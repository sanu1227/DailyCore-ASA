import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import policy from '../desktop/policy.cjs';
import { notificationBounds, notificationDuration, notificationHtml } from '../desktop/notification.cjs';

test('notification cards fit the work area and allow enough time to read', () => {
  assert.deepEqual(notificationBounds({ x: -1920, y: 0, width: 1920, height: 1032 }), { x: -500, y: 692, width: 480, height: 320 });
  for (const area of [{ x: 100, y: -500, width: 320, height: 240 }, { x: -100, y: 100, width: 800, height: 600 }]) {
    const rect = notificationBounds(area);
    assert.ok(rect.x >= area.x && rect.y >= area.y);
    assert.ok(rect.x + rect.width <= area.x + area.width && rect.y + rect.height <= area.y + area.height);
  }
  assert.equal(notificationDuration({ body: '짧은 알림', displayDuration: 8500 }), 12000);
  assert.equal(notificationDuration({ body: '긴 안내'.repeat(200) }), 30000);
  const html = notificationHtml({ key: 'event:test', title: '<img src=x onerror=alert(1)>', body: '첫 줄\n<script>alert(1)</script>' }, 'file:///photo.jpg', 12000, 2);
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('다음 알림 2개'));
  assert.ok(html.includes('data-action="snooze"'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('Content-Security-Policy'));
  const review = notificationHtml({ key: 'evening-review:2026-10-22', title: '아사 · 오늘 결산', body: '루틴 2개를 완료했어.' }, 'file:///photo.jpg', 12000);
  assert.ok(review.includes('하루 결산') && review.includes('결산 보기'));
  assert.ok(!review.includes('data-action="snooze"') && !review.includes('25분 집중'));
});

