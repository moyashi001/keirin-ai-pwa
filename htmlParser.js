/**
 * htmlParser.js
 * ユーザーがiPhone Safari上のブックマークレットでコピーし、
 * テキストエリアに貼り付けた「出走表HTML」「結果HTML」を構造化JSONに変換する。
 * サイト側のマークアップ変更に強くするため、複数のフォールバック戦略を積み重ねている。
 *  1. ラベル/クラス名によるヒント検索
 *  2. テーブル構造からのヒューリスティック推定
 *  3. 全文テキストへの正規表現フォールバック
 * 1ページに複数レース分の情報がまとまっている場合(テーブルが複数ある場合)は、
 * parseRaceCardsFromPage / parseResultsFromPage がテーブルごとに1レースとして
 * まとめて抽出する。
 */

const KEIRIN_STYLE_KEYWORDS = ['逃', 'まくり', '捲', '差', '両'];

/** 結果表の「決まり手」欄に出現する語。選手名との誤認識を防ぐための判定に使う。 */
const KIMARITE_WORDS = ['逃げ', '差し', 'まくり', '捲り', 'マーク', '追込', '突放'];

/** 全角数字・全角記号を半角に寄せる */
function normalizeText(str) {
  if (!str) return '';
  return str
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[　]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textOf(el) {
  return normalizeText(el ? el.textContent : '');
}

/**
 * HTML全文から開催日を推定する。当日運用専用のため日数差は計算せず、
 * 見つかった日付をそのままラベルとして返す(見つからなければ今日の日付)。
 */
function detectDateLabel(fullText, referenceDate = new Date()) {
  const today = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());

  // パターン0: KEIRIN.JPのページ内に埋め込まれたJSON(txtEventDate/kaisaiDate)を最優先で使う。
  // 結果ページには開催期間(例: hhKikan「2026/09/07～2026/09/09」、初日〜最終日の範囲表記)が
  // 実際の対象日(hhKaisaihi等)より先にDOM上へ出現することがあり、下記パターン1で単純に
  // 「最初に見つかった日付」を採用すると前日を誤って拾ってしまう(実際に発生した不具合)。
  // 埋め込みJSONの値はページの表示対象そのものを指すため、これを優先する。
  let m = fullText.match(/"txtEventDate"\s*:\s*"(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})"/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!isNaN(d.getTime())) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  }
  m = fullText.match(/"kaisaiDate"\s*:\s*"(\d{4})(\d{2})(\d{2})"/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!isNaN(d.getTime())) return `${m[1]}-${m[2]}-${m[3]}`;
  }

  // パターン1: 2026-09-08 / 2026/09/08
  m = fullText.match(/(20\d{2})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (!isNaN(d.getTime())) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  }

  // パターン2: 9月8日 / 09月08日 (年省略、当年 or 年跨ぎを考慮)
  m = fullText.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) {
    let year = today.getFullYear();
    let d = new Date(year, Number(m[1]) - 1, Number(m[2]));
    if (Math.round((d - today) / 86400000) < -180) {
      d = new Date(year + 1, Number(m[1]) - 1, Number(m[2]));
    }
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  // 見つからない場合は当日扱い
  return formatDate(today);
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
function formatDate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function detectVenue(fullText) {
  // KEIRIN.JPの埋め込みJSON(joName)を最優先で使う。結果ページ等では「○○競輪」という
  // 連続した文言が本文中に無く、代わりにお知らせ欄の「詳しくは競輪トピックス」等の
  // 文言を誤って会場名として拾ってしまうことがあるため。
  let m = fullText.match(/"joName"\s*:\s*"([^"]+)"/);
  if (m) return m[1].replace(/競輪場?$/, '');

  m = fullText.match(/([一-龥々ぁ-んァ-ヶー]{2,6}競輪)/);
  return m ? m[1].replace('競輪', '') : '不明会場';
}

function detectRaceNumber(fullText) {
  const m = fullText.match(/第?\s*(\d{1,2})\s*[Rレース]/);
  return m ? Number(m[1]) : null;
}

/**
 * KEIRIN.JPの「投票選択」ページ(/sp/voteselect)専用の抽出ロジック。
 * このページは選手情報がテーブルではなく <script> 内の JS変数 mainOzzData に
 * JSON形式で埋め込まれている(通常のテーブル走査では選手を検出できない)。
 * ブックマークレットでコピーしやすい画面のため、直接対応しておく。
 */
