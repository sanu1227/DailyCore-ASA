import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir, uptime } from 'node:os';
import { buildEveningReviewCandidate, buildEveningReviewFromStore } from './review.mjs';
import { RIN_AWAY_LINES } from './rin-away-lines.mjs';
import { RIN_CASUAL_LINES } from './rin-casual-lines.mjs';
import { buildDeadlineNagCopy } from './rin-nag-lines.mjs';
import { notificationVoiceCategory } from './notification-voice.cjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const USER_AWAY_SECONDS = 5 * 60;

const localDateKey = date => {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export function isQuietTime(now, start, end, enabled = true) {
  if (!enabled || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  const from = startHour * 60 + startMinute;
  const to = endHour * 60 + endMinute;
  return from < to ? current >= from && current < to : current >= from || current < to;
}

export function isUserPresent(activity, awaySeconds = USER_AWAY_SECONDS) {
  const idleSeconds = Number(activity?.idleSeconds);
  return !Number.isFinite(idleSeconds) || idleSeconds < awaySeconds;
}

export function withGamePlacement(candidate, activity) {
  const bounds = activity?.isGame ? activity?.windowBounds : activity?.visibleGameWindowBounds;
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(Number(bounds[key])))) return candidate;
  return { ...candidate, gameWindowBounds: Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Number(bounds[key])])) };
}

export function expandNotificationCandidate(candidate) {
  const items = Array.isArray(candidate?.notificationItems)
    ? candidate.notificationItems.map(item => String(item || '').trim()).filter(Boolean)
    : [];
  const { notificationItems, ...base } = candidate || {};
  if (items.length <= 1) return [{ ...base, body: items[0] || base.body }];
  return items.map((body, index) => ({
    ...base,
    key: `${base.key}:part:${index + 1}`,
    title: `${base.title} · ${index + 1}/${items.length}`,
    body,
    displayDuration: 8500
  }));
}

export function snoozeNotification(store, candidate, now = new Date()) {
  if (!candidate || typeof candidate.key !== 'string' || !candidate.key || candidate.key.length > 500 || typeof candidate.body !== 'string' || candidate.body.length > 8000) throw new Error('Invalid notification');
  const key = candidate.snoozeKey || candidate.key;
  const items = (store.integration('notification_snoozes')?.items || []).filter(item => item.key !== key);
  if (items.length >= 100) throw new Error('미뤄 둔 알림이 너무 많습니다.');
  const saved = { key: candidate.key, title: String(candidate.title || '아사').slice(0, 200), body: candidate.body, snoozeKey: key, snoozedAt: candidate.snoozedAt || now.toISOString() };
  for (const field of ['itemId', 'classId', 'routineId', 'scheduledFor']) if (typeof candidate[field] === 'string') saved[field] = candidate[field].slice(0, 120);
  const until = new Date(now.getTime() + 15 * MINUTE).toISOString();
  items.push({ key, until, candidate: saved });
  store.saveIntegration('notification_snoozes', { items });
  return { until };
}

