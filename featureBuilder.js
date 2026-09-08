/**
 * featureBuilder.js
 * 当日の出走表データ(htmlParser.jsの出力)から、training/以下のPythonパイプラインで
 * 学習したLightGBMモデルと同じ並び・意味の特徴量ベクトルを組み立てる。
 *
 * 学習側(training/build_features.py)の特徴量定義:
 *   [race_score, style_nige, style_oikomi, style_ryo,
 *    recent_avg_rank, recent_nige_rate, recent_makuri_rate, recent_sashi_rate,
 *    rank_position]
 *
 * ■ 出走表HTMLだけでは再現できない特徴量について(重要)
 *   学習データには存在するが、競輪公式サイトの出走表からは取得できない情報が2つある。
 *   その場合は学習データ全体の平均値で代用する(FEATURE_DEFAULTS)。
 *     - recent_nige_rate / recent_makuri_rate / recent_sashi_rate:
 *       直近5走の「決まり手」は出走表に載らないため算出不可。
 *     - rank_position:
 *       学習データでは記者の予想印(◎○注×△▲)の順位を「レース内の有力度順位」として
 *       使ったが、出走表に予想印は無い。そのため意味の近い代理指標として、
 *       「オッズが低い順につけた順位」を同じスケール(1〜7、7以上は7に丸め)で用いる。
 *
 * FEATURE_DEFAULTS の値は training/train_model.py 実行時の実データ統計から算出し、
 * ここに埋め込んでいる(学習データを再取得した場合は build_features.py の出力の
 * describe() を見て更新すること)。
 */

const FEATURE_COLUMNS = [
  'race_score',
  'style_nige',
  'style_oikomi',
  'style_ryo',
  'recent_avg_rank',
  'recent_nige_rate',
  'recent_makuri_rate',
  'recent_sashi_rate',
  'rank_position',
];

// training/features.csv の全体平均値(学習データ統計)。出走表から取得できない特徴量の穴埋めに使う。
const FEATURE_DEFAULTS = {
  race_score: 84.6,
  recent_avg_rank: 4.03,
  recent_nige_rate: 0.061,
  recent_makuri_rate: 0.06,
  recent_sashi_rate: 0.097,
};

const MAX_RANK_POSITION = 7;

/** 出走表の脚質ラベル("逃げ"/"差し"/"まくり"/"両方")を学習データのカテゴリにマッピング */
function styleOneHot(style) {
  // 学習データの running_style は「逃/追/両」の3カテゴリのみ。
  // 出走表側の「差し」「まくり」はどちらも決まり手的に追込グループへ寄せる。
  return {
    style_nige: style === '逃げ' ? 1 : 0,
    style_oikomi: style === '差し' || style === 'まくり' ? 1 : 0,
    style_ryo: style === '両方' ? 1 : 0,
  };
}

/** "1-2-1-3" のような直近成績文字列から平均着順(生値)を計算する */
function recentAvgRank(recentResults) {
  if (!recentResults) return null;
  const ranks = recentResults
    .split('-')
    .map(Number)
    .filter((n) => !isNaN(n));
  if (ranks.length === 0) return null;
  return ranks.reduce((a, b) => a + b, 0) / ranks.length;
}

/** レース内でオッズが低い順に1,2,3...と順位付けする(記者予想印順位の代理) */
function computeOddsRankMap(players) {
  const withOdds = players
    .filter((p) => p.odds != null)
    .slice()
    .sort((a, b) => a.odds - b.odds);
  const map = new Map();
  withOdds.forEach((p, i) => map.set(p.number, Math.min(i + 1, MAX_RANK_POSITION)));
  return map;
}

/**
 * レース1件分の選手配列から、学習済みモデルへ入力する特徴量行列を作る。
 * @param {object} race parseRaceCardHtml() の出力(players配列を含む)
 * @returns {{ vectors: number[][], players: object[] }} FEATURE_COLUMNS順に並んだ特徴量ベクトルの配列
 */
function buildFeatureMatrix(race) {
  const oddsRankMap = computeOddsRankMap(race.players);

  const vectors = race.players.map((p) => {
    const { style_nige, style_oikomi, style_ryo } = styleOneHot(p.style);
    const raceScore = p.score != null ? p.score : FEATURE_DEFAULTS.race_score;
    const avgRank = recentAvgRank(p.recentResults);
    const rankPosition = oddsRankMap.has(p.number) ? oddsRankMap.get(p.number) : MAX_RANK_POSITION;

    return [
      raceScore,
      style_nige,
      style_oikomi,
      style_ryo,
      avgRank != null ? avgRank : FEATURE_DEFAULTS.recent_avg_rank,
      FEATURE_DEFAULTS.recent_nige_rate,
      FEATURE_DEFAULTS.recent_makuri_rate,
      FEATURE_DEFAULTS.recent_sashi_rate,
      rankPosition,
    ];
  });

  return { vectors, players: race.players };
}

if (typeof window !== 'undefined') {
  window.KeirinFeatureBuilder = { buildFeatureMatrix, FEATURE_COLUMNS, FEATURE_DEFAULTS };
}
