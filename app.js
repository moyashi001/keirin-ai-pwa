/**
 * app.js
 * 画面遷移・イベントハンドリングを行うメインスクリプト。
 *
 * データ取得は「開催日一覧ページ」のURLを1つ入力するだけでよい構成になっている。
 *  1. 一覧ページを1回だけ fetch
 *  2. そこから A.当日の結果ページURL と B.翌日の出走表(開催)ページURL を自動抽出
 *  3. A→結果を取得して、前回保存しておいた予想(当日分)と突き合わせ回収率を計算
 *  4. B→そこから翌日の各レースURLを抽出し、1つずつ fetch(連続アクセス防止のため間隔を空ける)
 *     してAI推論・保存する(これが次にレース一覧タブへ表示される「翌日の予想」になる)
 * 対象サイトがCORSを許可していない場合はブラウザ側でブロックされ得るため、
 * その場合に備えて出走表HTMLを直接アップロードするフォールバックも用意している。
 */

(function () {
  const state = {
    races: [], // DB内の全レース(結果待ちの当日分+最新の翌日予想が一時的に混在し得る)
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
  }

  /** 表示対象は常に「最新の予想日(=翌日予想)」のレース群だけに絞る */
  function latestDateRaces() {
    if (state.races.length === 0) return [];
    const maxDate = state.races.reduce((max, r) => (r.date > max ? r.date : max), state.races[0].date);
    return state.races
      .filter((r) => r.date === maxDate)
      .sort((a, b) => (a.raceNumber || 0) - (b.raceNumber || 0));
  }

  function renderRacesView() {
    const races = latestDateRaces();
    $('#race-list').innerHTML = window.KeirinCards.renderRaceList(races);
    $('#races-date-label').textContent = races[0] ? `翌日の予想 (${races[0].date})` : '';
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

  /**
   * 開催日一覧ページのURLから
   *   A. 当日の結果 → 回収率計算
   *   B. 翌日の出走表 → AI推論して次回表示するレースとして保存
   * を1回の操作で行う(メインの取得経路)。
   */
  async function handleFetchFromIndexUrl() {
    const input = $('#index-url-input');
    const indexUrl = input.value.trim();
    if (!indexUrl) {
      setStatus('開催日一覧ページのURLを入力してください。', true);
      return;
    }

    const btn = $('#fetch-races-btn');
    btn.disabled = true;
    let recoverySummary = '';
    try {
      setStatus('開催日一覧ページを取得中...');
      const indexRes = await fetch(indexUrl);
      if (!indexRes.ok) throw new Error(`一覧ページの取得に失敗しました（status ${indexRes.status}）`);
      const indexHtml = await indexRes.text();

      const { resultUrl, nextDayUrl } = window.KeirinParser.extractResultAndNextDayUrls(indexHtml, indexUrl);
      if (!resultUrl && !nextDayUrl) {
        setStatus('一覧ページから結果/出走表のURLを検出できませんでした。下のHTML手動アップロードをお試しください。', true);
        return;
      }

      // --- A. 当日の結果を取得して回収率を計算 ---
      if (resultUrl) {
        setStatus('本日の結果ページを取得中...');
        try {
          const resultRes = await fetch(resultUrl);
          if (resultRes.ok) {
            const resultHtml = await resultRes.text();
            const results = window.KeirinParser.parseResultsFromPage(resultHtml);
            if (results.length > 0) {
              const resultDate = results[0].date;
              const todaysRaces = state.races.filter((r) => r.date === resultDate);
              if (todaysRaces.length > 0) {
                const log = window.KeirinBetting.computeDailyRecovery(resultDate, todaysRaces, results);
                await window.KeirinDB.saveDailyLog(log);
                await window.KeirinDB.clearRacesByDate(resultDate);
                await loadAllRaces();
                recoverySummary = `本日(${resultDate})の回収率 ${log.recoveryRate ?? '-'}%。`;
              } else {
                recoverySummary = '本日の結果を取得しましたが、対応する予想データが見つかりませんでした。';
              }
            }
          } else {
            console.warn('結果ページの取得に失敗しました:', resultRes.status);
          }
        } catch (err) {
          console.warn('結果ページの取得に失敗しました:', err);
        }
      }

      // --- B. 翌日の出走表を取得してAI推論 ---
      if (!nextDayUrl) {
        setStatus(`${recoverySummary} 翌日の出走表URLを検出できませんでした。`.trim(), true);
        return;
      }

      if (resultUrl) await sleep(900 + Math.random() * 600); // 連続アクセス防止のための間隔

      setStatus(`${recoverySummary} 翌日の開催ページを取得中...`.trim());
      const nextRes = await fetch(nextDayUrl);
      if (!nextRes.ok) throw new Error(`翌日の出走表ページの取得に失敗しました（status ${nextRes.status}）`);
      const nextHtml = await nextRes.text();

      const raceUrls = window.KeirinParser.extractRaceUrlsFromIndexPage(nextHtml, nextDayUrl);
      const parsed = [];

      if (raceUrls.length > 0) {
        for (let i = 0; i < raceUrls.length; i++) {
          setStatus(`${recoverySummary} 翌日のレース情報を取得中... (${i + 1}/${raceUrls.length})`.trim());
          if (i > 0) await sleep(900 + Math.random() * 600);
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
      } else {
        // nextDayUrl自体が単一レース分の出走表だったケースへのフォールバック
        const race = window.KeirinParser.parseRaceCardHtml(nextHtml);
        if (race.players && race.players.length > 0) parsed.push(race);
      }

      if (parsed.length === 0) {
        setStatus(`${recoverySummary} 翌日のレース情報を取得できませんでした。下のHTML手動アップロードをお試しください。`.trim(), true);
        return;
      }

      await finalizePredictionAndSave(parsed, recoverySummary);
    } catch (err) {
      console.error(err);
      setStatus(
        `${recoverySummary} 取得に失敗しました。対象サイトがブラウザからの直接アクセスを許可していない可能性があります。下のHTML手動アップロードをお試しください。`.trim(),
        true
      );
    } finally {
      btn.disabled = false;
    }
  }

  /** フォールバック: 翌日の出走表HTMLを手動アップロードして取り込む */
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

  async function finalizePredictionAndSave(parsedRaces, prefix = '') {
    setStatus(`${prefix} AI推論を実行中...`.trim());
    const predicted = await window.KeirinModel.predictRaces(parsedRaces);
    await window.KeirinDB.saveRaces(predicted);
    await loadAllRaces();
    setStatus(`${prefix} 翌日${predicted.length}レース分を予想しました。`.trim());
    switchTab('races');
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'races'));
  }

  async function renderResultsView() {
    const logs = await window.KeirinDB.getAllDailyLogs();
    const container = $('#log-list');
    if (logs.length === 0) {
      container.innerHTML = '<p class="empty-msg">まだ回収率ログがありません。「本日のレースを取得」を実行すると、開催日一覧ページから本日分の結果も自動集計されます。</p>';
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
    const races = latestDateRaces();
    const select = $('#article-race-select');
    select.innerHTML =
      '<option value="__summary__">翌日のまとめ記事</option>' +
      races.map((r) => `<option value="${r.raceKey}">${r.venue} 第${r.raceNumber ?? '?'}R</option>`).join('');
  }

  async function handleGenerateArticle() {
    const select = $('#article-race-select');
    const val = select.value;
    const textarea = $('#article-output');
    if (val === '__summary__') {
      textarea.value = window.KeirinArticle.generateSummaryArticle(latestDateRaces(), Date.now());
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
