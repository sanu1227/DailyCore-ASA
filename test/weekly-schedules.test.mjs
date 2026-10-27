import test from 'node:test';
import { codexResult, fakeCodex } from './helpers/codex.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { createApp } from '../app/server.mjs';
import { nextWeeklyDue, cleanScheduleTitle, recurrenceProblem, scheduleWhen, shouldInterpretAcademicCommand } from '../app/schedule-intent.mjs';
import { prepareScheduleChange } from '../app/schedule-changes.mjs';
import { ReminderService } from '../app/reminders.mjs';

const meeting = { id: 'weekly', title: '팀플 회의', course: '', kind: 'event', due: '2026-10-19T15:00', notes: '회의실', completed: false, repeat_weekly: 1 };
const now = new Date(2026, 9, 18, 12);

test('weekly dates cross weeks and years without copying occurrences or losing local time', () => {
  assert.equal(nextWeeklyDue(meeting.due, now), meeting.due);
  assert.equal(nextWeeklyDue(meeting.due, new Date(2026, 9, 19, 15, 1)), '2026-10-26T15:00');
  assert.equal(nextWeeklyDue('2026-12-28T15:00', new Date(2027, 0, 1)), '2027-01-04T15:00');
  assert.equal(nextWeeklyDue('2024-02-29T09:30', new Date(2024, 2, 1)), '2024-03-07T09:30');
  assert.equal(cleanScheduleTitle('매주 월요일 오후 3시 팀플 회의'), '팀플 회의');
  assert.equal(shouldInterpretAcademicCommand('매주 회의 있어'), true);
  for (const text of ['매년 회의 있어', '3주마다 월요일 회의 있어', '매주 월·수요일 회의 있어', '매주 월 수 금요일 회의 있어', '매주 월요일 오후 3시랑 5시 회의 있어', '매주 월요일과 수요일 회의 있어', '매주 월요일 세 번만 회의 있어']) assert.ok(recurrenceProblem(text), text);
  for (const text of ['매주 월요일 회의 있어?', '매주 월요일 회의 안 해', '매주 월요일 회의 있으면 좋겠다']) assert.equal(shouldInterpretAcademicCommand(text), false);
});

