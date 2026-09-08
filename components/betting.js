/**
 * components/betting.js
 * ①券種ごとのAIおすすめ買い方の生成(毎日の結果から学習した選手データで強化)、
 * ②おすすめレースの単勝買い目自動生成・的中判定・回収率計算をまとめたモジュール。
 */

/** 選手が2着になる確率の近似値(連対率から勝率を引いたもの、負値は0に丸める) */
function secondPlaceProb(p) {
  return Math.max(0, (p.placeRate || 0) - (p.winRate || 0));
}

/**
 * 選手の3連対率(3着以内に入る確率)を解決する。
 * riders学習データ(db.js)にshowRateがあればそれを優先し、無ければ連対率から回帰的に近似する。
 */
function resolveShowRate(p, riderMap) {
  const rider = riderMap && window.KeirinDB ? riderMap.get(window.KeirinDB.buildRiderId(p.name)) : null;
  if (rider && rider.showRate != null) return rider.showRate;
  return Math.min(0.99, (p.placeRate || 0) * 1.25 + 0.05);
}

/** 選手が3着になる確率の近似値(3連対率から連対率を引いたもの、負値は0に丸める) */
function thirdPlaceProb(p, riderMap) {
  return Math.max(0, resolveShowRate(p, riderMap) - (p.placeRate || 0));
}

