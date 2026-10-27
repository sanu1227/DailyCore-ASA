import test from 'node:test';
import { codexResult, fakeCodex } from './helpers/codex.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { createApp } from '../app/server.mjs';
import { prepareScheduleChange } from '../app/schedule-changes.mjs';
import { projectWeeklyItem, weeklyOccurrenceInWeek } from '../app/schedule-intent.mjs';
import { ReminderService } from '../app/reminders.mjs';

const now = new Date(2026, 9, 19, 10);
const meeting = { id: 'weekly', title: '팀플 회의', course: '', kind: 'event', due: '2026-10-12T15:00', notes: '', completed: false, repeat_weekly: 1 };
const original = '2026-10-19T15:00';
const item = projectWeeklyItem(meeting, [], now);
const recent = [{ schedule_action: { ...item, itemId: item.id } }];
const resolve = (message, extra = {}) => prepareScheduleChange({ message, items: [item], recent, now, ...extra });

test('single-occurrence phrases resolve this calendar week and never rewrite the series', () => {
  for (const message of ['이번 주 회의만 취소해줘', '그 회의 이번 주만 취소해줘', '회의 이번 회차만 취소해줘']) {
    const result = resolve(message);
    assert.equal(result.action, 'cancel', message);
    assert.equal(result.scope, 'occurrence'); assert.equal(result.original_due, original);
  }
  const change = resolve('이번 주만 오후 4시로 바꿔줘');
  assert.equal(change.action, 'update'); assert.equal(change.due, '2026-10-19T16:00'); assert.equal(change.original_due, original);
  assert.equal(resolve('이번 주만 오후 4시로 바꿔줘', { recent: [] }).action, 'none');
  const scope = resolve('그 회의 오후 4시로 바꿔줘');
  assert.equal(resolve('이번 회차', { draft: scope.draft }).due, change.due);
  assert.equal(resolve('전체', { draft: scope.draft }).scope, undefined);
  assert.equal(resolve('그 회의 반복 전체 이번 주만 취소해줘').action, 'none');
  const moved = resolve('그 회의 이번 회차만 다음 주 화요일 오후 4시로 바꿔줘');
  assert.equal(moved.original_due, original); assert.equal(moved.due, '2026-10-27T16:00');
  assert.equal(resolve('이번 주 회의만 취소해줘', { items: [{ ...meeting, repeat_weekly: 0, due: '2026-10-26T15:00' }] }).action, 'none');
  const sunday = new Date(2026, 9, 25, 10);
  const past = resolve('이번 주 회의만 취소해줘', { now: sunday, items: [projectWeeklyItem(meeting, [], sunday)] });
  assert.equal(past.action, 'none'); assert.match(past.message, /이미 지났어/);
  assert.equal(weeklyOccurrenceInWeek('2026-10-26T15:00', sunday), null);
  assert.equal(weeklyOccurrenceInWeek('2026-12-28T15:00', new Date(2027, 0, 3)), '2026-12-28T15:00');
});

test('occurrence clarification retains scope, date and stable target with safe stale detection', () => {
  const ambiguous = resolve('이번 주만 4시로 바꿔줘');
  assert.match(ambiguous.message, /오전이야 오후야/);
  assert.equal(ambiguous.draft.fields.originalDue, original);
  assert.equal(resolve('오후', { draft: ambiguous.draft }).due, '2026-10-19T16:00');
  const other = { ...item, id: 'other', title: '회사 회의' };
  const choices = resolve('이번 주 회의만 취소해줘', { items: [item, other], recent: [] });
  assert.equal(choices.draft.candidateIds.length, 2);
  assert.equal(resolve('2번', { items: [other, item], draft: choices.draft }).itemId, 'other');
  const changed = projectWeeklyItem(meeting, [{ original_due: original, due: '2026-10-19T17:00', cancelled: 0 }], now);
  assert.match(resolve('오후', { items: [changed], draft: ambiguous.draft }).message, /그사이 바뀌었어/);
  const missing = resolve('이번 주 회의만 바꿔줘');
  assert.equal(resolve('오후 4시', { draft: missing.draft }).scope, 'occurrence');
  assert.equal(resolve('이번 주만 오전 9시로 바꿔줘').action, 'none');
  assert.equal(resolve('이번 주 회의만 취소하지 마'), null); // ordinary chat, not a mutation
});

