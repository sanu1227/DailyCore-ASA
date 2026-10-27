import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';

function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), 'rin-chat-context-'));
  const store = new Store(join(directory, 'rin.sqlite'));
  try { run(store); }
  finally { store.close(); rmSync(directory, { recursive: true }); }
}

test('chat context retains the latest 24 complete conversation turns in order', () => withStore(store => {
  for (let turn = 1; turn <= 30; turn++) store.addPair(`질문 ${turn}`, `답변 ${turn}`);
  const context = store.context();
  assert.equal(store.messages().length, 60);
  assert.equal(context.length, 48);
  assert.deepEqual(context.map(message => message.content),
    Array.from({ length: 24 }, (_, index) => [`질문 ${index + 7}`, `답변 ${index + 7}`]).flat());
  assert.equal(context.every((message, index) => message.role === (index % 2 ? 'assistant' : 'user')), true);
}));

test('manual and automatic fact corrections preserve the current conversation', () => withStore(store => {
  store.addPair('보스 이름은 마지막 교대로 할게', '폐공장 분위기와 어울려.');
  const id = store.memory('컴퓨터공학 전공이다.');
  const before = store.context().map(message => message.content);
  store.memory('디자인 전공이다.', id);
  assert.deepEqual(store.context().map(message => message.content), before);
  store.addPair('지금은 음악 전공이야', '음악 전공으로 정정할게.', null,
    [{ id, content: '음악 전공이다.' }]);
  assert.deepEqual(store.context().map(message => message.content),
    [...before, '지금은 음악 전공이야', '음악 전공으로 정정할게.']);
  assert.equal(store.memories().find(memory => memory.id === id).content, '음악 전공이다.');
}));

test('deleting a memory retires old model context without deleting the visible archive', () => withStore(store => {
  const id = store.memory('디자인 전공이다.');
  store.addPair('내 전공 기억해?', '디자인 전공이야.');
  store.removeMemory(id);
  assert.equal(store.memories().length, 0);
  assert.equal(store.messages().length, 2);
  assert.deepEqual(store.context(), []);
  store.addPair('다른 이야기 하자', '좋아.');
  store.memory('따뜻한 커피를 좋아한다.');
  assert.deepEqual(store.context().map(message => message.content), ['다른 이야기 하자', '좋아.']);
}));

test('awkward conversation pairs stay excluded and do not consume the context window', () => withStore(store => {
  for (let turn = 1; turn <= 25; turn++) {
    store.addPair(`질문 ${turn}`, `답변 ${turn}`);
    if (turn === 20) store.feedback(store.messages().at(-1).id, 'awkward', 'repetition');
  }
  const context = store.context();
  assert.equal(context.length, 48);
  assert.equal(context[0].content, '질문 1');
  assert.equal(context.at(-1).content, '답변 25');
  assert.equal(context.some(message => /^(질문|답변) 20$/.test(message.content)), false);
  assert.equal(store.messages().length, 50);
}));
