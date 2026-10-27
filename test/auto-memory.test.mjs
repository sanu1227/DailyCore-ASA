import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractMemories, projectMemories, validateMemories } from '../app/memory.mjs';
import { Store } from '../app/store.mjs';
import { createApp } from '../app/server.mjs';

const fact = (content, evidence = content, id = '') => ({ id, content, evidence });
import { codexResult, fakeCodex } from './helpers/codex.mjs';
const memoryResult = memories => codexResult({ memories });

test('automatic memories require valid evidence, known IDs and bounded content', () => {
  const existing = [{ id: 'major', content: '컴퓨터공학 전공이다.' }];
  const text = '나는 디자인 전공으로 바꿨어. 답변은 짧게 해줘.';
  const valid = validateMemories({ memories: [
    fact('디자인 전공이다.', '디자인 전공으로 바꿨어', 'major'),
    fact('짧은 답변을 선호한다.', '답변은 짧게 해줘')
  ] }, text, existing);
  assert.deepEqual(valid, { operations: [
    { id: 'major', content: '디자인 전공이다.' },
    { id: null, content: '짧은 답변을 선호한다.' }
  ], status: 'ready' });
  for (const item of [
    fact('디자인 전공이다.', '디자인 전공으로 바꿨어', 'unknown'),
    fact('서울에 산다.', '서울에 살아'),
    fact('서울에 산다.', '!!'),
    fact('가'.repeat(501), '디자인 전공'),
    fact('', '디자인 전공'),
    { id: null, content: '디자인 전공이다.', evidence: '디자인 전공' },
    { id: '', content: '디자인 전공이다.', evidence: 123 }
  ]) assert.deepEqual(validateMemories({ memories: [item] }, text, existing).operations, []);
  assert.throws(() => validateMemories({}, text, existing), /Invalid memory response/);
  assert.throws(() => validateMemories({ memories: Array(4).fill(fact('정보', '전공')) }, text, existing), /Invalid memory response/);
});

test('automatic memories deduplicate, cap new entries and still allow corrections at capacity', () => {
  const existing = [{ id: 'answer', content: '짧은 답변을 선호한다.' }];
  assert.deepEqual(validateMemories({ memories: [fact('짧은 답변을 선호한다 !')] }, '짧은 답변을 선호한다 !', existing).operations, []);
  const twice = validateMemories({ memories: [fact('나는 디자인 전공이야'), fact('나는 디자인 전공이야!')] }, '나는 디자인 전공이야!', []);
  assert.equal(twice.operations.length, 1);
  const repeatedId = validateMemories({ memories: [
    fact('긴 답변을 선호한다.', '길게', 'answer'), fact('설명을 자세히 선호한다.', '자세히', 'answer')
  ] }, '길게 자세히 말해줘', existing);
  assert.equal(repeatedId.operations.length, 1);
  const full = Array.from({ length: 30 }, (_, index) => ({ id: `fact-${index}`, content: `기억 ${index}` }));
  const result = validateMemories({ memories: [fact('새 정보'), fact('수정 정보', '수정 정보', 'fact-0')] }, '새 정보, 수정 정보', full);
  assert.equal(result.status, 'full');
  assert.deepEqual(result.operations, [{ id: 'fact-0', content: '수정 정보' }]);
  const almostFull = validateMemories({ memories: [fact('첫 정보'), fact('둘째 정보')] }, '첫 정보, 둘째 정보', full.slice(1));
  assert.equal(almostFull.operations.length, 1);
  assert.equal(almostFull.status, 'full');
});

test('projection leaves persisted memories untouched until chat succeeds', () => {
  const existing = [{ id: 'major', content: '컴퓨터공학 전공이다.', source: 'manual' }];
  const projected = projectMemories(existing, [{ id: 'major', content: '디자인 전공이다.' }, { id: null, content: '짧은 답변을 선호한다.' }]);
  assert.deepEqual(projected.map(item => item.content), ['디자인 전공이다.', '짧은 답변을 선호한다.']);
  assert.deepEqual(existing, [{ id: 'major', content: '컴퓨터공학 전공이다.', source: 'manual' }]);
});

