const APP_ORIGIN = 'http://127.0.0.1:4317';

window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== APP_ORIGIN) return;
  if (event.data?.type !== 'RIN_ECLASS_SYNC_REQUEST' || typeof event.data.requestId !== 'string') return;
  const requestId = event.data.requestId;
  window.postMessage({ type: 'RIN_ECLASS_SYNC_ACCEPTED', requestId }, APP_ORIGIN);
  const reply = result => window.postMessage({ type: 'RIN_ECLASS_SYNC_RESULT', requestId, result }, APP_ORIGIN);
  try {
    chrome.runtime.sendMessage({ type: 'RIN_ECLASS_SYNC' }, response => {
      const error = chrome.runtime.lastError?.message;
      reply(error ? { ok: false, code: 'extension-error', message: '확장 프로그램이 갱신됐어요. 아사 화면을 새로고침해 주세요.' } : response);
    });
  } catch {
    reply({ ok: false, code: 'extension-reloaded', message: '확장 프로그램이 갱신됐어요. 아사 화면을 새로고침해 주세요.' });
  }
});
