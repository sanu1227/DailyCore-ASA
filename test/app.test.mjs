import test from 'node:test';
import { codexResult, fakeCodex } from './helpers/codex.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app/server.mjs';
import { generate, buildRequest, explicitKoreanDue, isAffectionTrigger, probeAiConnections, relationshipStyle, shouldInterpretAcademicCommand } from '../app/provider.mjs';

const localDueAfterDays = (days, time) => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${time}`;
};

test('local app: persistence, context, credentials, validation and failed requests', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-test-'));
  const dataPath = join(dir, 'rin.sqlite');
  let captured, mode = 'ok', structuredAnswer = null;
  const codexClient = fakeCodex(async body => {
    captured = { body };
    if (mode === 'unavailable') throw new Error('Codex unavailable');
    return codexResult(body.schema ? structuredAnswer : '제법이네. 같이 해보자.', { usage: { input_tokens: 100, output_tokens: 23, total_tokens: 123 } });
  });
  let app = createApp({ dataPath, codexClient });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  let base = `http://127.0.0.1:${app.server.address().port}`;
  let session = await (await fetch(`${base}/api/session`)).json();
  const post = async (path, body, headers = {}) => {
    const result = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': session.token, ...headers }, body: JSON.stringify(body) });
    return { status: result.status, data: await result.json() };
  };
  try {
    await t.test('blocks external origins, missing tokens and database downloads', async () => {
      assert.equal((await post('/api/key', { key: 'secret' }, { Origin: 'https://evil.example' })).status, 403);
      assert.equal((await post('/api/key', { key: 'secret' }, { 'X-Rin-Token': '' })).status, 403);
      assert.equal((await fetch(`${base}/data/rin.sqlite`)).status, 404);
      assert.equal((await fetch(`${base}/api/eclass/token`, { headers: { Origin: 'chrome-extension://wrong' } })).status, 403);
      const bridge = await fetch(`${base}/api/eclass/token`, { headers: { Origin: 'chrome-extension://cgncdfclndlgahkegcpldngkkokgeojd' } });
      assert.equal(bridge.status, 200); assert.equal((await bridge.json()).token, session.token);
      assert.equal(bridge.headers.get('access-control-allow-origin'), 'chrome-extension://cgncdfclndlgahkegcpldngkkokgeojd');
      const worker = await fetch(`${base}/api/eclass/token`, { headers: { 'X-Rin-Extension': 'cgncdfclndlgahkegcpldngkkokgeojd', 'Sec-Fetch-Site': 'none' } });
      assert.equal(worker.status, 200); assert.equal((await worker.json()).token, session.token);
      assert.equal((await fetch(`${base}/api/eclass/token`, { headers: { 'X-Rin-Extension': 'wrong' } })).status, 403);
    });
    await t.test('serves official ASA photos and the portrait controller', async () => {
      for (const name of ['portrait', 'choom', 'moon', 'supa-dupa-luv']) {
        const image = await fetch(`${base}/assets/asa/${name}.jpg`);
        assert.equal(image.status, 200);
        assert.equal(image.headers.get('content-type'), 'image/jpeg');
        const bytes = new Uint8Array(await image.arrayBuffer());
        assert.deepEqual([...bytes.slice(0, 3)], [255, 216, 255]);
      }
      assert.equal((await fetch(`${base}/assets/seoa/portrait.png`)).status, 404);
      const controller = await fetch(`${base}/seoa-portrait.js`);
      assert.equal(controller.status, 200);
      assert.match(controller.headers.get('content-type'), /^text\/javascript/);
    });
    await t.test('Codex chat uses the injected account client without an API key', async () => {
      const result = await post('/api/chat', { text: '안녕' });
      assert.equal(result.status, 200); assert.equal(app.store.messages().length, 2); app.store.clearMessages();
    });
    await t.test('validates preferences and stores only supported fields', async () => {
      assert.equal((await post('/api/settings', { ...app.store.settings(), teasing: 8 })).status, 400);
      assert.equal((await post('/api/settings', { name: '테스트', model: 'codex', teasing: 2, notifications: true, quietModeEnabled: false, dailyBriefing: true, casualNotifications: true, gameNagging: true, gameNagMinutes: 30, activityTracking: true, breakMinutes: 50, healthCheckReminder: true, healthCheckUsageMinutes: 180, eveningReview: true, eveningReviewUsageMinutes: 360, quietStart: '01:00', quietEnd: '07:00', key: 'must-not-save', tsundere: 5 })).status, 200);
      assert.equal(app.store.settings().key, undefined);
      assert.equal(app.store.settings().tsundere, undefined);
      assert.equal(app.store.settings().characterMotion, true);
      for (const characterMotion of [false, true]) {
        assert.equal((await post('/api/settings', { ...app.store.settings(), characterMotion })).status, 200);
        assert.equal(app.store.settings().characterMotion, characterMotion);
      }
      for (const characterMotion of [null, 'false', 0]) {
        assert.equal((await post('/api/settings', { ...app.store.settings(), characterMotion })).status, 400);
      }
      assert.equal(app.store.settings().activityTracking, true); assert.equal(app.store.settings().breakMinutes, 50);
      assert.equal(app.store.settings().quietModeEnabled, false);
      assert.equal(app.store.settings().notificationVolume, 70);
      for (const notificationVolume of [0, 35, 100]) {
        assert.equal((await post('/api/settings', { ...app.store.settings(), notificationVolume })).status, 200);
        assert.equal(app.store.settings().notificationVolume, notificationVolume);
      }
      for (const notificationVolume of [-1, 101, 1.5, '50']) {
        assert.equal((await post('/api/settings', { ...app.store.settings(), notificationVolume })).status, 400);
      }
      assert.equal((await post('/api/settings', { ...app.store.settings(), breakMinutes: 10 })).status, 400);
      assert.equal((await post('/api/settings', { name: '', model: 'unsupported-provider', teasing: 3 })).status, 400);
    });
    await t.test('toggles PC activity tracking from the tray', async () => {
      const paused = await post('/api/activity/toggle', { enabled: false });
      assert.equal(paused.status, 200); assert.equal(paused.data.settings.activityTracking, false);
      assert.equal(app.store.settings().activityTracking, false);
      assert.equal((await post('/api/activity/toggle', { enabled: 'false' })).status, 400);
      const resumed = await post('/api/activity/toggle', { enabled: true });
      assert.equal(resumed.status, 200); assert.equal(resumed.data.settings.activityTracking, true);
    });
    await t.test('applies persona, user preferences and explicit memories', async () => {
      assert.equal((await post('/api/key', { key: 'test-secret' })).status, 404);
      await post('/api/memory', { id: null, content: '월요일에는 오전 수업이 있어.' });
      assert.equal(typeof app.store.memories()[0].id, 'string');
      const result = await post('/api/chat', { text: '안녕' });
      assert.equal(result.status, 200); assert.equal(result.data.messages.length, 2);
      assert.match(captured.body.messages[0].content, /ASA/);
      assert.match(captured.body.messages[0].content, /팬메이드 AI 대화 상대/);
      assert.match(captured.body.messages[0].content, /이전 캐릭터/);
      assert.match(captured.body.messages[0].content, /월요일에는/);
      assert.doesNotMatch(captured.body.messages[0].content, /tsundere|츤데레|Fate/);
      assert.equal(captured.body.schema, undefined);
      assert.equal(captured.body.reasoningEffort, 'low');
      assert.equal(JSON.stringify(result.data).includes('test-secret'), false);
    });
    await t.test('feedback persists and refuses unknown rating', async () => {
      const message = app.store.messages().at(-1);
      assert.equal((await post('/api/feedback', { id: message.id, value: 'good' })).status, 200);
      assert.equal(app.store.messages().at(-1).feedback, 'good');
      await post('/api/feedback', { id: message.id, value: 'awkward', reason: 'tone' });
      assert.equal(app.store.messages().at(-1).feedback_reason, 'tone');
      assert.equal(app.store.context().length, 0);
      await post('/api/feedback', { id: message.id, value: 'good' });
      assert.equal(app.store.context().length, 2);
      assert.equal((await post('/api/feedback', { id: message.id, value: 'invalid' })).status, 400);
      assert.equal((await post('/api/feedback', { id: message.id, value: 'awkward', reason: 'invalid' })).status, 400);
    });
    await t.test('missed game notifications are listed and can be cleared', async () => {
      app.store.recordMissedNotification({ key: 'game-hidden:test', title: 'ASA · 놓친 알림', body: '게임 중이라 표시하지 않았어.' });
      let current = await (await fetch(`${base}/api/state`, { headers: { 'X-Rin-Token': session.token } })).json();
      assert.equal(current.missedNotifications.length, 1);
      assert.equal(current.missedNotifications[0].key, 'game-hidden:test');
      assert.equal((await post('/api/missed-notifications/clear', {})).data.missedNotifications.length, 0);
    });
    await t.test('memory correction preserves conversation and deletion excludes it', async () => {
      const id = app.store.memories()[0].id;
      await post('/api/memory', { id, content: '화요일 오후 수업' });
      assert.equal(app.store.context().length, 2);
      await post('/api/chat', { text: '수업 언제지?' });
      assert.doesNotMatch(captured.body.messages[0].content, /월요일에는/);
      assert.equal(captured.body.messages.length, 4);
      await post('/api/memory/delete', { id });
      await post('/api/chat', { text: '지금 기억은?' });
      assert.doesNotMatch(captured.body.messages[0].content, /화요일 오후 수업/);
      assert.equal(captured.body.messages.length, 2);
      assert.equal(app.store.messages().length, 6);
    });
    await t.test('creates, edits and validates weekly classes', async () => {
      assert.equal((await post('/api/class', { name: '자료구조', day: 1, start: '10:00', end: '09:00', location: '' })).status, 400);
      assert.equal((await post('/api/class', { name: '자료구조', day: 8, start: '09:00', end: '10:30', location: '' })).status, 400);
      const created = await post('/api/class', { id: null, name: '자료구조', day: 2, start: '09:00', end: '10:30', location: '공학관 301호' });
      assert.equal(created.status, 200); assert.equal(created.data.classes.length, 1);
      const id = created.data.classes[0].id;
      const edited = await post('/api/class', { id, name: '알고리즘', day: 3, start: '11:00', end: '12:30', location: '강의동 202호' });
      assert.equal(edited.data.classes[0].name, '알고리즘'); assert.equal(edited.data.classes[0].day, 3);
      assert.equal((await post('/api/class', { id: 'missing', name: '없음', day: 1, start: '09:00', end: '10:00', location: '' })).status, 404);
    });
    await t.test('creates, completes and validates academic items', async () => {
      assert.equal((await post('/api/academic', { title: '과제', course: '', kind: 'wrong', due: '2026-09-20T23:59', notes: '' })).status, 400);
      assert.equal((await post('/api/academic', { title: '과제', course: '', kind: 'assignment', due: '2026-02-30T23:59', notes: '' })).status, 400);
      const created = await post('/api/academic', { id: null, title: '그래프 과제', course: '알고리즘', kind: 'assignment', due: '2026-09-20T23:59', notes: 'LMS 제출' });
      assert.equal(created.status, 200); assert.equal(created.data.academics[0].completed, 0);
      const id = created.data.academics[0].id;
      const toggled = await post('/api/academic/toggle', { id, completed: true });
      assert.equal(toggled.data.academics[0].completed, 1);
      assert.equal(typeof toggled.data.academics[0].completed_at, 'string');
      const edited = await post('/api/academic', { id, title: '그래프 과제 수정', course: '알고리즘', kind: 'assignment', due: '2026-09-21T20:00', notes: '' });
      assert.equal(edited.data.academics[0].title, '그래프 과제 수정'); assert.equal(edited.data.academics[0].completed, 1);
      assert.equal((await post('/api/academic/toggle', { id, completed: 'yes' })).status, 400);
    });
    await t.test('creates, edits, completes and validates routines', async () => {
      assert.equal((await post('/api/routine', { title: '운동', category: 'wrong', days: [1], time: '20:00', notes: '' })).status, 400);
      assert.equal((await post('/api/routine', { title: '운동', category: 'exercise', days: [], time: '20:00', notes: '' })).status, 400);
      assert.equal((await post('/api/routine', { title: '운동', category: 'exercise', days: [1, 1], time: '20:00', notes: '' })).status, 400);
      const created = await post('/api/routine', { id: null, title: '저녁 스트레칭', category: 'exercise', days: [1, 3, 5], time: '20:00', notes: '20분' });
      assert.equal(created.status, 200); assert.equal(created.data.routines.length, 1); assert.deepEqual(created.data.routines[0].days, [1, 3, 5]);
      const id = created.data.routines[0].id;
      const toggled = await post('/api/routine/toggle', { id, completed: true });
      assert.equal(toggled.data.routines[0].completedToday, 1);
      assert.equal(app.store.routines('2099-01-01')[0].completedToday, 0);
      const edited = await post('/api/routine', { id, title: '저녁 걷기', category: 'exercise', days: [2, 4, 6], time: '19:30', notes: '' });
      assert.equal(edited.data.routines[0].title, '저녁 걷기'); assert.deepEqual(edited.data.routines[0].days, [2, 4, 6]);
      assert.equal((await post('/api/routine/toggle', { id, completed: 'yes' })).status, 400);
      const temporary = await post('/api/routine', { id: null, title: '삭제할 루틴', category: 'other', days: [7], time: '12:00', notes: '' });
      const temporaryId = temporary.data.routines.find(item => item.title === '삭제할 루틴').id;
      const removed = await post('/api/routine/delete', { id: temporaryId });
      assert.equal(removed.data.routines.some(item => item.id === temporaryId), false);
    });
    await t.test('creates, edits and validates daily health records', async () => {
      const now = new Date(); const pad = value => String(value).padStart(2, '0');
      const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
      assert.equal((await post('/api/health', { date: '2999-01-01', sleepMinutes: 420, meals: 3, water: 6, exerciseMinutes: 20, energy: 3, note: '' })).status, 400);
      const created = await post('/api/health', { date, sleepMinutes: 450, meals: 3, water: 7, exerciseMinutes: 25, energy: 4, note: '산책함' });
      assert.equal(created.status, 200); assert.equal(created.data.healthToday.sleep_minutes, 450); assert.equal(created.data.healthWeek.length, 1);
      const edited = await post('/api/health', { date, sleepMinutes: 480, meals: 2, water: 8, exerciseMinutes: 30, energy: 5, note: '수정' });
      assert.equal(edited.data.healthToday.sleep_minutes, 480); assert.equal(edited.data.healthWeek.length, 1);
      assert.equal((await post('/api/health', { date, sleepMinutes: 480, meals: 2, water: 8, exerciseMinutes: 30, energy: 8, note: '' })).status, 400);
    });
    await t.test('syncs e-Class items idempotently and validates imported data', async () => {
      const items = [
        { externalId: 'course-a:report:101', title: 'Python 코드 실습', course: '알고리즘', kind: 'assignment', due: localDueAfterDays(1, '23:59'), notes: 'e-Class Todo에서 가져온 일정' },
        { externalId: 'course-b:test:202', title: '중간고사', course: '게임수학', kind: 'exam', due: localDueAfterDays(30, '10:00'), notes: '' }
      ];
      assert.equal((await post('/api/eclass/sync', { items: [items[0], items[0]] })).status, 400);
      assert.equal((await post('/api/eclass/sync', { items: [{ ...items[0], due: 'not-a-date' }] })).status, 400);
      const first = await post('/api/eclass/sync', { items });
      assert.equal(first.status, 200); assert.equal(first.data.academics.length, 3);
      assert.equal(first.data.eclass.added, 2); assert.equal(first.data.eclass.received, 2);
      assert.equal(first.data.academics.filter(item => item.source === 'eclass').length, 2);
      const second = await post('/api/eclass/sync', { items: [{ ...items[0], title: 'Python 코드 실습 수정' }, items[1]] });
      assert.equal(second.data.academics.length, 3); assert.equal(second.data.eclass.added, 0); assert.equal(second.data.eclass.updated, 2);
      assert.equal(second.data.academics.some(item => item.title === 'Python 코드 실습 수정'), true);
      const partial = await post('/api/eclass/sync', { items: [{ ...items[0], title: 'Python 코드 실습 수정' }], snapshotComplete: false });
      assert.equal(partial.data.eclass.missing, 0);
      const missing = await post('/api/eclass/sync', { items: [{ ...items[0], title: 'Python 코드 실습 수정' }] });
      const missingExam = missing.data.academics.find(item => item.external_id === items[1].externalId);
      assert.equal(missing.data.eclass.missing, 1); assert.equal(typeof missingExam.missing_since, 'string');
      const kept = await post('/api/eclass/missing-action', { id: missingExam.id, action: 'keep' });
      assert.equal(kept.data.academics.find(item => item.id === missingExam.id).missing_since, null);
      assert.equal(kept.data.academics.find(item => item.id === missingExam.id).missing_ignored, 1);
      const ignored = await post('/api/eclass/sync', { items: [{ ...items[0], title: 'Python 코드 실습 수정' }] });
      assert.equal(ignored.data.eclass.missing, 0);
      await post('/api/eclass/sync', { items });
      const missingAgain = await post('/api/eclass/sync', { items: [{ ...items[0], title: 'Python 코드 실습 수정' }] });
      const completionCandidate = missingAgain.data.academics.find(item => item.external_id === items[1].externalId);
      const completedMissing = await post('/api/eclass/missing-action', { id: completionCandidate.id, action: 'complete' });
      assert.equal(completedMissing.data.academics.find(item => item.id === completionCandidate.id).completed, 1);
      assert.equal(completedMissing.data.academics.find(item => item.id === completionCandidate.id).missing_since, null);
      assert.equal((await post('/api/eclass/missing-action', { id: completionCandidate.id, action: 'wrong' })).status, 400);
      await post('/api/eclass/sync', { items: [{ ...items[0], title: 'Python 코드 실습 수정' }, items[1]] });
    });
    await t.test('handles urgent popup focus and snooze actions', async () => {
      const item = app.store.academics().find(value => value.title === 'Python 코드 실습 수정');
      const focused = await post('/api/reminder/action', { action: 'focus', itemId: item.id });
      assert.equal(focused.status, 200); assert.equal(focused.data.reminderControl.focus.itemId, item.id);
      assert.equal(new Date(focused.data.reminderControl.focus.ends) > new Date(), true);
      const snoozed = await post('/api/reminder/action', { action: 'snooze', itemId: item.id });
      assert.equal(snoozed.status, 200); assert.equal(snoozed.data.reminderControl.focus, null);
      assert.equal(new Date(snoozed.data.reminderControl.snoozes[item.id]) > new Date(), true);
      assert.equal((await post('/api/reminder/action', { action: 'wrong', itemId: item.id })).status, 400);
    });
    await t.test('answers with current schedule context and performs validated academic commands', async () => {
      const query = await post('/api/chat', { text: '가장 급한 일정 뭐야?' });
      assert.equal(query.status, 200);
      assert.equal(query.data.messages.at(-1).content, '제법이네. 같이 해보자.');

      structuredAnswer = { action: 'add', title: '운영체제 보고서', course: 'assignment', kind: 'assignment', due: '2026-10-30T23:59', notes: '모델이 만든 해석 설명', query: '', reason: '' };
      const added = await post('/api/chat', { text: '10월 30일까지 운영체제 보고서를 과제로 추가해 줘' });
      assert.equal(added.status, 200);
      const addedItem = added.data.academics.find(item => item.title === '운영체제 보고서');
      assert.equal(Boolean(addedItem && !addedItem.completed), true);
      assert.equal(addedItem.course, ''); assert.equal(addedItem.notes, '');
      assert.equal(added.data.messages.at(-1).schedule_action.itemId, addedItem.id);
      assert.equal(added.data.messages.at(-1).content, '제법이네. 같이 해보자.');

      structuredAnswer = { action: 'complete', title: '', course: '', kind: 'assignment', due: '', notes: '', query: '운영체제 보고서', reason: '' };
      const completed = await post('/api/chat', { text: '운영체제 보고서 과제 완료했어' });
      assert.equal(completed.status, 200);
      assert.equal(completed.data.academics.find(item => item.title === '운영체제 보고서').completed, 1);

      const count = completed.data.academics.length;
      structuredAnswer = { action: 'none', title: '', course: '', kind: 'assignment', due: '', notes: '', query: '', reason: '과제 이름과 날짜가 필요해.' };
      const ambiguous = await post('/api/chat', { text: '과제 하나 추가해 줘' });
      assert.equal(ambiguous.status, 200);
      assert.equal(ambiguous.data.academics.length, count);
      assert.equal(ambiguous.data.messages.at(-1).content, '제법이네. 같이 해보자.');
      structuredAnswer = null;
    });
    await t.test('provider failure is actionable and does not save a turn', async () => {
      mode = 'unavailable';
      const count = app.store.messages().length;
      const result = await post('/api/chat', { text: '실패할 요청' });
      assert.equal(result.status, 502); assert.match(result.data.error, /Codex/);
      assert.equal(app.store.messages().length, count);
      mode = 'ok';
    });
    await t.test('rejects malformed and oversized input', async () => {
      assert.equal((await post('/api/chat', null)).status, 400);
      assert.equal((await post('/api/chat', { text: 'a'.repeat(4001) })).status, 400);
      assert.equal((await post('/api/memory', { content: 'a'.repeat(501) })).status, 400);
    });
    await t.test('restart restores records but never session key', async () => {
      await new Promise(resolve => app.server.close(resolve));
      app = createApp({ dataPath, codexClient });
      await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${app.server.address().port}`;
      session = await (await fetch(`${base}/api/session`)).json();
      assert.equal(session.hasKey, undefined); assert.equal(session.settings.name, '테스트');
      assert.equal(session.messages.length, 14); assert.equal(session.messages[1].feedback, 'good');
      assert.equal(session.classes[0].name, '알고리즘');
      assert.equal(session.academics.some(item => item.title === '그래프 과제 수정' && item.completed === 1), true);
      assert.equal(session.academics.filter(item => item.source === 'eclass').length, 2);
      assert.equal(session.eclass.received, 2);
      assert.equal(session.routines[0].title, '저녁 걷기'); assert.equal(session.routines[0].completedToday, 1);
      assert.equal(session.activity.totalSeconds, 0); assert.deepEqual(session.activity.categories, { game: 0, study: 0, video: 0, other: 0 });
      assert.equal(session.healthToday.sleep_minutes, 480); assert.equal(session.healthWeek.length, 1);
      assert.equal(session.eveningReview.title, '아사 · 오늘 결산'); assert.equal(session.settings.eveningReviewUsageMinutes, 360);
    });
    await t.test('clear history removes feedback as well', async () => {
      const result = await post('/api/messages/clear', {});
      assert.equal(result.data.messages.length, 0); assert.equal(app.store.context().length, 0);
    });
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    assert.ok(dir.startsWith(join(tmpdir(), 'rin-test-')));
    rmSync(dir, { recursive: true });
  }
});

test('remote context preserves persona and newest turn within its larger budget', () => {
  const history = Array.from({ length: 48 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '옛'.repeat(1000) }));
  const request = buildRequest('ASA 성격', {}, [], history, '지금 질문');
  assert.equal(request.messages[0].role, 'system');
  assert.equal(request.messages.at(-1).content, '지금 질문');
  assert.ok(request.messages.length > 18 && request.messages.length < 50);
  assert.equal(request.messages[1].role, 'user');
  assert.throws(() => buildRequest('ASA 성격', {}, [{ content: '기억'.repeat(20000) }], [], '질문'), /한도/);
});

test('Codex connection failure propagates without invoking another inference provider', async () => {
  let calls = 0;
  await assert.rejects(generate({ request: { messages: [] }, codexClient: fakeCodex(async () => { calls++; throw new Error('Codex offline'); }) }), /Codex/);
  assert.equal(calls, 1);
});

test('explicit Korean dates override model date drift', () => {
  const now = new Date(2026, 8, 11, 18, 0);
  assert.equal(explicitKoreanDue('9월 30일까지 보고서 추가해 줘', now), '2026-09-30T23:59');
  assert.equal(explicitKoreanDue('10월 2일 오후 3시 30분 시험', now), '2026-10-02T15:30');
  assert.equal(explicitKoreanDue('2월 30일 과제', now), null);
});

test('only mutation-like academic messages invoke command interpretation', () => {
  assert.equal(shouldInterpretAcademicCommand('운영체제 과제 완료로 해 줘'), true);
  assert.equal(shouldInterpretAcademicCommand('이번 주 과제 뭐 있어?'), false);
  assert.equal(shouldInterpretAcademicCommand('오늘 이야기나 하자'), false);
});

test('Codex response reports the actual model and usage', async () => {
  const requests = [];
  const result = await generate({ request: { messages: [{ role: 'user', content: '안녕' }] }, codexClient: fakeCodex(async input => {
    requests.push(input); return codexResult('왔네.', { model: 'codex-response-model', usage: { total_tokens: 42 } });
  }) });
  assert.equal(result.provider, 'codex'); assert.equal(result.model, 'codex-response-model');
  assert.equal(result.usage.total_tokens, 42); assert.equal(requests.length, 1); assert.equal(requests[0].reasoningEffort, 'low');
});

test('Codex connection probe checks account availability without generating text', async () => {
  let probes = 0;
  const result = await probeAiConnections({ codexClient: fakeCodex(async () => assert.fail('probe must not generate'), {
    probe: async () => { probes++; return { available: false, reason: 'Codex login required' }; }
  }) });
  assert.equal(probes, 1); assert.equal(result.codex.available, false);
});

test('ASA fanmade AI keeps a nonromantic companion style without legacy personality intensity', () => {
  assert.equal(relationshipStyle({ tsundere: 0 }), relationshipStyle({ tsundere: 5 }));
  assert.match(relationshipStyle({}), /팬메이드 AI 대화 상대/);
  assert.match(relationshipStyle({}), /실제 아사 본인·공식 서비스·연인인 척하지 않는다/);
  assert.match(relationshipStyle({ teasing: 0 }), /장난을 덧붙이지 않고/);
  assert.match(relationshipStyle({ teasing: 3 }), /친한 여사친/);
  assert.equal(isAffectionTrigger('ASA 오늘 너무 귀여워'), true);
  assert.equal(isAffectionTrigger('내 일정 몇 시까지야?'), false);
});

for (const answer of ['고마워. 재미있게 얘기하자.', '프로세스마다 메모리 공간이 분리돼 있어. 필요하면 IPC로 데이터를 주고받아.', '귀찮아도 해야 해. 귀찮아도 해야 해.']) test('ordinary conversation uses one Codex generation: ' + answer, async () => {
  let calls = 0;
  const result = await generate({ request: { messages: [{ role: 'user', content: '이야기해줘' }] }, codexClient: fakeCodex(async () => { calls++; return codexResult(answer); }) });
  assert.equal(result.answer, answer); assert.equal(calls, 1);
});

test('provider rejects empty or unavailable Codex output instead of displaying false success', async () => {
  for (const body of [{}, codexResult('')]) await assert.rejects(generate({ request: { messages: [] }, codexClient: fakeCodex(async () => body) }));
});