test('exception storage survives restart, supports cross-week moves, cancellation and whole-rule changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-occurrences-')), path = join(dir, 'rin.sqlite');
  let store = new Store(path);
  try {
    const id = store.saveAcademic(meeting);
    store.saveAcademicOccurrence(id, original, '2026-10-19T16:00');
    let value = store.academics(now)[0];
    assert.equal(value.due, '2026-10-19T16:00'); assert.equal(value.series_due, meeting.due);
    assert.equal(store.academics(new Date(2026, 9, 19, 15, 30))[0].due, value.due);
    assert.equal(store.academics(new Date(2026, 9, 20))[0].due, '2026-10-26T15:00');
    store.saveAcademicOccurrence(id, original, value.due, true);
    store.close(); store = new Store(path);
    assert.equal(store.academics(now)[0].due, '2026-10-26T15:00');
    assert.equal(store.cancelledAcademics().length, 0);
    assert.equal(store.db.prepare('SELECT due FROM academic_items WHERE id=?').get(id).due, meeting.due);
    store.saveAcademicOccurrence(id, original, '2026-10-28T16:00');
    assert.equal(store.academics(new Date(2026, 9, 20))[0].due, '2026-10-26T15:00');
    assert.equal(store.academics(new Date(2026, 9, 27))[0].due, '2026-10-28T16:00');
    store.saveAcademicOccurrence(id, '2026-11-02T15:00', '2026-10-30T14:00');
    assert.equal(store.academics(new Date(2026, 9, 29))[0].due, '2026-10-30T14:00');
    assert.equal(store.academics(new Date(2026, 10, 1))[0].due, '2026-11-09T15:00');
    store.cancelAcademic(id); store.restoreAcademic(id);
    assert.equal(store.academicExceptions(id).length, 2);
    store.saveAcademic({ ...meeting, title: '새 회의', due: '2026-10-26T15:00' }, id);
    assert.equal(store.academicExceptions(id).length, 2);
    store.saveAcademic({ ...meeting, due: '2026-10-20T17:00' }, id);
    assert.equal(store.academicExceptions(id).length, 0);
    store.saveAcademicOccurrence(id, '2026-10-20T17:00', '2026-10-20T18:00');
    store.removeAcademic(id); assert.equal(store.academicExceptions(id).length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('changed and cancelled occurrence references remain attached to their original identity', () => {
  const exception = { original_due: original, due: '2026-10-20T16:00', cancelled: 0 };
  let changed = projectWeeklyItem(meeting, [exception], now);
  let context = [{ schedule_action: { ...changed, itemId: meeting.id, scope: 'occurrence', original_due: original } }];
  let result = resolve('이번 주만 오후 5시로 바꿔줘', { items: [changed], recent: context });
  assert.equal(result.original_due, original); assert.equal(result.due, '2026-10-20T17:00');
  changed = projectWeeklyItem(meeting, [{ ...exception, cancelled: 1 }], now);
  result = resolve('그 회의 다시 잡혔어', { items: [changed], recent: context });
  assert.equal(result.scope, 'occurrence'); assert.equal(result.action, 'restore'); assert.equal(result.due, exception.due);
  assert.equal(resolve('이번 주 회의만 취소해줘', { items: [changed] }).original_due, original);
  assert.equal(resolve('이번 주 회의만 오후 5시로 바꿔줘', { items: [changed] }).action, 'none');
});

test('chat stores exceptions and receipts atomically, supports undo and generates replies with AI', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const dir = mkdtempSync(join(tmpdir(), 'rin-occurrence-chat-'));
  const app = createApp({ dataPath: join(dir, 'rin.sqlite'), codexClient: fakeCodex(async ({ schema }) => { assert.equal(schema, undefined); return codexResult('AI가 작성한 답변.'); }) });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (body, path = '/api/chat', status = 200) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token }, body: JSON.stringify(body) });
    assert.equal(response.status, status); return response.json();
  };
  try {
    const id = app.store.saveAcademic(meeting);
    app.store.addPair('회의 등록', '등록했어', { action: 'add', itemId: id, title: meeting.title, due: original, repeat_weekly: 1 });
    let state = await post({ text: '이번 주만 오후 4시로 바꿔줘' });
    assert.equal(state.academics[0].due, '2026-10-19T16:00');
    assert.equal(state.academics[0].series_due, meeting.due);
    assert.equal(state.messages.at(-1).schedule_action.original_due, original);
    const addPair = app.store.addPair;
    app.store.addPair = () => { throw new Error('receipt failure'); };
    await post({ text: '이번 주 회의만 취소해줘' }, '/api/chat', 500);
    assert.equal(app.store.academicExceptions(id)[0].cancelled, 0);
    await post({ text: '그 회의 반복 전체 오후 5시로 바꿔줘' }, '/api/chat', 500);
    assert.equal(app.store.academicExceptions(id).length, 1);
    assert.equal(app.store.academics()[0].series_due, meeting.due);
    app.store.addPair = addPair;
    state = await post({ text: '이번 주 회의만 취소해줘' });
    assert.equal(state.academics[0].due, '2026-10-26T15:00');
    assert.equal(state.cancelledAcademicIds.length, 0);
    state = await post({ text: '그 회의 다시 잡혔어' });
    assert.equal(state.academics[0].due, '2026-10-19T16:00');
    await post({ text: '이번 주 회의만 취소해줘' });
    state = await post({ id, originalDue: original }, '/api/academic/restore');
    assert.equal(state.academics[0].due, '2026-10-19T16:00');
    await post({ id, originalDue: '2026-10-26T15:00' }, '/api/academic/restore', 404);
    state = await post({ text: '그 회의 반복 전체 오후 5시로 바꿔줘' });
    assert.equal(state.academics[0].due, '2026-10-19T17:00'); assert.equal(state.academics[0].exceptions.length, 0);
    assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
    assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM academic_items').get().n, 1);
  } finally { await new Promise(done => app.server.close(done)); rmSync(dir, { recursive: true }); }
});

test('reminders skip cancelled and old times, notify moved occurrence and resume the original rule', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-occurrence-alert-'));
  const store = new Store(join(dir, 'rin.sqlite')), sent = [];
  let current = new Date(2026, 9, 19, 14, 45);
  try {
    store.saveSettings({ ...store.settings(), dailyBriefing: false, casualNotifications: false, gameNagging: false });
    const id = store.saveAcademic(meeting);
    store.saveAcademicOccurrence(id, original, '2026-10-19T16:00');
    const service = new ReminderService(store, { now: () => current, notify: async value => sent.push(value), detectGame: async () => ({ isGame: false }) });
    const eventCount = () => sent.filter(value => value.key.startsWith('event:')).length;
    await service.tick(); assert.equal(eventCount(), 0);
    current = new Date(2026, 9, 19, 15, 45); await service.tick(); await service.tick(); assert.equal(eventCount(), 1);
    store.saveAcademicOccurrence(id, '2026-10-26T15:00', '2026-10-26T15:00', true);
    current = new Date(2026, 9, 26, 14, 45); await service.tick(); assert.equal(eventCount(), 1);
    current = new Date(2026, 10, 2, 14, 45); await service.tick(); assert.equal(eventCount(), 2);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
