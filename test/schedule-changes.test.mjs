import test from 'node:test';
import { codexResult, fakeCodex } from './helpers/codex.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app/server.mjs';
import { Store } from '../app/store.mjs';
import { prepareScheduleChange } from '../app/schedule-changes.mjs';
import { shouldInterpretAcademicCommand, scheduleWhen } from '../app/schedule-intent.mjs';
import { buildReminderCandidates, ReminderService } from '../app/reminders.mjs';

const now = new Date(2026, 9, 18, 12);
const meeting = { id: 'meeting', title: '팀플 회의', kind: 'event', due: '2026-10-19T15:00', course: '운영체제', notes: '도서관', completed: 0 };
const second = { ...meeting, id: 'second', title: '동아리 회의', due: '2026-10-20T17:00' };
const receipt = { schedule_action: { ...meeting, itemId: meeting.id, action: 'add' } };
const resolve = (message, extra = {}) => prepareScheduleChange({ message, items: [meeting, second], recent: [receipt], now, ...extra });

test('schedule changes resolve stored references and preserve unspecified fields', () => {
  assert.deepEqual(resolve('그 회의 오후 4시로 바뀌었어'), { action: 'update', itemId: meeting.id, due: '2026-10-19T16:00', title: meeting.title, draft: null });
  assert.equal(resolve('그 회의 모레로 미뤄줘').due, '2026-10-20T15:00');
  assert.equal(resolve('그 회의 오후 4시로 바꿔줄래?').due, '2026-10-19T16:00');
  assert.equal(resolve('그 회의 오후 4시로 바꿨어').due, '2026-10-19T16:00');
  assert.equal(resolve('내일 회의 모레 오후 4시로 옮겨줘', { recent: [] }).due, '2026-10-20T16:00');
  const renamed = resolve('그 회의 이름을 "프로젝트 회의"로 바꿔줘');
  assert.equal(renamed.title, '프로젝트 회의'); assert.equal(renamed.due, meeting.due);
  assert.equal(resolve('그 회의 취소됐어').itemId, meeting.id);
  assert.equal(resolve('그거 취소해 줘').itemId, meeting.id);
  assert.equal(resolve('그 회의 취소됐어', { items: [second] }).action, 'none');
  assert.equal(resolve('그거 취소해 줘', { recent: [] }).action, 'none');
});

test('memory and wording corrections do not turn an earlier reference into a schedule command', () => {
  const draft = resolve('회의 오후 4시로 바꿔줘', { recent: [] }).draft;
  for (const message of ['아까 전공 잘못 말했다. 내 전공은 산업디자인이야. 기억 수정해 줘.', '아까 말투를 좀 더 편하게 바꿔줘', '아까 대사 두 개 다 수정해줘']) {
    assert.equal(resolve(message), null);
    assert.equal(resolve(message, { recent: [], items: [] }), null);
    assert.equal(resolve(message, { draft }), null);
  }
});

test('ambiguous changes retain payload and stable candidate IDs across clarification', () => {
  const question = resolve('회의 오후 4시로 바꿔줘', { recent: [] });
  assert.match(question.message, /어느 일정/);
  assert.equal(resolve('2번', { draft: question.draft }).due, '2026-10-20T16:00');
  assert.equal(resolve('팀플 회의', { draft: question.draft }).itemId, meeting.id);
  assert.equal(resolve('오후 5시', { draft: question.draft }).action, 'none');
  assert.equal(resolve('1번', { draft: question.draft, items: [second] }).action, 'none');
  assert.equal(resolve('1번', { draft: question.draft, items: [{ ...meeting, due: '2026-10-19T18:00' }, second] }).action, 'none');
  const clock = resolve('그 회의 4시로 바꿔줘');
  assert.match(clock.message, /오전이야 오후야/);
  assert.equal(resolve('오후야', { draft: clock.draft }).due, '2026-10-19T16:00');
  const missing = resolve('그 회의 바뀌었어');
  assert.equal(resolve('모레 오후 5시', { draft: missing.draft }).due, '2026-10-20T17:00');
  const cancel = resolve('회의 취소됐어', { recent: [] });
  assert.equal(resolve('2번', { draft: cancel.draft }).action, 'cancel');
  assert.equal(resolve('아니야 취소', { draft: question.draft }).draft, null);
  assert.equal(resolve('아니야 취소', { draft: { title: '치과' } }).action, 'none');
  assert.equal(resolve('그거 취소해 줘', { draft: { title: '치과' } }).action, 'none');
  assert.equal(resolve('그 회의 취소됐어', { draft: { title: '팀플 회의' } }).action, 'none');
});

