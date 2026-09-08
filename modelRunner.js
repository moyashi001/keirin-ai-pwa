/**
 * modelRunner.js
 * ONNX Runtime Web を使ったブラウザ内AI推論。
 *
 * assets/model.onnx が配置されていればそれをロードして推論に使う。
 * 配置されていない場合(標準状態)は、内蔵のルールベース推論エンジンに
 * 自動フォールバックする。特徴量ベクトルの並びを揃えてあるため、
 * 将来ユーザーが学習済みモデルを assets/model.onnx として置き換えるだけで
 * そのまま本物のONNX推論に切り替わる設計になっている。
 */

const FEATURE_NAMES = ['scoreNorm', 'styleNige', 'styleMakuri', 'styleSashi', 'lineAdvantage', 'recentFormNorm', 'oddsPopularity'];

let ortSession = null;
let ortLoadAttempted = false;

function styleOneHot(style) {
  return {
    styleNige: style === '逃げ' ? 1 : 0,
    styleMakuri: style === 'まくり' ? 1 : 0,
    styleSashi: style === '差し' ? 1 : 0,
  };
}

/** 直近成績文字列("1-2-3-1"など)を0〜1の好調度スコアへ変換 */
function recentFormScore(recentResults) {
  if (!recentResults) return 0.5;
  const ranks = recentResults.split('-').map(Number).filter((n) => !isNaN(n));
  if (ranks.length === 0) return 0.5;
  const avg = ranks.reduce((a, b) => a + b, 0) / ranks.length;
  // 1着平均→1.0、6着平均→0.0 目安の線形マップ
  return Math.max(0, Math.min(1, (6 - avg) / 5));
}

/** ライン内でのポジション優位度(先頭・番手は有利、単騎はやや不利) */
function lineAdvantageScore(player, lines) {
  const line = (lines || []).find((l) => l.includes(player.number));
  if (!line || line.length <= 1) return 0.4; // 単騎
  const pos = line.indexOf(player.number);
  if (pos === 0) return 0.9; // 先頭
  if (pos === 1) return 0.75; // 番手
  return 0.55; // 三番手以降
}

/** オッズの人気度を0〜1へ(オッズが低いほど人気=高スコア) */
function oddsPopularityScore(odds) {
  if (odds == null || odds <= 0) return 0.3;
  // オッズ1.5倍→約0.9、オッズ20倍→約0.1 の目安カーブ
  return Math.max(0.02, Math.min(0.95, 1 / (1 + odds / 4)));
}

function buildFeatures(race) {
  const scores = race.players.map((p) => p.score).filter((s) => s != null);
  const minScore = scores.length ? Math.min(...scores) : 60;
  const maxScore = scores.length ? Math.max(...scores) : 120;
  const range = Math.max(1, maxScore - minScore);

  return race.players.map((p) => {
    const scoreNorm = p.score != null ? (p.score - minScore) / range : 0.5;
    const { styleNige, styleMakuri, styleSashi } = styleOneHot(p.style);
    const lineAdvantage = lineAdvantageScore(p, race.lines);
    const recentFormNorm = recentFormScore(p.recentResults);
    const oddsPopularity = oddsPopularityScore(p.odds);
    return {
      player: p,
      vector: [scoreNorm, styleNige, styleMakuri, styleSashi, lineAdvantage, recentFormNorm, oddsPopularity],
    };
  });
}

/** ルールベース推論エンジン(デフォルト)。重みは経験則に基づく簡易モデル。 */
const RULE_WEIGHTS = {
  scoreNorm: 2.2,
  styleNige: 0.3,
  styleMakuri: 0.5,
  styleSashi: 0.35,
  lineAdvantage: 1.4,
  recentFormNorm: 1.1,
  oddsPopularity: 0.9,
};

function ruleBasedLogits(vector) {
  const [scoreNorm, styleNige, styleMakuri, styleSashi, lineAdvantage, recentFormNorm, oddsPopularity] = vector;
  return (
    scoreNorm * RULE_WEIGHTS.scoreNorm +
    styleNige * RULE_WEIGHTS.styleNige +
    styleMakuri * RULE_WEIGHTS.styleMakuri +
    styleSashi * RULE_WEIGHTS.styleSashi +
    lineAdvantage * RULE_WEIGHTS.lineAdvantage +
    recentFormNorm * RULE_WEIGHTS.recentFormNorm +
    oddsPopularity * RULE_WEIGHTS.oddsPopularity
  );
}

