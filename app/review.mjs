const localDateKey = date => {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const sameDay = (value, now) => Boolean(value) && localDateKey(new Date(value)) === localDateKey(now);
const formatMinutes = minutes => minutes >= 60 ? `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}` : `${minutes}분`;
const quiet = (now, start, end, enabled = true) => {
  if (!enabled || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = start.split(':').map(Number), [eh, em] = end.split(':').map(Number);
  const from = sh * 60 + sm, to = eh * 60 + em;
  return from < to ? current >= from && current < to : current >= from || current < to;
};

export function buildEveningReview({ classes = [], academics = [], routines = [], activity, now = new Date() }) {
  const today = now.getDay() || 7;
  const tomorrow = today === 7 ? 1 : today + 1;
  const todayRoutines = routines.filter(item => item.active && item.days.includes(today));
  const routineDone = todayRoutines.filter(item => item.completedToday).length;
  const completedAcademics = academics.filter(item => item.completed && sameDay(item.completed_at, now)).length;
  const gameMinutes = Math.round((activity?.categories?.game || 0) / 60);
  const studyMinutes = Math.round((activity?.categories?.study || 0) / 60);
  const tomorrowEnd = new Date(now); tomorrowEnd.setDate(now.getDate() + 1); tomorrowEnd.setHours(23, 59, 59, 999);
  const open = academics.filter(item => !item.completed && !item.cancelled_at && !item.ended && !item.missing_since && new Date(item.due) >= now && new Date(item.due) <= tomorrowEnd)
    .sort((a, b) => new Date(a.due) - new Date(b.due));
  const priority = open[0] || null;
  const tomorrowClasses = classes.filter(item => item.day === tomorrow).sort((a, b) => a.start.localeCompare(b.start));
  const highlights = [];
  if (routineDone) highlights.push({ label: '완료한 루틴', value: `${routineDone} / ${todayRoutines.length}` });
  if (completedAcademics) highlights.push({ label: '마친 일정', value: `${completedAcademics}개` });
  if (studyMinutes) highlights.push({ label: 'PC 공부·개발', value: formatMinutes(studyMinutes) });
  if (gameMinutes) highlights.push({ label: 'PC 게임', value: formatMinutes(gameMinutes) });
  let nextDetail = '';
  if (priority) {
    const when = `${sameDay(priority.due, now) ? '오늘' : '내일'} ${priority.due.slice(11, 16)}`;
    nextDetail = priority.kind === 'event' ? `${when}에 예정돼 있어.`
      : priority.kind === 'exam' ? `${when} 시험이야.` : `${when} 마감이야.`;
  }
  const nextAction = priority ? `${priority.title}, ${nextDetail}` : '';
  const facts = [];
  if (routineDone) facts.push(`루틴 ${routineDone}개를 완료했어.`);
  if (completedAcademics) facts.push(`일정 ${completedAcademics}개를 마쳤어.`);
  if (!facts.length && studyMinutes) facts.push(`오늘 PC 공부·개발 시간은 ${formatMinutes(studyMinutes)}이야.`);
  if (!facts.length && gameMinutes) facts.push(`오늘 PC 게임 시간은 ${formatMinutes(gameMinutes)}이야.`);
  const shortTitle = value => value.length > 44 ? value.slice(0, 43) + '…' : value;
  if (priority) facts.push(nextAction.replace(priority.title, shortTitle(priority.title)));
  else if (tomorrowClasses.length) facts.push(`내일은 ${tomorrowClasses[0].start}에 ${shortTitle(tomorrowClasses[0].name)} 수업이 있어.`);
  const hasContent = highlights.length > 0 || Boolean(priority) || tomorrowClasses.length > 0;
  return {
    key: `evening-review:${localDateKey(now)}`, title: '아사 · 오늘 결산',
    body: facts.join(' '), highlights, hasContent, nextAction, nextDetail, priority, tomorrowClasses,
    stats: { routineDone, routineTotal: todayRoutines.length, completedAcademics, studyMinutes, gameMinutes },
    date: localDateKey(now)
  };
}

export function buildEveningReviewCandidate({ review, settings, usageMinutes = 0, now = new Date() }) {
  if (!settings.notifications || !settings.eveningReview || !review?.hasContent || quiet(now, settings.quietStart, settings.quietEnd, settings.quietModeEnabled)) return null;
  if (usageMinutes < settings.eveningReviewUsageMinutes) return null;
  return { key: review.key, title: review.title, body: review.body, display: 'daily-review' };
}

export function buildEveningReviewFromStore(store, now = new Date()) {
  const today = localDateKey(now);
  return buildEveningReview({
    classes: store.classes(), academics: store.academics(now), routines: store.routines(today),
    activity: store.activity(today), now
  });
}
