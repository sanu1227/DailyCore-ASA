import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBedtimeNagCopy, buildBreakNagCopy, buildDeadlineNagCopy } from '../app/rin-nag-lines.mjs';

test('ASA AI reminders copy stays varied while preserving actionable facts', () => {
  const deadline = new Set();
  const bedtime = new Set();
  const breaks = new Set();
  for (let seed = 0; seed < 240; seed++) {
    const urgent = buildDeadlineNagCopy({ label: '알고리즘 보고서', noun: '과제', time: '2시간', gameMinutes: 87, retryMinutes: 15, key: `deadline:${seed}` });
    assert.match(urgent.body, /알고리즘 보고서/); assert.match(urgent.body, /2시간/); assert.match(urgent.body, /15분 뒤/);
    assert.match(urgent.title, /^아사 ·/);
    assert.match(urgent.body, /게임 기록은 1시간 27분이야/);
    assert.doesNotMatch(urgent.body, /제법|딱히|흥[,! ]|바보|이번엔 진짜|또 미루|게임만|걱정시키|사랑해|서아|린 ·/);
    deadline.add(`${urgent.title}|${urgent.body}`);
    bedtime.add(JSON.stringify(buildBedtimeNagCopy({ routine: '취침 준비', key: `bedtime:${seed}` })));
    breaks.add(JSON.stringify(buildBreakNagCopy({ minutes: 50, key: `break:${seed}` })));
  }
  assert.ok(deadline.size >= 100, `deadline variations: ${deadline.size}`);
  assert.ok(bedtime.size >= 60, `bedtime variations: ${bedtime.size}`);
  assert.ok(breaks.size >= 30, `break variations: ${breaks.size}`);
});

test('game time wording stays natural on exact hours and without usage data', () => {
  const options = { label: '보고서', noun: '과제', time: '30분', key: 'deadline:hour' };
  assert.match(buildDeadlineNagCopy({ ...options, gameMinutes: 60 }).body, /게임 기록은 1시간이야/);
  assert.doesNotMatch(buildDeadlineNagCopy(options).body, /게임 기록/);
});

test('exam and event reminders describe a start without assignment submission instructions', () => {
  for (const noun of ['시험', '일정']) {
    for (let seed = 0; seed < 240; seed++) {
      const copy = buildDeadlineNagCopy({ label: noun === '시험' ? '게임수학 중간고사' : '팀플 회의', noun, time: seed % 2 ? '2시간' : '8시간', key: `kind:${seed}` });
      assert.match(copy.title, new RegExp(noun));
      assert.match(copy.body, /게임수학 중간고사|팀플 회의/);
      assert.match(copy.body, /2시간|8시간/);
      assert.doesNotMatch(copy.title + copy.body, /마감|제출|첨부|초안/);
    }
  }
});