test('opt-outs, credentials and greetings bypass automatic extraction', async () => {
  let calls = 0;
  const codexClient = fakeCodex(async () => { calls++; throw new Error('must not generate'); });
  for (const text of ['나는 디자인 전공이야. 기억하지 마.', '답변은 짧게 해줘. 저장하지 마.', '이 내용은 잊어 줘.', '내 비밀번호는 sample-password야.', 'API key: sk-test-only-123456789', '안녕', '고마워!']) {
    assert.deepEqual(await extractMemories({ text, memories: [], codexClient }), { operations: [], status: 'skipped' });
  }
  assert.equal(calls, 0);
  for (const content of ['비밀번호는 1234', '카드 번호 0000', '인증 코드 1234']) {
    assert.deepEqual(validateMemories({ memories: [fact(content, '내 정보')] }, '내 정보', []).operations, []);
  }
});

test('extraction validates Codex structured output and reports malformed answers as unavailable', async () => {
  const calls = [];
  const result = await extractMemories({ text: '나는 디자인 전공이야', memories: [], codexClient: fakeCodex(async input => {
    calls.push(input); return memoryResult([fact('디자인 전공이다.', '디자인 전공이야')]);
  }) });
  assert.deepEqual(result.operations, [{ id: null, content: '디자인 전공이다.' }]);
  assert.equal(calls.length, 1); assert.ok(calls[0].schema.properties.memories);
  assert.deepEqual(JSON.parse(calls[0].messages.at(-1).content), { text: '나는 디자인 전공이야', memories: [] });
  for (const value of ['not-json', '', '{"facts":[]}']) {
    assert.deepEqual(await extractMemories({ text: '나는 디자인 전공이야', memories: [], codexClient: fakeCodex(async () => codexResult(value)) }), { operations: [], status: 'unavailable' });
  }
  assert.deepEqual(await extractMemories({ text: '나는 디자인 전공이야', memories: [], codexClient: fakeCodex(async () => { throw new Error('Codex unavailable'); }) }), { operations: [], status: 'unavailable' });
});

test('short model references map back to existing memory IDs and reject unknown references', async () => {
  const memories = [
    { id: 'b23cb7f4-5d25-478e-a51b-04d783e35779', content: '컴퓨터공학 전공이다.' },
    { id: 'c251df02-23ae-4690-aa41-3f802b57f6ea', content: '차가운 커피를 좋아한다.' }
  ];
  const text = '이제 따뜻한 커피를 더 좋아해';
  let input;
  const result = await extractMemories({ text, memories, codexClient: fakeCodex(async request => {
    input = JSON.parse(request.messages.at(-1).content);
    return memoryResult([
      fact('따뜻한 커피를 더 좋아한다.', text, '2'),
      fact('커피 취향이 바뀌었다.', text, '99')
    ]);
  }) });
  assert.deepEqual(input.memories, memories.map((item, index) => ({ id: String(index + 1), content: item.content })));
  assert.deepEqual(result.operations, [{ id: memories[1].id, content: '따뜻한 커피를 더 좋아한다.' }]);
  assert.equal(memories[1].content, '차가운 커피를 좋아한다.');
});

test('legacy memory migration, conversation context and chat-memory rollback persist correctly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'asa-memory-store-'));
  const path = join(dir, 'rin.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec('CREATE TABLE memories (id TEXT PRIMARY KEY NOT NULL, content TEXT NOT NULL, created TEXT NOT NULL)');
  legacy.prepare('INSERT INTO memories VALUES (?,?,?)').run('legacy', '짧은 답변을 선호한다.', '2026-01-01T00:00:00.000Z');
  legacy.close();
  let store;
  try {
    store = new Store(path);
    assert.equal(store.memories()[0].source, 'manual');
    store.addPair('첫 대화', '첫 답변');
    store.addPair('나는 디자인 전공이야', '디자인 전공이구나.', null, [{ id: null, content: '디자인 전공이다.' }]);
    assert.equal(store.context().length, 4);
    const learned = store.memories().find(item => item.source === 'conversation');
    assert.ok(learned?.id);
    store.db.exec("CREATE TRIGGER fail_assistant BEFORE INSERT ON messages WHEN NEW.role='assistant' BEGIN SELECT RAISE(ABORT, 'test rollback'); END");
    assert.throws(() => store.addPair('지금은 음악 전공이야', '수정했어.', null, [{ id: learned.id, content: '음악 전공이다.' }]), /test rollback/);
    assert.equal(store.messages().length, 4);
    assert.equal(store.context().length, 4);
    assert.equal(store.memories().find(item => item.id === learned.id).content, '디자인 전공이다.');
    store.db.exec('DROP TRIGGER fail_assistant');
    store.addPair('지금은 음악 전공이야', '음악 전공이구나.', null, [{ id: learned.id, content: '음악 전공이다.' }]);
    assert.equal(store.messages().length, 6);
    assert.equal(store.context().length, 6);
    store.close();
    store = new Store(path);
    assert.equal(store.memories().length, 2);
    assert.equal(store.memories().find(item => item.id === learned.id).source, 'conversation');
    assert.equal(store.memories().find(item => item.id === learned.id).content, '음악 전공이다.');
    assert.equal(store.context().length, 6);
    store.memory('긴 답변을 선호한다.', 'legacy');
    assert.equal(store.memories().find(item => item.id === 'legacy').source, 'manual');
    assert.equal(store.context().length, 6);
  } finally { store?.close(); rmSync(dir, { recursive: true }); }
});

