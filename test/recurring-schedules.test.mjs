import test from 'node:test';
import { codexResult, fakeCodex } from './helpers/codex.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { createApp } from '../app/server.mjs';
import { nextRecurringDue, projectRecurringItem, recurrenceFromText, recurrenceProblem, recurrenceWhen, cleanScheduleTitle, sameRecurrenceRule } from '../app/schedule-intent.mjs';
import { prepareScheduleChange } from '../app/schedule-changes.mjs';
import { ReminderService } from '../app/reminders.mjs';

const now = new Date(2026, 9, 19, 10);
const meeting = { id: 'meeting', title: '회의', course: '', notes: '', kind: 'event', completed: false, due: '2026-10-19T15:00' };
const change = (message, item, extra = {}) => prepareScheduleChange({ message, items: [item], recent: [{ schedule_action: { itemId: item.id, title: item.title } }], now, ...extra });

test('daily, biweekly and monthly calculation keeps local time, phase and requested month day', () => {
  assert.equal(nextRecurringDue('2026-10-18T09:00', 'daily', now), '2026-10-20T09:00');
  assert.equal(nextRecurringDue('2026-10-19T15:00', 'biweekly', new Date(2026, 9, 26)), '2026-11-02T15:00');
  assert.equal(nextRecurringDue('2026-10-19T15:00', 'biweekly', new Date(2027, 0, 1)), '2027-01-11T15:00');
  for (const [date, expected] of [['2027-02-01', '2027-02-28'], ['2027-03-01', '2027-03-31'], ['2027-04-01', '2027-04-30'], ['2028-02-01', '2028-02-29']]) {
    assert.equal(nextRecurringDue('2027-01-31T15:00', 'monthly', new Date(`${date}T10:00`), 31), `${expected}T15:00`);
  }
  assert.equal(nextRecurringDue('2027-02-28T15:00', 'monthly', new Date(2027, 2, 1), 31), '2027-03-31T15:00');
  assert.equal(nextRecurringDue('2026-12-31T15:00', 'monthly', new Date(2027, 0, 1), 31), '2027-01-31T15:00');
  assert.equal(sameRecurrenceRule({ ...meeting, recurrence: 'biweekly' }, { ...meeting, recurrence: 'biweekly', due: '2026-10-26T15:00' }), false);
});

test('recurrence phrases and monthly clarification are validated without trusting model dates', () => {
  for (const [message, type] of [['매일 오후 3시 회의', 'daily'], ['날마다 오후 3시 회의', 'daily'], ['격주 월요일 오후 3시 회의', 'biweekly'], ['2 주마다 월요일 오후 3시 회의', 'biweekly'], ['매월 15일 오후 3시 회의', 'monthly'], ['매달 31일 오후 3시 회의', 'monthly']]) {
    assert.equal(recurrenceFromText(message), type); assert.equal(recurrenceProblem(message), ''); assert.equal(cleanScheduleTitle(message), '회의');
  }
  const monthly = recurrenceWhen('매달 31일 오후 3시 회의', 'monthly', new Date(2027, 1, 1));
  assert.equal(monthly.date, '2027-02-28'); assert.equal(monthly.monthly_day, 31);
  assert.equal(recurrenceWhen('32일 오후 3시', 'monthly', now).invalid, true);
  for (const message of ['매년 회의', '3주마다 회의', '매달 첫째 월요일 회의', '매달 15일과 20일 회의', '매달 15, 20일 회의', '매일 오전 9시 오후 3시 회의', '매일 월요일 회의', '매일 매달 회의', '매달 15일 세 번만 회의']) assert.ok(recurrenceProblem(message), message);
});

