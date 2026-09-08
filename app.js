/**
 * app.js
 * 画面遷移・イベントハンドリングを行うメインスクリプト。
 *
 * データ取得はURLフェッチではなく、ユーザーがiPhone Safari上のブックマークレットで
 * ページのHTMLをコピーし、テキストエリアに貼り付けて「解析する」ボタンを押す方式。
 * 貼り付けられたHTMLが「出走表」か「結果」かは htmlParser.detectPageType が自動判定し、
 *  - 出走表と判定: 選手ごとの学習データ(riders)で補強したAI推論を行い、荒れ度・展開予想・
 *    買い方戦略・期待値ランキング・脚質変化・相性データを付与して次回表示するレースとして保存
 *  - 結果と判定  : 前回保存済みの予想と突き合わせて回収率を計算し、選手の学習データ
 *    (直近成績・相性)を更新したうえで、そのレースを「決着済み(settled)」にする(削除はしない)
 * にそれぞれ振り分ける。1回の貼り付けで複数レース分のテーブルが含まれていても、
 * 含まれていなくてもどちらでも解析できるようパーサー側で対応している。
 * 決着済みのレースも削除せず保持するため、予想一覧では日付フィルタで過去の予想を
 * 履歴として振り返ることができる(B-2)。
 */

(function () {
  const state = {
    races: [], // DB内の全レース(決着済みも含めて保持し、日付フィルタで履歴表示できるようにする)
    selectedDate: null, // 予想一覧の日付フィルタで選択中の日付(nullなら「最新の未決着日」を自動表示)
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

  /** 未決着(=これから走る)レースの中で最新の予想日を返す */
  function latestUnsettledDate() {
    const unsettled = state.races.filter((r) => !r.settled);
    if (unsettled.length === 0) return null;
    return unsettled.reduce((max, r) => (r.date > max ? r.date : max), unsettled[0].date);
  }

  /** B-2: 予想一覧に表示する日付(降順)の一覧。フィルタのセレクトボックス用。 */
  function availableDates() {
    return [...new Set(state.races.map((r) => r.date))].sort().reverse();
  }

  /** 表示対象のレース群。selectedDateが指定されていればその日付、無ければ最新の未決着日。 */
  function displayedRaces() {
    if (state.races.length === 0) return [];
    const targetDate = state.selectedDate || latestUnsettledDate() || state.races[0].date;
    return state.races
      .filter((r) => r.date === targetDate)
      .sort((a, b) => (a.raceNumber || 0) - (b.raceNumber || 0));
  }

  /** 記事生成・買い目強化などは常に「最新の未決着日(=翌日予想)」を対象にする */
  function latestDateRaces() {
    const targetDate = latestUnsettledDate();
    if (!targetDate) return [];
    return state.races.filter((r) => r.date === targetDate).sort((a, b) => (a.raceNumber || 0) - (b.raceNumber || 0));
  }

  function renderDateFilter() {
    const select = $('#race-date-filter');
    if (!select) return;
    const dates = availableDates();
    const latest = latestUnsettledDate();
    if (!state.selectedDate || !dates.includes(state.selectedDate)) {
      state.selectedDate = latest || dates[0] || null;
    }
    select.innerHTML = dates
      .map((d) => `<option value="${d}"${d === state.selectedDate ? ' selected' : ''}>${d}${d === latest ? '（予想）' : '（結果済み）'}</option>`)
      .join('');
    select.parentElement.hidden = dates.length <= 1;
  }

  function renderRacesView() {
    renderDateFilter();
    const races = displayedRaces();
    const isLatest = races[0] && !races[0].settled;
    $('#race-list').innerHTML = window.KeirinCards.renderRaceList(races);
    $('#races-date-label').textContent = races[0] ? `${isLatest ? '翌日の予想' : '過去の予想'} (${races[0].date})` : '';
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
   * レースオブジェクトを保存用の形に整える。
   * members/odds/predictions に加え、荒れ度・展開予想・買い方戦略・期待値ランキング・
   * 脚質変化・相性データ(共通仕様で追加された分析フィールド)を付与する。
   */
  function finalizeRaceForStorage(race, riderMap) {
    const oddsMap = {};
    race.players.forEach((p) => {
      if (p.odds != null) oddsMap[p.number] = p.odds;
    });
    const raceRisk = window.KeirinBetting.buildRaceRisk(race.players, race.lines);
    return {
      ...race,
      raceId: race.raceKey,
      members: race.players,
      odds: oddsMap,
      predictions: window.KeirinBetting.buildPredictions(race.players, { riderMap, lines: race.lines }),
      expectedValueRanking: window.KeirinBetting.buildExpectedValueRanking(race.players),
      raceRisk,
      raceStrategy: window.KeirinBetting.buildRaceStrategy(raceRisk),
      raceFlow: window.KeirinBetting.buildRaceFlow(race.players),
      styleChanges: window.KeirinBetting.detectStyleChanges(race.players, riderMap),
      compatibilityNotes: window.KeirinBetting.buildCompatibilityNotes(race.players, riderMap),
    };
  }

  /** 「予想」タブに貼り付けられたHTMLを出走表として解析する(結果ページは「回収率」タブで扱う) */
  async function handleParseHtml() {
    const textarea = $('#html-input');
    const html = textarea.value.trim();
    if (!html) {
      setStatus('HTMLを貼り付けてください。', true);
      return;
    }

    try {
      setStatus('出走表を解析中...');
      const pageType = window.KeirinParser.detectPageType(html);
      if (pageType === 'result') {
        setStatus('結果ページのHTMLのようです。結果は「回収率」タブに貼り付けてください。', true);
        return;
      }
      await handleRaceCard(html);
      textarea.value = '';
    } catch (err) {
      console.error(err);
      setStatus('解析中にエラーが発生しました。貼り付けたHTMLの内容をご確認ください。', true);
    }
  }

  function setResultStatus(msg, isError = false) {
    const el = $('#result-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', isError);
  }

  /** 「回収率」タブに貼り付けられたHTMLを結果として解析する */
  async function handleParseResultHtml() {
    const textarea = $('#result-html-input');
    const html = textarea.value.trim();
    if (!html) {
      setResultStatus('HTMLを貼り付けてください。', true);
      return;
    }

    try {
      setResultStatus('結果を解析中...');
      const pageType = window.KeirinParser.detectPageType(html);
      if (pageType === 'racecard') {
        setResultStatus('出走表ページのHTMLのようです。出走表は「予想」タブに貼り付けてください。', true);
        return;
      }
      await handleResult(html);
      textarea.value = '';
    } catch (err) {
      console.error(err);
      setResultStatus('解析中にエラーが発生しました。貼り付けたHTMLの内容をご確認ください。', true);
    }
  }

  /** 出走表として解析: 選手ごとの学習データで補強したAI推論を行い、次回表示するレースとして保存する */
  async function handleRaceCard(html) {
    const races = window.KeirinParser.parseRaceCardsFromPage(html);
    if (races.length === 0) {
      setStatus('選手情報を検出できませんでした。貼り付けたHTMLの内容をご確認ください。', true);
      return;
    }
    setStatus(`出走表と判定。${races.length}レース分を検出、AI推論を実行中...`);
    const riderMap = await window.KeirinDB.getRiderMap();
    const predicted = await window.KeirinModel.predictRaces(races, riderMap);
    const finalized = predicted.map((race) => finalizeRaceForStorage(race, riderMap));
    await window.KeirinDB.saveRaces(finalized);
    await loadAllRaces();
    setStatus(`翌日${finalized.length}レース分を予想しました。`);
    switchTab('races');
    $$('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'races'));
  }

  /**
   * 結果の着順・決まり手を、当日の出走表データ(ライン位置・得点)と突き合わせて
   * 選手ごとの学習データ(riders)を更新する(直近5走をFIFOで維持し、勝率等を再計算)。
   * あわせて選手同士の相性データ(pairStats)も更新する(S-1)。
   */
  async function updateRidersFromResults(todaysRaces, results) {
    const raceMap = new Map(todaysRaces.map((r) => [r.raceKey, r]));
    for (const result of results) {
      const race = raceMap.get(result.raceKey);
      const membersByNumber = new Map(((race && (race.members || race.players)) || []).map((p) => [p.number, p]));
      for (const entry of result.order) {
        const member = membersByNumber.get(entry.number);
        const name = entry.name || (member && member.name);
        if (!name) continue;
        await window.KeirinDB.upsertRiderFromResult(
          name,
          {
            rank: entry.rank,
            move: entry.move || null,
            line: member ? member.linePosition : null,
            score: member ? member.score : null,
            style: member ? member.style : null,
          },
          result.date
        );
      }
      await window.KeirinDB.updatePairStats(result.order);
    }
  }

  /** 結果として解析: 前回保存済みの予想と突き合わせて回収率を計算し、選手の学習データを更新する */
  async function handleResult(html) {
    const results = window.KeirinParser.parseResultsFromPage(html);
    if (results.length === 0) {
      setResultStatus('着順情報を検出できませんでした。貼り付けたHTMLの内容をご確認ください。', true);
      return;
    }
    const resultDate = results[0].date;
    const todaysRaces = state.races.filter((r) => r.date === resultDate);
    if (todaysRaces.length === 0) {
      setResultStatus(`結果と判定されましたが、${resultDate}分の予想データが見つかりませんでした。`, true);
      return;
    }
    const log = window.KeirinBetting.computeDailyRecovery(resultDate, todaysRaces, results);
    await window.KeirinDB.saveDailyLog(log);
    await updateRidersFromResults(todaysRaces, results);
    await window.KeirinDB.markRacesSettled(resultDate);
    await loadAllRaces();
    setResultStatus(`結果と判定。${resultDate}の回収率 ${log.recoveryRate ?? '-'}% を記録し、選手データを更新しました。`);
    renderResultsView();
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
    $('#parse-result-btn').addEventListener('click', handleParseResultHtml);
    $('#generate-article-btn').addEventListener('click', handleGenerateArticle);
    $('#copy-article-btn').addEventListener('click', handleCopyArticle);
    const dateFilter = $('#race-date-filter');
    if (dateFilter) {
      dateFilter.addEventListener('change', (e) => {
        state.selectedDate = e.target.value;
        renderRacesView();
      });
    }
  }

  async function init() {
    bindEvents();
    await loadAllRaces();
    renderRacesView();

    if ('serviceWorker' in navigator) {
      // 新しいService Workerが有効になった瞬間にページを自動リロードする。
      // これが無いと、アプリを開きっぱなしにしている間はコードを更新しても
      // (キャッシュ自体は新しくなっても)実行中のJSは古いバージョンのまま動き続けてしまう。
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });
      try {
        await navigator.serviceWorker.register('service-worker.js');
      } catch (err) {
        console.warn('Service Worker登録に失敗しました。', err);
      }
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
