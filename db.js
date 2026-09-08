/**
 * db.js
 * IndexedDBラッパー。レース予測結果・日次回収率ログ・選手ごとの学習データを永続化する。
 *
 * 運用上、DBには「当日の結果待ちレース(前回アクセス時に翌日予想として保存したもの)」と
 * 「新しく取得した翌日予想レース」が一時的に同居し得る。当日結果の回収率計算が済んだら
 * markRacesSettled() でその日付のレースに settled:true を付ける(削除はしない)。
 * これにより予想一覧の日付フィルタから過去の予想を履歴として参照できる。
 *
 * riders ストアは「毎日の結果から自己学習するAI」のための選手別成績データ。
 * 出走表・結果ページには選手固有IDが載らないため、選手名を正規化した文字列を
 * riderId として使う(同姓同名の選手が同一人物として扱われる制約がある)。
 * pairStats は選手同士の相性(連対率・3連対率)、conditionIndex は直近5走から
 * 算出した調子指数で、どちらも結果解析のたびに更新される。
 */

const DB_NAME = 'keirin-ai-db';
const DB_VERSION = 3;
const STORE_RACES = 'races';
const STORE_LOGS = 'dailyLogs';
const STORE_RIDERS = 'riders';
const STORE_RESULTS = 'results';
const RECENT_HISTORY_LENGTH = 5;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RACES)) {
        db.createObjectStore(STORE_RACES, { keyPath: 'raceKey' });
      }
      if (!db.objectStoreNames.contains(STORE_LOGS)) {
        db.createObjectStore(STORE_LOGS, { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains(STORE_RIDERS)) {
        db.createObjectStore(STORE_RIDERS, { keyPath: 'riderId' });
      }
      if (!db.objectStoreNames.contains(STORE_RESULTS)) {
        // 結果ページは競輪場ごとに別々に貼り付けられるため、レース単位(raceKey)で蓄積し、
        // 日次回収率は「その日付分の全結果」を都度合算して計算する(後から別会場の結果を
        // 貼り付けても、先に判定済みだった会場の結果が消えないようにするため)。
        db.createObjectStore(STORE_RESULTS, { keyPath: 'raceKey' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** 選手名からriderId(DBの主キー)を生成する。全角/空白の揺れを吸収するため正規化する。 */
function buildRiderId(name) {
  const normalized = window.KeirinParser ? window.KeirinParser.normalizeText(name) : String(name || '').trim();
  return normalized.replace(/\s+/g, '');
}

/** 直近5走の着順配列(数値, 1が1着)から勝率・連対率・3連対率を計算する */
function computeRatesFromHistory(recentResults) {
  const valid = (recentResults || []).filter((r) => typeof r === 'number' && !isNaN(r));
  const n = valid.length;
  if (n === 0) return { winRate: 0, placeRate: 0, showRate: 0 };
  const wins = valid.filter((r) => r === 1).length;
  const places = valid.filter((r) => r <= 2).length;
  const shows = valid.filter((r) => r <= 3).length;
  return {
    winRate: Number((wins / n).toFixed(3)),
    placeRate: Number((places / n).toFixed(3)),
    showRate: Number((shows / n).toFixed(3)),
  };
}

/**
 * 調子指数 = (勝率×3 + 連対率×2 + 3連対率×1 + 決まり手成功率×1) × 10
 * 決まり手成功率は「直近5走のうち、自分の脚質どおりの決まり手で走れた割合」。
 */
function computeConditionIndex(rider) {
  const total = (rider.recentResults || []).length;
  if (total === 0) return 0;
  const moves = rider.recentMoves || [];
  const moveSuccessCount = moves.filter((m) => m && rider.style && m === rider.style).length;
  const moveSuccessRate = moveSuccessCount / total;
  const index = ((rider.winRate || 0) * 3 + (rider.placeRate || 0) * 2 + (rider.showRate || 0) * 1 + moveSuccessRate * 1) * 10;
  return Number(index.toFixed(1));
}

async function tx(storeName, mode) {
  const db = await openDB();
  return db.transaction(storeName, mode).objectStore(storeName);
}

async function saveRace(race) {
  const store = await tx(STORE_RACES, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(race);
    req.onsuccess = () => resolve(race);
    req.onerror = () => reject(req.error);
  });
}

async function saveRaces(races) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_RACES, 'readwrite');
    const store = t.objectStore(STORE_RACES);
    races.forEach((r) => store.put(r));
    t.oncomplete = () => resolve(races);
    t.onerror = () => reject(t.error);
  });
}

async function getAllRaces() {
  const store = await tx(STORE_RACES, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 指定した日付(YYYY-MM-DD)のレースを「決着済み(settled)」にマークする。
 * 削除はせず保持することで、予想一覧の日付フィルタ(履歴表示)から後で参照できるようにする。
 */
async function markRacesSettled(date) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_RACES, 'readwrite');
    const store = t.objectStore(STORE_RACES);
    const req = store.getAll();
    req.onsuccess = () => {
      (req.result || [])
        .filter((r) => r.date === date)
        .forEach((r) => store.put({ ...r, settled: true }));
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

async function getRace(raceKey) {
  const store = await tx(STORE_RACES, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(raceKey);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function deleteRace(raceKey) {
  const store = await tx(STORE_RACES, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(raceKey);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function saveDailyLog(log) {
  const store = await tx(STORE_LOGS, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(log);
    req.onsuccess = () => resolve(log);
    req.onerror = () => reject(req.error);
  });
}

async function getAllDailyLogs() {
  const store = await tx(STORE_LOGS, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result || []).sort((a, b) => a.date.localeCompare(b.date)));
    req.onerror = () => reject(req.error);
  });
}

async function getDailyLog(date) {
  const store = await tx(STORE_LOGS, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(date);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** 結果(レース単位)を蓄積保存する。同じraceKeyは上書き、別会場・別レースの結果は保持される。 */
async function saveResults(results) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_RESULTS, 'readwrite');
    const store = t.objectStore(STORE_RESULTS);
    (results || []).forEach((r) => store.put(r));
    t.oncomplete = () => resolve(results);
    t.onerror = () => reject(t.error);
  });
}