function extractMainOzzData(html) {
  const m = html.match(/mainOzzData\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
}

/** KEIRIN.JPの脚質表記(逃/追/両)をPWA内の表記(逃げ/差し/両方)に変換する */
function mapKyakusitu(kyakusitu) {
  if (kyakusitu === '逃') return '逃げ';
  if (kyakusitu === '追') return '差し';
  if (kyakusitu === '両') return '両方';
  return null;
}

/**
 * mainOzzData(KEIRIN.JP投票選択ページのJSONデータ)から、その日の全レース分の
 * 出走表相当データを組み立てる。このページには競走得点・オッズが無いため、
 * 3連単支持率(sanRentanSijiRituInfoList、人気度合いの目安)を疑似オッズとして使う。
 * 疑似オッズ = 100 / 支持率(%) とし、支持率が高い(人気)ほど値が小さくなるようにする。
 */
function buildRacesFromOzzData(data, referenceDate = new Date()) {
  if (!data || !Array.isArray(data.zenSensyuInfoList)) return [];

  const venueMap = new Map();
  (data.raceInfoList || []).forEach((info) => {
    venueMap.set(`${info.kaisaiDate}_${info.innerKeirinjyoCode}`, info.keirinjyoName);
  });

  const sijiMap = new Map();
  (data.sanRentanSijiInfoList || []).forEach((entry) => {
    const key = `${entry.kaisaiDate}_${entry.innerKeirinjyoCode}_${entry.raceNo}`;
    const byNumber = new Map((entry.sanRentanSijiRituInfoList || []).map((s) => [Number(s.syaban), parseFloat(s.sijiLitu)]));
    sijiMap.set(key, byNumber);
  });

  const races = [];
  for (const entry of data.zenSensyuInfoList) {
    const { kaisaiDate, innerKeirinjyoCode, raceNo, sensyuInfoList } = entry;
    if (!sensyuInfoList || sensyuInfoList.length === 0) continue;

    const dateLabel = /^\d{8}$/.test(String(kaisaiDate))
      ? `${String(kaisaiDate).slice(0, 4)}-${String(kaisaiDate).slice(4, 6)}-${String(kaisaiDate).slice(6, 8)}`
      : detectDateLabel(String(kaisaiDate), referenceDate);
    const venue = venueMap.get(`${kaisaiDate}_${innerKeirinjyoCode}`) || '不明会場';
    const raceNumber = Number(raceNo);
    const raceSiji = sijiMap.get(`${kaisaiDate}_${innerKeirinjyoCode}_${raceNo}`) || new Map();

    const players = sensyuInfoList.map((s) => {
      const number = Number(s.syaban);
      const supportRate = raceSiji.get(number);
      return {
        number,
        name: normalizeText(s.sensyuName).replace(/\s+/g, ''),
        score: null, // 投票選択ページには競走得点が無い
        style: mapKyakusitu(s.kyakusitu),
        odds: supportRate != null && supportRate > 0 ? Number((100 / supportRate).toFixed(2)) : null,
        recentResults: null,
      };
    });

    // ライン構成の情報は無いため、車番順に2人ずつまとめる簡易フォールバックを使う
    const numbers = players.map((p) => p.number).sort((a, b) => a - b);
    const lines = [];
    for (let i = 0; i < numbers.length; i += 2) lines.push(numbers.slice(i, i + 2));

    const raceKey = `${dateLabel}_${venue}_${raceNumber}`;
    races.push({
      raceKey,
      raceId: raceKey,
      raceName: buildRaceName(venue, raceNumber),
      raceClass: null,
      startTime: null, // 投票選択ページには発走時刻が無い
      date: dateLabel,
      venue,
      raceNumber,
      bankNote: null,
      lines,
      players,
      parsedAt: new Date().toISOString(),
    });
  }
  return races;
}

/**
 * KEIRIN.JPの「開催情報」ページ(/sp/race、出走表一覧タブ)専用の抽出ロジック。
 * このページは<script>内のJS変数(jsonData['SJ0305'])に選手情報がJSON形式で
 * 埋め込まれている。同じページに結果一覧(jsonData['SJ0306']相当のテーブル)も
 * 同居しているため、通常のテーブル走査だと結果テーブルまで出走表として誤って
 * 拾ってしまう(1行に3名分のセルが並ぶ構造のため、先頭の1名しか取れない上に
 * 結果テーブルの行まで選手行と誤認する)。JSON側を直接使うことでこれを避ける。
 */
function extractSJ0305Data(html) {
  const m = html.match(/jsonData\['SJ0305'\]\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
}

/** jsonData['SJ0305'](開催情報ページの出走表一覧)から、レース単位の出走表を組み立てる */
function buildRaceCardsFromSJ0305Data(data, fullText, referenceDate = new Date()) {
  if (!data || !Array.isArray(data.rInfo) || data.rInfo.length === 0) return [];

  const dateLabel = detectDateLabel(fullText, referenceDate);
  const venue = detectVenue(fullText);

  const races = [];
  for (const race of data.rInfo) {
    const players = (race.sInfo || [])
      .filter((s) => s.syaban != null && s.senName)
      .map((s) => ({
        number: Number(s.syaban),
        name: normalizeText(s.senName).replace(/\s+/g, ''),
        score: null, // このページには競走得点が無い
        style: null,
        odds: null,
        recentResults: null,
      }));
    if (players.length === 0) continue;

    const numbers = players.map((p) => p.number).sort((a, b) => a - b);
    const lines = [];
    for (let i = 0; i < numbers.length; i += 2) lines.push(numbers.slice(i, i + 2));

    const raceNumber = Number(race.raceNo);
    const raceKey = `${dateLabel}_${venue}_${raceNumber}`;
    races.push({
      raceKey,
      raceId: raceKey,
      raceName: buildRaceName(venue, raceNumber),
      raceClass: race.syumoku || null,
      startTime: race.stTime || null,
      date: dateLabel,
      venue,
      raceNumber,
      bankNote: null,
      lines,
      players,
      parsedAt: new Date().toISOString(),
    });
  }
  return races;
}

/** 発走時刻(例: 17:05 / 17時05分)を検出する */
function detectStartTime(fullText) {
  const m = fullText.match(/(\d{1,2})[:時](\d{2})分?/);
  if (!m) return null;
  return `${pad2(m[1])}:${pad2(m[2])}`;
}

/** レースの級班(A級チャレンジ、S級決勝など)を検出する */
function detectRaceClass(fullText) {
  const m = fullText.match(/([SA]級(?:チャレンジ|選抜|特進|一般|準決勝|決勝|[123一二三]班)?|ガールズ[一-龥々ぁ-んァ-ヶー]{0,6})/);
  return m ? m[1] : null;
}

/** レース名(例: 松戸競輪 5R)を組み立てる */
function buildRaceName(venue, raceNumber) {
  return `${venue}競輪${raceNumber ? ` ${raceNumber}R` : ''}`;
}

/** 文字列が競走得点らしいか(60〜130の範囲の小数) */
function looksLikeScore(s) {
  const m = s.match(/^\d{2,3}(\.\d{1,2})?$/);
  if (!m) return false;
  const v = parseFloat(s);
  return v >= 50 && v <= 130;
}

/** 文字列がオッズらしいか */
function looksLikeOdds(s) {
  const m = s.match(/^\d{1,4}(\.\d)?$/);
  if (!m) return false;
  const v = parseFloat(s);
  return v >= 1.0 && v <= 9999;
}

/** 文字列が選手名らしいか(漢字/カナ主体、2〜8文字、数字を含まない) */
/** 文字列が選手名らしいか(漢字/カナ主体、2〜8文字、数字を含まない)。
 * 姓名の間に全角スペースが1つ入る表記(例: 「辰己　豊」)も許容するが、
 * 「差し」「捲り」等の決まり手そのものは選手名として扱わない。
 */
function looksLikeName(s) {
  if (!s || s.length < 2 || s.length > 12) return false;
  if (/\d/.test(s)) return false;
  if (KIMARITE_WORDS.includes(s)) return false;
  return /^[一-龥々ぁ-んァ-ヶー・]+(\s[一-龥々ぁ-んァ-ヶー・]+)?$/.test(s);
}

function detectStyle(s) {
  for (const kw of KEIRIN_STYLE_KEYWORDS) {
    if (s.includes(kw)) return normalizeStyleLabel(kw, s);
  }
  return null;
}

function normalizeStyleLabel(kw, full) {
  if (full.includes('逃')) return '逃げ';
  if (full.includes('まくり') || full.includes('捲')) return 'まくり';
  if (full.includes('差')) return '差し';
  if (full.includes('両')) return '両方';
  return kw;
}

/** テーブル1行(セル文字列配列)から選手情報を推定する */
function extractPlayerFromRow(cells) {
  const player = { number: null, name: null, score: null, style: null, odds: null, recentResults: null };
  for (const raw of cells) {
    const c = normalizeText(raw);
    if (!c) continue;
    if (player.number === null && /^\d{1,2}$/.test(c) && Number(c) >= 1 && Number(c) <= 9) {
      player.number = Number(c);
      continue;
    }
    if (player.name === null && looksLikeName(c)) {
      player.name = c;
      continue;
    }
    if (player.score === null && looksLikeScore(c)) {
      player.score = parseFloat(c);
      continue;
    }
    if (player.style === null) {
      const st = detectStyle(c);
      if (st) {
        player.style = st;
        continue;
      }
    }
    if (/^[1-9](-[1-9]){2,6}$/.test(c)) {
      player.recentResults = c;
      continue;
    }
    if (player.odds === null && looksLikeOdds(c) && cells.length <= 12) {
      // オッズ列は出走表内に無いことも多いので、他項目が埋まった後の最終候補として扱う
    }
  }
  return player;
}

/** ライン構成の抽出: 「ライン構成」ラベル直後の記述を優先し、無ければ車番グルーピングにフォールバック */
function detectLines(fullText, players) {
  const validNumbers = new Set(players.map((p) => p.number).filter((n) => n != null));
  const labelMatch = fullText.match(/ライン構成[:：]?\s*([0-9\-,・/\s]{3,60})/);
  if (labelMatch) {
    const segments = labelMatch[1].split('/').map((s) => s.trim()).filter(Boolean);
    const parsed = segments
      .map((seg) => seg.split(/[-,・]/).map(Number).filter((n) => !isNaN(n) && validNumbers.has(n)))
      .filter((l) => l.length > 0);
    if (parsed.length > 0) return parsed.slice(0, 5);
  }
  // フォールバック: 車番順に2〜3人ずつまとめる(推定ラインとして扱う)
  const numbers = players.map((p) => p.number).filter((n) => n != null).sort((a, b) => a - b);
  const fallbackLines = [];
  for (let i = 0; i < numbers.length; i += 2) {
    fallbackLines.push(numbers.slice(i, i + 2));
  }
  return fallbackLines;
}

/** ライン内での位置を数値化する(1=先頭, 2=番手, 3=3番手以降/単騎) */
function computeLinePosition(playerNumber, lines) {
  const line = (lines || []).find((l) => l.includes(playerNumber));
  if (!line || line.length <= 1) return 3;
  const pos = line.indexOf(playerNumber);
  return Math.min(pos + 1, 3);
}

/** 選手配列に、確定したライン構成からのlinePosition(1〜3)を付与する */
function attachLinePositions(players, lines) {
  return players.map((p) => ({ ...p, linePosition: computeLinePosition(p.number, lines) }));
}

/** オッズ表(単勝オッズ等)を全文から車番→オッズのマップとして拾うフォールバック */
function extractOddsMap(doc) {
  const map = {};
  const tables = Array.from(doc.querySelectorAll('table'));
  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll('tr'));
    for (const row of rows) {
      const cells = Array.from(row.querySelectorAll('td,th')).map((c) => normalizeText(c.textContent));
      if (cells.length < 2) continue;
      const numCell = cells.find((c) => /^\d{1,2}$/.test(c) && Number(c) <= 9);
      const oddsCell = cells.find((c) => looksLikeOdds(c) && c.includes('.'));
      if (numCell && oddsCell) {
        map[Number(numCell)] = parseFloat(oddsCell);
      }
    }
  }
  return map;
}

