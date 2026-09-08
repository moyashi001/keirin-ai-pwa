/**
 * components/betting.js
 * おすすめレースの買い目自動生成・的中判定・回収率計算をまとめたモジュール。
 * シンプルさを優先し、1レースにつき「AI本命選手の単勝100円」を基準の買い目とする。
 */

/** おすすめレースの買い目(単勝100円)を生成する */
function generateBetsForRace(race) {
  const ranked = [...race.players].sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0));
  const honmei = ranked[0];
  if (!honmei) return null;
  return {
    raceKey: race.raceKey,
    date: race.date,
    venue: race.venue,
    raceNumber: race.raceNumber,
    betType: '単勝',
    targetNumber: honmei.number,
    targetName: honmei.name,
    stake: 100,
    odds: honmei.odds,
  };
}

/**
 * 結果データ(parseResultHtmlの出力)と買い目から的中/払戻を判定する。
 * @param {object} bet generateBetsForRace()の出力
 * @param {object} result parseResultHtmlの出力 { order: [{number, rank}, ...] }
 */
function judgeBet(bet, result) {
  if (!bet || !result || !result.order || result.order.length === 0) {
    return { ...bet, judged: false, hit: null, payout: 0 };
  }
  const winner = result.order.find((o) => o.rank === 1);
  const hit = !!winner && winner.number === bet.targetNumber;
  const payout = hit && bet.odds != null ? Math.round(bet.odds * bet.stake) : hit ? bet.stake : 0;
  return { ...bet, judged: true, hit, payout, actualWinner: winner || null };
}

/**
 * 1日分のレース群から日次回収率を計算する。
 * @param {object[]} races その日のおすすめレース(推論済み)
 * @param {object[]} results 対応する結果データの配列(raceKeyで突合)
 */
function computeDailyRecovery(date, races, results) {
  const resultMap = new Map(results.map((r) => [r.raceKey, r]));
  const recommendedRaces = races.filter((r) => r.recommended);
  const bets = recommendedRaces.map((race) => {
    const bet = generateBetsForRace(race);
    const result = resultMap.get(race.raceKey);
    return result ? judgeBet(bet, result) : { ...bet, judged: false, hit: null, payout: 0 };
  });

  const judgedBets = bets.filter((b) => b.judged);
  const invested = bets.length * 100;
  const returned = bets.reduce((sum, b) => sum + (b.payout || 0), 0);
  const recoveryRate = invested > 0 ? Number(((returned / invested) * 100).toFixed(1)) : null;

  return {
    date,
    invested,
    returned,
    recoveryRate,
    totalBets: bets.length,
    judgedBets: judgedBets.length,
    hitBets: bets.filter((b) => b.hit).length,
    bets,
  };
}

if (typeof window !== 'undefined') {
  window.KeirinBetting = { generateBetsForRace, judgeBet, computeDailyRecovery };
}
