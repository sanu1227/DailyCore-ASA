const { writeFileSync } = require('node:fs');

module.exports = async function smokeWidgetStay({ window, widget, startSurfaces, createSurface, windowState, screen, screenshot }) {
  if (!process.argv.includes('--smoke-test')) throw new Error('Widget checks require an isolated smoke profile');
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async condition => {
    for (let i = 0; i < 60; i++) { if (await condition()) return true; await wait(50); }
    return false;
  };
  const evaluate = code => widget.webContents.executeJavaScript(code);
  const displays = screen.getAllDisplays(), primary = screen.getPrimaryDisplay();
  const second = displays.find(display => display.id !== primary.id) || primary;
  const inside = (target, area) => {
    const bounds = target.getBounds();
    return bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height;
  };
  const report = { diagnostics: { displays: displays.map(({ id, label, workArea }) => ({ id, label, workArea })), preferredDisplay: second.id } };
  report.ready = await until(() => evaluate(`!!document.querySelector('.window-controls button') && document.querySelectorAll('#messages .message').length > 0`));
  if (!report.ready) return report;
  startSurfaces(['--background'], 'chat');
  report.backgroundShowsWidgetOnly = await until(() => widget.isVisible() && !window.isVisible());
  report.normalStacking = !widget.isAlwaysOnTop() && !window.isAlwaysOnTop();
  report.secondMonitor = inside(widget, second.workArea);
  report.onlyQuitControl = await evaluate(`document.querySelectorAll('.window-controls button').length === 1 && document.querySelector('.window-controls button').getAttribute('aria-label') === '아사 완전히 종료' && !document.getElementById('pin-widget')`);

  startSurfaces([], 'review');
  report.detailsLaunchKeepsWidget = await until(async () => window.isVisible() && widget.isVisible() && await window.webContents.executeJavaScript(`document.body.dataset.view === 'review'`));
  window.focus();
  await until(() => window.isFocused());
  await wait(300);
  report.detailsKeepsFocus = window.isFocused() && widget.isVisible() && !widget.isAlwaysOnTop();
  widget.hide();
  report.hiddenWidgetReturnsWithoutFocus = await until(() => widget.isVisible() && window.isFocused());
  await window.webContents.executeJavaScript(`window.rinDesktop.minimize(); true`);
  report.appCanMinimize = await until(() => window.isMinimized() && widget.isVisible());
  startSurfaces([], 'review');
  await window.webContents.executeJavaScript(`window.rinDesktop.close(); true`);
  report.detailsCloseKeepsWidget = await until(() => !window.isVisible() && widget.isVisible());
  await evaluate(`window.rinDesktop.minimize(); true`);
  await wait(150);
  report.widgetCannotMinimize = !widget.isMinimized() && widget.isVisible() && !widget.isMinimizable();
  widget.minimize();
  await wait(150);
  report.nativeMinimizeRecovers = await until(() => !widget.isMinimized() && widget.isVisible());

  const originalBounds = widget.getBounds();
  widget.setPosition(primary.workArea.x, primary.workArea.y);
  report.moveStaysOnSecondMonitor = await until(() => inside(widget, second.workArea));
  await evaluate(`window.rinDesktop.resizeWidget(9999, 9999)`);
  report.resizeStaysOnSecondMonitor = inside(widget, second.workArea);
  widget.setBounds(originalBounds);

  // Simulate monitor enumeration changes; never change the user's Windows display settings.
  const getAllDisplays = screen.getAllDisplays;
  try {
    screen.getAllDisplays = () => [primary];
    screen.emit('display-removed', {}, second);
    report.singleMonitorFallback = await until(() => inside(widget, primary.workArea) && widget.isVisible());
    screen.getAllDisplays = getAllDisplays;
    screen.emit('display-added', {}, second);
    report.reconnectedMonitor = await until(() => inside(widget, second.workArea) && widget.isVisible());
    widget.setPosition(second.workArea.x - 100, second.workArea.y - 100);
    screen.emit('display-metrics-changed', {}, second, ['workArea']);
    report.workAreaChange = await until(() => inside(widget, second.workArea));
  } finally { screen.getAllDisplays = getAllDisplays; widget.setBounds(originalBounds); }

  const saved = windowState.widget;
  let restored;
  try {
    windowState.widget = { ...originalBounds, x: primary.workArea.x, y: primary.workArea.y, pinned: true };
    restored = createSurface('widget');
    report.legacyPinnedStateIgnored = !restored.isAlwaysOnTop() && inside(restored, second.workArea) && !restored.isMinimizable();
  } finally { restored?.destroy(); windowState.widget = saved; }

  startSurfaces([], 'chat');
  await until(() => widget.isFocused());
  await wait(250);
  const point = await evaluate(`(() => { const r = document.getElementById('message').getBoundingClientRect(); return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height / 2) }; })()`);
  widget.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  widget.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  widget.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  report.inputFocus = await until(() => evaluate(`document.activeElement.id === 'message'`));
  report.diagnostics.input = await evaluate(`({ focused: document.hasFocus(), active: document.activeElement.id, point: ${JSON.stringify(point)}, element: document.elementFromPoint(${point.x}, ${point.y})?.id, input: document.getElementById('message').getBoundingClientRect().toJSON() })`);
  await widget.webContents.insertText('위젯 유지 확인');
  report.inputText = await evaluate(`document.getElementById('message').value === '위젯 유지 확인'`);
  await evaluate(`document.getElementById('message').value = ''; document.activeElement.blur(); true`);
  if (screenshot) {
    await wait(300);
    writeFileSync(screenshot, (await widget.webContents.capturePage()).toPNG());
  }
  report.diagnostics.finalBounds = widget.getBounds();
  return report;
};