/**
 * 出走表HTML文字列を構造化JSONへ変換する。
 * @param {string} html
 * @param {Date} [referenceDate] テスト用に「今日」を差し替え可能
 */
function parseRaceCardHtml(html, referenceDate = new Date()) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const fullText = normalizeText(doc.body ? doc.body.textContent : html);

  const dateLabel = detectDateLabel(fullText, referenceDate);
  const venue = detectVenue(fullText);
  const raceNumber = detectRaceNumber(fullText);
  const startTime = detectStartTime(fullText);
  const raceClass = detectRaceClass(fullText);

  // 出走表本体らしきテーブルを探す(行数が最も多いテーブルを採用)
  const tables = Array.from(doc.querySelectorAll('table'));
  let bestTable = null;
  let bestRows = [];
  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td,th')).map((c) => textOf(c))
    );
    const playerRows = rows.filter((r) => r.some((c) => /^\d{1,2}$/.test(c)) && r.some((c) => looksLikeName(c)));
    if (playerRows.length > bestRows.length) {
      bestRows = playerRows;
      bestTable = table;
    }
  }

  let players = bestRows.map(extractPlayerFromRow).filter((p) => p.name);

  // テーブルから拾えなかった場合の最終フォールバック: 全文正規表現走査
  if (players.length === 0) {
    const lineRe = /([1-9])\s*([一-龥々ぁ-んァ-ヶー・]{2,8})\s*(\d{2,3}\.\d{1,2})?/g;
    let m;
    const seen = new Set();
    while ((m = lineRe.exec(fullText)) !== null) {
      const num = Number(m[1]);
      if (seen.has(num)) continue;
      if (!looksLikeName(m[2])) continue;
      seen.add(num);
      players.push({
        number: num,
        name: m[2],
        score: m[3] ? parseFloat(m[3]) : null,
        style: null,
        odds: null,
        recentResults: null,
      });
    }
  }

  // オッズ補完(単勝オッズ表が別テーブルにあるケース)
  const oddsMap = extractOddsMap(doc);
  players = players.map((p) => ({
    ...p,
    odds: p.odds != null ? p.odds : oddsMap[p.number] != null ? oddsMap[p.number] : null,
  }));

  // 脚質が拾えなかった選手は近傍テキストから再探索(選手名の直後10文字程度)
  players = players.map((p) => {
    if (p.style) return p;
    const idx = fullText.indexOf(p.name);
    if (idx >= 0) {
      const near = fullText.slice(idx, idx + 20);
      const st = detectStyle(near);
      if (st) return { ...p, style: st };
    }
    return p;
  });

  const lines = detectLines(fullText, players);
  players = attachLinePositions(players, lines);

  // バンク特性(周長・みなし直線)
  let bankNote = null;
  const bankMatch = fullText.match(/(バンク周長[^\s、。]{0,20}|周長\s*\d{3}m[^\s、。]{0,10}|みなし直線[^\s、。]{0,20})/);
  if (bankMatch) bankNote = bankMatch[1];

  players.sort((a, b) => (a.number || 99) - (b.number || 99));

  const raceKey = `${dateLabel}_${venue}_${raceNumber || 'R'}`;
  return {
    raceKey,
    raceId: raceKey,
    raceName: buildRaceName(venue, raceNumber),
    raceClass,
    startTime,
    date: dateLabel,
    venue,
    raceNumber,
    bankNote,
    lines,
    players,
    parsedAt: new Date().toISOString(),
  };
}