test('each recurrence supports whole change, cancel, restore and one-occurrence exceptions', () => {
  for (const recurrence of ['daily', 'biweekly', 'monthly']) {
    const item = projectRecurringItem({ ...meeting, recurrence, monthly_day: recurrence === 'monthly' ? 19 : 0 }, [], now);
    const scope = change('그 회의 오후 4시로 바꿔줘', item);
    assert.equal(scope.draft.awaitScope, true);
    const result = change('전체', item, { draft: scope.draft });
    assert.equal(result.recurrence, recurrence); assert.match(result.due, /T16:00$/);
    assert.equal(change('그 회의 이번 회차만 오후 4시로 바꿔줘', item).scope, 'occurrence');
    assert.equal(change('그 회의 반복 전체 취소해줘', item).action, 'cancel');
    const restored = change('그 회의 반복 전체 다시 잡혔어', item, { items: [], cancelledItems: [{ ...item, cancelled_at: '2026-10-18' }] });
    assert.equal(restored.recurrence, recurrence); assert.equal(restored.action, 'restore');
  }
  const item = projectRecurringItem({ ...meeting, recurrence: 'daily' }, [], now);
  const monthly = change('그 회의 매달로 바꿔줘', item);
  assert.match(monthly.message, /매달 며칠/);
  assert.equal(change('31일', item, { draft: monthly.draft }).monthly_day, 31);
  assert.equal(change('격주로 바꿔줘', item).recurrence, 'biweekly');
  const later = projectRecurringItem({ ...meeting, due: '2026-10-31T15:00', recurrence: 'monthly', monthly_day: 31 }, [], now);
  assert.equal(change('그 회의 매일 오후 4시로 바꿔줘', later).due, '2026-10-19T16:00');
  const dailyWeek = change('이번 주 회의만 취소해줘', item);
  assert.equal(dailyWeek.action, 'none'); assert.match(dailyWeek.message, /여러 회차/);
  assert.equal(change('이번 회차', item, { draft: dailyWeek.draft }).scope, 'occurrence');
  const biweekly = projectRecurringItem({ ...meeting, recurrence: 'biweekly' }, [], new Date(2026, 9, 26, 10));
  assert.equal(change('이번 주 회의만 취소해줘', biweekly, { now: new Date(2026, 9, 26, 10) }).action, 'none');
});

test('old weekly rows and exception IDs migrate without data loss; new rules survive reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-repeat-migrate-')), path = join(dir, 'rin.sqlite');
  let store = new Store(path);
  try {
    const id = store.saveAcademic({ ...meeting, repeat_weekly: 1 });
    store.saveAcademicOccurrence(id, meeting.due, '2026-10-19T16:00');
    store.db.exec('ALTER TABLE academic_items DROP COLUMN recurrence; ALTER TABLE academic_items DROP COLUMN monthly_day');
    store.close(); store = new Store(path);
    assert.equal(store.academics(now)[0].recurrence, 'weekly'); assert.equal(store.academicExceptions(id).length, 1);
    for (const recurrence of ['daily', 'biweekly', 'monthly']) store.saveAcademic({ ...meeting, recurrence, monthly_day: recurrence === 'monthly' ? 31 : 0 });
    store.close(); store = new Store(path);
    assert.deepEqual(new Set(store.academics(now).map(item => item.recurrence)), new Set(['weekly', 'daily', 'biweekly', 'monthly']));
    const monthly = store.academics(now).find(item => item.recurrence === 'monthly');
    assert.equal(monthly.monthly_day, 31);
    store.saveAcademicOccurrence(monthly.id, '2026-10-31T15:00', '2026-10-31T16:00');
    assert.throws(() => store.saveAcademicOccurrence(monthly.id, '2026-10-30T15:00', '2026-10-30T16:00'));
    const biweekly = store.academics(now).find(item => item.recurrence === 'biweekly');
    assert.throws(() => store.saveAcademicOccurrence(biweekly.id, '2026-10-26T15:00', '2026-10-26T16:00'));
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('chat registers, clarifies, deduplicates, changes cadence and restores each repeat type atomically', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() });
  const dir = mkdtempSync(join(tmpdir(), 'rin-recurrence-chat-'));
  let calls = 0;
  const app = createApp({ dataPath: join(dir, 'rin.sqlite'), codexClient: fakeCodex(async ({ schema }) => {
    if (schema?.properties?.memories) return codexResult({ memories: [] });
    if (!schema) return codexResult('AI가 작성한 답변.');
    calls++; return codexResult({ action: 'add', title: '회의', kind: 'event', course: '', due: '2099-01-01T01:00' });
  }) });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (body, path = '/api/chat', status = 200) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token }, body: JSON.stringify(body) });
    assert.equal(response.status, status); return response.json();
  };
  try {
    let state = await post({ text: '매일 오후 3시 회의 있어' });
    assert.equal(state.academics[0].recurrence, 'daily'); assert.equal(state.academics[0].due, meeting.due);
    await post({ text: '매일 오후 3시 회의 있어' }); assert.equal(app.store.academics().length, 1);
    const id = state.academics[0].id;
    state = await post({ text: '그 회의 격주로 바꿔줘' });
    assert.equal(state.academics[0].recurrence, 'biweekly');
    state = await post({ text: '그 회의 매달 31일 오후 4시로 바꿔줘' });
    assert.equal(state.academics[0].recurrence, 'monthly'); assert.equal(state.academics[0].monthly_day, 31);
    assert.equal(state.academics[0].due, '2026-10-31T16:00');
    const modelCalls = calls;
    for (const recurrence of ['monthly', 'daily', 'biweekly']) {
      if (recurrence !== 'monthly') await post({ text: recurrence === 'daily' ? '그 회의 매일 오후 4시로 바꿔줘' : '그 회의 격주 화요일 오후 4시로 바꿔줘' });
      state = await post({ text: '그 회의 이번 회차만 취소해줘' });
      assert.equal(state.messages.at(-1).schedule_action.scope, 'occurrence');
      state = await post({ text: '그 회의 다시 잡혔어' }); assert.equal(state.messages.at(-1).schedule_action.action, 'restore');
      await post({ text: '그 회의 취소해줘' }); assert.equal(app.store.integration('schedule_draft').awaitScope, true);
      state = await post({ text: '전체' }); assert.equal(state.academics.length, 0);
      await post({ text: '그 회의 다시 잡혔어' });
      state = await post({ text: '전체' }); assert.equal(state.academics[0].id, id); assert.equal(state.academics[0].recurrence, recurrence);
      await post({ id, completed: true }, '/api/academic/toggle', 400);
    }
    assert.equal(calls, modelCalls);
    const before = app.store.academics();
    const addPair = app.store.addPair; app.store.addPair = () => { throw new Error('receipt failed'); };
    await post({ text: '그 회의 매달 15일로 바꿔줘' }, '/api/chat', 500);
    assert.deepEqual(app.store.academics(), before); app.store.addPair = addPair;
    await post({ ...meeting, id, recurrence: 'yearly' }, '/api/academic', 400);
    await post({ ...meeting, id, recurrence: 'monthly', monthlyDay: 32 }, '/api/academic', 400);
    state = await post({ ...meeting, id, recurrence: 'monthly', monthlyDay: 31 }, '/api/academic');
    assert.equal(state.academics[0].monthly_day, 31);
    await post({ text: '매달 회의 있어' }); assert.equal(app.store.messages().at(-1).content, 'AI가 작성한 답변.');
    const count = app.store.academics().length;
    await post({ text: '15일과 20일 오후 4시' }); assert.equal(app.store.academics().length, count);
    await post({ text: '매달 회의 있어' });
    state = await post({ text: '15일 4시' }); assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
    state = await post({ text: '오후' });
    assert.ok(state.academics.some(item => item.recurrence === 'monthly' && item.monthly_day === 15 && item.due === '2026-11-15T16:00'));
    await post({ text: '격주 회의 있어' }); assert.equal(app.store.messages().at(-1).content, 'AI가 작성한 답변.');
    state = await post({ text: '금요일 오후 3시' }); assert.ok(state.academics.some(item => item.recurrence === 'biweekly' && item.due === '2026-10-23T15:00'));
  } finally { await new Promise(done => app.server.close(done)); rmSync(dir, { recursive: true }); }
});

