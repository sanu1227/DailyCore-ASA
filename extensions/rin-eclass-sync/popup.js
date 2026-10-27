const button = document.getElementById('sync');
const status = document.getElementById('status');

button.onclick = () => {
  button.disabled = true;
  button.textContent = '확인 중…';
  status.textContent = 'e-Class Todo를 읽고 있어요.';
  chrome.runtime.sendMessage({ type: 'RIN_ECLASS_SYNC' }, result => {
    const runtimeError = chrome.runtime.lastError?.message;
    if (runtimeError || !result?.ok) {
      status.textContent = result?.message || '확장 프로그램을 다시 로드한 뒤 시도해 주세요.';
      button.disabled = false;
      button.textContent = '다시 시도';
      return;
    }
    status.textContent = `${result.received}개 확인 · 새 일정 ${result.added}개 · 갱신 ${result.updated}개${result.missing ? ` · 완료 확인 ${result.missing}개` : ''}${result.skipped ? ` · 읽지 못한 항목 ${result.skipped}개` : ''}`;
    button.textContent = '동기화 완료';
  });
};