/**
 * 複数テーブルが並ぶページで、あるテーブルの「見出しセクション」のテキストを集める。
 * DOM順序を遡って、1つ前の対象テーブルより後・このテーブルより前にある
 * 見出し(h1〜h6)・caption・pタグのテキストを連結する。見出しとテーブルの間に
 * 別の要素(説明文・オッズ表など)が挟まっていても正しく対応付けられるようにしている。
 * @param {Element} table 対象テーブル
 * @param {Element|null} boundaryEl 1つ前の対象テーブル(この要素より後だけを見出し候補にする)
 * @param {Document} doc
 */
function collectPrecedingSectionText(table, boundaryEl, doc) {
  const walker = doc.createTreeWalker(doc.body || doc, NodeFilter.SHOW_ELEMENT);
  let node;
  let pastBoundary = !boundaryEl;
  const texts = [];
  while ((node = walker.nextNode())) {
    if (node === table) break;
    if (node === boundaryEl) {
      pastBoundary = true;
      continue;
    }
    if (!pastBoundary) continue;
    if (/^H[1-6]$/.test(node.tagName) || node.tagName === 'CAPTION' || node.tagName === 'P') {
      texts.push(node.textContent);
    }
  }
  return normalizeText(texts.join(' '));
}

/** 対象テーブルに対応するレース番号を、直前の見出しセクションから推定する */
function findRaceNumberForTable(table, boundaryEl, doc) {
  return detectRaceNumber(collectPrecedingSectionText(table, boundaryEl, doc));
}

