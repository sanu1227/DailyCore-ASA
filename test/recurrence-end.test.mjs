import test from 'node:test';
import { codexResult, fakeCodex } from './helpers/codex.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { createApp } from '../app/server.mjs';
import { ReminderService } from '../app/reminders.mjs';
import { recurrenceEnd, recurrenceWhen, projectRecurringItem, validDateKey, cleanScheduleTitle } from '../app/schedule-intent.mjs';
import { prepareScheduleChange } from '../app/schedule-changes.mjs';

const now = new Date(2026, 9, 19, 10);
const meeting = { id: 'meeting', title: '회의', kind: 'event', course: '', notes: '', completed: false, due: '2026-10-19T15:00', recurrence: 'weekly', repeat_until: '2026-12-31' };
const change = (message, item = meeting, extra = {}) => prepareScheduleChange({ message, items: [item], recent: [{ schedule_action: { itemId: item.id, title: item.title } }], now, ...extra });
const fixture = async (t, run) => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const dir = mkdtempSync(join(tmpdir(), 'rin-end-chat-'));
  const app = createApp({ dataPath: join(dir, 'rin.sqlite'), codexClient: fakeCodex(async ({ schema }) => codexResult(schema ? { action: 'add', title: '회의', kind: 'event', course: '', due: '2099-01-01T01:00' } : 'AI가 작성한 답변.')) });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const post = async (body, path = '/api/chat', status = 200) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token }, body: JSON.stringify(body) });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result)); return result;
  };
  try { await run(app.store, post); } finally { await new Promise(done => app.server.close(done)); rmSync(dir, { recursive: true }); }
};

test('end phrases are inclusive calendar dates, separate from start date and title', () => {
  const sentence = '12월 말까지만 매주 월요일 오후 3시에 회의 있어';
  const end = recurrenceEnd(sentence, now);
  assert.equal(end.value, '2026-12-31'); assert.equal(end.invalid, false);
  assert.equal(recurrenceWhen(end.text, 'weekly', now).date, '2026-10-19');
  assert.equal(cleanScheduleTitle(sentence), '에 회의 있어');
  for (const [phrase, expected] of [
    ['11월 30일까지', '2026-11-30'], ['2026-12-31까지', '2026-12-31'], ['이번 달 말까지만', '2026-10-31'],
    ['다음 달까지', '2026-11-30'], ['다다음 달 15일까지', '2026-12-15'], ['올해까지만', '2026-12-31'],
    ['내년 말까지', '2027-12-31'], ['2028년 2월 말까지', '2028-02-29'], ['이번 주까지만', '2026-10-25'],
    ['다음 주 금요일까지', '2026-10-30'], ['오늘까지만', '2026-10-19'], ['종료일을 내년 1월 말로', '2027-01-31']
  ]) assert.equal(recurrenceEnd(phrase, now).value, expected, phrase);
  for (const phrase of ['2027년 2월 29일까지', '2026년 2월 30일까지', '13월까지', '2026-10-18까지', '11월까지 12월까지', '올해까지 종료일 없이']) assert.equal(recurrenceEnd(phrase, now).invalid, true, phrase);
  for (const phrase of ['종료일 없애줘', '종료일 취소해줘', '종료일만 지워줘', '종료일 없이', '기한 없이', '계속 반복해줘']) assert.deepEqual([recurrenceEnd(phrase, now).provided, recurrenceEnd(phrase, now).value], [true, null], phrase);
  assert.equal(recurrenceEnd('내년 1월 말', now, true).value, '2027-01-31');
  assert.equal(validDateKey('2026-02-29'), false);
});

