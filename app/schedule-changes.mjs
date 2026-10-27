import { dateKey, isScheduleDetail, nextRecurringDue, occurrenceInWeek, recurrenceEnd, recurrenceFromText, recurrenceLabel, recurrenceProblem, recurrenceToken, recurrenceType, recurrenceWhen, repeatEndLabel, repeats, restoreSchedulePattern, scheduleWhen, weeklyOccurrenceInWeek, withinRepeatEnd } from './schedule-intent.mjs';

const normalize = value => String(value || '').toLocaleLowerCase('ko-KR').replace(/[\s\p{P}\p{S}]/gu, '');
const datePattern = /(?:20\d{2}년\s*)?\d{1,2}월\s*\d{1,2}일?|20\d{2}-\d{2}-\d{2}|(?:(?:다다음|다음|이번)\s*주\s*)?[월화수목금토일]요일|오늘|내일|모레|글피|\d{1,2}\s*일\s*(?:뒤|후)|\d{1,2}\s*일/gu;
const timePattern = /(?:(?:오전|오후|아침|저녁|밤|낮|새벽)\s*)?(?:\d{1,2}|열두|열한|열|아홉|여덟|일곱|여섯|다섯|네|세|두|한)\s*(?:시(?!간)(?:\s*(?:반|\d{1,2}\s*분))?|:\d{2})|정오|자정/gu;
const changeWords = /취소|삭제|없어졌|바뀌|바꿔|바꿨|변경|수정|옮겨|옮겼|미뤄|미루|당겨|당겼|연장|단축/u;
const abort = /^(?:(?:아니야|아니|그냥)\s*)?(?:취소(?:해\s*줘)?|그만|됐어|변경하지\s*마|수정하지\s*마|취소하지\s*마)[.!\s]*$/u;
const onceWords = /(?:이번|다음)\s*주|이번\s*회차|이번만|한\s*번만/u;
const matches = (item, query) => !query || [item.title, `${item.course || ''} ${item.title}`].some(value => normalize(value).includes(query));
const snapshot = ({ id, title, due, cancelled_at, repeat_weekly, recurrence, monthly_day, repeat_until, series_due, ended, exceptions }) => ({ id, title, due, cancelled_at, repeat_weekly, recurrence, monthly_day, repeat_until, series_due, ended, exceptions });
const pending = (action, items, fields, now) => ({ action, candidateIds: items.map(item => item.id), itemId: items.length === 1 ? items[0].id : null, snapshots: items.map(snapshot), ...fields, created: now.getTime() });
const ask = (message, draft = null) => ({ action: 'none', message, draft });
const dateLabel = due => new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(due));