/** 対象テーブルより後・次の境界要素より前にある要素のテキストを集める(払戻し表の検出用) */
function collectFollowingSectionText(table, nextBoundaryEl, doc) {
  const walker = doc.createTreeWalker(doc.body || doc, NodeFilter.SHOW_ELEMENT);
  let node;
  let started = false;
  const texts = [];
  while ((node = walker.nextNode())) {
    if (node === table) {
      started = true;
      continue;
    }
    if (!started) continue;
    if (node === nextBoundaryEl) break;
    texts.push(node.textContent);
  }
  return normalizeText(texts.join(' '));
}

const PAYOUT_PATTERNS = [
  { key: 'win', label: '単勝', re: /単勝[\s:：]*([0-9]{1,2})[^\d]{0,6}?([\d,]+)円/ },
  { key: 'quinella', label: '2車複', re: /(?:2車複|二車複)[\s:：]*([0-9]{1,2}[-‐=][0-9]{1,2})[^\d]{0,6}?([\d,]+)円/ },
  { key: 'exacta', label: '2車単', re: /(?:2車単|二車単)[\s:：]*([0-9]{1,2}[-‐][0-9]{1,2})[^\d]{0,6}?([\d,]+)円/ },
  { key: 'wide', label: 'ワイド', re: /ワイド[\s:：]*([0-9]{1,2}[-‐=][0-9]{1,2})[^\d]{0,6}?([\d,]+)円/ },
  { key: 'trio', label: '3連複', re: /(?:3連複|三連複)[\s:：]*([0-9]{1,2}[-‐=][0-9]{1,2}[-‐=][0-9]{1,2})[^\d]{0,6}?([\d,]+)円/ },
  { key: 'trifecta', label: '3連単', re: /(?:3連単|三連単)[\s:：]*([0-9]{1,2}[-‐][0-9]{1,2}[-‐][0-9]{1,2})[^\d]{0,6}?([\d,]+)円/ },
];

/** テキストから券種ごとの払戻し(組み合わせ・金額)を検出する */
function extractPayouts(sectionText) {
  const payouts = {};
  for (const { key, re } of PAYOUT_PATTERNS) {
    const m = sectionText.match(re);
    if (m) {
      payouts[key] = { combo: m[1], amount: parseInt(m[2].replace(/,/g, ''), 10) };
    }
  }
  return payouts;
}

/**
 * 貼り付けられたHTML内の「選手情報を含むテーブル」を全て探す。
 * テーブルが1つしか無い場合(または見つからない場合)は空配列を返し、
 * 呼び出し側で従来の単一レース用ロジックにフォールバックできるようにする。
 */
function findPlayerTables(doc) {
  return Array.from(doc.querySelectorAll('table')).filter((table) => {
    const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td,th')).map((c) => textOf(c))
    );
    return rows.some((r) => r.some((c) => /^\d{1,2}$/.test(c)) && r.some((c) => looksLikeName(c)));
  });
}

/**
 * 1つのテーブル(選手情報を含む)から、そのレースの選手配列を組み立てる。
 * parseRaceCardHtml / parseRaceCardsFromPage の共通ロジック。
 */