test('ordinary chat learns, corrects and recalls facts without resurrecting deleted memories', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'asa-memory-chat-'));
  let extracted = [], mode = 'ok', heldReply = null, heldExtraction = null;
  const extractionInputs = [], requests = [];
  const codexClient = fakeCodex(async body => {
    if (body.schema) {
      extractionInputs.push(JSON.parse(body.messages.at(-1).content));
      if (heldExtraction) { heldExtraction.started(); await heldExtraction.untilReleased; }
      if (mode === 'extraction-failed') throw new Error('Codex memory unavailable');
      const content = JSON.stringify({ memories: extracted });
      return codexResult(content);
    }
    requests.push(body);
    if (heldReply) { heldReply.started(); await heldReply.untilReleased; }
    if (mode === 'chat-failed') throw new Error('Codex chat unavailable');
    return codexResult('알겠어.');
  });
  const app = createApp({ dataPath: join(dir, 'rin.sqlite'), codexClient });
  const close = () => new Promise(resolve => app.server.close(resolve));
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const session = await (await fetch(`${base}/api/session`)).json();
    const post = async (path, body) => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': session.token }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    let learnedId;
    await t.test('automatic learning runs alongside a reply that uses the current message and prior context', async () => {
      app.store.addPair('처음 대화', '첫 답변');
      extracted = [fact('컴퓨터공학 전공이다.', '컴퓨터공학 전공이야')];
      const result = await post('/api/chat', { text: '나는 컴퓨터공학 전공이야' });
      assert.equal(result.status, 200);
      assert.equal(result.data.memories.length, 1);
      assert.equal(result.data.memories[0].source, 'conversation');
      learnedId = result.data.memories[0].id;
      const context = JSON.parse(requests.at(-1).messages[0].content.split('\n').find(line => line.startsWith('{"localTime":')));
      assert.deepEqual(context.memories, []);
      assert.deepEqual(context.memoryActionResult, { status: 'pending', saved: [] });
      assert.equal(requests.at(-1).messages.at(-1).content, '나는 컴퓨터공학 전공이야');
      assert.equal(requests.at(-1).messages.length, 4);
      assert.equal(app.store.context().length, 4);
    });
    await t.test('uses saved facts in later chats and deduplicates repeated facts', async () => {
      extracted = [];
      assert.equal((await post('/api/chat', { text: '내 전공 기억해?' })).status, 200);
      assert.match(requests.at(-1).messages[0].content, /컴퓨터공학 전공이다/);
      extracted = [fact('컴퓨터공학 전공이다.', '컴퓨터공학 전공이야')];
      await post('/api/chat', { text: '나는 컴퓨터공학 전공이야' });
      assert.equal(app.store.memories().length, 1);
    });
    await t.test('automatic correction preserves the conversation and supplies the correction as the current message', async () => {
      extracted = [fact('디자인 전공이다.', '디자인 전공으로 바꿨어', learnedId)];
      assert.equal((await post('/api/chat', { text: '지금은 디자인 전공으로 바꿨어' })).status, 200);
      assert.deepEqual(app.store.memories().map(item => [item.id, item.content]), [[learnedId, '디자인 전공이다.']]);
      const context = JSON.parse(requests.at(-1).messages[0].content.split('\n').find(line => line.startsWith('{"localTime":')));
      assert.deepEqual(context.memories, ['컴퓨터공학 전공이다.']);
      assert.equal(context.memoryActionResult.status, 'pending');
      assert.match(JSON.stringify(requests.at(-1).messages.slice(1)), /컴퓨터공학/);
      assert.equal(requests.at(-1).messages.at(-1).content, '지금은 디자인 전공으로 바꿨어');
      assert.equal(requests.at(-1).messages.length, 10);
      assert.equal(app.store.context().length, 10);
      assert.equal(app.store.messages().length, 10);
    });
    await t.test('manual deletion remains effective even if the extractor invents old evidence', async () => {
      assert.equal((await post('/api/memory/delete', { id: learnedId })).status, 200);
      extracted = [fact('디자인 전공이다.', '디자인 전공으로 바꿨어')];
      const extractionCount = extractionInputs.length;
      assert.equal((await post('/api/chat', { text: '내 전공 기억해?' })).status, 200);
      assert.equal(app.store.memories().length, 0);
      assert.equal(extractionInputs.length, extractionCount, 'recall alone must not extract a new fact');
      assert.doesNotMatch(JSON.stringify(requests.at(-1).messages), /디자인 전공/);
      assert.equal(requests.at(-1).messages.length, 2);
    });
    await t.test('failed extraction keeps chat working without saving facts', async () => {
      mode = 'extraction-failed';
      assert.equal((await post('/api/chat', { text: '나는 차를 좋아해' })).status, 200);
      assert.equal(app.store.memories().length, 0);
    });
    await t.test('failed generation saves neither extracted memories nor partial chat', async () => {
      mode = 'chat-failed';
      extracted = [fact('차를 좋아한다.', '차를 좋아해')];
      const count = app.store.messages().length;
      assert.equal((await post('/api/chat', { text: '나는 차를 좋아해' })).status, 502);
      assert.equal(app.store.memories().length, 0);
      assert.equal(app.store.messages().length, count);
    });
    await t.test('opt-outs stay unsaved and manual editing still works', async () => {
      mode = 'ok';
      const count = extractionInputs.length;
      assert.equal((await post('/api/chat', { text: '나는 차를 좋아해. 기억하지 마.' })).status, 200);
      assert.equal(extractionInputs.length, count);
      assert.equal(app.store.memories().length, 0);
      const conversation = app.store.context().map(message => message.content);
      const manual = await post('/api/memory', { content: '커피를 좋아한다.' });
      assert.equal(manual.status, 200);
      const memory = manual.data.memories[0];
      assert.equal(memory.source, 'manual');
      assert.deepEqual(app.store.context().map(message => message.content), conversation);
      assert.equal((await post('/api/memory', { id: memory.id, content: '차를 좋아한다.' })).status, 200);
      assert.equal(app.store.memories()[0].content, '차를 좋아한다.');
      assert.deepEqual(app.store.context().map(message => message.content), conversation);
      assert.equal((await post('/api/memory/delete', { id: memory.id })).status, 200);
      extracted = [];
      const afterDeleteExtractions = extractionInputs.length;
      assert.equal((await post('/api/chat', { text: '내가 뭘 좋아하지?' })).status, 200);
      assert.equal(extractionInputs.length, afterDeleteExtractions);
      assert.equal(app.store.memories().length, 0);
    });
    await t.test('manual writes cannot race a pending chat-memory commit', async () => {
      const manual = await post('/api/memory', { content: '커피를 좋아한다.' });
      const memory = manual.data.memories[0];
      let started, release;
      const waiting = new Promise(resolve => { started = resolve; });
      heldReply = { started, untilReleased: new Promise(resolve => { release = resolve; }) };
      extracted = [fact('녹차를 좋아한다.', '녹차를 좋아해')];
      const pending = post('/api/chat', { text: '나는 녹차를 좋아해' });
      try {
        await waiting;
        assert.equal((await post('/api/memory', { id: memory.id, content: '홍차를 좋아한다.' })).status, 409);
        assert.equal((await post('/api/memory/delete', { id: memory.id })).status, 409);
        assert.equal((await post('/api/memory', { content: '차를 좋아한다.' })).status, 409);
      } finally { heldReply = null; release(); }
      assert.equal((await pending).status, 200);
      assert.equal(app.store.memories().find(item => item.id === memory.id).content, '커피를 좋아한다.');
      assert.equal(app.store.memories().length, 2);
    });
    await t.test('explicit saves wait for extraction and explicit corrections include verified facts without losing context', async () => {
      let started, release;
      const waiting = new Promise(resolve => { started = resolve; });
      heldExtraction = { started, untilReleased: new Promise(resolve => { release = resolve; }) };
      extracted = [fact('별명은 달빛이다.', '내 별명은 달빛이야')];
      const requestCount = requests.length;
      const pending = post('/api/chat', { text: '내 별명은 달빛이야. 기억해 줘.' });
      try {
        await waiting;
        assert.equal(requests.length, requestCount, 'explicit save must wait before generating its receipt');
      } finally { heldExtraction = null; release(); }
      assert.equal((await pending).status, 200);
      let context = JSON.parse(requests.at(-1).messages[0].content.split('\n').find(line => line.startsWith('{"localTime":')));
      assert.ok(context.memories.includes('별명은 달빛이다.'));
      assert.equal(context.memoryActionResult.status, 'success');
      assert.deepEqual(context.memoryActionResult.saved, ['별명은 달빛이다.']);
      const nickname = app.store.memories().find(item => item.content === '별명은 달빛이다.');
      const conversation = app.store.context().map(message => message.content);
      extracted = [fact('별명은 별빛이다.', '별빛으로 바꿨어', nickname.id)];
      assert.equal((await post('/api/chat', { text: '아까 별명을 별빛으로 바꿨어. 기억 수정해 줘.' })).status, 200);
      context = JSON.parse(requests.at(-1).messages[0].content.split('\n').find(line => line.startsWith('{"localTime":')));
      assert.ok(context.memories.includes('별명은 별빛이다.'));
      assert.equal(context.memories.includes('별명은 달빛이다.'), false);
      assert.equal(context.memoryActionResult.status, 'success');
      assert.deepEqual(context.memoryActionResult.saved, ['별명은 별빛이다.']);
      assert.deepEqual(requests.at(-1).messages.slice(1, -1).map(message => message.content), conversation);
      assert.equal(app.store.memories().find(item => item.id === nickname.id).content, '별명은 별빛이다.');
    });
  } finally {
    if (app.server.listening) await close(); else app.store.close();
    rmSync(dir, { recursive: true });
  }
});

