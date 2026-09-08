/**
 * app.js
 * 画面遷移・イベントハンドリングを行うメインスクリプト(当日運用専用)。
 *
 * データ取得は「開催日一覧ページ」のURLを1つ入力するだけでよい構成になっている。
 *  1. 一覧ページを1回だけ fetch
 *  2. そこから当日の各レースURLを自動抽出
 *  3. 各レースURLを1つずつ fetch(連続アクセス防止のため間隔を空ける)
 * 対象サイトがCORSを許可していない場合はブラウザ側でブロックされ得るため、
 * その場合に備えてHTMLファイルを直接アップロードするフォールバックも用意している。
 */

(function () {
  const state = {
    races: [],
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function switchTab(tabName) {
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${tabName}`));
    if (tabName === 'races') renderRacesView();
    if (tabName === 'results') renderResultsView();
    if (tabName === 'article') renderArticleView();
  }

  function setStatus(msg, isError = false) {
    const el = $('#upload-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', isError);
  }

  async function loadAllRaces() {
    state.races = await window.KeirinDB.getAllRaces();
    state.races.sort((a, b) => (a.raceNumber || 0) - (b.raceNumber || 0));
  }

  function renderRacesView() {
    const races = state.races.slice().sort((a, b) => (a.raceNumber || 0) - (b.raceNumber || 0));
    $('#race-list').innerHTML = window.KeirinCards.renderRaceList(races);
    $('#races-date-label').textContent = races[0] ? `本日 (${races[0].date})` : '';
    $$('#race-list .race-card').forEach((card) => {
      card.addEventListener('click', () => showRaceDetail(card.dataset.raceKey));
    });
    $('#summary-stats').innerHTML = renderSummaryStats(races);
  }

  function renderSummaryStats(races) {
    if (races.length === 0) return '';
    const recommended = races.filter((r) => r.recommended).length;
    return `<div class="stat-pill">全${races.length}R</div><div class="stat-pill neon">おすすめ ${recommended}R</div>`;
  }

  async function showRaceDetail(raceKey) {
    const race = await window.KeirinDB.getRace(raceKey);
    if (!race) return;
    $('#race-detail-content').innerHTML = window.KeirinCards.renderRaceDetail(race);
    switchTab('race-detail');
    $$('.tab-btn').forEach((b) => b.classList.remove('active'));
  }

  /** 開催日一覧ページのURLから当日の全レースを取得・推論・保存する(メインの取得経路) */
  async function handleFetchFromIndexUrl() {
    const input = $('#index-url-input');
    const indexUrl = input.value.trim();
    if (!indexUrl) {
      setStatus('開催日一覧ページのURLを入力してください。', true);
      return;
    }

    const btn = $('#fetch-races-btn');
    btn.disabled = true;
    try {
      setStatus('開催日一覧ページを取得中...');
      const indexRes = await fetch(indexUrl);
      if (!indexRes.ok) throw new Error(`一覧ページの取得に失敗しました（status ${indexRes.status}）`);
      const indexHtml = await indexRes.text();

      const raceUrls = window.KeirinParser.extractRaceUrlsFromIndexPage(indexHtml, indexUrl);
      if (raceUrls.length === 0) {
        setStatus('一覧ページからレースURLを検出できませんでした。サイト構造をご確認いただくか、下のHTML手動アップロードをお試しください。', true);
        return;
      }

      const parsed = [];
      for (let i = 0; i < raceUrls.length; i++) {
        setStatus(`レース情報を取得中... (${i + 1}/${raceUrls.length})`);
        if (i > 0) await sleep(900 + Math.random() * 600); // 連続アクセス防止のための間隔
        try {
          const res = await fetch(raceUrls[i]);
          if (!res.ok) continue;
          const html = await res.text();
          const race = window.KeirinParser.parseRaceCardHtml(html);
          if (race.players && race.players.length > 0) parsed.push(race);
        } catch (err) {
          console.warn('レースページの取得に失敗しました:', raceUrls[i], err);
        }
      }

      if (parsed.length === 0) {
        setStatus('レース情報を取得できませんでした。下のHTML手動アップロードをお試しください。', true);
        return;
      }

      await finalizePredictionAndSave(parsed);
    } catch (err) {
      console.error(err);
      setStatus(
        '取得に失敗しました。対象サイトがブラウザからの直接アクセスを許可していない可能性があります。下のHTML手動アップロードをお試しください。',
        true
      );
    } finally {
      btn.disabled = false;
    }
  }

  /** フォールバック: 出走表HTMLを手動アップロードして当日分として取り込む */
  async function handleRaceCardUpload(files) {
    if (!files || files.length === 0) return;
    setStatus(`解析中... (0/${files.length})`);
    const parsed = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const text = await file.text();
        const race = window.KeirinParser.parseRaceCardHtml(text);
        if (!race.players || race.players.length === 0) {
          setStatus(`「${file.name}」から選手情報を検出できませんでした。HTML構造をご確認ください。`, true);
          continue;
        }
        parsed.push(race);
        setStatus(`解析中... (${i + 1}/${files.length})`);
      } catch (err) {
        console.error(err);
        setStatus(`「${file.name}」の解析でエラーが発生しました。`, true);
      }
    }
    if (parsed.length === 0) return;
    await finalizePredictionAndSave(parsed);
  }

  async function finalizePredictionAndSave(parsedRaces) {
    setStatus('AI推論を実行中...');
    const predicted = await window.KeirinModel.predictRaces(parsedRaces);
    await window.KeirinDB.clearRaces(); // 当日分のみ保持するため、取得の都度入れ替える
    await window.KeirinDB.saveRaces(predicted);
    await loadAllRaces();
    setStatus(`本日${predicted.length}レース分を予想しました。`);
    switchTab('races');
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'races'));
  }

  async function handleResultUpload(files) {
    if (!files || files.length === 0) return;
    const results = [];
    for (const file of files) {
      try {
        const text = await file.text();
        const result = window.KeirinParser.parseResultHtml(text);
        if (result.order && result.order.length > 0) results.push(result);
      } catch (err) {
        console.error(err);
      }
    }
    if (results.length === 0) {
      setResultStatus('着順情報を検出できませんでした。', true);
      return;
    }

    const today = state.races[0] ? state.races[0].date : results[0].date;
    const log = window.KeirinBetting.computeDailyRecovery(today, state.races, results);
    await window.KeirinDB.saveDailyLog(log);
    setResultStatus(`${results.length}レース分の結果を反映しました。`);
    renderResultsView();
  }

  function setResultStatus(msg, isError = false) {
    const el = $('#result-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', isError);
  }

  async function renderResultsView() {
    const logs = await window.KeirinDB.getAllDailyLogs();
    const container = $('#log-list');
    if (logs.length === 0) {
      container.innerHTML = '<p class="empty-msg">まだ回収率ログがありません。本日のおすすめレースの結果HTMLをアップロードしてください。</p>';
    } else {
      container.innerHTML = logs
        .slice()
        .reverse()
        .map(
          (log) => `
        <div class="log-card">
          <div class="log-date">${log.date}</div>
          <div class="log-stats">
            <div><label>投資額</label><span>${log.invested}円</span></div>
            <div><label>回収額</label><span>${log.returned}円</span></div>
            <div class="rate ${log.recoveryRate >= 100 ? 'positive' : 'negative'}"><label>回収率</label><span>${log.recoveryRate ?? '-'}%</span></div>
          </div>
          <div class="log-detail">的中 ${log.hitBets}/${log.judgedBets}（判定済み） ・ 全${log.totalBets}買い目</div>
        </div>`
        )
        .join('');
    }
    const canvas = $('#recovery-chart');
    if (canvas) window.KeirinChart.drawRecoveryChart(canvas, logs);
  }

  function renderArticleView() {
    const select = $('#article-race-select');
    select.innerHTML =
      '<option value="__summary__">本日のまとめ記事</option>' +
      state.races.map((r) => `<option value="${r.raceKey}">${r.venue} 第${r.raceNumber ?? '?'}R</option>`).join('');
  }

  async function handleGenerateArticle() {
    const select = $('#article-race-select');
    const val = select.value;
    const textarea = $('#article-output');
    if (val === '__summary__') {
      textarea.value = window.KeirinArticle.generateSummaryArticle(state.races, Date.now());
    } else {
      const race = await window.KeirinDB.getRace(val);
      if (!race) return;
      textarea.value = window.KeirinArticle.generateRaceArticle(race, Date.now());
    }
  }

  async function handleCopyArticle() {
    const textarea = $('#article-output');
    if (!textarea.value) return;
    try {
      await navigator.clipboard.writeText(textarea.value);
      const btn = $('#copy-article-btn');
      const original = btn.textContent;
      btn.textContent = 'コピーしました！';
      setTimeout(() => (btn.textContent = original), 1500);
    } catch (err) {
      textarea.select();
      document.execCommand('copy');
    }
  }

  function bindEvents() {
    $$('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    $('#back-to-races').addEventListener('click', () => {
      switchTab('races');
      $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'races'));
    });
    $('#fetch-races-btn').addEventListener('click', handleFetchFromIndexUrl);
    $('#race-card-input').addEventListener('change', (e) => handleRaceCardUpload(e.target.files));
    $('#result-input').addEventListener('change', (e) => handleResultUpload(e.target.files));
    $('#generate-article-btn').addEventListener('click', handleGenerateArticle);
    $('#copy-article-btn').addEventListener('click', handleCopyArticle);
  }

  async function init() {
    bindEvents();
    await loadAllRaces();
    renderRacesView();

    if ('serviceWorker' in navigator) {
      try {
        await navigator.serviceWorker.register('service-worker.js');
      } catch (err) {
        console.warn('Service Worker登録に失敗しました。', err);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