/** 指定した日付(YYYY-MM-DD)分の結果を、これまで貼り付けた全会場分まとめて取得する */
async function getResultsForDate(date) {
  const store = await tx(STORE_RESULTS, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve((req.result || []).filter((r) => r.date === date));
    req.onerror = () => reject(req.error);
  });
}

async function getRider(riderId) {
  const store = await tx(STORE_RIDERS, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.get(riderId);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function getAllRiders() {
  const store = await tx(STORE_RIDERS, 'readonly');
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** riderId -> 学習データ のMapを一括取得する(特徴量生成・買い目強化で使う) */
async function getRiderMap() {
  const riders = await getAllRiders();
  return new Map(riders.map((r) => [r.riderId, r]));
}

/**
 * 結果1件分から選手の学習データを更新する(FIFOで直近5走を維持し、勝率等を再計算する)。
 * @param {string} name 選手名
 * @param {{rank:number, move?:string, line?:number, score?:number, style?:string}} entry
 * @param {string} date 結果の日付(YYYY-MM-DD)
 */
async function upsertRiderFromResult(name, entry, date) {
  const riderId = buildRiderId(name);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_RIDERS, 'readwrite');
    const store = t.objectStore(STORE_RIDERS);
    const getReq = store.get(riderId);
    getReq.onsuccess = () => {
      const existing = getReq.result || {
        riderId,
        name,
        score: null,
        style: null,
        recentResults: [],
        recentMoves: [],
        recentLine: [],
      };
      const recentResults = [...existing.recentResults, entry.rank].slice(-RECENT_HISTORY_LENGTH);
      const recentMoves = [...existing.recentMoves, entry.move || null].slice(-RECENT_HISTORY_LENGTH);
      const recentLine = [...existing.recentLine, entry.line != null ? entry.line : null].slice(-RECENT_HISTORY_LENGTH);
      const rates = computeRatesFromHistory(recentResults);
      const updated = {
        ...existing,
        riderId,
        name,
        score: entry.score != null ? entry.score : existing.score, // 競走得点は結果ページの値を優先
        style: entry.style || existing.style,
        recentResults,
        recentMoves,
        recentLine,
        ...rates,
        updatedAt: date,
      };
      updated.conditionIndex = computeConditionIndex(updated);
      store.put(updated);
    };
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

/**
 * 結果1レース分の着順配列から、選手同士の相性データ(pairStats)を更新する。
 * riderStats[riderId].pairStats[targetRiderId] = { races, winRate, placeRate, showRate }
 * winRate: 自分が1着、相手が2着以内(=二車単/二車複が絡んだ)割合
 * placeRate: 自分と相手が両方2着以内(=二車複が的中)割合
 * showRate: 自分と相手が両方3着以内(=三連系に絡んだ)割合
 * @param {Array<{number:number, name:string, rank:number}>} order
 */
async function updatePairStats(order) {
  const entries = (order || []).filter((o) => o.name);
  if (entries.length < 2) return;

  const ids = entries.map((o) => buildRiderId(o.name));
  const existing = await Promise.all(ids.map((id) => getRider(id)));
  const byId = new Map();
  ids.forEach((id, i) => byId.set(id, existing[i] || { riderId: id, name: entries[i].name, pairStats: {} }));

  for (let i = 0; i < entries.length; i++) {
    const a = entries[i];
    const aRider = byId.get(ids[i]);
    if (!aRider.pairStats) aRider.pairStats = {};
    for (let j = 0; j < entries.length; j++) {
      if (i === j) continue;
      const b = entries[j];
      const bId = ids[j];
      const cur = aRider.pairStats[bId] || { races: 0, winHits: 0, placeHits: 0, showHits: 0 };
      cur.races += 1;
      if (a.rank === 1 && b.rank <= 2) cur.winHits += 1;
      if (a.rank <= 2 && b.rank <= 2) cur.placeHits += 1;
      if (a.rank <= 3 && b.rank <= 3) cur.showHits += 1;
      cur.winRate = Number((cur.winHits / cur.races).toFixed(3));
      cur.placeRate = Number((cur.placeHits / cur.races).toFixed(3));
      cur.showRate = Number((cur.showHits / cur.races).toFixed(3));
      aRider.pairStats[bId] = cur;
    }
  }

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_RIDERS, 'readwrite');
    const store = t.objectStore(STORE_RIDERS);
    byId.forEach((rider) => store.put(rider));
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

if (typeof window !== 'undefined') {
  window.KeirinDB = {
    saveRace,
    saveRaces,
    getAllRaces,
    markRacesSettled,
    getRace,
    deleteRace,
    saveDailyLog,
    getAllDailyLogs,
    getDailyLog,
    saveResults,
    getResultsForDate,
    buildRiderId,
    getRider,
    getAllRiders,
    getRiderMap,
    upsertRiderFromResult,
    updatePairStats,
  };
}