export async function sendSnoozedNotifications(store, notify, now = new Date()) {
  const settings = store.settings();
  if (!settings.notifications || isQuietTime(now, settings.quietStart, settings.quietEnd, settings.quietModeEnabled)) return;
  const items = store.integration('notification_snoozes')?.items || [];
  for (const item of items) {
    if (new Date(item.until) > now) continue;
    let candidate = { ...item.candidate, key: `${item.key}:snoozed:${item.until}`, volume: settings.notificationVolume ?? 70 };
    const control = store.integration('reminder_control');
    if (candidate.itemId && control?.focus && new Date(control.focus.ends) > now) continue;
    if (candidate.itemId) {
      const current = store.academics(now).find(value => value.id === candidate.itemId);
      if (!current || current.completed || current.missing_since || (candidate.scheduledFor && current.due !== candidate.scheduledFor)) candidate = null;
    }
    if (candidate?.classId) {
      const current = store.classes().find(value => value.id === candidate.classId);
      if (!current || current.day !== (now.getDay() || 7) || `${localDateKey(now)}T${current.start}` !== candidate.scheduledFor) candidate = null;
    }
    if (candidate?.routineId) {
      const current = store.routines(localDateKey(now)).find(value => value.id === candidate.routineId);
      if (!current || !current.active || current.completedToday || !current.days.includes(now.getDay() || 7) || `${localDateKey(now)}T${current.time}` !== candidate.scheduledFor) candidate = null;
    }
    if (item.key.startsWith('health-check:') && !settings.healthCheckReminder) candidate = null;
    if (candidate) await notify(candidate);
    // Re-read after awaiting delivery so a simultaneous snooze is not overwritten.
    const current = store.integration('notification_snoozes')?.items || [];
    store.saveIntegration('notification_snoozes', { items: current.filter(value => value.key !== item.key || value.until !== item.until) });
  }
}

export function buildReminderCandidates({ classes, academics = [], settings, now = new Date() }) {
  if (!settings.notifications || isQuietTime(now, settings.quietStart, settings.quietEnd, settings.quietModeEnabled)) return [];
  const candidates = [];
  const today = now.getDay() || 7;
  for (const item of classes) {
    if (item.day !== today) continue;
    const [hour, minute] = item.start.split(':').map(Number);
    const starts = new Date(now);
    starts.setHours(hour, minute, 0, 0);
    const remaining = starts - now;
    if (remaining > -10 * MINUTE && remaining <= 30 * MINUTE) {
      const where = item.location ? ` (${item.location})` : '';
      const started = remaining <= 0;
      candidates.push({
        key: `class:${item.id}:${localDateKey(now)}:30m`, classId: item.id, scheduledFor: `${localDateKey(now)}T${item.start}`,
        title: started ? '아사 · 수업 시작했어' : '아사 · 곧 수업이야',
        body: started ? `${item.name}${where}, ${item.start}에 시작했어.` : `${item.name}${where}, ${Math.ceil(remaining / MINUTE)}분 뒤 시작이야. 슬슬 준비하자.`
      });
    }
  }
  for (const item of academics) {
    if (item.kind !== 'event' || item.completed || item.missing_since) continue;
    const remaining = new Date(item.due) - now;
    if (remaining >= 0 && remaining <= 30 * MINUTE) candidates.push({
      key: `event:${item.id}:${item.due}:30m`, itemId: item.id, scheduledFor: item.due, title: '아사 · 곧 시작할 일정',
      body: remaining === 0 ? `${item.title}, 지금 시작할 시간이야.` : `${item.title}, ${Math.ceil(remaining / MINUTE)}분 뒤야. 슬슬 준비하자.`
    });
  }
  return candidates;
}

const deadlineRemaining = (due, now) => {
  const minutes = Math.ceil((new Date(due) - now) / MINUTE);
  if (minutes <= 0) return null;
  if (minutes < 60) return `${minutes}분`;
  if (minutes < 24 * 60) return `${Math.ceil(minutes / 60)}시간`;
  return `${Math.ceil(minutes / (24 * 60))}일`;
};

const deadlineSummary = (academics, now) => academics
  .filter(item => !item.completed && !item.missing_since)
  .sort((a, b) => new Date(a.due) - new Date(b.due))
  .slice(0, 3)
  .map(item => {
    const label = item.course ? `${item.course} ${item.title}` : item.title;
    const remaining = deadlineRemaining(item.due, now);
    const timing = item.kind === 'exam' || item.kind === 'event' ? '시작' : '마감';
    return remaining ? `${label}, ${timing}까지 ${remaining} 남았어.` : `${label}, 예정된 ${timing} 시간이 지났어.`;
  });

