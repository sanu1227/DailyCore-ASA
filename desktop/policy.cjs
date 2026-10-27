const views = new Set(['home', 'chat', 'university', 'routines', 'activity', 'health', 'review', 'memory', 'settings']);
exports.validView = value => views.has(value);
exports.surfaceForView = value => value === 'chat' ? 'widget' : 'app';
exports.viewFromArguments = args => {
  const value = args.find(arg => arg.startsWith('--view='))?.slice(7);
  return views.has(value) ? value : 'chat';
};
exports.isAppUrl = value => {
  try { const url = new URL(value); return url.protocol === 'rin:' && url.hostname === 'app' && !url.port && !url.username && !url.password; }
  catch { return false; }
};
exports.isAllowedExternal = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && ['eclass.tukorea.ac.kr', 'portal.tukorea.ac.kr', 'yg-babymonster-official.jp'].includes(url.hostname) && !url.username && !url.password && !url.port; }
  catch { return false; }
};
exports.validBounds = (saved, workArea, surface = 'widget', displayBounds = workArea) => {
  const full = surface === 'app';
  const aspect = displayBounds.width / displayBounds.height;
  const defaultWidth = Math.round(Math.min(workArea.width, 1280, Math.max(720, workArea.width * 0.55), workArea.height * aspect, 720 * aspect));
  const defaultHeight = Math.round(defaultWidth / aspect);
  const width = full
    ? Math.min(Math.max(Number(saved.width) || 1180, 800), workArea.width)
    : Math.round(Math.min(Math.max(Number.isFinite(saved.width) ? saved.width : defaultWidth, 480), workArea.width));
  const height = full
    ? Math.min(Math.max(Number(saved.height) || 860, 620), workArea.height)
    : Math.round(Math.min(Math.max(Number.isFinite(saved.height) ? saved.height : defaultHeight, 360), workArea.height));
  const left = workArea.x || 0, top = workArea.y || 0;
  const x = Number.isFinite(saved.x) ? saved.x : left + Math.round((workArea.width - width) / 2);
  const y = Number.isFinite(saved.y) ? saved.y : top + Math.round((workArea.height - height) / 2);
  return { width, height, x: Math.max(left, Math.min(x, left + workArea.width - width)), y: Math.max(top, Math.min(y, top + workArea.height - height)) };
};
exports.notificationDisplayId = (displays, cursorDisplayId, gameWindowBounds) => {
  if (!Array.isArray(displays) || !displays.length) return cursorDisplayId;
  const fallback = displays.find(display => display.id === cursorDisplayId) || displays.find(display => display.primary) || displays[0];
  return displays.find(display => !display.primary)?.id || fallback.id;
};

const photos = ['asa/portrait.jpg', 'asa/choom.jpg', 'asa/moon.jpg', 'asa/supa-dupa-luv.jpg'];
const notificationArt = {
  default: photos, briefing: [photos[1], photos[2], photos[3], photos[0]],
  deadline: [photos[1], photos[2]], routine: [photos[3], photos[0]], break: [photos[3], photos[2]],
  meal: [photos[0], photos[3]], study: [photos[1], photos[2]], casual: photos,
  success: [photos[2], photos[3]], bedtime: [photos[3], photos[2]]
};
exports.notificationArtPool = candidate => {
  const key = String(candidate?.key || '');
  const title = String(candidate?.title || '');
  if (key.startsWith('focus-end:')) return notificationArt.success;
  if (/잘 시간|취침|수면/.test(title)) return notificationArt.bedtime;
  if (/식사|아침|점심|저녁|밥/.test(title)) return notificationArt.meal;
  if (/공부|학습|집중/.test(title)) return notificationArt.study;
  if (key.startsWith('activity-break:') || key.startsWith('health-check:') || /쉬어|물/.test(title)) return notificationArt.break;
  if (key.startsWith('briefing:') || key.startsWith('class:')) return notificationArt.briefing;
  if (key.startsWith('game:') || key.startsWith('deadline-')) return notificationArt.deadline;
  if (key.startsWith('routine:')) return notificationArt.routine;
  if (key.startsWith('casual:') || key.startsWith('away:')) return notificationArt.casual;
  if (/완료|끝|잘했/.test(title)) return notificationArt.success;
  return notificationArt.default;
};
exports.chooseNotificationArt = (candidate, previous, random = Math.random, used = new Set()) => {
  const pool = exports.notificationArtPool(candidate);
  const unseen = pool.filter(item => item !== previous && !used.has(item));
  const choices = unseen.length ? unseen : pool.length > 1 ? pool.filter(item => item !== previous) : pool;
  const index = Math.min(choices.length - 1, Math.floor(Math.max(0, random()) * choices.length));
  return choices[index] || pool[0];
};
