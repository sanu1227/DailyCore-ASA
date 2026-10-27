const events = /과제|시험|중간|기말|보고서|발표|일정|제출|회의|팀플|약속|미팅|면접|예약|병원|치과|진료|수업|모임|약속|만나|만날|여행|공연|전시|생일/u;
const mutation = /추가|등록|일정에?\s*(넣|적)|기록해|끝냈|끝났|완료(했|해|로|처리)|제출(했|완료)|다\s*했/u;
export const isCompletion = text => /끝냈|끝났|완료(했|해|로|처리)|제출(했|완료)|다\s*했/u.test(text);
export const restoreSchedulePattern = /다시\s*(?:(?:안|못)\s*)?잡|복구|복원|취소(?:를)?\s*(?:되돌|철회)/u;
export const declinesSchedule = text => /취소|등록.{0,6}(마|않)|추가.{0,6}(마|않)|저장.{0,6}(마|않)|안\s*(해|하|갈|가|만나|잡|넣|적)|없어|없다|없을|아니야|하지\s*마|됐어|그만/u.test(text);
const uncertain = text => /만약|가정|예를\s*들|할까|갈까|만날까|있으면|있다면|일지도|미정|아직.{0,5}(몰라|모르)|일지\s*몰라|하고\s*싶|가고\s*싶|좋겠다/u.test(text);
const dateWords = /오늘|내일|모레|글피|\d{1,2}\s*일\s*(뒤|후)|[월화수목금토일]요일|\d{1,2}월\s*\d{1,2}일|\d{4}-\d{2}-\d{2}/u;
const timeWords = /(?:\d{1,2}|열두|열한|열|아홉|여덟|일곱|여섯|다섯|네|세|두|한)\s*시(?!간)|\d{1,2}:\d{2}|정오|자정/u;
export const recurrenceWords = /매\s*(?:주|일|월|달|년)|격주|반복|주\s*마다|날마다/u;
export const weeklyWords = /매\s*주|(?:일주|1주)\s*마다/u;
export const recurrenceTypes = ['none', 'daily', 'weekly', 'biweekly', 'monthly'];
export const recurrenceType = item => item?.recurrence ?? (item?.repeat_weekly ? 'weekly' : 'none');
export const repeats = item => recurrenceType(item) !== 'none';
export const recurrenceToken = /매\s*(?:일|주|월|달)|격주|날마다|(?:일주|1\s*주|2\s*주|두\s*주)\s*마다/gu;
export function recurrenceFromText(text) {
  if (/매\s*일|날마다/u.test(text)) return 'daily';
  if (/격주|(?:2|두)\s*주\s*마다/u.test(text)) return 'biweekly';
  if (/매\s*(?:월|달)/u.test(text)) return 'monthly';
  if (weeklyWords.test(text)) return 'weekly';
  return null;
}
const endDateToken = String.raw`(?:(?:20\d{2}년|올해|내년)\s*)?\d{1,2}월(?:\s*(?:말(?:일)?|\d{1,2}일?))?|20\d{2}-\d{2}-\d{2}|(?:이번|다음|다다음)\s*달(?:\s*(?:말(?:일)?|\d{1,2}일))?|(?:올해|내년|20\d{2}년)(?:\s*말)?|(?:(?:이번|다음|다다음)\s*주\s*)?[월화수목금토일]요일|(?:이번|다음|다다음)\s*주(?:\s*말)?|오늘|내일|모레`;
export function validDateKey(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00`);
  return Number.isFinite(date.getTime()) && dateKey(date) === value;
}

// Parse the end separately so it can never become the meeting's first date.
export function recurrenceEnd(text, now = new Date(), allowBare = false) {
  const clear = /(?:종료일|종료\s*날짜|끝나는\s*날)(?:은|는|을|를|만)?\s*(?:없애\s*(?:줘|줄래)?|지워\s*(?:줘|줄래)?|(?:삭제|취소|해제)(?:해\s*(?:줘|줄래))?)|(?:종료일|기한)\s*없이|계속\s*반복해\s*줘/gu;
  const limits = [...text.matchAll(new RegExp(`(${endDateToken})\\s*까지(?:만)?`, 'gu'))];
  const explicit = text.match(new RegExp(`(?:종료일|종료\\s*날짜|끝나는\\s*날)(?:은|는|을|를)?\\s*(${endDateToken})(?:로|이야|야)?`, 'u'));
  const bare = allowBare ? text.match(new RegExp(`^\\s*(${endDateToken})(?:로|이야|야)?[.!\\s]*$`, 'u')) : null;
  const clears = [...text.matchAll(clear)];
  const match = limits[0] || explicit || bare;
  const provided = Boolean(match || clears.length);
  let rest = text;
  for (const part of [...limits, ...(explicit ? [explicit] : []), ...(bare ? [bare] : []), ...clears]) rest = rest.replace(part[0], ' ');
  rest = rest.replace(/(?:종료일|종료\s*날짜|끝나는\s*날)(?:은|는|을|를)?/gu, ' ').trim();
  if (!provided) return { provided: false, text, value: null, invalid: false };
  if (limits.length > 1 || clears.length && match) return { provided: true, text: rest, value: null, invalid: true, reason: '종료일은 하나만 말해 줘. 종료일 설정과 해제도 따로 부탁해.' };
  if (clears.length) return { provided: true, text: rest, value: null, invalid: false };
  const phrase = match[1].replace(/\s/g, '');
  let value;
  const month = phrase.match(/^(?:(20\d{2})년|(올해|내년))?(\d{1,2})월(?:(말(?:일)?)|(\d{1,2})일?)?$/u);
  const relativeMonth = phrase.match(/^(이번|다음|다다음)달(?:(말(?:일)?)|(\d{1,2})일)?$/u);
  const year = phrase.match(/^(올해|내년|20\d{2}년)(?:말)?$/u);
  const week = phrase.match(/^(이번|다음|다다음)주(?:말)?$/u);
  if (month || relativeMonth) {
    let y, m, day;
    if (month) {
      y = month[1] ? Number(month[1]) : now.getFullYear() + (month[2] === '내년' ? 1 : 0);
      m = Number(month[3]); day = month[5] ? Number(month[5]) : new Date(y, m, 0).getDate();
      if (!month[1] && !month[2] && m >= 1 && m <= 12 && dateKey(new Date(y, m - 1, day)) < dateKey(now)) { y++; if (!month[5]) day = new Date(y, m, 0).getDate(); }
    } else {
      const date = new Date(now.getFullYear(), now.getMonth() + { 이번: 0, 다음: 1, 다다음: 2 }[relativeMonth[1]], 1);
      y = date.getFullYear(); m = date.getMonth() + 1; day = relativeMonth[3] ? Number(relativeMonth[3]) : new Date(y, m, 0).getDate();
    }
    value = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  } else if (year) value = `${year[1].startsWith('20') ? year[1].slice(0, 4) : now.getFullYear() + (year[1] === '내년' ? 1 : 0)}-12-31`;
  else if (week) {
    const date = new Date(now); date.setDate(date.getDate() + 7 - (date.getDay() || 7) + { 이번: 0, 다음: 7, 다다음: 14 }[week[1]]); value = dateKey(date);
  } else value = scheduleWhen(phrase, now).date;
  const invalid = !validDateKey(value) || value < dateKey(now);
  return { provided: true, text: rest, value: invalid ? null : value, invalid, reason: invalid ? '종료일은 오늘 이후의 실제 날짜로 말해 줘. 예: 2026년 12월 31일까지.' : '' };
}

export const withinRepeatEnd = (item, due) => !item.repeat_until || due.slice(0, 10) <= item.repeat_until;
export const repeatEndLabel = item => item.repeat_until ? `${item.repeat_until} 당일까지` : '종료일 없이';
export function recurrenceProblem(text, kind = recurrenceFromText(text)) {
  if (kind) {
    const end = recurrenceEnd(text);
    if (end.provided) text = end.text;
  }
  if (/매\s*년|(?:[3-9]|\d{2,}|세|네)\s*주\s*마다|\d+\s*(?:개월|달|일)\s*마다/u.test(text)) return '지금은 매일·매주·격주·매달 반복을 지원해. 다른 반복 주기는 아직 등록하지 않았어.';
  if (kind && (/부터|까지|평일|주말|말일|첫째|둘째|셋째|넷째|마지막|(?:\d+|한|두|세|네)\s*(?:번|회)|[월화수목금토일]\s*[,·/와과]\s*[월화수목금토일]|[월화수목금토일]{2,7}요일|(?:[월화수목금토일]\s+)+[월화수목금토일]요일/u.test(text)
      || [...text.matchAll(recurrenceToken)].length > 1 || [...text.matchAll(/[월화수목금토일]요일/gu)].length > 1
      || [...text.matchAll(new RegExp(timeWords.source, 'gu'))].length > 1
      || (kind === 'monthly' && (/[월화수목금토일]요일/u.test(text) || /\d+\s*[,·/와과]\s*\d+\s*일/u.test(text) || [...text.matchAll(/\d+\s*일/gu)].length > 1))
      || (kind === 'daily' && /[월화수목금토일]요일/u.test(text)))) return '한 시간에 반복할 수 있어. 매일은 시간, 매주·격주는 요일, 매달은 날짜 하나(1~31일)를 말해 줘. 종료일은 “12월 말까지”처럼 지정하면 돼.';
  return '';
}
export function nextRecurringDue(due, kind, now = new Date(), monthlyDay = 0) {
  const value = new Date(due);
  if (!Number.isFinite(value.getTime()) || !Number.isFinite(now.getTime()) || !recurrenceTypes.includes(kind)) throw new Error('Invalid recurring date');
  if (kind === 'monthly') {
    const day = monthlyDay || value.getDate();
    if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error('Invalid monthly day');
    let offset = Math.max(0, (now.getFullYear() - value.getFullYear()) * 12 + now.getMonth() - value.getMonth());
    while (true) {
      const target = new Date(value.getFullYear(), value.getMonth() + offset, 1);
      target.setDate(Math.min(day, new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()));
      const candidate = `${dateKey(target)}T${due.slice(11, 16)}`;
      if (candidate >= due && new Date(candidate) >= now) return candidate;
      offset++;
    }
  }
  if (kind === 'none') return due;
  // Calendar arithmetic preserves local wall-clock time across DST and year boundaries.
  const step = { daily: 1, weekly: 7, biweekly: 14 }[kind];
  while (value < now) value.setDate(value.getDate() + step);
  return `${dateKey(value)}T${due.slice(11, 16)}`;
}
export const nextWeeklyDue = (due, now = new Date()) => nextRecurringDue(due, 'weekly', now);

export function recurrenceWhen(text, kind, now = new Date(), savedDay = 0) {
  const when = scheduleWhen(text, now);
  const dayText = kind === 'monthly' ? text.match(/(?<!\d)(\d{1,2})\s*일(?!\s*(?:뒤|후|마다))/u) : null;
  const explicitDate = Boolean(when.date || dayText);
  const monthly_day = kind === 'monthly' ? (dayText ? Number(dayText[1]) : savedDay) : 0;
  if (kind === 'monthly' && dayText && (monthly_day < 1 || monthly_day > 31)) when.invalid = true;
  if (!when.date && !when.invalid && (kind === 'daily' || kind === 'monthly' && monthly_day)) {
    const date = new Date(now);
    if (kind === 'monthly') date.setDate(Math.min(monthly_day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
    when.date = dateKey(date);
  }
  return { ...when, monthly_day, explicitDate };
}

export function occurrenceInWeek(item, week) {
  const kind = recurrenceType(item), anchor = item.series_due || item.due;
  const start = new Date(`${dateKey(week)}T00:00`); start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const due = nextRecurringDue(anchor, kind, start, item.monthly_day);
  return new Date(due) >= start && new Date(due) < end ? due : null;
}

// Identify an occurrence by its original local time, even after it is moved.
export function weeklyOccurrenceInWeek(due, week = new Date()) {
  const date = new Date(week);
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7) + ((new Date(due).getDay() + 6) % 7));
  const original = `${dateKey(date)}T${due.slice(11, 16)}`;
  return original >= due ? original : null;
}

export function projectRecurringItem(item, exceptions, now = new Date()) {
  const kind = recurrenceType(item);
  const nextDue = date => nextRecurringDue(item.due, kind, date, item.monthly_day);
  let original = nextDue(now);
  const changed = new Set(exceptions.map(value => value.original_due));
  while (withinRepeatEnd(item, original) && changed.has(original)) original = nextDue(new Date(new Date(original).getTime() + 1));
  // A moved occurrence can cross weeks or remain upcoming after its original time.
  const next = [{ original_due: original, due: original }, ...exceptions.filter(value => !value.cancelled && new Date(value.due) >= now)]
    .filter(value => withinRepeatEnd(item, value.original_due) && withinRepeatEnd(item, value.due))
    .sort((a, b) => a.due.localeCompare(b.due) || a.original_due.localeCompare(b.original_due))[0];
  return { ...item, ...(next ? {} : { ended: true }), series_due: item.due, next_regular_due: nextDue(now), due: next?.due || item.due, occurrence_due: next?.original_due || null, exceptions };
}
export const projectWeeklyItem = projectRecurringItem;
export const weeklyLabel = due => `매주 ${new Intl.DateTimeFormat('ko-KR', { weekday: 'long' }).format(new Date(due))} ${new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' }).format(new Date(due))}`;
export function recurrenceLabel(item) {
  const due = item.series_due || item.due, kind = recurrenceType(item);
  const time = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' }).format(new Date(due));
  if (kind === 'daily') return `매일 ${time}`;
  if (kind === 'monthly') return `매달 ${item.monthly_day || new Date(due).getDate()}일 ${time}`;
  return `${kind === 'biweekly' ? '격주' : '매주'} ${new Intl.DateTimeFormat('ko-KR', { weekday: 'long' }).format(new Date(due))} ${time}`;
}
export function sameRecurrenceRule(a, b) {
  const kind = recurrenceType(a), left = a.series_due || a.due, right = b.series_due || b.due;
  if (kind !== recurrenceType(b) || left.slice(11) !== right.slice(11)) return false;
  if (kind === 'daily') return true;
  if (kind === 'monthly') return (a.monthly_day || new Date(left).getDate()) === (b.monthly_day || new Date(right).getDate());
  if (kind === 'weekly') return new Date(left).getDay() === new Date(right).getDay();
  if (kind === 'biweekly') return ((Date.parse(`${right.slice(0, 10)}T00:00Z`) - Date.parse(`${left.slice(0, 10)}T00:00Z`)) / 86400000) % 14 === 0;
  return left === right;
}
export function cleanScheduleTitle(text) {
  return recurrenceEnd(text).text.trim()
    .replace(recurrenceToken, '')
    .replace(/(?:(?:다다음|다음|이번)\s*주\s*)?[월화수목금토일]요일|오늘|내일|모레|글피|\d{1,2}\s*일\s*(?:뒤|후)|(?:20\d{2}년\s*)?\d{1,2}월\s*\d{1,2}일?|20\d{2}-\d{2}-\d{2}/u, '')
    .replace(/(?<!\d)\d{1,2}\s*일(?!\s*(?:뒤|후|마다))/u, '')
    .replace(/^\s*(?:에|까지)\s*/u, '')
    .replace(/(?:(?:오전|오후|아침|저녁|밤|낮|새벽)\s*)?(?:\d{1,2}|열두|열한|열|아홉|여덟|일곱|여섯|다섯|네|세|두|한)\s*(?:시(?:\s*(?:반|\d{1,2}\s*분))?|:\d{2})|정오|자정|오전|오후/u, '').trim();
}
export function isScheduleDetail(text) {
  const remainder = cleanScheduleTitle(text);
  return remainder !== text.trim() && /^(?:에|까지|야|이야|이야\.|로\s*해\s*줘)?[.!\s]*$/u.test(remainder);
}
export function shouldInterpretAcademicCommand(text, draft = null) {
  if (restoreSchedulePattern.test(text)) return false;
  if (/취소|삭제|없어졌|바뀌|바꿔|바꿨|변경|수정|옮겨|옮겼|미뤄|미루|당겨|당겼/u.test(text)) return false;
  if (declinesSchedule(text) || uncertain(text)) return false;
  if (/(?:[가-힣]{2,4}|친구|동생|누나|엄마|아빠)(?:은|는|이|가).{0,30}(?:간대|한대|있대|간다고|한다더라)/u.test(text)) return false;
  const explicit = mutation.test(text) && events.test(text);
  if (explicit) return true;
  if (/[?？]|언제|몇\s*시|뭐\s*있|알려\s*줘|기억\s*나/u.test(text)) return false;
  if (draft && text.length <= 100 && (isScheduleDetail(text) || dateWords.test(text) || timeWords.test(text) || events.test(text))) return true;
  return (dateWords.test(text) || recurrenceWords.test(text)) && events.test(text) && !/어제|그제|지난|했었|다녀왔/u.test(text);
}
export const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// The model extracts the title; calendar dates and clock times come only from the user's words.
export function scheduleWhen(text, now = new Date()) {
  let date = null, time = null, invalid = false, ambiguousTime = false, ambiguousClock = null;
  const numeric = text.match(/(?:(20\d{2})년\s*)?(\d{1,2})월\s*(\d{1,2})일?/u);
  const iso = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/u);
  const relative = text.match(/글피|모레|내일|오늘|(?<days>\d{1,2})\s*일\s*(?:뒤|후)/u);
  const weekday = text.match(/(?:(다음\s*주|이번\s*주|다다음\s*주)\s*)?([월화수목금토일])요일/u);
  if (numeric || iso) {
    const match = numeric || iso;
    let year = Number(match[1]) || now.getFullYear();
    const month = Number(match[2]), day = Number(match[3]);
    let value = new Date(year, month - 1, day);
    if (!match[1] && dateKey(value) < dateKey(now)) value = new Date(++year, month - 1, day);
    invalid = value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day;
    if (!invalid) date = dateKey(value);
  } else if (relative) {
    const offset = relative.groups?.days ? Number(relative.groups.days) : { 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[relative[0]];
    const value = new Date(now); value.setDate(value.getDate() + offset); date = dateKey(value);
  } else if (weekday) {
    const target = '월화수목금토일'.indexOf(weekday[2]) + 1, today = now.getDay() || 7;
    const week = weekday[1]?.replace(/\s/g, '');
    const offset = week ? target - today + (week === '다다음주' ? 14 : week === '다음주' ? 7 : 0) : (target - today + 7) % 7;
    const value = new Date(now); value.setDate(value.getDate() + offset); date = dateKey(value);
  }
  const hours = { 한: 1, 두: 2, 세: 3, 네: 4, 다섯: 5, 여섯: 6, 일곱: 7, 여덟: 8, 아홉: 9, 열: 10, 열한: 11, 열두: 12 };
  const clock = text.match(/(?:(오전|오후|아침|저녁|밤|낮|새벽)\s*)?(\d{1,2}|열두|열한|열|아홉|여덟|일곱|여섯|다섯|네|세|두|한)\s*(?:시(?!간)(?:\s*(반|\d{1,2}\s*분))?|:(\d{2}))/u);
  if (clock) {
    let hour = hours[clock[2]] || Number(clock[2]);
    const minute = clock[3] === '반' ? 30 : Number(clock[4] || clock[3]?.replace(/\D/g, '') || 0);
    invalid ||= hour > 23 || minute > 59 || Boolean(clock[1] && (hour < 1 || hour > 12));
    ambiguousTime = !clock[1] && !clock[4] && hour >= 1 && hour <= 12;
    if (ambiguousTime && !invalid) ambiguousClock = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    if (/오후|저녁|밤|낮/u.test(clock[1]) && hour < 12) hour += 12;
    if (/오전|아침|새벽/u.test(clock[1]) && hour === 12) hour = 0;
    if (clock[1] === '밤' && hour === 12) hour = 0;
    if (!invalid && !ambiguousTime) time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  } else if (/정오|자정/u.test(text)) time = text.includes('정오') ? '12:00' : '00:00';
  return { date, time, invalid, ambiguousTime, ...(ambiguousClock ? { ambiguousClock } : {}) };
}
