import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEveningReview, buildEveningReviewCandidate } from '../app/review.mjs';

const settings = { notifications: true, eveningReview: true, eveningReviewUsageMinutes: 360, quietStart: '01:00', quietEnd: '07:00' };

test('evening review shows recorded facts and the nearest upcoming plan without duplicate statistics', () => {
  const now = new Date(2026, 8, 12, 23, 5);
  const review = buildEveningReview({
    now,
    classes: [{ id: 'c', name: '알고리즘', day: 7, start: '10:00', end: '12:00', location: 'E동' }],
    academics: [
      { id: 'done', title: '실습', completed: 1, completed_at: '2026-09-12T10:00:00.000Z', due: '2026-09-12T12:00' },
      { id: 'next', title: '보고서', completed: 0, due: '2026-09-13T23:59' }
    ],
    routines: [{ id: 'r', title: '운동', active: 1, days: [6], completedToday: 1 }],
    activity: { categories: { study: 3600, game: 1800 } },
    health: { exercise_minutes: 30 }, healthWeek: [], activityWeek: []
  });
  assert.equal(review.stats.routineDone, 1); assert.equal(review.stats.completedAcademics, 1);
  assert.equal(review.priority.id, 'next'); assert.equal(review.tomorrowClasses[0].name, '알고리즘');
  assert.match(review.body, /루틴 1개를 완료/); assert.match(review.nextAction, /보고서, 내일 23:59 마감/);
  assert.equal(review.highlights.length, 4); assert.equal(review.hasContent, true);
  assert.doesNotMatch(review.body, /생활 기록|평균|공부.*게임|0분/);
});

test('empty review skips the notification, zero cards and automatic weekly recap', () => {
  const review = buildEveningReview({ now: new Date(2026, 8, 13, 23, 5), activity: { categories: {} }, healthWeek: [{ sleep_minutes: 420 }, { sleep_minutes: 480 }], activityWeek: [{ category: 'study', seconds: 7200 }, { category: 'game', seconds: 3600 }] });
  assert.equal(review.hasContent, false); assert.deepEqual(review.highlights, []); assert.equal(review.body, '');
  assert.equal(buildEveningReviewCandidate({ review, settings, usageMinutes: 480 }), null);
});

test('game-only record stays neutral and does not compare or demand health input', () => {
  const review = buildEveningReview({ activity: { categories: { game: 10800 } } });
  assert.deepEqual(review.highlights, [{ label: 'PC 게임', value: '3시간' }]);
  assert.equal(review.body, '오늘 PC 게임 시간은 3시간이야.');
  assert.equal(review.nextAction, '');
});

test('nearby plans exclude stale, distant, cancelled, missing and ended items across the year boundary', () => {
  const now = new Date(2026, 11, 31, 23, 0);
  const review = buildEveningReview({ now, academics: [
    { id: 'old', title: '지난 마감', due: '2026-12-01T18:00' },
    { id: 'far', title: '다음 주', due: '2027-01-03T10:00' },
    { id: 'cancelled', title: '취소', due: '2027-01-01T09:00', cancelled_at: '2026-12-30' },
    { id: 'missing', title: '확인 대기', due: '2027-01-01T09:00', missing_since: '2026-12-30' },
    { id: 'ended', title: '종료', due: '2027-01-01T09:00', ended: true },
    { id: 'next', title: '신년 회의', kind: 'event', due: '2027-01-01T10:00' }
  ] });
  assert.equal(review.priority.id, 'next'); assert.equal(review.nextAction, '신년 회의, 내일 10:00에 예정돼 있어.');
  assert.equal(review.hasContent, true);
});

test('long names stay complete on the page and short in the notification', () => {
  const now = new Date(2026, 9, 22, 20, 0), title = '긴 과제 이름 '.repeat(30);
  const review = buildEveningReview({ now, academics: [{ id: 'long', title, due: '2026-10-23T23:59' }] });
  assert.equal(review.priority.title, title); assert.ok(review.body.length < 100); assert.match(review.body, /…/);
});

test('evening popup candidate follows accumulated computer use, quiet hours and toggle', () => {
  const review = { key: 'evening-review:2026-09-12', title: 'ASA · 오늘 결산', body: '결산', hasContent: true };
  assert.equal(buildEveningReviewCandidate({ review, settings, usageMinutes: 359, now: new Date(2026, 8, 12, 18, 0) }), null);
  const candidate = buildEveningReviewCandidate({ review, settings, usageMinutes: 360, now: new Date(2026, 8, 12, 18, 1) });
  assert.equal(candidate.display, 'daily-review'); assert.equal(candidate.itemId, undefined);
  assert.equal(buildEveningReviewCandidate({ review, settings, usageMinutes: 360, now: new Date(2026, 8, 12, 2, 0) }), null);
  const quietDisabled = buildEveningReviewCandidate({ review, settings: { ...settings, quietModeEnabled: false }, usageMinutes: 360, now: new Date(2026, 8, 12, 2, 0) });
  assert.equal(quietDisabled.display, 'daily-review');
  assert.equal(buildEveningReviewCandidate({ review, settings: { ...settings, eveningReview: false }, usageMinutes: 480, now: new Date(2026, 8, 12, 18, 1) }), null);
});