export function buildStartupDeadlineCandidate({ academics, settings, sessionKey, now = new Date() }) {
  if (!settings.notifications || isQuietTime(now, settings.quietStart, settings.quietEnd, settings.quietModeEnabled)) return null;
  const lines = deadlineSummary(academics, now);
  if (!lines.length) return null;
  return { key: `deadline-start:${sessionKey}`, title: '아사 · 남은 마감 확인', body: lines.join(' '), notificationItems: lines };
}

export function buildGameNagCandidate({ academics, settings, game, activity, now = new Date() }) {
  if (!settings.notifications || !settings.gameNagging || !game?.isGame) return null;
  const urgent = academics
    .filter(item => !item.completed && !item.missing_since && new Date(item.due) > now && new Date(item.due) - now <= DAY)
    .sort((a, b) => new Date(a.due) - new Date(b.due))[0];
  if (!urgent) return null;
  const minutes = settings.gameNagMinutes;
  const slot = Math.floor(now.getTime() / (minutes * MINUTE));
  const label = urgent.course ? `${urgent.course} ${urgent.title}` : urgent.title;
  const remainingMinutes = Math.ceil((new Date(urgent.due) - now) / MINUTE);
  const time = remainingMinutes < 60 ? `${remainingMinutes}분` : `${Math.ceil(remainingMinutes / 60)}시간`;
  const noun = urgent.kind === 'exam' ? '시험' : urgent.kind === 'event' ? '일정' : '과제';
  const gameMinutes = Math.floor((activity?.categories?.game || 0) / 60);
  const key = `game:${urgent.id}:${urgent.due}:${minutes}:${slot}`;
  const copy = buildDeadlineNagCopy({ label, noun, time, gameMinutes, retryMinutes: remainingMinutes > 180 ? minutes : 0, key });
  return { key, ...copy, itemId: urgent.id, display: 'popup' };
}

const routineCopy = item => ({
  sleep: ['아사 · 잘 시간', `${item.title} 시간이야. 저장할 건 저장하고 슬슬 자자.`],
  exercise: ['아사 · 운동 시간', `${item.title} 할 시간이야. 가볍게 몸 좀 풀자.`],
  meal: ['아사 · 밥 먹을 시간', `${item.title} 시간이야. 아직 안 먹었으면 밥부터 먹자.`],
  study: ['아사 · 공부 시간', `${item.title} 할 시간이야. 일단 자료부터 열어 볼까.`],
  other: ['아사 · 루틴 시간', `${item.title}, 지금 하기로 했어.`]
}[item.category] || ['아사 · 루틴 시간', `${item.title}, 지금 하기로 했어.`]);

export function buildRoutineCandidates({ routines = [], settings, now = new Date() }) {
  if (!settings.notifications || isQuietTime(now, settings.quietStart, settings.quietEnd, settings.quietModeEnabled)) return [];
  const today = now.getDay() || 7;
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const date = localDateKey(now);
  const candidates = [];
  for (const item of routines) {
    if (!item.active || item.completedToday || !item.days.includes(today)) continue;
    const [hour, minute] = item.time.split(':').map(Number);
    const elapsed = currentMinutes - (hour * 60 + minute);
    if (elapsed < 0 || elapsed >= 60) continue;
    const milestone = elapsed < 30 ? 'due' : '30m';
    const [title, rawBody] = routineCopy(item);
    candidates.push({ key: `routine:${item.id}:${date}:${milestone}`, routineId: item.id, scheduledFor: `${date}T${item.time}`, title, body: milestone === '30m' ? `${item.title}, 정한 시간보다 ${elapsed}분 지났어. 이미 했으면 완료로 바꿔 줘.` : rawBody, display: 'toast' });
  }
  return candidates;
}

export function buildHealthCheckCandidate({ entry, settings, usageMinutes = 0, now = new Date() }) {
  if (!settings.notifications || !settings.healthCheckReminder || entry || isQuietTime(now, settings.quietStart, settings.quietEnd, settings.quietModeEnabled)) return null;
  if (usageMinutes < settings.healthCheckUsageMinutes) return null;
  return { key: `health-check:${localDateKey(now)}`, title: '아사 · 오늘 기록', body: '오늘 수면, 식사, 운동 기록이 아직 없어. 기억날 때 짧게 남겨 둘래?' };
}