test('questions, negatives, hypotheticals, invalid and past times do not mutate or create schedules', () => {
  for (const message of ['그 회의 취소됐어?', '그 회의 취소하지 마', '그 회의 취소 안 됐어', '그 회의 취소 안 할 거야', '그 회의 취소할 수도 있어', '만약 내일 회의 오후 4시로 바뀌면', '내일 회의 시간 변경하지 마', '그 회의 바꾸면 어때?', '내일 회의 취소 아니야', '내일 회의 시간 안 바꿨어']) {
    assert.equal(resolve(message)?.action || 'none', 'none', message);
    assert.equal(shouldInterpretAcademicCommand(message), false, message);
  }
  for (const message of ['회의 모두 취소해 줘', '그 회의 취소하고 내일 다시 잡아줘', '그 회의 오늘 오전 9시로 바꿔줘', '그 회의 2월 30일로 바꿔줘', '그 회의 오후 25시로 바꿔줘']) assert.equal(resolve(message).action, 'none', message);
  assert.equal(resolve('다른 이야기 하자'), null);
});

test('conversation restores only cancelled IDs and validates dates, ambiguity and negation', () => {
  const cancelled = { ...meeting, cancelled_at: '2026-10-18T01:00:00Z' };
  const options = { items: [], cancelledItems: [cancelled], recent: [{ schedule_action: { ...receipt.schedule_action, action: 'cancel' } }] };
  for (const message of ['그 회의 다시 잡혔어', '그거 복구해 줘', '그 회의 취소를 되돌려 줘', '취소했던 팀플 회의 다시 잡혔어']) {
    assert.deepEqual(resolve(message, options), { action: 'restore', itemId: meeting.id, title: meeting.title, due: meeting.due, draft: null }, message);
    assert.equal(shouldInterpretAcademicCommand(message), false);
  }
  assert.equal(resolve('그 회의 모레 오후 4시로 다시 잡혔어', options).due, '2026-10-20T16:00');
  assert.equal(resolve('모레 팀플 회의 다시 잡혔어', options).due, '2026-10-20T15:00');
  assert.equal(resolve('그 회의 다시 잡혔어 오후 4시야', options).due, '2026-10-19T16:00');
  const clock = resolve('그 회의 4시로 다시 잡혔어', options);
  assert.match(clock.message, /오전이야 오후야/);
  assert.equal(resolve('오후야', { ...options, draft: clock.draft }).due, '2026-10-19T16:00');
  assert.equal(resolve('그 회의 2월 30일로 다시 잡혔어', options).action, 'none');
  const pastOptions = { ...options, cancelledItems: [{ ...cancelled, due: '2026-10-17T15:00' }] };
  const past = resolve('그 회의 다시 잡혔어', pastOptions);
  assert.match(past.message, /이미 지났어/);
  assert.equal(resolve('내일 오후 4시', { ...pastOptions, draft: past.draft }).due, '2026-10-19T16:00');
  assert.equal(resolve('그 회의 다시 잡혔어').action, 'none'); // Active is not a restore target.
  assert.equal(resolve('그 회의 다시 잡혔어', { ...options, cancelledItems: [] }).action, 'none');
  for (const message of ['내일 그 회의 다시 잡혔어?', '내일 회의 다시 안 잡혔어', '내일 회의 다시 못 잡았어', '내일 그 회의 복구하지 마', '내일 회의 다시 잡히면 좋겠다', '내일 회의 다시 잡을까', '그 회의 다시 잡힐 수도 있어', '그 회의 다시 잡혔는지 알려줘', '내일 회의 다시 잡으려고 해']) {
    assert.equal(resolve(message, options)?.action || 'none', 'none', message);
    assert.equal(shouldInterpretAcademicCommand(message), false, message);
  }
  const multiple = { ...options, cancelledItems: [cancelled, { ...second, cancelled_at: cancelled.cancelled_at }], recent: [] };
  const question = resolve('회의 오후 4시로 다시 잡혔어', multiple);
  assert.equal(question.draft.action, 'restore'); assert.match(question.message, /어느 일정/);
  assert.equal(resolve('2번', { ...multiple, draft: question.draft }).due, '2026-10-20T16:00');
  assert.equal(resolve('팀플 회의', { ...multiple, draft: question.draft }).itemId, meeting.id);
  assert.equal(resolve('1번', { ...multiple, draft: question.draft, cancelledItems: [multiple.cancelledItems[1]] }).action, 'none');
  assert.equal(resolve('오후야', { ...options, draft: clock.draft, cancelledItems: [{ ...cancelled, cancelled_at: '2026-10-18T02:00:00Z' }] }).action, 'none');
  assert.equal(resolve('아니야 취소', { ...options, draft: clock.draft }).draft, null);
});

