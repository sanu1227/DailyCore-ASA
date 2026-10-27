const { writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

module.exports = async function smokeActivity({ window, widget, showSurface, baseUrl, root, dataPath, screenshot }) {
  if (!process.argv.includes('--smoke-test')) throw new Error('Activity fixtures require an isolated smoke profile');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = code => window.webContents.executeJavaScript(code);
  const until = async code => {
    for (let i = 0; i < 80; i++) { if (await evaluate(code)) return; await wait(75); }
    throw new Error('Activity screen did not reach: ' + code);
  };
  const seed = (apps, current) => execFileSync(join(root, 'runtime/node.exe'), ['--input-type=module', '-e', `
    import { Store } from './app/store.mjs';
    const store = new Store(process.argv[1]);
    const fixture = JSON.parse(process.argv[2]), now = new Date();
    const date = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    store.db.exec('DELETE FROM activity_usage');
    for (const [app, category, seconds] of fixture.apps) store.addActivity(date, app, category, seconds);
    store.saveIntegration('current_activity', fixture.current); store.close();
  `, dataPath, JSON.stringify({ apps, current })], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const refresh = async () => { await evaluate(`window.dispatchEvent(new Event('focus')); true`); };
  const capture = async suffix => {
    if (!screenshot) return;
    await evaluate(`document.activeElement?.blur(); Promise.all([...document.querySelectorAll('.view:not([hidden]) img')].map(image => image.decode().catch(() => {}))).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    await wait(500);
    writeFileSync(screenshot.replace(/(\.png)?$/i, suffix + '.png'), (await window.webContents.capturePage()).toPNG());
  };
  const session = await (await fetch(baseUrl + '/api/session')).json();
  const toggle = async enabled => {
    const response = await fetch(baseUrl + '/api/activity/toggle', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': session.token }, body: JSON.stringify({ enabled }) });
    if (!response.ok) throw new Error('Activity toggle failed');
    await refresh();
  };
  const report = {};
  widget.hide(); window.setSize(1180, 900); showSurface('app', 'activity');
  await until(`document.body.dataset.view === 'activity' && document.querySelector('.activity-empty') !== null`);
  report.emptyState = await evaluate(`document.getElementById('activity-total').textContent === '—' && document.getElementById('activity-categories').hidden && document.getElementById('activity-more').hidden && document.getElementById('activity-status').textContent === '측정 준비 중'`);
  await capture('.empty');
  await toggle(false); await until(`document.getElementById('activity-status').textContent === '측정 꺼짐'`);
  report.disabledEmpty = await evaluate(`document.getElementById('activity-status').dataset.state === 'idle' && document.querySelector('.activity-empty').textContent.includes('측정 설정에서 켜면')`);
  await toggle(true);
  const apps = [['Code', 'study', 7200], ['Overwatch', 'game', 5400], ['Chrome', 'other', 1800], ['Discord', 'other', 600], ['VLC', 'video', 300], ['Explorer', 'other', 30], ['아주 긴 프로그램 이름과 프로젝트 설명 '.repeat(3), 'other', 10], ['Unused', 'other', 0]];
  const current = () => ({ app: 'Code', category: 'study', track: true, checkedAt: new Date().toISOString() });
  seed(apps, current()); await refresh(); await until(`document.getElementById('activity-app-count').textContent.startsWith('7개')`);
  report.recordedTotals = await evaluate(`document.getElementById('activity-total').textContent === '4시간 16분' && document.querySelectorAll('.activity-category').length === 4 && document.querySelector('[data-category="other"]').textContent.includes('41분')`);
  report.measuring = await evaluate(`document.getElementById('activity-status').textContent === '측정 중' && document.getElementById('activity-status').dataset.state === 'active'`);
  report.topApps = await evaluate(`document.querySelectorAll('#activity-apps .activity-row').length === 5 && document.querySelector('#activity-apps strong').textContent === 'Code' && !document.getElementById('activity-more').open && document.querySelectorAll('#activity-more-apps .activity-row').length === 2`);
  report.noRepeatedBars = await evaluate(`!document.querySelector('#view-activity .activity-bar, #view-activity .activity-summary') && !document.getElementById('view-activity').textContent.includes('Unused') && document.querySelectorAll('#view-activity .inline-help').length === 1`);
  report.wideLayout = await evaluate(`(() => { const a = document.getElementById('activity-total').getBoundingClientRect(), b = document.getElementById('activity-categories').getBoundingClientRect(); return a.right < b.left && document.documentElement.scrollWidth <= innerWidth; })()`);
  await capture('');
  await evaluate(`document.getElementById('activity-more-label').focus(); true`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await until(`document.getElementById('activity-more').open`);
  report.keyboardExpand = await evaluate(`document.querySelector('#activity-more-apps .activity-duration').textContent === '1분 미만' && document.querySelector('#activity-more-apps').getBoundingClientRect().height > 0`);
  seed([...apps, ['Notepad', 'other', 70]], current()); await refresh(); await until(`document.getElementById('activity-app-count').textContent.startsWith('8개')`);
  report.expandSurvivesRefresh = await evaluate(`document.getElementById('activity-more').open`);
  seed(apps, { ...current(), track: false }); await refresh(); await until(`document.getElementById('activity-status').textContent === '측정 대기'`);
  report.idleState = await evaluate(`document.getElementById('activity-status').dataset.state === 'idle'`);
  seed(apps, { ...current(), checkedAt: new Date(Date.now() - 180000).toISOString() }); await refresh(); await until(`document.getElementById('activity-status').textContent === '측정 확인 중'`);
  report.staleState = await evaluate(`document.getElementById('activity-status').dataset.state === 'idle'`);
  await toggle(false); await until(`document.getElementById('activity-status').textContent === '측정 꺼짐'`);
  report.disabledKeepsHistory = await evaluate(`document.querySelectorAll('.activity-row').length === 7 && document.getElementById('activity-total').textContent === '4시간 16분'`);
  await capture('.paused');
  await toggle(true); seed(apps, current()); await refresh(); await until(`document.getElementById('activity-status').textContent === '측정 중'`);
  await evaluate(`document.querySelector('.activity-controls button').click(); true`);
  report.settingsLink = await evaluate(`document.body.dataset.view === 'settings'`);
  showSurface('app', 'activity'); await until(`document.body.dataset.view === 'activity'`);
  window.setMinimumSize(360, 620); window.setSize(390, 844); await wait(200); await evaluate(`scrollTo(0, 0); true`);
  report.narrowLayout = await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.getElementById('activity-total').getBoundingClientRect().bottom <= document.getElementById('activity-categories').getBoundingClientRect().top`);
  await capture('.narrow');
  await evaluate(`document.getElementById('activity-more').scrollIntoView({ block: 'center' }); true`);
  report.longName = await evaluate(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.activity-duration')].every(item => item.getBoundingClientRect().right <= innerWidth)`);
  await capture('.expanded');
  seed([['Code', 'study', 20]], current()); await refresh(); await until(`document.querySelectorAll('.activity-row').length === 1`);
  report.shortRecord = await evaluate(`document.getElementById('activity-total').textContent === '1분 미만' && document.querySelectorAll('.activity-category').length === 1 && document.getElementById('activity-more').hidden`);
  return report;
};