test('all repeat frequencies notify once per actual occurrence and honor exceptions', async () => {
  for (const [recurrence, anchor, next, monthlyDay] of [['daily', '2026-10-19T15:00', '2026-10-20T15:00', 0], ['biweekly', '2026-10-19T15:00', '2026-11-02T15:00', 0], ['monthly', '2027-01-31T15:00', '2027-02-28T15:00', 31]]) {
    const dir = mkdtempSync(join(tmpdir(), 'rin-repeat-alert-')), store = new Store(join(dir, 'rin.sqlite')), sent = [];
    let current = new Date(new Date(anchor).getTime() - 15 * 60000);
    try {
      store.saveSettings({ ...store.settings(), dailyBriefing: false, casualNotifications: false, gameNagging: false });
      const id = store.saveAcademic({ ...meeting, due: anchor, recurrence, monthly_day: monthlyDay });
      store.saveAcademicOccurrence(id, anchor, anchor, true);
      const service = new ReminderService(store, { now: () => current, notify: async value => sent.push(value), detectGame: async () => ({ isGame: false }) });
      await service.tick(); assert.equal(sent.filter(value => value.key.startsWith('event:')).length, 0);
      current = new Date(new Date(next).getTime() - 15 * 60000);
      await service.tick(); await service.tick(); assert.equal(sent.filter(value => value.key.startsWith('event:')).length, 1);
      assert.match(sent.find(value => value.key.startsWith('event:')).key, new RegExp(next));
    } finally { store.close(); rmSync(dir, { recursive: true }); }
  }
});