test('end updates, clear, inspect and clarification preserve series identity and do not mutate on uncertainty', () => {
  for (const phrase of ['그 회의 내년 1월 말까지 연장해줘', '회의 종료일을 내년 1월 말로 바꿔줘', '그 회의 내년 1월 말까지만 해줘']) {
    const result = change(phrase); assert.equal(result.action, 'update', phrase); assert.equal(result.repeat_until, '2027-01-31', phrase); assert.equal(result.due, meeting.due);
  }
  for (const phrase of ['그 회의 종료일 없애줘', '그 회의 종료일 취소해줘', '그 회의 계속 반복해줘']) { const result = change(phrase); assert.equal(result.action, 'update', phrase); assert.equal(result.repeat_until, null); }
  for (const phrase of ['그 회의 언제까지야?', '그 회의 종료일 알려줘']) { const result = change(phrase); assert.equal(result.action, 'none'); assert.match(result.message, /2026-12-31/); }
  for (const phrase of ['그 회의 종료일 없애지 마', '그 회의 내년까지 연장하지 마', '그 회의 내년까지 연장할까?', '만약 그 회의 내년까지 연장하면']) assert.equal(change(phrase), null, phrase);
  const pending = change('그 회의 종료일 바꿔줘'); assert.equal(pending.draft.awaitEnd, true);
  const result = change('내년 1월 말', meeting, { draft: pending.draft }); assert.equal(result.repeat_until, '2027-01-31');
  assert.equal(change('이번 회차만 내년까지 연장해줘').action, 'none');
});