const casualTitles = ['아사 · 있잖아', '아사 · 잠깐 수다'];
const awayTitles = ['아사 · 편할 때 봐', '아사 · 나중에 얘기하자'];
const hash = value => [...String(value)].reduce((result, char) => Math.imul(result ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261);
export const AWAY_CASUAL_THRESHOLDS = [5, 20, 45, 90, 180];

export function casualUsageThresholds(date) {
  const result = [];
  let seed = hash(date);
  let minute = 15 + seed % 16;
  for (let index = 0; index < 10; index++) {
    result.push(minute);
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    minute += 25 + seed % 21;
  }
  return result;
}

export function buildCasualConversationCandidate({ settings, usageMinutes = 0, now = new Date() }) {
  if (!settings.notifications || !settings.casualNotifications || isQuietTime(now, settings.quietStart, settings.quietEnd, settings.quietModeEnabled)) return null;
  const date = localDateKey(now);
  const thresholds = casualUsageThresholds(date);
  const slot = thresholds.reduce((current, threshold, index) => usageMinutes >= threshold ? index + 1 : current, 0);
  if (!slot) return null;
  const seed = hash(`${date}:${slot}:${settings.name || ''}`);
  const body = RIN_CASUAL_LINES[(seed + slot * 37) % RIN_CASUAL_LINES.length]
    .replaceAll('{name}', settings.name?.trim() || '있잖아');
  return { key: `casual:${date}:${slot}`, title: casualTitles[seed % casualTitles.length], body, kind: 'casual' };
}

export function buildAwayCasualCandidate({ settings, activity, awaySince, now = new Date() }) {
  if (!settings.notifications || !settings.casualNotifications || isQuietTime(now, settings.quietStart, settings.quietEnd, settings.quietModeEnabled)) return null;
  const idleSeconds = Number(activity?.idleSeconds);
  if (!Number.isFinite(idleSeconds) || idleSeconds < USER_AWAY_SECONDS || !awaySince) return null;
  const idleMinutes = Math.floor(idleSeconds / 60);
  const slot = AWAY_CASUAL_THRESHOLDS.reduce((current, threshold, index) => idleMinutes >= threshold ? index + 1 : current, 0);
  if (!slot) return null;
  const seed = hash(`${awaySince}:${slot}:${settings.name || ''}`);
  const body = RIN_AWAY_LINES[(seed + slot * 29) % RIN_AWAY_LINES.length]
    .replaceAll('{name}', settings.name?.trim() || '있잖아');
  return { key: `away:${awaySince}:${slot}`, title: awayTitles[seed % awayTitles.length], body, kind: 'casual' };
}

const sameLocalDay = (value, now) => Boolean(value) && localDateKey(new Date(value)) === localDateKey(now);

export function buildDailyBriefing({ classes, academics, routines = [], eclass, settings, now = new Date() }) {
  if (!settings.notifications || !settings.dailyBriefing || isQuietTime(now, settings.quietStart, settings.quietEnd, settings.quietModeEnabled)) return null;
  const today = now.getDay() || 7;
  const todayClasses = classes.filter(item => item.day === today).sort((a, b) => a.start.localeCompare(b.start));
  const deadlines = deadlineSummary(academics, now);
  const parts = [];
  if (todayClasses.length) {
    for (const item of todayClasses.slice(0, 3)) parts.push(`${item.start} ${item.name}${item.location ? ` (${item.location})` : ''} 수업이 있어.`);
    if (todayClasses.length > 3) parts.push(`수업이 ${todayClasses.length - 3}개 더 있어. 나머지는 시간표에서 봐.`);
  } else parts.push('오늘 등록된 수업은 없어.');
  if (deadlines.length) parts.push(...deadlines);
  else parts.push('남아 있는 마감은 없어.');
  const pendingRoutines = routines.filter(item => item.active && item.days.includes(today) && !item.completedToday);
  if (pendingRoutines.length) {
    for (const item of pendingRoutines.slice(0, 3)) parts.push(`${item.time} ${item.title}도 예정돼 있어.`);
    if (pendingRoutines.length > 3) parts.push(`오늘 루틴이 ${pendingRoutines.length - 3}개 더 남아 있어.`);
  }
  else if (routines.some(item => item.active && item.days.includes(today))) parts.push('오늘 루틴은 다 끝냈네. 수고했어.');
  parts.push(sameLocalDay(eclass?.lastSync, now) ? 'e-Class도 오늘 확인했어.' : 'e-Class는 아직 오늘 동기화한 기록이 없어. 저장된 일정 기준이야.');
  if (eclass?.missing > 0) parts.push(`Todo에서 사라진 일정 ${eclass.missing}개가 있어. 완료한 건지 확인해 줘.`);
  return { key: `briefing:${localDateKey(now)}`, title: '아사 · 오늘 브리핑', body: parts.join(' '), notificationItems: parts };
}

export function detectForegroundGame() {
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'Get-RinForegroundGame.ps1')], { windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', () => resolve({ isGame: false, name: '' }));
    child.on('close', code => {
      if (code !== 0) return resolve({ isGame: false, name: '' });
      try { resolve(JSON.parse(output.trim())); } catch { resolve({ isGame: false, name: '' }); }
    });
  });
}

