/**
 * generateArticle.js
 * note投稿用の予想記事(詳細版)を翌日のレース推論結果から自動生成する。
 */

const OVERVIEW_OPENERS = [
  'ラインの並びとAIスコアを重ね合わせると、展開の主導権は',
  '得点・脚質・オッズの3要素を総合すると、今回の主役は',
  'バンク特性とライン構成を踏まえたAIの読みでは、鍵を握るのは',
];

const CLOSERS = [
  'とはいえ競輪は展開一つで着順が入れ替わる競技。あくまでAI予想は判断材料の一つとして活用してほしい。',
  '最終的な判断は当日のオッズ動向や気配も合わせて総合的に。',
  'AIスコアはあくまで参考値。無理のない範囲で楽しんでいただきたい。',
];

function styleDescription(style) {
  switch (style) {
    case '逃げ':
      return '先行して主導権を握るタイプ';
    case 'まくり':
      return '後方から一気に差し込む破壊力が武器';
    case '差し':
      return '直線での切れ味に定評あり';
    case '両方':
      return '逃げ・差しどちらもこなせる万能型';
    default:
      return '脚質データは限定的';
  }
}

function formatPercent(v) {
  return v == null ? '―' : `${(v * 100).toFixed(1)}%`;
}

function formatOdds(v) {
  return v == null ? '―' : `${v.toFixed(1)}倍`;
}

function pick(arr, seed) {
  return arr[seed % arr.length];
}

function lineDescription(race) {
  if (!race.lines || race.lines.length === 0) return 'ライン情報は取得できませんでした。';
  return race.lines
    .filter((l) => l.length > 0)
    .map((l) => l.join('-'))
    .join(' / ');
}

function rankedPlayers(race) {
  return [...race.players].sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0));
}

/** レース1件分のnote記事(詳細版)を生成する */
function generateRaceArticle(race, seed = 0) {
  const ranked = rankedPlayers(race);
  const honmei = ranked[0];
  const taikou = ranked[1];
  const ana = ranked.find((p, i) => i >= 2 && p.expectedValue != null && p.expectedValue >= 1.0) || ranked[2];

  const dateStr = race.date || '';
  const title = `【${dateStr}】${race.venue}競輪 第${race.raceNumber || '?'}R AI予想`;

  const lines = [];
  lines.push(`■ ${title}`);
  lines.push('');
  lines.push('◎本命：' + (honmei ? `${honmei.number}番 ${honmei.name}（勝率${formatPercent(honmei.winRate)} / 期待値${honmei.expectedValue ?? '―'}）` : '該当なし'));
  lines.push('〇対抗：' + (taikou ? `${taikou.number}番 ${taikou.name}（勝率${formatPercent(taikou.winRate)} / 期待値${taikou.expectedValue ?? '―'}）` : '該当なし'));
  lines.push('△穴　：' + (ana ? `${ana.number}番 ${ana.name}（勝率${formatPercent(ana.winRate)} / 期待値${ana.expectedValue ?? '―'}）` : '該当なし'));
  lines.push('');
  lines.push('【AI総評】');
  const opener = pick(OVERVIEW_OPENERS, seed);
  lines.push(
    `${opener}${honmei ? `${honmei.number}番${honmei.name}` : '不明'}。${honmei ? styleDescription(honmei.style) : ''}で、` +
      `ライン構成は「${lineDescription(race)}」。${race.bankNote ? `バンク特性は${race.bankNote}。` : ''}` +
      `${taikou ? `対抗の${taikou.number}番${taikou.name}は${styleDescription(taikou.style)}で、展開次第では逆転の目もある。` : ''}`
  );
  lines.push('');
  lines.push('【期待値について】');
  lines.push(
    '期待値は「AIが算出した勝率 × オッズ」で計算しており、1.0を超えるほど賭け金に対してリターンが見込みやすい買い目と判断できる。' +
      `本レースの本命は期待値${honmei && honmei.expectedValue != null ? honmei.expectedValue : '算出不可（オッズ未取得）'}。`
  );
  lines.push('');
  lines.push('【推奨買い目】');
  if (honmei && taikou) {
    lines.push(`・2車複 ${honmei.number}-${taikou.number}`);
    lines.push(`・ワイド ${honmei.number}-${taikou.number}`);
    if (ana && ana.number !== honmei.number && ana.number !== taikou.number) {
      lines.push(`・3連複 ${honmei.number}-${taikou.number}-${ana.number}`);
    }
  } else {
    lines.push('データ不足のため買い目の自動生成を見送りました。');
  }
  lines.push('');
  const recommendLabel = race.recommended ? '★★★（おすすめレース）' : honmei && honmei.expectedValue >= 0.8 ? '★★☆' : '★☆☆';
  lines.push(`【AIおすすめ度】${recommendLabel}`);
  lines.push('');
  lines.push(pick(CLOSERS, seed + 1));

  return lines.join('\n');
}

/** 翌日の全レースをまとめた記事を生成する */
function generateSummaryArticle(races, seed = 0) {
  const date = races[0] ? races[0].date : '';

  const lines = [];
  lines.push(`■ ${date} 競輪AI予想まとめ`);
  lines.push('');
  lines.push(
    `${date}は全${races.length}レースをAI分析。期待値1.0を超える「おすすめレース」は` +
      `${races.filter((r) => r.recommended).length}レースだった。`
  );
  lines.push('');

  races
    .slice()
    .sort((a, b) => (a.raceNumber || 0) - (b.raceNumber || 0))
    .forEach((race) => {
      const ranked = rankedPlayers(race);
      const honmei = ranked[0];
      const mark = race.recommended ? '🔥おすすめ' : '';
      lines.push(
        `第${race.raceNumber || '?'}R（${race.venue}）${mark}　本命：${honmei ? `${honmei.number} ${honmei.name}` : '―'}` +
          `（勝率${formatPercent(honmei && honmei.winRate)} / 期待値${honmei && honmei.expectedValue != null ? honmei.expectedValue : '―'}）`
      );
    });
  lines.push('');

  lines.push(pick(CLOSERS, seed));
  return lines.join('\n');
}

if (typeof window !== 'undefined') {
  window.KeirinArticle = { generateRaceArticle, generateSummaryArticle };
}
