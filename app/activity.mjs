import { detectForegroundGame, isQuietTime, showWindowsNotification, withGamePlacement } from './reminders.mjs';
import { buildBedtimeNagCopy, buildBreakNagCopy } from './rin-nag-lines.mjs';

const MINUTE = 60_000;
const localDateKey = date => {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const STUDY_APPS = new Set(['code', 'devenv', 'pycharm64', 'idea64', 'eclipse', 'codeblocks', 'clion64', 'rider64', 'matlab', 'rstudio', 'notepad++']);
const VIDEO_APPS = new Set(['vlc', 'mpv', 'potplayer', 'potplayermini64', 'wmplayer', 'moviesandtv', 'kmp']);
const GAME_APPS = new Set(['nikke']);
const IGNORED_APPS = new Set(['lockapp', 'logonui', 'screensaver', 'idle']);

export function classifyActivity(activity) {
  const app = String(activity?.name || '').trim().slice(0, 80);
  const key = app.toLocaleLowerCase('en-US');
  if (!app || activity?.idleSeconds >= 300 || IGNORED_APPS.has(key)) return { track: false, app, category: 'other' };
  if (activity?.isGame || GAME_APPS.has(key)) return { track: true, app, category: 'game' };
  if (STUDY_APPS.has(key)) return { track: true, app, category: 'study' };
  if (VIDEO_APPS.has(key)) return { track: true, app, category: 'video' };
  return { track: true, app, category: 'other' };
}

export function buildActivityCandidates({ activity, routines = [], settings, continuousMinutes = 0, continuousStarted, now = new Date() }) {
  if (!settings.notifications || !settings.activityTracking || !activity?.track) return [];
  const result = [];
  const date = localDateKey(now);
  const breakMinutes = settings.breakMinutes;
  const breakSlot = Math.floor(continuousMinutes / breakMinutes);
  const session = continuousStarted instanceof Date ? continuousStarted.toISOString() : date;
  if (breakSlot >= 1 && !isQuietTime(now, settings.quietStart, settings.quietEnd, settings.quietModeEnabled)) {
    const key = `activity-break:${session}:${breakSlot}`;
    result.push({ key, ...buildBreakNagCopy({ minutes: breakSlot * breakMinutes, key }) });
  }
  if (activity.category === 'game') {
    const today = now.getDay() || 7;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const bedtime = routines.filter(item => item.active && item.category === 'sleep' && item.days.includes(today))
      .filter(item => { const [h, m] = item.time.split(':').map(Number); return nowMinutes >= h * 60 + m; })
      .sort((a, b) => b.time.localeCompare(a.time))[0];
    if (bedtime) {
      const slot = Math.floor(now.getTime() / (settings.gameNagMinutes * MINUTE));
      const key = `bedtime-game:${bedtime.id}:${date}:${slot}`;
      result.push({ key, ...buildBedtimeNagCopy({ routine: bedtime.title, key }) });
    }
  }
  return result;
}

export class ActivityService {
  constructor(store, { detectActivity = detectForegroundGame, notify = showWindowsNotification, now = () => new Date(), intervalMs = 30_000 } = {}) {
    this.store = store; this.detectActivity = detectActivity; this.notify = notify; this.now = now; this.intervalMs = intervalMs;
    this.timer = null; this.running = false; this.lastAt = null; this.lastActivity = null; this.continuousSince = null;
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
      const settings = this.store.settings();
      if (!settings.activityTracking) { this.lastAt = now; this.lastActivity = null; this.continuousSince = null; return; }
      const detected = await this.detectActivity();
      const current = classifyActivity(detected);
      if (this.lastAt && this.lastActivity?.track && localDateKey(this.lastAt) === localDateKey(now)) {
        const seconds = Math.min(Math.max(0, Math.round((now - this.lastAt) / 1000)), Math.ceil(this.intervalMs / 1000) * 2);
        if (seconds) this.store.addActivity(localDateKey(now), this.lastActivity.app, this.lastActivity.category, seconds);
      }
      if (!current.track) this.continuousSince = null;
      else if (!this.continuousSince) this.continuousSince = now;
      this.lastAt = now; this.lastActivity = current;
      const gameActivity = { ...detected, isGame: current.category === 'game' };
      this.store.saveIntegration('current_activity', { app: current.app, category: current.category, track: current.track, isGame: current.category === 'game', windowBounds: detected?.windowBounds || null, checkedAt: now.toISOString() });
      const continuousMinutes = this.continuousSince ? Math.floor((now - this.continuousSince) / MINUTE) : 0;
      const candidates = buildActivityCandidates({ activity: current, routines: this.store.routines(localDateKey(now)), settings, continuousMinutes, continuousStarted: this.continuousSince, now });
      for (const candidate of candidates) {
        if (this.store.notificationSent(candidate.key)) continue;
        await this.notify(withGamePlacement({ ...candidate, volume: settings.notificationVolume ?? 70 }, gameActivity)); this.store.markNotificationSent(candidate.key, now.toISOString());
      }
    } catch (error) { console.error(`Activity error: ${error.message}`); }
    finally { this.running = false; }
  }
}