export function showWindowsNotification(candidate) {
  if (candidate?.gameWindowBounds) return Promise.resolve({ suppressed: true });
  const { title, body } = candidate;
  const encode = value => Buffer.from(value, 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'Show-RinNotification.ps1'), encode(title), encode(body), notificationVoiceCategory(candidate), '-Volume', String(candidate.volume ?? 70)], { windowsHide: true });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error.trim() || `알림 도구 종료 코드 ${code}`)));
  });
}

function showPopup(scriptName, candidate, { token, baseUrl }) {
  const { title, body, itemId, gameWindowBounds } = candidate;
  const encode = value => Buffer.from(value, 'utf8').toString('base64');
  return new Promise((resolve, reject) => {
    const placement = gameWindowBounds ? encode(JSON.stringify(gameWindowBounds)) : '__RIN_EMPTY__';
    const readyPath = join(tmpdir(), `rin-popup-${randomUUID()}.ready`);
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(root, scriptName), encode(title), encode(body), itemId || '__RIN_EMPTY__', token, baseUrl, '0', placement, readyPath, notificationVoiceCategory(candidate), '-Volume', String(candidate.volume ?? 70)], {
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let settled = false;
    let output = '';
    let error = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { error += chunk; });
    const cleanup = () => {
      clearInterval(poll);
      clearTimeout(timeout);
      try { unlinkSync(readyPath); } catch {}
    };
    const finish = (failure, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) return reject(failure);
      child.removeAllListeners('exit');
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      resolve(result);
    };
    const checkReady = () => {
      if (!existsSync(readyPath)) return;
      const status = readFileSync(readyPath, 'utf8').trim();
      finish(null, status === 'suppressed' ? { suppressed: true } : undefined);
    };
    const poll = setInterval(checkReady, 50);
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error(`${scriptName} 창이 8초 안에 열리지 않았습니다.${(error || output).trim() ? ` ${(error || output).trim()}` : ''}`));
    }, 8000);
    child.once('error', finish);
    child.once('exit', code => {
      checkReady();
      if (!settled) finish(new Error((error || output).trim() || `${scriptName} 창이 열리기 전에 종료됐습니다. (종료 코드 ${code})`));
    });
  });
}

export function showUrgentPopup(candidate, { token, baseUrl = 'http://127.0.0.1:4317' }) {
  return showPopup('Show-RinUrgentPopup.ps1', candidate, { token, baseUrl });
}

