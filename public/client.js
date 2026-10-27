import { createPortrait } from './seoa-portrait.js';
import { createSceneCards } from './seoa-gallery.js';

const $ = id => document.getElementById(id);
const surface = new URLSearchParams(location.search).get('surface') === 'widget' ? 'widget' : 'app';
const isWidget = surface === 'widget';
document.documentElement.dataset.surface = document.body.dataset.surface = surface;
if (isWidget) {
  const slider = $('widget-transparency');
  const apply = () => {
    document.body.style.setProperty('--widget-backdrop-opacity', String(1 - slider.valueAsNumber / 100));
    $('widget-transparency-value').textContent = `${slider.value}%`;
    slider.setAttribute('aria-valuetext', `배경 투명도 ${slider.value}%`);
  };
  try {
    const saved = localStorage.getItem('seoa-widget-transparency');
    if (saved !== null && saved.trim() && Number.isFinite(Number(saved))) slider.value = String(Math.max(0, Math.min(100, Math.round(Number(saved)))));
  } catch { /* Keep the default if local storage is unavailable. */ }
  apply();
  slider.addEventListener('input', () => {
    apply();
    try { localStorage.setItem('seoa-widget-transparency', slider.value); }
    catch { toast('투명도 설정을 저장하지 못했어요.'); }
  });
  $('reset-widget-transparency').onclick = () => { slider.value = '36'; slider.dispatchEvent(new Event('input')); };
  if (window.rinDesktop?.resizeWidget) {
    const sizeControls = document.createElement('section'); sizeControls.id = 'widget-size';
    sizeControls.innerHTML = '<h3>위젯 크기</h3><label for="widget-width">가로 <output id="widget-width-value" for="widget-width"></output></label><input id="widget-width" type="range" min="480" max="1920" step="1"><label for="widget-height">세로 <output id="widget-height-value" for="widget-height"></output></label><input id="widget-height" type="range" min="360" max="1080" step="1"><button id="reset-widget-size" type="button" class="secondary">기본 크기</button>';
    $('widget-appearance').after(sizeControls);
    const grip = document.createElement('button'); grip.id = 'widget-resize'; grip.type = 'button';
    grip.title = '드래그로 크기 조절 · 방향키로 20px 조절'; grip.setAttribute('aria-label', '위젯 크기 조절');
    grip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 19 19 5M12 19l7-7M19 19h.01"/></svg>';
    document.body.append(grip);
    const updateSize = size => {
      for (const axis of ['width', 'height']) {
        const slider = $('widget-' + axis), dimension = axis === 'width' ? 'Width' : 'Height';
        slider.min = size['min' + dimension]; slider.max = size['max' + dimension]; slider.value = size[axis];
        slider.setAttribute('aria-valuetext', `${size[axis]}px`);
        $('widget-' + axis + '-value').textContent = `${size[axis]}px`;
      }
    };
    const readSize = () => window.rinDesktop.getWidgetSize().then(updateSize).catch(() => {});
    let resizeFrame, requestedSize, resizing = false;
    const flushSize = async () => {
      resizeFrame = undefined;
      if (resizing || !requestedSize) return;
      const size = requestedSize; requestedSize = undefined; resizing = true;
      const messages = $('messages'), followLatest = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
      try {
        updateSize(await window.rinDesktop.resizeWidget(size.width, size.height, size.keepPosition));
        if (followLatest) requestAnimationFrame(() => { messages.scrollTop = messages.scrollHeight; });
      }
      catch { toast('위젯 크기를 변경하지 못했어요.'); }
      finally { resizing = false; if (requestedSize) resizeFrame = requestAnimationFrame(flushSize); }
    };
    const resize = (width, height, keepPosition = false) => {
      requestedSize = { width, height, keepPosition };
      if (!resizeFrame && !resizing) resizeFrame = requestAnimationFrame(flushSize);
    };
    for (const axis of ['width', 'height']) $('widget-' + axis).addEventListener('input', () => resize($('widget-width').valueAsNumber, $('widget-height').valueAsNumber));
    $('reset-widget-size').onclick = async () => {
      requestedSize = undefined;
      try { updateSize(await window.rinDesktop.resetWidgetSize()); } catch { toast('기본 크기를 적용하지 못했어요.'); }
    };
    let drag;
    grip.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      drag = { x: event.screenX, y: event.screenY, width: innerWidth, height: innerHeight };
      grip.setPointerCapture(event.pointerId); event.preventDefault();
    });
    grip.addEventListener('pointermove', event => {
      if (drag) resize(drag.width + event.screenX - drag.x, drag.height + event.screenY - drag.y, true);
    });
    grip.addEventListener('pointerup', event => {
      if (drag) resize(drag.width + event.screenX - drag.x, drag.height + event.screenY - drag.y, true);
      drag = undefined;
    });
    grip.addEventListener('lostpointercapture', () => { drag = undefined; });
    window.addEventListener('blur', () => { drag = undefined; });
    grip.addEventListener('keydown', event => {
      const delta = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[event.key];
      if (delta) { event.preventDefault(); resize(innerWidth + delta[0], innerHeight + delta[1]); }
    });
    window.addEventListener('resize', readSize);
    $('open-chat-menu').addEventListener('click', readSize);
    void readSize();
  }
}
const changes = typeof BroadcastChannel === 'function' ? new BroadcastChannel('seoa-state') : null;
let refreshEpoch = 0, pendingChanges = 0;
const saveDraft = () => { try { sessionStorage.setItem('seoa-chat-draft', $('message').value); } catch {} };
try { $('message').value = sessionStorage.getItem('seoa-chat-draft') || ''; } catch {}
$('message').addEventListener('input', saveDraft);
window.addEventListener('pagehide', saveDraft);
function openDetails(name = 'home') {
  if (window.rinDesktop?.openApp) return window.rinDesktop.openApp(name).catch(() => toast('상세 화면을 열지 못했어. 다시 눌러 줘.'));
  location.href = `/?surface=app#${name}`;
}
$('open-details')?.addEventListener('click', () => openDetails());
$('show-widget')?.addEventListener('click', () => {
  if (window.rinDesktop?.showWidget) window.rinDesktop.showWidget().catch(() => toast('위젯을 열지 못했어. 다시 눌러 줘.'));
  else location.href = '/?surface=widget#chat';
});
const portrait = createPortrait($('seoa-portrait'));
portrait.setVisible(!isWidget);
const homePortrait = createPortrait($('seoa-home-portrait'), { scene: 'rest' });
homePortrait.setVisible(false);
const sceneCards = createSceneCards();
const sceneButtons = document.querySelectorAll('[data-portrait-scene]');
const updateSceneButtons = scene => sceneButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.portraitScene === scene)));
$('seoa-portrait').addEventListener('portraitscenechange', event => updateSceneButtons(event.detail));
try { portrait.setScene(localStorage.getItem('seoa-portrait-scene') || 'studio'); } catch {}
sceneButtons.forEach(button => { button.onclick = () => {
  portrait.setScene(button.dataset.portraitScene);
  try { localStorage.setItem('seoa-portrait-scene', button.dataset.portraitScene); } catch {}
}; });
const recurrenceType = item => item?.recurrence ?? (item?.repeat_weekly ? 'weekly' : 'none');
const repeats = item => recurrenceType(item) !== 'none';
const repeatLabel = document.createElement('label'); repeatLabel.htmlFor = 'academic-repeat'; repeatLabel.textContent = '반복 주기';
const repeatInput = document.createElement('select'); repeatInput.id = 'academic-repeat';
for (const [value, label] of [['none', '반복 없음'], ['daily', '매일'], ['weekly', '매주'], ['biweekly', '격주 (14일 간격)'], ['monthly', '매달']]) {
  const option = document.createElement('option'); option.value = value; option.textContent = label; repeatInput.append(option);
}
const monthLabel = document.createElement('label'); monthLabel.htmlFor = 'academic-month-day'; monthLabel.textContent = '매달 날짜 (없는 달에는 말일)';
const monthInput = document.createElement('input'); monthInput.id = 'academic-month-day'; monthInput.type = 'number'; monthInput.min = '1'; monthInput.max = '31';
const endLabel = document.createElement('label'); endLabel.htmlFor = 'academic-repeat-until'; endLabel.textContent = '반복 종료일 (당일까지 포함 · 비우면 계속)';
const endInput = document.createElement('input'); endInput.id = 'academic-repeat-until'; endInput.type = 'date';
const repeatHelp = document.createElement('p'); repeatHelp.className = 'help'; repeatHelp.textContent = '이 창은 반복 전체를 수정합니다. 주기·요일·날짜·시간 변경 시 회차별 예외를 해제합니다. 한 회차만 변경하려면 대화로 말해 주세요.';
$('academic-due').after(repeatLabel, repeatInput, monthLabel, monthInput, endLabel, endInput, repeatHelp);
const showMonthDay = () => { monthLabel.hidden = monthInput.hidden = repeatInput.value !== 'monthly'; monthInput.required = repeatInput.value === 'monthly'; endLabel.hidden = endInput.hidden = repeatInput.value === 'none'; };
repeatInput.onchange = () => { monthInput.value ||= new Date($('academic-due').value).getDate() || 1; showMonthDay(); };
$('academic-due').addEventListener('change', () => { if (repeatInput.value === 'monthly') monthInput.value = new Date($('academic-due').value).getDate(); });
showMonthDay();
const endedSection = document.createElement('section'); endedSection.className = 'panel'; endedSection.id = 'ended-academic-panel';
const endedHeading = document.createElement('h2'); endedHeading.textContent = '종료된 반복 일정';
const endedList = document.createElement('div'); endedList.id = 'ended-academic-list'; endedList.className = 'academic-list';
endedSection.append(endedHeading, endedList); $('past-academic-list').parentElement.after(endedSection);
if (window.rinDesktop) {
  document.body.classList.add('native-app');
  const titlebar = document.createElement('header'); titlebar.className = 'native-titlebar';
  const caption = document.createElement('div'); caption.className = 'native-caption'; caption.textContent = '아사';
  const controls = document.createElement('div'); controls.className = 'window-controls';
  for (const [label, icon, action] of [['최소화', '−', 'minimize'], ['최대화 또는 이전 크기', '□', 'maximize'], [isWidget ? '아사 완전히 종료' : '위젯으로 돌아가기', '×', isWidget ? 'quit' : 'close']]) {
    if (isWidget && action !== 'quit') continue;
    const button = document.createElement('button'); button.type = 'button'; button.textContent = icon; button.title = label; button.setAttribute('aria-label', label); button.onclick = () => window.rinDesktop[action](); controls.append(button);
  }
  titlebar.append(caption, controls); document.body.prepend(titlebar);
  if (isWidget) {
    caption.replaceChildren(document.querySelector('.chat-identity'));
    caption.title = '끌어서 화면 안에서 이동';
    const toolbar = document.createElement('div'); toolbar.className = 'widget-toolbar';
    toolbar.append($('open-details'), $('open-chat-menu'));
    controls.before(toolbar);
    const icons = [
      [$('open-chat-menu'), '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>'],
      [$('send'), '<path d="M12 19V5m-6 6 6-6 6 6"/>'],
      [controls.children[0], '<path d="m7 7 10 10M17 7 7 17"/>']
    ];
    for (const [button, paths] of icons) button.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    $('message').placeholder = '메시지 입력';
  }
  if (isWidget && window.rinDesktop.setClickThrough) {
    let point = { x: -1, y: -1 }, ignored, holding = false, buttons = 0, pointerRevision = 0, pointerPending = false;
    const updatePointer = () => {
      // DOM refreshes must not capture a drag that started behind the widget either.
      if (buttons && !holding && ignored) return;
      const target = document.elementFromPoint(point.x, point.y);
      const messages = $('messages'), rect = messages.getBoundingClientRect();
      const scrollbar = messages.scrollHeight > messages.clientHeight && point.x >= rect.right - 12 && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom;
      const interactive = holding || document.querySelector('dialog[open]') || scrollbar || target?.closest('button, a, input, textarea, select, [contenteditable="true"], .native-caption, .message');
      const next = !interactive;
      if (next !== ignored) { ignored = next; window.rinDesktop.setClickThrough(next); }
    };
    const readPointer = async () => {
      if (pointerPending || document.hidden) return;
      pointerPending = true;
      const revision = ++pointerRevision;
      try {
        const current = await window.rinDesktop.widgetPointer();
        if (revision === pointerRevision) { point = current; updatePointer(); }
      } catch { /* Retry on the next sample while the window remains visible. */ }
      finally { pointerPending = false; }
    };
    window.addEventListener('mousemove', event => {
      pointerRevision++; point = { x: event.clientX, y: event.clientY }; buttons = event.buttons;
      if (!buttons) holding = false;
      updatePointer();
    });
    window.addEventListener('pointerdown', event => { holding = true; buttons = event.buttons; updatePointer(); });
    window.addEventListener('pointerup', event => { holding = false; buttons = event.buttons; updatePointer(); });
    window.addEventListener('pointercancel', () => { holding = false; buttons = 0; void readPointer(); });
    document.documentElement.addEventListener('mouseleave', () => {
      // Windows can emit leave when forwarding switches or when entering the native drag handle.
      if (!holding) void readPointer();
    });
    window.addEventListener('blur', () => { holding = false; void readPointer(); });
    window.addEventListener('focus', readPointer);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void readPointer(); });
    window.addEventListener('resize', readPointer);
    document.addEventListener('scroll', updatePointer, true);
    new MutationObserver(updatePointer).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'hidden'] });
    // Forwarded mouse movement can stop on Windows; do not leave the controls click-through.
    const pointerTimer = setInterval(readPointer, 100);
    window.addEventListener('pagehide', () => clearInterval(pointerTimer), { once: true });
    void readPointer();
  }
  const desktopSettings = document.createElement('div'); desktopSettings.className = 'desktop-settings';
  const startupLabel = document.createElement('label'); startupLabel.className = 'check-label desktop-startup';
  const startupToggle = document.createElement('input'); startupToggle.type = 'checkbox'; startupToggle.setAttribute('aria-describedby', 'desktop-startup-help');
  startupLabel.append(startupToggle, document.createTextNode(' Windows 로그인 시 아사 시작하기'));
  const startupHelp = document.createElement('p'); startupHelp.id = 'desktop-startup-help'; startupHelp.className = 'help'; startupHelp.textContent = '두 번째 모니터에 위젯을 띄우고 알림을 시작해요. 아사를 종료하면 다음 로그인이나 직접 실행 전까지 멈춰요.';
  startupToggle.disabled = true;
  window.rinDesktop.startupStatus().then(status => { startupToggle.checked = status.enabled; startupToggle.disabled = false; }).catch(() => { startupHelp.textContent = '자동 시작 상태를 확인하지 못했어요.'; });
  startupToggle.addEventListener('change', async event => {
    event.stopPropagation();
    const requested = startupToggle.checked; startupToggle.disabled = true;
    try {
      const status = await window.rinDesktop.setStartup(requested);
      startupToggle.checked = status.enabled;
      toast(status.enabled ? '다음 Windows 로그인부터 알림을 시작해요.' : 'Windows 자동 시작을 껐어. 앱 실행 중에만 알림이 와요.');
    } catch (error) {
      startupToggle.checked = !requested;
      toast(error?.message || '자동 시작 설정을 바꾸지 못했어.');
    } finally { startupToggle.disabled = false; }
  });
  const openFolder = document.createElement('button'); openFolder.className = 'secondary'; openFolder.textContent = '내 기록 폴더'; openFolder.onclick = () => window.rinDesktop.openDataFolder();
  const testNotification = document.createElement('button'); testNotification.className = 'secondary'; testNotification.textContent = '전체 알림 테스트'; testNotification.onclick = async () => { try { const result = await window.rinDesktop.testNotification(Number($('notification-volume').value)); toast(`${result.count}종류 알림을 두 번째 모니터에 차례로 보여 줄게.`); } catch { toast('알림을 표시하지 못했어. 알림 설정을 확인해 줘.'); } };
  const quit = document.createElement('button'); quit.className = 'secondary'; quit.textContent = '아사 종료'; quit.onclick = () => window.rinDesktop.quit();
  const backupLabel = document.createElement('label'); backupLabel.textContent = '자동 백업 복원'; backupLabel.className = 'desktop-backup-label';
  const backupSelect = document.createElement('select'); backupSelect.className = 'settings-select'; backupSelect.disabled = true;
  const backupHelp = document.createElement('p'); backupHelp.className = 'help'; backupHelp.textContent = '백업 목록을 확인하는 중이에요.';
  const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'secondary'; restore.textContent = '선택한 백업 복원'; restore.disabled = true;
  const loadBackups = async () => {
    try {
      const backups = await window.rinDesktop.listBackups(); backupSelect.replaceChildren();
      for (const backup of backups) { const option = document.createElement('option'); option.value = backup.name; option.textContent = `${backup.date} · ${backup.valid ? '정상' : '손상'}`; option.disabled = !backup.valid; backupSelect.append(option); }
      backupSelect.disabled = !backups.some(item => item.valid); restore.disabled = backupSelect.disabled;
      backupHelp.textContent = backups.length ? '복원 전 현재 DB를 별도 안전 백업으로 보존합니다.' : '사용 가능한 자동 백업이 아직 없어요.';
    } catch { backupHelp.textContent = '백업 목록을 확인하지 못했어요.'; }
  };
  restore.onclick = async () => {
    if (!backupSelect.value || !await confirmAction(`${backupSelect.selectedOptions[0]?.textContent} 백업으로 복원할까요? 현재 데이터는 복원 전 별도 백업으로 보존됩니다.`)) return;
    restore.disabled = true;
    try { await window.rinDesktop.restoreBackup(backupSelect.value); toast('백업을 복원했어요. 아사를 다시 연결하는 중이에요.'); }
    catch (error) { toast(error?.message || '백업을 복원하지 못했어요.'); restore.disabled = false; }
  };
  void loadBackups();
  desktopSettings.append(startupLabel, startupHelp, backupLabel, backupSelect, backupHelp, restore, testNotification, openFolder, quit); $('view-settings').append(desktopSettings);
}
let state, token, sending = false, outgoingText = '', streamingText = '', eclassSyncing = false, eclassSyncMessage = '', editingMemory = null, editingClass = null, editingAcademic = null, editingRoutine = null, toastTimer;
const dayNames = ['월', '화', '수', '목', '금', '토', '일'];
const kindNames = { assignment: '과제', exam: '시험', event: '일정' };
const routineCategoryNames = { sleep: '수면', exercise: '운동', meal: '식사', study: '공부', other: '기타' };
const activityCategoryNames = { study: '공부·개발', game: '게임', video: '영상', other: '기타' };
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 7000); }
function view(name, focus = true) {
  const recordLink = name === 'health';
  if (recordLink) name = 'routines';
  const target = $(`view-${name}`);
  if (!target) return;
  if ($('chat-menu').open) $('chat-menu').close();
  if (isWidget && name !== 'chat') { void openDetails(name); return; }
  document.querySelectorAll('.view').forEach(el => el.hidden = el.id !== `view-${name}`);
  document.querySelectorAll('.nav').forEach(el => {
    el.classList.toggle('active', el.dataset.view === name);
    if (el.dataset.view === name) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  const heading = target.querySelector('h1');
  $('current-view-title').textContent = name === 'home' ? '나의 하루' : name === 'chat' ? '아사와 대화' : heading.textContent;
  document.title = `${$('current-view-title').textContent} · 아사`;
  document.body.dataset.view = name;
  portrait.setVisible(!isWidget && name === 'chat');
  homePortrait.setVisible(!isWidget && name === 'home');
  sceneCards.show(name);
  history.replaceState(null, '', `#${name}`);
  if (focus) { if (name === 'chat') $('message').focus(); else { heading.tabIndex = -1; heading.focus(); } }
  if (recordLink) { $('health-form').scrollIntoView({ block: 'nearest' }); if (focus) $('health-date').focus({ preventScroll: true }); }
}
function confirmAction(description) {
  $('confirm-description').textContent = description;
  const dialog = $('confirm-dialog');
  return new Promise(resolve => {
    const finish = value => { dialog.close(); resolve(value); };
    $('confirm-yes').onclick = () => finish(true);
    $('confirm-no').onclick = () => finish(false);
    dialog.oncancel = () => resolve(false);
    dialog.showModal(); $('confirm-no').focus();
  });
}
async function readChatStream(response, onRecord) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('답변 스트림을 읽을 수 없어요. 다시 시도해 주세요.');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', result;
  const readLine = line => {
    if (!line.trim()) return;
    let record;
    try { record = JSON.parse(line); } catch { throw new Error('답변 데이터를 읽지 못했어요. 다시 시도해 주세요.'); }
    if (record?.type === 'error') throw new Error(record.error || '답변을 완성하지 못했어요. 다시 시도해 주세요.');
    if (record?.type === 'done' && Array.isArray(record.messages) && record.settings) {
      const { type, ...value } = record; result = value; return;
    }
    if (record?.type === 'reset' || record?.type === 'delta' && typeof record.text === 'string' || record?.type === 'status' && record.providerStatus && typeof record.providerStatus === 'object') onRecord(record);
    else throw new Error('답변 데이터 형식이 올바르지 않아요. 다시 시도해 주세요.');
  };
  try {
    while (!result) {
      let chunk;
      try { chunk = await reader.read(); }
      catch { throw new Error('답변 연결이 중단됐어요. 답변 완료 여부를 확인하지 못했어요.'); }
      try { buffer += decoder.decode(chunk.value, { stream: !chunk.done }); }
      catch { throw new Error('답변 데이터를 읽지 못했어요. 다시 시도해 주세요.'); }
      let newline;
      while (!result && (newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); readLine(line);
      }
      if (chunk.done) {
        if (!result && buffer.trim()) readLine(buffer);
        if (!result) throw new Error('답변 연결이 중단됐어요. 답변 완료 여부를 확인하지 못했어요.');
      }
    }
    return result;
  } finally {
    if (!result) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
function updateStreamingReply(record) {
  if (record.type === 'status') {
    state.providerStatus = record.providerStatus;
    renderProviderStatus();
    return;
  }
  streamingText = record.type === 'reset' ? '' : streamingText + record.text;
  const list = $('messages'), followLatest = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const card = $('streaming-reply');
  if (streamingText && card) card.lastElementChild.textContent = streamingText;
  else {
    card?.remove(); $('chat-pending')?.remove();
    appendPendingReply(list);
  }
  if (followLatest) list.scrollTop = list.scrollHeight;
}
function appendPendingReply(list) {
  if (!sending && !state.busy) return;
  if (streamingText) {
    const card = el('div', 'message assistant'); card.id = 'streaming-reply'; card.setAttribute('aria-busy', 'true');
    card.append(el('div', 'speaker', '아사'), el('div', 'bubble', streamingText)); list.append(card);
  } else {
    const pending = el('div', 'pending', '답변 중…'); pending.id = 'chat-pending'; list.append(pending);
  }
}
async function request(path, body) {
  refreshEpoch++; pendingChanges++;
  try {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': token, ...(path === '/api/chat' ? { Accept: 'application/x-ndjson' } : {}) }, body: JSON.stringify(body) });
  const result = response.ok && response.headers.get('Content-Type')?.includes('application/x-ndjson') ? await readChatStream(response, updateStreamingReply) : await response.json();
  if (!response.ok) throw new Error(result.error || '요청을 처리하지 못했어요.');
  if (path === '/api/settings') settingsDirty = false;
  if (path === '/api/chat') { streamingText = ''; outgoingText = ''; }
  state = result; render(); changes?.postMessage('refresh'); return result;
  } finally { refreshEpoch++; pendingChanges--; }
}
const el = (tag, cls, content) => { const node = document.createElement(tag); if (cls) node.className = cls; if (content !== undefined) node.textContent = content; return node; };
let homeSignature = '', chatSignature = '', settingsDirty = false;
function renderHome() {
  const now = new Date();
  const today = now.getDay() || 7;
  const end = new Date(now); end.setDate(end.getDate() + 7);
  const classes = state.classes.filter(item => item.day === today).sort((a, b) => a.start.localeCompare(b.start));
  const deadlines = state.academics.filter(item => !item.completed && !item.missing_since && Number.isFinite(new Date(item.due).getTime())).sort((a, b) => new Date(a.due) - new Date(b.due));
  const upcoming = deadlines.filter(item => new Date(item.due) >= now && new Date(item.due) <= end);
  const routines = state.routines.filter(item => item.active && item.days.includes(today)).sort((a, b) => a.time.localeCompare(b.time));
  $('home-title').textContent = '오늘의 일정';
  $('home-class-count').textContent = `${classes.length}개`;
  $('home-due-count').textContent = `${upcoming.length}개`;
  $('home-routine-count').textContent = `${routines.filter(item => item.completedToday).length} / ${routines.length}`;
  $('home-class-caption').textContent = classes.length ? `${classes.length}개의 수업` : '등록된 수업 없음';
  const signature = JSON.stringify([now.toDateString(), classes, deadlines.slice(0, 3), routines]);
  if (signature === homeSignature) return;
  homeSignature = signature;
  const row = (time, title, detail, target, urgent = false) => {
    const button = el('button', `agenda-row${urgent ? ' is-urgent' : ''}`);
    const copy = el('span', 'agenda-copy'); copy.append(el('strong', '', title), el('small', '', detail));
    button.append(el('span', 'agenda-time', time), copy, el('span', 'agenda-arrow', '›'));
    button.lastChild.setAttribute('aria-hidden', 'true');
    button.onclick = () => view(target); return button;
  };
  const classList = $('home-classes'); classList.replaceChildren();
  for (const item of classes) classList.append(row(item.start, item.name, `${item.end} 종료${item.location ? ` · ${item.location}` : ''}`, 'university'));
  if (!classes.length) classList.append(el('p', 'desk-empty', '오늘 등록한 수업이 없어요.'));
  const dueList = $('home-deadlines'); dueList.replaceChildren();
  for (const item of deadlines.slice(0, 3)) {
    const late = new Date(item.due) < now;
    dueList.append(row(late ? '지난 마감' : '마감 예정', item.title, `${item.course ? `${item.course} · ` : ''}${formatDue(item.due)}`, 'university', late));
  }
  if (!deadlines.length) dueList.append(el('p', 'desk-empty', '남은 마감이 없어요.'));
  const routineList = $('home-routines'); routineList.replaceChildren();
  for (const item of routines.slice(0, 4)) {
    const button = el('button', `home-routine${item.completedToday ? ' is-done' : ''}`);
    button.id = `home-routine-${item.id}`;
    button.setAttribute('aria-pressed', String(Boolean(item.completedToday)));
    button.setAttribute('aria-label', `${item.title}, ${item.time}, ${item.completedToday ? '완료 취소' : '완료하기'}`);
    const check = el('span', 'routine-check', item.completedToday ? '✓' : ''); check.setAttribute('aria-hidden', 'true');
    button.append(check, el('span', '', item.title), el('small', '', item.time));
    button.onclick = async () => {
      button.disabled = true;
      try { await request('/api/routine/toggle', { id: item.id, completed: !Boolean(item.completedToday) }); $(button.id)?.focus({ preventScroll: true }); }
      catch (error) { button.disabled = false; toast(error.message); }
    };
    routineList.append(button);
  }
  if (!routines.length) routineList.append(el('p', 'desk-empty', '오늘 등록한 루틴이 없어요.'));
}
function renderProviderStatus() {
  const aiStatus = state.providerStatus || {};
  const stageLabels = { memory: '기억 추출', schedule: '일정 해석', chat: '대화 응답' };
  const modelLabel = result => [result.model, result.provider === 'codex' ? 'Codex' : ''].filter(Boolean).join(' · ');
  const stage = stageLabels[aiStatus.stage] || 'AI';
  let summary = '아직 AI 응답 기록 없음';
  if (sending || state.busy || aiStatus.status === 'pending') summary = aiStatus.status === 'pending' && aiStatus.stage ? `${stage} 중` : '답변 처리 중';
  else if (aiStatus.turnError) summary = '최근 요청 실패';
  else if (aiStatus.status === 'success') summary = `최근 ${stage}: ${modelLabel(aiStatus)} · 성공`;
  else if (aiStatus.status === 'failed') summary = `최근 ${stage} 실패${aiStatus.model ? ` · ${modelLabel(aiStatus)}` : ''}`;
  else if (aiStatus.status === 'rules') summary = '최근 일정 응답: 앱 규칙으로 처리';
  else if (aiStatus.codex?.available === false) summary = 'Codex 연결 확인 필요';
  $('provider-status').textContent = summary;
  $('model').value = aiStatus.model || '응답 후 확인';

  const stages = Object.entries(aiStatus.stages || {});
  const issues = [aiStatus.turnError || aiStatus.error, ...stages.filter(([, result]) => result.status === 'failed').map(([phase, result]) => result.error && `${stageLabels[phase] || phase}: ${result.error}`), aiStatus.codex?.available === false ? aiStatus.codex.reason || 'Codex를 열어 로그인 상태와 사용 한도를 확인한 뒤 다시 시도해 주세요.' : ''].filter(Boolean);
  $('provider-issue').textContent = [...new Set(issues)].join(' · ');
  $('provider-issue').hidden = !issues.length;

  const details = $('provider-detail'); details.replaceChildren();
  if (aiStatus.turnError) details.append(el('p', 'help', `요청 오류: ${aiStatus.turnError}`));
  const turnTiming = [Number.isFinite(aiStatus.firstTokenMs) ? `첫 글자 ${(aiStatus.firstTokenMs / 1000).toFixed(1)}초` : '', Number.isFinite(aiStatus.turnElapsedMs ?? aiStatus.elapsedMs) ? `전체 ${((aiStatus.turnElapsedMs ?? aiStatus.elapsedMs) / 1000).toFixed(1)}초` : ''].filter(Boolean);
  if (turnTiming.length) details.append(el('p', 'help', `이번 요청: ${turnTiming.join(' · ')}`));
  for (const [phase, result] of stages) {
    const outcome = result.status === 'success' ? `성공 · ${modelLabel(result)}` : result.status === 'failed' ? `실패${result.model ? ` · ${modelLabel(result)}` : ''}` : result.status === 'rules' ? '앱 규칙으로 처리' : result.status === 'pending' ? '처리 중' : 'AI 호출 생략';
    const firstToken = Number.isFinite(result.firstTokenMs) ? `첫 글자 ${(result.firstTokenMs / 1000).toFixed(1)}초` : '';
    const duration = Number.isFinite(result.elapsedMs) ? `전체 ${(result.elapsedMs / 1000).toFixed(1)}초` : '';
    const finished = result.finishedAt ? new Date(result.finishedAt).toLocaleString('ko-KR') : '';
    details.append(el('p', 'help', [`${stageLabels[phase] || phase}: ${outcome}`, firstToken, duration, finished].filter(Boolean).join(' · ')));
    if (result.retryReason) details.append(el('p', 'help', `${stageLabels[phase] || phase} 재시도 이유: ${result.retryReason}`));
    if (result.error) details.append(el('p', 'help', `${stageLabels[phase] || phase} 오류: ${result.error}`));
  }
  if (!stages.length && aiStatus.error) details.append(el('p', 'help', `오류: ${aiStatus.error}`));
  if (aiStatus.lastSuccess) details.append(el('p', 'help', `마지막 AI 성공: ${new Date(aiStatus.lastSuccess).toLocaleString('ko-KR')}`));
  if (aiStatus.checkedAt) {
    const connection = aiStatus.codex?.available === true ? '사용 가능' : aiStatus.codex?.available === false ? '확인 필요' : '미확인';
    details.append(el('p', 'help', `Codex 연결 점검: ${connection} · ${new Date(aiStatus.checkedAt).toLocaleString('ko-KR')}`));
    if (aiStatus.codex?.model) details.append(el('p', 'help', `앱 대화 모델: ${aiStatus.codex.model}`));
  }
  if (!details.children.length) details.append(el('p', 'help', '실제 응답이 완료되면 사용 모델을 표시합니다.'));
}
function render() {
  portrait.setEnabled(settingsDirty ? $('character-motion').checked : state.settings.characterMotion !== false);
  homePortrait.setEnabled(settingsDirty ? $('character-motion').checked : state.settings.characterMotion !== false);
  portrait.setBusy(Boolean(sending || state.busy));
  renderProviderStatus();
  const missed = $('missed-notifications'); missed.replaceChildren();
  for (const item of state.missedNotifications || []) {
    const card = el('div', 'missed-item'); card.append(el('strong', '', item.title), el('span', '', item.body), el('small', '', new Date(item.created).toLocaleString('ko-KR'))); missed.append(card);
  }
  if (!missed.children.length) missed.append(el('p', 'help', '놓친 알림이 없어요.'));
  $('clear-missed-notifications').disabled = !(state.missedNotifications || []).length;
  renderHome();

  $('memory-count').textContent = state.memories.length;
  $('academic-count').textContent = state.academics.filter(item => !item.completed).length;
  $('routine-count').textContent = state.routines.filter(item => item.days.includes(new Date().getDay() || 7) && !item.completedToday).length;
  if (!settingsDirty) {
  $('name').value = state.settings.name;
  $('teasing').value = state.settings.teasing;
  $('teasing-value').textContent = state.settings.teasing;
  $('character-motion').checked = state.settings.characterMotion !== false;
  $('notifications').checked = state.settings.notifications;
  $('quiet-mode-enabled').checked = state.settings.quietModeEnabled;
  $('notification-volume').value = state.settings.notificationVolume ?? 70;
  $('notification-volume-value').textContent = `${state.settings.notificationVolume ?? 70}%`;
  $('daily-briefing').checked = state.settings.dailyBriefing;
  $('casual-notifications').checked = state.settings.casualNotifications;
  $('game-nagging').checked = state.settings.gameNagging;
  $('game-nag-minutes').value = state.settings.gameNagMinutes;
  $('activity-tracking').checked = state.settings.activityTracking;
  $('break-minutes').value = state.settings.breakMinutes;
  $('health-check-reminder').checked = state.settings.healthCheckReminder;
  $('health-check-usage-minutes').value = state.settings.healthCheckUsageMinutes;
  $('health-check-usage-minutes').disabled = !state.settings.healthCheckReminder;
  $('evening-review').checked = state.settings.eveningReview;
  $('evening-review-usage-minutes').value = state.settings.eveningReviewUsageMinutes;
  $('evening-review-usage-minutes').disabled = !$('evening-review').checked;
  $('quiet-start').value = state.settings.quietStart;
  $('quiet-end').value = state.settings.quietEnd;
  }
  $('usage').textContent = state.usage ? `최근 사용량 ${state.usage.total_tokens ?? '—'} 토큰` : '사용량 집계 없음';
  const next = state.academics.find(item => !item.completed && !item.missing_since && new Date(item.due) > new Date());
  $('chat-next').hidden = !next;
  if (next) { $('chat-next').textContent = `다음 일정 · ${next.title} · ${formatDue(next.due)}`; $('chat-next').onclick = () => editAcademicItem(next); }
  const nextChatSignature = JSON.stringify([state.messages, state.academics, state.cancelledAcademicIds, outgoingText, streamingText, sending, state.busy, state.settings.name]);
  const list = $('messages');
  if (nextChatSignature !== chatSignature) {
  const followLatest = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const previousScroll = list.scrollTop;
  chatSignature = nextChatSignature;
  list.replaceChildren();
  for (const message of state.messages) {
    const card = el('div', `message ${message.role}`);
    card.append(el('div', 'speaker', message.role === 'user' ? state.settings.name || '나' : '아사'), el('div', 'bubble', message.content));
    if (message.role === 'assistant') {
      const action = message.schedule_action;
      if (action?.itemId) {
        const item = [...state.academics, ...(state.endedAcademics || [])].find(value => value.id === action.itemId);
        const cancelled = state.cancelledAcademicIds?.includes(action.itemId);
        const occurrence = action.scope === 'occurrence';
        const occurrenceCancelled = occurrence && item?.exceptions?.some(value => value.original_due === action.original_due && value.cancelled);
        const receipt = el('div', 'schedule-receipt');
        const labels = { update: '일정을 수정했어', restore: '일정을 복구했어', cancel: '일정을 취소했어', existing: '이미 등록한 일정', complete: '완료한 일정' };
        const label = cancelled ? '취소된 일정 · 알림 꺼짐' : !item ? '삭제된 일정' : item.ended ? '반복 종료 · 알림 꺼짐 · 기록 보존' : occurrence ? occurrenceCancelled ? '이번 회차 취소 · 다른 회차 유지' : action.action === 'cancel' ? '회차 취소 해제 · 현재 일정 확인' : `이번 회차만 ${action.action === 'restore' ? '복구' : '수정'} · 다른 회차 유지` : action.action === 'cancel' ? '취소를 되돌린 일정' : item.completed ? '완료한 일정' : labels[action.action] || '일정에 등록했어';
        receipt.append(el('small', '', label), el('strong', '', action.title), el('span', '', formatAcademicDue(action)));
        if (repeats(action)) receipt.append(el('small', '', action.repeat_until ? `${action.repeat_until} 당일까지 반복` : '종료일 없이 반복'));
        if (action.previousUntil !== undefined && action.previousUntil !== action.repeat_until) receipt.append(el('small', '', `이전 종료일: ${action.previousUntil || '없음'}`));
        if (occurrence) receipt.append(el('small', '', `원래 회차: ${formatDue(action.original_due)}`));
        if (['update', 'restore'].includes(action.action)) {
          const before = [action.previousTitle !== action.title ? action.previousTitle : '', action.previousDue !== action.due ? formatDue(action.previousDue) : ''].filter(Boolean).join(' · ');
          if (before) receipt.append(el('small', '', `변경 전: ${before}`));
        }
        const cancelledOccurrence = item?.exceptions?.find(value => value.original_due === action.original_due && value.cancelled);
        const canRestoreOccurrence = occurrenceCancelled && new Date(cancelledOccurrence.due) > new Date() && (!item.repeat_until || action.original_due.slice(0, 10) <= item.repeat_until && cancelledOccurrence.due.slice(0, 10) <= item.repeat_until);
        if ((cancelled && !occurrence || canRestoreOccurrence) && action.action === 'cancel') {
          const restore = el('button', '', '취소 되돌리기');
          restore.onclick = async () => { try { await request('/api/academic/restore', { id: action.itemId, ...(occurrence ? { originalDue: action.original_due } : {}) }); toast(occurrence ? '이번 회차를 복구했어요.' : '일정을 복구했어요.'); } catch (error) { toast(error.message); } };
          const actions = el('div', 'receipt-actions'); actions.append(restore); receipt.append(actions);
        }
        if (item) {
          const actions = el('div', 'receipt-actions');
          const edit = el('button', '', isWidget ? '상세에서 확인' : repeats(item) ? '반복 전체 확인·수정' : '확인·수정'); edit.onclick = () => editAcademicItem(item); actions.append(edit);
          if (action.action === 'add' && !item.completed) {
            const undo = el('button', '', '등록 취소');
            undo.onclick = async () => { if (!await confirmAction(`${item.title} ${repeats(item) ? '반복 전체를 영구 삭제할까요?' : '일정을 삭제할까요?'}`)) return; try { await request('/api/academic/delete', { id: item.id }); } catch (error) { toast(error.message); } };
            actions.append(undo);
          }
          receipt.append(actions);
        }
        card.append(receipt);
      }
      const feedback = el('div', 'feedback');
      for (const [value, label] of [['good', '응답이 좋아요'], ['awkward', '조금 어색해요']]) {
        const button = el('button', message.feedback === value ? 'selected' : '', label);
        button.setAttribute('aria-pressed', String(message.feedback === value));
        button.onclick = async () => {
          const next = message.feedback === value ? '' : value;
          try {
            await request('/api/feedback', { id: message.id, value: next });
            if (next === 'awkward') toast('이 답변과 바로 앞의 메시지는 다음 대화 문맥에서 제외할게요.');
          } catch (e) { toast(e.message); }
        };
        feedback.append(button);
      }
      card.append(feedback);
      if (message.feedback === 'awkward') {
        const reasons = el('div', 'feedback-reasons');
        for (const [reason, label] of [['tone', '상담사 말투'], ['repetition', '반복'], ['character', '말투가 어색함'], ['length', '너무 김'], ['fact', '사실 오류']]) {
          const button = el('button', message.feedback_reason === reason ? 'selected' : '', label);
          button.onclick = async () => { try { await request('/api/feedback', { id: message.id, value: 'awkward', reason }); toast('어색한 이유를 기록했어요.'); } catch (e) { toast(e.message); } };
          reasons.append(button);
        }
        card.append(reasons);
      }
    }
    list.append(card);
  }
  if (outgoingText) {
    const pendingMessage = el('div', 'message user'); pendingMessage.append(el('div', 'speaker', state.settings.name || '나'), el('div', 'bubble', outgoingText)); list.append(pendingMessage);
  }
  appendPendingReply(list);
  list.scrollTop = followLatest ? list.scrollHeight : previousScroll;
  }
  $('send').disabled = sending || state.busy;
  $('chat-status').textContent = sending || state.busy ? '답변 중…' : '';
  $('chat-status').hidden = !sending && !state.busy;
  const memories = $('memories'); memories.replaceChildren();
  if (!state.memories.length) memories.append(el('div', 'empty', '저장된 기억이 없어요.'));
  for (const memory of state.memories) {
    const card = el('article', 'memory-card'); card.append(el('small', '', memory.source === 'conversation' ? '대화에서 기억' : '직접 남긴 기억'), el('p', '', memory.content));
    const actions = el('div', 'memory-actions');
    const edit = el('button', '', '수정'); edit.onclick = () => editMemory(memory);
    const remove = el('button', '', '삭제'); remove.onclick = async () => {
      if (!await confirmAction('이 기억을 삭제할까요? 이전 대화도 더 이상 AI에 보내지 않습니다. 화면의 대화 기록은 남습니다.')) return;
      try { await request('/api/memory/delete', { id: memory.id }); toast('기억을 삭제하고 AI 대화 문맥을 새로 시작했어요.'); } catch (e) { toast(e.message); }
    };
    actions.append(edit, remove); card.append(actions); memories.append(card);
  }
  renderUniversity();
  renderRoutines();
  renderActivity();
  renderHealth();
  renderReview();
}
function formatDue(value) {
  return new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function formatAcademicDue(item) {
  const due = item.series_due || item.due;
  if (!repeats(item) || item.scope === 'occurrence') return formatDue(item.due);
  const type = recurrenceType(item), time = new Intl.DateTimeFormat('ko-KR', { hour: 'numeric', minute: '2-digit' }).format(new Date(due));
  if (type === 'daily') return `매일 ${time}`;
  if (type === 'monthly') return `매달 ${item.monthly_day || new Date(due).getDate()}일 ${time}`;
  return `${type === 'biweekly' ? '격주' : '매주'} ${new Intl.DateTimeFormat('ko-KR', { weekday: 'long' }).format(new Date(due))} ${time}`;
}
function localInputValue(date) {
  const pad = number => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function createAcademicCard(item, now) {
  const overdue = !item.ended && new Date(item.due) < now;
  const card = el('article', `academic-card${item.completed ? ' completed' : ''}${overdue && !item.completed ? ' overdue' : ''}`);
  const toggle = el('button', 'complete-button', item.completed ? '✓' : ''); toggle.title = item.completed ? '미완료로 변경' : '완료로 표시';
  if (repeats(item)) { toggle.textContent = '↻'; toggle.disabled = true; toggle.title = '자동 반복 · 종료하려면 전체 취소'; }
  toggle.setAttribute('aria-label', toggle.title); toggle.onclick = async () => {
    try { await request('/api/academic/toggle', { id: item.id, completed: !item.completed }); } catch (e) { toast(e.message); }
  };
  const copy = el('button', 'academic-copy'); copy.type = 'button'; copy.onclick = () => editAcademicItem(item);
  const top = el('span', 'academic-meta'); top.append(el('span', `kind-badge ${item.kind}`, kindNames[item.kind]));
  if (item.source === 'eclass') top.append(el('span', 'source-badge', 'e-Class'));
  top.append(el('span', overdue ? 'due overdue-text' : 'due', `${overdue ? '지남 · ' : ''}${formatAcademicDue(item)}`));
  if (repeats(item)) top.append(el('span', 'due', item.ended ? '반복 종료 · 알림 꺼짐' : `다음 ${formatDue(item.due)}`));
  if (item.repeat_until) top.append(el('span', 'due', `${item.repeat_until}까지`));
  if (repeats(item) && item.exceptions?.some(value => new Date(value.due) >= now)) top.append(el('span', 'due', '회차별 예외 적용 중 · 대화로 변경'));
  copy.append(top, el('strong', '', item.title));
  if (item.course || item.notes) copy.append(el('span', 'academic-detail', [item.course, item.notes].filter(Boolean).join(' · ')));
  const remove = el('button', 'icon-button', '×'); remove.title = '일정 삭제'; remove.onclick = async () => {
    if (!await confirmAction(`${item.title} ${repeats(item) ? '반복 전체를 영구 삭제할까요?' : '일정을 삭제할까요?'}`)) return;
    try { await request('/api/academic/delete', { id: item.id }); toast('일정을 삭제했어요.'); } catch (e) { toast(e.message); }
  };
  card.append(toggle, copy, remove);
  return card;
}
function createMissingAcademicCard(item) {
  const card = el('article', 'academic-card missing-review');
  const copy = el('div', 'academic-copy');
  const top = el('span', 'academic-meta');
  top.append(el('span', `kind-badge ${item.kind}`, kindNames[item.kind]), el('span', 'source-badge', 'e-Class에서 사라짐'), el('span', 'due', formatDue(item.due)));
  copy.append(top, el('strong', '', item.title), el('span', 'academic-detail', `${item.course ? `${item.course} · ` : ''}제출했는지 확인해 주세요.`));
  const actions = el('div', 'missing-actions');
  const complete = el('button', 'primary', '완료 처리'); complete.type = 'button';
  complete.onclick = async () => { try { await request('/api/eclass/missing-action', { id: item.id, action: 'complete' }); toast(`${item.title}을 완료로 표시했어요.`); } catch (e) { toast(e.message); } };
  const keep = el('button', 'secondary', '계속 관리'); keep.type = 'button';
  keep.onclick = async () => { try { await request('/api/eclass/missing-action', { id: item.id, action: 'keep' }); toast(`${item.title}은 계속 관리할게요.`); } catch (e) { toast(e.message); } };
  actions.append(complete, keep); card.append(copy, actions); return card;
}
function renderUniversity() {
  const now = new Date();
  const today = now.getDay() || 7;
  const weekEnd = new Date(now); weekEnd.setDate(weekEnd.getDate() + 7);
  const open = state.academics.filter(item => !item.completed && !item.missing_since);
  $('today-class-count').textContent = state.classes.filter(item => item.day === today).length;
  $('week-due-count').textContent = open.filter(item => { const due = new Date(item.due); return due >= now && due <= weekEnd; }).length;
  $('overdue-count').textContent = open.filter(item => new Date(item.due) < now).length;
  $('eclass-status').textContent = eclassSyncMessage || (state.eclass?.lastSync
    ? `마지막 동기화 ${new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(state.eclass.lastSync))} · ${state.eclass.received}개 확인${state.eclass.missing ? ` · 완료 확인 ${state.eclass.missing}개` : ''}`
    : 'e-Class 연결 전 · 확장 프로그램 설치 필요');
  $('eclass-sync').disabled = eclassSyncing;
  $('eclass-sync').textContent = eclassSyncing ? '↻ 동기화 중…' : '↻ e-Class 동기화';
  $('briefing-card').hidden = !state.briefing;
  if (state.briefing) {
    $('briefing-title').textContent = state.briefing.title;
    $('briefing-body').textContent = state.briefing.body;
    $('briefing-time').textContent = `${new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(state.briefing.sent))} 작성`;
  }
  const focus = state.reminderControl?.focus;
  const focusActive = focus && new Date(focus.ends) > now;
  $('focus-status').hidden = !focusActive;
  if (focusActive) $('focus-status-text').textContent = `집중 중 · ${focus.title} · ${new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(new Date(focus.ends))}까지`;

  const classList = $('class-list'); classList.replaceChildren();
  if (!state.classes.length) classList.append(el('div', 'empty compact', '등록한 수업이 없어요.'));
  for (let day = 1; day <= 7; day++) {
    const items = state.classes.filter(item => item.day === day);
    if (!items.length) continue;
    const group = el('div', `class-day${day === today ? ' today' : ''}`);
    const label = el('div', 'day-label', `${dayNames[day - 1]}요일`);
    if (day === today) label.append(el('span', 'today-badge', '오늘'));
    const cards = el('div', 'day-classes');
    for (const item of items) {
      const card = el('article', 'class-card');
      const copy = el('button', 'class-copy'); copy.type = 'button'; copy.onclick = () => editClassItem(item);
      copy.append(el('strong', '', item.name), el('span', '', `${item.start}–${item.end}${item.location ? ` · ${item.location}` : ''}`));
      const remove = el('button', 'icon-button', '×'); remove.title = '수업 삭제'; remove.onclick = async () => {
        if (!await confirmAction(`${item.name} 수업을 시간표에서 삭제할까요?`)) return;
        try { await request('/api/class/delete', { id: item.id }); toast('수업을 삭제했어요.'); } catch (e) { toast(e.message); }
      };
      card.append(copy, remove); cards.append(card);
    }
    group.append(label, cards); classList.append(group);
  }

  const missingItems = state.academics.filter(item => !item.completed && item.missing_since);
  const currentItems = state.academics.filter(item => !item.missing_since && new Date(item.due) >= now);
  const pastItems = state.academics.filter(item => !item.missing_since && new Date(item.due) < now);
  const academicList = $('academic-list'); academicList.replaceChildren();
  if (!currentItems.length) academicList.append(el('div', 'empty compact', '예정된 일정이 없어요.'));
  for (const item of currentItems) academicList.append(createAcademicCard(item, now));
  const missingList = $('missing-academic-list'); missingList.replaceChildren();
  $('missing-academic-count').textContent = `${missingItems.length}개`;
  if (!missingItems.length) missingList.append(el('div', 'empty compact', '완료 확인이 필요한 일정이 없어요.'));
  for (const item of missingItems) missingList.append(createMissingAcademicCard(item));
  const pastList = $('past-academic-list'); pastList.replaceChildren();
  $('past-academic-count').textContent = `미완료 ${pastItems.filter(item => !item.completed).length}개`;
  if (!pastItems.length) pastList.append(el('div', 'empty compact', '기한이 지난 일정이 없어요.'));
  for (const item of pastItems) pastList.append(createAcademicCard(item, now));
  endedSection.hidden = !state.endedAcademics?.length; endedList.replaceChildren();
  for (const item of state.endedAcademics || []) endedList.append(createAcademicCard(item, now));
}
function renderRoutines() {
  const today = new Date().getDay() || 7;
  const todayItems = state.routines.filter(item => item.active && item.days.includes(today));
  const completed = todayItems.filter(item => item.completedToday).length;
  $('routine-progress').textContent = `${completed} / ${todayItems.length} 완료`;
  $('routine-progress-bar').max = Math.max(todayItems.length, 1);
  $('routine-progress-bar').value = completed;
  $('routine-today-date').textContent = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
  $('routine-library-count').textContent = `${state.routines.length}개`;
  const todayList = $('today-routines'); todayList.replaceChildren();
  if (!todayItems.length) {
    const empty = el('div', 'life-empty');
    empty.append(el('span', 'life-empty-mark', '✓'), el('strong', '', state.routines.length ? '오늘은 예정된 루틴이 없어요' : '작은 루틴 하나부터'), el('p', '', state.routines.length ? '등록한 루틴은 아래에서 관리할 수 있어요.' : '식사, 운동처럼 반복할 일을 추가해 보세요.'));
    todayList.append(empty);
  }
  for (const item of todayItems) {
    const card = el('article', `routine-card${item.completedToday ? ' completed' : ''}`);
    const toggle = el('button', 'complete-button', item.completedToday ? '✓' : '');
    toggle.title = item.completedToday ? '오늘 완료 취소' : '오늘 완료';
    toggle.setAttribute('aria-label', `${item.title} ${toggle.title}`);
    toggle.setAttribute('aria-pressed', String(Boolean(item.completedToday)));
    toggle.onclick = async () => { try { await request('/api/routine/toggle', { id: item.id, completed: !Boolean(item.completedToday) }); } catch (e) { toast(e.message); } };
    const copy = el('div', 'routine-copy'); copy.append(el('strong', '', item.title), el('span', '', `${routineCategoryNames[item.category] || '기타'}${item.notes ? ` · ${item.notes}` : ''}`));
    card.append(toggle, copy, el('time', 'life-routine-time', item.time)); todayList.append(card);
  }
  const all = $('all-routines'); all.replaceChildren();
  if (!state.routines.length) all.append(el('div', 'empty compact', '등록한 루틴이 없어요.'));
  for (const item of state.routines) {
    const card = el('article', 'routine-card');
    const copy = el('button', 'routine-copy editable'); copy.type = 'button'; copy.onclick = () => editRoutineItem(item);
    copy.append(el('strong', '', item.title), el('span', '', `${item.time} · ${routineCategoryNames[item.category]} · ${item.days.map(day => dayNames[day - 1]).join('·')}`));
    const remove = el('button', 'icon-button', '×'); remove.title = '루틴 삭제'; remove.onclick = async () => {
      if (!await confirmAction(`${item.title} 루틴과 완료 기록을 삭제할까요?`)) return;
      try { await request('/api/routine/delete', { id: item.id }); toast('루틴을 삭제했어요.'); } catch (e) { toast(e.message); }
    };
    card.append(copy, remove); all.append(card);
  }
}
function formatDuration(seconds) {
  const minutes = Math.round((seconds || 0) / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`;
}
function renderActivity() {
  const activity = state.activity || { totalSeconds: 0, categories: {}, apps: [] };
  const duration = seconds => seconds > 0 && seconds < 60 ? '1분 미만' : formatDuration(seconds).replace('시간 0분', '시간');
  $('activity-date').textContent = new Date((activity.date || dateKey()) + 'T12:00').toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }) + ' · 오늘 사용한 시간';
  $('activity-total').textContent = activity.totalSeconds > 0 ? duration(activity.totalSeconds) : '—';
  const categories = $('activity-categories'); categories.replaceChildren();
  for (const [category, label] of Object.entries(activityCategoryNames)) {
    const seconds = activity.categories[category];
    if (!(seconds > 0)) continue;
    const item = el('div', 'activity-category'); item.dataset.category = category;
    item.append(el('dt', '', label), el('dd', '', duration(seconds))); categories.append(item);
  }
  categories.hidden = !categories.childElementCount;
  const status = $('activity-status');
  const current = state.currentActivity;
  const fresh = current?.checkedAt && Math.abs(Date.now() - new Date(current.checkedAt)) < 90_000;
  const measuring = state.settings.activityTracking && fresh && current.track;
  const statusText = !state.settings.activityTracking ? '측정 꺼짐' : !current ? '측정 준비 중' : !fresh ? '측정 확인 중' : measuring ? '측정 중' : '측정 대기';
  status.dataset.state = measuring ? 'active' : 'idle';
  if (status.textContent !== statusText) status.textContent = statusText;
  const list = $('activity-apps'), more = $('activity-more-apps'); list.replaceChildren(); more.replaceChildren();
  const apps = activity.apps.filter(item => item.seconds > 0);
  $('activity-app-count').textContent = apps.length ? `${apps.length}개 · 많이 사용한 순` : '오늘 기록';
  if (!apps.length) {
    const empty = el('div', 'activity-empty');
    empty.append(el('strong', '', '아직 기록된 사용 시간이 없어요.'), el('p', '', state.settings.activityTracking ? '앱을 사용하면 여기에 차곡차곡 모여요.' : '측정 설정에서 켜면 사용 시간을 모을 수 있어요.'));
    list.append(empty);
  }
  for (const [index, item] of apps.entries()) {
    const row = el('article', 'activity-row');
    const copy = el('div', 'activity-app-copy'); copy.append(el('strong', '', item.app), el('span', '', activityCategoryNames[item.category] || '기타'));
    row.append(el('span', 'activity-rank', String(index + 1).padStart(2, '0')), copy, el('b', 'activity-duration', duration(item.seconds)));
    (index < 5 ? list : more).append(row);
  }
  $('activity-more').hidden = apps.length <= 5;
  $('activity-more-label').textContent = `나머지 ${Math.max(0, apps.length - 5)}개 앱 보기`;
}
function dateKey(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
let healthDirty = false;
function healthEntry(date) { return (state.healthRecent || state.healthWeek).find(item => item.date === date); }
function loadHealthForm(date) {
  healthDirty = false;
  const entry = healthEntry(date);
  $('health-date').value = date;
  $('health-sleep').value = entry ? entry.sleep_minutes / 60 : 7;
  $('health-meals').value = entry?.meals ?? 3;
  $('health-water').value = entry?.water ?? 6;
  $('health-exercise').value = entry?.exercise_minutes ?? 0;
  $('health-energy').value = entry?.energy ?? 3;
  renderHealthEnergy();
  $('health-note').value = entry?.note || '';
  renderHealthRecordStatus();
}
function renderHealthEnergy() {
  const value = Number($('health-energy').value);
  $('health-energy-value').textContent = `${value} / 5 · ${['많이 피곤함', '조금 피곤함', '보통', '괜찮음', '가뿐함'][value - 1]}`;
}
function renderHealthRecordStatus() {
  $('health-record-status').textContent = healthDirty ? '저장 전' : healthEntry($('health-date').value) ? '기록 완료' : '새 기록';
}
function renderHealth() {
  const entries = state.healthWeek || [];
  const average = key => entries.length ? Math.round(entries.reduce((sum, item) => sum + item[key], 0) / entries.length) : null;
  const sleep = average('sleep_minutes');
  $('health-sleep-average').textContent = sleep === null ? '—' : `${Math.floor(sleep / 60)}시간 ${sleep % 60}분`;
  const meals = average('meals'), exercise = average('exercise_minutes'), energy = average('energy');
  $('health-meal-average').textContent = meals === null ? '—' : `${meals}회`;
  $('health-exercise-average').textContent = exercise === null ? '—' : `${exercise}분`;
  $('health-energy-average').textContent = energy === null ? '—' : `${energy} / 5`;
  $('health-record-count').textContent = `${entries.length}일 기록`;
  const list = $('health-week-list'); list.replaceChildren();
  if (!entries.length) list.append(el('div', 'empty compact', '첫 기록을 남기면 여기에 차곡차곡 모여요.'));
  for (const item of entries) {
    const button = el('button', 'health-day'); button.type = 'button';
    button.onclick = () => { loadHealthForm(item.date); $('health-form').scrollIntoView({ block: 'nearest' }); $('health-date').focus({ preventScroll: true }); };
    button.append(el('strong', '', new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', weekday: 'short' }).format(new Date(`${item.date}T00:00:00`))), el('span', '', `수면 ${(item.sleep_minutes / 60).toFixed(1)}시간 · 식사 ${item.meals}회 · 운동 ${item.exercise_minutes}분`), el('b', '', `컨디션 ${item.energy}/5`));
    list.append(button);
  }
  if (!$('health-date').value) {
    const today = new Date(); const oldest = new Date(today); oldest.setDate(oldest.getDate() - 90);
    $('health-date').max = dateKey(today); $('health-date').min = dateKey(oldest); loadHealthForm(dateKey(today));
  }
  renderHealthRecordStatus();
}
function renderReview() {
  const review = state.eveningReview;
  if (!review) return;
  $('review-date').textContent = new Date(review.date + 'T12:00').toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }) + ' · 남긴 기록과 내일 일정';
  const highlights = $('review-highlights'); highlights.replaceChildren();
  for (const item of review.highlights) {
    const stat = el('div', 'review-stat'); stat.append(el('dt', '', item.label), el('dd', '', item.value)); highlights.append(stat);
  }
  highlights.hidden = review.highlights.length === 0;
  $('review-empty').hidden = review.highlights.length > 0;
  document.querySelector('.review-overview h2').textContent = review.highlights.length ? '오늘은 이만큼 남겼어.' : '차곡차곡 모일 하루의 기록';
  $('review-upcoming').hidden = !review.priority;
  $('review-next-title').textContent = review.priority?.title || '';
  $('review-next-action').textContent = review.nextDetail;
  $('review-tomorrow').hidden = review.tomorrowClasses.length === 0;
  $('review-class-count').textContent = `${review.tomorrowClasses.length}개`;
  const list = $('review-tomorrow-list'); list.replaceChildren();
  for (const item of review.tomorrowClasses) {
    const card = el('article', 'review-class');
    const copy = el('div', 'routine-copy'); copy.append(el('strong', '', item.name), el('span', '', `${item.end}까지${item.location ? ` · ${item.location}` : ''}`));
    card.append(el('span', 'review-class-time', item.start), copy); list.append(card);
  }
}
async function refreshState() {
  if (!token || pendingChanges) return;
  const epoch = ++refreshEpoch;
  try {
    const response = await fetch('/api/state', { headers: { 'X-Rin-Token': token } });
    if (!response.ok) return;
    const result = await response.json();
    if (epoch !== refreshEpoch || pendingChanges) return;
    const previousSync = state.eclass?.lastSync;
    // Chat rendering never replaces the composer; focused chat must still receive the other window's updates.
    if (document.querySelector('dialog[open]') || document.body.dataset.view !== 'chat' && document.activeElement?.closest('.content input, .content textarea, .content select, .content button')) return;
    state = result; render();
    if (state.eclass?.lastSync && state.eclass.lastSync !== previousSync) toast(`e-Class 일정 ${state.eclass.received}개를 동기화했어요.`);
  } catch {}
}
function editMemory(memory) { editingMemory = memory?.id || null; $('memory-title').textContent = memory ? '기억 수정하기' : '기억 남기기'; $('memory-content').value = memory?.content || ''; $('memory-dialog').showModal(); $('memory-content').focus(); }
function editClassItem(item) {
  editingClass = item?.id || null; $('class-title').textContent = item ? '수업 수정' : '수업 추가';
  $('class-name').value = item?.name || ''; $('class-day').value = item?.day || 1; $('class-start').value = item?.start || '09:00'; $('class-end').value = item?.end || '10:30'; $('class-location').value = item?.location || '';
  $('class-dialog').showModal(); $('class-name').focus();
}
function editAcademicItem(item) {
  if (isWidget) { void openDetails('university'); return; }
  editingAcademic = item?.id || null; $('academic-title').textContent = item ? '과제·시험 수정' : '과제·시험 추가';
  $('academic-kind').value = item?.kind || 'assignment'; $('academic-course').value = item?.course || ''; $('academic-name').value = item?.title || '';
  const defaultDue = new Date(); defaultDue.setDate(defaultDue.getDate() + 1); defaultDue.setHours(23, 59, 0, 0);
  $('academic-due').value = item?.next_regular_due || item?.due || localInputValue(defaultDue); $('academic-notes').value = item?.notes || '';
  $('academic-repeat').value = recurrenceType(item);
  $('academic-month-day').value = item?.monthly_day || new Date($('academic-due').value).getDate(); showMonthDay();
  $('academic-repeat-until').value = item?.repeat_until || '';
  $('academic-dialog').showModal(); $('academic-name').focus();
}
function editRoutineItem(item) {
  editingRoutine = item?.id || null; $('routine-title').textContent = item ? '루틴 수정' : '루틴 추가';
  $('routine-name').value = item?.title || ''; $('routine-category').value = item?.category || 'exercise'; $('routine-time').value = item?.time || '20:00'; $('routine-notes').value = item?.notes || '';
  document.querySelectorAll('input[name="routine-day"]').forEach(input => { input.checked = item ? item.days.includes(Number(input.value)) : Number(input.value) <= 5; });
  $('routine-dialog').showModal(); $('routine-name').focus();
}
async function requestEclassSync() {
  if (window.rinDesktop) {
    const previous = state.eclass?.lastSync;
    await window.rinDesktop.openEclass();
    toast('학교 페이지를 열었어요. 로그인하면 설치된 e-Class 확장 프로그램이 일정을 가져옵니다.');
    const until = Date.now() + 90000;
    while (Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const response = await fetch('/api/state', { headers: { 'X-Rin-Token': token } });
      if (!response.ok) continue;
      const latest = await response.json();
      if (latest.eclass?.lastSync && latest.eclass.lastSync !== previous) {
        state = latest; render();
        return { ok: true, desktop: true, received: latest.eclass.received || 0, missing: latest.eclass.missing || 0 };
      }
    }
    return { ok: false, message: '아직 새 일정이 도착하지 않았어요. Chrome의 e-Class 로그인과 e-Class 확장 프로그램을 확인해 주세요.' };
  }
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    let accepted = false;
    const cleanup = () => { clearTimeout(connectTimer); clearTimeout(resultTimer); window.removeEventListener('message', receive); };
    const connectTimer = setTimeout(() => {
      if (accepted) return;
      cleanup();
      const error = new Error('아사 e-Class Sync 확장 프로그램을 다시 로드해 주세요.');
      error.code = 'extension-missing'; reject(error);
    }, 1500);
    const resultTimer = setTimeout(() => {
      cleanup(); reject(new Error('e-Class 응답이 늦어지고 있어요. 잠시 후 다시 눌러 주세요.'));
    }, 30000);
    const receive = event => {
      if (event.source !== window || event.origin !== location.origin || event.data?.requestId !== requestId) return;
      if (event.data.type === 'RIN_ECLASS_SYNC_ACCEPTED') { accepted = true; clearTimeout(connectTimer); return; }
      if (event.data.type !== 'RIN_ECLASS_SYNC_RESULT') return;
      cleanup(); resolve(event.data.result || { ok: false, message: '확장 프로그램의 응답이 비어 있어요.' });
    };
    window.addEventListener('message', receive);
    window.postMessage({ type: 'RIN_ECLASS_SYNC_REQUEST', requestId }, location.origin);
  });
}
document.querySelectorAll('button[data-view], a[data-view]').forEach(button => button.onclick = event => { event.preventDefault(); view(button.dataset.view); });
$('view-settings').addEventListener('input', () => { settingsDirty = true; });
$('view-settings').addEventListener('change', () => { settingsDirty = true; });
document.querySelectorAll('.nav > span:first-child').forEach(icon => icon.setAttribute('aria-hidden', 'true'));
document.querySelectorAll('dialog').forEach(dialog => {
  const heading = dialog.querySelector('h2');
  if (!heading.id) heading.id = `${dialog.id}-title`;
  dialog.setAttribute('aria-labelledby', heading.id);
});
$('confirm-dialog').setAttribute('aria-describedby', 'confirm-description');
window.addEventListener('hashchange', () => view(location.hash.slice(1) || 'chat'));
$('open-chat-menu').onclick = () => $('chat-menu').showModal();
$('close-chat-menu').onclick = () => $('chat-menu').close();
$('clear-missed-notifications').onclick = async () => { if (!await confirmAction('놓친 알림 목록을 비울까요? 일정과 알림 설정은 유지됩니다.')) return; try { await request('/api/missed-notifications/clear', {}); toast('놓친 알림 목록을 비웠어요.'); } catch (e) { toast(e.message); } };
$('chat-form').onsubmit = async event => {
  event.preventDefault(); if (sending || !state || state.busy) return;
  const text = $('message').value.trim(); if (!text) return;
  sending = true; outgoingText = text; streamingText = ''; $('message').readOnly = true; $('chat-error').hidden = true; render(); $('messages').scrollTop = $('messages').scrollHeight;
  let replied = false;
  try { await request('/api/chat', { text }); $('message').value = ''; saveDraft(); replied = true; }
  catch (e) { $('chat-error').textContent = e.message; $('chat-error').hidden = false; }
  finally {
    sending = false; outgoingText = ''; streamingText = ''; $('message').readOnly = false; render();
    const greeting = /^(?:아사야?[,\s]*|너\s+)?(?:안녕|좋은 아침|고마워|고마워요)[.!?~\s]*$/u.test(text);
    if (replied && greeting) portrait.reply();
    $('message').focus();
    if (!replied) void refreshState();
  }
};
$('message').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); $('chat-form').requestSubmit(); } };
$('preferences-form').onsubmit = async event => {
  event.preventDefault(); try { await request('/api/settings', { ...state.settings, notificationVolume: Number($('notification-volume').value), name: $('name').value, characterMotion: $('character-motion').checked, teasing: Number($('teasing').value), notifications: $('notifications').checked, quietModeEnabled: $('quiet-mode-enabled').checked, dailyBriefing: $('daily-briefing').checked, casualNotifications: $('casual-notifications').checked, gameNagging: $('game-nagging').checked, gameNagMinutes: Number($('game-nag-minutes').value), activityTracking: $('activity-tracking').checked, breakMinutes: Number($('break-minutes').value), healthCheckReminder: $('health-check-reminder').checked, healthCheckUsageMinutes: Number($('health-check-usage-minutes').value), eveningReview: $('evening-review').checked, eveningReviewUsageMinutes: Number($('evening-review-usage-minutes').value), quietStart: $('quiet-start').value, quietEnd: $('quiet-end').value }); toast('설정을 저장했어요. 대화와 알림에 반영됩니다.'); } catch (e) { toast(e.message); }
};
$('notification-volume').oninput = () => $('notification-volume-value').textContent = `${$('notification-volume').value}%`;
$('health-check-reminder').onchange = () => { $('health-check-usage-minutes').disabled = !$('health-check-reminder').checked; };
$('evening-review').onchange = () => { $('evening-review-usage-minutes').disabled = !$('evening-review').checked; };
$('health-energy').oninput = renderHealthEnergy;
$('health-date').onchange = () => loadHealthForm($('health-date').value);
$('health-today').onclick = () => loadHealthForm(dateKey(new Date()));
$('health-form').oninput = event => { if (event.target.id !== 'health-date') { healthDirty = true; renderHealthRecordStatus(); } };
$('health-form').onsubmit = async event => { event.preventDefault(); try { await request('/api/health', { date: $('health-date').value, sleepMinutes: Math.round(Number($('health-sleep').value) * 60), meals: Number($('health-meals').value), water: Number($('health-water').value), exerciseMinutes: Number($('health-exercise').value), energy: Number($('health-energy').value), note: $('health-note').value }); healthDirty = false; renderHealthRecordStatus(); toast('생활 기록을 저장했어요.'); } catch (e) { toast(e.message); } };
$('teasing').oninput = () => $('teasing-value').textContent = $('teasing').value;
$('character-motion').onchange = () => {
  portrait.setEnabled($('character-motion').checked);
  homePortrait.setEnabled($('character-motion').checked);
};
$('add-memory').onclick = () => editMemory();
$('cancel-memory').onclick = () => $('memory-dialog').close();
$('memory-form').onsubmit = async event => { event.preventDefault(); try { await request('/api/memory', { id: editingMemory, content: $('memory-content').value }); $('memory-dialog').close(); toast('기억을 저장했어요. 다음 대화부터 새 기억을 사용합니다.'); } catch (e) { toast(e.message); } };
$('add-class').onclick = $('add-class-empty').onclick = () => editClassItem();
$('cancel-class').onclick = () => $('class-dialog').close();
$('class-form').onsubmit = async event => { event.preventDefault(); try { await request('/api/class', { id: editingClass, name: $('class-name').value, day: Number($('class-day').value), start: $('class-start').value, end: $('class-end').value, location: $('class-location').value }); $('class-dialog').close(); toast('시간표에 수업을 저장했어요.'); } catch (e) { toast(e.message); } };
$('add-academic').onclick = $('add-academic-empty').onclick = () => editAcademicItem();
$('cancel-academic').onclick = () => $('academic-dialog').close();
$('academic-form').onsubmit = async event => { event.preventDefault(); try { await request('/api/academic', { id: editingAcademic, title: $('academic-name').value, course: $('academic-course').value, kind: $('academic-kind').value, due: $('academic-due').value, notes: $('academic-notes').value, recurrence: $('academic-repeat').value, monthlyDay: $('academic-repeat').value === 'monthly' ? Number($('academic-month-day').value) : 0, repeatUntil: $('academic-repeat').value !== 'none' ? $('academic-repeat-until').value || null : null }); $('academic-dialog').close(); toast('학업 일정을 저장했어요.'); } catch (e) { toast(e.message); } };
$('add-routine').onclick = $('add-routine-empty').onclick = () => editRoutineItem();
$('cancel-routine').onclick = () => $('routine-dialog').close();
$('routine-form').onsubmit = async event => { event.preventDefault(); try { const days = [...document.querySelectorAll('input[name="routine-day"]:checked')].map(input => Number(input.value)); await request('/api/routine', { id: editingRoutine, title: $('routine-name').value, category: $('routine-category').value, time: $('routine-time').value, days, notes: $('routine-notes').value }); $('routine-dialog').close(); toast('생활 루틴을 저장했어요.'); } catch (e) { toast(e.message); } };
$('eclass-sync').onclick = async () => {
  if (eclassSyncing) return;
  eclassSyncing = true; eclassSyncMessage = 'e-Class 메인 화면에서 Todo를 확인하는 중…'; renderUniversity();
  try {
    const result = await requestEclassSync();
    if (!result.ok) {
      eclassSyncMessage = result.message || 'e-Class 동기화에 실패했어요.';
      toast(eclassSyncMessage); return;
    }
    await refreshState();
    eclassSyncMessage = '';
    const skipped = result.skipped ? ` · 형식을 읽지 못한 항목 ${result.skipped}개` : '';
    const missing = result.missing ? ` · 완료 확인 ${result.missing}개` : '';
    toast(result.desktop ? `e-Class 일정 ${result.received}개 동기화 확인${missing}` : `e-Class 일정 ${result.received}개 확인 · 새로 추가 ${result.added}개 · 갱신 ${result.updated}개${missing}${skipped}`);
  } catch (error) {
    eclassSyncMessage = error.message; toast(error.message);
    if (error.code === 'extension-missing') $('eclass-dialog').showModal();
  } finally { eclassSyncing = false; renderUniversity(); }
};
$('close-eclass-dialog').onclick = () => $('eclass-dialog').close();
$('copy-extension-path').onclick = async () => {
  try { await navigator.clipboard.writeText($('extension-path').textContent); toast('확장 프로그램 폴더 경로를 복사했어요.'); }
  catch { toast('경로를 선택해 직접 복사해 주세요.'); }
};
$('clear-chat').onclick = async () => { $('chat-menu').close(); if (!await confirmAction('이 컴퓨터에 저장된 대화와 답변 평가를 모두 지울까요? 등록한 기억과 일정은 유지됩니다.')) return; try { await request('/api/messages/clear', {}); toast('대화 기록을 지웠어요.'); } catch (e) { toast(e.message); } };
$('date').textContent = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
try { const response = await fetch('/api/session'); if (!response.ok) throw new Error(); const result = await response.json(); token = result.token; state = result; render(); const initial = location.hash.slice(1); view(isWidget ? 'chat' : initial === 'health' || $(`view-${initial}`) ? initial : 'home', false); }
catch { toast('로컬 앱에 연결하지 못했어요. 실행 상태를 확인하고 새로고침해 주세요.'); $('send').disabled = true; }
setInterval(refreshState, 5000);
window.addEventListener('focus', refreshState);
changes?.addEventListener('message', event => { if (event.data === 'refresh') void refreshState(); });
window.addEventListener('storage', event => {
  if (event.key === 'seoa-portrait-scene') portrait.setScene(event.newValue || 'studio');
});