function buildPlayersFromTable(table, fullText, oddsMap) {
  const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.querySelectorAll('td,th')).map((c) => textOf(c))
  );
  const playerRows = rows.filter((r) => r.some((c) => /^\d{1,2}$/.test(c)) && r.some((c) => looksLikeName(c)));
  let players = playerRows.map(extractPlayerFromRow).filter((p) => p.name);

  players = players.map((p) => ({
    ...p,
    odds: p.odds != null ? p.odds : oddsMap[p.number] != null ? oddsMap[p.number] : null,
  }));

  players = players.map((p) => {
    if (p.style) return p;
    const idx = fullText.indexOf(p.name);
    if (idx >= 0) {
      const near = fullText.slice(idx, idx + 20);
      const st = detectStyle(near);
      if (st) return { ...p, style: st };
    }
    return p;
  });

  players.sort((a, b) => (a.number || 99) - (b.number || 99));
  return players;
}

/**
 * 貼り付けられたHTMLに複数レース分の出走表テーブルが並んでいる場合に、
 * テーブルごとに1レースとして抽出する。テーブルが1つしか見つからない場合は
 * parseRaceCardHtml と同じ結果を1件だけ返す(後方互換)。
 * @param {string} html 出走表ページのHTML(1レース分でも複数レース分でも可)
 * @param {Date} [referenceDate]
 * @returns {object[]} parseRaceCardHtml() と同じ形のレースオブジェクトの配列
 */
