/**
 * components/raceCard.js
 * レース一覧・レース詳細のDOM生成を担当するレンダリング部品。
 * レース詳細は 1.レース名 → 2.発走時間 → 3.出走メンバー → 4.AIおすすめ買い方(券種別) → 5.オッズ の順に表示する。
 */

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function styleBadge(style) {
  if (!style) return '<span class="badge badge-muted">脚質不明</span>';
  const cls = { 逃げ: 'badge-nige', まくり: 'badge-makuri', 差し: 'badge-sashi', 両方: 'badge-ryo' }[style] || 'badge-muted';
  return `<span class="badge ${cls}">${escapeHtml(style)}</span>`;
}

/** レース名(例: 松戸競輪 5R（A級準決勝）)を組み立てる。旧データ(raceName未保存)にもフォールバックする */
function raceTitle(race) {
  const base = race.raceName || `${race.venue}競輪 ${race.raceNumber ?? '?'}R`;
  return race.raceClass ? `${base}（${race.raceClass}）` : base;
}

function renderRaceCard(race) {
  const top = [...race.players].sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0))[0];
  const recommendedClass = race.recommended ? 'race-card recommended' : 'race-card';
  return `
    <button class="${recommendedClass}" data-race-key="${escapeHtml(race.raceKey)}">
      ${race.recommended ? '<div class="ribbon">AIおすすめ</div>' : ''}
      <div class="race-card-header">
        <span class="venue">${escapeHtml(raceTitle(race))}</span>
        ${race.startTime ? `<span class="race-number">${escapeHtml(race.startTime)}発走</span>` : ''}
      </div>
      <div class="race-card-body">
        <div class="top-pick">
          <span class="num">${top ? top.number : '-'}</span>
          <span class="name">${top ? escapeHtml(top.name) : '選手情報なし'}</span>
          ${top ? styleBadge(top.style) : ''}
        </div>
        <div class="race-card-stats">
          <div><label>勝率</label><span>${top ? (top.winRate * 100).toFixed(1) : '-'}%</span></div>
          <div><label>期待値</label><span>${top && top.expectedValue != null ? top.expectedValue : '-'}</span></div>
          <div><label>AI度</label><span>${top ? top.aiScore : '-'}</span></div>
        </div>
      </div>
    </button>
  `;
}

function renderRaceList(races) {
  if (!races || races.length === 0) {
    return '<p class="empty-msg">この日の出走表はまだアップロードされていません。</p>';
  }
  return races.map(renderRaceCard).join('');
}

function renderPlayerRow(p) {
  return `
    <tr>
      <td class="num">${p.number ?? '-'}</td>
      <td class="name">${escapeHtml(p.name)}</td>
      <td>${p.score ?? '-'}</td>
      <td>${styleBadge(p.style)}</td>
      <td>${p.odds ?? '-'}</td>
      <td>${(p.winRate * 100).toFixed(1)}%</td>
      <td>${(p.placeRate * 100).toFixed(1)}%</td>
      <td>${p.expectedValue ?? '-'}</td>
      <td class="ai-score">${p.aiScore}</td>
    </tr>
  `;
}

function comboLabel(numbers) {
  return (numbers || []).join('-');
}