// Resolve references only against stored IDs and receipts. The model never chooses a row to mutate.
export function prepareScheduleChange({ message, items, cancelledItems = [], recent = [], draft = null, now = new Date() }) {
  const knownTitle = [...items, ...cancelledItems].some(item => normalize(message).includes(normalize(item.title)));
  const scheduleSubject = /일정|회의|약속|과제|시험|마감|수업|종료일|종료\s*날짜/u.test(message);
  // "아까" may refer to a user fact or wording, even when an older schedule receipt exists.
  if (!knownTitle && !scheduleSubject && /기억|전공|취향|호칭|말투|답변|대사|문장/u.test(message)) return null;
  const changeDraft = ['update', 'cancel', 'restore', 'inspect'].includes(draft?.action) ? draft : null;
  if (draft && abort.test(message)) return ask('알겠어. 진행하던 일정 입력은 취소할게. 저장된 일정은 그대로야.');
  const end = recurrenceEnd(message, now, Boolean(changeDraft?.awaitEnd));
  if (draft && !changeDraft && end.provided && /^(?:해\s*줘)?[.!\s]*$/u.test(end.text)) return null;
  const endQuestion = /언제까지|종료일.{0,8}(?:언제|뭐|알려|확인)|언제.{0,8}(?:끝나|종료)/u.test(message);
  if (!changeDraft && !endQuestion && recurrenceFromText(message) && /있어|있다|등록|추가/u.test(message) && !changeWords.test(message) && !restoreSchedulePattern.test(message)) return null;
  const endIntent = /종료일|종료\s*날짜|끝나는\s*날/u.test(message) && !endQuestion;
  const endEdit = end.provided && (endIntent || /연장|단축|계속\s*반복해/u.test(message) || /^(?:그|이|저|아까|방금)/u.test(message.trim()) || !recurrenceFromText(message) && !/있어|있다|등록|추가/u.test(message) && (!draft || changeDraft));
  const endFollowup = changeDraft && end.provided && /^(?:(?:로)?\s*(?:해\s*줘|연장해\s*줘|단축해\s*줘))?[.!\s]*$/u.test(end.text);
  let restoreMatch = message.match(restoreSchedulePattern);
  const hasChange = Boolean(restoreMatch) || changeWords.test(message) || endEdit || endQuestion;
  const scopeAnswer = changeDraft?.awaitScope && /^\s*(?:반복\s*)?전체(?:로|를|야)?(?:\s*(?:취소|변경|수정)?해\s*줘)?[.!\s]*$/u.test(message) && (!/취소/u.test(message) || changeDraft.action === 'cancel') && (!/변경|수정/u.test(message) || changeDraft.action === 'update');
  const onceAnswer = changeDraft?.awaitScope && onceWords.test(message) && (!hasChange || (changeDraft.action === 'cancel' ? /취소/u.test(message) : changeDraft.action === 'restore' ? Boolean(restoreMatch) : !/취소/u.test(message) && !restoreMatch));
  const ordinalAnswer = changeDraft && /^\s*(?:[1-9]\d?\s*번?|첫\s*번째|두\s*번째|세\s*번째)(?:거|야|로)?[.!\s]*$/u.test(message);
  const selection = changeDraft && (endFollowup || scopeAnswer || onceAnswer || isScheduleDetail(message) || onceWords.test(message) || ordinalAnswer || [...items, ...cancelledItems].some(item => changeDraft.candidateIds.includes(item.id) && normalize(message).includes(normalize(item.title))));
  if (!hasChange && !selection) return null;
  if (restoreMatch && /잡(?:으려|을\s*예정|는\s*중)|(?:복구|복원)(?:할\s*예정|하려고)|혔는지|됐는지|알려\s*줘/u.test(message)) return null;
  if (!endQuestion && (/만약|가정|예를\s*들|할까|될까|할지|될지|잡(?:을까|힐까|으면|히면|을지|힐지)|한다면|하면|바뀌면|변경되면|취소되면|수도|수\s*있|같아|생각|고\s*싶|지\s*마|말아|않|아니|(?:안|못)\s*(?:하|할|해|했|됐|되|바꿔|바꿨|취소|잡|연장|단축)|왜|언제|어떻게|(?:친구|동생|누나|엄마|아빠)(?:은|는|이|가).*(?:대|더라)/u.test(message)
      || (/[?？]/u.test(message) && !/(?:해|바꿔|옮겨|미뤄|당겨|잡아|되돌려|없애|지워)\s*(?:줘|줄래)/u.test(message)))) return changeDraft ? ask('알겠어. 일정은 그대로 둘게.') : null;
  if (/전부|모두|둘\s*다|다\s*(?:취소|삭제|복구|복원)|그리고|말고|(?:취소|삭제|변경|수정|복구|복원)하고|바꾸고|옮기고/u.test(message)) return ask('한 번에 하나씩 바꿀게. 어떤 일정인지 이름을 말해 줘.');

  const action = endQuestion ? 'inspect' : scopeAnswer || endFollowup ? changeDraft.action : restoreMatch ? 'restore' : endEdit || endIntent ? 'update' : hasChange ? /취소|삭제|없어졌/u.test(message) ? 'cancel' : 'update' : changeDraft.action;
  const continuing = !hasChange || scopeAnswer || onceAnswer || endFollowup ? changeDraft : null;
  if (end.provided) message = end.text;
  if (endQuestion) message = message.replace(/(?:언제|종료일|끝나는\s*날)[\s\S]*$/u, '');
  if (endIntent) message = message.replace(/(?:종료일|종료\s*날짜|끝나는\s*날)(?:은|는|을|를)?/gu, '');
  restoreMatch = message.match(restoreSchedulePattern);
  const rename = action === 'update' && message.match(/\s*(?:이름|제목)(?:을|를)?\s*["“']?(.+?)["”']?(?:으)?로\s*(?:바꿔|변경|수정)/u);
  const targetText = rename ? message.slice(0, rename.index) : restoreMatch ? message.slice(0, restoreMatch.index).replace(/^취소(?:된|했던|한)\s*/u, '') : message;
  let query = targetText.replace(recurrenceToken, '').replace(/반복\s*전체|반복|전체|앞으로(?:도)?|(?:이번|다음)\s*주(?:에)?(?:만)?|이번\s*회차(?:만)?|이번만|한\s*번만/gu, '').replace(datePattern, '').replace(timePattern, '')
    .replace(/(?:으로|로)?\s*(?:취소|삭제|없어졌|바뀌|바꿔|바꿨|변경|수정|옮겨|옮겼|미뤄|미루|당겨|당겼|연장|단축)[\s\S]*$/u, '')
    .replace(/(?:으로|로|에)\s*$/u, '')
    .replace(/\s*(?:시간|날짜|시각)(?:은|는|을|를|이|가)?\s*$/u, '').trim().replace(/(?:은|는|을|를|이|가)$/u, '').trim();
  if (endEdit) query = query.replace(/(?:해\s*줘|하자|진행해\s*줘)[.!\s]*$/u, '').replace(/(?:기간)(?:은|는|을|를)?$/u, '').trim();
  if (onceWords.test(message)) query = query.replace(/만$/u, '').trim();
  const reference = (!query && (endEdit || endIntent || endQuestion || onceWords.test(message) || recurrenceFromText(message))) || /^(?:그거|이거|그것|이것|방금|아까|그\s|이\s|저\s|그(?:회의|일정|약속|과제|시험)|이(?:회의|일정|약속))/u.test(query);
  // Changing a preference or major is ordinary conversation, not a schedule mutation.
  if (!changeDraft && !knownTitle && !scheduleSubject && !reference) return null;
  if (reference) query = query.replace(/^(?:그거|이거|그것|이것|방금(?:\s*말한)?|아까(?:\s*말한)?|그|이|저)\s*/u, '');
  query = normalize(query === '일정' ? '' : query);
  const last = reference ? [...recent].reverse().find(row => row.schedule_action && matches(row.schedule_action, query))?.schedule_action : null;
  if (draft && !changeDraft && action === 'cancel' && reference && matches(draft, query)) return ask('알겠어. 물어보던 일정은 등록하지 않을게. 저장된 일정은 그대로야.');

  const dates = [...message.matchAll(datePattern)], times = [...message.matchAll(timePattern)];
  const fields = { ...(continuing?.fields || {}) };
  if (end.provided) { fields.untilSet = !end.invalid; fields.repeat_until = end.value; fields.invalidUntil = end.invalid; fields.whole = true; fields.once = false; }
  if (endIntent) fields.whole = true;
  const requestedRecurrence = recurrenceFromText(message);
  if (requestedRecurrence) fields.recurrence = requestedRecurrence;
  if (scopeAnswer || requestedRecurrence || /전체|앞으로|반복/u.test(message)) { fields.whole = true; fields.once = false; }
  if (onceWords.test(message)) {
    if (end.provided || endIntent || requestedRecurrence || /전체|앞으로|반복/u.test(message)) return ask('이번 회차와 반복 전체 중 하나만 골라 말해 줘. 일정은 그대로 둘게.');
    fields.once = true; fields.whole = false;
    const weekWord = message.match(/(이번|다음)\s*주/u);
    const occurrenceWord = message.search(/이번\s*회차|이번만|한\s*번만/u);
    if (occurrenceWord >= 0) { delete fields.week; delete fields.originalDue; }
    // In "이번 회차를 다음 주 화요일로", next week is the destination, not the target.
    if (weekWord && (occurrenceWord < 0 || weekWord.index < occurrenceWord)) {
      const week = new Date(now); week.setDate(week.getDate() + (weekWord[1] === '다음' ? 7 : 0));
      fields.week = dateKey(week);
      delete fields.originalDue;
    }
  }
  if (action === 'restore' && last?.scope === 'occurrence' && !fields.whole) fields.once = true;
  if (['update', 'restore'].includes(action) && !rename && (!continuing || continuing.itemId)) {
    if (dates.length) {
      const when = scheduleWhen(dates.at(-1)[0], now);
      fields.date = when.date; fields.invalidDate = when.invalid;
      delete fields.monthlyDay;
      const monthDay = dates.at(-1)[0].match(/^(\d{1,2})\s*일$/u);
      if (monthDay) { fields.monthlyDay = Number(monthDay[1]); fields.invalidDate ||= fields.monthlyDay < 1 || fields.monthlyDay > 31; }
    }
    if (times.length) {
      const when = scheduleWhen(times.at(-1)[0], now);
      fields.time = when.time; fields.invalidTime = when.invalid;
      fields.ambiguousClock = when.ambiguousClock || null;
    }
    const meridiem = message.match(/^(오전|오후)(?:이?야)?[.!\s]*$/u)?.[1];
    if (meridiem && fields.ambiguousClock) {
      fields.time = scheduleWhen(`${meridiem} ${fields.ambiguousClock}`, now).time;
      fields.ambiguousClock = null; fields.invalidTime = false;
    }
  }
  const newTitle = rename ? rename[1].replace(/["“”']/g, '').trim() : continuing?.newTitle || null;
  const sourceItems = action === 'inspect' ? [...items, ...cancelledItems] : action === 'restore' ? (fields.once ? items.filter(item => repeats(item) && item.exceptions?.some(value => value.cancelled)) : [...cancelledItems, ...items.filter(item => item.ended)]) : items;
  let candidates = sourceItems.filter(item => !item.completed && (!continuing || continuing.candidateIds.includes(item.id)));
  if (fields.once && fields.week) candidates = candidates.filter(item => repeats(item) || weeklyOccurrenceInWeek(item.due, new Date(`${fields.week}T12:00`)) === item.due);
  if (continuing?.itemId) {
    candidates = candidates.filter(item => item.id === continuing.itemId);
  } else if (continuing) {
    const ordinal = message.trim().match(/^([1-9]\d?)\s*번?(?:거|야|로)?[.!\s]*$/u);
    const index = ordinal ? Number(ordinal[1]) - 1 : /^첫\s*번째/u.test(message) ? 0 : /^두\s*번째/u.test(message) ? 1 : /^세\s*번째/u.test(message) ? 2 : -1;
    if (index >= 0) candidates = candidates.filter(item => item.id === continuing.candidateIds[index]);
    else if (!isScheduleDetail(message)) {
      const selected = normalize(message.replace(/(?:이야|야|말이야)[.!\s]*$/u, ''));
      candidates = candidates.filter(item => matches(item, selected));
    }
  } else {
    const exact = query && candidates.filter(item => [item.title, `${item.course || ''} ${item.title}`].some(value => normalize(value) === query));
    candidates = exact?.length ? exact : candidates.filter(item => matches(item, query));
    // A leading date describes the target: "내일 회의 모레로 미뤄 줘".
    if (action !== 'restore' && !fields.once && dates.length && message.trimStart().startsWith(dates[0][0])) {
      const targetDate = scheduleWhen(dates[0][0], now).date;
      if (targetDate) candidates = candidates.filter(item => item.due.startsWith(targetDate));
    }
    if (reference) {
      if (last) {
        const target = candidates.find(item => item.id === last.itemId);
        if (!target) return ask(action === 'restore' ? `${last.title}, 지금 취소 상태가 아니거나 삭제된 일정이야. 다른 일정이면 정확한 이름을 말해 줘.` : `${last.title}, 지금 변경할 수 있는 미완료 일정이 아니야. 다른 일정이면 정확한 이름을 말해 줘.`);
        candidates = [target];
      } else if (!query) candidates = [];
    } else if (!query) candidates = [];
  }
  if (!candidates.length) return ask(action === 'restore' ? '그 이름으로 복구할 취소 일정을 찾지 못했어. 일정 이름을 정확히 말해 줘.' : '그 이름으로 변경할 미완료 일정을 찾지 못했어. 일정 이름을 정확히 말해 줘.');
  if (candidates.length > 8) return ask('같은 이름의 일정이 많아. 날짜나 더 정확한 이름을 붙여서 다시 말해 줘.');
  if (continuing && candidates.some(item => !continuing.snapshots?.some(old => JSON.stringify(old) === JSON.stringify(snapshot(item))))) return ask('그 일정이 그사이 바뀌었어. 현재 일정을 확인하고 다시 말해 줘.');
  const nextDraft = pending(action, candidates, { fields, newTitle }, now);
  if (candidates.length > 1) return ask(`어느 일정이야? 이름이나 번호로 말해 줘.\n${candidates.map((item, i) => `${i + 1}. ${item.title} · ${repeats(item) ? recurrenceLabel(item) : dateLabel(item.due)}`).join('\n')}`, nextDraft);
  const item = candidates[0];
  const recurrence = fields.recurrence || recurrenceType(item), recurring = recurrence !== 'none';
  if (action === 'inspect') return ask(recurring ? `${item.title}, ${recurrenceLabel(item)} ${repeatEndLabel(item)} 반복이야.${item.ended ? ' 남은 회차가 없어 자동 종료된 상태야. 종료일을 연장하거나 없애면 다시 이어갈 수 있어.' : item.cancelled_at ? ' 지금은 취소 상태라 알림은 꺼져 있어.' : ''}` : `${item.title}은 반복 없는 일정이야.`);
  if ((end.provided || endIntent || continuing?.awaitEnd) && !recurring) return ask('종료일은 반복 일정에만 지정할 수 있어. 먼저 매일·매주·격주·매달 중 주기를 말해 줘.');
  if (fields.invalidUntil || endIntent && !fields.untilSet || continuing?.awaitEnd && !fields.untilSet) return ask(end.reason || '언제까지 반복할까? 날짜나 “종료일 없이”라고 말해 줘.', { ...nextDraft, awaitEnd: true });
  if (recurring && fields.once) {
    if (!repeats(item)) return ask('먼저 반복 일정을 등록해 줘.');
    if (fields.week && recurrence === 'daily') return ask('매일 일정은 한 주에 여러 회차가 있어. 다음 한 번만 바꾸려면 “이번 회차”라고 말해 줘.', nextDraft);
    if (fields.monthlyDay) return ask('한 회차를 옮길 때는 월과 일을 함께 말해 줘.', nextDraft);
    const original = fields.originalDue || (fields.week ? occurrenceInWeek(item, new Date(`${fields.week}T12:00`)) : last?.scope === 'occurrence' && last.itemId === item.id ? last.original_due : item.occurrence_due || item.due);
    if (!original) return ask('그 주에는 반복 회차가 없어. 다른 회차는 그대로 둘게.');
    fields.originalDue = original;
    const exception = item.exceptions?.find(value => value.original_due === original);
    const currentDue = exception?.due || original;
    if (new Date(currentDue) <= now) return ask('그 주의 회차는 이미 지났어. 다음 주 일정은 그대로 둘게. 변경할 회차를 다시 말해 줘.');
    if (newTitle) return ask('이번 회차는 날짜·시간만 바꿀 수 있어. 이름 변경은 반복 전체로 말해 줘.');
    if (action === 'restore' && !exception?.cancelled) return ask('그 회차는 취소 상태가 아니야. 일정은 그대로 둘게.');
    if (action === 'update' && exception?.cancelled) return ask('그 회차는 취소 상태야. 다시 잡혔다고 말하면 복구할게.');
    if (fields.invalidDate || fields.invalidTime) return ask('날짜나 시간이 맞지 않아. 정확한 날짜와 시간을 다시 말해 줘.', nextDraft);
    if (fields.ambiguousClock) return ask(`${item.title}, 오전이야 오후야?`, nextDraft);
    if (action === 'update' && !fields.date && !fields.time) return ask(`${item.title}, 이번 회차를 어느 날짜나 시간으로 바꿀까?`, nextDraft);
    const due = action === 'cancel' ? currentDue : `${fields.date || currentDue.slice(0, 10)}T${fields.time || currentDue.slice(11, 16)}`;
    if (!withinRepeatEnd(item, original) || !withinRepeatEnd(item, due)) return ask('그 회차는 반복 종료일 밖이야. 먼저 반복 전체의 종료일을 연장해 줘.');
    if (new Date(due) <= now) return ask('그 시간은 이미 지났어. 앞으로의 날짜와 시간을 말해 줘.', nextDraft);
    return { action, scope: 'occurrence', itemId: item.id, original_due: original, due, title: item.title, previousDue: currentDue, draft: null };
  }
  if (recurring && !fields.whole) return ask(`${item.title}, 이번 회차만 바꿀까, 반복 전체를 ${action === 'cancel' ? '취소' : action === 'restore' ? '복구' : '변경'}할까? “이번 회차” 또는 “전체”라고 말해 줘.`, { ...nextDraft, awaitScope: true });
  const problem = recurring && !ordinalAnswer && recurrenceProblem(message, recurrence);
  if (problem) return ask(problem);
  if (action === 'cancel') return { action, itemId: item.id, draft: null };
  if (fields.invalidDate || fields.invalidTime) return ask('날짜나 시간이 맞지 않아. 정확한 날짜와 시간을 다시 말해 줘.', nextDraft);
  if (fields.ambiguousClock) return ask(`${item.title}, 오전이야 오후야?`, nextDraft);
  if (fields.monthlyDay && recurrence !== 'monthly') return ask('월과 일을 함께 말해 줘. 매달 규칙을 바꾸려면 “매달 15일”처럼 말하면 돼.', nextDraft);
  if (action !== 'restore' && !fields.date && !fields.time && !newTitle && !fields.recurrence && !fields.monthlyDay && !fields.untilSet) return ask(`${item.title}, 어느 날짜나 시간으로 바뀌었어?`, nextDraft);
  const baseDue = recurring ? item.series_due || item.due : item.due;
  const monthlyDay = recurrence === 'monthly' ? fields.monthlyDay || (fields.date ? new Date(`${fields.date}T12:00`).getDate() : item.monthly_day) || new Date(baseDue).getDate() : 0;
  if (recurrence === 'monthly' && fields.recurrence === 'monthly' && recurrenceType(item) !== 'monthly' && !fields.monthlyDay && !fields.date) return ask(`${item.title}, 매달 며칠로 바꿀까?`, nextDraft);
  if (fields.monthlyDay && recurrence === 'monthly') fields.date = recurrenceWhen(`${monthlyDay}일`, recurrence, now).date;
  if (recurrence === 'daily' && recurrenceType(item) !== 'daily' && !fields.date) fields.date = dateKey(now);
  let due = `${fields.date || baseDue.slice(0, 10)}T${fields.time || baseDue.slice(11, 16)}`;
  if (recurring) {
    if (recurrence === 'biweekly' && recurrenceType(item) !== 'biweekly') due = nextRecurringDue(due, 'weekly', now);
    due = nextRecurringDue(due, recurrence, now, monthlyDay);
  }
  const until = fields.untilSet ? fields.repeat_until : item.repeat_until ?? null;
  const endOnly = fields.untilSet && !fields.date && !fields.time && !fields.recurrence && !fields.monthlyDay;
  if (recurring && until && until < baseDue.slice(0, 10)) return ask('종료일이 첫 회차보다 빨라. 더 뒤의 종료일을 말해 줘.', { ...nextDraft, fields: { ...fields, untilSet: false }, awaitEnd: true });
  if (recurring && !withinRepeatEnd({ repeat_until: until }, due) && !endOnly) return ask('현재 종료일 안에 남은 회차가 없어. 새 종료일이나 “종료일 없이”라고 말해 줘.', { ...nextDraft, fields: { ...fields, untilSet: false }, awaitEnd: true });
  if (endOnly) due = baseDue;
  if (!endOnly && (action === 'restore' || fields.date || fields.time) && new Date(due) <= now) return ask('그 시간은 이미 지났어. 앞으로의 날짜와 시간을 말해 줘.', nextDraft);
  if (newTitle && newTitle.length > 100) return ask('일정 이름은 100자 안으로 말해 줘.', nextDraft);
  return { action, itemId: item.id, due, title: newTitle || item.title, ...(recurring ? { recurrence, monthly_day: monthlyDay, repeat_until: until, repeat_weekly: recurrence === 'weekly' ? 1 : 0 } : {}), draft: null };
}
