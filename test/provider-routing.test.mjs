import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate, interpretAcademicCommand, runCodex } from '../app/provider.mjs';
import { extractMemories } from '../app/memory.mjs';
import { createApp } from '../app/server.mjs';
import { codexResult, fakeCodex } from './helpers/codex.mjs';
const schedule = { action: 'add', title: '운영체제 시험', course: '운영체제', kind: 'exam', due: '', notes: '', query: '', reason: '' };

test('Codex structured schedule validates before success and uses explicit Korean dates', async () => {
  const requests = [], statuses = [];
  const result = await interpretAcademicCommand({ text: '내일 오후 3시 30분 운영체제 시험 있어', academics: [], now: new Date(2026, 9, 19), onResult: value => statuses.push(value), codexClient: fakeCodex(async request => {
    requests.push(request); return codexResult(schedule);
  }) });
  assert.equal(result.due, '2026-10-20T15:30'); assert.equal(requests.length, 1);
  assert.equal(requests[0].schema.type, 'object'); assert.equal(requests[0].reasoningEffort, 'low');
  assert.equal(statuses.length, 1); assert.equal(statuses[0].status, 'success'); assert.equal(statuses[0].model, 'codex-test-model');
});

test('invalid schedule and memory JSON never report success or invoke another provider', async () => {
  for (const value of ['{"action":', { action: 'add' }, { action: 'complete' }]) {
    let calls = 0; const statuses = [];
    await assert.rejects(interpretAcademicCommand({ text: '내일 시험 있어', academics: [], onResult: status => statuses.push(status), codexClient: fakeCodex(async () => { calls++; return codexResult(value); }) }));
    assert.equal(calls, 1); assert.equal(statuses[0].status, 'failed'); assert.match(statuses[0].error, /형식/);
  }
  const statuses = [];
  const result = await extractMemories({ text: '나는 컴퓨터공학 전공이야', memories: [], codexClient: fakeCodex(async () => codexResult({})), onResult: status => statuses.push(status) });
  assert.deepEqual(result, { operations: [], status: 'unavailable' }); assert.equal(statuses[0].status, 'failed');
});

test('Codex authentication quota and timeout failures preserve reasons without fallback or retries', async () => {
  for (const [status, code] of [[401, 'login_required'], [429, 'quota'], [504, 'timeout']]) {
    let calls = 0; const statuses = [];
    await assert.rejects(runCodex({ messages: [], codexClient: fakeCodex(async () => { calls++; throw Object.assign(new Error('Codex ' + code), { status, code, model: 'codex-test-model' }); }), onResult: value => statuses.push(value) }), error => error.status === status && error.code === code);
    assert.equal(calls, 1); assert.equal(statuses[0].provider, 'codex'); assert.equal(statuses[0].status, 'failed'); assert.equal(statuses[0].errorCode, code);
  }
});

test('schedule clarification accepts 200 characters but rejects an oversized reason before success', async () => {
  for (const length of [200, 201]) {
    const statuses = [];
    const pending = interpretAcademicCommand({ text: '다음 회의 등록해줘', academics: [],
      codexClient: fakeCodex(async () => codexResult({ action: 'none', reason: '가'.repeat(length) })),
      onResult: value => statuses.push(value) });
    if (length === 200) {
      assert.equal((await pending).reason.length, 200);
      assert.equal(statuses[0].status, 'success');
    } else {
      await assert.rejects(pending, error => error.status === 502);
      assert.equal(statuses[0].status, 'failed');
      assert.match(statuses[0].error, /형식/);
    }
  }
});

test('Codex structured parse failures preserve token usage and actual model diagnostics', async () => {
  const statuses = [];
  await assert.rejects(runCodex({ messages: [], schema: { type: 'object' }, parse: JSON.parse, codexClient: fakeCodex(async () => codexResult('broken', { model: 'codex-actual-model', usage: { total_tokens: 32 } })), onResult: value => statuses.push(value) }), error => error.usage.total_tokens === 32);
  assert.equal(statuses[0].model, 'codex-actual-model'); assert.equal(statuses[0].status, 'failed');
});

test('failed memory extraction preserves return shape and emits Codex failure diagnostics', async () => {
  const statuses = [];
  const result = await extractMemories({ text: '나는 컴퓨터공학 전공이야', memories: [], codexClient: fakeCodex(async () => { throw new Error('Codex unavailable'); }), onResult: value => statuses.push(value) });
  assert.deepEqual(result, { operations: [], status: 'unavailable' }); assert.equal(statuses.length, 1);
  assert.equal(statuses[0].provider, 'codex'); assert.match(statuses[0].error, /unavailable/);
});

