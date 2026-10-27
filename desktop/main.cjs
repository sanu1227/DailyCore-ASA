const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, protocol, shell, dialog, screen } = require('electron');
const { spawn } = require('node:child_process');
const { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, appendFileSync, unlinkSync } = require('node:fs');
const { join, dirname, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const { viewFromArguments, validView, surfaceForView, isAppUrl, isAllowedExternal, validBounds, notificationDisplayId, notificationArtPool, chooseNotificationArt } = require('./policy.cjs');
const { notificationVoiceCategory } = require('../app/notification-voice.cjs');
const { listBackups, restoreBackup, rollbackRestore } = require('./backup.cjs');
const { notificationBounds, notificationDuration, notificationHtml, NOTIFICATION_GAP, NOTIFICATION_SOUND_GAP } = require('./notification.cjs');

const root = resolve(__dirname, '..');
const smoke = process.argv.includes('--smoke-test');
const smokeSurfacesOnly = smoke && process.argv.includes('--smoke-surfaces-only');
const notificationPreview = process.argv.includes('--notification-preview');
const smokeReport = process.argv.find(value => value.startsWith('--smoke-report='))?.slice(15);
const smokeScreenshot = process.argv.find(value => value.startsWith('--smoke-screenshot='))?.slice(19);
const smokeWallpaper = smoke && process.argv.find(value => value.startsWith('--smoke-wallpaper='))?.slice(18);
// Keep existing Electron settings and sessions when changing the visible name.
app.setPath('userData', smoke || notificationPreview
  ? mkdtempSync(join(tmpdir(), notificationPreview ? 'rin-notification-preview-' : 'rin-desktop-smoke-'))
  : join(app.getPath('appData'), 'RIN'));
// Keep Chromium's generated User-Agent ASCII; visible window titles carry the Korean name.
app.setName('ASA');
app.setAppUserModelId('local.rin.companion');
protocol.registerSchemesAsPrivileged([{ scheme: 'rin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const ownsLock = app.requestSingleInstanceLock();
if (!ownsLock) app.quit();
let window, widget, tray, backend, baseUrl, quitting = false, startingView = viewFromArguments(process.argv);
let windowState = {}, surfacesReady = false;
let backendRestartTimer = null, backendRestartAttempts = 0;
let backendLegacyRoot = null, backendMaintenance = false;
let notificationWindow = null, notificationTimer = null;
let activeNotification = null, nextNotificationTimer = null, lastNotificationSound = -Infinity;
const notificationActions = new Map();
let notificationSoundProcess = null;
let lastNotificationArt = null;
const notificationArtHistory = new Map();
const notificationQueue = [];
let dataPath, logPath, windowStatePath;
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } };
function log(message) { if (logPath) appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`); }
function playNotificationSound(sound = 'soft', volume = 70) {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'Play-RinSound.ps1'), sound, '-Volume', String(volume)], { cwd: root, windowsHide: true, stdio: 'ignore' });
  notificationSoundProcess = child;
  child.once('error', error => log(`Notification sound failed: ${error.message}`));
  child.once('exit', () => { if (notificationSoundProcess === child) notificationSoundProcess = null; });
}
function startupShortcutPaths() {
  const startup = join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  return {
    current: join(startup, 'Baek SeoA Background.lnk'),
    legacyBackground: join(startup, 'RIN Background.lnk'),
    legacy: join(startup, 'Rin Daily Sync.lnk')
  };
}
function startupStatus() {
  const paths = startupShortcutPaths();
  return { enabled: Object.values(paths).some(path => existsSync(path)) };
}
function setStartup(enabled) {
  const paths = startupShortcutPaths();
  if (enabled) {
    mkdirSync(dirname(paths.current), { recursive: true });
    const written = shell.writeShortcutLink(paths.current, 'create', {
      target: process.execPath,
      args: '--background',
      cwd: dirname(process.execPath),
      description: 'Windows 로그인 시 아사 알림을 백그라운드에서 시작합니다.',
      icon: process.execPath,
      iconIndex: 0
    });
    if (!written) throw new Error('Windows 자동 시작 바로가기를 만들지 못했어요.');
    for (const path of [paths.legacyBackground, paths.legacy]) if (existsSync(path)) unlinkSync(path);
  } else {
    for (const path of Object.values(paths)) if (existsSync(path)) unlinkSync(path);
  }
  return startupStatus();
}
function show(view = startingView) {
  if (!validView(view)) view = 'chat';
  if (!surfacesReady) { startingView = view; return false; }
  return showSurface(surfaceForView(view), view);
}
function showSurface(surface, view = surface === 'widget' ? 'chat' : 'home') {
  const target = surface === 'widget' ? widget : window;
  if (!target || target.isDestroyed()) { startingView = view; return false; }
  if (target.isMinimized()) target.restore();
  // Hash navigation keeps each renderer and its unsent conversation draft alive.
  if (target.webContents.getURL() && new URL(target.webContents.getURL()).hash !== `#${view}`) {
    target.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#${view}`)}`).catch(error => log(error.message));
  }
  target.show();
  // Windows may apply a hidden launcher's STARTUPINFO to the first native ShowWindow call.
  if (!target.isVisible()) target.showInactive();
  if (target.isVisible()) target.focus();
  return target.isVisible();
}
function keepWidgetVisible() {
  if (quitting || !surfacesReady || !widget || widget.isDestroyed()) return;
  if (widget.isMinimized()) widget.restore();
  if (!widget.isVisible()) widget.showInactive();
  // Hidden Windows launchers can consume the first ShowWindow call.
  if (!widget.isVisible()) widget.showInactive();
}
function startSurfaces(args = process.argv, view = startingView) {
  keepWidgetVisible();
  if (!args.includes('--background')) show(view);
}
function reloadSurfaces() {
  for (const target of [window, widget]) if (target && !target.isDestroyed()) target.webContents.reload();
}
function notificationView(key = '') {
  if (key.startsWith('evening-review:')) return 'review';
  if (key.startsWith('academic:') || key.startsWith('class:') || key.startsWith('event:') || key.startsWith('briefing:') || key.startsWith('deadline-')) return 'university';
  if (key.startsWith('routine:') || key.startsWith('focus-end:')) return 'routines';
  if (key.startsWith('health-check:')) return 'health';
  return 'chat';
}
function detectForegroundGame() {
  return new Promise(resolveDetection => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'Get-RinForegroundGame.ps1')], { cwd: root, windowsHide: true });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.once('error', () => resolveDetection({ isGame: false }));
    child.once('close', code => {
      if (code !== 0) return resolveDetection({ isGame: false });
      try { resolveDetection(JSON.parse(output.trim())); } catch { resolveDetection({ isGame: false }); }
    });
  });
}
function showNextNotification() {
  if (notificationWindow || nextNotificationTimer || !notificationQueue.length || quitting) return;
  const candidate = notificationQueue.shift();
  activeNotification = candidate;
  const cursorDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const displays = screen.getAllDisplays().map(item => ({ id: item.id, bounds: item.bounds, primary: item.id === screen.getPrimaryDisplay().id }));
  const displayId = notificationDisplayId(displays, cursorDisplay.id);
  const display = screen.getAllDisplays().find(item => item.id === displayId) || cursorDisplay;
  const artPool = notificationArtPool(candidate);
  let usedArt = notificationArtHistory.get(artPool);
  if (!usedArt || usedArt.size === artPool.length) { usedArt = new Set(); notificationArtHistory.set(artPool, usedArt); }
  const selectedArt = chooseNotificationArt(candidate, lastNotificationArt, Math.random, usedArt);
  usedArt.add(selectedArt); lastNotificationArt = selectedArt;
  const artPath = join(root, 'public/assets', selectedArt);
  const iconUrl = pathToFileURL(existsSync(artPath) ? artPath : join(root, 'public/assets/asa/portrait.jpg')).href;
  const duration = notificationDuration(candidate);
  const notificationHtmlPath = join(app.getPath('userData'), 'notification-' + process.pid + '-' + Date.now() + '.html');
  writeFileSync(notificationHtmlPath, notificationHtml(candidate, iconUrl, duration, notificationQueue.length), 'utf8');
  const target = new BrowserWindow({
    ...notificationBounds(display.workArea), title: '아사 알림', show: false, frame: false,
    backgroundColor: '#1d2527', resizable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: true, roundedCorners: true, hasShadow: true,
    webPreferences: { preload: join(__dirname, 'notification-preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: smoke }
  });
  notificationWindow = target;
  target.setAlwaysOnTop(true, 'pop-up-menu');
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', event => event.preventDefault());
  let revealed = false, hovered = false, paused = false, remaining = duration, started = 0;
  const trustedNotification = event => !target.isDestroyed() && event.sender === target.webContents && event.senderFrame === target.webContents.mainFrame && event.senderFrame.url === pathToFileURL(notificationHtmlPath).href;
  const updateTimer = () => {
    if (!revealed || target.isDestroyed()) return;
    if (started) remaining = Math.max(0, remaining - (Date.now() - started));
    clearTimeout(notificationTimer); started = 0;
    paused = hovered || target.isFocused();
    if (!paused) { started = Date.now(); notificationTimer = setTimeout(() => target.close(), remaining); }
    target.webContents.send('rin:notification-lifetime', paused);
  };
  const hover = (event, value) => {
    if (!trustedNotification(event) || typeof value !== 'boolean') return;
    hovered = value; updateTimer();
  };
  ipcMain.on('rin:notification-hover', hover);
  target.on('focus', updateTimer); target.on('blur', updateTimer);
  const revealNotification = () => {
    if (revealed || target.isDestroyed()) return;
    revealed = true; target.showInactive();
    if ((candidate.volume ?? 70) > 0 && Date.now() - lastNotificationSound >= NOTIFICATION_SOUND_GAP) {
      playNotificationSound(notificationVoiceCategory(candidate), candidate.volume ?? 70);
      lastNotificationSound = Date.now();
    }
    updateTimer();
    const bounds = target.getBounds();
    log('Notification ' + candidate.key + ' shown at ' + JSON.stringify(bounds) + '; art=' + selectedArt);
  };
  target.once('ready-to-show', revealNotification);
  target.webContents.once('did-finish-load', revealNotification);
  target.on('closed', () => {
    notificationWindow = null; activeNotification = null;
    clearTimeout(notificationTimer); notificationTimer = null;
    ipcMain.removeListener('rin:notification-hover', hover);
    try { unlinkSync(notificationHtmlPath); } catch {}
    if (!quitting) nextNotificationTimer = setTimeout(() => { nextNotificationTimer = null; showNextNotification(); }, NOTIFICATION_GAP);
  });
  void target.loadFile(notificationHtmlPath).catch(error => {
    log('Notification load failed: ' + error.message);
    if (backend?.connected) backend.send({ type: 'notification-suppressed', candidate });
    if (!target.isDestroyed()) target.close();
  });
}
async function displayNotification(candidate) {
  if (!candidate || typeof candidate.key !== 'string' || !candidate.key) throw new Error('Invalid notification');
  if (activeNotification?.key === candidate.key) return;
  const existing = notificationQueue.findIndex(item => item.key === candidate.key);
  if (existing >= 0) notificationQueue[existing] = candidate;
  else notificationQueue.push(candidate);
  if (notificationWindow && !notificationWindow.isDestroyed()) notificationWindow.webContents.send('rin:notification-pending', notificationQueue.length);
  showNextNotification();
}
function snoozeDesktopNotification(candidate) {
  if (!backend?.connected) return Promise.reject(new Error('Notification backend unavailable'));
  return new Promise((resolveAction, reject) => {
    const id = require('node:crypto').randomUUID();
    const timeout = setTimeout(() => { notificationActions.delete(id); reject(new Error('Notification action timed out')); }, 5000);
    notificationActions.set(id, { resolve: resolveAction, reject, timeout });
    backend.send({ type: 'notification-snooze', id, candidate }, error => {
      if (!error) return;
      clearTimeout(timeout); notificationActions.delete(id); reject(error);
    });
  });
}
ipcMain.handle('rin:notification-action', async (event, action) => {
  const target = notificationWindow, candidate = activeNotification;
  if (!target || target.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame || !['open', 'dismiss', 'snooze'].includes(action)) throw new Error('Not allowed');
  if (action === 'snooze') await snoozeDesktopNotification(candidate);
  if (action === 'open') show(notificationView(candidate.key));
  if (!target.isDestroyed()) target.close();
  return true;
});
async function showNotification(message) {
  try {
    await displayNotification(message.candidate);
    backend?.send({ type: 'notification-result', id: message.id, ok: true });
  } catch (error) {
    backend?.send({ type: 'notification-result', id: message.id, ok: false, error: error.message });
  }
}
const previewCards = () => [
  { key: 'briefing:preview', title: '아사 · 오늘 일정', body: '10:00 알고리즘 (E동 101호) 수업이 있어. 보고서 마감까지 하루 남았어.' },
  { key: 'class:preview', title: '아사 · 곧 수업이야', body: '알고리즘 (E동 101호), 30분 뒤 시작이야. 슬슬 준비하자.' },
  { key: 'routine:preview', title: '아사 · 운동 시간', body: '스트레칭 할 시간이야. 가볍게 몸 좀 풀자.' },
  { key: 'health-check:preview', title: '아사 · 오늘 기록', body: '오늘 수면, 식사, 운동 기록이 아직 없어. 기억날 때 짧게 남겨 둘래?' },
  { key: 'activity-break:preview', title: '아사 · 잠깐 쉬자', body: 'PC 사용 50분째야. 잠깐 쉴까. 어깨 한번 풀어 주고.' },
  { key: 'casual:preview', title: '아사 · 있잖아', body: '요즘 제일 많이 듣는 노래 뭐야? 한 곡만 골라 봐.' },
  { key: 'deadline-start:preview', title: '아사 · 남은 마감', body: '보고서, 마감까지 하루 남았어. 일단 파일부터 열어 보자.' },
  { key: 'evening-review:preview', title: '아사 · 오늘 결산', body: '루틴 2개를 완료했어. 보고서, 내일 23:59 마감이야.', display: 'daily-review' }
];
function spawnPopupPreview(script, title, body, gameWindowBounds, seconds = 4, volume = 70) {
  const encode = value => Buffer.from(value, 'utf8').toString('base64');
  const placement = gameWindowBounds ? encode(JSON.stringify(gameWindowBounds)) : '__RIN_EMPTY__';
  const itemId = script.includes('Urgent') ? 'preview' : '__RIN_EMPTY__';
  const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', join(root, script), encode(title), encode(body), itemId, 'preview', 'http://127.0.0.1:4317', String(seconds), placement, '-Volume', String(volume)], { cwd: root, windowsHide: true, detached: false, stdio: 'ignore' });
  child.unref();
}
async function testAllNotifications(volume = 70) {
  const activity = await detectForegroundGame();
  const bounds = activity?.isGame ? activity.windowBounds : activity?.visibleGameWindowBounds || null;
  const cards = previewCards();
  for (const candidate of cards) notificationQueue.push({ ...candidate, volume, gameWindowBounds: bounds, previewDuration: 6000 });
  showNextNotification();
  const cardDuration = cards.length * (6000 + NOTIFICATION_GAP);
  setTimeout(() => spawnPopupPreview('Show-RinUrgentPopup.ps1', '아사 · 마감부터 확인해', '마감까지 8시간 남았어. 이번 판 끝나면 자료부터 열자. 시작할 부분은 같이 정리해 줄게.', bounds, 6, volume), cardDuration);
  return { count: cards.length + 1, game: activity?.isGame === true };
}
async function runNotificationPreview() {
  const result = await testAllNotifications();
  log(`Notification preview started: ${result.count} types, game=${result.game}`);
  setTimeout(() => app.quit(), previewCards().length * (6000 + NOTIFICATION_GAP) + 7000);
}
app.on('second-instance', (_event, args) => startSurfaces(args, viewFromArguments(args)));

async function health(url) {
  try { const result = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) }); const data = result.ok ? await result.json() : null; return data?.app === 'rin-companion' ? data : null; }
  catch { return null; }
}
async function stopLegacyBackend(legacyRoot) {
  const script = legacyRoot && join(legacyRoot, 'Stop-Rin.ps1');
  if (!script || !existsSync(script)) return false;
  await new Promise((resolveStop, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { cwd: legacyRoot, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolveStop() : reject(new Error(`이전 RIN 서비스 종료 실패 (${code})`)));
  });
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!await health('http://127.0.0.1:4317')) return true;
    await new Promise(resolveWait => setTimeout(resolveWait, 150));
  }
  return false;
}
async function startBackend(legacyRoot) {
  backendLegacyRoot = legacyRoot;
  const existing = !smoke && await health('http://127.0.0.1:4317');
  if (existing?.host !== 'desktop' && existing) {
    log('Stopping the legacy background service before starting the desktop notification host.');
    await stopLegacyBackend(legacyRoot);
  }
  const remaining = !smoke && await health('http://127.0.0.1:4317');
  if (remaining?.host === 'desktop') { baseUrl = 'http://127.0.0.1:4317'; log('Reusing an existing desktop backend.'); return; }
  if (remaining) throw new Error('이전 RIN 서비스가 아직 실행 중입니다. 작업 표시줄의 이전 RIN을 종료한 뒤 다시 실행해 주세요.');
  const bundledNode = join(root, 'runtime', 'node.exe');
  const nodePath = existsSync(bundledNode) ? bundledNode : process.env.RIN_NODE_EXE;
  if (!nodePath) throw new Error('앱에 포함된 Node 실행 파일이 없습니다. 데스크톱 빌드를 다시 만들어 주세요.');
  const child = spawn(nodePath, [join(__dirname, 'backend.mjs')], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, RIN_DATA_PATH: dataPath, RIN_PORT: smoke ? '0' : '4317', RIN_SMOKE_TEST: smoke ? '1' : '0', RIN_DESKTOP_HOST: '1', RIN_DESKTOP_EXE: app.isPackaged ? process.execPath : '' }
  });
  backend = child;
  let ready = false;
  child.stdout.on('data', data => log(data.toString()));
  child.stderr.on('data', data => log(data.toString()));
  child.on('exit', code => {
    if (backend === child) { backend = null; baseUrl = null; }
    if (!quitting && !backendMaintenance && ready) scheduleBackendRestart(legacyRoot, code);
  });
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error('로컬 서비스 시작 시간이 초과됐습니다.')), 15000);
    const fail = error => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('exit', code => { if (!ready) fail(new Error(`로컬 서비스 시작 실패 (${code})`)); });
    child.on('message', message => {
      if (message.type === 'notification-action-result') {
        const request = notificationActions.get(message.id);
        if (request) {
          clearTimeout(request.timeout); notificationActions.delete(message.id);
          message.ok ? request.resolve(message) : request.reject(new Error(message.error || 'Notification action failed'));
        }
      }
      if (message.type === 'ready') { clearTimeout(timer); ready = true; baseUrl = message.baseUrl; resolveReady(); }
      if (message.type === 'error') fail(new Error(message.message));
      if (message.type === 'notification') showNotification(message);
    });
  });
}
async function stopBackendForRestore() {
  const child = backend;
  if (!child) return;
  await new Promise(resolveStop => {
    const timer = setTimeout(() => child.kill(), 5000);
    child.once('exit', () => { clearTimeout(timer); resolveStop(); });
    if (child.connected) child.send('shutdown'); else child.kill();
  });
}
async function restoreFromBackup(name) {
  backendMaintenance = true;
  let result;
  try {
    await stopBackendForRestore();
    result = restoreBackup(dataPath, name);
    try { await startBackend(backendLegacyRoot); }
    catch (error) {
      rollbackRestore(dataPath, result.safety);
      await startBackend(backendLegacyRoot);
      throw new Error(`백업 복원 후 시작하지 못해 기존 데이터로 되돌렸습니다. ${error.message}`);
    }
    setTimeout(reloadSurfaces, 250);
    return result;
  } catch (error) {
    if (!backend) try { await startBackend(backendLegacyRoot); } catch (restartError) { log(`Backend restart after restore failure: ${restartError.message}`); }
    throw error;
  } finally { backendMaintenance = false; }
}
function scheduleBackendRestart(legacyRoot, code) {
  if (quitting || backendRestartTimer) return;
  if (++backendRestartAttempts > 3) {
    dialog.showErrorBox('아사 연결 종료', '로컬 서비스 자동 복구에 실패했습니다. 아사를 다시 실행해 주세요.');
    return;
  }
  const delay = backendRestartAttempts * 1000;
  log(`Backend exited (${code}); restart attempt ${backendRestartAttempts} in ${delay}ms.`);
  backendRestartTimer = setTimeout(async () => {
    backendRestartTimer = null;
    try {
      await startBackend(legacyRoot);
      backendRestartAttempts = 0;
      reloadSurfaces();
      log('Backend restarted successfully.');
    } catch (error) {
      log(`Backend restart failed: ${error.message}`);
      scheduleBackendRestart(legacyRoot, error.message);
    }
  }, delay);
}
function registerProtocol() {
  const files = {
    '/': ['public/index.html', 'text/html; charset=utf-8'],
    '/style.css': ['public/style.css', 'text/css; charset=utf-8'],
    '/client.js': ['public/client.js', 'text/javascript; charset=utf-8'],
    '/seoa-portrait.js': ['public/seoa-portrait.js', 'text/javascript; charset=utf-8'],
    '/seoa-gallery.js': ['public/seoa-gallery.js', 'text/javascript; charset=utf-8']
  };
  for (const name of ['portrait', 'choom', 'moon', 'supa-dupa-luv']) {
    const file = `asa/${name}.jpg`;
    files[`/assets/${file}`] = [`public/assets/${file}`, 'image/jpeg'];
  }
  const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'";
  protocol.handle('rin', async request => {
    if (!isAppUrl(request.url)) return new Response('Forbidden', { status: 403 });
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/') && ['GET', 'POST'].includes(request.method)) {
        const headers = {};
        for (const name of ['content-type', 'x-rin-token']) if (request.headers.has(name)) headers[name] = request.headers.get(name);
        const response = await fetch(`${baseUrl}${url.pathname}${url.search}`, {
          method: request.method, headers, redirect: 'error', signal: AbortSignal.timeout(180000),
          ...(request.method === 'POST' ? { body: await request.text() } : {})
        });
        return new Response(await response.arrayBuffer(), { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') || 'application/json', 'Cache-Control': 'no-store' } });
      }
      const file = files[url.pathname];
      if (request.method !== 'GET' || !file) return new Response('Not found', { status: 404 });
      return new Response(readFileSync(join(root, file[0])), { headers: { 'Content-Type': file[1], 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' } });
    } catch (error) { log(error.message); return Response.json({ error: '로컬 서비스에 연결하지 못했어요. 앱을 다시 실행해 주세요.' }, { status: 503 }); }
  });
}
function trustedWindow(event) {
  return [window, widget].find(target => target && !target.isDestroyed() && event.sender === target.webContents && event.senderFrame === target.webContents.mainFrame && isAppUrl(event.senderFrame.url));
}
function trusted(event) { return !!trustedWindow(event); }
function preferredDisplay() { return screen.getAllDisplays().find(display => display.id !== screen.getPrimaryDisplay().id) || screen.getPrimaryDisplay(); }
function displayForBounds(saved, surface = 'app') {
  if (surface === 'widget') return preferredDisplay();
  return screen.getAllDisplays().find(({ workArea: area }) => Number.isFinite(saved.x) && Number.isFinite(saved.y) && saved.x < area.x + area.width && saved.y < area.y + area.height && saved.x + (saved.width || 1) > area.x && saved.y + (saved.height || 1) > area.y) || preferredDisplay();
}
function saveWindowState(surface, target) {
  if (target.isDestroyed() || target.isMinimized()) return;
  windowState[surface] = { ...target.getNormalBounds(), maximized: target.isMaximized() };
  writeFileSync(windowStatePath, JSON.stringify(windowState));
}
function closeSurface(target) {
  if (target === widget) { app.quit(); return; }
  target.hide();
  if (target === window && !quitting) showSurface('widget');
}
function fitSurface(surface, target) {
  if (!target || target.isDestroyed()) return;
  const current = target.getNormalBounds(), display = displayForBounds(current, surface);
  const bounds = validBounds(current, display.workArea, surface, display.bounds);
  target.setMinimumSize(Math.min(surface === 'widget' ? 480 : 800, bounds.width), Math.min(surface === 'widget' ? 360 : 620, bounds.height));
  if (Object.keys(bounds).some(key => bounds[key] !== current[key])) target.setBounds(bounds);
}
function fitWindows() {
  fitSurface('widget', widget);
  fitSurface('app', window);
  keepWidgetVisible();
}
function createSurface(surface) {
  const saved = windowState[surface] || {};
  const display = displayForBounds(saved, surface);
  const isWidget = surface === 'widget';
  const bounds = validBounds(saved, display.workArea, surface, display.bounds);
  const icon = nativeImage.createFromPath(join(root, 'public/assets/asa/portrait.jpg'));
  const target = new BrowserWindow({
    ...bounds, minWidth: Math.min(isWidget ? 480 : 800, bounds.width), minHeight: Math.min(isWidget ? 360 : 620, bounds.height),
    title: isWidget ? '아사 · 위젯' : '아사', icon, show: false, frame: false,
    transparent: isWidget, backgroundColor: isWidget ? '#00000000' : '#f6f3ee', hasShadow: !isWidget, skipTaskbar: isWidget,
    resizable: !isWidget, maximizable: !isWidget, minimizable: !isWidget,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged || smoke }
  });
  target.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  if (smoke) {
    target.webContents.on('console-message', event => log(`Smoke ${surface}: ${event.message}`));
    target.webContents.session.webRequest.onErrorOccurred(details => log(`Smoke request: ${details.url} ${details.error}`));
  }
  target.webContents.session.setPermissionCheckHandler(() => false);
  target.webContents.setWindowOpenHandler(({ url }) => { if (isAllowedExternal(url)) shell.openExternal(url); return { action: 'deny' }; });
  target.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) { event.preventDefault(); if (isAllowedExternal(url)) shell.openExternal(url); } });
  target.on('close', event => { if (!quitting) { event.preventDefault(); closeSurface(target); } });
  target.on('resize', () => saveWindowState(surface, target));
  target.on('moved', () => saveWindowState(surface, target));
  target.once('show', () => { if (!isWidget && saved.maximized) target.maximize(); });
  if (isWidget) {
    target.on('move', () => setImmediate(() => fitSurface(surface, target)));
    target.on('hide', () => setImmediate(keepWidgetVisible));
    target.on('minimize', () => setImmediate(keepWidgetVisible));
    // Forward movement so controls can become interactive again after passing a click through.
    target.setIgnoreMouseEvents(true, { forward: true });
    target.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) target.setIgnoreMouseEvents(true, { forward: true });
    });
  }
  return target;
}
async function createWindow() {
  const saved = readJson(windowStatePath);
  windowState = { widget: saved.widget || {}, app: saved.app || {} };
  Menu.setApplicationMenu(null);
  widget = createSurface('widget');
  window = createSurface('app');
  screen.on('display-added', fitWindows);
  screen.on('display-removed', fitWindows);
  screen.on('display-metrics-changed', fitWindows);
  ipcMain.on('rin:window', (event, action) => {
    const target = trustedWindow(event);
    if (!target) return;
    if (action === 'minimize' && target !== widget) target.minimize();
    if (action === 'maximize' && target.isMaximizable()) target.isMaximized() ? target.unmaximize() : target.maximize();
    if (action === 'close') closeSurface(target);
    if (action === 'quit') app.quit();
  });
  ipcMain.handle('rin:open-app', (event, view = 'home') => {
    if (!trusted(event) || !validView(view)) throw new Error('Not allowed');
    return showSurface('app', view);
  });
  ipcMain.handle('rin:show-widget', event => {
    if (!trusted(event)) throw new Error('Not allowed');
    window.hide();
    return showSurface('widget');
  });
  ipcMain.on('rin:click-through', (event, enabled) => {
    if (trustedWindow(event) !== widget || typeof enabled !== 'boolean') return;
    widget.setIgnoreMouseEvents(enabled, { forward: true });
  });
  ipcMain.handle('rin:widget-pointer', event => {
    if (trustedWindow(event) !== widget) throw new Error('Not allowed');
    const point = screen.getCursorScreenPoint(), bounds = widget.getContentBounds();
    const zoom = widget.webContents.getZoomFactor();
    return { x: (point.x - bounds.x) / zoom, y: (point.y - bounds.y) / zoom };
  });
  ipcMain.handle('rin:widget-size', (event, action, size) => {
    if (trustedWindow(event) !== widget || !['get', 'set', 'reset'].includes(action)) throw new Error('Not allowed');
    if (action === 'set' && (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height))) throw new Error('Invalid size');
    const current = widget.getNormalBounds(), display = preferredDisplay();
    if (action !== 'get') {
      const requested = action === 'reset' ? { x: current.x, y: current.y } : { ...current, width: size.width, height: size.height };
      if (size?.keepPosition === true) {
        requested.width = Math.min(requested.width, display.workArea.x + display.workArea.width - current.x);
        requested.height = Math.min(requested.height, display.workArea.y + display.workArea.height - current.y);
      }
      widget.setBounds(validBounds(requested, display.workArea, 'widget', display.bounds));
      saveWindowState('widget', widget);
    }
    const { width, height } = widget.getBounds();
    return { width, height, minWidth: Math.min(480, display.workArea.width), minHeight: Math.min(360, display.workArea.height), maxWidth: display.workArea.width, maxHeight: display.workArea.height };
  });
  ipcMain.handle('rin:eclass', async event => { if (!trusted(event)) throw new Error('Not allowed'); await shell.openExternal('https://eclass.tukorea.ac.kr/ilos/main/main_form.acl'); return true; });
  ipcMain.handle('rin:data-folder', async event => { if (!trusted(event)) throw new Error('Not allowed'); return shell.openPath(dirname(dataPath)); });
  ipcMain.handle('rin:test-notification', async (event, volume = 70) => {
    if (!trusted(event)) throw new Error('Not allowed');
    if (!Number.isInteger(volume) || volume < 0 || volume > 100) throw new Error('Invalid volume');
    return testAllNotifications(volume);
  });
  ipcMain.handle('rin:startup-status', event => {
    if (!trusted(event)) throw new Error('Not allowed');
    return startupStatus();
  });
  ipcMain.handle('rin:set-startup', (event, enabled) => {
    if (!trusted(event) || typeof enabled !== 'boolean') throw new Error('Not allowed');
    return setStartup(enabled);
  });
  ipcMain.handle('rin:backups', event => {
    if (!trusted(event)) throw new Error('Not allowed');
    return listBackups(dataPath);
  });
  ipcMain.handle('rin:restore-backup', (event, name) => {
    if (!trusted(event) || typeof name !== 'string') throw new Error('Not allowed');
    return restoreFromBackup(name);
  });
  if (!smoke) {
    const icon = nativeImage.createFromPath(join(root, 'public/assets/asa/portrait.jpg'));
    tray = new Tray(icon.resize({ width: 24, height: 24 }));
    tray.setToolTip('아사');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '대화 위젯 열기', click: () => show('chat') },
      { label: '상세 앱 열기', click: () => show('home') },
      { label: '오늘 일정', click: () => show('university') },
      { label: '하루 결산', click: () => show('review') },
      { type: 'separator' },
      { label: '기록 폴더 열기', click: () => shell.openPath(dirname(dataPath)) },
      { label: '아사 종료', click: () => app.quit() }
    ]));
    tray.on('double-click', () => show('chat'));
  }
  await Promise.all([
    widget.loadURL('rin://app/?surface=widget#chat'),
    window.loadURL(`rin://app/?surface=app#${smoke ? 'chat' : startingView === 'chat' ? 'home' : startingView}`)
  ]);
  surfacesReady = true;
  if (!smoke) startSurfaces();
}
async function smokeDesktopSurfaces() {
  const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
  const until = async condition => {
    for (let attempt = 0; attempt < 60; attempt++) { if (await condition()) return true; await wait(50); }
    return false;
  };
  const nativeWindow = { resizable: widget.isResizable(), maximizable: widget.isMaximizable(), backgroundColor: widget.getBackgroundColor(), opacity: widget.getOpacity(), bounds: widget.getBounds() };
  // Electron's getBackgroundColor omits alpha; capturePage below verifies real transparent pixels.
  const result = { initiallyHidden: !widget.isVisible() && !window.isVisible(), fixedTransparentWindow: !nativeWindow.resizable && !nativeWindow.maximizable && nativeWindow.backgroundColor === '#000000' && nativeWindow.opacity === 1, normalStacking: !widget.isAlwaysOnTop(), diagnostics: { nativeWindow } };
  let widgetId = widget.id;
  const appId = window.id;
  const displayId = preferredDisplay().id;
  result.secondDisplay = screen.getDisplayMatching(widget.getBounds()).id === displayId && screen.getDisplayMatching(window.getBounds()).id === displayId;
  show('chat');
  result.widgetReady = await until(() => widget.webContents.executeJavaScript(`document.body.dataset.surface === 'widget' && document.querySelectorAll('#messages .message').length > 0 && typeof window.rinDesktop?.openApp === 'function'`));
  if (!result.widgetReady) {
    const diagnostics = await widget.webContents.executeJavaScript(`(async () => {
      const details = { surface: document.body.dataset.surface, title: document.title, url: location.href, messages: document.querySelectorAll('#messages .message').length, toast: document.getElementById('toast')?.textContent, bridge: typeof window.rinDesktop?.openApp };
      try { const response = await fetch('/api/session'), session = await response.json(); return { ...details, serverMessages: session.messages?.length, error: session.error, status: response.status }; }
      catch (error) { return { ...details, fetchError: error.message }; }
    })()`);
    throw new Error('Widget did not initialize: ' + JSON.stringify(diagnostics));
  }
  result.widgetVisible = widget.isVisible();
  const transparentStyles = await widget.webContents.executeJavaScript(`(async () => {
    const selectors = ['html', 'body', '.shell', '#workspace', '.content', '#view-chat', '.conversation-layout', '.chat-card', '.chat-header', '.native-titlebar', '#messages', '.bubble', '#chat-form', '#message', '#send'];
    const inspect = () => selectors.flatMap(selector => {
      const element = document.querySelector(selector);
      if (!element) return [{ selector, missing: true }];
      const style = getComputedStyle(element);
      const clear = (style.backgroundColor.split(',').at(-1).trim() === '0)' || style.backgroundColor === 'transparent') && style.backgroundImage === 'none';
      return clear ? [] : [{ selector, backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage, transitionProperty: style.transitionProperty, transitionDuration: style.transitionDuration }];
    });
    const initialFailures = inspect();
    let finalFailures = initialFailures, samples = 1;
    while (finalFailures.length && samples < 21) {
      await new Promise(resolve => setTimeout(resolve, 50));
      finalFailures = inspect(); samples++;
    }
    return { initialFailures, finalFailures, samples };
  })()`);
  result.transparentSurfaces = transparentStyles.finalFailures.length === 0;
  result.diagnostics.backdrop = await widget.webContents.executeJavaScript(`(() => {
    const panel = getComputedStyle(document.body, '::before');
    const rgba = panel.backgroundColor.match(/[\\d.]+/g).map(Number);
    const alpha = (rgba[3] ?? 1) * Number(panel.opacity);
    const luminance = rgb => rgb.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const background = luminance(rgba.slice(0, 3).map(v => v * alpha + 255 * (1 - alpha)));
    const contrast = ['.bubble', '.user .bubble', '#chat-status', '.composer textarea'].map(selector => {
      const rgb = getComputedStyle(document.querySelector(selector)).color.match(/[\\d.]+/g).slice(0, 3).map(Number);
      return (luminance(rgb) + .05) / (background + .05);
    });
    return { alpha, pointerEvents: panel.pointerEvents, radius: parseFloat(panel.borderRadius), minContrast: Math.min(...contrast) };
  })()`);
  result.translucentBackdrop = result.diagnostics.backdrop.alpha > 0 && result.diagnostics.backdrop.alpha < 1 && result.diagnostics.backdrop.pointerEvents === 'none' && result.diagnostics.backdrop.radius > 0;
  result.diagnostics.transparentStyles = transparentStyles;
  result.widgetLayout = await widget.webContents.executeJavaScript(`document.querySelector('.sidebar').getBoundingClientRect().width === 0 && document.querySelector('.chat-presence').getBoundingClientRect().height === 0 && document.querySelectorAll('.window-controls button').length === 1 && document.getElementById('send').getBoundingClientRect().bottom <= innerHeight`);
  const widgetDisplay = screen.getDisplayMatching(widget.getBounds());
  const expectedBounds = validBounds({}, widgetDisplay.workArea, 'widget', widgetDisplay.bounds);
  result.responsiveWidget = nativeWindow.bounds.width === expectedBounds.width && nativeWindow.bounds.height === expectedBounds.height;
  result.diagnostics.widgetText = await widget.webContents.executeJavaScript(`(() => {
    const text = getComputedStyle(document.querySelector('.bubble')), input = getComputedStyle(document.getElementById('message'));
    return { fontSize: parseFloat(text.fontSize), fontWeight: Number(text.fontWeight), inputSize: parseFloat(input.fontSize), shadow: text.textShadow };
  })()`);
  result.widgetReadability = result.diagnostics.widgetText.fontSize >= 20 && result.diagnostics.widgetText.fontWeight >= 600 && result.diagnostics.widgetText.inputSize >= 20 && result.diagnostics.backdrop.minContrast >= 4.5;
  const adjustment = await widget.webContents.executeJavaScript(`(() => {
    const menu = document.getElementById('chat-menu'), slider = document.getElementById('widget-transparency');
    document.getElementById('open-chat-menu').click();
    const menuOpened = menu.open;
    const values = [0, 100, 58].map(value => {
      slider.value = String(value); slider.dispatchEvent(new Event('input', { bubbles: true }));
      return { value, opacity: Number(getComputedStyle(document.body, '::before').opacity), textOpacity: getComputedStyle(document.querySelector('.bubble')).opacity, label: document.getElementById('widget-transparency-value').textContent };
    });
    document.getElementById('close-chat-menu').click();
    return { menuOpened, menuClosed: !menu.open, values, saved: localStorage.getItem('seoa-widget-transparency') };
  })()`);
  result.transparencyControl = adjustment.menuOpened && adjustment.menuClosed && adjustment.saved === '58' && widget.getOpacity() === 1 && adjustment.values.every(item => Math.abs(item.opacity - (1 - item.value / 100)) < .001 && item.textOpacity === '1' && item.label === item.value + '%');
  const reopenWidget = async () => {
    widget.webContents.session.flushStorageData();
    widget.destroy();
    widget = createSurface('widget');
    await widget.loadURL('rin://app/?surface=widget#chat');
    show('chat');
    widgetId = widget.id;
  };
  await reopenWidget();
  result.transparencyRestored = await until(() => widget.webContents.executeJavaScript(`document.getElementById('widget-transparency')?.value === '58' && Math.abs(Number(getComputedStyle(document.body, '::before').opacity) - .42) < .001 && document.querySelectorAll('#messages .message').length > 0`));
  await widget.webContents.executeJavaScript(`localStorage.setItem('seoa-widget-transparency', 'invalid')`);
  await reopenWidget();
  result.transparencyInvalidFallback = await until(() => widget.webContents.executeJavaScript(`document.getElementById('widget-transparency')?.value === '36' && Math.abs(Number(getComputedStyle(document.body, '::before').opacity) - .64) < .001 && document.querySelectorAll('#messages .message').length > 0`));
  result.transparencyReset = await widget.webContents.executeJavaScript(`(() => {
    const slider = document.getElementById('widget-transparency'); slider.value = '80'; slider.dispatchEvent(new Event('input'));
    document.getElementById('reset-widget-transparency').click();
    return slider.value === '36' && localStorage.getItem('seoa-widget-transparency') === '36';
  })()`);
  result.neutralCopy = await widget.webContents.executeJavaScript(`document.getElementById('chat-status').hidden && document.getElementById('chat-status').textContent === '' && !document.querySelector('.message.greeting, .rin-speech, .seoa-portrait-caption, #suggestions, [data-prompt]')`);
  result.diagnostics.transparency = adjustment;
  const layouts = [];
  for (const [width, height] of [[480, 360], [640, 800], [1320, 420]]) {
    await widget.webContents.executeJavaScript(`window.rinDesktop.resizeWidget(${width}, ${height})`);
    await wait(150);
    layouts.push(await widget.webContents.executeJavaScript(`(() => {
      const rect = selector => document.querySelector(selector).getBoundingClientRect();
      const messages = rect('#messages'), input = rect('#chat-form'), caption = rect('.native-caption'), toolbar = rect('.widget-toolbar'), send = rect('#send');
      return { width: innerWidth, height: innerHeight, inputWidth: input.width, historyHeight: messages.height,
        ok: document.documentElement.scrollWidth <= innerWidth && messages.height > 100 && messages.bottom <= input.top + 1 && input.bottom <= innerHeight - 30 && send.bottom <= input.bottom && caption.right <= toolbar.left && toolbar.right <= rect('.window-controls').left };
    })()`));
    if (smokeScreenshot) writeFileSync(smokeScreenshot.replace(/(\.png)?$/i, `.widget-${width}x${height}.png`), (await widget.webContents.capturePage()).toPNG());
  }
  result.diagnostics.resizeLayouts = layouts;
  result.resizeLayouts = layouts.every(layout => layout.ok) && layouts[2].inputWidth > layouts[0].inputWidth;
  await widget.webContents.executeJavaScript(`document.getElementById('open-chat-menu').click(); document.getElementById('widget-width').value = '700'; document.getElementById('widget-width').dispatchEvent(new Event('input'))`);
  result.widthControl = await until(() => widget.getBounds().width === 700);
  await widget.webContents.executeJavaScript(`document.getElementById('widget-height').value = '500'; document.getElementById('widget-height').dispatchEvent(new Event('input'))`);
  result.heightControl = await until(() => widget.getBounds().height === 500);
  await widget.webContents.executeJavaScript(`document.getElementById('close-chat-menu').click(); document.getElementById('widget-resize').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight',bubbles:true}))`);
  result.resizeKeyboard = await until(() => widget.getBounds().width === 720);
  windowState = readJson(windowStatePath);
  await reopenWidget();
  result.sizeRestored = await until(() => widget.webContents.executeJavaScript(`innerWidth === 720 && innerHeight === 500 && document.getElementById('widget-width-value').textContent === '720px' && !!document.querySelector('#messages .message')`));
  result.resizeValidation = await widget.webContents.executeJavaScript(`(async () => { try { await window.rinDesktop.resizeWidget(Infinity, 500); return false; } catch { return true; } })()`);
  result.resizeSenderValidation = await window.webContents.executeJavaScript(`(async () => { try { await window.rinDesktop.resizeWidget(600, 400); return false; } catch { return true; } })()`);
  await widget.webContents.executeJavaScript(`document.getElementById('reset-widget-size').click()`);
  result.sizeReset = await until(() => widget.getBounds().width === expectedBounds.width && widget.getBounds().height === expectedBounds.height);
  await widget.webContents.executeJavaScript(`document.getElementById('message').value = '위젯에 남겨 둔 입력'; document.getElementById('message').dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('open-details').click()`);
  result.detailsButton = await until(async () => window.isVisible() && await window.webContents.executeJavaScript(`document.body.dataset.surface === 'app' && document.body.dataset.view === 'home'`));
  result.diagnostics.details = { visible: window.isVisible(), minimized: window.isMinimized(), url: window.webContents.getURL(), renderer: await window.webContents.executeJavaScript(`({ ready: document.readyState, surface: document.body.dataset.surface, view: document.body.dataset.view, hash: location.hash, title: document.title, toast: document.getElementById('toast')?.textContent })`), widgetToast: await widget.webContents.executeJavaScript(`document.getElementById('toast')?.textContent`) };
  await window.webContents.executeJavaScript(`window.rinDesktop.openApp('chat')`);
  await wait(100);
  await window.webContents.executeJavaScript(`document.getElementById('message').value = '상세 앱에 남겨 둔 입력'; document.getElementById('message').dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('show-widget').click()`);
  result.showWidgetButton = await until(() => widget.isVisible() && widget.isFocused() && !window.isVisible());
  result.normalStackingAfterSwitch = !widget.isAlwaysOnTop() && !window.isAlwaysOnTop();
  await widget.webContents.executeJavaScript(`window.rinDesktop.minimize()`);
  await wait(100);
  result.widgetCannotMinimize = widget.isVisible() && !widget.isMinimized() && !widget.isMinimizable();
  show('chat');
  await window.webContents.executeJavaScript(`window.rinDesktop.close()`);
  result.appClose = await until(() => !window.isVisible() && widget.isVisible());
  await widget.webContents.executeJavaScript(`document.getElementById('open-details').click()`);
  result.reusedWindows = await until(() => window.isVisible()) && window.id === appId && widget.id === widgetId && BrowserWindow.getAllWindows().length === 2;
  result.separateDrafts = await widget.webContents.executeJavaScript(`document.getElementById('message').value === '위젯에 남겨 둔 입력'`) && await window.webContents.executeJavaScript(`document.getElementById('message').value === '상세 앱에 남겨 둔 입력'`);
  result.validatedNavigation = await widget.webContents.executeJavaScript(`(async () => { try { await window.rinDesktop.openApp('https://evil.example'); return false; } catch { return true; } })()`);
  widget.hide();
  result.widgetReappears = await until(() => widget.isVisible() && window.isVisible());
  showSurface('app', 'chat');
  await wait(100);
  await window.webContents.executeJavaScript(`document.getElementById('message').value = ''; document.getElementById('message').dispatchEvent(new Event('input', { bubbles: true }))`);
  return result;
}
async function smokeSharedSettings() {
  show('chat');
  await widget.webContents.executeJavaScript(`document.getElementById('message').focus()`);
  const volumeSetting = await window.webContents.executeJavaScript(`(async () => {
    const slider = document.getElementById('notification-volume');
    if (!slider || slider.min !== '0' || slider.max !== '100') return false;
    slider.value = '35';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('preferences-form').requestSubmit();
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const current = await (await fetch('/api/session')).json();
      if (current.settings.notificationVolume === 35) return document.getElementById('notification-volume-value').textContent === '35%';
    }
    return false;
  })()`);
  const shared = await widget.webContents.executeJavaScript(`(async () => {
    let diagnostics;
    for (let attempt = 0; attempt < 50; attempt++) {
      const current = await (await fetch('/api/session')).json();
      diagnostics = { slider: document.getElementById('notification-volume').value, serverVolume: current.settings.notificationVolume, messages: document.querySelectorAll('#messages .message').length, serverMessages: current.messages.length, draft: document.getElementById('message').value, hidden: document.hidden, focused: document.hasFocus(), activeElement: document.activeElement?.id, view: document.body.dataset.view, dialogs: [...document.querySelectorAll('dialog[open]')].map(dialog => dialog.id) };
      if (diagnostics.slider === '35' && diagnostics.messages === diagnostics.serverMessages && diagnostics.draft === '위젯에 남겨 둔 입력') return { ok: true, diagnostics };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { ok: false, diagnostics };
  })()`);
  return { volumeSetting, sharedState: shared.ok, diagnostics: shared.diagnostics };
}
async function smokeCharacterAssets() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const pinned = window.isAlwaysOnTop(), debuggerAttached = window.webContents.debugger.isAttached();
  const report = {};
  window.setAlwaysOnTop(true, 'screen-saver');
  showSurface('app', 'chat');
  if (!debuggerAttached) window.webContents.debugger.attach('1.3');
  const motionPreference = value => window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: value ? [{ name: 'prefers-reduced-motion', value }] : [] });
  try {
    await motionPreference('no-preference');
    await wait(150);
    Object.assign(report, await window.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const loaded = async image => {
        for (let attempt = 0; image && attempt < 60; attempt++) {
          if (image.complete && image.naturalWidth > 0) { try { await image.decode(); return true; } catch {} }
          await wait(50);
        }
        return false;
      };
      const moving = async stage => {
        const before = getComputedStyle(stage).transform;
        // A single sample can hit matching transforms on either side of the animation peak.
        for (let attempt = 0; attempt < 10; attempt++) {
          await wait(100);
          const style = getComputedStyle(stage);
          if (stage.classList.contains('is-breathing') && style.animationName !== 'none' && style.transform !== before) return true;
        }
        return false;
      };
      const gallery = { assets: 0, cards: {}, sceneBases: {} };
      const toggle = document.getElementById('character-motion');
      toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
      gallery.module = (await fetch('/seoa-gallery.js')).ok;
      for (const file of ['portrait.jpg', 'choom.jpg', 'moon.jpg', 'supa-dupa-luv.jpg']) {
        const response = await fetch('/assets/asa/' + file), bytes = new Uint8Array(await response.arrayBuffer());
        if (response.ok && response.headers.get('content-type')?.includes('image/jpeg') && bytes.length > 1024 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) gallery.assets++;
      }
      gallery.strictPaths = (await fetch('/assets/asa/unknown.jpg')).status === 404 && (await fetch('/assets/asa/portrait.png')).status === 404 && (await fetch('/assets/seoa/portrait.png')).status === 404;
      for (const view of ['university', 'routines', 'activity', 'review', 'memory', 'settings']) {
        document.querySelector('.nav[data-view="' + view + '"]').click();
        const card = document.querySelector('#view-' + view + ' .seoa-scene-card'), image = card?.querySelector('[data-seoa-photo]');
        if (!card || !await loaded(image)) { gallery.cards[view] = false; continue; }
        const first = image.dataset.seoaPhoto;
        card.querySelector('button').click();
        gallery.cards[view] = await loaded(image) && first !== image.dataset.seoaPhoto && image.src.includes('/assets/asa/') && image.getBoundingClientRect().height > 0;
      }
      document.querySelector('.nav[data-view="chat"]').click();
      const stage = document.querySelector('#seoa-portrait .seoa-portrait-stage');
      for (const [scene, file] of [['casual', 'choom.jpg'], ['rest', 'supa-dupa-luv.jpg'], ['studio', 'moon.jpg']]) {
        const button = document.querySelector('[data-portrait-scene="' + scene + '"]');
        button.click();
        const image = stage.querySelector('.seoa-portrait-base');
        gallery.sceneBases[scene] = await loaded(image) && stage.dataset.scene === scene && image.src.endsWith('/assets/asa/' + file) && button.getAttribute('aria-pressed') === 'true';
      }
      const character = {
        noTsundere: !document.getElementById('tsundere'),
        cleanIdentity: document.title.endsWith(' · 아사') && !document.querySelector('.fanmade-label, .fanmade-info') && !document.body.textContent.includes('팬메이드') && !document.body.textContent.includes('FANMADE'),
        original: stage.querySelector('.seoa-portrait-base').src.endsWith('/assets/asa/moon.jpg') && stage.querySelector('.seoa-portrait-base').naturalWidth >= 1000,
        noGeneratedFrames: !document.querySelector('.seoa-portrait-frame'),
        motion: await moving(stage)
      };
      document.querySelector('.nav[data-view="home"]').click();
      const home = document.querySelector('#seoa-home-portrait .seoa-portrait-stage');
      gallery.hiddenChat = !stage.classList.contains('is-breathing');
      gallery.homeBase = home.dataset.scene === 'rest' && await loaded(home.querySelector('.seoa-portrait-base')) && home.querySelector('.seoa-portrait-base').src.endsWith('/assets/asa/supa-dupa-luv.jpg');
      gallery.homeAnimated = await moving(home);
      document.querySelector('.nav[data-view="chat"]').click();
      gallery.hiddenHome = !home.classList.contains('is-breathing');
      gallery.noOldImages = [...document.images].every(image => !image.src.includes('/assets/seoa/')) && performance.getEntriesByType('resource').every(entry => entry.initiatorType !== 'img' || !entry.name.includes('/assets/seoa/'));
      return { gallery, character };
    })()`));
    window.hide();
    report.gallery.hiddenWindow = await window.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      for (let attempt = 0; attempt < 30 && !document.hidden; attempt++) await wait(50);
      const stage = document.querySelector('#seoa-portrait .seoa-portrait-stage'), before = getComputedStyle(stage).transform;
      await wait(250);
      return document.hidden && !stage.classList.contains('is-breathing') && getComputedStyle(stage).transform === before;
    })()`);
    showSurface('app', 'chat');
    await motionPreference('reduce');
    await wait(150);
    report.character.reducedMotion = await window.webContents.executeJavaScript(`(async () => {
      const stage = document.querySelector('#seoa-portrait .seoa-portrait-stage'), before = getComputedStyle(stage).transform;
      await new Promise(resolve => setTimeout(resolve, 350));
      return matchMedia('(prefers-reduced-motion: reduce)').matches && !stage.classList.contains('is-breathing') && getComputedStyle(stage).animationName === 'none' && getComputedStyle(stage).transform === before;
    })()`);
    await motionPreference('no-preference');
    report.character.motionSaved = await window.webContents.executeJavaScript(`(async () => {
      const toggle = document.getElementById('character-motion');
      toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('preferences-form').requestSubmit();
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if ((await (await fetch('/api/session')).json()).settings.characterMotion === false) return true;
      }
      return false;
    })()`);
    // Reload only the detail app; transparent widget forwarding uses its existing native window.
    const reloaded = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    window.webContents.reload(); await reloaded;
    report.character.motionOff = await window.webContents.executeJavaScript(`(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms)), toggle = document.getElementById('character-motion');
      const stage = document.querySelector('#seoa-portrait .seoa-portrait-stage');
      for (let attempt = 0; attempt < 40 && toggle.checked; attempt++) await wait(100);
      const before = getComputedStyle(stage).transform;
      await wait(500);
      return !toggle.checked && !stage.classList.contains('is-breathing') && getComputedStyle(stage).animationName === 'none' && getComputedStyle(stage).transform === before;
    })()`);
    report.character.motionRestored = await window.webContents.executeJavaScript(`(async () => {
      const toggle = document.getElementById('character-motion');
      toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('preferences-form').requestSubmit();
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if ((await (await fetch('/api/session')).json()).settings.characterMotion === true) return true;
      }
      return false;
    })()`);
    report.gallery.ok = report.gallery.module && report.gallery.assets === 4 && report.gallery.strictPaths && Object.keys(report.gallery.cards).length === 6 && Object.values(report.gallery.cards).every(Boolean) && Object.keys(report.gallery.sceneBases).length === 3 && Object.values(report.gallery.sceneBases).every(Boolean) && report.gallery.homeBase && report.gallery.homeAnimated && report.gallery.hiddenChat && report.gallery.hiddenHome && report.gallery.hiddenWindow && report.gallery.noOldImages;
    report.character.ok = Object.values(report.character).every(value => value === true);
    if (smokeScreenshot) {
      for (const view of ['university', 'settings']) {
        showSurface('app', view);
        await wait(250);
        writeFileSync(smokeScreenshot.replace(/(\.png)?$/i, '.' + view + '.png'), (await window.webContents.capturePage()).toPNG());
      }
    }
    return report;
  } finally {
    await motionPreference().catch(() => {});
    if (!debuggerAttached && window.webContents.debugger.isAttached()) window.webContents.debugger.detach();
    window.setAlwaysOnTop(pinned);
    showSurface('app', 'chat');
  }
}
async function smokeNotifications() {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async condition => { for (let i = 0; i < 80; i++) { if (await condition()) return true; await wait(50); } return false; };
  const report = {}, candidate = { key: 'class:notification-smoke', title: '아사 · 곧 수업이야', body: '알고리즘 (E동 101호), 25분 뒤 시작이야.\n슬슬 준비하자.', volume: 0, previewDuration: 30000 };
  const ready = async () => {
    if (!await until(() => notificationWindow && !notificationWindow.isDestroyed() && !notificationWindow.webContents.isLoadingMainFrame())) throw new Error('Notification did not load');
    await wait(200); return notificationWindow;
  };
  const click = (target, action) => target.webContents.executeJavaScript(`document.querySelector('[data-action="${action}"]').click(); true`);
  try {
    await displayNotification(candidate);
    let target = await ready();
    const display = screen.getDisplayMatching(target.getBounds());
    const actual = target.getBounds(), expected = notificationBounds(display.workArea);
    report.placement = Object.keys(expected).every(key => actual[key] === expected[key]);
    report.noFocusSteal = !target.isFocused();
    report.layout = await target.webContents.executeJavaScript(`(() => { const body = document.querySelector('.body'), buttons = [...document.querySelectorAll('button')]; return document.documentElement.scrollWidth <= innerWidth && body.clientHeight >= 60 && buttons.every(button => { const r = button.getBoundingClientRect(); return r.width >= 36 && r.height >= 36 && r.bottom <= innerHeight; }) && document.querySelector('img').naturalWidth > 0; })()`);
    report.isolated = await target.webContents.executeJavaScript(`typeof require === 'undefined' && typeof process === 'undefined' && typeof window.rinDesktop === 'undefined'`);
    if (smokeScreenshot) writeFileSync(smokeScreenshot, (await target.webContents.capturePage()).toPNG());
    await displayNotification(candidate);
    await displayNotification({ ...candidate, key: 'casual:notification-next', body: '처음 내용' });
    await displayNotification({ ...candidate, key: 'casual:notification-next', body: '갱신한 내용' });
    report.deduplicated = notificationQueue.length === 1 && notificationQueue[0].body === '갱신한 내용';
    await click(target, 'open');
    report.openAction = await until(async () => target.isDestroyed() && window.isVisible() && await window.webContents.executeJavaScript(`document.body.dataset.view === 'university'`));
    report.healthReminderOptIn = await window.webContents.executeJavaScript(`(() => {
      const toggle = document.getElementById('health-check-reminder'), timing = document.getElementById('health-check-usage-minutes');
      const initiallyOff = !toggle.checked && timing.disabled;
      toggle.click(); const canEnable = toggle.checked && !timing.disabled;
      toggle.click(); return initiallyOff && canEnable && !toggle.checked && timing.disabled;
    })()`);
    report.queueGap = notificationWindow === null && notificationQueue.length === 1;
    target = await ready();
    const saved = new Promise(resolve => {
      const listener = message => { if (message.type === 'notification-action-result') { backend.off('message', listener); resolve(message); } };
      backend.on('message', listener);
      setTimeout(() => { backend.off('message', listener); resolve({ ok: false }); }, 5000);
    });
    await click(target, 'snooze');
    const result = await saved;
    report.snoozeAction = result.ok && new Date(result.until) - Date.now() > 14 * 60000 && await until(() => target.isDestroyed());
    window.hide(); widget.hide();
    await displayNotification({ ...candidate, key: 'casual:hover-smoke', previewDuration: 800 });
    target = await ready();
    await target.webContents.executeJavaScript(`document.documentElement.dispatchEvent(new MouseEvent('mouseenter')); true`);
    await wait(1100);
    report.hoverPauses = !target.isDestroyed();
    await target.webContents.executeJavaScript(`document.documentElement.dispatchEvent(new MouseEvent('mouseleave')); true`);
    report.autoCloseResumes = await until(() => target.isDestroyed());
    await displayNotification({ ...candidate, key: 'casual:long-smoke', title: '긴 안내도 차분하게 읽을 수 있도록', body: '읽던 내용을 놓치지 않도록 마우스를 올리면 알림이 유지돼. 긴 문장은 아래로 스크롤해서 끝까지 읽을 수 있어.\n'.repeat(8) });
    target = await ready();
    report.longText = await target.webContents.executeJavaScript(`document.querySelector('.body').scrollHeight > document.querySelector('.body').clientHeight && document.querySelector('.actions').getBoundingClientRect().bottom <= innerHeight`);
    if (smokeScreenshot) writeFileSync(smokeScreenshot.replace(/(\.png)?$/i, '.long.png'), (await target.webContents.capturePage()).toPNG());
    target.setSize(320, 300);
    await wait(150);
    report.narrowLayout = await target.webContents.executeJavaScript(`document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('button')].every(button => { const r = button.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; })`);
    if (smokeScreenshot) writeFileSync(smokeScreenshot.replace(/(\.png)?$/i, '.narrow.png'), (await target.webContents.capturePage()).toPNG());
    await target.webContents.executeJavaScript(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
    report.escapeCloses = await until(() => target.isDestroyed());
  } catch (error) { report.error = error.stack || error.message; }
  report.ok = !report.error && Object.values(report).every(value => value === true);
  if (smokeReport) writeFileSync(smokeReport, JSON.stringify(report, null, 2));
  quitting = true;
  clearTimeout(nextNotificationTimer); clearTimeout(notificationTimer);
  if (backend?.connected) backend.send('shutdown');
  app.exit(report.ok ? 0 : 1);
}
async function runSmokeTest() {
  const screenSmoke = ['lifestyle', 'review', 'activity', 'widget-stay'].find(name => process.argv.includes('--smoke-' + name));
  if (screenSmoke) {
    let report;
    try {
      const run = require('./' + screenSmoke + '-smoke.cjs');
      report = await run({ window, widget, showSurface, startSurfaces, createSurface, windowState, screen, baseUrl, root, dataPath, displayNotification, getNotification: () => notificationWindow, screenshot: smokeScreenshot });
      report.ok = Object.entries(report).every(([key, value]) => key === 'diagnostics' || value === true);
    }
    catch (error) { report = { ok: false, error: error.stack || error.message }; }
    if (smokeReport) writeFileSync(smokeReport, JSON.stringify(report, null, 2));
    quitting = true;
    if (backend?.connected) backend.send('shutdown');
    app.exit(report.ok ? 0 : 1); return;
  }
  if (process.argv.includes('--smoke-notifications')) return smokeNotifications();
  const dualWindow = await smokeDesktopSurfaces();
  if (process.argv.includes('--smoke-widget-quit')) {
    const backendPid = backend?.pid;
    const quitButton = await widget.webContents.executeJavaScript(`document.querySelector('.window-controls button:last-child').getAttribute('aria-label') === '아사 완전히 종료'`);
    if (!quitButton) throw new Error('Widget quit button missing');
    app.once('will-quit', () => {
      const shutdown = { quitButton, quitting, windowsClosed: BrowserWindow.getAllWindows().length === 0, trayDestroyed: !tray || tray.isDestroyed(), backendPid };
      const ok = Object.entries(dualWindow).every(([key, value]) => key === 'diagnostics' || value === true) && shutdown.quitting && shutdown.windowsClosed && shutdown.trayDestroyed;
      if (smokeReport) writeFileSync(smokeReport, JSON.stringify({ ok, dualWindow, shutdown }, null, 2));
      if (!ok) process.exitCode = 1;
    });
    // Click the real control; the normal trusted IPC and before-quit cleanup must run.
    if (process.argv.includes('--smoke-native-close')) widget.close();
    else await widget.webContents.executeJavaScript(`setTimeout(() => document.querySelector('.window-controls button:last-child').click(), 50); true`);
    return;
  }
  if (process.argv.includes('--smoke-click-through')) {
    const clickThrough = await require('./widget-smoke.cjs')({ widget, window, screen, BrowserWindow });
    const passed = result => Object.entries(result).every(([key, value]) => key === 'diagnostics' || value === true);
    const ok = passed(dualWindow) && passed(clickThrough);
    if (smokeReport) writeFileSync(smokeReport, JSON.stringify({ ok, dualWindow, clickThrough }, null, 2));
    if (!ok) process.exitCode = 1;
    app.quit(); return;
  }
  if (smokeSurfacesOnly) {
    const shared = await smokeSharedSettings();
    dualWindow.volumeSetting = shared.volumeSetting;
    dualWindow.sharedState = shared.sharedState;
    dualWindow.diagnostics.sharedState = shared.diagnostics;
    const photos = await smokeCharacterAssets();
    showSurface('app', 'chat');
    await new Promise(resolveWait => setTimeout(resolveWait, 350));
    if (smokeScreenshot) writeFileSync(smokeScreenshot.replace(/(\.png)?$/i, '.chat.png'), (await window.webContents.capturePage()).toPNG());
    showSurface('app', 'home');
    await new Promise(resolveWait => setTimeout(resolveWait, 350));
    if (smokeScreenshot) writeFileSync(smokeScreenshot, (await window.webContents.capturePage()).toPNG());
    show('chat');
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
    const image = await widget.webContents.capturePage(), pixels = image.toBitmap();
    let transparentPixels = 0, translucentPixels = 0;
    for (let index = 3; index < pixels.length; index += 4) { if (pixels[index] === 0) transparentPixels++; else if (pixels[index] < 255) translucentPixels++; }
    dualWindow.transparentPixels = transparentPixels > 0 && pixels[3] === 0 && pixels.at(-1) === 0;
    dualWindow.translucentPixels = translucentPixels > pixels.length / 4 * 0.5;
    if (smokeScreenshot) writeFileSync(smokeScreenshot.replace(/(\.png)?$/i, '.widget.png'), image.toPNG());
    if (smokeScreenshot) {
      for (const [name, color] of [['light', '#f5f5f5'], ['dark', '#171b22']]) {
        await widget.webContents.executeJavaScript(`document.body.style.setProperty('background', ${JSON.stringify(color)}, 'important')`);
        await new Promise(resolveWait => setTimeout(resolveWait, 100));
        writeFileSync(smokeScreenshot.replace(/(\.png)?$/i, '.widget-' + name + '.png'), (await widget.webContents.capturePage()).toPNG());
      }
      if (smokeWallpaper) {
        const display = screen.getDisplayMatching(widget.getBounds()).bounds, bounds = widget.getBounds();
        const image = 'data:image/png;base64,' + readFileSync(smokeWallpaper).toString('base64');
        const background = `url("${image}") ${display.x - bounds.x}px ${display.y - bounds.y}px / ${display.width}px ${display.height}px no-repeat`;
        await widget.webContents.executeJavaScript(`document.body.style.setProperty('background', ${JSON.stringify(background)}, 'important')`);
        await new Promise(resolveWait => setTimeout(resolveWait, 200));
        writeFileSync(smokeScreenshot.replace(/(\.png)?$/i, '.widget-wallpaper.png'), (await widget.webContents.capturePage()).toPNG());
        await widget.webContents.executeJavaScript(`document.getElementById('open-chat-menu').click()`);
        await new Promise(resolveWait => setTimeout(resolveWait, 150));
        writeFileSync(smokeScreenshot.replace(/(\.png)?$/i, '.widget-menu.png'), (await widget.webContents.capturePage()).toPNG());
        await widget.webContents.executeJavaScript(`document.getElementById('close-chat-menu').click()`);
      }
      await widget.webContents.executeJavaScript(`document.body.style.removeProperty('background')`);
    }
    const widgetBounds = widget.getBounds();
    widget.setSize(480, 360);
    await new Promise(resolveWait => setTimeout(resolveWait, 150));
    dualWindow.compactWidget = await widget.webContents.executeJavaScript(`document.documentElement.scrollWidth <= innerWidth && document.getElementById('send').getBoundingClientRect().bottom <= innerHeight && document.getElementById('messages').clientHeight > 100 && parseFloat(getComputedStyle(document.querySelector('.bubble')).fontSize) >= 20`);
    widget.setBounds(widgetBounds);
    // Only the isolated smoke database is cleared; production conversations are untouched.
    await widget.webContents.executeJavaScript(`(async () => {
      const session = await (await fetch('/api/session')).json();
      await fetch('/api/messages/clear', {method:'POST',headers:{'Content-Type':'application/json','X-Rin-Token':session.token},body:'{}'});
      window.dispatchEvent(new Event('focus'));
    })()`);
    for (let attempt = 0; attempt < 60; attempt++) {
      dualWindow.emptyChat = await widget.webContents.executeJavaScript(`document.getElementById('messages').children.length === 0 && document.getElementById('chat-status').hidden && !document.querySelector('#suggestions,.message.greeting,[data-prompt]')`);
      if (dualWindow.emptyChat) break;
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
    }
    const ok = Object.entries(dualWindow).every(([key, value]) => key === 'diagnostics' || value === true) && photos.gallery.ok && photos.character.ok;
    if (smokeReport) writeFileSync(smokeReport, JSON.stringify({ ok, dualWindow, ...photos }, null, 2));
    if (!ok) process.exitCode = 1;
    app.quit(); return;
  }
  const until = Date.now() + 12000;
  let report;
  do {
    report = await window.webContents.executeJavaScript(`({ ready: document.title.endsWith(' · 아사') && !!document.querySelector('#messages .message'), title: document.title, url: location.href, bridge: typeof window.rinDesktop?.minimize === 'function', backupBridge: typeof window.rinDesktop?.listBackups === 'function' && typeof window.rinDesktop?.restoreBackup === 'function' && !!document.querySelector('.desktop-backup-label'), providerStatus: !!document.getElementById('provider-status'), isolated: typeof require === 'undefined' && typeof process === 'undefined', images: [...document.images].filter(i => i.hasAttribute('src')).every(i => i.complete && i.naturalWidth > 0), overflow: document.documentElement.scrollWidth > innerWidth, controls: document.querySelectorAll('.window-controls button').length })`);
    if (report.ready && report.images) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  } while (Date.now() < until);
  report.dualWindow = dualWindow;
  const expectedDisplay = screen.getAllDisplays().find(display => display.id !== screen.getPrimaryDisplay().id) || screen.getPrimaryDisplay();
  report.secondDisplay = screen.getDisplayMatching(window.getBounds()).id === expectedDisplay.id;
  report.chat = await window.webContents.executeJavaScript(`(async () => {
    const visible = element => !!element && element.getBoundingClientRect().height > 0 && getComputedStyle(element).display !== 'none';
    if (document.body.dataset.surface !== 'app' || document.body.dataset.view !== 'chat' || !visible(document.querySelector('.sidebar')) || !visible(document.querySelector('.schedule-receipt'))) return 'app chat layout or receipt missing';
    document.querySelector('.receipt-actions button').click();
    if (!document.getElementById('academic-dialog').open || document.getElementById('academic-name').value !== '팀플 회의') return 'edit dialog';
    document.getElementById('cancel-academic').click();
    document.getElementById('open-chat-menu').click();
    if (!document.getElementById('chat-menu').open) return 'menu dialog';
    document.querySelector('#chat-menu [data-view="settings"]').click();
    if (document.body.dataset.view !== 'settings' || document.getElementById('chat-menu').open) return 'settings navigation';
    document.querySelector('.nav[data-view="chat"]').click();
    return document.activeElement.id === 'message' && visible(document.getElementById('send')) ? true : 'chat focus';
  })()`);
  Object.assign(report, await smokeCharacterAssets());
  report.scheduleChanges = await window.webContents.executeJavaScript(`(async () => {
    const submit = async text => {
      document.getElementById('message').value = text;
      document.getElementById('chat-form').requestSubmit();
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!document.getElementById('send').disabled && !document.getElementById('message').value) return true;
      }
      return false;
    };
    if (!await submit('그 회의 오후 4시로 바뀌었어')) return 'update timeout';
    let latest = [...document.querySelectorAll('.schedule-receipt')].at(-1);
    if (!latest?.textContent.includes('일정을 수정했어') || !latest.textContent.includes('변경 전:')) return 'update receipt';
    if (!await submit('그 회의 취소됐어')) return 'cancel timeout';
    latest = [...document.querySelectorAll('.schedule-receipt')].at(-1);
    const undo = [...latest.querySelectorAll('button')].find(button => button.textContent === '취소 되돌리기');
    if (!undo || !latest.textContent.includes('알림 꺼짐')) return 'cancel receipt';
    undo.click();
    let restored = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const current = await (await fetch('/api/session')).json();
      if (current.academics[0]?.due.endsWith('T16:00') && !current.cancelledAcademicIds.length && [...document.querySelectorAll('.schedule-receipt')].at(-1).textContent.includes('취소를 되돌린')) { restored = true; break; }
    }
    if (!restored) return 'restore timeout';
    const originalId = (await (await fetch('/api/session')).json()).academics[0].id;
    if (!await submit('그 회의 취소됐어') || !await submit('그 회의 다시 잡혔어')) return 'chat restore timeout';
    const current = await (await fetch('/api/session')).json();
    latest = [...document.querySelectorAll('.schedule-receipt')].at(-1);
    return current.academics.length === 1 && current.academics[0].id === originalId && current.academics[0].due.endsWith('T16:00') && !current.cancelledAcademicIds.length && latest.textContent.includes('일정을 복구했어') ? true : 'chat restore receipt';
  })()`);
  report.weeklySchedules = await window.webContents.executeJavaScript(`(async () => {
    const submit = async text => {
      document.getElementById('message').value = text;
      document.getElementById('chat-form').requestSubmit();
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!document.getElementById('send').disabled && !document.getElementById('message').value) return true;
      }
      return false;
    };
    if (!await submit('그 회의 매주 월요일 오후 3시로 바꿔줘')) return 'weekly conversion';
    let latest = [...document.querySelectorAll('.schedule-receipt')].at(-1);
    if (!latest.textContent.includes('매주 월요일')) return 'weekly receipt';
    latest.querySelector('button').click();
    if (document.getElementById('academic-repeat').value !== 'weekly') return 'weekly editor';
    document.getElementById('cancel-academic').click();
    if (!await submit('그 회의 매주 화요일 오후 4시로 바꿔줘') || !await submit('그 회의 취소됐어')) return 'weekly change';
    let current = await (await fetch('/api/session')).json();
    if (current.academics.length !== 1 || !current.messages.at(-1).content.includes('반복 전체')) return 'weekly scope question';
    if (!await submit('전체')) return 'weekly cancel';
    current = await (await fetch('/api/session')).json();
    if (current.academics.length !== 0) return 'weekly cancel state';
    if (!await submit('그 회의 다시 잡혔어') || !await submit('전체')) return 'weekly restore';
    current = await (await fetch('/api/session')).json();
    return current.academics.length === 1 && current.academics[0].repeat_weekly === 1 && new Date(current.academics[0].due).getDay() === 2 && current.academics[0].due.endsWith('T16:00') && [...document.querySelectorAll('.schedule-receipt')].at(-1).textContent.includes('매주 화요일') ? true : 'weekly restored state';
  })()`);
  report.occurrenceSchedules = await window.webContents.executeJavaScript(`(async () => {
    const submit = async text => {
      document.getElementById('message').value = text;
      document.getElementById('chat-form').requestSubmit();
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!document.getElementById('send').disabled && !document.getElementById('message').value) return true;
      }
      return false;
    };
    let current = await (await fetch('/api/session')).json();
    const before = current.academics[0], rule = before.series_due, original = before.occurrence_due;
    if (!await submit('그 회의 이번 회차만 오후 5시로 바꿔줘')) return 'occurrence update';
    current = await (await fetch('/api/session')).json();
    let latest = [...document.querySelectorAll('.schedule-receipt')].at(-1);
    if (current.academics[0].series_due !== rule || !current.academics[0].due.endsWith('T17:00') || !latest.textContent.includes('이번 회차만 수정')) return 'occurrence update receipt';
    latest.querySelector('button').click();
    if (!document.getElementById('academic-due').value.endsWith('T16:00')) return 'editor changed the series rule';
    document.getElementById('cancel-academic').click();
    if (!await submit('그 회의 이번 회차만 취소해줘')) return 'occurrence cancel';
    current = await (await fetch('/api/session')).json();
    const next = new Date(original); next.setDate(next.getDate() + 7);
    if (new Date(current.academics[0].due).getTime() !== next.getTime() || current.cancelledAcademicIds.length) return 'next week rule';
    latest = [...document.querySelectorAll('.schedule-receipt')].at(-1);
    const undo = [...latest.querySelectorAll('button')].find(button => button.textContent === '취소 되돌리기');
    if (!undo || !latest.textContent.includes('이번 회차 취소')) return 'occurrence cancel receipt';
    undo.click();
    let restored = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      current = await (await fetch('/api/session')).json();
      if (current.academics[0].due.endsWith('T17:00')) { restored = true; break; }
    }
    if (!restored) return 'occurrence undo';
    if (!await submit('그 회의 이번 회차만 취소해줘') || !await submit('그 회의 다시 잡혔어')) return 'occurrence chat restore';
    current = await (await fetch('/api/session')).json();
    return current.academics.length === 1 && current.academics[0].series_due === rule && current.academics[0].due.endsWith('T17:00') && current.messages.at(-1).schedule_action.scope === 'occurrence' ? true : 'occurrence restored state';
  })()`);
  report.recurrenceSchedules = await window.webContents.executeJavaScript(`(async () => {
    const submit = async text => {
      document.getElementById('message').value = text;
      document.getElementById('chat-form').requestSubmit();
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!document.getElementById('send').disabled && !document.getElementById('message').value) return true;
      }
      return false;
    };
    for (const [type, phrase, label] of [['daily', '매일 오후 4시', '매일'], ['biweekly', '격주 월요일 오후 4시', '격주 월요일'], ['monthly', '매달 31일 오후 4시', '매달 31일']]) {
      if (!await submit('그 회의 ' + phrase + '로 바꿔줘')) return type + ' change';
      let current = await (await fetch('/api/session')).json();
      let latest = [...document.querySelectorAll('.schedule-receipt')].at(-1);
      if (current.academics[0].recurrence !== type || !latest.textContent.includes(label)) return type + ' receipt';
      latest.querySelector('button').click();
      if (document.getElementById('academic-repeat').value !== type) return type + ' editor';
      const monthDay = document.getElementById('academic-month-day');
      if (type === 'monthly' && (monthDay.value !== '31' || !monthDay.getBoundingClientRect().height)) return 'monthly day editor';
      if (type !== 'monthly' && monthDay.getBoundingClientRect().height) return 'monthly control should be hidden';
      document.getElementById('cancel-academic').click();
      if (!await submit('그 회의 취소해줘') || !await submit('전체')) return type + ' cancel';
      current = await (await fetch('/api/session')).json();
      if (current.academics.length) return type + ' cancelled state';
      if (!await submit('그 회의 다시 잡혔어') || !await submit('전체')) return type + ' restore';
      current = await (await fetch('/api/session')).json();
      if (current.academics.length !== 1 || current.academics[0].recurrence !== type) return type + ' restored state';
    }
    const latest = [...document.querySelectorAll('.schedule-receipt')].at(-1);
    latest.querySelector('button').click();
    document.getElementById('academic-notes').value = '반복 주기 시험';
    document.getElementById('academic-form').requestSubmit();
    for (let i = 0; i < 40; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (!document.getElementById('academic-dialog').open) {
        const current = await (await fetch('/api/session')).json();
        return current.academics[0].recurrence === 'monthly' && current.academics[0].monthly_day === 31 && current.academics[0].notes === '반복 주기 시험' ? true : 'monthly save state';
      }
    }
    return 'monthly editor save timeout';
  })()`);
  report.endSchedules = await window.webContents.executeJavaScript(`(async () => {
    const submit = async text => {
      document.getElementById('message').value = text;
      document.getElementById('chat-form').requestSubmit();
      for (let i = 0; i < 60; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (!document.getElementById('send').disabled && !document.getElementById('message').value) return true;
      }
      return false;
    };
    const year = new Date().getFullYear();
    if (!await submit('그 회의 올해 말까지만 해줘')) return 'end change';
    let current = await (await fetch('/api/session')).json();
    const id = current.academics[0].id;
    if (current.academics[0].repeat_until !== year + '-12-31') return 'end value';
    if (!await submit('그 회의 언제까지야?')) return 'end query';
    current = await (await fetch('/api/session')).json();
    if (!current.messages.at(-1).content.includes(year + '-12-31')) return 'query response';
    if (!await submit('그 회의 내년 1월 말까지 연장해줘')) return 'extend';
    const latest = [...document.querySelectorAll('.schedule-receipt')].at(-1);
    if (!latest.textContent.includes((year + 1) + '-01-31')) return 'end receipt';
    latest.querySelector('button').click();
    const end = document.getElementById('academic-repeat-until');
    if (end.value !== (year + 1) + '-01-31' || !end.getBoundingClientRect().height) return 'end editor';
    end.value = (year + 1) + '-02-28';
    document.getElementById('academic-form').requestSubmit();
    for (let i = 0; i < 40 && document.getElementById('academic-dialog').open; i++) await new Promise(resolve => setTimeout(resolve, 100));
    current = await (await fetch('/api/session')).json();
    if (current.academics[0].repeat_until !== (year + 1) + '-02-28') return 'end save';
    if (!await submit('그 회의 종료일 없애줘')) return 'clear end';
    current = await (await fetch('/api/session')).json();
    if (current.academics[0].id !== id || current.academics[0].repeat_until !== null) return 'clear result';
    const dateKey = date => date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    const today = new Date(), yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    const result = await fetch('/api/academic', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Rin-Token': current.token }, body: JSON.stringify({ title: '종료 확인', kind: 'event', due: dateKey(yesterday) + 'T00:00', recurrence: 'daily', repeatUntil: dateKey(today) }) });
    current = await result.json();
    return result.ok && current.endedAcademics.length === 1 && current.academics.length === 1 ? true : 'ended state';
  })()`);
  const endReload = new Promise(resolve => window.webContents.once('did-finish-load', resolve));
  window.webContents.reload(); await endReload;
  for (let i = 0; i < 30; i++) {
    report.endedScheduleUI = await window.webContents.executeJavaScript(`document.getElementById('ended-academic-list')?.textContent.includes('종료 확인') && document.getElementById('ended-academic-list')?.textContent.includes('알림 꺼짐') && !document.getElementById('academic-list')?.textContent.includes('종료 확인')`);
    if (report.endedScheduleUI) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const appBounds = window.getBounds(), widgetBounds = widget.getBounds();
  showSurface('app', 'chat');
  window.setSize(800, 620);
  await new Promise(resolveWait => setTimeout(resolveWait, 250));
  report.appMinimum = await window.webContents.executeJavaScript(`document.documentElement.scrollWidth <= innerWidth && document.getElementById('send').getBoundingClientRect().bottom <= innerHeight && document.getElementById('messages').clientHeight > 100`);
  window.setBounds(appBounds);
  const shared = await smokeSharedSettings();
  report.volumeSetting = shared.volumeSetting;
  report.dualWindow.sharedState = shared.sharedState;
  report.dualWindow.diagnostics.sharedState = shared.diagnostics;
  await widget.webContents.executeJavaScript(`document.getElementById('message').value = ''; document.getElementById('message').dispatchEvent(new Event('input', { bubbles: true }))`);
  showSurface('app', 'chat');
  await new Promise(resolveWait => setTimeout(resolveWait, 350));
  if (smokeScreenshot) writeFileSync(smokeScreenshot.replace(/(\.png)?$/i, '.chat.png'), (await window.webContents.capturePage()).toPNG());
  showSurface('app', 'home');
  await new Promise(resolveWait => setTimeout(resolveWait, 350));
  if (smokeScreenshot) writeFileSync(smokeScreenshot, (await window.webContents.capturePage()).toPNG());
  show('chat');
  await new Promise(resolveWait => setTimeout(resolveWait, 250));
  const widgetImage = await widget.webContents.capturePage(), pixels = widgetImage.toBitmap();
  let transparentPixels = 0, translucentPixels = 0;
  for (let index = 3; index < pixels.length; index += 4) { if (pixels[index] === 0) transparentPixels++; else if (pixels[index] < 255) translucentPixels++; }
  report.dualWindow.transparentPixels = transparentPixels > 0 && pixels[3] === 0 && pixels.at(-1) === 0;
  report.dualWindow.translucentPixels = translucentPixels > pixels.length / 4 * 0.5;
  if (smokeScreenshot) writeFileSync(smokeScreenshot.replace(/(\.png)?$/i, '.widget.png'), widgetImage.toPNG());
  // Exercise a cramped viewport without enabling native resizing on the transparent window.
  widget.setSize(640, 360);
  await new Promise(resolveWait => setTimeout(resolveWait, 250));
  report.compact = await widget.webContents.executeJavaScript(`document.documentElement.scrollWidth <= innerWidth && document.getElementById('send').getBoundingClientRect().bottom <= innerHeight && document.getElementById('messages').clientHeight > 100`);
  report.minimumWindow = report.compact;
  widget.setBounds(widgetBounds);
  report.dualWindow.ok = Object.entries(report.dualWindow).every(([key, value]) => key === 'diagnostics' || value === true);
  report.ok = report.ready && report.bridge && report.backupBridge && report.providerStatus && report.isolated && report.images && !report.overflow && report.controls === 3 && report.volumeSetting && report.secondDisplay && report.chat === true && report.gallery.ok && report.character.ok && report.scheduleChanges === true && report.weeklySchedules === true && report.occurrenceSchedules === true && report.recurrenceSchedules === true && report.endSchedules === true && report.endedScheduleUI && report.compact && report.appMinimum && report.dualWindow.ok;
  if (smokeReport) writeFileSync(smokeReport, JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
  app.quit();
}
app.on('before-quit', () => {
  quitting = true;
  clearTimeout(backendRestartTimer);
  clearTimeout(nextNotificationTimer); clearTimeout(notificationTimer);
  tray?.destroy();
  if (backend?.connected) backend.send('shutdown');
});
app.on('window-all-closed', () => { if (quitting || smoke) app.quit(); });
if (ownsLock) app.whenReady().then(async () => {
  if (notificationPreview) { logPath = join(app.getPath('userData'), 'notification-preview.log'); await runNotificationPreview(); return; }
  const context = readJson(join(__dirname, 'install-context.json'));
  const legacyRoot = context.legacyRoot && existsSync(join(context.legacyRoot, 'data/rin.sqlite')) ? context.legacyRoot : null;
  const dataDir = smoke ? join(app.getPath('userData'), 'data') : legacyRoot ? join(legacyRoot, 'data') : join(app.getPath('userData'), 'data');
  mkdirSync(dataDir, { recursive: true });
  dataPath = join(dataDir, 'rin.sqlite'); logPath = join(dataDir, 'desktop.log');
  windowStatePath = join(app.getPath('userData'), 'window-state.json');
  await startBackend(legacyRoot);
  registerProtocol();
  await createWindow();
  if (!smoke && startupStatus().enabled && !existsSync(startupShortcutPaths().current)) {
    try { setStartup(true); } catch (error) { log(`Startup shortcut migration failed: ${error.message}`); }
  }
  if (smoke) await runSmokeTest();
}).catch(error => {
  log(error.stack || error.message);
  if (smoke && smokeReport) writeFileSync(smokeReport, JSON.stringify({ ok: false, error: error.message }));
  else dialog.showErrorBox('아사를 열지 못했어요', error.message);
  app.quit();
});