test('chat restores atomically without AI or duplicates, persists references and enforces capacity', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-restore-chat-'));
  const dataPath = join(dir, 'rin.sqlite');
  const codexClient = fakeCodex(async ({ schema }) => { assert.equal(schema, undefined); return codexResult('AI가 작성한 답변.'); });
  let app = createApp({ dataPath, codexClient }), base;
  const start = async () => { await new Promise(done => app.server.listen(0, '127.0.0.1', done)); base = `http://127.0.0.1:${app.server.address().port}`; };
  const post = async (message, status = 200) => {
    const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token }, body: JSON.stringify({ text: message }) });
    assert.equal(response.status, status); return response.json();
  };
  await start();
  try {
    const due = `${scheduleWhen('내일').date}T15:00`;
    app.store.syncEclass([{ ...meeting, due, externalId: 'restore-test', sourceUrl: 'https://eclass.tukorea.ac.kr/' }]);
    const id = app.store.academics()[0].id;
    app.store.addPair('내일 팀플 회의 있어', '등록했어', { action: 'add', itemId: id, title: meeting.title, due });
    await post('그 회의 취소됐어');
    const addPair = app.store.addPair;
    app.store.addPair = () => { throw new Error('Simulated receipt failure'); };
    await post('그 회의 모레 오후 4시로 다시 잡혔어', 500);
    assert.deepEqual(app.store.cancelledAcademicIds(), [id]); assert.equal(app.store.cancelledAcademics()[0].due, due);
    app.store.addPair = addPair;
    let state = await post('그 회의 다시 잡혔어');
    assert.equal(state.academics.length, 1); assert.equal(state.academics[0].id, id);
    assert.equal(state.academics[0].due, due); assert.equal(state.academics[0].manual_override, 0);
    assert.equal(state.academics[0].notes, meeting.notes); assert.equal(state.academics[0].external_id, 'restore-test');
    assert.equal(state.messages.at(-1).schedule_action.action, 'restore');
    assert.equal(buildReminderCandidates({ classes: [], academics: state.academics, settings: { notifications: true }, now: new Date(`${due.slice(0, 10)}T14:45`) }).length, 1);
    state = await post('그 회의 다시 잡혔어');
    assert.equal(state.academics.length, 1); assert.equal(state.messages.at(-1).schedule_action, null);
    await post('그 회의 취소됐어');
    await post('그 회의 4시로 다시 잡혔어');
    assert.equal(app.store.integration('schedule_draft').action, 'restore');
    await new Promise(done => app.server.close(done));
    app = createApp({ dataPath, codexClient }); await start();
    state = await post('오후야');
    assert.match(state.academics[0].due, /T16:00$/); assert.equal(state.academics[0].id, id);
    assert.equal(state.academics[0].manual_override, 1);
    assert.equal(state.messages.at(-1).schedule_action.action, 'restore');
    await post('그 회의 취소됐어');
    app.store.clearMessages(); // Exact names still work without old cards.
    state = await post('팀플 회의 다시 잡혔어');
    assert.equal(state.academics[0].id, id);
    await post('그 회의 취소됐어');
    app.store.db.exec('BEGIN');
    for (let i = 0; i < 200; i++) app.store.saveAcademic({ ...meeting, title: `다른 일정 ${i}`, due });
    app.store.db.exec('COMMIT');
    await post('그 회의 다시 잡혔어', 400);
    assert.deepEqual(app.store.cancelledAcademicIds(), [id]); assert.equal(app.store.academics().length, 200);
  } finally { await new Promise(done => app.server.close(done)); rmSync(dir, { recursive: true }); }
});