/** 2名が同じライン(race.linesの同じ配列)に属しているかどうか */
function isSameLine(numberA, numberB, lines) {
  return (lines || []).some((l) => l.includes(numberA) && l.includes(numberB));
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
 * @param {{riderMap?: Map<string,object>, lines?: number[][]}} [options]
 *   riderMap: db.getRiderMap()の結果(3連対率など学習データで買い目を強化する)
 *   lines: レースのライン構成(二車複のライン相性判定に使う)
 * @returns {{win:object[], place:object[], quinella:object[], exacta:object[], wide:object[], trio:object[], trifecta:object[]}}
 */
function buildPredictions(players, options = {}) {
  const { riderMap, lines } = options;
  const valid = (players || []).filter((p) => p.number != null);
  if (valid.length === 0) {
    return { win: [], place: [], quinella: [], exacta: [], wide: [], trio: [], trifecta: [] };
  }

  const winScore = (p) => (p.winRate || 0) * (p.odds || 1);
  const placeScore = (p) => (p.placeRate || 0) * (p.odds || 1);

  const byWinScore = [...valid].sort((a, b) => winScore(b) - winScore(a));
  const byPlaceScore = [...valid].sort((a, b) => placeScore(b) - placeScore(a));
  const byPlaceRate = [...valid].sort((a, b) => (b.placeRate || 0) - (a.placeRate || 0));

  // 単勝: 勝率 × オッズ が最も高い選手
  const win = byWinScore.slice(0, 1).map((p) => ({
    number: p.number,
    name: p.name,
    winRate: p.winRate,
    score: Number(winScore(p).toFixed(3)),
  }));

  // 複勝: 連対率 × オッズ が高い上位2名
  const place = byPlaceScore.slice(0, 2).map((p) => ({
    number: p.number,
    name: p.name,
    placeRate: p.placeRate,
    score: Number(placeScore(p).toFixed(3)),
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

  // 二車複: 連対率 × ライン相性(同じラインなら1.3倍のボーナス)が高い組み合わせ
  const quinellaCandidates = combinations([...valid].sort((a, b) => (b.placeRate || 0) - (a.placeRate || 0)).slice(0, 4), 2).map(
    (combo) => {
      const lineBonus = isSameLine(combo[0].number, combo[1].number, lines) ? 1.3 : 1.0;
      const score = combo.reduce((acc, p) => acc * (p.placeRate || 0), 1) * lineBonus;
      return { combo: combo.map((p) => p.number), names: combo.map((p) => p.name), score: Number(score.toFixed(4)) };
    }
  );
  quinellaCandidates.sort((a, b) => b.score - a.score);
  const quinella = quinellaCandidates.slice(0, 1);

  // 二車単: 勝率 × 2着率 × オッズ が最も高い並びを採用
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

  // 三連単: 勝率 × 2着率 × 3着率 × オッズ が最も高い並びを採用(上位候補から探索)
  const trifectaTop = [...valid].sort((a, b) => winScore(b) - winScore(a)).slice(0, 5);
  const trifectaCandidates = [];
  for (const a of trifectaTop) {
    for (const b of trifectaTop) {
      if (b.number === a.number) continue;
      for (const c of trifectaTop) {
        if (c.number === a.number || c.number === b.number) continue;
        const score = (a.winRate || 0) * secondPlaceProb(b) * thirdPlaceProb(c, riderMap) * (a.odds || 1);
        trifectaCandidates.push({ order: [a.number, b.number, c.number], names: [a.name, b.name, c.name], score });
      }
    }
  }
  trifectaCandidates.sort((x, y) => y.score - x.score);
  const trifecta = trifectaCandidates.slice(0, 1).map((c) => ({ ...c, score: Number(c.score.toFixed(4)) }));

  return { win, place, quinella, exacta, wide, trio, trifecta };
}

/** オッズ×的中確率(期待値)で全選手をランキング化する */
function buildExpectedValueRanking(players) {
  return (players || [])
    .filter((p) => p.number != null)
    .map((p) => ({
      number: p.number,
      name: p.name,
      odds: p.odds != null ? p.odds : null,
      winRate: p.winRate,
      expectedValue: p.expectedValue,
    }))
    .sort((a, b) => (b.expectedValue ?? -1) - (a.expectedValue ?? -1));
}

/** 選手1名の展開上の役割を脚質・ライン位置から言語化する */
function describeRaceRole(player) {
  if (player.linePosition === 1 && player.style === '逃げ') return '先行濃厚';
  if (player.linePosition === 1) return '先頭誘導';
  if (player.linePosition === 2) return '番手';
  if (player.style === 'まくり') return 'まくり主体';
  if (player.style === '差し') return '差し狙い';
  return '単騎';
}

/** 脚質・直近の決まり手・ライン位置からレース展開を1文で生成する */
function buildRaceFlow(players) {
  const ranked = [...(players || [])].sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0)).slice(0, 3);
  if (ranked.length === 0) return '展開を予測するデータが不足しています。';
  const parts = ranked.map((p) => `${p.number}番が${describeRaceRole(p)}`);
  return `${parts.join('、')}、という展開が濃厚。`;
}

/**
 * 得点差・脚質構成・頭数・ライン強度からレースの荒れやすさを判定する。
 * @returns {{stars:number, label:string, score:number}}
 */
function buildRaceRisk(players, lines) {
  const valid = players || [];
  const scores = valid.map((p) => p.score).filter((s) => s != null);
  const scoreSpread = scores.length ? Math.max(...scores) - Math.min(...scores) : 10;
  const styleDiversity = new Set(valid.map((p) => p.style).filter(Boolean)).size;
  const fieldSize = valid.length;
  const singleLineCount = (lines || []).filter((l) => l.length <= 1).length;

  let riskScore = 0;
  riskScore += Math.max(0, 10 - scoreSpread) * 2; // 得点差が小さいほど荒れやすい
  riskScore += styleDiversity * 8; // 脚質が割れているほど荒れやすい
  riskScore += fieldSize * 2; // 頭数が多いほど荒れやすい
  riskScore += singleLineCount * 6; // 単騎(ラインを組まない選手)が多いほど荒れやすい

  const stars = Math.max(1, Math.min(5, Math.round(riskScore / 20)));
  const labels = ['本命堅め', '順当決着寄り', 'やや荒れやすい', '荒れやすい', 'かなり荒れやすい'];
  return { stars, label: labels[stars - 1], score: Number(riskScore.toFixed(1)) };
}

/** 荒れ度に応じたおすすめの買い方戦略を1文で生成する */
function buildRaceStrategy(raceRisk) {
  if (!raceRisk) return 'データ不足のため戦略の提案を見送りました。';
  if (raceRisk.stars >= 4) return '荒れやすいレースのため、三連複・ワイドなど的中率重視の買い方がおすすめ。';
  if (raceRisk.stars === 3) return 'やや荒れる可能性があるため、二車複・ワイドを中心に手広く狙いたい。';
  if (raceRisk.stars === 2) return '順当決着寄りのため、二車単・単勝で高配当を狙うのもあり。';
  return '本命が堅いレースのため、単勝・二車複で手堅く。';
}

/**
 * riders学習データの直近の決まり手履歴から、脚質の変化(傾向シフト)を検出する。
 * 直近2走が同じ決まり手で、それが本来の脚質と異なり、かつそれ以前には見られなかった場合に変化とみなす。
 */
function detectStyleChanges(players, riderMap) {
  if (!riderMap || !window.KeirinDB) return [];
  const notes = [];
  for (const p of players || []) {
    const rider = riderMap.get(window.KeirinDB.buildRiderId(p.name));
    if (!rider || !rider.recentMoves) continue;
    const recent = rider.recentMoves.filter(Boolean);
    if (recent.length < 3) continue;
    const lastTwo = recent.slice(-2);
    const earlier = recent.slice(0, -2);
    const shiftedTo = lastTwo[0];
    if (lastTwo.length === 2 && lastTwo[0] === lastTwo[1] && shiftedTo !== p.style && !earlier.includes(shiftedTo)) {
      notes.push({ number: p.number, name: p.name, from: p.style || '不明', to: shiftedTo });
    }
  }
  return notes;
}

/**
 * riders学習データのpairStats(相性)から、レース内で最も相性の良いパートナーを選手ごとに探す。
 * 二車複・二車単の参考情報として表示する。
 */
function buildCompatibilityNotes(players, riderMap) {
  if (!riderMap || !window.KeirinDB) return [];
  const idOf = (name) => window.KeirinDB.buildRiderId(name);
  const idToPlayer = new Map((players || []).map((p) => [idOf(p.name), p]));
  const notes = [];
  for (const p of players || []) {
    const rider = riderMap.get(idOf(p.name));
    if (!rider || !rider.pairStats) continue;
    let best = null;
    for (const [targetId, stats] of Object.entries(rider.pairStats)) {
      if (targetId === idOf(p.name) || !idToPlayer.has(targetId)) continue;
      if (!stats.races || stats.placeRate <= 0) continue;
      if (!best || stats.placeRate > best.stats.placeRate) best = { targetId, stats };
    }
    if (best) {
      const partner = idToPlayer.get(best.targetId);
      notes.push({
        number: p.number,
        name: p.name,
        partnerNumber: partner.number,
        partnerName: partner.name,
        placeRate: best.stats.placeRate,
        races: best.stats.races,
      });
    }
  }
  return notes;
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
  window.KeirinBetting = {
    buildPredictions,
    buildExpectedValueRanking,
    buildRaceFlow,
    buildRaceRisk,
    buildRaceStrategy,
    detectStyleChanges,
    buildCompatibilityNotes,
    generateBetsForRace,
    judgeBet,
    computeDailyRecovery,
  };
}
