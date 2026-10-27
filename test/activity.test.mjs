import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityService, buildActivityCandidates, classifyActivity } from '../app/activity.mjs';
import { Store } from '../app/store.mjs';

const settings = { notifications: true, activityTracking: true, breakMinutes: 50, gameNagMinutes: 15, quietStart: '01:00', quietEnd: '07:00' };

test('classifies foreground apps without using window content', () => {
  assert.deepEqual(classifyActivity({ name: 'Code', isGame: false, idleSeconds: 2 }), { track: true, app: 'Code', category: 'study' });
  assert.equal(classifyActivity({ name: 'GameClient', isGame: true, idleSeconds: 0 }).category, 'game');
  assert.equal(classifyActivity({ name: 'NIKKE', isGame: false, idleSeconds: 0 }).category, 'game');
  assert.equal(classifyActivity({ name: 'vlc', isGame: false, idleSeconds: 0 }).category, 'video');
  assert.equal(classifyActivity({ name: 'chrome', isGame: false, idleSeconds: 301 }).track, false);
});

test('builds break and bedtime game reminders', () => {
  const now = new Date(2026, 8, 11, 23, 10);
  const activity = { track: true, app: 'Game', category: 'game' };
  const routines = [{ id: 'sleep', title: '취침 준비', category: 'sleep', days: [5], time: '23:00', active: 1 }];
  const result = buildActivityCandidates({ activity, routines, settings, continuousMinutes: 52, now });
  assert.equal(result.length, 2); assert.match(result[0].key, /^activity-break:/); assert.match(result[1].key, /^bedtime-game:/);
  assert.match(result[1].body, /취침 준비/);
});

test('quiet hours suppress breaks but keep active-game bedtime nagging', () => {
  const now = new Date(2026, 8, 11, 2, 10);
  const activity = { track: true, app: 'Game', category: 'game' };
  const routines = [{ id: 'sleep', title: '취침 준비', category: 'sleep', days: [5], time: '01:00', active: 1 }];
  const result = buildActivityCandidates({ activity, routines, settings, continuousMinutes: 52, now });
  assert.equal(result.length, 1);
  assert.match(result[0].key, /^bedtime-game:sleep:2026-09-11:/);
  const disabled = buildActivityCandidates({ activity, routines, settings: { ...settings, quietModeEnabled: false }, continuousMinutes: 52, now });
  assert.equal(disabled.length, 2);
  assert.match(disabled[0].key, /^activity-break:/);
});

test('activity service aggregates elapsed time by app and category', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-activity-'));
  const store = new Store(join(dir, 'rin.sqlite'));
  let now = new Date(2026, 8, 11, 12, 0, 0);
  try {
    const service = new ActivityService(store, { now: () => now, intervalMs: 30_000, detectActivity: async () => ({ name: 'Code', isGame: false, idleSeconds: 0 }), notify: async () => {} });
    await service.tick(); now = new Date(2026, 8, 11, 12, 0, 30); await service.tick();
    const activity = store.activity('2026-09-11');
    assert.equal(activity.totalSeconds, 30); assert.equal(activity.categories.study, 30); assert.equal(activity.apps[0].app, 'Code');
    assert.deepEqual(Object.keys(store.integration('current_activity')).sort(), ['app', 'category', 'checkedAt', 'isGame', 'track', 'windowBounds']);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('reclassifies existing NIKKE activity as game time', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rin-game-migration-'));
  const path = join(dir, 'rin.sqlite');
  try {
    const first = new Store(path);
    first.addActivity('2026-09-13', 'nikke', 'other', 300);
    first.addActivity('2026-09-13', 'nikke', 'game', 30);
    first.close();
    const second = new Store(path);
    const activity = second.activity('2026-09-13');
    assert.equal(activity.categories.game, 330);
    assert.equal(activity.categories.other, 0);
    assert.equal(activity.apps.filter(item => item.app === 'nikke').length, 1);
    second.close();
  } finally { rmSync(dir, { recursive: true }); }
});
