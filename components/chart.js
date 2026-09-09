/**
 * components/chart.js
 * 外部ライブラリなしでCanvasに簡易折れ線グラフ(日次回収率の推移)を描画する。
 */

function drawRecoveryChart(canvas, logs, selectedDate = null) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 320;
  const cssHeight = canvas.clientHeight || 160;
  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padding = { top: 16, right: 12, bottom: 24, left: 36 };
  const w = cssWidth - padding.left - padding.right;
  const h = cssHeight - padding.top - padding.bottom;

  if (!logs || logs.length === 0) {
    ctx.fillStyle = '#7dffff';
    ctx.font = '13px sans-serif';
    ctx.fillText('まだログがありません', padding.left, cssHeight / 2);
    return;
  }

  const rates = logs.map((l) => l.recoveryRate || 0);
  const maxRate = Math.max(100, ...rates) * 1.1;

  // 基準線(100%)
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.setLineDash([4, 4]);
  const y100 = padding.top + h - (100 / maxRate) * h;
  ctx.beginPath();
  ctx.moveTo(padding.left, y100);
  ctx.lineTo(padding.left + w, y100);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '10px sans-serif';
  ctx.fillText('100%', 2, y100 + 3);

  // 折れ線(ネオンシアン) + グロー
  ctx.shadowColor = '#00fff2';
  ctx.shadowBlur = 8;
  ctx.strokeStyle = '#00fff2';
  ctx.lineWidth = 2;
  ctx.beginPath();
  logs.forEach((log, i) => {
    const x = padding.left + (logs.length === 1 ? w / 2 : (w * i) / (logs.length - 1));
    const y = padding.top + h - ((log.recoveryRate || 0) / maxRate) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 点(選択中の日付は大きめのシアン丸で強調表示する)
  logs.forEach((log, i) => {
    const x = padding.left + (logs.length === 1 ? w / 2 : (w * i) / (logs.length - 1));
    const y = padding.top + h - ((log.recoveryRate || 0) / maxRate) * h;
    const isSelected = selectedDate && log.date === selectedDate;
    ctx.beginPath();
    ctx.fillStyle = isSelected ? '#00fff2' : '#ff00e6';
    ctx.arc(x, y, isSelected ? 6 : 3, 0, Math.PI * 2);
    ctx.fill();
    if (isSelected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  });

  // x軸ラベル(最初・最後のみ)
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.font = '10px sans-serif';
  ctx.fillText(logs[0].date.slice(5), padding.left, cssHeight - 6);
  if (logs.length > 1) {
    const lastLabel = logs[logs.length - 1].date.slice(5);
    ctx.fillText(lastLabel, padding.left + w - 28, cssHeight - 6);
  }
}

if (typeof window !== 'undefined') {
  window.KeirinChart = { drawRecoveryChart };
}
