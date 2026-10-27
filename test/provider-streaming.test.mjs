import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, generate } from '../app/provider.mjs';
import { codexResult, fakeCodex } from './helpers/codex.mjs';
const request = { messages: [{ role: 'user', content: '프로세스가 뭐야?' }] };
const display = () => {
  const state = { text: '', resets: 0, chunks: [] };
  return { state, onDelta: delta => { state.text += delta; state.chunks.push(delta); }, onReset: () => { state.text = ''; state.resets++; } };
};

test('Codex streams Korean text before completion and reports actual model and usage', async () => {
  let release, firstDelta, completed = false;
  const held = new Promise(resolve => { release = resolve; }), first = new Promise(resolve => { firstDelta = resolve; });
  const ui = display(), statuses = [];
  const pending = generate({ request, ...ui, onResult: value => statuses.push(value), codexClient: fakeCodex(async input => {
    assert.equal(input.reasoningEffort, 'low'); input.onDelta('프로세스는 '); firstDelta(); await held;
    input.onDelta('실행 중인 프로그램이야.');
    return codexResult('프로세스는 실행 중인 프로그램이야.', { model: 'codex-actual-model', usage: { total_tokens: 30 } });
  }) }).then(result => { completed = true; return result; });
  await first; assert.equal(completed, false); assert.equal(ui.state.text, '프로세스는 '); release();
  const result = await pending; assert.equal(result.answer, ui.state.text); assert.equal(result.model, 'codex-actual-model');
  assert.equal(result.usage.total_tokens, 30); assert.equal(statuses[0].status, 'success'); assert.equal(ui.state.resets, 0);
});

test('Codex interrupted and timed out streams clear partial output and never report success', async () => {
  for (const code of ['interrupted', 'timeout']) {
    let calls = 0; const ui = display(), statuses = [];
    await assert.rejects(generate({ request, ...ui, onResult: value => statuses.push(value), codexClient: fakeCodex(async input => {
      calls++; input.onDelta('중간 답변'); throw Object.assign(new Error('Codex ' + code), { code });
    }) }), new RegExp(code));
    assert.equal(calls, 1); assert.equal(ui.state.text, ''); assert.equal(ui.state.resets, 1);
    assert.equal(statuses.length, 1); assert.equal(statuses[0].status, 'failed'); assert.equal(statuses[0].errorCode, code);
  }
});

test('Codex request passes cancellation and reset callbacks to the account client', async () => {
  const controller = new AbortController(), ui = display();
  const result = await generate({ request, ...ui, signal: controller.signal, codexClient: fakeCodex(async input => {
    assert.equal(input.signal, controller.signal); input.onDelta('이전 조각'); input.onReset(); input.onDelta('최종 답변');
    return codexResult('최종 답변');
  }) });
  assert.equal(result.answer, '최종 답변'); assert.equal(ui.state.text, result.answer); assert.equal(ui.state.resets, 1);
});

test('ordinary and repetitive Codex answers require a single generation', async () => {
  for (const text of ['설명은 필요한 만큼 길어도 돼. '.repeat(20), '같은 문장이 반복돼. 같은 문장이 반복돼.']) {
    let calls = 0; const ui = display();
    const result = await generate({ request, ...ui, codexClient: fakeCodex(async input => { calls++; input.onDelta(text); return codexResult(text); }) });
    assert.equal(result.answer, text.trim()); assert.equal(calls, 1); assert.equal(ui.state.resets, 0);
  }
});

test('casual prompts omit schedule data and prefer current corrections and memories', () => {
  const companion = { memoryActionResult: { status: 'pending', saved: [] }, schedule: { classes: [{ name: '운영체제', day: 2 }], academics: [{ title: '운영체제 시험' }], gameAdvice: { allowed: false } } };
  const casual = buildRequest('페르소나', {}, [{ content: '나는 컴퓨터공학 전공이야' }], [], '요즘 듣는 노래 이야기하자', companion).messages[0].content;
  assert.doesNotMatch(casual, /weeklyClasses|openAcademics|운영체제 시험/);
  assert.match(casual, /현재 사용자 정정 > 최신 memories > 과거 대화/);
  assert.match(casual, /pending이면.*저장 완료를 말하지/);
  const relevant = buildRequest('페르소나', {}, [], [], '게임해도 돼?', companion).messages[0].content;
  assert.match(relevant, /weeklyClasses/); assert.match(relevant, /운영체제 시험/); assert.match(relevant, /gameAdvice/);
});

test('Codex preserves the larger recent context without a local fallback budget', async () => {
  const history = Array.from({ length: 16 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: index + ' ' + '옛'.repeat(1000) }));
  const body = buildRequest('페르소나', {}, [], history, '지금 질문');
  assert.equal(body.messages.length, 18); assert.equal(body.model, 'codex'); assert.equal(body.options, undefined);
  await generate({ request: body, codexClient: fakeCodex(async input => {
    assert.equal(input.messages.length, 18); assert.equal(input.messages[0].role, 'system'); assert.equal(input.messages.at(-1).content, '지금 질문');
    return codexResult('현재 질문에 답할게.');
  }) });
  assert.equal(body.messages.length, 18);
});
