/**
 * htmlParser.js
 * 競輪公式サイトの「開催日一覧ページHTML」から
 *   A. 当日の結果ページURL
 *   B. 翌日の出走表(開催)ページURL
 * を自動抽出し、出走表HTML・結果HTMLを構造化JSONに変換する。
 * サイト側のマークアップ変更に強くするため、複数のフォールバック戦略を積み重ねている。
 *  1. ラベル/クラス名/日付によるヒント検索
 *  2. テーブル構造からのヒューリスティック推定
 *  3. 全文テキストへの正規表現フォールバック
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
 * 「開催日一覧ページ」のHTMLから、当日の各レースページURLを自動抽出する。
 * サイト構造が不明でも壊れにくいよう、リンクテキスト/href双方から
 * レースページらしさをヒューリスティックに判定する。
 * @param {string} html 開催日一覧ページのHTML
 * @param {string} baseUrl 相対URLを絶対URLへ解決するための基準URL(一覧ページ自身のURL)
 * @returns {string[]} 重複除去済みのレースページURL一覧(出現順)
 */
function extractRaceUrlsFromIndexPage(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = Array.from(doc.querySelectorAll('a[href]'));
  const seen = new Set();
  const urls = [];

  for (const a of anchors) {
    const text = normalizeText(a.textContent);
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;

    const looksLikeRaceText = /^第?\s*\d{1,2}\s*[Rレース]/.test(text) || /出走表/.test(text);
    const looksLikeRaceHref = /race|shusso|degree|raceNumber|raceNo|hd=|rno=/i.test(href);
    if (!looksLikeRaceText && !looksLikeRaceHref) continue;

    let absolute;
    try {
      absolute = new URL(href, baseUrl).href;
    } catch (_) {
      continue;
    }
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    urls.push(absolute);
  }

  return urls;
}

/** 'YYYY-MM-DD' 文字列同士が同じ日かどうか(タイムゾーンに影響されない文字列比較) */
function isSameDateLabel(a, b) {
  return !!a && !!b && a === b;
}

/**
 * 開催日一覧ページのHTMLから「当日の結果ページURL」と「翌日の出走表(開催)ページURL」を
 * それぞれ1つずつ抽出する。サイト構造が不明でも壊れにくいよう、
 * リンクの周辺テキストから日付を推定しつつ、キーワードだけのゆるい判定にもフォールバックする。
 * @param {string} html 開催日一覧ページのHTML
 * @param {string} baseUrl 相対URLを絶対URLへ解決するための基準URL
 * @param {Date} [referenceDate] テスト用に「今日」を差し替え可能
 * @returns {{ resultUrl: string|null, nextDayUrl: string|null }}
 */
function extractResultAndNextDayUrls(html, baseUrl, referenceDate = new Date()) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = Array.from(doc.querySelectorAll('a[href]'));

  const today = new Date(referenceDate.getFullYear(), referenceDate.getMonth(), referenceDate.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  const todayLabel = formatDate(today);
  const tomorrowLabel = formatDate(tomorrow);

  let resultUrl = null;
  let resultUrlDated = false;
  let nextDayUrl = null;
  let nextDayUrlDated = false;

  const resolve = (href) => {
    try {
      return new URL(href, baseUrl).href;
    } catch (_) {
      return null;
    }
  };

  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    const text = normalizeText(a.textContent);
    const context = normalizeText((a.closest('li,tr,div,td,section,article') || a).textContent).slice(0, 80);

    const isResultLike = /結果|着順|払戻/.test(text) || /result|chakujun|haraimodoshi/i.test(href);
    const isCardLike = /出走表|番組|出走/.test(text) || /race|card|degree|shusso|syusso|hd=|rno=/i.test(href);
    if (!isResultLike && !isCardLike) continue;

    // 周辺テキストに日付らしき記述があれば、それが今日/明日かを判定する
    const contextDateLabel = /本日|今日/.test(context) ? todayLabel : /明日|翌日/.test(context) ? tomorrowLabel : detectDateLabel(context, referenceDate);
    const absolute = resolve(href);
    if (!absolute) continue;

    if (isResultLike) {
      const matchesToday = isSameDateLabel(contextDateLabel, todayLabel);
      if (!resultUrl || (matchesToday && !resultUrlDated)) {
        resultUrl = absolute;
        resultUrlDated = matchesToday;
      }
    }
    if (isCardLike) {
      const matchesTomorrow = isSameDateLabel(contextDateLabel, tomorrowLabel);
      if (!nextDayUrl || (matchesTomorrow && !nextDayUrlDated)) {
        nextDayUrl = absolute;
        nextDayUrlDated = matchesTomorrow;
      }
    }
  }

  return { resultUrl, nextDayUrl };
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

    // レース番号をテーブル直前の見出しやcaptionから推定する
    const precedingText = normalizeText(
      (table.caption ? table.caption.textContent : '') +
        ' ' +
        (table.previousElementSibling ? table.previousElementSibling.textContent : '')
    );
    let raceNumber = detectRaceNumber(precedingText);
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
    parseResultHtml,
    parseResultsFromPage,
    extractRaceUrlsFromIndexPage,
    extractResultAndNextDayUrls,
    normalizeText,
  };
}