function parseRaceCardsFromPage(html, referenceDate = new Date()) {
  // KEIRIN.JPの投票選択ページ(mainOzzDataを含む)は、選手情報がテーブルではなく
  // JS変数に埋め込まれているため、まずこちらを優先的に試す。
  const ozzData = extractMainOzzData(html);
  if (ozzData) {
    const ozzRaces = buildRacesFromOzzData(ozzData, referenceDate);
    if (ozzRaces.length > 0) return ozzRaces;
  }

  // KEIRIN.JPの「開催情報」ページ(jsonData['SJ0305']を含む)も同様にJS変数優先で解析する。
  // 結果一覧が同じページに同居しているため、通常のテーブル走査だと誤って
  // 結果テーブルまで出走表として拾ってしまう。
  const sj0305Data = extractSJ0305Data(html);
  if (sj0305Data) {
    const fullTextForSj = normalizeText(new DOMParser().parseFromString(html, 'text/html').body?.textContent || html);
    const sjRaces = buildRaceCardsFromSJ0305Data(sj0305Data, fullTextForSj, referenceDate);
    if (sjRaces.length > 0) return sjRaces;
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const playerTables = findPlayerTables(doc);

  if (playerTables.length <= 1) {
    const single = parseRaceCardHtml(html, referenceDate);
    return single.players.length > 0 ? [single] : [];
  }

  const fullText = normalizeText(doc.body ? doc.body.textContent : html);
  const dateLabel = detectDateLabel(fullText, referenceDate);
  const venue = detectVenue(fullText);
  const oddsMap = extractOddsMap(doc);
  let bankNote = null;
  const bankMatch = fullText.match(/(バンク周長[^\s、。]{0,20}|周長\s*\d{3}m[^\s、。]{0,10}|みなし直線[^\s、。]{0,20})/);
  if (bankMatch) bankNote = bankMatch[1];

  const races = [];
  const usedRaceNumbers = new Set();
  let fallbackRaceNo = 1;
  let prevTable = null;

  for (const table of playerTables) {
    let players = buildPlayersFromTable(table, fullText, oddsMap);
    if (players.length === 0) {
      prevTable = table;
      continue;
    }

    const lines = detectLines(fullText, players);
    players = attachLinePositions(players, lines);

    const sectionText = collectPrecedingSectionText(table, prevTable, doc);
    let raceNumber = detectRaceNumber(sectionText);
    const startTime = detectStartTime(sectionText) || detectStartTime(fullText);
    const raceClass = detectRaceClass(sectionText) || detectRaceClass(fullText);
    prevTable = table;
    while (raceNumber && usedRaceNumbers.has(raceNumber)) raceNumber = null; // 誤検出で重複した場合はフォールバック
    if (!raceNumber) {
      while (usedRaceNumbers.has(fallbackRaceNo)) fallbackRaceNo++;
      raceNumber = fallbackRaceNo;
    }
    usedRaceNumbers.add(raceNumber);

    const raceKey = `${dateLabel}_${venue}_${raceNumber}`;
    races.push({
      raceKey,
      raceId: raceKey,
      raceName: buildRaceName(venue, raceNumber),
      raceClass,
      startTime,
      date: dateLabel,
      venue,
      raceNumber,
      bankNote,
      lines,
      players,
      parsedAt: new Date().toISOString(),
    });
  }

  return races;
}

/**
 * KEIRIN.JPのPC版「結果一覧」ページ(/pc/racelist)専用の抽出ロジック。
 * このページも着順が<table>ではなく<script>内のJS変数(jsonData['PJ0306'])に
 * JSON形式で埋め込まれており(SP版投票選択ページのmainOzzDataと同様の構造)、
 * 通常のテーブル走査では着順を検出できない。
 */
function extractPcResultData(html) {
  const m = html.match(/jsonData\['PJ0306'\]\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch (_) {
    return null;
  }
}

/** PC版結果ページの決まり手(1文字表記: 差/捲/逃/マ 等)をPWA内の表記に変換する */
function mapPcKimarite(k) {
  if (!k) return null;
  if (k.includes('逃')) return '逃げ';
  if (k.includes('捲')) return 'まくり';
  if (k.includes('差')) return '差し';
  if (k.includes('マ')) return 'マーク';
  return k;
}

/** 金額文字列(例: "1,240円")から数値を取り出す */
function parseYen(s) {
  const n = parseInt(String(s || '').replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? null : n;
}

/** jsonData['PJ0306'](PC版結果ページ)から、レース単位の結果配列を組み立てる */
function buildResultsFromPcData(data, fullText, referenceDate = new Date()) {
  if (!data || !Array.isArray(data.resultList) || data.resultList.length === 0) return [];

  const dateLabel = detectDateLabel(fullText, referenceDate);
  const venue = detectVenue(fullText);

  const results = [];
  for (const race of data.resultList) {
    const raceNumber = detectRaceNumber(String(race.rclblRaceNo || ''));
    const order = [];
    ['tyakui1List', 'tyakui2List', 'tyakui3List'].forEach((key) => {
      (race[key] || []).forEach((entry) => {
        if (entry.rclblSyaban == null || !entry.rclblSensyuName) return;
        order.push({
          number: Number(entry.rclblSyaban),
          name: normalizeText(entry.rclblSensyuName).replace(/\s+/g, ''),
          rank: entry.rclblTyakui,
          move: mapPcKimarite(entry.rclblKimari),
        });
      });
    });
    if (order.length === 0) continue;
    order.sort((a, b) => a.rank - b.rank);

    const payouts = {};
    const exacta = (race.harai2syaList || [])[0];
    if (exacta) payouts.exacta = { combo: exacta.kumi, amount: parseYen(exacta.kingaku) };
    const trifecta = (race.harai3renList || [])[0];
    if (trifecta) payouts.trifecta = { combo: trifecta.kumi, amount: parseYen(trifecta.kingaku) };

    results.push({
      raceKey: `${dateLabel}_${venue}_${raceNumber}`,
      date: dateLabel,
      venue,
      raceNumber,
      order,
      payouts,
      parsedAt: new Date().toISOString(),
    });
  }
  return results;
}

/**
 * 結果ページ(1ページに複数レース分の着順表が並んでいることを想定)を
 * レース単位の結果配列に変換する。テーブルごとに1レース分の着順とみなし、
 * レース番号はテーブル直前の見出しテキストから推定する(推定できない場合は出現順の通し番号)。
 * @returns {Array<{raceKey:string, date:string, venue:string, raceNumber:number, order:object[]}>}
 */
function parseResultsFromPage(html, referenceDate = new Date()) {
  // KEIRIN.JPのPC版結果一覧ページ(jsonData['PJ0306']を含む)は、着順がテーブルではなく
  // JS変数に埋め込まれているため、まずこちらを優先的に試す。
  const pcData = extractPcResultData(html);
  if (pcData) {
    const fullTextForPc = normalizeText(new DOMParser().parseFromString(html, 'text/html').body?.textContent || html);
    const pcResults = buildResultsFromPcData(pcData, fullTextForPc, referenceDate);
    if (pcResults.length > 0) return pcResults;
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const fullText = normalizeText(doc.body ? doc.body.textContent : html);
  const dateLabel = detectDateLabel(fullText, referenceDate);
  const venue = detectVenue(fullText);

  const tables = Array.from(doc.querySelectorAll('table'));
  const results = [];
  let fallbackRaceNo = 1;
  const usedRaceNumbers = new Set();
  let prevTable = null;

  for (let i = 0; i < tables.length; i++) {
    const table = tables[i];
    const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td,th')).map((c) => textOf(c))
    );
    const order = [];
    for (const row of rows) {
      // 「着」の文字が付いた列だけを着順とみなす(出走表の車番セルは単なる数字なので誤検出しない)
      const rankIdx = row.findIndex((c) => /^[1-9]着$/.test(c));
      if (rankIdx === -1) continue;
      const rank = parseInt(row[rankIdx], 10);
      const numCell = row.filter((c, i) => i !== rankIdx && /^\d{1,2}$/.test(c) && Number(c) <= 9);
      const nameCell = row.find((c) => looksLikeName(c));
      const moveCell = row.find((c, i) => i !== rankIdx && detectStyle(c));
      if (nameCell && numCell.length > 0 && rank >= 1 && rank <= 9) {
        order.push({ number: Number(numCell[0]), name: nameCell.replace(/\s+/g, ''), rank, move: moveCell ? detectStyle(moveCell) : null });
      }
    }
    if (order.length === 0) continue;
    order.sort((a, b) => a.rank - b.rank);

    // レース番号: テーブル自身のthead内の表記(例:「1R」)を最優先し、無ければ
    // 直前の見出し(h1〜h6)から推定する。結果が出ていないレースがテーブル途中に
    // 挟まっても後続レースの番号がずれないようにするため。
    const theadText = normalizeText(table.querySelector('thead') ? table.querySelector('thead').textContent : '');
    let raceNumber = detectRaceNumber(theadText) || findRaceNumberForTable(table, prevTable, doc);
    // 払戻し(単勝・2車複・2車単・ワイド・3連複・3連単)をこのテーブル〜次のテーブルの間から抽出
    const followingText = collectFollowingSectionText(table, tables[i + 1] || null, doc);
    const payouts = extractPayouts(followingText || fullText);
    prevTable = table;
    while (raceNumber && usedRaceNumbers.has(raceNumber)) raceNumber = null; // 誤検出で重複した場合はフォールバック
    if (!raceNumber) {
      while (usedRaceNumbers.has(fallbackRaceNo)) fallbackRaceNo++;
      raceNumber = fallbackRaceNo;
    }
    usedRaceNumbers.add(raceNumber);

    results.push({
      raceKey: `${dateLabel}_${venue}_${raceNumber}`,
      date: dateLabel,
      venue,
      raceNumber,
      order,
      payouts,
      parsedAt: new Date().toISOString(),
    });
  }

  return results;
}

/**
 * 結果HTML(着順表、1レース分)を構造化JSONへ変換する。
 * @returns {{raceKey:string, order: {number:number, name:string, rank:number}[]}}
 */
function parseResultHtml(html, referenceDate = new Date()) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const fullText = normalizeText(doc.body ? doc.body.textContent : html);
  const dateLabel = detectDateLabel(fullText, referenceDate);
  const venue = detectVenue(fullText);
  const raceNumber = detectRaceNumber(fullText);

  const tables = Array.from(doc.querySelectorAll('table'));
  let order = [];
  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td,th')).map((c) => textOf(c))
    );
    for (const row of rows) {
      // 「着」の文字が付いた列だけを着順とみなす(出走表の車番セルは単なる数字なので誤検出しない)
      const rankIdx = row.findIndex((c) => /^[1-9]着$/.test(c));
      if (rankIdx === -1) continue;
      const rank = parseInt(row[rankIdx], 10);
      const numCell = row.filter((c, i) => i !== rankIdx && /^\d{1,2}$/.test(c) && Number(c) <= 9);
      const nameCell = row.find((c) => looksLikeName(c));
      const moveCell = row.find((c, i) => i !== rankIdx && detectStyle(c));
      if (nameCell && numCell.length > 0 && rank >= 1 && rank <= 9) {
        order.push({ number: Number(numCell[0]), name: nameCell.replace(/\s+/g, ''), rank, move: moveCell ? detectStyle(moveCell) : null });
      }
    }
    if (order.length >= 3) break;
  }

  // フォールバック: 全文から「1着 3 田中太郎」のようなパターン
  if (order.length === 0) {
    const re = /([1-9])\s*着\s*(\d{1,2})?\s*([一-龥々ぁ-んァ-ヶー・]{2,8})/g;
    let m;
    while ((m = re.exec(fullText)) !== null) {
      order.push({ number: m[2] ? Number(m[2]) : null, name: m[3], rank: Number(m[1]) });
    }
  }

  order.sort((a, b) => a.rank - b.rank);

  return {
    raceKey: `${dateLabel}_${venue}_${raceNumber || 'R'}`,
    date: dateLabel,
    venue,
    raceNumber,
    order,
    parsedAt: new Date().toISOString(),
  };
}