test('mixed personal facts survive schedule registration, change and generated query replies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'asa-memory-schedule-'));
  let extracted = [], scheduleCalls = 0, chatCalls = 0;
  const app = createApp({ dataPath: join(dir, 'rin.sqlite'), codexClient: fakeCodex(async body => {
    const memoryRequest = body.schema?.properties?.memories;
    let content;
    if (memoryRequest) content = JSON.stringify({ memories: extracted });
    else if (body.schema) {
      scheduleCalls++;
      content = JSON.stringify({ action: 'add', title: '팀플 회의', kind: 'event', course: '', due: '', reason: '' });
    } else { chatCalls++; content = '알겠어.'; }
    return codexResult(content);
  }) });
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const chat = async text => {
      const response = await fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token }, body: JSON.stringify({ text }) });
      assert.equal(response.status, 200);
      return response.json();
    };
    extracted = [fact('컴퓨터공학 전공이다.', '컴퓨터공학 전공이야')];
    let state = await chat('나는 컴퓨터공학 전공이야. 내일 오후 3시에 팀플 회의 있어');
    assert.equal(state.academics.length, 1);
    assert.equal(state.memories[0].content, '컴퓨터공학 전공이다.');
    assert.equal(state.memories[0].source, 'conversation');
    assert.equal(state.messages.at(-1).schedule_action.action, 'add');
    extracted = [fact('차를 좋아한다.', '차를 좋아해')];
    state = await chat('팀플 회의 취소해줘. 나는 차를 좋아해');
    assert.equal(state.academics.length, 0);
    assert.equal(state.memories.length, 2);
    assert.equal(state.messages.at(-1).schedule_action.action, 'cancel');
    extracted = [fact('짧은 답변을 선호한다.', '답변은 짧게 해줘')];
    state = await chat('오늘 수업 뭐야? 답변은 짧게 해줘');
    assert.equal(state.memories.length, 3);
    assert.equal(state.messages.at(-1).content, '알겠어.');
    assert.equal(scheduleCalls, 1);
    assert.equal(chatCalls, 3);
  } finally {
    if (app.server.listening) await new Promise(resolve => app.server.close(resolve)); else app.store.close();
    rmSync(dir, { recursive: true });
  }
});