/** 券種別のAIおすすめ買い方をまとめて表示するセクションを組み立てる */
function renderPredictions(predictions) {
  if (!predictions) return '<p class="empty-msg">買い目データがありません。</p>';

  const rows = [];

  if (predictions.win && predictions.win.length) {
    const p = predictions.win[0];
    rows.push({ label: '単勝', value: `${p.number} ${escapeHtml(p.name)}`, sub: `勝率 ${(p.winRate * 100).toFixed(1)}%` });
  }
  if (predictions.place && predictions.place.length) {
    const names = predictions.place.map((p) => `${p.number} ${escapeHtml(p.name)}`).join(' / ');
    rows.push({ label: '複勝', value: names, sub: '' });
  }
  if (predictions.quinella && predictions.quinella.length) {
    const c = predictions.quinella[0];
    rows.push({ label: '二車複', value: comboLabel(c.combo), sub: `スコア ${c.score}` });
  }
  if (predictions.exacta && predictions.exacta.length) {
    const c = predictions.exacta[0];
    rows.push({ label: '二車単', value: comboLabel(c.order), sub: `スコア ${c.score}` });
  }
  if (predictions.wide && predictions.wide.length) {
    const combos = predictions.wide.map((c) => comboLabel(c.combo)).join(' , ');
    rows.push({ label: 'ワイド', value: combos, sub: '' });
  }
  if (predictions.trio && predictions.trio.length) {
    const c = predictions.trio[0];
    rows.push({ label: '三連複', value: comboLabel(c.combo), sub: `スコア ${c.score}` });
  }
  if (predictions.trifecta && predictions.trifecta.length) {
    const c = predictions.trifecta[0];
    rows.push({ label: '三連単', value: comboLabel(c.order), sub: `スコア ${c.score}` });
  }

  if (rows.length === 0) return '<p class="empty-msg">買い目データがありません。</p>';

  return `
    <div class="prediction-grid">
      ${rows
        .map(
          (r) => `
        <div class="prediction-row">
          <span class="prediction-type">${r.label}</span>
          <span class="prediction-value">${r.value}</span>
          ${r.sub ? `<span class="prediction-sub">${r.sub}</span>` : ''}
        </div>`
        )
        .join('')}
    </div>
  `;
}

/** オッズ一覧(車番→オッズ)を表示する */
function renderOddsList(race) {
  const players = [...race.players].sort((a, b) => (a.number || 99) - (b.number || 99));
  if (players.every((p) => p.odds == null)) return '<p class="empty-msg">オッズ情報がありません。</p>';
  return `
    <div class="odds-grid">
      ${players.map((p) => `<div class="odds-chip"><span class="odds-num">${p.number}</span><span>${p.odds ?? '-'}</span></div>`).join('')}
    </div>
  `;
}

function renderRaceDetail(race) {
  const ranked = [...race.players].sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0));
  const lineText = (race.lines || []).map((l) => l.join('-')).join(' / ') || '不明';

  return `
    <div class="detail-header">
      <h2>${escapeHtml(raceTitle(race))}</h2>
      <p class="detail-sub">
        ${escapeHtml(race.date)}${race.startTime ? `　発走 ${escapeHtml(race.startTime)}` : ''}　推論エンジン: ${race.inferenceEngine === 'onnx' ? 'ONNXモデル' : 'ルールベースAI'}
      </p>
      ${race.recommended ? '<div class="neon-tag">🔥 AIおすすめレース</div>' : ''}
      <p class="detail-line">ライン構成: ${escapeHtml(lineText)}</p>
      ${race.bankNote ? `<p class="detail-line">バンク特性: ${escapeHtml(race.bankNote)}</p>` : ''}
    </div>

    <h3 class="section-title">出走メンバー</h3>
    <div class="table-scroll">
      <table class="player-table">
        <thead>
          <tr>
            <th>車番</th><th>選手名</th><th>得点</th><th>脚質</th><th>オッズ</th>
            <th>勝率</th><th>連対率</th><th>期待値</th><th>AI推奨度</th>
          </tr>
        </thead>
        <tbody>${ranked.map(renderPlayerRow).join('')}</tbody>
      </table>
    </div>

    <h3 class="section-title">AIおすすめ買い方</h3>
    ${renderPredictions(race.predictions)}

    <h3 class="section-title">オッズ</h3>
    ${renderOddsList(race)}
  `;
}

if (typeof window !== 'undefined') {
  window.KeirinCards = { renderRaceCard, renderRaceList, renderRaceDetail, renderPredictions, escapeHtml };
}
