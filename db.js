/**
 * db.js
 * IndexedDBラッパー。レース予測結果と日次回収率ログを永続化する。
 *
 * 運用上、DBには「当日の結果待ちレース(前回アクセス時に翌日予想として保存したもの)」と
 * 「新しく取得した翌日予想レース」が一時的に同居し得る。当日結果の回収率計算が済んだら
 * clearRacesByDate() でその日付のレースだけを削除し、無制限に溜まらないようにする。
 */

const DB_NAME = 'keirin-ai-db';
const DB_VERSION = 1;
const STORE_RACES = 'races';
const STORE_LOGS = 'dailyLogs';

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
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

/** 指定した日付(YYYY-MM-DD)のレースだけを一括削除する(結果処理が済んだ分の掃除用) */
async function clearRacesByDate(date) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_RACES, 'readwrite');
    const store = t.objectStore(STORE_RACES);
    const req = store.getAll();
    req.onsuccess = () => {
      (req.result || []).filter((r) => r.date === date).forEach((r) => store.delete(r.raceKey));
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

if (typeof window !== 'undefined') {
  window.KeirinDB = {
    saveRace,
    saveRaces,
    getAllRaces,
    clearRacesByDate,
    getRace,
    deleteRace,
    saveDailyLog,
    getAllDailyLogs,
    getDailyLog,
  };
}
