const { writeFileSync } = require('node:fs');

module.exports = async function smokeLifestyle({ window, widget, showSurface, screenshot }) {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = code => window.webContents.executeJavaScript(code);
  const until = async code => {
    for (let attempt = 0; attempt < 80; attempt++) { if (await evaluate(code)) return true; await wait(75); }
    throw new Error('Life screen did not reach expected state: ' + code);
  };
  const capture = async suffix => {
    if (!screenshot) return;
    await evaluate(`document.activeElement?.blur(); document.getElementById('toast').hidden = true; Promise.all([...document.querySelectorAll('.view:not([hidden]) img')].map(image => image.decode().catch(() => {}))).then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    await wait(600);
    writeFileSync(screenshot.replace(/(\.png)?$/i, suffix + '.png'), (await window.webContents.capturePage()).toPNG());
  };
  const report = {};
  widget.hide(); window.setSize(1180, 900); showSurface('app', 'routines');
  await until(`document.body.dataset.view === 'routines' && document.getElementById('health-date').value !== ''`);
  await until(`document.querySelector('.nav[aria-current="page"]').dataset.view === 'routines' && document.querySelector('.life-heading img').naturalWidth > 0`);
  report.unifiedNavigation = await evaluate(`document.querySelectorAll('.nav[data-view="routines"]').length === 1 && !document.querySelector('.nav[data-view="health"]') && !document.getElementById('view-health') && document.getElementById('health-form').closest('.view').id === 'view-routines'`);
  report.emptyState = await evaluate(`document.querySelector('#today-routines .life-empty') !== null && !document.querySelector('.routine-library').open`);
  await evaluate(`document.querySelector('.nav[data-view="routines"]').click(); true`);
  await capture('.empty');

  await evaluate(`document.getElementById('add-routine').click(); document.getElementById('routine-name').value = '가볍게 스트레칭'; document.getElementById('routine-time').value = '20:00'; document.querySelectorAll('[name="routine-day"]').forEach(input => input.checked = true); document.getElementById('routine-form').requestSubmit(); true`);
  await until(`!document.getElementById('routine-dialog').open && document.querySelectorAll('#today-routines .routine-card').length === 1`);
  report.createRoutine = true;
  await evaluate(`document.getElementById('health-note').value = '산책하고 나니 조금 개운해졌다.'; document.getElementById('health-note').dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#today-routines .complete-button').click(); true`);
  await until(`document.querySelector('#today-routines .complete-button').getAttribute('aria-pressed') === 'true'`);
  report.completeKeepsDraft = await evaluate(`document.getElementById('health-note').value === '산책하고 나니 조금 개운해졌다.' && document.getElementById('routine-progress-bar').value === 1 && document.getElementById('health-record-status').textContent === '저장 전'`);
  await evaluate(`document.querySelector('#today-routines .complete-button').click(); true`);
  await until(`document.querySelector('#today-routines .complete-button').getAttribute('aria-pressed') === 'false'`);
  report.undoCompletion = true;
  await evaluate(`document.getElementById('health-sleep').value = '7.5'; document.getElementById('health-exercise').value = '20'; document.getElementById('health-energy').value = '4'; document.getElementById('health-energy').dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('health-form').requestSubmit(); true`);
  await until(`document.getElementById('health-record-status').textContent === '기록 완료' && document.querySelectorAll('.health-day').length === 1`);
  report.saveRecord = await evaluate(`document.getElementById('health-sleep-average').textContent.includes('7시간 30분') && document.getElementById('health-energy-value').textContent.includes('괜찮음')`);
  await evaluate(`document.querySelector('.routine-library').open = true; document.querySelector('#all-routines .routine-copy').click(); document.getElementById('routine-name').value = '저녁 스트레칭 20분'; document.getElementById('routine-form').requestSubmit(); true`);
  await until(`!document.getElementById('routine-dialog').open && document.getElementById('today-routines').textContent.includes('저녁 스트레칭 20분')`);
  report.editRoutine = true;
  await evaluate(`document.querySelector('.routine-library').open = false; document.getElementById('health-date').value = '2000-01-01'; document.getElementById('health-form').requestSubmit(); true`);
  report.dateValidation = await evaluate(`!document.getElementById('health-date').checkValidity() && document.querySelectorAll('.health-day').length === 1`);
  await evaluate(`document.getElementById('health-today').click(); document.querySelector('.health-day').click(); true`);
  report.reopenRecord = await evaluate(`document.getElementById('health-sleep').value === '7.5' && document.getElementById('health-note').value === '산책하고 나니 조금 개운해졌다.'`);
  await evaluate(`document.getElementById('health-note').value = '산책 기록 수정'; document.getElementById('health-form').requestSubmit(); true`);
  await until(`fetch('/api/session').then(response => response.json()).then(session => session.healthToday?.note === '산책 기록 수정')`);
  // A different view and reload exercise the old health link used by desktop notifications.
  showSurface('app', 'home');
  await until(`document.body.dataset.view === 'home'`);
  showSurface('app', 'health');
  await until(`document.body.dataset.view === 'routines' && location.hash === '#routines'`);
  report.legacyHealthLink = true;
  await new Promise(resolve => { window.webContents.once('did-finish-load', resolve); window.webContents.reload(); });
  await until(`document.body.dataset.view === 'routines' && document.getElementById('health-record-status').textContent === '기록 완료'`);
  report.reloadPersists = await evaluate(`document.getElementById('health-note').value === '산책 기록 수정' && document.getElementById('today-routines').textContent.includes('저녁 스트레칭 20분') && !document.getElementById('health-check-reminder').checked`);
  const oldLink = new URL(window.webContents.getURL()); oldLink.hash = '#health';
  await window.loadURL(oldLink.href);
  await until(`document.body.dataset.view === 'routines' && location.hash === '#routines' && document.getElementById('health-note').value === '산책 기록 수정'`);
  report.legacyColdStart = true;
  await evaluate(`(() => { const d = new Date(); d.setDate(d.getDate() - 1); const pad = n => String(n).padStart(2, '0'); document.getElementById('health-date').value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); document.getElementById('health-date').dispatchEvent(new Event('change')); document.getElementById('health-sleep').value = '8'; document.getElementById('health-note').value = '어제 기록'; document.getElementById('health-form').requestSubmit(); })(); true`);
  await until(`document.querySelectorAll('.health-day').length === 2 && document.getElementById('health-record-status').textContent === '기록 완료'`);
  await evaluate(`document.querySelectorAll('.health-day')[1].click(); true`);
  report.pastRecord = await evaluate(`document.getElementById('health-sleep').value === '8' && document.getElementById('health-note').value === '어제 기록'`);
  await evaluate(`document.getElementById('health-today').click(); true`);
  report.todayShortcut = await evaluate(`document.getElementById('health-sleep').value === '7.5' && document.getElementById('health-note').value === '산책 기록 수정'`);
  report.wideLayout = await evaluate(`(() => { const a = document.querySelector('.life-routines').getBoundingClientRect(), b = document.getElementById('health-form').getBoundingClientRect(); return a.right < b.left && Math.abs(a.top - b.top) < 2 && document.documentElement.scrollWidth <= innerWidth; })()`);
  await evaluate(`scrollTo(0, 0); true`); await capture('');
  await evaluate(`document.querySelector('.life-history').scrollIntoView({ block: 'center' }); true`); await capture('.history');
  window.setMinimumSize(360, 620); window.setSize(390, 844);
  await wait(200); await evaluate(`scrollTo(0, 0); true`);
  report.narrowLayout = await evaluate(`(() => { const a = document.querySelector('.life-routines').getBoundingClientRect(), b = document.getElementById('health-form').getBoundingClientRect(); return a.bottom <= b.top && document.documentElement.scrollWidth <= innerWidth && b.right <= innerWidth; })()`);
  await capture('.narrow');
  await evaluate(`document.getElementById('health-form').scrollIntoView({ block: 'start' }); true`); await capture('.narrow-form');
  return report;
};