export class ReminderService {
  constructor(store, { notify = showWindowsNotification, detectGame = detectForegroundGame, now = () => new Date(), intervalMs = MINUTE, briefingWaitMs = 5 * MINUTE, sessionKey = `boot-${Math.floor((Date.now() - uptime() * 1000) / (10 * MINUTE))}` } = {}) {
    this.store = store; this.notify = notify; this.detectGame = detectGame; this.now = now; this.intervalMs = intervalMs;
    this.briefingWaitMs = briefingWaitMs; this.startedAt = this.now(); this.sessionKey = sessionKey;
    this.timer = null; this.running = false;
  }
  async sendCandidate(candidate, activity, academics = null) {
    const placed = withGamePlacement({ ...candidate, volume: this.store.settings().notificationVolume ?? 70 }, activity);
    for (const item of expandNotificationCandidate(placed)) {
      // Discard stale queued text after a chat edit/cancellation. Rebuild on the next tick.
      if (academics && JSON.stringify(academics) !== JSON.stringify(this.store.academics(this.now()))) return false;
      await this.notify(item);
    }
    return true;
  }
  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      await sendSnoozedNotifications(this.store, this.notify, now);
      const settings = this.store.settings();
      const academics = this.store.academics(now);
      const routines = this.store.routines(localDateKey(now));
      let control = this.store.integration('reminder_control') || { snoozes: {}, focus: null };
      const focusEnded = Boolean(control.focus && new Date(control.focus.ends) <= now);
      const focusEndKey = focusEnded ? `focus-end:${control.focus.started}` : null;
      const focusEndPending = Boolean(focusEndKey && !this.store.notificationSent(focusEndKey));
      const focusActive = Boolean(control.focus && new Date(control.focus.ends) > now);
      const snoozed = itemId => Boolean(itemId && control.snoozes?.[itemId] && new Date(control.snoozes[itemId]) > now);
      const candidates = [...buildReminderCandidates({ classes: this.store.classes(), academics, settings, now }), ...buildRoutineCandidates({ routines, settings, now })]
        .filter(candidate => !candidate.itemId || (!focusActive && !snoozed(candidate.itemId)));
      const startupDeadline = focusActive ? null : buildStartupDeadlineCandidate({ academics, settings, sessionKey: this.sessionKey, now });
      if (startupDeadline) candidates.unshift(startupDeadline);
      const activity = this.store.activity(localDateKey(now));
      const usageMinutes = Math.floor(activity.totalSeconds / 60);
      const healthCheck = buildHealthCheckCandidate({ entry: this.store.health(localDateKey(now)), settings, usageMinutes, now });
      if (healthCheck) candidates.push(healthCheck);
      const review = buildEveningReviewFromStore(this.store, now);
      const evening = buildEveningReviewCandidate({ review, settings, usageMinutes, now });
      if (evening) candidates.push(evening);
      const eclass = this.store.integration('eclass');
      const waitingForEclass = eclass && !sameLocalDay(eclass.lastSync, now) && now - this.startedAt < this.briefingWaitMs;
      const briefing = waitingForEclass ? null : buildDailyBriefing({ classes: this.store.classes(), academics, routines, eclass, settings, now });
      const briefingPending = Boolean(briefing && !this.store.notificationSent(briefing.key));
      const hasPendingCandidate = candidates.some(candidate => !this.store.notificationSent(candidate.key));
      const lastNotification = this.store.lastNotification();
      const casualCooldown = Boolean(lastNotification && now - new Date(lastNotification.sent) < 20 * MINUTE);
      const casual = !focusActive && !briefingPending && !hasPendingCandidate && !casualCooldown ? buildCasualConversationCandidate({ settings, usageMinutes, now }) : null;
      if (casual) candidates.push(casual);
      const maySendAwayCasual = settings.notifications && settings.casualNotifications && !isQuietTime(now, settings.quietStart, settings.quietEnd, settings.quietModeEnabled);
      const hasUrgentDeadline = academics.some(item => !item.completed && !item.missing_since && new Date(item.due) > now && new Date(item.due) - now <= DAY);
      const mayNagAboutGame = !focusActive && settings.notifications && settings.gameNagging && hasUrgentDeadline;
      let foreground = null;
      let away = null;
      if (focusEndPending || briefingPending || hasPendingCandidate || mayNagAboutGame || maySendAwayCasual) {
        foreground = await this.detectGame();
        if (!isUserPresent(foreground)) {
          const previous = this.store.integration('reminder_presence');
          const awaySince = previous?.away && previous.deferredSince
            ? previous.deferredSince
            : new Date(now.getTime() - Number(foreground.idleSeconds) * 1000).toISOString();
          const presence = {
            away: true,
            deferredSince: awaySince,
            lastChecked: now.toISOString(),
            idleSeconds: Number(foreground.idleSeconds)
          };
          this.store.saveIntegration('reminder_presence', presence);
          away = buildAwayCasualCandidate({ settings, activity: foreground, awaySince, now });
        }
        else {
          const previous = this.store.integration('reminder_presence');
          if (previous?.away) this.store.saveIntegration('reminder_presence', { away: false, returnedAt: now.toISOString(), lastChecked: now.toISOString(), idleSeconds: Number(foreground.idleSeconds) });
        }
      }
      const sendAway = async () => {
        if (!away || this.store.notificationSent(away.key)) return;
        if (!await this.sendCandidate(away, foreground, academics)) return;
        this.store.markNotificationSent(away.key, this.now().toISOString());
      };
      if (control.focus && new Date(control.focus.ends) <= now) {
        if (!this.store.notificationSent(focusEndKey)) {
          if (!await this.sendCandidate({ key: focusEndKey, title: '아사 · 25분 끝났어', body: `${control.focus.title}, 25분 지났어. 잠깐 쉬었다 이어 하자.` }, foreground, academics)) return;
          this.store.markNotificationSent(focusEndKey, this.now().toISOString());
        }
        await sendAway();
        control = { ...control, focus: null };
        this.store.saveIntegration('reminder_control', control);
        return;
      }
      if (briefing && !this.store.notificationSent(briefing.key)) {
        if (!await this.sendCandidate(briefing, foreground, academics)) return;
        const sent = this.now().toISOString();
        this.store.markNotificationSent(briefing.key, sent);
        this.store.saveIntegration('briefing', { title: briefing.title, body: briefing.body, sent });
        if (startupDeadline) this.store.markNotificationSent(startupDeadline.key, sent);
        await sendAway();
        return;
      }
      let sentRegular = false;
      for (const candidate of candidates) {
        if (this.store.notificationSent(candidate.key)) continue;
        if (!await this.sendCandidate(candidate, foreground, academics)) return;
        this.store.markNotificationSent(candidate.key, this.now().toISOString());
        if (candidate.display === 'daily-review') this.store.saveIntegration('evening_review', { ...review, sent: this.now().toISOString() });
        sentRegular = true;
      }
      await sendAway();
      if (!focusActive && (!sentRegular || away) && settings.notifications && settings.gameNagging && hasUrgentDeadline) {
        const recent = this.store.integration('current_activity');
        const game = foreground || (recent?.checkedAt && now - new Date(recent.checkedAt) <= 2 * MINUTE ? recent : await this.detectGame());
        const nag = buildGameNagCandidate({ academics, settings, game, activity, now });
        if (nag && !snoozed(nag.itemId) && !this.store.notificationSent(nag.key)) {
          if (!await this.sendCandidate(nag, game, academics)) return;
          this.store.markNotificationSent(nag.key, this.now().toISOString());
        }
      }
    } catch (error) { console.error(`Reminder error: ${error.message}`); }
    finally { this.running = false; }
  }
}
