import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/store.mjs';
import { buildRequest } from '../app/provider.mjs';
import { RIN_AWAY_LINES } from '../app/rin-away-lines.mjs';
import { RIN_CASUAL_LINES } from '../app/rin-casual-lines.mjs';

for (const previousVersion of [0, 1]) test(`ASA migration from v${previousVersion} preserves records and runs only once`, () => {
  const directory = mkdtempSync(join(tmpdir(), 'asa-migration-'));
  const path = join(directory, 'rin.sqlite');
  let store = new Store(path);
  const preservedTables = ['memories', 'class_sessions', 'academic_items', 'routines'];
  const snapshot = () => Object.fromEntries(preservedTables.map(table => [table, store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  try {
    store.memory('월요일 수업이 있고 커피는 따뜻한 것을 좋아한다.', 'user-memory');
    store.memory('이전 캐릭터는 원작의 성격을 따르는 연인이다.', 'old-persona-memory');
    store.saveClass({ name: '자료구조', day: 1, start: '09:00', end: '10:00', location: '301' }, 'class-1');
    store.saveAcademic({ title: '보고서', course: '자료구조', kind: 'assignment', due: '2030-10-20T23:59', notes: '원본 보존', completed: false }, 'academic-1');
    store.saveRoutine({ title: '아침 식사', category: 'meal', days: [1, 3, 5], time: '08:00', notes: '', active: true }, 'routine-1');
    store.saveIntegration('eclass', { source: 'keep-existing', count: 1 });
    store.addPair('이전 대화', '이전 캐릭터의 답변');
    store.feedback(store.messages().at(-1).id, 'good', '');
    const archived = store.messages().map(({ context, ...message }) => message);
    const records = snapshot();
    const legacySettings = { ...store.settings(), name: '테스트', teasing: 2, notificationVolume: 0, tsundere: 5 };
    delete legacySettings.characterMotion;
    store.db.prepare('UPDATE settings SET value=? WHERE id=1').run(JSON.stringify(legacySettings));
    if (previousVersion) store.saveIntegration('persona_migration', { version: previousVersion, character: '백서아' });
    else store.db.prepare("DELETE FROM integrations WHERE key='persona_migration'").run();
    store.close();

    store = new Store(path);
    assert.deepEqual(store.integration('persona_migration'), { version: 2, character: 'ASA', persona: 'asa-fan' });
    assert.deepEqual(store.messages().map(({ context, ...message }) => message), archived);
    assert.equal(store.messages().every(message => message.context === 0), true);
    assert.deepEqual(store.context(), []);
    assert.deepEqual(snapshot(), records);
    assert.deepEqual(store.integration('eclass'), { source: 'keep-existing', count: 1 });
    assert.equal(store.settings().name, '테스트');
    assert.equal(store.settings().teasing, 2);
    assert.equal(store.settings().notificationVolume, 0);
    assert.equal(store.settings().characterMotion, true);
    assert.equal(store.settings().tsundere, undefined);
    assert.equal(JSON.parse(store.db.prepare('SELECT value FROM settings').get().value).tsundere, undefined);

    store.addPair('아사 AI 안녕', '안녕.');
    store.saveSettings({ ...store.settings(), characterMotion: false, tsundere: 4 });
    store.close();
    store = new Store(path);
    assert.equal(store.messages().length, archived.length + 2);
    assert.deepEqual(store.context().map(message => message.content), ['아사 AI 안녕', '안녕.']);
    assert.deepEqual(store.integration('persona_migration'), { version: 2, character: 'ASA', persona: 'asa-fan' });
    assert.equal(store.settings().characterMotion, false);
    assert.equal(store.settings().tsundere, undefined);
    assert.deepEqual(snapshot(), records);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('ASA companion keeps user facts without inheriting a persona or pretending to be the artist', () => {
  const persona = readFileSync(new URL('../prompts/rin-local-system.md', import.meta.url), 'utf8');
  const memory = '이전 캐릭터의 이름은 린이고 사용자는 월요일 수업이 있다.';
  const request = buildRequest(persona, { name: '테스트', teasing: 2 }, [{ content: memory }], [], '네 이름이 뭐야?');
  const system = request.messages[0].content;
  assert.match(system, /BABYMONSTER ASA\(아사\) 콘셉트의 팬메이드 AI 대화 상대/);
  assert.match(system, /실제 아사 본인이나 소속사, 공식 서비스가 아니/);
  assert.match(system, /사용자는 연인이 아닌 대화 상대를 선택/);
  assert.match(system, /사생활, 비공개 일정, 관계, 연락처, 생각이나 감정을 지어내지 않는다/);
  assert.match(system, /매 답변마다 소개나 면책 문구를 반복하지 않는다/);
  assert.match(system, /친한 여사친처럼 짧고 편하게 말한다/);
  assert.match(system, /잔소리는 등록된 일정·마감·알림이나 사용자가 직접 말한 미룬 일, 요청한 조언처럼 근거가 있을 때만/);
  assert.match(system, /해결책을 요청하지 않으면 계획표를 만들거나 생활 관리로 돌리지 않는다/);
  assert.match(system, /memoryActionResult.status가 success인 경우에만 saved에 담긴 기억의 저장·갱신을 완료/);
  assert.match(system, /대화로 기억을 삭제하지 못하므로 삭제 요청은 기억 탭에서/);
  assert.doesNotMatch(system, /기억을 삭제하거나 바꿨다고 주장하지 않는다/);
  assert.match(system, /이전 캐릭터의 이름·원작 세계관·성격·외형·관계 연기는 현재 설정으로 사용하지 않는다/);
  assert.match(system, /사용자 이름, 실제 취향, 수업·과제·생활 사실은 계속 존중/);
  assert.ok(system.includes(memory));
  assert.doesNotMatch(system, /tsundere|츤데레 강도|백금발|사용자에게만|오리지널 캐릭터 백서아/);
});

test('ASA AI casual and away copy avoids romantic scripts and invented artist experiences', () => {
  const lines = [...RIN_CASUAL_LINES, ...RIN_AWAY_LINES];
  assert.equal(RIN_CASUAL_LINES.length >= 100, true);
  assert.equal(RIN_AWAY_LINES.length >= 25, true);
  for (const line of lines) {
    assert.doesNotMatch(line, /서아|백금발|너한테는|네 이름 한번|사랑해|나도 좋아해|연인|남자친구|여자친구|연습했|촬영했|멤버들이랑|딱히|기다렸|기다리는 건|집중한 얼굴|기분 좋아 보|방금 웃었|아직 밖|긴 외출|걱정시키|보고해|칭찬.{0,10}안 해/);
  }
});
