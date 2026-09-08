/**
 * components/betting.js
 * ①券種ごとのAIおすすめ買い方の生成、②おすすめレースの単勝買い目自動生成・
 * 的中判定・回収率計算をまとめたモジュール。
 */

/** 選手が2着になる確率の近似値(連対率から勝率を引いたもの、負値は0に丸める) */
function secondPlaceProb(p) {
  return Math.max(0, (p.placeRate || 0) - (p.winRate || 0));
}

/** 配列から重複無しでn個選ぶ組み合わせを列挙する(順不同) */
function combinations(arr, n) {
  if (n === 0) return [[]];
  if (arr.length < n) return [];
  const [first, ...rest] = arr;
  const withFirst = combinations(rest, n - 1).map((c) => [first, ...c]);
  const withoutFirst = combinations(rest, n);
  return [...withFirst, ...withoutFirst];
}

/**
 * AI推論結果(勝率・連対率・期待値)を使って、券種ごとのおすすめ買い方を生成する。
 * @param {object[]} players winRate/placeRate/expectedValue/oddsを持つ選手配列
 * @returns {{win:object[], place:object[], quinella:object[], exacta:object[], wide:object[], trio:object[], trifecta:object[]}}
 */
function buildPredictions(players) {
  const valid = (players || []).filter((p) => p.number != null);
  if (valid.length === 0) {
    return { win: [], place: [], quinella: [], exacta: [], wide: [], trio: [], trifecta: [] };
  }

  const byWinRate = [...valid].sort((a, b) => (b.winRate || 0) - (a.winRate || 0));
  const byPlaceRate = [...valid].sort((a, b) => (b.placeRate || 0) - (a.placeRate || 0));
  const byExpectedValue = [...valid].sort((a, b) => (b.expectedValue ?? b.winRate ?? 0) - (a.expectedValue ?? a.winRate ?? 0));

  // 単勝: 勝率が最も高い選手
  const win = byWinRate.slice(0, 1).map((p) => ({
    number: p.number,
    name: p.name,
    winRate: p.winRate,
  }));

  // 複勝: 連対率が高い上位2名
  const place = byPlaceRate.slice(0, 2).map((p) => ({
    number: p.number,
    name: p.name,
    placeRate: p.placeRate,
  }));

  // ワイド: 連対率が高い組み合わせ(上位3名から2名の組を作り、連対率の積が高い順)
  const wideTop = byPlaceRate.slice(0, 3);
  const wide = combinations(wideTop, 2)
    .map((combo) => ({
      combo: combo.map((p) => p.number),
      names: combo.map((p) => p.name),
      score: Number(combo.reduce((acc, p) => acc * (p.placeRate || 0), 1).toFixed(4)),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);

  // 二車複: 勝率上位2名の組み合わせ
  const quinellaTop = byWinRate.slice(0, 2);
  const quinella =
    quinellaTop.length === 2
      ? [
          {
            combo: quinellaTop.map((p) => p.number),
            names: quinellaTop.map((p) => p.name),
            score: Number((quinellaTop[0].winRate * secondPlaceProb(quinellaTop[1]) + quinellaTop[1].winRate * secondPlaceProb(quinellaTop[0])).toFixed(4)),
          },
        ]
      : [];

  // 二車単: 1着確率 × 2着確率 × オッズ が最も高い並びを採用
  const exactaCandidates = [];
  for (const a of valid) {
    for (const b of valid) {
      if (a.number === b.number) continue;
      const score = (a.winRate || 0) * secondPlaceProb(b) * (a.odds || 1);
      exactaCandidates.push({ order: [a.number, b.number], names: [a.name, b.name], score });
    }
  }
  exactaCandidates.sort((a, b) => b.score - a.score);
  const exacta = exactaCandidates.slice(0, 2).map((c) => ({ ...c, score: Number(c.score.toFixed(3)) }));

  // 三連複: 連対率上位3名の組み合わせ(積が高い)
  const trioTop = byPlaceRate.slice(0, 3);
  const trio =
    trioTop.length === 3
      ? [
          {
            combo: trioTop.map((p) => p.number),
            names: trioTop.map((p) => p.name),
            score: Number(trioTop.reduce((acc, p) => acc * (p.placeRate || 0), 1).toFixed(4)),
          },
        ]
      : [];

  // 三連単: 期待値が高い上位3名をそのまま1着-2着-3着の順に採用
  const trifectaTop = byExpectedValue.slice(0, 3);
  const trifecta =
    trifectaTop.length === 3
      ? [
          {
            order: trifectaTop.map((p) => p.number),
            names: trifectaTop.map((p) => p.name),
            score: Number(trifectaTop.reduce((acc, p) => acc * (p.expectedValue ?? p.winRate ?? 0), 1).toFixed(4)),
          },
        ]
      : [];

  return { win, place, quinella, exacta, wide, trio, trifecta };
}

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
  let payout = 0;
  if (hit) {
    // 結果ページから実際の単勝払戻し額が取れていればそれを優先し、無ければオッズから概算する
    const actualPayout = result.payouts && result.payouts.win;
    if (actualPayout && String(actualPayout.combo) === String(bet.targetNumber)) {
      payout = actualPayout.amount;
    } else if (bet.odds != null) {
      payout = Math.round(bet.odds * bet.stake);
    } else {
      payout = bet.stake;
    }
  }
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
  window.KeirinBetting = { buildPredictions, generateBetsForRace, judgeBet, computeDailyRecovery };
}
