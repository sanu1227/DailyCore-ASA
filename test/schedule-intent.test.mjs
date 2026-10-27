import test from 'node:test';
import { codexResult, fakeCodex } from './helpers/codex.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../app/server.mjs';
import { cleanScheduleTitle, shouldInterpretAcademicCommand, scheduleWhen } from '../app/schedule-intent.mjs';
import { interpretAcademicCommand } from '../app/provider.mjs';

test('schedule extraction uses Codex structured output and rejects malformed intent without fallback', async () => {
  let malformed = false, calls = 0;
  const codexClient = fakeCodex(async ({ schema }) => {
    calls++; assert.equal(schema.type, 'object');
    return codexResult(malformed ? {} : { action: 'add', title: '팀플 회의', course: '', kind: 'event', due: '2099-01-01T00:00', reason: '' });
  });
  const input = { text: '내일 오후 3시에 팀플 회의 있어', academics: [], now: new Date(2026, 9, 18), codexClient };
  assert.equal((await interpretAcademicCommand(input)).due, '2026-10-19T15:00');
  malformed = true;
  await assert.rejects(interpretAcademicCommand(input)); assert.equal(calls, 2);
});

test('conversational schedule detection excludes questions, negation, hypotheticals and past events', () => {
  for (const text of ['내일 오후 3시 팀플 회의 있어', '금요일 치과 가야 해', '11월 5일 오후 두 시 민수 만나', '내일 15:00 약속 등록해 줄래?', '보고서 과제 완료했어']) assert.equal(shouldInterpretAcademicCommand(text), true, text);
  for (const text of ['내일 회의 있어?', '내일 회의 안 해', '내일 회의 있으면 좋겠다', '내일 회의 몇 시야', '내일 치과 갈까', '어제 회의 했어', '그냥 이야기하자', '내일 오후 3시 병원 일정 등록하지 마', '내일 친구는 오후 3시에 병원 간대']) assert.equal(shouldInterpretAcademicCommand(text), false, text);
  assert.equal(shouldInterpretAcademicCommand('오후 세 시 반', { title: '팀플 회의' }), true);
  assert.equal(shouldInterpretAcademicCommand('오후 세 시 반'), false);
});

test('schedule times use explicit user dates, weekdays, rollover and unambiguous clocks', () => {
  assert.equal(cleanScheduleTitle('내일 오후 3시 팀플 회의'), '팀플 회의');
  assert.equal(cleanScheduleTitle('금요일 치과'), '치과');
  const now = new Date(2026, 9, 18, 12); // Sunday
  assert.deepEqual(scheduleWhen('내일 오후 세 시 반', now), { date: '2026-10-19', time: '15:30', invalid: false, ambiguousTime: false });
  assert.equal(scheduleWhen('다음주 금요일 15:00 회의', now).date, '2026-10-23');
  assert.equal(scheduleWhen('다다음주 월요일 정오', now).date, '2026-10-26');
  assert.equal(scheduleWhen('내일 3시', now).ambiguousTime, true);
  assert.equal(scheduleWhen('내일 3시', now).time, null);
  assert.equal(scheduleWhen('내일 오후 25시', now).invalid, true);
  assert.equal(scheduleWhen('2월 30일 오전 9시', now).invalid, true);
  assert.equal(scheduleWhen('내일 오전 12시', now).time, '00:00');
  assert.equal(scheduleWhen('내일 오후 12시', now).time, '12:00');
  assert.equal(scheduleWhen('모레', new Date(2026, 11, 31)).date, '2027-01-02');
});

test('chat saves schedules and receipts atomically, retains optional details, prevents duplicates and persists history', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-chat-schedule-'));
  const dataPath = join(dir, 'rin.sqlite');
  let intent = { action: 'add', title: '팀플 회의', course: '', kind: 'event', due: '2099-12-01T00:00', notes: '', query: '', reason: '' };
  let calls = 0;
  const codexClient = fakeCodex(async ({ schema }) => {
    if (schema?.properties?.memories) return codexResult({ memories: [] });
    if (!schema) return codexResult('AI가 작성한 답변.');
    calls++; return codexResult(intent);
  });
  let app = createApp({ dataPath, codexClient });
  const start = async () => { await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${app.server.address().port}`; };
  let base = await start();
  const post = async (message, path = '/api/chat') => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token }, body: JSON.stringify({ text: message }) });
    assert.equal(response.status, 200); return response.json();
  };
  try {
    let state = await post('내일 팀플 회의 있어');
    assert.equal(state.academics.length, 0); assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
    state = await post('오후 3시');
    assert.equal(state.academics.length, 1);
    const due = `${scheduleWhen('내일').date}T15:00`;
    assert.equal(state.academics[0].due, due);
    assert.equal(state.messages.at(-1).schedule_action.itemId, state.academics[0].id);
    assert.equal(calls, 1);
    state = await post('내일 오후 3시 팀플 회의 있어');
    assert.equal(state.academics.length, 1); assert.equal(state.messages.at(-1).schedule_action.action, 'existing');
    intent = { ...intent, title: '치과 진료', kind: 'exam' };
    state = await post('모레 치과 진료 있어');
    assert.equal(state.academics.length, 1);
    const beforeCancel = calls;
    state = await post('아니야 취소');
    assert.equal(calls, beforeCancel); assert.equal(app.store.integration('schedule_draft'), null);
    assert.equal(state.academics.length, 1);
    state = await post('모레 3시 치과 진료 있어');
    assert.equal(state.messages.at(-1).content, 'AI가 작성한 답변.');
    state = await post('오후야');
    assert.equal(state.academics.length, 2); assert.match(state.academics[1].due, /T15:00$/);
    assert.equal(state.academics[1].kind, 'event');
    intent = { ...intent, title: '운영체제 보고서', kind: 'assignment' };
    state = await post('글피까지 운영체제 보고서 제출해야 해');
    assert.equal(state.academics.length, 3); assert.match(state.academics[2].due, /T23:59$/);
    await new Promise(resolve => app.server.close(resolve));
    app = createApp({ dataPath, codexClient }); base = await start();
    assert.equal(app.store.messages().at(-1).schedule_action.action, 'add');
    assert.equal(app.store.academics().length, 3);
    const addPair = app.store.addPair;
    app.store.addPair = () => { throw new Error('Simulated receipt failure'); };
    const failed = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token }, body: JSON.stringify({ text: '5일 뒤 운영체제 보고서 추가해 줘' }) });
    assert.equal(failed.status, 500); assert.equal(app.store.academics().length, 3);
    app.store.addPair = addPair;
    await post('', '/api/messages/clear');
    assert.equal(app.store.integration('schedule_draft'), null);
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    rmSync(dir, { recursive: true });
  }
});
