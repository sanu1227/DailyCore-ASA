const { writeFileSync } = require('node:fs');

// Called only by --smoke-test --smoke-review, with an isolated backend and DB.
module.exports = async function smokeReview({ window, widget, showSurface, baseUrl, displayNotification, getNotification, screenshot }) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = code => window.webContents.executeJavaScript(code);
  const until = async check => {
    for (let i = 0; i < 80; i++) { if (await check()) return; await wait(75); }
    throw new Error('Review smoke timed out: ' + check);
  };
  let state = await (await fetch(baseUrl + '/api/session')).json();
  const token = state.token;
  const post = async (path, body) => {
    const response = await fetch(baseUrl + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': token }, body: JSON.stringify(body) });
    state = await response.json(); if (!response.ok) throw new Error(path + ': ' + state.error); return state;
  };
  const reload = async () => {
    await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
    await until(() => evaluate(`document.body.dataset.view === 'review' && document.getElementById('review-date').textContent.length > 0`));
  };
  const capture = async (suffix, target = window) => {
    if (!screenshot) return;
    await target.webContents.executeJavaScript(`document.activeElement?.blur(); Promise.all([...document.querySelectorAll('img')].map(image => image.decode().catch(() => {}))).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    await wait(500);
    writeFileSync(screenshot.replace(/(\.png)?$/i, suffix + '.png'), (await target.webContents.capturePage()).toPNG());
  };
  const report = {};
  widget.hide(); window.setSize(1180, 860); showSurface('app', 'review');
  for (const item of state.academics) await post('/api/academic/delete', { id: item.id });
  await reload();
  report.emptyState = await evaluate(`!document.getElementById('review-empty').hidden && document.getElementById('review-highlights').hidden && document.getElementById('review-upcoming').hidden && document.getElementById('review-tomorrow').hidden`);
  report.noClutter = await evaluate(`!document.querySelector('#review-health, #review-focus, #review-weekly-badge') && !document.getElementById('view-review').textContent.includes('0분')`);
  await capture('.empty');

  const now = new Date(), tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const date = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  for (const title of ['가벼운 스트레칭', '책 읽기', '저녁 산책']) await post('/api/routine', { title, category: 'other', days: [1,2,3,4,5,6,7], time: '20:00', notes: '' });
  const routineIds = state.routines.map(item => item.id);
  for (const id of routineIds.slice(0, 2)) await post('/api/routine/toggle', { id, completed: true });
  await post('/api/academic', { title: '알고리즘 실습', kind: 'assignment', due: date + 'T23:59' });
  const completedId = state.academics[0].id;
  await post('/api/academic/toggle', { id: completedId, completed: true });
  await post('/api/academic', { title: '컴퓨터 그래픽스 보고서 제출', kind: 'assignment', due: date + 'T23:59' });
  const priority = state.eveningReview.priority;
  await post('/api/class', { name: '컴퓨터 그래픽스', day: tomorrow.getDay() || 7, start: '13:00', end: '15:00', location: 'E동 205호' });
  await post('/api/class', { name: '알고리즘', day: tomorrow.getDay() || 7, start: '10:00', end: '12:00', location: 'E동 101호' });
  await reload();
  report.recordedFacts = await evaluate(`document.querySelectorAll('.review-stat').length === 2 && document.getElementById('review-highlights').textContent.includes('2 / 3') && document.getElementById('review-highlights').textContent.includes('1개')`);
  report.nearbyPlan = await evaluate(`!document.getElementById('review-upcoming').hidden && document.getElementById('review-next-title').textContent === '컴퓨터 그래픽스 보고서 제출' && document.getElementById('review-next-action').textContent.includes('내일 23:59')`);
  report.tomorrowOrder = await evaluate(`document.querySelectorAll('.review-class').length === 2 && document.querySelector('.review-class strong').textContent === '알고리즘'`);
  report.wideLayout = await evaluate(`(() => { const a = document.getElementById('review-upcoming').getBoundingClientRect(), b = document.getElementById('review-tomorrow').getBoundingClientRect(); return a.right < b.left && document.documentElement.scrollWidth <= innerWidth; })()`);
  await capture('');
  await evaluate(`document.querySelector('#review-upcoming button').click(); true`);
  report.scheduleLink = await evaluate(`document.body.dataset.view === 'university'`);
  window.hide(); widget.hide();
  await displayNotification({ key: state.eveningReview.key, title: state.eveningReview.title, body: state.eveningReview.body, display: 'daily-review', volume: 0, previewDuration: 30000 });
  await until(() => getNotification() && !getNotification().webContents.isLoadingMainFrame());
  const card = getNotification(); await wait(300);
  report.noFocusSteal = !card.isFocused();
  report.compactNotification = await card.webContents.executeJavaScript(`document.querySelectorAll('.actions button').length === 2 && !document.querySelector('[data-action="snooze"]') && document.querySelector('[data-action="open"]').textContent === '결산 보기' && document.querySelector('.body').scrollHeight <= document.querySelector('.body').clientHeight && document.querySelector('.actions').getBoundingClientRect().bottom <= innerHeight`);
  await capture('.notification', card);
  await card.webContents.executeJavaScript(`document.querySelector('[data-action="open"]').click(); true`);
  await until(() => evaluate(`document.body.dataset.view === 'review'`));
  report.notificationOpensReview = card.isDestroyed() && window.isVisible();
  report.reviewToggle = await evaluate(`(() => { const toggle = document.getElementById('evening-review'), timing = document.getElementById('evening-review-usage-minutes'); toggle.checked = false; toggle.dispatchEvent(new Event('change')); const disabled = timing.disabled; toggle.checked = true; toggle.dispatchEvent(new Event('change')); return disabled && !timing.disabled; })()`);
  await post('/api/routine/toggle', { id: routineIds[0], completed: false }); await reload();
  report.freshData = await evaluate(`document.getElementById('review-highlights').textContent.includes('1 / 3')`);
  await post('/api/routine/toggle', { id: routineIds[0], completed: true }); await reload();
  window.setMinimumSize(360, 620); window.setSize(390, 844); await wait(200);
  report.narrowLayout = await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.getElementById('review-upcoming').getBoundingClientRect().bottom <= document.getElementById('review-tomorrow').getBoundingClientRect().top`);
  await capture('.narrow');
  await post('/api/academic', { ...priority, id: priority.id, title: '아주 긴 보고서 이름과 제출 내용을 확인하는 과제 '.repeat(4).slice(0, 100) }); await reload();
  report.longTitle = await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.getElementById('review-next-title').getBoundingClientRect().height > 40`);
  await capture('.long');
  return report;
};
