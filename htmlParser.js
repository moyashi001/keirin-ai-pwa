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

const KEIRIN_STYLE_KEYWORDS = ['逃', 'まくり', '差', '両'];

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

  // パターン1: 2026-09-08 / 2026/09/08
  let m = fullText.match(/(20\d{2})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
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
  const m = fullText.match(/([一-龥ぁ-んァ-ヶー]{2,6}競輪)/);
  return m ? m[1].replace('競輪', '') : '不明会場';
}

function detectRaceNumber(fullText) {
  const m = fullText.match(/第?\s*(\d{1,2})\s*[Rレース]/);
  return m ? Number(m[1]) : null;
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
function looksLikeName(s) {
  if (!s || s.length < 2 || s.length > 10) return false;
  if (/\d/.test(s)) return false;
  return /^[一-龥ぁ-んァ-ヶー・]+$/.test(s);
}

function detectStyle(s) {
  for (const kw of KEIRIN_STYLE_KEYWORDS) {
    if (s.includes(kw)) return normalizeStyleLabel(kw, s);
  }
  return null;
}

function normalizeStyleLabel(kw, full) {
  if (full.includes('逃')) return '逃げ';
  if (full.includes('まくり')) return 'まくり';
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
    const lineRe = /([1-9])\s*([一-龥ぁ-んァ-ヶー・]{2,8})\s*(\d{2,3}\.\d{1,2})?/g;
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

  // バンク特性(周長・みなし直線)
  let bankNote = null;
  const bankMatch = fullText.match(/(バンク周長[^\s、。]{0,20}|周長\s*\d{3}m[^\s、。]{0,10}|みなし直線[^\s、。]{0,20})/);
  if (bankMatch) bankNote = bankMatch[1];

  players.sort((a, b) => (a.number || 99) - (b.number || 99));

  return {
    raceKey: `${dateLabel}_${venue}_${raceNumber || 'R'}`,
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
 * 複数テーブルが並ぶページで、あるテーブルに対応するレース番号を推定する。
 * テーブル直前の兄弟要素だけでなく、DOM順序を遡って「直前の見出し(h1〜h6)」を
 * 探す(1つ前の対象テーブルより後の範囲に限定する)ことで、見出しとテーブルの間に
 * 別の要素(説明文・オッズ表など)が挟まっていても正しく対応付けられるようにしている。
 * @param {Element} table 対象テーブル
 * @param {Element|null} boundaryEl 1つ前の対象テーブル(この要素より後だけを見出し候補にする)
 * @param {Document} doc
 */
function findRaceNumberForTable(table, boundaryEl, doc) {
  const walker = doc.createTreeWalker(doc.body || doc, NodeFilter.SHOW_ELEMENT);
  let node;
  let pastBoundary = !boundaryEl;
  let lastHeadingText = '';
  while ((node = walker.nextNode())) {
    if (node === table) break;
    if (node === boundaryEl) {
      pastBoundary = true;
      continue;
    }
    if (!pastBoundary) continue;
    if (/^H[1-6]$/.test(node.tagName) || node.tagName === 'CAPTION') {
      lastHeadingText = node.textContent;
    }
  }
  return detectRaceNumber(normalizeText(lastHeadingText));
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
    const players = buildPlayersFromTable(table, fullText, oddsMap);
    if (players.length === 0) {
      prevTable = table;
      continue;
    }

    const lines = detectLines(fullText, players);

    let raceNumber = findRaceNumberForTable(table, prevTable, doc);
    prevTable = table;
    while (raceNumber && usedRaceNumbers.has(raceNumber)) raceNumber = null; // 誤検出で重複した場合はフォールバック
    if (!raceNumber) {
      while (usedRaceNumbers.has(fallbackRaceNo)) fallbackRaceNo++;
      raceNumber = fallbackRaceNo;
    }
    usedRaceNumbers.add(raceNumber);

    races.push({
      raceKey: `${dateLabel}_${venue}_${raceNumber}`,
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
 * 結果ページ(1ページに複数レース分の着順表が並んでいることを想定)を
 * レース単位の結果配列に変換する。テーブルごとに1レース分の着順とみなし、
 * レース番号はテーブル直前の見出しテキストから推定する(推定できない場合は出現順の通し番号)。
 * @returns {Array<{raceKey:string, date:string, venue:string, raceNumber:number, order:object[]}>}
 */
function parseResultsFromPage(html, referenceDate = new Date()) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const fullText = normalizeText(doc.body ? doc.body.textContent : html);
  const dateLabel = detectDateLabel(fullText, referenceDate);
  const venue = detectVenue(fullText);

  const tables = Array.from(doc.querySelectorAll('table'));
  const results = [];
  let fallbackRaceNo = 1;
  const usedRaceNumbers = new Set();
  let prevTable = null;

  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td,th')).map((c) => textOf(c))
    );
    const order = [];
    for (const row of rows) {
      const rankCell = row.find((c) => /^[1-9]着?$/.test(c));
      const numCell = row.filter((c) => /^\d{1,2}$/.test(c) && Number(c) <= 9);
      const nameCell = row.find((c) => looksLikeName(c));
      if (rankCell && nameCell && numCell.length > 0) {
        const rank = parseInt(rankCell, 10);
        const number = Number(numCell[numCell.length > 1 ? 1 : 0]);
        if (rank >= 1 && rank <= 9) order.push({ number, name: nameCell, rank });
      }
    }
    if (order.length === 0) continue;
    order.sort((a, b) => a.rank - b.rank);

    // レース番号を「直前の見出し(h1〜h6)」から推定する(見出しとテーブルの間に他要素があってもよい)
    let raceNumber = findRaceNumberForTable(table, prevTable, doc);
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
      const rankCell = row.find((c) => /^[1-9]着?$/.test(c));
      const numCell = row.filter((c) => /^\d{1,2}$/.test(c) && Number(c) <= 9);
      const nameCell = row.find((c) => looksLikeName(c));
      if (rankCell && nameCell && numCell.length > 0) {
        const rank = parseInt(rankCell, 10);
        const number = Number(numCell[numCell.length > 1 ? 1 : 0]);
        if (rank >= 1 && rank <= 9) {
          order.push({ number, name: nameCell, rank });
        }
      }
    }
    if (order.length >= 3) break;
  }

  // フォールバック: 全文から「1着 3 田中太郎」のようなパターン
  if (order.length === 0) {
    const re = /([1-9])\s*着\s*(\d{1,2})?\s*([一-龥ぁ-んァ-ヶー・]{2,8})/g;
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

if (typeof window !== 'undefined') {
  window.KeirinParser = {
    parseRaceCardHtml,
    parseRaceCardsFromPage,
    parseResultHtml,
    parseResultsFromPage,
    normalizeText,
  };
}
