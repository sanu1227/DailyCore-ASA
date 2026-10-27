import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexClient } from '../app/codex.mjs';

function harness(t, { handle, account = { type: 'chatgpt' }, model = 'configured-model', threadPatch, timeoutMs = 500, efforts = ['low'] } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'rin-codex-test-'));
  const calls = [], children = [], spawns = [];
  let sequence = 0;
  const send = (child, message) => child.stdout.write(`${JSON.stringify(message)}\n`);
  const notify = (child, method, params) => send(child, { method, params });
  const reply = (child, request, result) => send(child, { id: request.id, result });
  const client = createCodexClient({ cwd, executable: 'fake-codex', timeoutMs, startupTimeoutMs: 500,
    spawnImpl(executable, args, options) {
      spawns.push({ executable, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.kill = () => { child.killed = true; child.stdout.end(); child.stderr.end(); queueMicrotask(() => child.emit('exit', 0)); };
      child.stdin = new Writable({ write(chunk, _, callback) {
        const request = JSON.parse(chunk.toString()); calls.push(request);
        queueMicrotask(() => {
          if (handle?.({ child, request, reply: result => reply(child, request, result), send: message => send(child, message), notify: (method, params) => notify(child, method, params) })) return;
          if (request.id === undefined || !request.method) return;
          if (request.method === 'initialize') reply(child, request, {});
          else if (request.method === 'account/read') reply(child, request, { account });
          else if (request.method === 'config/read') reply(child, request, { config: { model } });
          else if (request.method === 'model/list') reply(child, request, { data: [model, 'gpt-6.1-sol'].map(value => ({ id: value, model: value, isDefault: value === model, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) })) });
          else if (request.method === 'thread/start') reply(child, request, { thread: { id: `thread-${++sequence}` }, model: request.params.model || model, modelProvider: 'openai', instructionSources: [], approvalPolicy: 'never', sandbox: { type: 'readOnly' }, ...threadPatch });
          else if (request.method === 'turn/start') {
            const threadId = request.params.threadId, turnId = `turn-${threadId}`;
            reply(child, request, { turn: { id: turnId, status: 'inProgress' } });
            queueMicrotask(() => complete(child, threadId, '안녕'));
          } else reply(child, request, {});
        });
        callback();
      } });
      children.push(child); return child;
    },
  });
  function complete(child, threadId, text, { status = 'completed', error, usage = true, streamed = text } = {}) {
    const turnId = `turn-${threadId}`, item = { id: `item-${threadId}`, type: 'agentMessage', phase: 'final_answer', text };
    notify(child, 'item/started', { threadId, turnId, item: { ...item, text: '' } });
    if (streamed) notify(child, 'item/agentMessage/delta', { threadId, turnId, itemId: item.id, delta: streamed });
    if (usage) notify(child, 'thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { total: { totalTokens: 9, inputTokens: 6, outputTokens: 3, reasoningOutputTokens: 1, cachedInputTokens: 2 } } });
    notify(child, 'turn/completed', { threadId, turn: { id: turnId, status, items: [item], error } });
  }
  t.after(() => { client.close(); rmSync(cwd, { recursive: true, force: true }); });
  return { client, calls, children, spawns, complete, notify, reply };
}

const input = [{ role: 'system', content: '린처럼 짧게 답해.' }, { role: 'user', content: '안녕' }];

test('Codex pins Rin replies and connection status to 6.1 sol without changing global configuration', async t => {
  const h = harness(t); assert.equal(h.spawns.length, 0);
  const chunks = [], result = await h.client.generate({ messages: input, onDelta: text => chunks.push(text) });
  assert.equal(result.text, '안녕'); assert.deepEqual(chunks, ['안녕']); assert.equal(result.model, 'gpt-6.1-sol');
  assert.deepEqual(await h.client.probe(), { available: true, model: 'gpt-6.1-sol' });
  assert.equal(h.calls.some(call => call.method?.startsWith('config/')), false);
  assert.deepEqual(result.usage, { total_tokens: 9, input_tokens: 6, output_tokens: 3, reasoning_tokens: 1, cached_input_tokens: 2 });
  assert.ok(result.firstTokenMs >= 0 && result.elapsedMs >= result.firstTokenMs);
  const { args, options } = h.spawns[0];
  assert.equal(options.windowsHide, true); assert.equal(options.shell, false);
  for (const flag of ['--strict-config', 'forced_login_method="chatgpt"', 'model_provider="openai"', 'features.shell_tool=false', 'features.apps=false', 'features.memories=false', 'skills.include_instructions=false']) assert.ok(args.includes(flag), flag);
  const thread = h.calls.find(call => call.method === 'thread/start').params;
  assert.equal(thread.ephemeral, true); assert.equal(thread.approvalPolicy, 'never'); assert.equal(thread.sandbox, 'read-only');
  assert.equal(thread.allowProviderModelFallback, false); assert.deepEqual(thread.environments, []); assert.deepEqual(thread.dynamicTools, []);
  assert.equal(thread.developerInstructions, input[0].content); assert.equal(thread.model, 'gpt-6.1-sol');
  assert.equal(h.calls.find(call => call.method === 'turn/start').params.effort, 'low');
  assert.equal(h.calls.filter(call => call.method === 'thread/unsubscribe').length, 1);
});

test('concurrent replies use independent ephemeral threads on one process', async t => {
  const starts = [];
  const h = harness(t, { handle({ request, reply }) {
    if (request.method !== 'turn/start') return false;
    starts.push(request.params.threadId); reply({ turn: { id: `turn-${request.params.threadId}` } }); return true;
  } });
  const a = [], b = [];
  const pendingA = h.client.generate({ messages: input, onDelta: value => a.push(value) });
  const pendingB = h.client.generate({ messages: input, onDelta: value => b.push(value) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts.length, 2); assert.equal(h.spawns.length, 1);
  h.complete(h.children[0], starts[1], '두 번째'); h.complete(h.children[0], starts[0], '첫 번째');
  assert.deepEqual((await Promise.all([pendingA, pendingB])).map(value => value.text), ['첫 번째', '두 번째']);
  assert.deepEqual(a, ['첫 번째']); assert.deepEqual(b, ['두 번째']);
});

test('structured output is passed to Codex and incomplete JSON is rejected', async t => {
  const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
  const h = harness(t, { efforts: ['high'], handle({ request, reply, child }) {
    if (request.method !== 'turn/start') return false;
    reply({ turn: { id: `turn-${request.params.threadId}` } });
    queueMicrotask(() => h.complete(child, request.params.threadId, '{"answer":'));
    return true;
  } });
  let resets = 0;
  await assert.rejects(h.client.generate({ messages: input, schema, onReset: () => resets++ }), { code: 'protocol' });
  const turn = h.calls.find(call => call.method === 'turn/start').params;
  assert.deepEqual(turn.outputSchema, schema); assert.equal(turn.effort, undefined); assert.equal(resets, 1);
});

test('quota failure clears partial output without switching model or retrying', async t => {
  const h = harness(t, { handle({ request, reply, child }) {
    if (request.method !== 'turn/start') return false;
    reply({ turn: { id: `turn-${request.params.threadId}` } });
    queueMicrotask(() => h.complete(child, request.params.threadId, '부분', { status: 'failed', error: { message: 'secret server detail', codexErrorInfo: 'usageLimitExceeded' } }));
    return true;
  } });
  let resets = 0;
  await assert.rejects(h.client.generate({ messages: input, onReset: () => resets++ }), error => error.status === 429 && error.code === 'quota' && !error.message.includes('secret'));
  assert.equal(resets, 1); assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('authentication failure is safe and never starts a conversation', async t => {
  const h = harness(t, { account: { type: 'apiKey' } });
  assert.equal((await h.client.probe()).available, false);
  await assert.rejects(h.client.generate({ messages: input }), { code: 'auth', status: 401 });
  assert.equal(h.calls.filter(call => call.method === 'thread/start').length, 0);
});

test('writable sandbox or permissive approvals fail closed before inference', async t => {
  for (const threadPatch of [{ approvalPolicy: 'on-request' }, { sandbox: { type: 'workspaceWrite' } }]) {
    const h = harness(t, { threadPatch });
    await assert.rejects(h.client.generate({ messages: input }), { code: 'isolation' });
    assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 0);
    assert.equal(h.calls.filter(call => call.method === 'thread/unsubscribe').length, 1);
  }
});

test('discovered instruction paths alone do not reject a safely configured thread', async t => {
  const h = harness(t, { threadPatch: { instructionSources: ['C:/codex/AGENTS.md'] } });
  assert.equal((await h.client.generate({ messages: input })).text, '안녕');
  assert.ok(h.spawns[0].args.includes('project_doc_max_bytes=0'));
});

test('custom or local provider cannot enter the ChatGPT-only transport', async t => {
  const h = harness(t, { threadPatch: { modelProvider: 'ollama' } });
  await assert.rejects(h.client.generate({ messages: input }), { code: 'isolation' });
  assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('unexpected thread model is rejected before inference instead of silently falling back', async t => {
  const h = harness(t, { threadPatch: { model: 'gpt-6-astra' } });
  await assert.rejects(h.client.generate({ messages: input }), { code: 'modelChanged', model: 'gpt-6-astra' });
  assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.equal(h.calls.filter(call => call.method === 'thread/unsubscribe').length, 1);
});

test('model rerouting is rejected and late deltas cannot revive partial output', async t => {
  const h = harness(t, { handle({ request, reply, notify }) {
    if (request.method !== 'turn/start') return false;
    const threadId = request.params.threadId;
    reply({ turn: { id: `turn-${threadId}` } });
    notify('item/agentMessage/delta', { threadId, itemId: 'a', delta: '부분' });
    notify('model/rerouted', { threadId, fromModel: 'gpt-6.1-sol', toModel: 'another-model' });
    notify('item/agentMessage/delta', { threadId, itemId: 'a', delta: '늦은 응답' });
    return true;
  } });
  const chunks = []; let resets = 0;
  await assert.rejects(h.client.generate({ messages: input, onDelta: text => chunks.push(text), onReset: () => resets++ }), { code: 'modelChanged' });
  assert.deepEqual(chunks, ['부분']); assert.equal(resets, 1);
});

test('tool requests are denied and the turn is interrupted', async t => {
  const h = harness(t, { handle({ request, reply, send }) {
    if (request.method !== 'turn/start') return false;
    reply({ turn: { id: `turn-${request.params.threadId}` } });
    send({ id: 'tool-1', method: 'item/commandExecution/requestApproval', params: { threadId: request.params.threadId } });
    return true;
  } });
  await assert.rejects(h.client.generate({ messages: input }), { code: 'tools' });
  assert.equal(h.calls.find(call => call.id === 'tool-1').error.code, -32601);
});

test('abort during thread creation unsubscribes without starting inference', async t => {
  const controller = new AbortController();
  const h = harness(t, { handle({ request }) { if (request.method === 'thread/start') controller.abort(); return false; } });
  await assert.rejects(h.client.generate({ messages: input, signal: controller.signal }), { code: 'cancelled' });
  assert.equal(h.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.equal(h.calls.filter(call => call.method === 'thread/unsubscribe').length, 1);
});

test('timeout interrupts an unfinished turn and returns no successful answer', async t => {
  const h = harness(t, { timeoutMs: 30, handle({ request, reply }) {
    if (request.method !== 'turn/start') return false;
    reply({ turn: { id: `turn-${request.params.threadId}` } }); return true;
  } });
  await assert.rejects(h.client.generate({ messages: input }), { code: 'timeout', status: 504 });
  assert.equal(h.calls.filter(call => call.method === 'turn/interrupt').length, 1);
});

test('process crash rejects the turn and the next request reconnects', async t => {
  let crash = true;
  const h = harness(t, { handle({ request, child }) {
    if (request.method === 'turn/start' && crash) { crash = false; child.emit('exit', 1); return true; }
    return false;
  } });
  await assert.rejects(h.client.generate({ messages: input }), { code: 'crash' });
  assert.equal((await h.client.generate({ messages: input })).text, '안녕'); assert.equal(h.spawns.length, 2);
});
