import test from 'node:test';
import { codexResult, fakeCodex } from './helpers/codex.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app/server.mjs';
import { shouldExtractMemories } from '../app/memory.mjs';

const gate = () => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; };
const memory = () => codexResult({ memories: [{ id: '', content: '녹차를 좋아한다.', evidence: '녹차를 좋아해' }] });
const answer = input => { input.onDelta?.('녹차는 '); input.onDelta?.('깔끔하지.'); return codexResult('녹차는 깔끔하지.'); };

async function fixture(generate, run) {
  const dir = mkdtempSync(join(tmpdir(), 'rin-chat-stream-'));
  const app = createApp({ dataPath: join(dir, 'rin.sqlite'), codexClient: fakeCodex(generate) });
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const post = (text, headers = {}) => fetch(`${base}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': app.token, Accept: 'application/x-ndjson', ...headers }, body: JSON.stringify({ text }) });
    await run({ app, base, post });
  } finally {
    await new Promise(resolve => app.server.close(resolve));
    rmSync(dir, { recursive: true });
  }
}

async function* records(response) {
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line) yield JSON.parse(line);
    }
  }
  buffer += decoder.decode();
  assert.equal(buffer, '');
}

test('chat streams before automatic memory completes, then commits both without replacing reply diagnostics', async () => {
  const held = gate();
  await fixture(async body => {
    if (body.schema) { await held.promise; return memory(); }
    assert.equal(typeof body.onDelta, 'function');
    assert.match(body.messages[0].content, /pending/);
    return answer(body);
  }, async ({ app, base, post }) => {
    const response = await post('나는 녹차를 좋아해');
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    const events = []; let checkedDelta = false;
    try {
      for await (const event of records(response)) {
        events.push(event);
        if (event.type === 'delta' && !checkedDelta) {
          checkedDelta = true;
          assert.equal(app.store.messages().length, 0, 'Partial chat must not be persisted');
          const state = await (await fetch(`${base}/api/session`)).json();
          assert.equal(state.busy, true);
          assert.equal(state.providerStatus.stages.memory.status, 'pending');
          held.release();
        }
      }
    } finally { held.release(); }
    assert.equal(checkedDelta, true);
    assert.equal(events.at(-1).type, 'done');
    assert.equal(app.store.memories()[0].content, '녹차를 좋아한다.');
    assert.equal(app.store.messages().at(-1).content, '녹차는 깔끔하지.');
    const state = await (await fetch(`${base}/api/session`)).json();
    assert.equal(state.providerStatus.stage, 'chat');
    assert.equal(state.providerStatus.model, 'codex-test-model');
    assert.equal(state.providerStatus.stages.memory.status, 'success');
    assert.equal(typeof state.providerStatus.firstTokenMs, 'number');
    assert.ok(state.providerStatus.turnElapsedMs >= state.providerStatus.firstTokenMs);
  });
});

test('explicit memory request waits for verified extraction and delivers a single final state', async () => {
  const entered = gate(), held = gate(); let chatCalls = 0;
  await fixture(async body => {
    if (body.schema) { entered.release(); await held.promise; return memory(); }
    chatCalls++;
    assert.match(body.messages[0].content, /녹차를 좋아한다/);
    assert.match(body.messages[0].content, /"status":"success"/);
    return answer(body);
  }, async ({ post }) => {
    const response = await post('나는 녹차를 좋아해. 기억해 줘.');
    await entered.promise;
    assert.equal(chatCalls, 0);
    held.release();
    const events = []; for await (const event of records(response)) events.push(event);
    assert.equal(events.filter(event => event.type === 'done').length, 1);
    assert.equal(events.at(-1).messages.length, 2);
    assert.equal(events.at(-1).memories.length, 1);
    assert.equal(events.at(-1).busy, false);
  });
});

test('incomplete streamed reply emits an error and saves no partial chat or learned facts', async () => {
  await fixture(async body => {
    if (body.schema) return memory();
    body.onDelta?.('중간 답변'); throw new Error('Codex reply interrupted');
  }, async ({ app, post }) => {
    const events = []; for await (const event of records(await post('나는 녹차를 좋아해'))) events.push(event);
    assert.ok(events.some(event => event.type === 'delta'));
    assert.equal(events.at(-1).type, 'error');
    assert.equal(events.some(event => event.type === 'done'), false);
    assert.equal(app.store.messages().length, 0);
    assert.equal(app.store.memories().length, 0);
  });
});

test('only durable user fact candidates or explicit saves need memory extraction', () => {
  for (const text of [
    '오늘 수업 뭐 있어?', '아까 주인공 이름 뭐였지?', '다른 이름 두 개 추천해줘', '프로세스와 스레드 차이 알려줘',
    '내 전공 기억해?', '내 전공이 뭐였지?', '나는 오늘 기분이 별로야', '오늘 점심에 국수 먹었어',
    '요즘 만드는 게임 주인공은 우체부야. 달에 있는 마을로 편지를 배달해.',
    '주인공 이름은 하람이야', '소설 캐릭터의 전공은 디자인이야', '이 캐릭터는 차를 좋아해',
    '그 설정으로 대사 두 개 지어줘', '그 대사 좀 자연스럽게 다시 써줘', '내일 오후 3시에 팀플 회의 있어',
    '매주 월요일 수업 등록해줘', '너는 따뜻한 차를 좋아해?', '이 내용 기억하지 마. 나는 디자인 전공이야',
  ]) assert.equal(shouldExtractMemories(text), false, text);
  for (const text of [
    '나는 디자인 전공이야. 다른 직업 추천해줘', '따뜻한 차를 좋아하는데 너는?', '짧은 답변을 선호해. 그렇게 해줄래?',
    '나는 컴공 전공이야. 내일 팀플 회의 있어', '팀플 회의 취소해줘. 나는 차를 좋아해', '오늘 수업 뭐야? 답변은 짧게 해줘',
    '지금은 음악 전공으로 바꿨어', '나는 회사에서 개발자로 일해', '내 직업은 간호사야', '내 별명은 하람이야', '나를 도윤이라고 불러줘',
    '나는 녹차를 좋아한다', '긴 설명보다 간단한 답변을 선호한다',
    '평소에는 밤 12시에 자', '매일 아침 산책해', '앞으로 반말로 말해줘', '내 취향은 재즈야. 기억해 줘',
    '주인공 이름은 하람이야. 이 설정 기억해 줘',
  ]) assert.equal(shouldExtractMemories(text), true, text);
});

test('a failed final save reports request failure while preserving completed model diagnostics', async () => {
  await fixture(async input => answer(input), async ({ app, base, post }) => {
    app.store.addPair = () => { throw new Error('Test storage failure'); };
    const events = []; for await (const event of records(await post('안녕'))) events.push(event);
    assert.equal(events.at(-1).type, 'error');
    assert.equal(app.store.messages().length, 0);
    const state = await (await fetch(`${base}/api/session`)).json();
    assert.match(state.providerStatus.turnError, /저장/);
    assert.equal(state.providerStatus.stages.chat.status, 'success');
    assert.equal(state.busy, false);
  });
});
