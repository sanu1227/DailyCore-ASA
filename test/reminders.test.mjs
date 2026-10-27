import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { AWAY_CASUAL_THRESHOLDS, buildAwayCasualCandidate, buildCasualConversationCandidate, buildDailyBriefing, buildGameNagCandidate, buildHealthCheckCandidate, buildReminderCandidates, buildRoutineCandidates, buildStartupDeadlineCandidate, casualUsageThresholds, expandNotificationCandidate, isQuietTime, isUserPresent, ReminderService, showWindowsNotification, withGamePlacement } from '../app/reminders.mjs';
import { RIN_AWAY_LINES } from '../app/rin-away-lines.mjs';
import { RIN_CASUAL_LINES } from '../app/rin-casual-lines.mjs';
import { snoozeNotification, sendSnoozedNotifications } from '../app/reminders.mjs';

const settings = { notifications: true, quietStart: '01:00', quietEnd: '07:00', gameNagging: true, gameNagMinutes: 30, dailyBriefing: true };

test('snoozed notifications survive restart, wait for quiet hours, retry failures and skip completed items', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rin-snooze-test-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  try {
    store.saveSettings({ ...store.settings(), notifications: true, quietModeEnabled: true, quietStart: '01:00', quietEnd: '07:00' });
    const now = new Date(2026, 9, 21, 0, 55), delivered = [];
    const candidate = { key: 'casual:test', title: '아사 · 잠깐', body: '하던 거 저장해 둬.', previewDuration: 100 };
    snoozeNotification(store, candidate, now);
    snoozeNotification(store, candidate, now);
    assert.equal(store.integration('notification_snoozes').items.length, 1);
    store.close(); store = new Store(path);
    await sendSnoozedNotifications(store, value => delivered.push(value), new Date(2026, 9, 21, 1, 15));
    assert.equal(delivered.length, 0);
    await assert.rejects(sendSnoozedNotifications(store, () => { throw new Error('delivery failed'); }, new Date(2026, 9, 21, 7, 0)), /delivery failed/);
    assert.equal(store.integration('notification_snoozes').items.length, 1);
    await sendSnoozedNotifications(store, value => delivered.push(value), new Date(2026, 9, 21, 7, 1));
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].snoozedAt, now.toISOString());
    assert.equal(delivered[0].previewDuration, undefined);
    await sendSnoozedNotifications(store, value => delivered.push(value), new Date(2026, 9, 21, 7, 2));
    assert.equal(delivered.length, 1);
    const id = store.saveAcademic({ title: '회의', kind: 'event', due: '2026-10-21T09:00', course: '', notes: '', completed: false });
    snoozeNotification(store, { ...candidate, key: 'event:test', itemId: id, scheduledFor: '2026-10-21T09:00' }, new Date(2026, 9, 21, 8, 30));
    store.toggleAcademic(id, true);
    await sendSnoozedNotifications(store, value => delivered.push(value), new Date(2026, 9, 21, 8, 46));
    assert.equal(delivered.length, 1);
    assert.deepEqual(store.integration('notification_snoozes').items, []);
    const classId = store.saveClass({ name: '알고리즘', day: 3, start: '09:00', end: '10:00', location: '' });
    const classNotice = buildReminderCandidates({ classes: store.classes(), settings: store.settings(), now: new Date(2026, 9, 21, 8, 40) })[0];
    snoozeNotification(store, classNotice, new Date(2026, 9, 21, 8, 40));
    await sendSnoozedNotifications(store, value => delivered.push(value), new Date(2026, 9, 21, 8, 54));
    assert.equal(delivered.length, 1, 'do not deliver before 15 minutes');
    store.saveClass({ name: '알고리즘', day: 4, start: '09:00', end: '10:00', location: '' }, classId);
    await sendSnoozedNotifications(store, value => delivered.push(value), new Date(2026, 9, 21, 8, 56));
    assert.equal(delivered.length, 1, 'drop a class moved to another day');
    const routineId = store.saveRoutine({ title: '스트레칭', category: 'custom', days: [3], time: '08:30', notes: '', active: true });
    const routineNotice = buildRoutineCandidates({ routines: store.routines('2026-10-21'), settings: store.settings(), now: new Date(2026, 9, 21, 8, 40) })[0];
    snoozeNotification(store, routineNotice, new Date(2026, 9, 21, 8, 40));
    store.saveRoutine({ title: '스트레칭', category: 'custom', days: [3], time: '10:00', notes: '', active: true }, routineId);
    await sendSnoozedNotifications(store, value => delivered.push(value), new Date(2026, 9, 21, 8, 56));
    assert.equal(delivered.length, 1, 'drop a rescheduled routine');
    assert.deepEqual(store.integration('notification_snoozes').items, []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('health reminders are opt-in, keep the saved choice and cancel deferred health notices when disabled', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rin-health-opt-in-'));
  const path = join(directory, 'test.sqlite');
  let store = new Store(path);
  const now = new Date(2026, 9, 22, 14, 0);
  const healthNotice = () => buildHealthCheckCandidate({ entry: null, settings: store.settings(), usageMinutes: 240, now });
  try {
    assert.equal(store.settings().healthCheckReminder, false);
    assert.equal(healthNotice(), null);
    store.saveSettings({ ...store.settings(), healthCheckReminder: true });
    store.close(); store = new Store(path);
    assert.equal(store.settings().healthCheckReminder, true);
    const candidate = healthNotice();
    assert.ok(candidate);
    snoozeNotification(store, candidate, now);
    snoozeNotification(store, { key: 'casual:keep', title: '아사', body: '편할 때 봐.' }, now);
    store.saveSettings({ ...store.settings(), healthCheckReminder: false });
    store.close(); store = new Store(path);
    assert.equal(healthNotice(), null);
    const delivered = [];
    await sendSnoozedNotifications(store, value => delivered.push(value), new Date(2026, 9, 22, 14, 16));
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].key, /^casual:keep:/);
    assert.deepEqual(store.integration('notification_snoozes').items, []);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('quiet hours support an overnight range', () => {
  assert.equal(isQuietTime(new Date(2026, 8, 11, 2, 0), '01:00', '07:00'), true);
  assert.equal(isQuietTime(new Date(2026, 8, 11, 12, 0), '01:00', '07:00'), false);
  assert.equal(isQuietTime(new Date(2026, 8, 11, 23, 0), '22:00', '06:00'), true);
  assert.equal(isQuietTime(new Date(2026, 8, 11, 23, 0), '22:00', '06:00', false), false);
});

test('user presence uses recent Windows input and fails open when unavailable', () => {
  assert.equal(isUserPresent({ idleSeconds: 299 }), true);
  assert.equal(isUserPresent({ idleSeconds: 300 }), false);
  assert.equal(isUserPresent({}), true);
});

test('notification placement carries only active game window bounds', () => {
  const candidate = { key: 'test', title: 'ASA', body: '확인해.' };
  const bounds = { x: 0, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(withGamePlacement(candidate, { isGame: true, windowBounds: bounds }), { ...candidate, gameWindowBounds: bounds });
  assert.equal(withGamePlacement(candidate, { isGame: false, windowBounds: bounds }), candidate);
  assert.deepEqual(withGamePlacement(candidate, { isGame: false, visibleGameWindowBounds: bounds }), { ...candidate, gameWindowBounds: bounds });
  assert.equal(withGamePlacement(candidate, { isGame: true, windowBounds: { x: 0 } }), candidate);
});

test('Windows fallback notifications are suppressed while a game is active', async () => {
  const result = await showWindowsNotification({ title: 'ASA', body: '게임 중에는 표시하지 않아.', gameWindowBounds: { x: 0, y: 0, width: 1920, height: 1080 } });
  assert.deepEqual(result, { suppressed: true });
});

test('multi-item notifications expand into short numbered cards', () => {
  const cards = expandNotificationCandidate({ key: 'briefing:today', title: 'ASA · 오늘 브리핑', body: '전체 내용', notificationItems: ['수업이 있어.', '마감이 있어.', '루틴이 있어.'] });
  assert.equal(cards.length, 3);
  assert.equal(cards[0].key, 'briefing:today:part:1');
  assert.equal(cards[0].title, 'ASA · 오늘 브리핑 · 1/3');
  assert.equal(cards[0].body, '수업이 있어.');
  assert.equal(cards[2].displayDuration, 8500);
  assert.deepEqual(expandNotificationCandidate({ key: 'one', title: 'ASA', body: '하나', notificationItems: ['하나'] }), [{ key: 'one', title: 'ASA', body: '하나' }]);
});

test('class reminder stays time-sensitive while deadlines move to startup', () => {
  const now = new Date(2026, 8, 11, 9, 35);
  const result = buildReminderCandidates({
    now, settings,
    classes: [{ id: 'class-1', name: '알고리즘', day: 5, start: '10:00', location: 'E동 101호' }],
    academics: [
      { id: 'a', title: '코드 실습', course: '알고리즘', kind: 'assignment', due: '2026-09-11T12:00', completed: 0 },
      { id: 'done', title: '완료 과제', course: '', kind: 'assignment', due: '2026-09-11T12:00', completed: 1 }
    ]
  });
  assert.equal(result.length, 1);
  assert.match(result[0].body, /25분 뒤 시작이야/);
  assert.match(result[0].body, /알고리즘/); assert.match(result[0].body, /E동 101호/);
});

test('appointments notify within 30 minutes and respect completion and quiet hours', () => {
  const now = new Date(2026, 9, 18, 14, 40);
  const item = { id: 'meeting', title: '팀플 회의', kind: 'event', due: '2026-10-18T15:00', completed: false };
  const candidates = buildReminderCandidates({ classes: [], academics: [item, { ...item, id: 'done', completed: true }, { ...item, id: 'past', due: '2026-10-18T14:00' }], settings, now });
  assert.equal(candidates.length, 1); assert.match(candidates[0].body, /20분/);
  assert.equal(candidates[0].key, 'event:meeting:2026-10-18T15:00:30m');
  assert.equal(buildReminderCandidates({ classes: [], academics: [item], settings: { ...settings, notifications: false }, now }).length, 0);
  assert.equal(buildReminderCandidates({ classes: [], academics: [item], settings: { ...settings, quietStart: '14:00', quietEnd: '16:00', quietModeEnabled: true }, now }).length, 0);
});

test('startup deadline reminder lists remaining time once per computer session', () => {
  const now = new Date(2026, 8, 11, 9, 0);
  const candidate = buildStartupDeadlineCandidate({ now, settings, sessionKey: 'boot-123', academics: [
    { id: 'a', title: '공모전 보고서 작성', course: '', due: '2026-09-12T09:00', completed: 0 },
    { id: 'b', title: '그래프 과제', course: '알고리즘', due: '2026-09-14T09:00', completed: 0 }
  ] });
  assert.equal(candidate.key, 'deadline-start:boot-123');
  assert.match(candidate.body, /공모전 보고서 작성, 마감까지 1일/);
  assert.match(candidate.body, /알고리즘 그래프 과제, 마감까지 3일/);
  assert.equal(candidate.notificationItems.length, 2);
});

test('game nagging selects the closest incomplete deadline and uses time slots', () => {
  const now = new Date(2026, 8, 11, 12, 5);
  const academics = [
    { id: 'later', title: '두 번째 과제', course: '', kind: 'assignment', due: '2026-09-12T11:00', completed: 0 },
    { id: 'first', title: '중간고사', course: '게임수학', kind: 'exam', due: '2026-09-11T16:00', completed: 0 }
  ];
  const nag = buildGameNagCandidate({ academics, settings, game: { isGame: true }, now });
  assert.match(nag.key, /^game:first:/);
  assert.match(nag.body, /게임수학 중간고사/);
  assert.match(nag.body, /4시간/);
  assert.equal(buildGameNagCandidate({ academics, settings, game: { isGame: false }, now }), null);
  assert.match(buildGameNagCandidate({ academics, settings, game: { isGame: true }, now: new Date(2026, 8, 11, 2, 0) }).key, /^game:first:/);
});

test('routine reminders fire at the scheduled time and again after 30 minutes', () => {
  const routine = { id: 'stretch', title: '20분 스트레칭', category: 'exercise', days: [5], time: '20:00', active: 1, completedToday: 0 };
  const due = buildRoutineCandidates({ routines: [routine], settings, now: new Date(2026, 8, 11, 20, 5) });
  assert.equal(due.length, 1); assert.match(due[0].key, /:due$/); assert.match(due[0].body, /20분 스트레칭/);
  const late = buildRoutineCandidates({ routines: [routine], settings, now: new Date(2026, 8, 11, 20, 35) });
  assert.equal(late.length, 1); assert.match(late[0].key, /:30m$/); assert.match(late[0].body, /35분 지났어/);
  assert.equal(buildRoutineCandidates({ routines: [{ ...routine, completedToday: 1 }], settings, now: new Date(2026, 8, 11, 20, 5) }).length, 0);
  assert.equal(buildRoutineCandidates({ routines: [routine], settings, now: new Date(2026, 8, 11, 21, 1) }).length, 0);
});

test('daily health check follows accumulated computer use instead of a clock time', () => {
  const healthSettings = { ...settings, healthCheckReminder: true, healthCheckUsageMinutes: 180 };
  assert.equal(buildHealthCheckCandidate({ entry: null, settings: healthSettings, usageMinutes: 179, now: new Date(2026, 8, 11, 14, 0) }), null);
  const reminder = buildHealthCheckCandidate({ entry: null, settings: healthSettings, usageMinutes: 180, now: new Date(2026, 8, 11, 14, 1) });
  assert.match(reminder.key, /health-check:2026-09-11/); assert.match(reminder.body, /수면, 식사, 운동/);
  assert.equal(buildHealthCheckCandidate({ entry: { date: '2026-09-11' }, settings: healthSettings, usageMinutes: 240, now: new Date(2026, 8, 11, 16, 0) }), null);
});

test('casual ASA AI has at least 100 unique original samples and random usage milestones', () => {
  const casualSettings = { ...settings, name: '새누', casualNotifications: true };
  const now = new Date(2026, 8, 11, 14, 0);
  const thresholds = casualUsageThresholds('2026-09-11');
  assert.equal(RIN_CASUAL_LINES.length >= 100, true);
  assert.equal(new Set(RIN_CASUAL_LINES).size, RIN_CASUAL_LINES.length);
  assert.equal(thresholds.length, 10);
  assert.equal(thresholds.every((value, index) => index === 0 ? value >= 15 && value <= 30 : value - thresholds[index - 1] >= 25 && value - thresholds[index - 1] <= 45), true);
  assert.equal(buildCasualConversationCandidate({ settings: casualSettings, usageMinutes: thresholds[0] - 1, now }), null);
  const first = buildCasualConversationCandidate({ settings: casualSettings, usageMinutes: thresholds[0], now });
  const second = buildCasualConversationCandidate({ settings: casualSettings, usageMinutes: thresholds[1], now });
  assert.equal(first.key, 'casual:2026-09-11:1');
  assert.equal(second.key, 'casual:2026-09-11:2');
  assert.match(first.title, /^아사 ·/);
  assert.equal(buildCasualConversationCandidate({ settings: { ...casualSettings, casualNotifications: false }, usageMinutes: 300, now }), null);
});

test('casual ASA AI message is delivered during active use without repeating', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-casual-'));
  const store = new Store(join(dir, 'rin.sqlite'));
  const now = new Date(2026, 8, 11, 14, 0);
  const sent = [];
  try {
    store.saveSettings({ ...store.settings(), dailyBriefing: false, healthCheckReminder: false, eveningReview: false, casualNotifications: true });
    store.addActivity('2026-09-11', 'Code', 'study', casualUsageThresholds('2026-09-11')[0] * 60);
    const service = new ReminderService(store, { now: () => now, notify: async item => sent.push(item), detectGame: async () => ({ isGame: false, idleSeconds: 1 }) });
    await service.tick(); await service.tick();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].key, 'casual:2026-09-11:1');
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('away ASA AI uses original copy at spaced idle milestones', () => {
  const casualSettings = { ...settings, name: '새누', casualNotifications: true };
  const now = new Date(2026, 8, 11, 14, 0);
  const awaySince = '2026-09-11T04:55:00.000Z';
  assert.equal(RIN_AWAY_LINES.length >= 25, true);
  assert.equal(new Set(RIN_AWAY_LINES).size, RIN_AWAY_LINES.length);
  assert.deepEqual(AWAY_CASUAL_THRESHOLDS, [5, 20, 45, 90, 180]);
  assert.equal(buildAwayCasualCandidate({ settings: casualSettings, activity: { idleSeconds: 299 }, awaySince, now }), null);
  const first = buildAwayCasualCandidate({ settings: casualSettings, activity: { idleSeconds: 300 }, awaySince, now });
  const second = buildAwayCasualCandidate({ settings: casualSettings, activity: { idleSeconds: 20 * 60 }, awaySince, now });
  assert.equal(first.key, `away:${awaySince}:1`);
  assert.equal(second.key, `away:${awaySince}:2`);
  assert.match(first.title, /^아사 ·/);
  assert.equal(buildAwayCasualCandidate({ settings: { ...casualSettings, casualNotifications: false }, activity: { idleSeconds: 300 }, awaySince, now }), null);
});

test('daily briefing summarizes classes, urgent work and e-Class status', () => {
  const now = new Date(2026, 8, 11, 8, 0);
  const briefing = buildDailyBriefing({
    now, settings,
    classes: [{ id: 'c', name: '알고리즘', day: 5, start: '10:00', location: 'E동' }],
    academics: [{ id: 'a', title: '코드 실습', kind: 'assignment', due: '2026-09-12T08:00', completed: 0 }],
    routines: [{ id: 'r', title: '아침 식사', category: 'meal', days: [5], time: '08:30', active: 1, completedToday: 0 }],
    eclass: { lastSync: '2026-09-11T07:30:00.000Z', missing: 2 }
  });
  assert.match(briefing.key, /briefing:2026-09-11/);
  assert.match(briefing.body, /10:00 알고리즘/);
  assert.match(briefing.body, /코드 실습/);
  assert.match(briefing.body, /08:30 아침 식사/);
  assert.match(briefing.body, /e-Class도 오늘 확인/);
  assert.match(briefing.body, /사라진 일정 2개/);
  assert.equal(briefing.notificationItems.length, 5);
  assert.equal(briefing.notificationItems.every(item => item.length < 80), true);
});

test('deadline reminder sends once per computer session and again after a new boot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-reminder-'));
  const store = new Store(join(dir, 'rin.sqlite'));
  const now = new Date(2026, 8, 11, 9, 0);
  const sent = [];
  try {
    store.saveSettings({ ...store.settings(), dailyBriefing: false });
    store.saveAcademic({ title: '보고서', course: '게임수학', kind: 'assignment', due: '2026-09-11T11:00', notes: '', completed: false }, 'item-1');
    const service = new ReminderService(store, { now: () => now, notify: async item => sent.push(item), detectGame: async () => ({ isGame: false }), sessionKey: 'boot-once' });
    await service.tick();
    await service.tick();
    assert.equal(sent.length, 1);
    assert.equal(store.notificationSent(sent[0].key), true);
    const nextBoot = new ReminderService(store, { now: () => now, notify: async item => sent.push(item), detectGame: async () => ({ isGame: false }), sessionKey: 'boot-next' });
    await nextBoot.tick();
    assert.equal(sent.length, 2);
    assert.equal(sent[1].key, 'deadline-start:boot-next');
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('reminder service queues regular and away notices together without repeats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-reminder-presence-'));
  const store = new Store(join(dir, 'rin.sqlite'));
  const now = new Date(2026, 8, 11, 9, 0);
  const sent = [];
  let idleSeconds = 900;
  try {
    store.saveSettings({ ...store.settings(), dailyBriefing: false });
    store.saveAcademic({ title: '보고서', course: '게임수학', kind: 'assignment', due: '2026-09-11T11:00', notes: '', completed: false }, 'item-away');
    const service = new ReminderService(store, { now: () => now, notify: async item => sent.push(item), detectGame: async () => ({ isGame: false, idleSeconds }), sessionKey: 'boot-away' });
    await service.tick();
    assert.equal(sent.length, 2);
    assert.equal(sent[0].key, 'deadline-start:boot-away');
    assert.match(sent[1].key, /^away:/);
    assert.equal(store.notificationSent('deadline-start:boot-away'), true);
    assert.equal(store.integration('reminder_presence').away, true);
    await service.tick();
    assert.equal(sent.length, 2);
    idleSeconds = 2;
    await service.tick();
    assert.equal(sent.length, 2);
    assert.equal(store.integration('reminder_presence').away, false);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('daily briefing covers the startup deadline and preserves other simultaneous reminders', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-briefing-reminder-'));
  const store = new Store(join(dir, 'rin.sqlite'));
  const now = new Date(2026, 8, 11, 8, 0);
  const sent = [];
  try {
    store.saveAcademic({ title: '보고서', course: '', kind: 'assignment', due: '2026-09-12T08:00', notes: '', completed: false }, 'item-briefing');
    store.saveRoutine({ title: '아침 식사', category: 'meal', days: [5], time: '08:00', notes: '', active: true }, 'routine-briefing');
    const service = new ReminderService(store, { now: () => now, notify: async item => sent.push(item), detectGame: async () => ({ isGame: false, idleSeconds: 1 }), briefingWaitMs: 0, sessionKey: 'boot-briefing' });
    await service.tick();
    assert.equal(sent.filter(item => item.key.startsWith('briefing:')).length, 4);
    assert.match(sent[0].title, /1\/4$/);
    assert.equal(store.notificationSent('deadline-start:boot-briefing'), true);
    assert.equal(store.notificationSent('routine:routine-briefing:2026-09-11:due'), false);
    await service.tick();
    assert.equal(sent.length, 5);
    assert.match(sent[4].key, /^routine:/);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('daily briefing is sent and stored only once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-briefing-'));
  const store = new Store(join(dir, 'rin.sqlite'));
  const now = new Date(2026, 8, 11, 8, 0);
  const sent = [];
  try {
    const service = new ReminderService(store, { now: () => now, notify: async item => sent.push(item), detectGame: async () => ({ isGame: false }), briefingWaitMs: 0 });
    await service.tick(); await service.tick();
    assert.equal(sent.length, 3);
    assert.equal(sent.every(item => item.key.startsWith('briefing:')), true);
    assert.equal(sent.every(item => store.integration('briefing').body.includes(item.body)), true);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('daily briefing waits for stale e-Class data and falls back after timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-briefing-wait-'));
  const store = new Store(join(dir, 'rin.sqlite'));
  let now = new Date(2026, 8, 11, 8, 0);
  const sent = [];
  try {
    store.saveIntegration('eclass', { lastSync: '2026-09-10T08:00:00.000Z', received: 2 });
    const service = new ReminderService(store, { now: () => now, notify: async item => sent.push(item), detectGame: async () => ({ isGame: false }), briefingWaitMs: 5 * 60_000 });
    await service.tick(); assert.equal(sent.length, 0);
    now = new Date(2026, 8, 11, 8, 6);
    await service.tick(); assert.equal(sent.length, 3);
    assert.equal(sent.some(item => /저장된 일정/.test(item.body)), true);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('active focus suppresses academic reminders until the timer ends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-focus-'));
  const store = new Store(join(dir, 'rin.sqlite'));
  const now = new Date(2026, 8, 11, 9, 0);
  const sent = [];
  try {
    store.saveSettings({ ...store.settings(), dailyBriefing: false });
    store.saveAcademic({ title: '보고서', course: '', kind: 'assignment', due: '2026-09-11T11:00', notes: '', completed: false }, 'focus-item');
    store.saveIntegration('reminder_control', { snoozes: {}, focus: { itemId: 'focus-item', title: '보고서', started: '2026-09-11T08:55:00.000', ends: '2026-09-11T09:25:00.000' } });
    const service = new ReminderService(store, { now: () => now, notify: async item => sent.push(item), detectGame: async () => ({ isGame: true }) });
    await service.tick();
    assert.equal(sent.length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('evening review popup is sent and stored only once per day', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-evening-'));
  const store = new Store(join(dir, 'rin.sqlite'));
  const now = new Date(2026, 8, 12, 23, 5);
  const sent = [];
  try {
    store.saveSettings({ ...store.settings(), dailyBriefing: false, healthCheckReminder: false, eveningReview: true, eveningReviewUsageMinutes: 240 });
    store.addActivity('2026-09-12', 'Code', 'study', 240 * 60);
    const service = new ReminderService(store, { now: () => now, notify: async item => sent.push(item), detectGame: async () => ({ isGame: false }) });
    await service.tick(); await service.tick();
    assert.equal(sent.length, 1); assert.equal(sent[0].display, 'daily-review');
    assert.equal(store.integration('evening_review').date, '2026-09-12');
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
