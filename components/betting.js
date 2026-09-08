/**
 * components/betting.js
 * ①「本命・中穴・大穴」3階層のワイド買い目の生成(毎日の結果から学習した選手データで強化)、
 * ②おすすめレースの単勝買い目自動生成・的中判定・回収率計算をまとめたモジュール。
 *
 * 買い目は券種をワイドのみに統一している。
 *  - 本命: AI推奨度が最も高い選手(軸)と、軸との連対率が最も高い相手のワイド(1点)
 *  - 中穴: 軸と、中位人気(2〜4番人気)の相手とのワイド(最大2点)
 *  - 大穴: 軸と、人気薄(オッズが高い)相手とのワイド(最大3点)
 */

/** 軸選手と相手選手のワイド1点分のエントリを組み立てる */
function buildWideEntry(axis, partner) {
  if (!axis || !partner) return null;
  return {
    combo: [axis.number, partner.number],
    names: [axis.name, partner.name],
    odds: axis.odds != null && partner.odds != null ? Number((axis.odds + partner.odds).toFixed(1)) : null,
  };
}

/**
 * AI推論結果(勝率・連対率・オッズ)を使って、本命・中穴・大穴の3階層でワイドのおすすめ買い方を生成する。
 * @param {object[]} players winRate/placeRate/aiScore/oddsを持つ選手配列
 * @returns {{honmei: object|null, nakaana: object[], ooana: object[]}}
 */
function buildPredictions(players) {
  const valid = (players || []).filter((p) => p.number != null);
  if (valid.length < 2) {
    return { honmei: null, nakaana: [], ooana: [] };
  }

  const axis = [...valid].sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0))[0];
  const others = valid.filter((p) => p.number !== axis.number);

  const byPlaceRate = [...others].sort((a, b) => (b.placeRate || 0) - (a.placeRate || 0));
  const byOddsAsc = [...others].filter((p) => p.odds != null).sort((a, b) => a.odds - b.odds); // 人気順(オッズ低い順)
  const byOddsDesc = [...others].filter((p) => p.odds != null).sort((a, b) => b.odds - a.odds); // 穴順(オッズ高い順)

  // 本命: 軸 + 連対率が最も高い相手のワイド1点
  const honmei = buildWideEntry(axis, byPlaceRate[0]);

  // 中穴: 軸 + 2〜4番人気(中位人気)の相手とのワイド最大2点
  const nakaana = byOddsAsc.slice(1, 4).slice(0, 2).map((p) => buildWideEntry(axis, p)).filter(Boolean);

  // 大穴: 軸 + 人気薄(オッズが高い順)の相手とのワイド最大3点
  const ooana = byOddsDesc.slice(0, 3).map((p) => buildWideEntry(axis, p)).filter(Boolean);

  return { honmei, nakaana, ooana };
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

/**
 * おすすめレースの買い目(ワイド100円×本命/中穴/大穴)を生成する。
 * 「AIおすすめ買い方」(buildPredictions)で提示している組み合わせをそのまま
 * 回収率集計の対象にする(単勝ではなく実際に提案しているワイドで判定するため)。
 */
function generateWideBetsForRace(race) {
  const predictions = race.predictions;
  if (!predictions) return [];

  const entries = [];
  if (predictions.honmei) entries.push({ ...predictions.honmei, category: '本命' });
  (predictions.nakaana || []).forEach((c) => entries.push({ ...c, category: '中穴' }));
  (predictions.ooana || []).forEach((c) => entries.push({ ...c, category: '大穴' }));

  return entries.map((entry) => ({
    raceKey: race.raceKey,
    date: race.date,
    venue: race.venue,
    raceNumber: race.raceNumber,
    betType: 'ワイド',
    category: entry.category,
    combo: entry.combo,
    names: entry.names || null,
    stake: 100,
    odds: entry.odds,
  }));
}

/**
 * 結果データ(parseResultsFromPageの出力)とワイド買い目から的中/払戻を判定する。
 * ワイドは組み合わせの2車がどちらも3着以内に入れば的中。
 * @param {object} bet generateWideBetsForRace()の出力1件分
 * @param {object} result parseResultsFromPageの出力 { order: [{number, rank}, ...], payouts }
 */
function judgeWideBet(bet, result) {
  if (!bet || !result || !result.order || result.order.length === 0) {
    return { ...bet, judged: false, hit: null, payout: 0 };
  }
  const top3 = new Set(result.order.filter((o) => o.rank <= 3).map((o) => o.number));
  const hit = (bet.combo || []).length === 2 && bet.combo.every((n) => top3.has(n));
  let payout = 0;
  if (hit) {
    // 結果ページに実際のワイド払戻し額があればそれを優先し、無ければ推定オッズから概算する
    // (KEIRIN.JPの結果ページは通常2車単・3連単のみ掲載でワイドが無いことが多い)
    const actualPayout = result.payouts && result.payouts.wide;
    const comboKey = [...bet.combo].sort((a, b) => a - b).join('-');
    if (actualPayout) {
      const actualCombo = String(actualPayout.combo)
        .split(/[-‐=]/)
        .map(Number)
        .sort((a, b) => a - b)
        .join('-');
      if (actualCombo === comboKey) payout = actualPayout.amount;
    }
    if (!payout) payout = bet.odds != null ? Math.round(bet.odds * bet.stake) : bet.stake;
  }
  return { ...bet, judged: true, hit, payout };
}

/**
 * 1日分のレース群から日次回収率を計算する。おすすめレースごとに「AIおすすめ買い方」の
 * ワイド(本命/中穴/大穴、最大6点)を1点100円で購入した想定で集計する。
 * @param {object[]} races その日のおすすめレース(推論済み)
 * @param {object[]} results 対応する結果データの配列(raceKeyで突合)
 */
function computeDailyRecovery(date, races, results) {
  const resultMap = new Map(results.map((r) => [r.raceKey, r]));
  // 競輪場ごとにまとめ、各会場内は1R→12Rの順に並べる(表示上の見やすさのため)
  const recommendedRaces = races
    .filter((r) => r.recommended)
    .sort((a, b) => (a.venue || '').localeCompare(b.venue || '', 'ja') || (a.raceNumber || 0) - (b.raceNumber || 0));
  const bets = recommendedRaces.flatMap((race) => {
    const raceBets = generateWideBetsForRace(race);
    const result = resultMap.get(race.raceKey);
    return raceBets.map((bet) => (result ? judgeWideBet(bet, result) : { ...bet, judged: false, hit: null, payout: 0 }));
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
    generateWideBetsForRace,
    judgeWideBet,
    computeDailyRecovery,
  };
}