test('chat updates and cancels atomically without a model, restores and persists receipts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-change-chat-'));
  const dataPath = join(dir, 'rin.sqlite');
  const codexClient = fakeCodex(async ({ schema }) => { assert.equal(schema, undefined); return codexResult('AI가 작성한 답변.'); });
  let app = createApp({ dataPath, codexClient }), base;
  const start = async () => { await new Promise(done => app.server.listen(0, '127.0.0.1', done)); base = `http://127.0.0.1:${app.server.address().port}`; };
  const post = async (body, path = '/api/chat', status = 200) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token }, body: JSON.stringify(body) });
    assert.equal(response.status, status); return response.json();
  };
  await start();
  try {
    const due = `${scheduleWhen('내일').date}T15:00`;
    const id = app.store.saveAcademic({ ...meeting, due });
    app.store.addPair('내일 회의 있어', '등록했어', { action: 'add', itemId: id, title: meeting.title, due });
    let state = await post({ text: '그 회의 오후 4시로 바뀌었어' });
    const item = state.academics[0];
    assert.equal(item.id, id); assert.equal(item.due, due.replace('15:00', '16:00'));
    assert.equal(item.notes, meeting.notes); assert.equal(item.course, meeting.course); assert.equal(item.kind, meeting.kind);
    assert.equal(state.messages.at(-1).schedule_action.previousDue, due);
    const addPair = app.store.addPair;
    app.store.addPair = () => { throw new Error('Simulated receipt failure'); };
    await post({ text: '그 회의 취소됐어' }, '/api/chat', 500);
    assert.equal(app.store.academics().length, 1); assert.equal(app.store.cancelledAcademicIds().length, 0);
    await post({ text: '그 회의 오후 6시로 바꿔줘' }, '/api/chat', 500);
    assert.equal(app.store.academics()[0].due, item.due);
    app.store.addPair = addPair;
    state = await post({ text: '그 회의 취소됐어' });
    assert.equal(state.academics.length, 0); assert.deepEqual(state.cancelledAcademicIds, [id]);
    assert.equal(state.messages.at(-1).schedule_action.action, 'cancel');
    assert.deepEqual(buildReminderCandidates({ classes: [], academics: app.store.academics(), settings: { notifications: true }, now: new Date(`${due.slice(0, 10)}T15:45`) }), []);
    await new Promise(done => app.server.close(done));
    app = createApp({ dataPath, codexClient }); await start();
    assert.equal(app.store.messages().at(-1).schedule_action.action, 'cancel');
    assert.deepEqual(app.store.cancelledAcademicIds(), [id]);
    state = await post({ id }, '/api/academic/restore');
    assert.equal(state.academics[0].due, item.due); assert.deepEqual(state.cancelledAcademicIds, []);
    assert.equal(buildReminderCandidates({ classes: [], academics: state.academics, settings: { notifications: true }, now: new Date(`${due.slice(0, 10)}T15:45`) }).length, 1);
    await post({ id }, '/api/academic/restore', 404);
    state = await post({ text: '그 회의 5시로 바꿔줘' });
    assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
    state = await post({ text: '오후야' });
    assert.match(state.academics[0].due, /T17:00$/);
    await post({}, '/api/messages/clear');
    assert.equal(app.store.integration('schedule_draft'), null);
  } finally {
    await new Promise(done => app.server.close(done));
    rmSync(dir, { recursive: true });
  }
});

test('e-Class sync does not overwrite local edits or resurrect cancelled schedules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-change-sync-'));
  const store = new Store(join(dir, 'rin.sqlite'));
  const source = { ...meeting, externalId: 'test-course-meeting', sourceUrl: 'https://eclass.tukorea.ac.kr/' };
  try {
    store.syncEclass([source]);
    const id = store.academics()[0].id;
    store.saveAcademic({ ...meeting, due: '2026-10-19T16:00' }, id);
    store.syncEclass([source]);
    assert.equal(store.academics()[0].due, '2026-10-19T16:00');
    store.cancelAcademic(id); store.syncEclass([source]); store.syncEclass([]);
    assert.equal(store.academics().length, 0);
    assert.deepEqual(store.cancelledAcademicIds(), [id]);
    store.restoreAcademic(id);
    assert.equal(store.academics()[0].due, '2026-10-19T16:00');
    assert.equal(store.academics()[0].external_id, source.externalId);
    assert.equal(store.academics()[0].missing_since, null);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('cancelling during notification preparation discards stale pending text', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-change-notify-'));
  const store = new Store(join(dir, 'rin.sqlite'));
  const sent = [];
  try {
    store.saveSettings({ ...store.settings(), dailyBriefing: false, casualNotifications: false });
    const id = store.saveAcademic(meeting);
    const service = new ReminderService(store, { now: () => new Date(2026, 9, 19, 14, 45), notify: async item => sent.push(item), detectGame: async () => { store.cancelAcademic(id); return { isGame: false }; } });
    await service.tick();
    assert.deepEqual(sent, []);
    store.restoreAcademic(id);
    service.detectGame = async () => ({ isGame: false });
    await service.tick();
    assert.ok(sent.some(item => item.key.startsWith('event:')));
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