test('weekly storage projects one next occurrence, preserves recurrence and restores after downtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-weekly-store-'));
  const path = join(dir, 'rin.sqlite');
  let store = new Store(path);
  try {
    const id = store.saveAcademic(meeting);
    assert.equal(store.academics(new Date(2026, 9, 20))[0].due, '2026-10-26T15:00');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM academic_items').get().n, 1);
    assert.equal(store.db.prepare('SELECT due FROM academic_items').get().due, meeting.due);
    store.saveAcademic({ ...meeting, repeat_weekly: undefined, notes: '새 회의실' }, id);
    store.cancelAcademic(id); store.close(); store = new Store(path);
    assert.equal(store.academics(now).length, 0); assert.equal(store.cancelledAcademics()[0].repeat_weekly, 1);
    store.restoreAcademic(id);
    const value = store.academics(new Date(2026, 10, 1))[0];
    assert.equal(value.due, '2026-11-02T15:00'); assert.equal(value.id, id); assert.equal(value.notes, '새 회의실');
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('weekly changes require clear series scope and never turn one-occurrence requests into series changes', () => {
  const recent = [{ schedule_action: { ...meeting, itemId: meeting.id } }];
  const resolve = (message, extra = {}) => prepareScheduleChange({ message, items: [meeting], recent, now, ...extra });
  const update = resolve('그 회의 매주 화요일 오후 4시로 바꿔줘');
  assert.equal(update.repeat_weekly, 1); assert.equal(update.due, '2026-10-20T16:00');
  const prompt = resolve('그 회의 오후 4시로 바뀌었어');
  assert.equal(prompt.action, 'none'); assert.equal(prompt.draft.awaitScope, true);
  assert.equal(resolve('전체', { draft: prompt.draft }).due, '2026-10-19T16:00');
  assert.equal(resolve('이번 주만', { draft: prompt.draft }).draft, null);
  assert.equal(resolve('그 회의 이번 주만 취소해 줘').action, 'none');
  const cancel = resolve('그 회의 취소됐어');
  assert.equal(cancel.action, 'none');
  assert.equal(resolve('전체 취소해줘', { draft: cancel.draft }).action, 'cancel');
  assert.equal(resolve('그 회의 반복 전체 취소해 줘').action, 'cancel');
  const restore = resolve('그 회의 반복 전체 다시 잡혔어', { items: [], cancelledItems: [{ ...meeting, due: '2026-10-05T15:00', cancelled_at: '2026-10-06' }] });
  assert.equal(restore.action, 'restore'); assert.equal(restore.due, meeting.due);
});

test('weekly chat registers, clarifies, deduplicates, modifies and cancels atomically', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-weekly-chat-'));
  let calls = 0;
  const app = createApp({ dataPath: join(dir, 'rin.sqlite'), codexClient: fakeCodex(async ({ schema }) => {
    if (schema?.properties?.memories) return codexResult({ memories: [] });
    if (!schema) return codexResult('AI가 작성한 답변.');
    calls++; return codexResult({ action: 'add', title: '매주 팀플 회의', course: '', kind: 'event', due: '', reason: '' });
  }) });
  await new Promise(done => app.server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (body, path = '/api/chat', status = 200) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token }, body: JSON.stringify(body) });
    assert.equal(response.status, status); return response.json();
  };
  try {
    let state = await post({ text: '매주 팀플 회의 있어' });
    assert.equal(state.academics.length, 0); assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
    state = await post({ text: '월요일 오후 3시' });
    assert.equal(calls, 1); assert.equal(state.academics.length, 1); assert.equal(state.academics[0].repeat_weekly, 1);
    assert.equal(state.academics[0].title, meeting.title);
    const id = state.academics[0].id;
    assert.equal(new Date(state.academics[0].due).getDay(), 1); assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
    state = await post({ text: '매주 월요일 오후 3시에 팀플 회의 있어' });
    assert.equal(state.academics.length, 1); assert.equal(state.messages.at(-1).schedule_action.action, 'existing');
    const modelCalls = calls;
    state = await post({ text: '그 회의 매주 화요일 오후 4시로 바꿔줘' });
    assert.equal(state.academics[0].id, id); assert.equal(new Date(state.academics[0].due).getDay(), 2); assert.match(state.academics[0].due, /T16:00$/);
    state = await post({ text: '그 회의 취소됐어' });
    assert.equal(state.academics.length, 1); assert.equal(app.store.integration('schedule_draft').awaitScope, true);
    state = await post({ text: '이번 회차' });
    assert.equal(state.academics.length, 1); assert.equal(state.messages.at(-1).schedule_action.scope, 'occurrence');
    assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
    const addPair = app.store.addPair;
    app.store.addPair = () => { throw new Error('receipt failure'); };
    await post({ text: '그 회의 반복 전체 취소해줘' }, '/api/chat', 500);
    assert.equal(app.store.academics().length, 1);
    app.store.addPair = addPair;
    state = await post({ text: '그 회의 반복 전체 취소해줘' });
    assert.equal(state.academics.length, 0);
    state = await post({ text: '그 회의 다시 잡혔어' });
    assert.equal(state.academics.length, 0); assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
    state = await post({ text: '전체' });
    assert.equal(state.academics[0].id, id); assert.equal(state.academics[0].repeat_weekly, 1);
    assert.equal(calls, modelCalls);
    for (const text of ['매년 회의 있어', '3주마다 월요일 회의 있어', '매주 월·수요일 회의 있어']) {
      state = await post({ text }); assert.equal(state.academics.length, 1); assert.equal(calls, modelCalls);
    }
    await post({ id, completed: true }, '/api/academic/toggle', 400);
    await post({ ...meeting, id, repeatWeekly: 'yes' }, '/api/academic', 400);
    state = await post({ ...meeting, id, due: `${scheduleWhen('금요일').date}T17:00`, repeatWeekly: true }, '/api/academic');
    assert.equal(new Date(state.academics[0].due).getDay(), 5); assert.equal(state.academics[0].repeat_weekly, 1);
    state = await post({ ...meeting, id, repeatWeekly: false }, '/api/academic');
    assert.equal(state.academics[0].repeat_weekly, 0);
  } finally { await new Promise(done => app.server.close(done)); rmSync(dir, { recursive: true }); }
});

test('weekly reminders recur once per occurrence and stop after series cancellation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-weekly-alert-'));
  const store = new Store(join(dir, 'rin.sqlite')), sent = [];
  let current = new Date(2026, 9, 19, 14, 45);
  try {
    store.saveSettings({ ...store.settings(), dailyBriefing: false, casualNotifications: false, gameNagging: false });
    const id = store.saveAcademic(meeting);
    const service = new ReminderService(store, { now: () => current, notify: async item => sent.push(item), detectGame: async () => ({ isGame: false }) });
    await service.tick(); await service.tick();
    assert.equal(sent.filter(item => item.key.startsWith('event:')).length, 1);
    current = new Date(2026, 9, 26, 14, 45); await service.tick();
    assert.equal(sent.filter(item => item.key.startsWith('event:')).length, 2);
    store.cancelAcademic(id); current = new Date(2026, 10, 2, 14, 45); await service.tick();
    assert.equal(sent.filter(item => item.key.startsWith('event:')).length, 2);
    store.restoreAcademic(id); await service.tick();
    assert.equal(sent.filter(item => item.key.startsWith('event:')).length, 3);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
