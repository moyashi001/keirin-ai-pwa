/**
 * components/raceCard.js
 * レース一覧・レース詳細のDOM生成を担当するレンダリング部品。
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

function renderRaceCard(race) {
  const top = [...race.players].sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0))[0];
  const recommendedClass = race.recommended ? 'race-card recommended' : 'race-card';
  return `
    <button class="${recommendedClass}" data-race-key="${escapeHtml(race.raceKey)}">
      ${race.recommended ? '<div class="ribbon">AIおすすめ</div>' : ''}
      <div class="race-card-header">
        <span class="venue">${escapeHtml(race.venue)}</span>
        <span class="race-number">第${race.raceNumber ?? '?'}R</span>
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

function renderRaceDetail(race) {
  const ranked = [...race.players].sort((a, b) => (b.aiScore || 0) - (a.aiScore || 0));
  const lineText = (race.lines || []).map((l) => l.join('-')).join(' / ') || '不明';
  return `
    <div class="detail-header">
      <h2>${escapeHtml(race.venue)} 第${race.raceNumber ?? '?'}R</h2>
      <p class="detail-sub">${escapeHtml(race.date)}　推論エンジン: ${race.inferenceEngine === 'onnx' ? 'ONNXモデル' : 'ルールベースAI'}</p>
      ${race.recommended ? '<div class="neon-tag">🔥 AIおすすめレース</div>' : ''}
      <p class="detail-line">ライン構成: ${escapeHtml(lineText)}</p>
      ${race.bankNote ? `<p class="detail-line">バンク特性: ${escapeHtml(race.bankNote)}</p>` : ''}
    </div>
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
  `;
}

if (typeof window !== 'undefined') {
  window.KeirinCards = { renderRaceCard, renderRaceList, renderRaceDetail, escapeHtml };
}