/**
 * 貼り付けられたHTMLが「出走表」か「結果」かを自動判定する。
 * 両方のパーサーを試し、着順(rank)が複数選手にわたってしっかり取れていれば結果、
 * 得点(score)が複数選手で取れていれば出走表と判定する。どちらも取れなければ'unknown'。
 * @returns {'racecard'|'result'|'unknown'}
 */
function detectPageType(html, referenceDate = new Date()) {
  // KEIRIN.JPの投票選択ページ(mainOzzData)は得点・オッズが無く、通常の判定基準
  // (score/oddsの充足度)に乗らないため、検出できた時点で確定で出走表とみなす。
  const ozzData = extractMainOzzData(html);
  if (ozzData && buildRacesFromOzzData(ozzData, referenceDate).length > 0) return 'racecard';

  const cardRaces = parseRaceCardsFromPage(html, referenceDate);
  const resultRaces = parseResultsFromPage(html, referenceDate);

  const hasStrongResult = resultRaces.some((r) => r.order.length >= 2);
  const cardHasScore = cardRaces.some((r) => r.players.filter((p) => p.score != null).length >= 2);
  const hasStrongCard = cardRaces.some((r) => r.players.length >= 2) && cardHasScore;

  if (hasStrongResult && !hasStrongCard) return 'result';
  if (hasStrongCard && !hasStrongResult) return 'racecard';
  if (hasStrongResult && hasStrongCard) return cardHasScore ? 'racecard' : 'result';
  if (resultRaces.some((r) => r.order.length > 0)) return 'result';
  if (cardRaces.some((r) => r.players.length > 0)) return 'racecard';
  return 'unknown';
}

if (typeof window !== 'undefined') {
  window.KeirinParser = {
    parseRaceCardHtml,
    parseRaceCardsFromPage,
    parseResultHtml,
    detectPageType,
    parseResultsFromPage,
    normalizeText,
  };
}
