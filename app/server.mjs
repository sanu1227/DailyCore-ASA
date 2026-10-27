import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { createCodexClient } from './codex.mjs';
import { AppError, buildRequest, generate, interpretAcademicCommand, CODEX_MODEL, probeAiConnections, shouldInterpretAcademicCommand } from './provider.mjs';
import { ReminderService, showUrgentPopup, showWindowsNotification } from './reminders.mjs';
import { cleanScheduleTitle, isCompletion, isScheduleDetail, nextRecurringDue, projectRecurringItem, recurrenceEnd, recurrenceFromText, recurrenceProblem, recurrenceType, recurrenceTypes, recurrenceWhen, recurrenceWords, repeats, sameRecurrenceRule, scheduleWhen, validDateKey, withinRepeatEnd } from './schedule-intent.mjs';
import { prepareScheduleChange } from './schedule-changes.mjs';
import { ActivityService } from './activity.mjs';
import { extractMemories, projectMemories } from './memory.mjs';
import { buildEveningReviewFromStore } from './review.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ECLASS_EXTENSION_ID = 'cgncdfclndlgahkegcpldngkkokgeojd';
const ECLASS_EXTENSION_ORIGIN = `chrome-extension://${ECLASS_EXTENSION_ID}`;
const assets = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/client.js': ['client.js', 'text/javascript'], '/seoa-portrait.js': ['seoa-portrait.js', 'text/javascript'], '/assets/rin-chibi.png': ['assets/rin-chibi.png', 'image/png'] };
assets['/seoa-gallery.js'] = ['seoa-gallery.js', 'text/javascript'];
for (const name of ['portrait', 'choom', 'moon', 'supa-dupa-luv']) {
  const file = `assets/asa/${name}.jpg`;
  assets[`/${file}`] = [file, 'image/jpeg'];
}
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(`내용은 1~${max}자로 입력해 주세요.`);
  return value.trim();
};
const strength = value => {
  if (!Number.isInteger(value) || value < 0 || value > 5) throw new AppError('강도는 0~5 사이여야 합니다.');
  return value;
};
const optionalText = (value, max) => {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > max) throw new AppError(`내용은 ${max}자 이내로 입력해 주세요.`);
  return value.trim();
};
const clock = value => {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new AppError('시간을 올바르게 입력해 주세요.');
  return value;
};
const localDateTime = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new AppError('마감 날짜와 시간을 올바르게 입력해 주세요.');
  const date = new Date(`${value}:00`);
  const pad = number => String(number).padStart(2, '0');
  const normalized = Number.isNaN(date.getTime()) ? '' : `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (normalized !== value) throw new AppError('마감 날짜와 시간을 올바르게 입력해 주세요.');
  return value;
};
const localDateKey = date => {
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const daysAgoKey = (now, count) => { const date = new Date(now); date.setDate(date.getDate() - count); return localDateKey(date); };
const localDate = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new AppError('날짜를 올바르게 입력해 주세요.');
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime()) || localDateKey(date) !== value) throw new AppError('날짜를 올바르게 입력해 주세요.');
  return value;
};
const integer = (value, min, max, label) => {
  if (!Number.isInteger(value) || value < min || value > max) throw new AppError(`${label} 값이 올바르지 않습니다.`);
  return value;
};
async function readBody(req, maxBytes = 20000) {
  req.setEncoding('utf8');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new AppError('요청이 너무 큽니다.', 413);
  }
  try { return JSON.parse(body); } catch { throw new AppError('올바른 JSON 요청이 필요합니다.'); }
}

const scheduleForAI = (store, now = new Date()) => {
  const currentDay = now.getDay() || 7;
  const currentClock = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const classes = store.classes().map(({ name, day, start, end, location }) => ({ name, day, start, end, location }));
  const todayClasses = classes.filter(item => item.day === currentDay).map(item => ({
    ...item, status: currentClock < item.start ? 'upcoming' : currentClock < item.end ? 'in_progress' : 'ended'
  }));
  const academics = store.academics(now).filter(item => !item.completed && !item.missing_since).map(({ title, course, kind, due, repeat_weekly, recurrence, monthly_day, repeat_until, series_due, occurrence_due }) => ({
    title, course, kind, due, repeat_weekly, recurrence, monthly_day, repeat_until, series_due, occurrence_due, remainingMinutes: Math.ceil((new Date(due) - now) / 60000)
  }));
  const todayRoutines = store.routines(localDateKey(now))
    .filter(item => item.active && item.days.includes(currentDay))
    .map(({ title, category, time, completedToday }) => ({ title, category, time, completed: Boolean(completedToday) }));
  const classNeedsAttention = todayClasses.some(item => item.status === 'in_progress' || (item.status === 'upcoming' && (() => {
    const [hour, minute] = item.start.split(':').map(Number);
    return hour * 60 + minute - (now.getHours() * 60 + now.getMinutes()) <= 90;
  })()));
  return {
    currentDay,
    gameAdvice: academics.some(item => item.remainingMinutes <= 24 * 60) ? 'finish_deadline_first' : classNeedsAttention ? 'class_first' : 'allowed',
    todayClasses,
    todayRoutines,
    classes,
    academics,
    activity: store.activity(localDateKey(now)),
    health: store.healthRange(daysAgoKey(now, 6), localDateKey(now))
  };
};

const normalized = value => value.toLocaleLowerCase('ko-KR').replace(/[\s\p{P}\p{S}]/gu, '');

function prepareAcademicCommand(store, intent, now = new Date()) {
  if (!intent || typeof intent !== 'object' || Array.isArray(intent)) return { status: 'failed', message: '일정 명령 형식이 올바르지 않아 변경하지 않았어.' };
  if (intent.action === 'none') return { status: 'needs_details', message: optionalText(intent.reason, 200) || '일정 이름 또는 날짜가 불명확하여 저장하지 않음.' };
  if (intent.action === 'add') {
    if (!['assignment', 'exam', 'event'].includes(intent.kind)) return { status: 'failed', message: '일정 종류를 판단하지 못해서 추가하지 않았어.' };
    if (store.academics().length >= 200) return { status: 'failed', message: '학업 일정 저장 한도에 도달했어.' };
    try {
      const proposedCourse = optionalText(intent.course, 60);
      const course = ['assignment', 'exam', 'event', '과제', '시험', '일정'].includes(proposedCourse.toLocaleLowerCase('ko-KR')) ? '' : proposedCourse;
      const value = { title: text(intent.title, 100), course, kind: intent.kind, due: localDateTime(intent.due), notes: '', completed: false, recurrence: recurrenceType(intent), monthly_day: intent.monthly_day || 0, repeat_until: intent.repeat_until ?? null, repeat_weekly: recurrenceType(intent) === 'weekly' ? 1 : 0 };
      if (new Date(value.due) <= now) return { status: 'needs_details', message: '마감 시간이 이미 지났어. 앞으로의 날짜를 말해 줘.' };
      if (!withinRepeatEnd(value, value.due)) return { status: 'needs_details', message: '종료일이 첫 회차보다 빨라. 더 뒤의 종료일을 말해 줘.' };
      const existing = store.academics(now, true).find(item => !item.completed && normalized(item.title) === normalized(value.title) && normalized(item.course) === normalized(value.course) && sameRecurrenceRule(item, value));
      if (existing && (existing.ended || (existing.repeat_until ?? null) !== value.repeat_until)) return { status: 'needs_details', message: `${value.title}, 같은 반복 기록이 있어. 새로 복제하지 않을게. “${value.title} 종료일을 바꿔줘”라고 말하면 기간을 수정할 수 있어.` };
      if (existing) return { status: 'success', action: 'existing', itemId: existing.id, title: existing.title, due: existing.due, series_due: existing.series_due, repeat_weekly: existing.repeat_weekly, recurrence: existing.recurrence, monthly_day: existing.monthly_day, repeat_until: existing.repeat_until };
      const itemId = randomUUID();
      return { status: 'success', action: 'add', itemId, title: value.title, due: value.due, repeat_weekly: value.repeat_weekly, recurrence: value.recurrence, monthly_day: value.monthly_day, repeat_until: value.repeat_until, commit: () => store.saveAcademic(value, itemId) };
    } catch (error) { return { status: 'needs_details', message: error instanceof AppError ? error.message : '일정을 추가하지 못했어.' }; }
  }
  if (intent.action === 'complete') {
    let query;
    try { query = text(intent.query, 100); } catch { return { status: 'needs_details', message: '완료한 일정 이름을 말해 줘.' }; }
    const pending = store.academics().filter(item => !item.completed);
    const needle = normalized(query);
    const exact = pending.filter(item => [item.title, `${item.course} ${item.title}`].some(value => normalized(value) === needle));
    const partial = pending.filter(item => {
      const title = normalized(item.title);
      const full = normalized(`${item.course} ${item.title}`);
      return needle.length >= 2 && (title.includes(needle) || full.includes(needle) || needle.includes(title));
    });
    const matches = exact.length ? exact : partial;
    if (matches.length !== 1) {
      const names = matches.slice(0, 3).map(item => item.title).join(', ');
      return { status: 'needs_details', message: matches.length ? `어느 일정인지 하나로 정해 줘: ${names}` : `${query}이라는 미완료 일정을 찾지 못했어.` };
    }
    if (repeats(matches[0])) return { status: 'needs_details', message: '반복 일정은 다음 회차로 자동 이어져. 반복을 끝내려면 전체 취소라고 말해 줘.' };
    return { status: 'success', action: 'complete', itemId: matches[0].id, title: matches[0].title, due: matches[0].due, commit: () => store.toggleAcademic(matches[0].id, true) };
  }
  return { status: 'failed', message: '지원하지 않는 일정 변경이라 실행하지 않았어.' };
}

function applyReminderAction(store, body, now = new Date()) {
  const itemId = text(body.itemId, 100);
  if (!['focus', 'snooze', 'complete'].includes(body.action)) throw new AppError('알림 응답이 올바르지 않습니다.');
  const item = store.academics().find(value => value.id === itemId);
  if (!item) throw new AppError('일정을 찾을 수 없습니다.', 404);
  if (item.completed && body.action !== 'complete') throw new AppError('이미 완료한 일정입니다.');
  const control = store.integration('reminder_control') || { snoozes: {}, focus: null };
  control.snoozes ||= {};
  const stamp = date => date.toISOString();
  if (body.action === 'complete') {
    if (repeats(item)) throw new AppError('반복 일정은 다음 회차로 자동 이어집니다. 종료하려면 대화에서 반복 전체 취소를 요청해 주세요.');
    store.toggleAcademic(itemId, true);
    delete control.snoozes[itemId];
    if (control.focus?.itemId === itemId) control.focus = null;
    control.lastAction = { action: 'complete', itemId, at: stamp(now), message: `${item.title}을 완료로 표시했어.` };
  } else if (body.action === 'snooze') {
    const until = new Date(now.getTime() + 15 * 60_000);
    control.snoozes[itemId] = stamp(until);
    if (control.focus?.itemId === itemId) control.focus = null;
    control.lastAction = { action: 'snooze', itemId, at: stamp(now), message: `알겠어. 15분 뒤에 다시 알려 줄게.` };
  } else {
    if (item.completed) throw new AppError('이미 완료한 일정입니다.');
    const ends = new Date(now.getTime() + 25 * 60_000);
    delete control.snoozes[itemId];
    control.focus = { itemId, title: item.title, started: stamp(now), ends: stamp(ends) };
    control.lastAction = { action: 'focus', itemId, at: stamp(now), message: `${item.title}, 25분 타이머 켰어. 끝나면 알려 줄게.` };
  }
  store.saveIntegration('reminder_control', control);
  return control.lastAction;
}

export function createApp({ dataPath = join(root, 'data', 'rin.sqlite'), codexClient = createCodexClient({ cwd: join(dirname(dataPath), 'codex-runtime') }) } = {}) {
  const store = new Store(dataPath);
  store.saveSettings({ ...store.settings(), model: CODEX_MODEL });
  const token = randomBytes(32).toString('hex');
  const persona = readFileSync(join(root, 'prompts', 'rin-local-system.md'), 'utf8');
  let busy = false;
  let usage = null;
  let provider = null;
  let emitStatus = null;
  let providerStatus = { provider: null, model: null, stage: null, status: null, lastSuccess: null, fallbackReason: '', retryReason: '', error: '', stages: {} };
  const recordProvider = (stage, result) => {
    const value = { fallbackReason: '', retryReason: '', error: '', elapsedMs: 0, firstTokenMs: null, ...result };
    // Memory may finish after the reply. It must not replace the model that wrote it.
    const stages = { ...providerStatus.stages, [stage]: value };
    if (stage === 'memory') providerStatus = { ...providerStatus, stages };
    else {
      provider = value.provider;
      providerStatus = { ...providerStatus, ...value, stage, lastSuccess: value.status === 'success' ? value.finishedAt : null, stages };
    }
    emitStatus?.({ type: 'status', providerStatus });
  };
  const recordRules = () => recordProvider('schedule', { provider: null, model: null, status: 'rules', finishedAt: new Date().toISOString() });
  const refreshProviderStatus = async () => {
    const connections = await probeAiConnections({ codexClient });
    providerStatus = { ...providerStatus, ...connections };
    return providerStatus;
  };
  const state = () => { const now = new Date(); const today = localDateKey(now); return { settings: store.settings(), messages: store.messages(), memories: store.memories(), classes: store.classes(), academics: store.academics(now), endedAcademics: store.endedAcademics(now), cancelledAcademicIds: store.cancelledAcademicIds(), routines: store.routines(today), activity: store.activity(today), currentActivity: store.integration('current_activity'), healthToday: store.health(today), healthWeek: store.healthRange(daysAgoKey(now, 6), today), healthRecent: store.healthRange(daysAgoKey(now, 90), today), eveningReview: buildEveningReviewFromStore(store, now), eclass: store.integration('eclass'), briefing: store.integration('briefing'), reminderControl: store.integration('reminder_control'), missedNotifications: store.missedNotifications(), provider, providerStatus, busy, usage }; };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    let streaming = false;
    const emit = value => {
      if (streaming && !res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(value)}\n`);
    };
    const send = (code, value) => {
      if (streaming) { emit({ type: code < 400 ? 'done' : 'error', ...value }); res.end(); }
      else { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
    };
    try {
      const address = `127.0.0.1:${server.address().port}`;
      const path = new URL(req.url, `http://${address}`).pathname;
      const extensionPath = ['/api/eclass/token', '/api/eclass/sync'].includes(path);
      const extensionIdentity = req.headers.origin === ECLASS_EXTENSION_ORIGIN
        || (!req.headers.origin && req.headers['x-rin-extension'] === ECLASS_EXTENSION_ID)
        || (!req.headers.origin && req.headers['sec-fetch-site'] === 'none');
      const extensionRequest = extensionPath && extensionIdentity;
      if (req.headers.host !== address) throw new AppError('허용되지 않은 호스트입니다.', 403);
      if (req.headers.origin && req.headers.origin !== `http://${address}` && !extensionRequest) throw new AppError('외부 페이지의 요청은 허용되지 않습니다.', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site' && !extensionRequest) throw new AppError('외부 페이지의 요청은 허용되지 않습니다.', 403);
      if (extensionRequest) {
        res.setHeader('Access-Control-Allow-Origin', ECLASS_EXTENSION_ORIGIN);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Rin-Token, X-Rin-Extension');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      }
      if (path === '/api/health' && req.method === 'GET') { send(200, { app: 'rin-companion', host: process.env.RIN_DESKTOP_HOST === '1' ? 'desktop' : 'legacy' }); return; }
      if (req.method === 'GET' && assets[path]) {
        const [file, type] = assets[path];
        res.writeHead(200, { 'Content-Type': type.startsWith('text/') ? `${type}; charset=utf-8` : type });
        res.end(readFileSync(join(root, 'public', file))); return;
      }
      if (path === '/api/session' && req.method === 'GET') { send(200, { token, ...state() }); return; }
      if (path === '/api/eclass/token' && req.method === 'GET' && extensionRequest) { send(200, { token }); return; }
      if (!path.startsWith('/api/')) throw new AppError('찾을 수 없습니다.', 404);
      if (req.headers['x-rin-token'] !== token) throw new AppError('페이지를 새로고침해 주세요.', 403);
      if (req.method === 'GET' && path === '/api/state') { send(200, state()); return; }
      if (req.method !== 'POST' || !req.headers['content-type']?.startsWith('application/json')) throw new AppError('허용되지 않은 요청입니다.', 405);
      const body = await readBody(req, path === '/api/eclass/sync' ? 100000 : 20000);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError('요청 형식이 올바르지 않습니다.');
      if (busy) throw new AppError('아사가 답변을 작성 중이에요. 잠시 후 다시 시도해 주세요.', 409);
      if (path === '/api/reminder/action') {
        applyReminderAction(store, body);
        send(200, state()); return;
      }
      if (path === '/api/activity/toggle') {
        if (typeof body.enabled !== 'boolean') throw new AppError('PC 활동 측정 상태가 올바르지 않습니다.');
        store.saveSettings({ ...store.settings(), activityTracking: body.enabled });
        send(200, state()); return;
      }
      if (path === '/api/missed-notifications/clear') {
        store.clearMissedNotifications();
        send(200, state()); return;
      }
      if (path === '/api/settings') {
        const current = store.settings();
        const notificationVolume = body.notificationVolume ?? current.notificationVolume;
        const characterMotion = body.characterMotion === undefined ? current.characterMotion : body.characterMotion;
        if (typeof characterMotion !== 'boolean') throw new AppError('캐릭터 움직임 설정이 올바르지 않습니다.');
        if (!Number.isInteger(notificationVolume) || notificationVolume < 0 || notificationVolume > 100) throw new AppError('알림 음량은 0~100 사이로 설정해 주세요.');
        if (typeof body.name !== 'string' || body.name.length > 40) throw new AppError('호칭은 40자 이내로 입력해 주세요.');
        const model = text(body.model, 100);
        if (model !== CODEX_MODEL) throw new AppError('대화는 Codex만 사용합니다. 모델은 Codex 설정을 따릅니다.');
        if (typeof body.notifications !== 'boolean') throw new AppError('알림 설정이 올바르지 않습니다.');
        if (typeof body.quietModeEnabled !== 'boolean') throw new AppError('방해 금지 설정이 올바르지 않습니다.');
        if (typeof body.gameNagging !== 'boolean' || ![15, 30, 60].includes(body.gameNagMinutes)) throw new AppError('게임 중 잔소리 설정이 올바르지 않습니다.');
        if (typeof body.dailyBriefing !== 'boolean') throw new AppError('오늘 브리핑 설정이 올바르지 않습니다.');
        if (typeof body.casualNotifications !== 'boolean') throw new AppError('아사의 일상 알림 설정이 올바르지 않습니다.');
        if (typeof body.activityTracking !== 'boolean' || ![30, 45, 50, 60, 90].includes(body.breakMinutes)) throw new AppError('PC 활동 측정 설정이 올바르지 않습니다.');
        if (typeof body.healthCheckReminder !== 'boolean' || ![120, 180, 240].includes(body.healthCheckUsageMinutes)) throw new AppError('생활 기록 알림 설정이 올바르지 않습니다.');
        if (typeof body.eveningReview !== 'boolean' || ![240, 360, 480].includes(body.eveningReviewUsageMinutes)) throw new AppError('하루 결산 설정이 올바르지 않습니다.');
        store.saveSettings({
          ...current, name: body.name.trim(), model,
          teasing: strength(body.teasing), characterMotion,
          notifications: body.notifications,
          notificationVolume,
          quietModeEnabled: body.quietModeEnabled,
          quietStart: clock(body.quietStart), quietEnd: clock(body.quietEnd),
          gameNagging: body.gameNagging, gameNagMinutes: body.gameNagMinutes,
          dailyBriefing: body.dailyBriefing,
          casualNotifications: body.casualNotifications,
          activityTracking: body.activityTracking, breakMinutes: body.breakMinutes,
          healthCheckReminder: body.healthCheckReminder, healthCheckUsageMinutes: body.healthCheckUsageMinutes,
          eveningReview: body.eveningReview, eveningReviewUsageMinutes: body.eveningReviewUsageMinutes
        });
      } else if (path === '/api/memory') {
        const content = text(body.content, 500);
        if (body.id && !store.memories().some(m => m.id === body.id)) throw new AppError('기억을 찾을 수 없습니다.', 404);
        if (!body.id && store.memories().length >= 30) throw new AppError('기억은 최대 30개까지 저장할 수 있어요. 필요 없는 기억을 정리해 주세요.');
        store.memory(content, body.id);
      } else if (path === '/api/memory/delete') {
        store.removeMemory(text(body.id, 100));
      } else if (path === '/api/class') {
        const name = text(body.name, 60);
        const day = Number(body.day);
        const start = clock(body.start);
        const end = clock(body.end);
        if (!Number.isInteger(day) || day < 1 || day > 7) throw new AppError('요일을 선택해 주세요.');
        if (start >= end) throw new AppError('종료 시간은 시작 시간보다 늦어야 합니다.');
        if (body.id && !store.classes().some(item => item.id === body.id)) throw new AppError('수업을 찾을 수 없습니다.', 404);
        if (!body.id && store.classes().length >= 60) throw new AppError('수업은 최대 60개까지 저장할 수 있어요.');
        store.saveClass({ name, day, start, end, location: optionalText(body.location, 80) }, body.id);
      } else if (path === '/api/class/delete') {
        store.removeClass(text(body.id, 100));
      } else if (path === '/api/academic') {
        const kind = body.kind;
        if (!['assignment', 'exam', 'event'].includes(kind)) throw new AppError('일정 종류를 선택해 주세요.');
        const previous = body.id ? store.academics(new Date(), true).find(item => item.id === body.id) : null;
        if (body.id && !previous) throw new AppError('일정을 찾을 수 없습니다.', 404);
        if (!body.id && store.academics().length >= 200) throw new AppError('학업 일정은 최대 200개까지 저장할 수 있어요.');
        if (body.repeatWeekly !== undefined && typeof body.repeatWeekly !== 'boolean') throw new AppError('반복 여부가 올바르지 않습니다.');
        if (body.recurrence !== undefined && !recurrenceTypes.includes(body.recurrence)) throw new AppError('반복 주기가 올바르지 않습니다.');
        if (body.monthlyDay !== undefined && (!Number.isInteger(body.monthlyDay) || body.monthlyDay < 0 || body.monthlyDay > 31 || body.recurrence === 'monthly' && body.monthlyDay === 0)) throw new AppError('매달 날짜는 1~31일로 지정해 주세요.');
        if ((body.repeatWeekly || body.recurrence && body.recurrence !== 'none') && store.academics().find(item => item.id === body.id)?.completed) throw new AppError('완료한 일정을 먼저 미완료로 바꾼 뒤 반복을 설정해 주세요.');
        if (body.repeatUntil !== undefined && body.repeatUntil !== null && (!validDateKey(body.repeatUntil) || body.repeatUntil < localDateKey(new Date()) && body.repeatUntil !== previous?.repeat_until)) throw new AppError('종료일은 오늘 이후의 실제 날짜로 지정해 주세요.');
        const recurrence = body.recurrence ?? (body.repeatWeekly !== undefined ? body.repeatWeekly ? 'weekly' : 'none' : recurrenceType(previous));
        const due = localDateTime(body.due);
        const until = body.repeatUntil !== undefined ? body.repeatUntil : previous?.repeat_until ?? null;
        if (until && recurrence === 'none') throw new AppError('종료일은 반복 일정에만 지정할 수 있습니다.');
        const anchor = previous && repeats(previous) && sameRecurrenceRule(previous, { due, recurrence, monthly_day: body.monthlyDay || previous.monthly_day }) ? previous.series_due || previous.due : due;
        if (until && until < anchor.slice(0, 10)) throw new AppError('종료일이 첫 회차보다 빠릅니다.');
        if (previous?.ended && store.academics().length >= 200) throw new AppError('학업 일정은 최대 200개까지 저장할 수 있어요.');
        store.saveAcademic({ title: text(body.title, 100), course: optionalText(body.course, 60), kind, due, notes: optionalText(body.notes, 500), completed: false, repeat_weekly: body.repeatWeekly, recurrence, monthly_day: body.monthlyDay, repeat_until: body.repeatUntil }, body.id);
      } else if (path === '/api/academic/toggle') {
        const id = text(body.id, 100);
        if (!store.academics().some(item => item.id === id)) throw new AppError('일정을 찾을 수 없습니다.', 404);
        if (typeof body.completed !== 'boolean') throw new AppError('완료 상태가 올바르지 않습니다.');
        if (repeats(store.academics().find(item => item.id === id))) throw new AppError('반복 일정은 다음 회차로 자동 이어집니다. 종료하려면 대화에서 반복 전체 취소를 요청해 주세요.');
        store.toggleAcademic(id, body.completed);
      } else if (path === '/api/academic/restore') {
        const id = text(body.id, 100);
        if (body.originalDue !== undefined) {
          const original = localDateTime(body.originalDue);
          const item = store.academics(new Date(), true).find(value => value.id === id);
          const exception = item?.exceptions?.find(value => value.original_due === original && value.cancelled);
          if (!exception) throw new AppError('취소된 회차를 찾을 수 없습니다.', 404);
          if (!withinRepeatEnd(item, original) || !withinRepeatEnd(item, exception.due)) throw new AppError('그 회차는 반복 종료일 밖입니다. 먼저 종료일을 연장해 주세요.');
          if (new Date(exception.due) <= new Date()) throw new AppError('이미 지난 회차는 복구할 수 없습니다.');
          if (item.ended && store.academics().length >= 200) throw new AppError('학업 일정은 최대 200개까지 저장할 수 있어요.');
          store.saveAcademicOccurrence(id, original, exception.due);
        } else {
          if (!store.cancelledAcademicIds().includes(id)) throw new AppError('취소된 일정을 찾을 수 없습니다.', 404);
          const cancelled = store.cancelledAcademics().find(item => item.id === id);
          if (repeats(cancelled) && projectRecurringItem(cancelled, store.academicExceptions(id)).ended) throw new AppError('종료일 안에 남은 회차가 없습니다. 대화로 새 종료일과 함께 복구해 주세요.');
          if (store.academics().length >= 200) throw new AppError('학업 일정은 최대 200개까지 저장할 수 있어요.');
          store.restoreAcademic(id);
        }
      } else if (path === '/api/academic/delete') {
        store.removeAcademic(text(body.id, 100));
      } else if (path === '/api/eclass/missing-action') {
        const id = text(body.id, 100);
        if (!['complete', 'keep'].includes(body.action)) throw new AppError('확인할 동작이 올바르지 않습니다.');
        if (!store.resolveMissingAcademic(id, body.action)) throw new AppError('완료 확인이 필요한 e-Class 일정을 찾을 수 없습니다.', 404);
      } else if (path === '/api/routine') {
        const category = body.category;
        if (!['sleep', 'exercise', 'meal', 'study', 'other'].includes(category)) throw new AppError('루틴 종류를 선택해 주세요.');
        if (!Array.isArray(body.days) || !body.days.length) throw new AppError('실천할 요일을 하나 이상 선택해 주세요.');
        if (!body.days.every(Number.isInteger)) throw new AppError('루틴 요일이 올바르지 않습니다.');
        const days = [...new Set(body.days)].sort((a, b) => a - b);
        if (days.length !== body.days.length || days.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw new AppError('루틴 요일이 올바르지 않습니다.');
        if (body.id && !store.routines(localDateKey(new Date())).some(item => item.id === body.id)) throw new AppError('루틴을 찾을 수 없습니다.', 404);
        if (!body.id && store.routines(localDateKey(new Date())).length >= 50) throw new AppError('루틴은 최대 50개까지 저장할 수 있어요.');
        store.saveRoutine({ title: text(body.title, 60), category, days, time: clock(body.time), notes: optionalText(body.notes, 300) }, body.id);
      } else if (path === '/api/routine/toggle') {
        const id = text(body.id, 100);
        if (!store.routines(localDateKey(new Date())).some(item => item.id === id)) throw new AppError('루틴을 찾을 수 없습니다.', 404);
        if (typeof body.completed !== 'boolean') throw new AppError('완료 상태가 올바르지 않습니다.');
        store.toggleRoutine(id, localDateKey(new Date()), body.completed);
      } else if (path === '/api/routine/delete') {
        const id = text(body.id, 100);
        if (!store.routines(localDateKey(new Date())).some(item => item.id === id)) throw new AppError('루틴을 찾을 수 없습니다.', 404);
        store.removeRoutine(id);
      } else if (path === '/api/health') {
        const date = localDate(body.date);
        const today = localDateKey(new Date());
        if (date > today || date < daysAgoKey(new Date(), 90)) throw new AppError('최근 90일 안의 날짜만 기록할 수 있어요.');
        store.saveHealth({
          date,
          sleepMinutes: integer(body.sleepMinutes, 0, 1440, '수면 시간'),
          meals: integer(body.meals, 0, 6, '식사 횟수'),
          water: integer(body.water, 0, 30, '물 섭취'),
          exerciseMinutes: integer(body.exerciseMinutes, 0, 600, '운동 시간'),
          energy: integer(body.energy, 1, 5, '컨디션'),
          note: optionalText(body.note, 300)
        });
      } else if (path === '/api/eclass/sync') {
        if (!Array.isArray(body.items) || body.items.length > 100) throw new AppError('e-Class 일정은 한 번에 최대 100개까지 가져올 수 있어요.');
        const seen = new Set();
        const items = body.items.map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new AppError('e-Class 일정 형식이 올바르지 않습니다.');
          const externalId = text(item.externalId, 200);
          if (seen.has(externalId)) throw new AppError('e-Class 일정 ID가 중복되었습니다.');
          seen.add(externalId);
          if (!['assignment', 'exam', 'event'].includes(item.kind)) throw new AppError('e-Class 일정 종류가 올바르지 않습니다.');
          return {
            externalId,
            title: text(item.title, 100),
            course: optionalText(item.course, 60),
            kind: item.kind,
            due: localDateTime(item.due),
            notes: optionalText(item.notes, 500),
            sourceUrl: 'https://eclass.tukorea.ac.kr/ilos/main/main_form.acl'
          };
        });
        const known = store.eclassSourceIds();
        const newCount = items.filter(item => !known.has(item.externalId)).length;
        if (store.academics().length + newCount > 200) throw new AppError('학업 일정은 최대 200개까지 저장할 수 있어요.');
        store.syncEclass(items, body.snapshotComplete !== false);
      } else if (path === '/api/feedback') {
        if (!['', 'good', 'awkward'].includes(body.value)) throw new AppError('평가 값이 올바르지 않습니다.');
        const reason = body.value === 'awkward' ? optionalText(body.reason, 30) : '';
        if (!['', 'tone', 'repetition', 'character', 'length', 'fact'].includes(reason)) throw new AppError('어색한 이유가 올바르지 않습니다.');
        store.feedback(text(body.id, 100), body.value, reason);
      } else if (path === '/api/messages/clear') {
        store.clearMessages(); store.saveIntegration('schedule_draft', null); usage = null;
      } else if (path === '/api/chat') {
        const message = text(body.text, 4000);
        const chatStarted = Date.now();
        busy = true;
        provider = null;
        providerStatus = { ...providerStatus, provider: null, model: null, stage: null, status: 'pending', lastSuccess: null, fallbackReason: '', retryReason: '', error: '', turnError: '', firstTokenMs: null, elapsedMs: 0, turnElapsedMs: 0, stages: {} };
        streaming = req.headers.accept?.includes('application/x-ndjson') || false;
        if (streaming) {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8' });
          res.flushHeaders();
          emitStatus = emit;
        }
        let extraction;
        try {
          const memories = store.memories();
          recordProvider('memory', { provider: null, model: null, status: 'pending' });
          extraction = extractMemories({ text: message, memories, codexClient, onResult: result => recordProvider('memory', result) });
          let extracted;
          // Explicit saves need a verified receipt; automatic learning runs alongside the reply.
          if (/(?:기억|저장|기록).{0,12}(?:해\s*줘|해\s*둬|해\s*놓|부탁|수정|바꿔)/u.test(message)) extracted = await extraction;
          const respond = async ({ actionResult = null, commit = null, nextDraft = null } = {}) => {
            const memoryActionResult = extracted
              ? { status: extracted.operations.length ? 'success' : extracted.status, capacityReached: extracted.status === 'full', saved: extracted.operations.map(item => item.content) }
              : { status: 'pending', saved: [] };
            // Mutating replies are buffered until the write and receipt both succeed.
            const plannedResult = actionResult?.status === 'success' && commit ? { ...actionResult, status: 'ready' } : actionResult;
            let firstTokenMs = null;
            const result = await generate({
              request: buildRequest(persona, store.settings(), projectMemories(memories, extracted?.operations || []), store.context(), message, { schedule: scheduleForAI(store), actionResult: plannedResult, memoryActionResult }), codexClient,
              onDelta: streaming && !commit ? chunk => { firstTokenMs ??= Date.now() - chatStarted; emit({ type: 'delta', text: chunk }); } : undefined,
              onReset: streaming ? () => { firstTokenMs = null; emit({ type: 'reset' }); } : undefined,
              onResult: result => recordProvider('chat', { ...result, ...(streaming ? { firstTokenMs } : {}), elapsedMs: Date.now() - chatStarted }),
            });
            extracted = await extraction;
            store.db.exec('BEGIN');
            try {
              commit?.();
              store.saveIntegration('schedule_draft', nextDraft);
              store.addPair(message, result.answer, actionResult?.status === 'success' ? actionResult : null, extracted.operations);
              store.db.exec('COMMIT');
            } catch (error) { store.db.exec('ROLLBACK'); throw error; }
            if (streaming && commit) emit({ type: 'delta', text: result.answer });
            usage = result.usage; provider = result.provider;
          };
          const savedDraft = store.integration('schedule_draft');
          const freshDraft = savedDraft && Date.now() - savedDraft.created < 10 * 60_000 ? savedDraft : null;
          const repeatError = recurrenceProblem(message, recurrenceFromText(message) || (!freshDraft?.action ? freshDraft?.recurrence : null));
          const change = (repeatError ? { action: 'none', draft: null, message: repeatError } : prepareScheduleChange({ message, items: store.academics(new Date(), true), cancelledItems: store.cancelledAcademics(), recent: store.messages().slice(-16), draft: freshDraft }))
            || (recurrenceWords.test(message) && !recurrenceFromText(message) ? { action: 'none', draft: null, message: '매일·매주·격주·매달 중 반복 주기와 시간을 말해 줘.' } : null);
          if (change) {
            recordRules();
            extracted = await extraction;
            let receipt = null, commit = null;
            if (change.itemId) {
              const occurrence = change.scope === 'occurrence';
              const item = (change.action === 'restore' && !occurrence ? [...store.cancelledAcademics(), ...store.endedAcademics()] : store.academics(new Date(), true)).find(value => value.id === change.itemId);
              if (!item || item.completed) throw new AppError('변경할 일정을 찾을 수 없습니다.', 404);
              if (change.action === 'restore' && !occurrence && store.academics().length >= 200) throw new AppError('학업 일정은 최대 200개까지 저장할 수 있어요.');
              if (occurrence) {
                const originalDue = localDateTime(change.original_due), due = localDateTime(change.due);
                commit = () => store.saveAcademicOccurrence(item.id, originalDue, due, change.action === 'cancel');
              } else if (change.action === 'cancel') {
                commit = () => store.cancelAcademic(item.id);
              } else {
                const value = { ...item, series_due: undefined, title: text(change.title, 100), due: localDateTime(change.due), recurrence: change.recurrence ?? recurrenceType(item), monthly_day: change.monthly_day ?? item.monthly_day, repeat_until: change.repeat_until !== undefined ? change.repeat_until : item.repeat_until, repeat_weekly: change.repeat_weekly ?? item.repeat_weekly };
                commit = () => {
                  if (change.action !== 'restore' || value.due !== item.due || value.title !== item.title || !sameRecurrenceRule(value, item) || value.repeat_until !== item.repeat_until) store.saveAcademic(value, item.id);
                  if (change.action === 'restore') store.restoreAcademic(item.id);
                  if (store.academics().length > 200) throw new AppError('학업 일정은 최대 200개까지 저장할 수 있어요.');
                };
              }
              receipt = { status: 'success', action: change.action, itemId: item.id, title: change.title || item.title, due: change.due || item.due, repeat_weekly: change.repeat_weekly ?? item.repeat_weekly, recurrence: change.recurrence ?? recurrenceType(item), monthly_day: change.monthly_day ?? item.monthly_day, repeat_until: change.repeat_until !== undefined ? change.repeat_until : item.repeat_until, previousUntil: item.repeat_until, previousTitle: item.title, previousDue: change.previousDue || item.series_due || item.due, series_due: occurrence ? item.series_due : change.due || item.series_due || item.due, ...(occurrence ? { scope: 'occurrence', original_due: change.original_due } : {}) };
            }
            await respond({ actionResult: receipt || { status: 'unchanged', detail: change.message }, commit, nextDraft: change.draft });
            busy = false;
            providerStatus = { ...providerStatus, turnElapsedMs: Date.now() - chatStarted };
            send(200, state()); return;
          }
          const draft = freshDraft && !freshDraft.action ? freshDraft : null;
          const interpret = shouldInterpretAcademicCommand(message, draft) || Boolean(draft?.awaitEnd && recurrenceEnd(message, new Date(), true).provided);
          if (interpret) {
            const detailOnly = draft && (isScheduleDetail(message) || draft.awaitEnd && recurrenceEnd(message, new Date(), true).provided);
            if (detailOnly) recordRules();
            const intent = detailOnly ? { ...draft, action: 'add' } : await interpretAcademicCommand({ text: message, academics: store.academics(), history: store.context(), draft, codexClient, onResult: result => recordProvider('schedule', result) });
            let nextDraft = null;
            if (intent?.action === 'add') {
              const title = text(cleanScheduleTitle(text(intent.title, 100)).replace(/^(?:에|까지)\s*/u, ''), 100);
              intent.title = title;
              const previous = draft && normalized(title) === normalized(draft.title) ? draft : null;
              intent.recurrence = recurrenceFromText(message) || recurrenceType(previous);
              intent.repeat_weekly = intent.recurrence === 'weekly';
              const end = repeats(intent) ? recurrenceEnd(message, new Date(), Boolean(previous?.awaitEnd)) : { provided: false, text: message };
              intent.repeat_until = end.provided ? end.value : previous?.repeat_until ?? null;
              intent.kind = /과제|보고서|레포트|제출/u.test(`${title} ${message}`) ? 'assignment' : /시험|고사/u.test(`${title} ${message}`) ? 'exam' : 'event';
              const meridiem = message.match(/^(오전|오후)(?:이?야)?[.!\s]*$/u)?.[1];
              const when = recurrenceWhen(meridiem && previous?.ambiguousClock ? `${meridiem} ${previous.ambiguousClock}` : end.text, intent.recurrence, new Date(), previous?.monthly_day);
              intent.monthly_day = when.monthly_day;
              const date = when.explicitDate ? when.date : previous?.date || when.date;
              const time = when.ambiguousTime ? null : when.time || previous?.time;
              const dueTime = time || (intent.kind === 'assignment' && !when.ambiguousTime ? '23:59' : null);
              let reason = when.invalid ? '유효하지 않은 날짜 또는 시간.' : !date || intent.recurrence === 'monthly' && !intent.monthly_day ? '일정 날짜 또는 반복 요일·날짜 미지정.' : !dueTime ? when.ambiguousTime ? '오전·오후가 불명확한 시간.' : '일정 시각 미지정.' : '';
              intent.due = date && dueTime ? `${date}T${dueTime}` : '';
              if (!reason && repeats(intent)) {
                // A new biweekly series starts on the nearest upcoming chosen weekday.
                if (intent.recurrence === 'biweekly') intent.due = nextRecurringDue(intent.due, 'weekly');
                intent.due = nextRecurringDue(intent.due, intent.recurrence, new Date(), intent.monthly_day);
              }
              if (!reason && new Date(intent.due) <= new Date()) reason = '이미 지난 일정 시각.';
              const awaitEnd = Boolean(end.invalid || previous?.awaitEnd && !end.provided || intent.due && !withinRepeatEnd(intent, intent.due));
              if (awaitEnd) reason = end.reason || '종료일 안에 남은 회차 없음.';
              if (reason) {
                nextDraft = { title, course: optionalText(intent.course, 60), kind: intent.kind, date: when.invalid ? null : date || null, time: when.invalid ? null : time || null, repeat_weekly: intent.repeat_weekly, recurrence: intent.recurrence, monthly_day: when.invalid ? 0 : intent.monthly_day, repeat_until: intent.repeat_until, awaitEnd, ambiguousClock: when.ambiguousClock || null, created: Date.now() };
                intent.action = 'none'; intent.reason = reason;
              }
            }
            if (intent?.action === 'complete' && !isCompletion(message)) { intent.action = 'none'; intent.reason = '완료한 일정이면 이름과 함께 완료했다고 말해 줘.'; }
            extracted = await extraction;
            const { commit, message: detail, ...actionResult } = prepareAcademicCommand(store, intent);
            await respond({ actionResult: { ...actionResult, ...(detail ? { detail } : {}) }, commit, nextDraft });
          } else {
            await respond();
          }
        } catch (error) {
          providerStatus = { ...providerStatus, turnError: error instanceof AppError ? error.message : '답변 처리 또는 저장에 실패했어요. 잠시 후 다시 시도해 주세요.' };
          throw error;
        } finally {
          // Keep the single-writer guard until both jobs settle, including failed chat generation.
          await extraction;
          busy = false;
          providerStatus = { ...providerStatus, turnElapsedMs: Date.now() - chatStarted };
          emitStatus = null;
        }
      } else { throw new AppError('찾을 수 없습니다.', 404); }
      send(200, state());
    } catch (error) {
      send(error instanceof AppError ? error.status : 500, { error: error instanceof AppError ? error.message : '처리하지 못했어요. 잠시 후 다시 시도해 주세요.' });
    }
  });
  server.on('close', () => { codexClient.close(); store.close(); });
  return { server, store, token, refreshProviderStatus };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, store, token, refreshProviderStatus } = createApp();
  const notify = async candidate => {
    const result = await (candidate.display === 'popup' ? showUrgentPopup(candidate, { token }) : showWindowsNotification(candidate));
    if (result?.suppressed) store.recordMissedNotification(candidate);
    return result;
  };
  const reminders = new ReminderService(store, { notify });
  const activities = new ActivityService(store);
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '이미 실행 중이거나 포트가 사용 중입니다. http://127.0.0.1:4317 을 확인하세요.' : error.message); process.exitCode = 1; });
  server.on('close', () => { reminders.stop(); activities.stop(); });
  server.listen(Number(process.env.PORT || 4317), '127.0.0.1', () => {
    reminders.start();
    activities.start();
    void refreshProviderStatus();
    const providerTimer = setInterval(refreshProviderStatus, 5 * 60_000); providerTimer.unref();
    server.once('close', () => clearInterval(providerTimer));
    console.log(`Rin is ready: http://127.0.0.1:${server.address().port}`);
  });
}
