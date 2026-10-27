import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app/server.mjs';
import { codexResult, fakeCodex } from './helpers/codex.mjs';

const contextOf = input => JSON.parse(input.messages[0].content.split('현재 데이터:\n').at(-1));
const intent = { action: 'add', title: '팀플 회의', kind: 'event', course: '', due: '', reason: '' };

async function fixture(generate, run) {
  const dir = mkdtempSync(join(tmpdir(), 'rin-generated-chat-'));
  const app = createApp({ dataPath: join(dir, 'rin.sqlite'), codexClient: fakeCodex(generate) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (text, stream = false) => fetch(`${base}/api/chat`, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Rin-Token': app.token, ...(stream ? { Accept: 'application/x-ndjson' } : {}),
  }, body: JSON.stringify({ text }) });
  try { await run({ app, base, post }); }
  finally { await new Promise(resolve => app.server.close(resolve)); rmSync(dir, { recursive: true }); }
}

test('every former direct reply uses the model and includes schedule, routine, activity and health facts', async () => {
  let calls = 0;
  await fixture(async input => {
    assert.equal(input.schema, undefined);
    const context = contextOf(input);
    for (const key of ['weeklyClasses', 'todayClasses', 'todayRoutines', 'openAcademics', 'todayActivity', 'recentHealth', 'gameAdvice']) assert.ok(key in context, key);
    input.onDelta?.(`모델 응답 ${++calls}`);
    return codexResult(`모델 응답 ${calls}`);
  }, async ({ post }) => {
    for (const message of ['오늘 수업 뭐 있어?', '이번 주 과제 뭐 있어?', '가장 급한 게 뭐야?', '지금 게임해도 돼?', '오늘 루틴 뭐야?', '오늘 컴퓨터 얼마나 했어?', '이번 주 생활 어땠어?']) {
      const response = await post(message, true);
      const events = (await response.text()).trim().split('\n').map(JSON.parse);
      assert.equal(events.at(-1).type, 'done');
      assert.equal(events.at(-1).messages.at(-1).content, `모델 응답 ${calls}`);
      assert.ok(events.some(event => event.type === 'delta'));
      assert.equal(events.at(-1).providerStatus.stage, 'chat');
    }
    assert.equal(calls, 7);
  });
});

test('clarification is neither forced nor blocked and all mutation replies come from the model', async () => {
  let calls = 0;
  await fixture(async input => {
    if (input.schema?.properties?.memories) return codexResult({ memories: [] });
    if (input.schema) return codexResult(input.messages.at(-1).content.endsWith('"팀플 회의 완료했어"') ? { action: 'complete', query: '팀플 회의' } : intent);
    calls++;
    assert.match(input.messages[0].content, /질문 여부와 내용은 현재 대화에 맞춰 자연스럽게 판단한다/);
    assert.doesNotMatch(input.messages[0].content, /needs_details\/failed면 빠진 정보 하나만 묻는다/);
    return codexResult(calls === 1 ? '회의는 몇 시야?' : '그 얘기였구나.');
  }, async ({ app, post }) => {
    for (const message of ['내일 팀플 회의 있어', '모레 3시 팀플 회의 있어', '매주 팀플 회의 있어']) {
      const state = await (await post(message)).json();
      assert.equal(state.messages.at(-1).content, calls === 1 ? '회의는 몇 시야?' : '그 얘기였구나.');
      assert.equal(state.academics.length, 0);
      assert.equal(state.messages.at(-1).schedule_action, null);
    }
    for (const [message, action] of [
      ['아니야 취소', null], ['내일 오후 3시 팀플 회의 있어', 'add'],
      ['내일 오후 3시 팀플 회의 있어', 'existing'], ['그 회의 오후 4시로 바꿔줘', 'update'],
      ['그 회의 취소해줘', 'cancel'], ['그 회의 다시 잡혔어', 'restore'], ['팀플 회의 완료했어', 'complete'],
    ]) {
      const state = await (await post(message)).json();
      assert.equal(state.messages.at(-1).content, '그 얘기였구나.');
      assert.equal(state.messages.at(-1).schedule_action?.action || null, action);
    }
    assert.equal(calls, 10);
    assert.equal(app.store.academics()[0].completed, 1);
  });
});

test('model and receipt failures leave schedules and drafts intact without streaming a false success', async () => {
  let failModel = true;
  await fixture(async input => {
    if (input.schema) return codexResult(intent);
    assert.equal(contextOf(input).scheduleActionResult.status, 'ready');
    assert.equal(input.onDelta, undefined);
    if (failModel) throw new Error('Model unavailable');
    return codexResult('처리했어.');
  }, async ({ app, post }) => {
    const originalDraft = { title: '이전 일정', created: 0 };
    app.store.saveIntegration('schedule_draft', originalDraft);
    for (const failure of ['model', 'receipt']) {
      if (failure === 'receipt') { failModel = false; app.store.addPair = () => { throw new Error('Receipt failed'); }; }
      const events = (await (await post('내일 오후 3시 팀플 회의 있어', true)).text()).trim().split('\n').map(JSON.parse);
      assert.equal(events.at(-1).type, 'error');
      assert.equal(events.some(event => event.type === 'delta' || event.type === 'done'), false);
      assert.equal(app.store.academics().length, 0);
      assert.equal(app.store.messages().length, 0);
      assert.deepEqual(app.store.integration('schedule_draft'), originalDraft);
    }
  });
});

test('planned changes stay invisible while generation runs and competing mutations are blocked', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  await fixture(async input => {
    if (input.schema) return codexResult(intent);
    entered(); await gate;
    return codexResult('일정에 반영했어.');
  }, async ({ app, base, post }) => {
    const pending = post('내일 오후 3시 팀플 회의 있어');
    try {
      await ready;
      const state = await (await fetch(`${base}/api/session`)).json();
      assert.equal(state.busy, true); assert.equal(state.academics.length, 0);
      assert.equal(app.store.academics().length, 0);
      const mutation = await fetch(`${base}/api/activity/toggle`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token }, body: JSON.stringify({ enabled: false }) });
      assert.equal(mutation.status, 409);
    } finally { release(); }
    const state = await (await pending).json();
    assert.equal(state.academics.length, 1);
    assert.equal(state.messages.at(-1).schedule_action.itemId, state.academics[0].id);
  });
});