test('widget recovers missing mouse movement without stealing drags or accepting stale coordinates', async () => {
  const source = readFileSync(join(import.meta.dirname, '../public/client.js'), 'utf8');
  const events = {}, changes = [];
  let point = { x: 0, y: 0 }, poll, resolvePointer, reads = 0, cleared = false;
  const document = {
    hidden: false, body: {}, documentElement: { addEventListener() {} }, addEventListener() {},
    querySelector: () => null,
    elementFromPoint: x => ({ closest: () => x === 100 })
  };
  const context = {
    isWidget: true, document,
    $: () => ({ scrollHeight: 100, clientHeight: 100, getBoundingClientRect: () => ({ right: 300 }) }),
    MutationObserver: class { observe() {} },
    setInterval: callback => { poll = callback; return 1; },
    clearInterval: () => { cleared = true; },
    window: {
      addEventListener: (name, callback) => { events[name] = callback; },
      rinDesktop: {
        setClickThrough: value => changes.push(value),
        widgetPointer: async () => { reads++; return point; }
      }
    }
  };
  vm.runInNewContext(source.slice(source.indexOf('  if (isWidget && window.rinDesktop.setClickThrough)'), source.indexOf('  const desktopSettings')), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(changes.at(-1), true);
  point = { x: 100, y: 0 };
  await poll(); // No mousemove, focus or visibility event: input must still recover.
  assert.equal(changes.at(-1), false);
  events.pointerdown({ buttons: 1 });
  point = { x: 0, y: 0 };
  await poll();
  assert.equal(changes.at(-1), false, 'keep a widget drag captured');
  events.pointerup({ buttons: 0 });
  assert.equal(changes.at(-1), true);
  events.mousemove({ clientX: 100, clientY: 0, buttons: 1 });
  point = { x: 100, y: 0 };
  await poll();
  assert.equal(changes.at(-1), true, 'leave a background drag alone');
  events.mousemove({ clientX: 100, clientY: 0, buttons: 0 });
  assert.equal(changes.at(-1), false);
  context.window.rinDesktop.widgetPointer = () => new Promise(resolve => { reads++; resolvePointer = resolve; });
  const pending = poll(), pendingReads = reads;
  await poll();
  assert.equal(reads, pendingReads, 'only one pointer request at a time');
  events.mousemove({ clientX: 0, clientY: 0, buttons: 0 });
  resolvePointer({ x: 100, y: 0 });
  await pending;
  assert.equal(changes.at(-1), true, 'newer movement wins over an old sample');
  document.hidden = true;
  await poll();
  assert.equal(reads, pendingReads, 'hidden widgets do not poll');
  document.hidden = false;
  context.window.rinDesktop.widgetPointer = async () => { throw new Error('temporary IPC failure'); };
  await poll();
  context.window.rinDesktop.widgetPointer = async () => ({ x: 100, y: 0 });
  await poll();
  assert.equal(changes.at(-1), false, 'retry after an IPC failure');
  events.pagehide();
  assert.equal(cleared, true);
});

test('normal launch and shutdown leave independent AI services untouched', () => {
  const read = name => readFileSync(join(import.meta.dirname, '..', name), 'utf8');
  for (const name of ['desktop/main.cjs', 'Start-Rin.ps1', 'Start-Daily-Rin.ps1', 'Open-RinWindow.ps1', 'Stop-Rin.ps1', 'Rin.cmd']) {
    assert.doesNotMatch(read(name), /Start-LocalAI|Start-OmniRoute|startLocalAI|startOmniRoute|OLLAMA|ollama|RIN_OMNIROUTE_API_KEY|aiProcess/, name);
  }
  assert.match(read('desktop/main.cjs'), /env:\s*\{\s*\.\.\.process\.env/);
  assert.match(read('Start-LocalAI.ps1'), /ollama/);
  assert.match(read('Start-OmniRoute.ps1'), /omniroute/);
});

test('Codex status separates connection checks, actual model, timing and actionable failures', () => {
  const source = readFileSync(join(import.meta.dirname, '../public/client.js'), 'utf8');
  const nodes = Object.fromEntries(['provider-status', 'provider-issue', 'provider-detail', 'model'].map(id => [id, {
    children: [], replaceChildren() { this.children = []; }, append(node) { this.children.push(node); }
  }]));
  const context = {
    sending: false, state: { busy: false, settings: { model: 'qwen3:8b' }, providerStatus: {} },
    $: id => nodes[id], el: (_tag, _class, textContent) => ({ textContent })
  };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function renderProviderStatus()'), source.indexOf('function render()')), context);
  const show = value => { context.state.providerStatus = value; vm.runInContext('renderProviderStatus()', context); };
  const checkedAt = '2026-10-19T12:00:00Z';
  show({ codex: { available: true, model: 'configured-model' }, checkedAt });
  assert.equal(nodes['provider-status'].textContent, '아직 AI 응답 기록 없음');
  assert.equal(nodes.model.value, '응답 후 확인');
  const chat = { status: 'success', provider: 'codex', model: 'actual-model', elapsedMs: 900 };
  show({ ...chat, stage: 'chat', firstTokenMs: 250, turnElapsedMs: 1200, stages: { chat }, codex: { available: true }, checkedAt });
  assert.equal(nodes['provider-status'].textContent, '최근 대화 응답: actual-model · Codex · 성공');
  assert.equal(nodes.model.value, 'actual-model');
  assert.ok(nodes['provider-detail'].children.some(node => /첫 글자 0\.3초 · 전체 1\.2초/.test(node.textContent)));
  const reason = 'Codex 사용 한도에 도달했어요. Codex에서 한도와 재개 시간을 확인해 주세요.';
  show({ status: 'failed', provider: 'codex', stage: 'chat', error: reason, codex: { available: false, reason }, checkedAt });
  assert.equal(nodes['provider-issue'].hidden, false);
  assert.equal(nodes['provider-issue'].textContent, reason);
  show({ codex: { available: false }, checkedAt });
  assert.equal(nodes['provider-status'].textContent, 'Codex 연결 확인 필요');
  assert.match(nodes['provider-issue'].textContent, /로그인 상태와 사용 한도/);
  const html = readFileSync(join(import.meta.dirname, '../public/index.html'), 'utf8');
  assert.doesNotMatch(html, /예비 모델|Gemini|Qwen|qwen3|provider-fallback/);
  assert.doesNotMatch(source.slice(source.indexOf('function renderProviderStatus()'), source.indexOf('function render()')), /omniroute|Gemini|Qwen|fallbackReason/);
});

test('desktop navigation accepts only known views and application origins', () => {
  assert.equal(policy.viewFromArguments(['--view=review']), 'review');
  assert.equal(policy.viewFromArguments(['--view=https://evil.example']), 'chat');
  assert.equal(policy.viewFromArguments([]), 'chat');
  assert.equal(policy.validView('home'), true);
  assert.equal(policy.validView('https://evil.example'), false);
  assert.equal(policy.surfaceForView('chat'), 'widget');
  assert.equal(policy.surfaceForView('university'), 'app');
  assert.equal(policy.isAppUrl('rin://app/#home'), true);
  assert.equal(policy.isAppUrl('rin://app/?surface=widget#chat'), true);
  for (const url of ['https://app/', 'rin://app.evil/', 'rin://app:80/', 'file:///C:/private']) assert.equal(policy.isAppUrl(url), false);
});
test('desktop external navigation is limited to school and official profile HTTPS pages', () => {
  assert.equal(policy.isAllowedExternal('https://eclass.tukorea.ac.kr/ilos/main/main_form.acl'), true);
  assert.equal(policy.isAllowedExternal('https://yg-babymonster-official.jp/profile/'), true);
  for (const url of ['file:///C:/Windows/', 'javascript:alert(1)', 'https://eclass.tukorea.ac.kr.evil/', 'http://eclass.tukorea.ac.kr', 'https://user:password@eclass.tukorea.ac.kr', 'https://yg-babymonster-official.jp.evil/profile/', 'http://yg-babymonster-official.jp/profile/', 'https://yg-babymonster-official.jp@evil.example/profile/']) assert.equal(policy.isAllowedExternal(url), false);
});
test('desktop widget defaults follow monitor proportions', () => {
  const workArea = { width: 1920, height: 1032, x: -1920, y: 0 };
  const display = { width: 1920, height: 1080 };
  assert.deepEqual(policy.validBounds({}, workArea, 'widget', display), { width: 1056, height: 594, x: -1488, y: 219 });
  assert.deepEqual(policy.validBounds({ x: 3000, y: 3000 }, { width: 1920, height: 1080, x: -1920, y: -200 }), { width: 1056, height: 594, x: -1056, y: 286 });
  assert.deepEqual(policy.validBounds({}, { width: 3440, height: 1392 }, 'widget', { width: 3440, height: 1440 }), { width: 1280, height: 536, x: 1080, y: 428 });
  assert.deepEqual(policy.validBounds({}, { width: 640, height: 360 }, 'widget', { width: 640, height: 400 }), { width: 576, height: 360, x: 32, y: 0 });
});

test('desktop widget restores independent portrait and wide dimensions', () => {
  const workArea = { width: 1920, height: 1032, x: -1920, y: 0 };
  const display = { width: 1920, height: 1080 };
  assert.deepEqual(policy.validBounds({ width: 480, height: 820, x: -1200, y: 106 }, workArea, 'widget', display), { width: 480, height: 820, x: -1200, y: 106 });
  assert.deepEqual(policy.validBounds({ width: 1500, height: 400 }, workArea, 'widget', display), { width: 1500, height: 400, x: -1710, y: 316 });
  assert.deepEqual(policy.validBounds({ width: 800.4, height: 500.6 }, workArea, 'widget', display), { width: 800, height: 501, x: -1360, y: 266 });
});

test('desktop widget clamps dimensions and position to the current work area', () => {
  assert.deepEqual(policy.validBounds({ width: 3000, height: 2000, x: -3000, y: 1000 }, { width: 640, height: 360, x: -640, y: -200 }), { width: 640, height: 360, x: -640, y: -200 });
  assert.deepEqual(policy.validBounds({ width: 1, height: -1, x: 3000, y: 3000 }, { width: 1920, height: 1080, x: -1920, y: 0 }), { width: 480, height: 360, x: -480, y: 720 });
  assert.deepEqual(policy.validBounds({ width: 800, height: 600 }, { width: 400, height: 300 }), { width: 400, height: 300, x: 0, y: 0 });
});

test('desktop widget uses defaults for malformed dimensions independently', () => {
  const workArea = { width: 1920, height: 1080 };
  for (const invalid of [NaN, Infinity, -Infinity, '800', null, {}, undefined]) {
    assert.deepEqual(policy.validBounds({ width: invalid, height: 400 }, workArea), { width: 1056, height: 400, x: 432, y: 340 });
    assert.deepEqual(policy.validBounds({ width: 800, height: invalid, x: Infinity, y: NaN }, workArea), { width: 800, height: 594, x: 560, y: 243 });
  }
});
test('desktop restored app window fits a smaller display', () => {
  assert.deepEqual(policy.validBounds({ width: 3000, height: 2000 }, { width: 1366, height: 768 }, 'app'), { width: 1366, height: 768, x: 0, y: 0 });
  assert.deepEqual(policy.validBounds({}, { width: 1920, height: 1080, x: 1920, y: 0 }, 'app'), { width: 1180, height: 860, x: 2290, y: 110 });
  assert.deepEqual(policy.validBounds({ width: 300, height: 300 }, { width: 1280, height: 720 }, 'app'), { width: 800, height: 620, x: 240, y: 50 });
  assert.deepEqual(policy.validBounds({}, { width: 600, height: 500 }, 'app'), { width: 600, height: 500, x: 0, y: 0 });
});
test('desktop notifications always use the non-primary display when available', () => {
  const displays = [
    { id: 1, primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { id: 2, primary: false, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } }
  ];
  assert.equal(policy.notificationDisplayId(displays, 1, { x: 100, y: 80, width: 1800, height: 1000 }), 2);
  assert.equal(policy.notificationDisplayId(displays, 2, { x: 2000, y: 100, width: 2400, height: 1300 }), 2);
  assert.equal(policy.notificationDisplayId(displays, 2, null), 2);
  assert.equal(policy.notificationDisplayId([displays[0]], 1, { x: 0, y: 0, width: 1920, height: 1080 }), 1);
  assert.equal(policy.notificationDisplayId(displays, 1, { x: 9000, y: 9000, width: 100, height: 100 }), 2);
});

test('desktop notification art matches the message and avoids an immediate repeat', () => {
  assert.equal(policy.notificationArtPool({ key: 'deadline-start:boot' })[0], 'asa/choom.jpg');
  assert.equal(policy.notificationArtPool({ key: 'briefing:today' })[0], 'asa/choom.jpg');
  assert.equal(policy.notificationArtPool({ key: 'casual:today:1' })[0], 'asa/portrait.jpg');
  assert.equal(policy.notificationArtPool({ key: 'away:session:1' })[0], 'asa/portrait.jpg');
  assert.equal(policy.notificationArtPool({ key: 'routine:sleep', title: '아사 · 잘 시간' })[0], 'asa/supa-dupa-luv.jpg');
  assert.equal(policy.notificationArtPool({ key: 'routine:meal', title: '아사 · 식사 챙겨' })[0], 'asa/portrait.jpg');
  assert.equal(policy.notificationArtPool({ key: 'activity-break:today', title: '아사 · 잠깐 쉬어' })[0], 'asa/supa-dupa-luv.jpg');
  assert.equal(policy.notificationArtPool({ key: 'routine:study', title: '아사 · 공부 시간' })[0], 'asa/choom.jpg');
  assert.equal(policy.notificationArtPool({ key: 'focus-end:today', title: '아사 · 집중 끝났어' })[0], 'asa/moon.jpg');
  const previous = 'asa/portrait.jpg';
  assert.notEqual(policy.chooseNotificationArt({ key: 'casual:today:1' }, previous, () => 0), previous);
});

test('notification gallery covers four official photos and exhausts each theme before reusing one', () => {
  const all = policy.notificationArtPool({});
  assert.deepEqual(all, ['asa/portrait.jpg', 'asa/choom.jpg', 'asa/moon.jpg', 'asa/supa-dupa-luv.jpg']);
  assert.equal(new Set(all).size, 4);
  for (const key of ['', 'briefing:today', 'deadline-start:boot', 'routine:today', 'activity-break:today', 'casual:today', 'focus-end:today']) {
    const candidate = { key }, pool = policy.notificationArtPool(candidate), used = new Set();
    let previous = null;
    for (let index = 0; index < pool.length; index++) {
      const selected = policy.chooseNotificationArt(candidate, previous, () => 0, used);
      assert.ok(pool.includes(selected));
      assert.ok(!used.has(selected), `${key} repeated ${selected} before its theme was exhausted`);
      used.add(selected); previous = selected;
    }
    assert.notEqual(policy.chooseNotificationArt(candidate, previous, () => 0, new Set()), previous);
  }
});

test('switching notification themes does not repeat the previous photo even at a cycle boundary', () => {
  const candidate = { key: 'routine:sleep', title: '잘 시간' };
  const pool = policy.notificationArtPool(candidate), remaining = pool.at(-1), used = new Set(pool.slice(0, -1));
  const next = policy.chooseNotificationArt(candidate, remaining, () => 0, used);
  assert.notEqual(next, remaining);
  used.add(next);
  assert.equal(policy.chooseNotificationArt(candidate, next, () => 0, used), remaining);
});

test('desktop notification sounds are bundled as playable PCM wave files', () => {
  for (const name of ['rin-soft-chime.wav', 'rin-priority-chime.wav', 'rin-review-chime.wav']) {
    const sound = readFileSync(join(import.meta.dirname, '..', 'public', 'assets', 'sounds', name));
    assert.equal(sound.subarray(0, 4).toString(), 'RIFF');
    assert.equal(sound.subarray(8, 12).toString(), 'WAVE');
    assert.equal(sound.readUInt16LE(20), 1);
    assert.equal(sound.readUInt32LE(24), 44_100);
    assert.ok(sound.length > 80_000);
  }
});

test('legacy notification voice assets remain archived', () => {
  const names = [
    'rin-soft-01.wav', 'rin-soft-02.wav', 'rin-soft-03.wav',
    'rin-priority-01.wav', 'rin-priority-02.wav', 'rin-priority-03.wav',
    'rin-review-01.wav', 'rin-review-02.wav'
  ];
  for (const name of names) {
    const voice = readFileSync(join(import.meta.dirname, '..', 'public', 'assets', 'voices', name));
    assert.equal(voice.subarray(0, 4).toString(), 'RIFF');
    assert.equal(voice.subarray(8, 12).toString(), 'WAVE');
    assert.ok(voice.length > 40_000);
  }
});