test('server reports generated replies for schedule actions and queries while retaining memory diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-provider-routing-'));
  let mode = 'normal', release, entered;
  const app = createApp({ dataPath: join(dir, 'rin.sqlite'), codexClient: fakeCodex(async body => {
    const memory = Boolean(body.schema?.properties?.memories);
    if (memory && mode === 'pending') { entered(); await new Promise(resolve => { release = resolve; }); }
    if (memory && mode === 'failure') throw Object.assign(new Error('Codex memory quota'), { code: 'quota', status: 429 });
    return codexResult(memory ? { memories: [] } : body.schema ? schedule : '프로세스마다 메모리 공간이 분리돼 있어.');
  }) });
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const state = async () => (await fetch(`${base}/api/session`)).json();
    const chat = async text => {
      const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token }, body: JSON.stringify({ text }) });
      assert.equal(response.status, 200); return response.json();
    };
    await app.refreshProviderStatus();
    let result = await state();
    assert.equal(result.provider, null); assert.equal(result.providerStatus.model, null);
    assert.equal(result.providerStatus.lastSuccess, null); assert.equal(result.providerStatus.codex.available, true);

    result = await chat('나는 컴공 전공이야. 내일 오후 3시 30분 운영체제 시험 있어');
    assert.equal(result.providerStatus.stage, 'chat'); assert.equal(result.providerStatus.model, 'codex-test-model');
    assert.equal(result.providerStatus.stages.schedule.status, 'success');
    assert.equal(result.providerStatus.stages.memory.provider, 'codex'); assert.equal(result.academics.length, 1);

    mode = 'failure';
    result = await chat('나는 컴공 전공이야. 프로세스의 메모리 공간을 알려줘');
    assert.equal(result.providerStatus.stage, 'chat'); assert.equal(result.providerStatus.provider, 'codex');
    assert.equal(result.providerStatus.stages.memory.provider, 'codex'); assert.equal(result.providerStatus.stages.memory.status, 'failed'); assert.match(result.providerStatus.stages.memory.error, /quota/);
    assert.equal(result.providerStatus.fallbackReason, ''); assert.equal(result.providerStatus.stages.schedule, undefined);

    mode = 'pending';
    const waiting = new Promise(resolve => { entered = resolve; });
    const pendingChat = chat('이번 주 시험 뭐 있어? 답변은 짧게 해줘');
    await waiting;
    result = await state();
    assert.equal(result.busy, true); assert.equal(result.providerStatus.model, 'codex-test-model');
    assert.equal(result.provider, 'codex'); assert.equal(result.providerStatus.stages.memory.status, 'pending');
    assert.equal(result.providerStatus.stages.schedule, undefined);
    mode = 'normal'; release();
    result = await pendingChat;
    assert.equal(result.providerStatus.status, 'success'); assert.equal(result.providerStatus.model, 'codex-test-model');
    assert.equal(result.provider, 'codex'); assert.ok(result.providerStatus.lastSuccess);
    assert.equal(result.providerStatus.stages.memory.provider, 'codex');
    assert.equal(result.providerStatus.stages.chat.status, 'success');
  } finally {
    release?.();
    if (app.server.listening) await new Promise(resolve => app.server.close(resolve));
    else app.store.close();
    assert.ok(dir.startsWith(join(tmpdir(), 'rin-provider-routing-')));
    rmSync(dir, { recursive: true });
  }
});

test('a slow connectivity probe cannot overwrite a newer completed chat status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-provider-probe-'));
  let releaseProbe;
  const probeGate = new Promise(resolve => { releaseProbe = resolve; });
  const app = createApp({ dataPath: join(dir, 'rin.sqlite'), codexClient: fakeCodex(async () => codexResult('왔네. 오늘은 무슨 얘기할래?', { model: 'codex-newest-response' }), { probe: async () => { await probeGate; return { available: true }; } }) });
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const pendingProbe = app.refreshProviderStatus();
    const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token }, body: JSON.stringify({ text: '안녕' }) });
    assert.equal(response.status, 200);
    const completed = await response.json();
    assert.equal(completed.providerStatus.stage, 'chat'); assert.equal(completed.providerStatus.model, 'codex-newest-response');
    releaseProbe(); await pendingProbe;
    const current = await (await fetch(`${base}/api/session`)).json();
    assert.equal(current.providerStatus.provider, 'codex'); assert.equal(current.providerStatus.stage, 'chat');
    assert.equal(current.providerStatus.model, completed.providerStatus.model);
    assert.equal(current.providerStatus.lastSuccess, completed.providerStatus.lastSuccess);
    assert.deepEqual(current.providerStatus.stages, completed.providerStatus.stages);
    assert.equal(current.providerStatus.codex.available, true);
  } finally {
    releaseProbe();
    if (app.server.listening) await new Promise(resolve => app.server.close(resolve));
    else app.store.close();
    assert.ok(dir.startsWith(join(tmpdir(), 'rin-provider-probe-')));
    rmSync(dir, { recursive: true });
  }
});
