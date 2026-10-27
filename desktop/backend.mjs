import { createApp } from '../app/server.mjs';
import { detectForegroundGame, ReminderService, showUrgentPopup, showWindowsNotification, withGamePlacement, snoozeNotification } from '../app/reminders.mjs';
import { ActivityService } from '../app/activity.mjs';
import { randomUUID } from 'node:crypto';

// UI smoke checks use synthetic records and must never spend real Codex usage.
const smokeClient = process.env.RIN_SMOKE_TEST === '1' ? {
  async generate({ schema }) {
    if (!schema?.properties?.memories) throw new Error('Unexpected Codex generation in UI smoke test');
    return { text: '{"memories":[]}', model: 'codex-smoke', usage: { total_tokens: 0 } };
  },
  async probe() { return { available: true, model: 'codex-smoke' }; },
  close() {},
} : null;
const { server, store, token, refreshProviderStatus } = createApp({ dataPath: process.env.RIN_DATA_PATH, ...(smokeClient ? { codexClient: smokeClient } : {}) });
if (process.env.RIN_SMOKE_TEST === '1') {
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
  const due = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}T15:00`;
  const title = '팀플 회의';
  const itemId = store.saveAcademic({ title, course: '', kind: 'event', due, notes: '', completed: false });
  store.addPair('오늘은 좀 정신없었어.', '뭐가 그렇게 바빴는데? 하나씩 말해 봐.');
  store.addPair('내일 오후 3시에 팀플 회의 있어.', '내일 오후 3시, 팀플 회의. 일정에 적어 뒀어.', { status: 'success', action: 'add', itemId, title, due });
}
let reminders, activities, closing = false;
let providerTimer;
const notificationRequests = new Map();
function showDesktopNotification(candidate) {
  if (!process.send) return showWindowsNotification(candidate);
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timeout = setTimeout(() => { notificationRequests.delete(id); reject(new Error('데스크톱 알림 응답 시간이 초과됐습니다.')); }, 5000);
    notificationRequests.set(id, { resolve, reject, timeout });
    process.send({ type: 'notification', id, candidate }, error => {
      if (!error) return;
      clearTimeout(timeout); notificationRequests.delete(id); reject(error);
    });
  });
}
process.on('message', message => {
  if (message?.type === 'notification-snooze') {
    try { process.send?.({ type: 'notification-action-result', id: message.id, ok: true, ...snoozeNotification(store, message.candidate) }); }
    catch (error) { process.send?.({ type: 'notification-action-result', id: message.id, ok: false, error: error.message }); }
  }
  if (message?.type === 'notification-suppressed') store.recordMissedNotification(message.candidate);
  if (message?.type === 'notification-result') {
    const request = notificationRequests.get(message.id);
    if (!request) return;
    clearTimeout(request.timeout); notificationRequests.delete(message.id);
    message.ok ? request.resolve() : request.reject(new Error(message.error || '데스크톱 알림을 표시하지 못했습니다.'));
  }
  if (message === 'shutdown') close();
});
server.on('error', error => { process.send?.({ type: 'error', message: error.message }); process.exitCode = 1; });
server.listen(Number(process.env.RIN_PORT || 4317), '127.0.0.1', () => {
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  if (process.env.RIN_SMOKE_TEST !== '1') {
    const notify = async candidate => {
      const placed = withGamePlacement(candidate, await detectForegroundGame());
      const result = placed.display === 'popup'
        ? showUrgentPopup(placed, { token, baseUrl })
        : showDesktopNotification(placed);
      const outcome = await result;
      if (outcome?.suppressed) store.recordMissedNotification(placed);
      return outcome;
    };
    reminders = new ReminderService(store, { notify });
    activities = new ActivityService(store, { notify });
    reminders.start(); activities.start();
    void refreshProviderStatus();
    providerTimer = setInterval(refreshProviderStatus, 5 * 60_000); providerTimer.unref();
  }
  process.send?.({ type: 'ready', baseUrl });
});
function close() {
  if (closing) return;
  closing = true; clearInterval(providerTimer); reminders?.stop(); activities?.stop();
  server.close(() => process.exit(0));
  server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('disconnect', close);
