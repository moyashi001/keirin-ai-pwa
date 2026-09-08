/**
 * app.js
 * 画面遷移・イベントハンドリングを行うメインスクリプト。
 *
 * データ取得はURLフェッチではなく、ユーザーがiPhone Safari上のブックマークレットで
 * ページのHTMLをコピーし、テキストエリアに貼り付けて「解析する」ボタンを押す方式。
 * 貼り付けられたHTMLが「出走表」か「結果」かは htmlParser.detectPageType が自動判定し、
 *  - 出走表と判定: AI推論して次回表示するレースとして保存(翌日の予想)
 *  - 結果と判定  : 前回保存済みの予想と突き合わせて回収率を計算
 * にそれぞれ振り分ける。1回の貼り付けで複数レース分のテーブルが含まれていても、
 * 含まれていなくてもどちらでも解析できるようパーサー側で対応している。
 */

(function () {
  const state = {
    races: [], // DB内の全レース(結果待ちの当日分+最新の翌日予想が一時的に混在し得る)
  };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

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

  /** レースオブジェクトを保存用の形に整える(members/odds/predictionsのエイリアスを付与) */
  function finalizeRaceForStorage(race) {
    const oddsMap = {};
    race.players.forEach((p) => {
      if (p.odds != null) oddsMap[p.number] = p.odds;
    });
    return {
      ...race,
      raceId: race.raceKey,
      members: race.players,
      odds: oddsMap,
      predictions: window.KeirinBetting.buildPredictions(race.players),
    };
  }

  /** 貼り付けられたHTMLを解析し、出走表/結果を自動判定して処理する */
  async function handleParseHtml() {
    const textarea = $('#html-input');
    const html = textarea.value.trim();
    if (!html) {
      setStatus('HTMLを貼り付けてください。', true);
      return;
    }

    try {
      setStatus('HTMLの種別を判定中...');
      const pageType = window.KeirinParser.detectPageType(html);

      if (pageType === 'racecard') {
        await handleRaceCard(html);
      } else if (pageType === 'result') {
        await handleResult(html);
      } else {
        setStatus('出走表・結果のどちらとしても認識できませんでした。貼り付けたHTMLの内容をご確認ください。', true);
        return;
      }
      textarea.value = '';
    } catch (err) {
      console.error(err);
      setStatus('解析中にエラーが発生しました。貼り付けたHTMLの内容をご確認ください。', true);
    }
  }

  /** 出走表として解析: AI推論して次回表示するレースとして保存する */
  async function handleRaceCard(html) {
    const races = window.KeirinParser.parseRaceCardsFromPage(html);
    if (races.length === 0) {
      setStatus('選手情報を検出できませんでした。貼り付けたHTMLの内容をご確認ください。', true);
      return;
    }
    setStatus(`出走表と判定。${races.length}レース分を検出、AI推論を実行中...`);
    const predicted = await window.KeirinModel.predictRaces(races);
    const finalized = predicted.map(finalizeRaceForStorage);
    await window.KeirinDB.saveRaces(finalized);
    await loadAllRaces();
    setStatus(`翌日${finalized.length}レース分を予想しました。`);
    switchTab('races');
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'races'));
  }

  /** 結果として解析: 前回保存済みの予想と突き合わせて回収率を計算する */
  async function handleResult(html) {
    const results = window.KeirinParser.parseResultsFromPage(html);
    if (results.length === 0) {
      setStatus('着順情報を検出できませんでした。貼り付けたHTMLの内容をご確認ください。', true);
      return;
    }
    const resultDate = results[0].date;
    const todaysRaces = state.races.filter((r) => r.date === resultDate);
    if (todaysRaces.length === 0) {
      setStatus(`結果と判定されましたが、${resultDate}分の予想データが見つかりませんでした。`, true);
      return;
    }
    const log = window.KeirinBetting.computeDailyRecovery(resultDate, todaysRaces, results);
    await window.KeirinDB.saveDailyLog(log);
    await window.KeirinDB.clearRacesByDate(resultDate);
    await loadAllRaces();
    setStatus(`結果と判定。${resultDate}の回収率 ${log.recoveryRate ?? '-'}% を記録しました。`);
    switchTab('results');
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'results'));
  }

  async function renderResultsView() {
    const logs = await window.KeirinDB.getAllDailyLogs();
    const container = $('#log-list');
    if (logs.length === 0) {
      container.innerHTML = '<p class="empty-msg">まだ回収率ログがありません。「予想」タブで本日の結果ページのHTMLを貼り付けて集計してください。</p>';
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
    $('#parse-html-btn').addEventListener('click', handleParseHtml);
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