function softmax(logits) {
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
}

/** assets/model.onnx のロードを一度だけ試みる。無ければ null のまま。 */
async function tryLoadOnnxModel() {
  if (ortLoadAttempted) return ortSession;
  ortLoadAttempted = true;
  if (typeof ort === 'undefined') return null;
  try {
    ort.env.wasm.wasmPaths = 'vendor/ort/';
    const res = await fetch('assets/model.onnx', { method: 'HEAD' });
    if (!res.ok) return null;
    ortSession = await ort.InferenceSession.create('assets/model.onnx', { executionProviders: ['wasm'] });
    console.info('[modelRunner] assets/model.onnx をロードしました。ONNX推論モードで動作します。');
  } catch (err) {
    console.warn('[modelRunner] ONNXモデルのロードに失敗、ルールベース推論にフォールバックします。', err);
    ortSession = null;
  }
  return ortSession;
}

async function runOnnxInference(session, featureRows) {
  const inputName = session.inputNames[0];
  const n = featureRows.length;
  const dim = FEATURE_NAMES.length;
  const flat = new Float32Array(n * dim);
  featureRows.forEach((row, i) => row.vector.forEach((v, j) => (flat[i * dim + j] = v)));
  const tensor = new ort.Tensor('float32', flat, [n, dim]);
  const feeds = { [inputName]: tensor };
  const outputMap = await session.run(feeds);
  const outputName = session.outputNames[0];
  const data = outputMap[outputName].data;
  // モデル出力をレース内でsoftmax正規化して勝率とみなす
  return softmax(Array.from(data).slice(0, n));
}

/**
 * レース1件分の推論を実行し、各選手に winRate / placeRate / expectedValue / aiScore を付与する。
 * @param {object} race parseRaceCardHtml() の出力
 * @returns {Promise<object>} 推論結果を付与したレースオブジェクト
 */
async function predictRace(race) {
  const featureRows = buildFeatures(race);
  const session = await tryLoadOnnxModel();

  let winRates;
  let usedOnnx = false;
  if (session) {
    try {
      winRates = await runOnnxInference(session, featureRows);
      usedOnnx = true;
    } catch (err) {
      console.warn('[modelRunner] ONNX推論に失敗、ルールベースにフォールバックします。', err);
    }
  }
  if (!winRates) {
    const logits = featureRows.map((r) => ruleBasedLogits(r.vector));
    winRates = softmax(logits);
  }

  // データ充実度(得点・オッズ・脚質が揃っているほど信頼度が高い)
  const completeness = featureRows.map(({ player }) => {
    let filled = 0;
    if (player.score != null) filled++;
    if (player.odds != null) filled++;
    if (player.style) filled++;
    if (player.recentResults) filled++;
    return filled / 4;
  });

  const players = featureRows.map(({ player }, i) => {
    const winRate = winRates[i];
    // 連対率は勝率に「上位3割の底上げ」を加えた回帰的な推定値
    const placeRate = Math.min(0.98, winRate * 1.9 + 0.08);
    const odds = player.odds != null ? player.odds : null;
    const expectedValue = odds != null ? Number((winRate * odds).toFixed(3)) : null;
    const confidence = completeness[i];
    const aiScore = Number(((expectedValue != null ? expectedValue : winRate * 2) * (0.5 + 0.5 * confidence)).toFixed(3));
    return {
      ...player,
      winRate: Number(winRate.toFixed(4)),
      placeRate: Number(placeRate.toFixed(4)),
      expectedValue,
      confidence: Number(confidence.toFixed(2)),
      aiScore,
    };
  });

  players.sort((a, b) => b.aiScore - a.aiScore);

  const recommended = players.length > 0 && (players[0].expectedValue == null || players[0].expectedValue >= 1.0);

  return {
    ...race,
    players,
    inferenceEngine: usedOnnx ? 'onnx' : 'rule-based',
    recommended,
    recommendScore: players.length ? players[0].aiScore : 0,
    predictedAt: new Date().toISOString(),
  };
}

async function predictRaces(races) {
  const results = [];
  for (const race of races) {
    results.push(await predictRace(race));
  }
  return results;
}

if (typeof window !== 'undefined') {
  window.KeirinModel = { predictRace, predictRaces, FEATURE_NAMES };
}
