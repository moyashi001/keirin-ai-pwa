/**
 * modelRunner.js
 * ONNX Runtime Web を使ったブラウザ内AI推論。
 *
 * training/ 以下のPythonパイプラインで学習したLightGBMモデルを
 * assets/keirin_model.onnx としてONNX変換して配置している。
 * 特徴量の組み立ては featureBuilder.js が担当し、この並び順が
 * 学習時(training/build_features.py の FEATURE_COLUMNS)と一致している必要がある。
 *
 * assets/keirin_model.onnx が読み込めない場合(未配置・読み込み失敗)は、
 * 同じ特徴量を使った軽量なルールベース推論に自動フォールバックする。
 *
 * 調子指数(riders学習データ由来)はONNXモデルの入力次元(9次元固定、変更すると
 * 再学習なしには推論できなくなる)には含めず、推論後のAI推奨度(aiScore)への
 * 補正として反映している。
 */

let ortSession = null;
let ortLoadAttempted = false;

// 「AIおすすめ」リボンの判定基準。当たりやすさ(勝率)と儲けやすさ(期待値)の
// 両方を満たすレースだけを厳選する。競輪は7〜9車立てが基本のため、均等なら
// 1人あたりの勝率は11〜14%程度。その倍以上ある30%を「明確な本命」の目安とする。
const RECOMMEND_WIN_RATE_THRESHOLD = 0.3;
const RECOMMEND_EXPECTED_VALUE_THRESHOLD = 1.0;

/** レース内で各選手の独立勝率を合計1になるよう正規化する */
function normalizeToDistribution(values) {
  const sum = values.reduce((a, b) => a + b, 0);
  if (sum <= 0) return values.map(() => 1 / values.length);
  return values.map((v) => v / sum);
}

/** assets/keirin_model.onnx のロードを一度だけ試みる。無ければ null のまま。 */
async function tryLoadOnnxModel() {
  if (ortLoadAttempted) return ortSession;
  ortLoadAttempted = true;
  if (typeof ort === 'undefined') return null;
  try {
    ort.env.wasm.wasmPaths = 'vendor/ort/';
    const res = await fetch('assets/keirin_model.onnx', { method: 'HEAD' });
    if (!res.ok) return null;
    ortSession = await ort.InferenceSession.create('assets/keirin_model.onnx', { executionProviders: ['wasm'] });
    console.info('[modelRunner] assets/keirin_model.onnx をロードしました。LightGBM(ONNX)推論モードで動作します。');
  } catch (err) {
    console.warn('[modelRunner] ONNXモデルのロードに失敗、ルールベース推論にフォールバックします。', err);
    ortSession = null;
  }
  return ortSession;
}

/**
 * ONNX推論を実行し、各選手の「1着になる確率」を返す。
 * LightGBM(convert_to_onnx.py, zipmap=False)の出力は
 * ['label', 'probabilities'] で、probabilities は [N, 2] (0:負け, 1:1着)。
 */
async function runOnnxInference(session, vectors) {
  const inputName = session.inputNames[0];
  const n = vectors.length;
  const dim = vectors[0].length;
  const flat = new Float32Array(n * dim);
  vectors.forEach((row, i) => row.forEach((v, j) => (flat[i * dim + j] = v)));
  const tensor = new ort.Tensor('float32', flat, [n, dim]);
  const outputMap = await session.run({ [inputName]: tensor });

  const probOutput = outputMap['probabilities'] || outputMap[session.outputNames[session.outputNames.length - 1]];
  const data = probOutput.data;
  const outDim = probOutput.dims[probOutput.dims.length - 1];
  const winProbs = [];
  for (let i = 0; i < n; i++) {
    winProbs.push(data[i * outDim + (outDim - 1)]); // 最後の列 = 1着(is_win=1)クラスの確率
  }
  return winProbs;
}

/** ルールベース推論エンジン(ONNXモデル未配置時のフォールバック)。特徴量はfeatureBuilder.jsと同じもの。 */
const RULE_WEIGHTS = {
  scoreNorm: 2.0,
  styleNige: 0.3,
  styleOikomi: 0.2,
  styleRyo: 0.1,
  recentRankBonus: 1.3, // 平均着順が良い(小さい)ほど加点
  recentNigeRate: 0.4,
  recentMakuriRate: 0.5,
  recentSashiRate: 0.35,
  rankPositionBonus: 1.2, // 予想印/オッズ順位が良い(小さい)ほど加点
};