test('all frequencies stop after final date, retain their anchor and recover exceptions after extension', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-end-store-')), path = join(dir, 'rin.sqlite');
  let store = new Store(path);
  try {
    for (const recurrence of ['daily', 'weekly', 'biweekly', 'monthly']) store.saveAcademic({ ...meeting, recurrence, monthly_day: recurrence === 'monthly' ? 19 : 0, repeat_until: '2026-11-19' });
    assert.equal(store.academics(new Date(2026, 10, 19, 14)).length, 2);
    assert.equal(store.academics(new Date(2026, 10, 20)).length, 0); assert.equal(store.endedAcademics(new Date(2026, 10, 20)).length, 4);
    const item = store.academics(now).find(row => row.recurrence === 'weekly');
    store.saveAcademicOccurrence(item.id, '2026-11-02T15:00', '2026-11-03T16:00');
    assert.throws(() => store.saveAcademicOccurrence(item.id, '2026-11-23T15:00', '2026-11-18T16:00'));
    assert.throws(() => store.saveAcademicOccurrence(item.id, '2026-11-16T15:00', '2026-11-20T16:00'));
    store.saveAcademic({ ...item, repeat_until: '2026-10-31' }, item.id);
    assert.equal(store.academicExceptions(item.id).length, 1);
    assert.equal(store.academics(new Date(2026, 10, 2)).some(row => row.id === item.id), false);
    store.close(); store = new Store(path);
    assert.equal(store.endedAcademics(new Date(2026, 10, 20)).length, 4);
    store.saveAcademic({ ...item, repeat_until: '2026-12-31' }, item.id);
    const restored = store.academics(new Date(2026, 10, 2)).find(row => row.id === item.id);
    assert.equal(restored.due, '2026-11-03T16:00'); assert.equal(restored.series_due, meeting.due);
    assert.throws(() => store.saveAcademic({ ...item, repeat_until: '2026-02-30' }, item.id));
    assert.equal(projectRecurringItem({ ...meeting, repeat_until: '2026-10-19' }, [{ original_due: meeting.due, due: '2026-10-20T15:00', cancelled: false }], now).ended, true);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('chat adds all bounded frequencies, then extends, clears and inspects without a model choosing dates', async t => fixture(t, async (store, post) => {
  for (const phrase of ['12월 말까지만 매주 월요일 오후 3시에 회의 있어', '올해까지만 매일 오후 3시 회의 있어', '2026년 12월 31일까지 격주 월요일 오후 3시 회의 있어', '12월 말까지 매달 19일 오후 3시 회의 있어']) {
    const state = await post({ text: phrase }); assert.equal(state.messages.at(-1).schedule_action?.action, 'add', state.messages.at(-1).content);
    const receipt = state.messages.at(-1).schedule_action; assert.equal(receipt.repeat_until, '2026-12-31'); assert.equal(receipt.due, meeting.due);
  }
  const id = store.messages().at(-1).schedule_action.itemId;
  await post({ text: '그 회의 내년 1월 말까지 연장해줘' }); assert.equal(store.academics().find(row => row.id === id).repeat_until, '2027-01-31');
  const state = await post({ text: '그 회의 언제까지야?' }); assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
  await post({ text: '그 회의 종료일 취소해줘' }); assert.equal(store.academics().find(row => row.id === id).repeat_until, null); assert.equal(store.cancelledAcademics().length, 0);
  await post({ text: '그 회의 종료일 바꿔줘' }); await post({ text: '다음 달 말' });
  assert.equal(store.academics().find(row => row.id === id).repeat_until, '2026-11-30');
  const before = store.academics(); await post({ text: '그 회의 내년까지 연장하지 마' }); assert.deepEqual(store.academics(), before);
}));

test('registration remembers end while clarifying time or invalid end, rejects unsupported ranges safely', async t => fixture(t, async (store, post) => {
  await post({ text: '12월 말까지만 매주 회의 있어' });
  let state = await post({ text: '월요일 오후 3시' }); assert.equal(state.academics[0].repeat_until, '2026-12-31');
  await post({ text: '2027년 2월 30일까지 매일 오후 4시 회의 있어' });
  assert.equal(store.academics().length, 1);
  state = await post({ text: '2027년 2월 말' }); assert.equal(state.academics.find(row => row.recurrence === 'daily')?.repeat_until, '2027-02-28');
  await post({ text: '오늘까지만 매달 31일 오후 3시 회의 있어' }); assert.equal(store.academics().length, 2);
  state = await post({ text: '종료일 없이' }); assert.equal(state.academics.find(row => row.recurrence === 'monthly')?.repeat_until, null);
  await post({ text: '매주 월요일 겨울까지만 오후 3시 회의 있어' }); assert.equal(store.academics().length, 3);
}));

test('expired end can be extended without a new row; canceled restore needs a new end; API validates bounds', async t => fixture(t, async (store, post) => {
  const id = store.saveAcademic({ ...meeting, due: '2026-10-12T15:00', repeat_until: '2026-10-12' });
  let state = await post({ text: '회의 종료일을 올해 말까지 연장해줘' }); assert.equal(state.academics[0].id, id); assert.equal(state.endedAcademics.length, 0);
  assert.equal(state.academics[0].series_due, '2026-10-12T15:00');
  await post({ ...meeting, id, repeatUntil: '2026-02-30' }, '/api/academic', 400);
  await post({ ...meeting, id, repeatUntil: '2026-10-01' }, '/api/academic', 400);
  await post({ ...meeting, id: undefined, recurrence: 'none', repeatUntil: '2026-12-31' }, '/api/academic', 400);
  await post({ ...meeting, id, repeatUntil: null }, '/api/academic'); assert.equal(store.academics()[0].repeat_until, null);
  store.saveAcademic({ ...meeting, due: '2026-10-12T15:00', repeat_until: '2026-10-12' }, id); store.cancelAcademic(id);
  await post({ id }, '/api/academic/restore', 400);
  state = await post({ text: '회의 반복 전체 다시 잡혔어' }); assert.equal(store.cancelledAcademics().length, 1); assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
  state = await post({ text: '내년 1월 말까지' }); assert.equal(state.academics[0].id, id); assert.equal(store.cancelledAcademics().length, 0); assert.equal(state.academics[0].repeat_until, '2027-01-31');
}));

test('last-day notification fires once; next occurrence and reopened expired records never alert', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-end-alert-')), path = join(dir, 'rin.sqlite');
  let store = new Store(path), current = new Date(2026, 11, 31, 14, 45);
  const sent = [], options = { now: () => current, notify: async value => sent.push(value), detectGame: async () => ({ isGame: false }) };
  try {
    store.saveSettings({ ...store.settings(), dailyBriefing: false, casualNotifications: false, gameNagging: false });
    store.saveAcademic({ ...meeting, recurrence: 'daily' });
    let service = new ReminderService(store, options); await service.tick(); await service.tick();
    assert.equal(sent.filter(row => row.key.startsWith('event:')).length, 1);
    current = new Date(2027, 0, 1, 14, 45); await service.tick(); assert.equal(store.academics(current).length, 0);
    store.close(); store = new Store(path); service = new ReminderService(store, options); await service.tick();
    assert.equal(sent.filter(row => row.key.startsWith('event:')).length, 1); assert.equal(store.endedAcademics(current).length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('final canceled occurrence can be restored by button or chat, but never past a shortened limit', async t => fixture(t, async (store, post) => {
  let state = await post({ text: '오늘까지만 매일 오후 3시 회의 있어' });
  const id = state.academics[0].id;
  state = await post({ text: '이번 회차만 취소해줘' });
  assert.equal(state.academics.length, 0); assert.equal(state.endedAcademics[0].id, id);
  state = await post({ id, originalDue: meeting.due }, '/api/academic/restore'); assert.equal(state.academics[0].id, id);
  await post({ text: '이번 회차만 취소해줘' });
  state = await post({ text: '그 회의 다시 잡혔어' }); assert.equal(state.academics[0].id, id); assert.equal(state.messages.at(-1).schedule_action.scope, 'occurrence');
  await post({ text: '그 회의 종료일을 올해까지 연장해줘' });
  store.saveAcademicOccurrence(id, '2026-10-20T15:00', '2026-10-20T15:00', true);
  await post({ text: '그 회의 오늘까지만 해줘' });
  await post({ id, originalDue: '2026-10-20T15:00' }, '/api/academic/restore', 400);
  const before = store.academics(); state = await post({ text: '그 회의 이번 회차만 내일 오후 4시로 바꿔줘' });
  assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.'); assert.deepEqual(store.academics(), before);
}));

test('ambiguous end changes retain chosen ID; stale choices and transaction failures do not partially change schedules', async t => fixture(t, async (store, post) => {
  const first = store.saveAcademic({ ...meeting, title: '팀 회의' });
  const second = store.saveAcademic({ ...meeting, title: '주간 회의', due: '2026-10-20T15:00' });
  let state = await post({ text: '회의 종료일을 내년 말까지 연장해줘' }); assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
  state = await post({ text: '2번' }); assert.equal(state.messages.at(-1).schedule_action.itemId, second);
  assert.equal(store.academics().find(row => row.id === first).repeat_until, '2026-12-31');
  await post({ text: '회의 종료일을 다음 달까지 바꿔줘' });
  store.saveAcademic({ ...meeting, title: '주간 회의', due: '2026-10-20T15:00', repeat_until: '2027-01-31' }, second);
  state = await post({ text: '2번' }); assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
  store.db.exec("CREATE TRIGGER fail_end_receipt BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  const before = store.academics(), messages = store.messages().length;
  await post({ text: '팀 회의 종료일 없애줘' }, '/api/chat', 500);
  assert.deepEqual(store.academics(), before); assert.equal(store.messages().length, messages);
}));

test('legacy schema gets no end by default; end-only edits preserve biweekly phase and monthly clamp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-end-migrate-')), path = join(dir, 'rin.sqlite'); let store = new Store(path);
  try {
    const id = store.saveAcademic({ ...meeting, recurrence: 'biweekly' });
    store.saveAcademicOccurrence(id, meeting.due, '2026-10-20T16:00');
    store.db.exec('ALTER TABLE academic_items DROP COLUMN repeat_until'); store.close(); store = new Store(path);
    const row = store.academics(now)[0]; assert.equal(row.repeat_until, null); assert.equal(row.exceptions.length, 1);
    store.saveAcademic({ ...row, due: '2026-11-02T15:00', repeat_until: '2026-11-02' }, id);
    assert.equal(store.academics(new Date(2026, 10, 2, 14))[0].series_due, meeting.due);
    assert.equal(store.academics(new Date(2026, 10, 2, 16)).length, 0);
    const monthly = { ...meeting, due: '2027-01-31T15:00', recurrence: 'monthly', monthly_day: 31, repeat_until: '2027-02-28' };
    assert.equal(projectRecurringItem(monthly, [], new Date(2027, 1, 28, 14)).due, '2027-02-28T15:00');
    assert.equal(projectRecurringItem(monthly, [], new Date(2027, 1, 28, 16)).ended, true);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('new unbounded registration and API range errors do not select or overwrite an existing series', async t => fixture(t, async (store, post) => {
  let state = await post({ text: '종료일 없이 매주 월요일 오후 3시 회의 있어' });
  assert.equal(state.academics[0].repeat_until, null); const id = state.academics[0].id;
  await post({ ...meeting, id: undefined, due: '2026-12-01T15:00', repeatUntil: '2026-11-30' }, '/api/academic', 400);
  const futureId = store.saveAcademic({ ...meeting, due: '2026-12-07T15:00' });
  await post({ ...meeting, id: futureId, due: '2026-12-14T15:00', repeatUntil: '2026-11-30' }, '/api/academic', 400);
  assert.equal(store.academics().find(row => row.id === id).repeat_until, null);
  state = await post({ text: '그 회의 반복 전체 취소해줘' });
  assert.equal(state.cancelledAcademicIds.includes(id), true);
}));
