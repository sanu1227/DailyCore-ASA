const { spawn } = require('node:child_process');
const { join } = require('node:path');
const { createInterface } = require('node:readline');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const handle = window => {
  const bytes = window.getNativeWindowHandle();
  return (bytes.length === 8 ? bytes.readBigUInt64LE() : BigInt(bytes.readUInt32LE())).toString();
};

// A real Windows click must reach the harmless receiver behind the widget.
// Renderer sendInputEvent alone cannot verify native window hit testing.
module.exports = async function smokeWidgetClickThrough({ widget, window, screen, BrowserWindow }) {
  const checks = { blankPassesThrough: false, inputReceivesClick: false, inputReceivesText: false, sendReceivesClick: false, headerPassesThrough: false, reentryReceivesClick: false, captionDragsWindow: false, blankAfterDragPassesThrough: false, resizeShrinksWindow: false, resizeExpandsWindow: false, inputAfterResizeReceivesText: false, blankAfterShrinkPassesThrough: false, blankAfterExpandPassesThrough: false, detailsReceivesClick: false, diagnostics: { events: [] } };
  if (process.platform !== 'win32') return { ...checks, diagnostics: { error: 'Native smoke test requires Windows.' } };
  const originalBounds = widget.getBounds(), originalPinned = widget.isAlwaysOnTop();
  const area = screen.getDisplayMatching(originalBounds).workArea;
  const receiver = new BrowserWindow({ ...area, frame: false, show: false, backgroundColor: '#24332b', skipTaskbar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const native = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'widget-mouse.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let pending, nativeError = '', originalDraft;
  const lines = createInterface({ input: native.stdout });
  lines.on('line', line => {
    if (!pending) return;
    try { const result = JSON.parse(line); pending.resolve(result); }
    catch (error) { pending.reject(error); }
    pending = undefined;
  });
  native.stderr.on('data', data => { nativeError += data.toString(); });
  native.on('error', error => { nativeError = error.message; pending?.reject(error); pending = undefined; });
  native.on('exit', () => { pending?.reject(new Error(nativeError || 'Mouse helper exited.')); pending = undefined; });
  const command = request => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending = undefined; reject(new Error(nativeError || 'Native mouse action timed out.')); }, 15000);
    pending = { resolve: result => { clearTimeout(timer); result.ok ? resolve(result) : reject(new Error(result.error)); }, reject: error => { clearTimeout(timer); reject(error); } };
    native.stdin.write(`${JSON.stringify(request)}\n`, error => { if (error) { pending?.reject(error); pending = undefined; } });
  });
  const toNative = point => screen.dipToScreenPoint({ x: Math.round(point.x), y: Math.round(point.y) });
  const topLeft = toNative(area), bottomRight = toNative({ x: area.x + area.width - 1, y: area.y + area.height - 1 });
  const guard = { bounds: { left: topLeft.x, top: topLeft.y, right: bottomRight.x + 1, bottom: bottomRight.y + 1 }, handles: [handle(receiver), handle(widget)] };
  checks.diagnostics.handles = { receiver: handle(receiver), widget: handle(widget) };
  const mouse = async (action, point, end) => {
    const result = await command({ action, point: toNative(point), ...(end ? { end: toNative(end) } : {}), ...guard });
    await wait(120);
    const bounds = widget.getContentBounds(), local = { x: Math.round(point.x - bounds.x), y: Math.round(point.y - bounds.y) };
    const renderer = await widget.webContents.executeJavaScript(`(() => {
      const point = ${JSON.stringify(local)}, target = document.elementFromPoint(point.x, point.y);
      const style = target && getComputedStyle(target);
      return { point, target: target && { tag: target.tagName, id: target.id, class: target.className, background: style.backgroundColor, pointerEvents: style.pointerEvents, opacity: style.opacity, disabled: target.disabled, rect: target.getBoundingClientRect().toJSON() }, focused: document.hasFocus(), active: document.activeElement?.id, observed: window.__nativeObservedEvents.splice(0), dpr: devicePixelRatio };
    })()`);
    let pixel;
    if (local.x >= 0 && local.y >= 0 && local.x < bounds.width && local.y < bounds.height) {
      const image = await widget.webContents.capturePage({ x: local.x, y: local.y, width: 1, height: 1 });
      pixel = [...image.toBitmap().subarray(0, 4)];
    }
    checks.diagnostics.events.push({ action, point, target: result.target, styles: result.styles, renderer, pixel });
  };
  const localPoint = point => { const bounds = widget.getContentBounds(); return { x: bounds.x + point.x, y: bounds.y + point.y }; };
  const elementPoint = async (selector, fraction = .5) => localPoint(await widget.webContents.executeJavaScript(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = element.getBoundingClientRect(); if (!r.width || !r.height) throw new Error('Smoke target is hidden'); return { x: r.left + r.width * ${fraction}, y: r.top + r.height / 2 }; })()`));
  const receiverClicks = () => receiver.webContents.executeJavaScript('window.clicks.length');
  const checkBlank = async point => {
    const before = await receiverClicks();
    await mouse('click', point);
    return await receiverClicks() === before + 1;
  };
  const showWidget = () => { widget.show(); if (!widget.isVisible()) widget.showInactive(); widget.focus(); };
  try {
    await receiver.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><style>html,body{height:100%;margin:0;background:#24332b;color:white;font:16px sans-serif}p{padding:20px}</style><p>SEOA native click-through verification</p><script>window.clicks=[];addEventListener("click",e=>clicks.push({x:e.clientX,y:e.clientY}));</script>'));
    window.hide(); widget.hide();
    receiver.show(); if (!receiver.isVisible()) receiver.showInactive();
    widget.setAlwaysOnTop(true); showWidget();
    originalDraft = await widget.webContents.executeJavaScript(`(() => {
      const input = document.getElementById('message'); const draft = input.value; input.value = '';
      window.__nativeObservedEvents = [];
      window.__nativeObservedHandler = event => { window.__nativeObservedEvents.push({ type: event.type, x: event.clientX, y: event.clientY, target: event.target?.id || event.target?.className || event.target?.tagName, buttons: event.buttons }); if (window.__nativeObservedEvents.length > 16) window.__nativeObservedEvents.shift(); };
      for (const type of ['mousemove', 'pointerdown', 'pointerup', 'click', 'mouseleave']) window.addEventListener(type, window.__nativeObservedHandler, true);
      window.__nativeSendClicks = 0;
      window.__nativeSendHandler = event => { event.preventDefault(); event.stopImmediatePropagation(); window.__nativeSendClicks++; };
      document.getElementById('send').addEventListener('click', window.__nativeSendHandler, true); return draft;
    })()`);
    await wait(350);
    checks.blankPassesThrough = await checkBlank(localPoint({ x: 8, y: originalBounds.height / 2 }));
    await mouse('click', await elementPoint('#message'));
    checks.inputReceivesClick = await widget.webContents.executeJavaScript(`document.activeElement.id === 'message'`) && widget.isFocused();
    if (checks.inputReceivesClick) {
      await widget.webContents.insertText('native input check');
      checks.inputReceivesText = await widget.webContents.executeJavaScript(`document.getElementById('message').value === 'native input check'`);
    }
    await mouse('click', await elementPoint('#send'));
    checks.sendReceivesClick = await widget.webContents.executeJavaScript('window.__nativeSendClicks === 1');
    const blankHeader = await widget.webContents.executeJavaScript(`(() => { const caption = document.querySelector('.native-caption').getBoundingClientRect(), controls = document.querySelector('.window-controls').getBoundingClientRect(); if (controls.left - caption.right < 12) throw new Error('No empty header region'); return { x: (caption.right + controls.left) / 2, y: 17 }; })()`);
    checks.headerPassesThrough = await checkBlank(localPoint(blankHeader));
    const panelPixel = checks.diagnostics.events.at(-1).pixel;
    checks.translucentBlankPassesThrough = checks.headerPassesThrough && panelPixel[3] > 0 && panelPixel[3] < 255;
    await mouse('click', await elementPoint('#open-chat-menu'));
    const originalTransparency = await widget.webContents.executeJavaScript(`document.getElementById('widget-transparency').value`);
    await mouse('click', await elementPoint('#widget-transparency'));
    checks.transparencyReceivesClick = await widget.webContents.executeJavaScript(`document.getElementById('chat-menu').open && document.getElementById('widget-transparency').value !== ${JSON.stringify(originalTransparency)} && Math.abs(Number(getComputedStyle(document.body, '::before').opacity) - (1 - Number(document.getElementById('widget-transparency').value) / 100)) < .001`);
    await widget.webContents.executeJavaScript(`document.getElementById('widget-transparency').value = ${JSON.stringify(originalTransparency)}; document.getElementById('widget-transparency').dispatchEvent(new Event('input'))`);
    const beforeMenuResize = widget.getBounds();
    const widthFraction = await widget.webContents.executeJavaScript(`(() => { const slider = document.getElementById('widget-width'); return slider.valueAsNumber < (Number(slider.min) + Number(slider.max)) / 2 ? .75 : .25; })()`);
    await mouse('click', await elementPoint('#widget-width', widthFraction));
    const afterMenuResize = widget.getBounds();
    checks.sizeSliderReceivesClick = afterMenuResize.width !== beforeMenuResize.width && afterMenuResize.height === beforeMenuResize.height && await widget.webContents.executeJavaScript(`document.getElementById('widget-width').valueAsNumber === ${afterMenuResize.width}`);
    checks.diagnostics.sizeSlider = { before: beforeMenuResize, after: afterMenuResize };
    await widget.webContents.executeJavaScript(`window.rinDesktop.resizeWidget(${beforeMenuResize.width}, ${beforeMenuResize.height})`);
    widget.setBounds(beforeMenuResize);
    await wait(120);
    await mouse('click', await elementPoint('#close-chat-menu'));
    checks.blankAfterMenuPassesThrough = await checkBlank(localPoint({ x: 8, y: originalBounds.height / 2 }));
    await mouse('move', { x: area.x + 6, y: area.y + 6 });
    await mouse('click', await elementPoint('#message'));
    checks.reentryReceivesClick = await widget.webContents.executeJavaScript(`document.activeElement.id === 'message'`) && widget.isFocused();
    const beforeDrag = widget.getBounds(), caption = await elementPoint('.native-caption');
    const dx = beforeDrag.x + beforeDrag.width + 40 <= area.x + area.width ? 32 : -32;
    const dy = beforeDrag.y + beforeDrag.height + 30 <= area.y + area.height ? 24 : -24;
    await mouse('drag', caption, { x: caption.x + dx, y: caption.y + dy });
    const afterDrag = widget.getBounds();
    // Windows consumes the initial drag-threshold pixels before moving the window.
    checks.captionDragsWindow = Math.sign(afterDrag.x - beforeDrag.x) === Math.sign(dx) && Math.sign(afterDrag.y - beforeDrag.y) === Math.sign(dy) && Math.abs(afterDrag.x - beforeDrag.x - dx) <= 8 && Math.abs(afterDrag.y - beforeDrag.y - dy) <= 8;
    checks.diagnostics.drag = { before: beforeDrag, after: afterDrag, expected: { dx, dy } };
    checks.blankAfterDragPassesThrough = await checkBlank(localPoint({ x: 8, y: originalBounds.height / 2 }));
    // Make room for a shrink even when the saved widget size is already minimal.
    if (afterDrag.width < 600 || afterDrag.height < 440) {
      await widget.webContents.executeJavaScript(`window.rinDesktop.resizeWidget(${Math.max(600, afterDrag.width)}, ${Math.max(440, afterDrag.height)})`);
      await wait(120);
    }
    const beforeResize = widget.getBounds(), grip = await elementPoint('#widget-resize');
    const shrinkX = Math.min(120, beforeResize.width - 480), shrinkY = Math.min(80, beforeResize.height - 360);
    if (shrinkX <= 0 || shrinkY <= 0) throw new Error('No room for native widget resize verification.');
    await mouse('drag', grip, { x: grip.x - shrinkX, y: grip.y - shrinkY });
    const afterShrink = widget.getBounds();
    checks.resizeShrinksWindow = Math.abs(afterShrink.width - (beforeResize.width - shrinkX)) <= 4 && Math.abs(afterShrink.height - (beforeResize.height - shrinkY)) <= 4;
    checks.blankAfterShrinkPassesThrough = await checkBlank(localPoint({ x: 8, y: afterShrink.height / 2 }));
    await mouse('click', await elementPoint('#message'));
    const inputFocused = await widget.webContents.executeJavaScript(`document.activeElement.id === 'message'`) && widget.isFocused();
    if (inputFocused) {
      await widget.webContents.executeJavaScript(`document.getElementById('message').value = ''`);
      await widget.webContents.insertText('resized native input check');
      checks.inputAfterResizeReceivesText = await widget.webContents.executeJavaScript(`document.getElementById('message').value === 'resized native input check'`);
    }
    const smallGrip = await elementPoint('#widget-resize');
    await mouse('drag', smallGrip, { x: smallGrip.x + shrinkX, y: smallGrip.y + shrinkY });
    const afterExpand = widget.getBounds();
    checks.resizeExpandsWindow = Math.abs(afterExpand.width - beforeResize.width) <= 4 && Math.abs(afterExpand.height - beforeResize.height) <= 4;
    checks.blankAfterExpandPassesThrough = await checkBlank(localPoint({ x: 8, y: afterExpand.height / 2 }));
    checks.diagnostics.resize = { before: beforeResize, afterShrink, afterExpand, expected: { dx: shrinkX, dy: shrinkY } };
    await mouse('click', await elementPoint('#open-details'));
    checks.detailsReceivesClick = window.isVisible() && await window.webContents.executeJavaScript(`document.body.dataset.view === 'home'`);
    checks.diagnostics.receiverClicks = await receiver.webContents.executeJavaScript('window.clicks');
  } catch (error) {
    checks.diagnostics.error = error.stack || error.message;
  } finally {
    try { await command({ action: 'restore' }); } catch (error) { checks.diagnostics.restoreError = error.message; }
    native.stdin.end(); lines.close(); native.kill();
    if (!widget.isDestroyed()) {
      if (originalDraft !== undefined) await widget.webContents.executeJavaScript(`document.getElementById('send').removeEventListener('click', window.__nativeSendHandler, true); for (const type of ['mousemove', 'pointerdown', 'pointerup', 'click', 'mouseleave']) window.removeEventListener(type, window.__nativeObservedHandler, true); delete window.__nativeSendHandler; delete window.__nativeSendClicks; delete window.__nativeObservedHandler; delete window.__nativeObservedEvents; document.getElementById('message').value = ${JSON.stringify(originalDraft)}; document.getElementById('message').dispatchEvent(new Event('input', { bubbles: true }))`).catch(() => {});
      widget.setBounds(originalBounds); widget.setAlwaysOnTop(originalPinned); widget.hide();
    }
    if (!window.isDestroyed()) window.hide();
    receiver.destroy();
  }
  return checks;
};
