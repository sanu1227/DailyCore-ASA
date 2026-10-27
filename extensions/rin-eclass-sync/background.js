const ECLASS_HOME = 'https://eclass.tukorea.ac.kr/ilos/sso/index.jsp';
const rinHeaders = () => ({ 'X-Rin-Extension': chrome.runtime.id });

async function readTodoPage() {
  const normalize = value => (value || '').replace(/\s+/g, ' ').trim();
  const parseDate = value => {
    const match = normalize(value).match(/(\d{4})\.(\d{2})\.(\d{2})\s*(오전|오후)\s*(\d{1,2}):(\d{2})/);
    if (!match) return null;
    let hour = Number(match[5]);
    if (match[4] === '오후' && hour < 12) hour += 12;
    if (match[4] === '오전' && hour === 12) hour = 0;
    return `${match[1]}-${match[2]}-${match[3]}T${String(hour).padStart(2, '0')}:${match[6]}`;
  };
  const categoryKind = category => category === 'test' ? 'exam' : ['report', 'project'].includes(category) ? 'assignment' : 'event';

  if (!document.querySelector('a[href*="/ilos/lo/logout.acl"]')) return { ok: false, code: 'login-required' };
  const launcher = [...document.querySelectorAll('[onclick]')].find(element => /^popTodo\s*\(/.test(element.getAttribute('onclick') || ''));
  const expected = Number.parseInt(normalize(launcher?.textContent), 10);
  if (!Number.isFinite(expected)) return { ok: false, code: 'unsupported-page', message: 'Todo 버튼이 있는 e-Class 메인 화면을 찾지 못했습니다.' };
  try { launcher.click(); }
  catch (error) { return { ok: false, code: 'todo-open-failed', message: error.message || 'Todo 창을 열지 못했습니다.' }; }

  const started = Date.now();
  let rows = [];
  while (Date.now() - started < 10000) {
    rows = [...document.querySelectorAll('#todo_pop .todo_wrap:not(.no_data)')];
    const empty = document.querySelector('#todo_pop .no_data');
    if (rows.length || expected === 0 && (empty || document.querySelector('#todo_pop #todo_list'))) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!rows.length && expected > 0) return { ok: false, code: 'todo-timeout', message: `Todo ${expected}개가 표시되지 않았습니다.` };

  const items = [];
  let skipped = 0;
  for (const row of rows) {
      const action = row.getAttribute('onclick') || '';
      const ids = action.match(/goLecture\('([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\)/);
      const due = parseDate(row.querySelector('.todo_date .todo_date')?.textContent || row.querySelector('.todo_date')?.textContent);
      if (!ids || !due) { skipped += 1; continue; }
      const rawTitle = normalize(row.querySelector('.todo_title')?.textContent);
      const category = ids[3];
      items.push({
        externalId: `${ids[1]}:${category}:${ids[2]}`,
        title: rawTitle.replace(/^\[[^\]]+\]\s*/, '').slice(0, 100),
        course: normalize(row.querySelector('.todo_subjt')?.textContent).slice(0, 60),
        kind: categoryKind(category),
        due,
        notes: 'e-Class Todo에서 가져온 일정'
      });
  }
  if (rows.length && !items.length) return { ok: false, code: 'parse-failed', message: `Todo ${rows.length}개의 형식을 읽지 못했습니다.` };
  return { ok: true, items, expected, skipped };
}

const tabScore = tab => (tab.url?.includes('/ilos/main/main_form.acl') ? 100 : 0) + (tab.active ? 20 : 0) + (tab.lastAccessed || 0) / 1e15;

async function readFromEclassTabs(tabs) {
  const failures = [];
  for (const tab of [...tabs].sort((a, b) => tabScore(b) - tabScore(a))) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: readTodoPage });
      if (result?.ok && Array.isArray(result.items)) return { ...result, tab };
      failures.push({ tab, code: result?.code || 'empty-response', message: result?.message || '' });
    } catch (error) {
      failures.push({ tab, code: 'script-failed', message: error.message || '' });
    }
  }
  return { ok: false, failures };
}

async function syncEclass() {
  const tabs = await chrome.tabs.query({ url: 'https://eclass.tukorea.ac.kr/*' });
  if (!tabs.length) {
    await chrome.tabs.create({ url: ECLASS_HOME });
    return { ok: false, code: 'login-required', message: 'e-Class 탭을 열었어요. 로그인한 뒤 다시 동기화해 주세요.' };
  }
  try {
    const result = await readFromEclassTabs(tabs);
    if (!result.ok) {
      const loginFailure = result.failures.find(item => item.code === 'login-required');
      const usefulFailure = result.failures.find(item => item.message) || result.failures[0];
      if (loginFailure && result.failures.every(item => item.code === 'login-required' || item.code === 'unsupported-page')) {
        await chrome.tabs.update(loginFailure.tab.id, { active: true });
        return { ok: false, code: 'login-required', message: 'e-Class 로그인이 필요해요. 열린 화면에서 로그인한 뒤 다시 눌러 주세요.' };
      }
      return { ok: false, code: usefulFailure?.code || 'read-error', message: usefulFailure?.message || '로그인된 e-Class 메인 화면에서 Todo를 열지 못했습니다.' };
    }
    const tokenResponse = await fetch('http://127.0.0.1:4317/api/eclass/token', { headers: rinHeaders() });
    if (!tokenResponse.ok) throw new Error(`아사 연결이 거절됐습니다. HTTP ${tokenResponse.status}`);
    const { token } = await tokenResponse.json();
    const importResponse = await fetch('http://127.0.0.1:4317/api/eclass/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Rin-Token': token, ...rinHeaders() },
      body: JSON.stringify({ items: result.items, snapshotComplete: result.skipped === 0 })
    });
    const imported = await importResponse.json();
    if (!importResponse.ok) throw new Error(imported.error || '아사에 일정을 저장하지 못했습니다.');
    return { ok: true, received: result.items.length, added: imported.eclass?.added || 0, updated: imported.eclass?.updated || 0, missing: imported.eclass?.missing || 0, skipped: result.skipped || 0 };
  } catch (error) {
    return { ok: false, code: 'read-error', message: `e-Class 일정을 읽지 못했어요. ${error.message || ''}`.trim() };
  }
}

const localDay = () => {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

async function autoSyncEclass() {
  const today = localDay();
  const { lastAutomaticSync } = await chrome.storage.local.get('lastAutomaticSync');
  if (lastAutomaticSync === today) return { ok: true, skipped: true };
  const result = await syncEclass();
  if (result.ok) await chrome.storage.local.set({ lastAutomaticSync: today });
  return result;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['RIN_ECLASS_SYNC', 'RIN_ECLASS_AUTO_SYNC'].includes(message?.type)) return;
  const action = message.type === 'RIN_ECLASS_AUTO_SYNC' ? autoSyncEclass : syncEclass;
  action().then(sendResponse, error => sendResponse({ ok: false, code: 'extension-error', message: error.message }));
  return true;
});

chrome.runtime.onStartup.addListener(() => { autoSyncEclass().catch(() => {}); });