function ruleBasedLogits(vector) {
  const [raceScore, styleNige, styleOikomi, styleRyo, recentAvgRank, nigeRate, makuriRate, sashiRate, rankPosition] = vector;
  const scoreNorm = Math.max(0, Math.min(1, (raceScore - 60) / 60));
  const recentRankBonus = Math.max(0, (9 - recentAvgRank) / 9);
  const rankPositionBonus = Math.max(0, (8 - rankPosition) / 7);

  return (
    scoreNorm * RULE_WEIGHTS.scoreNorm +
    styleNige * RULE_WEIGHTS.styleNige +
    styleOikomi * RULE_WEIGHTS.styleOikomi +
    styleRyo * RULE_WEIGHTS.styleRyo +
    recentRankBonus * RULE_WEIGHTS.recentRankBonus +
    nigeRate * RULE_WEIGHTS.recentNigeRate +
    makuriRate * RULE_WEIGHTS.recentMakuriRate +
    sashiRate * RULE_WEIGHTS.recentSashiRate +
    rankPositionBonus * RULE_WEIGHTS.rankPositionBonus
  );
}

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

/**
 * レース1件分の推論を実行し、各選手に winRate / placeRate / expectedValue / aiScore を付与する。
 * @param {object} race parseRaceCardHtml() の出力
 * @param {Map<string,object>} [riderMap] db.getRiderMap()の結果。あれば選手ごとの学習データで特徴量を補強する。
 * @returns {Promise<object>} 推論結果を付与したレースオブジェクト
 */
async function predictRace(race, riderMap) {
  const { vectors, players } = window.KeirinFeatureBuilder.buildFeatureMatrix(race, riderMap);
  const session = await tryLoadOnnxModel();

  let winRates;
  let usedOnnx = false;
  if (session) {
    try {
      const rawProbs = await runOnnxInference(session, vectors);
      winRates = normalizeToDistribution(rawProbs);
      usedOnnx = true;
    } catch (err) {
      console.warn('[modelRunner] ONNX推論に失敗、ルールベースにフォールバックします。', err);
    }
  }
  if (!winRates) {
    const logits = vectors.map(ruleBasedLogits);
    winRates = softmax(logits);
  }

  // データ充実度(得点・オッズ・脚質・直近成績が揃っているほど信頼度が高い)
  const completeness = players.map((player) => {
    let filled = 0;
    if (player.score != null) filled++;
    if (player.odds != null) filled++;
    if (player.style) filled++;
    if (player.recentResults) filled++;
    return filled / 4;
  });

  const resultPlayers = players.map((player, i) => {
    const winRate = winRates[i];
    const placeRate = Math.min(0.98, winRate * 1.9 + 0.08);
    const odds = player.odds != null ? player.odds : null;
    const expectedValue = odds != null ? Number((winRate * odds).toFixed(3)) : null;
    const confidence = completeness[i];
    let aiScore = (expectedValue != null ? expectedValue : winRate * 2) * (0.5 + 0.5 * confidence);

    // 調子指数(S-2): ONNXモデルの入力次元は固定のため特徴量ベクトルには追加できないが、
    // 推論後のAI推奨度には反映する。指数の目安中央値35を基準に±15%の範囲で補正する。
    const rider = riderMap && window.KeirinDB ? riderMap.get(window.KeirinDB.buildRiderId(player.name)) : null;
    const conditionIndex = rider && rider.conditionIndex != null ? rider.conditionIndex : null;
    if (conditionIndex != null) {
      const conditionBoost = 1 + Math.max(-0.15, Math.min(0.15, (conditionIndex - 35) / 200));
      aiScore *= conditionBoost;
    }

    return {
      ...player,
      winRate: Number(winRate.toFixed(4)),
      placeRate: Number(placeRate.toFixed(4)),
      expectedValue,
      confidence: Number(confidence.toFixed(2)),
      aiScore: Number(aiScore.toFixed(3)),
      conditionIndex,
    };
  });

  resultPlayers.sort((a, b) => b.aiScore - a.aiScore);

  const top = resultPlayers[0];
  const recommended =
    !!top &&
    top.winRate >= RECOMMEND_WIN_RATE_THRESHOLD &&
    (top.expectedValue == null || top.expectedValue >= RECOMMEND_EXPECTED_VALUE_THRESHOLD);

  return {
    ...race,
    players: resultPlayers,
    inferenceEngine: usedOnnx ? 'onnx' : 'rule-based',
    recommended,
    recommendScore: top ? top.aiScore : 0,
    predictedAt: new Date().toISOString(),
  };
}

async function predictRaces(races, riderMap) {
  const results = [];
  for (const race of races) {
    results.push(await predictRace(race, riderMap));
  }
  return results;
}

if (typeof window !== 'undefined') {
  window.KeirinModel = { predictRace, predictRaces };
}
