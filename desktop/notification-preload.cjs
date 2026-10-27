const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  const action = async name => {
    const buttons = [...document.querySelectorAll('button')];
    if (buttons.some(button => button.disabled)) return;
    buttons.forEach(button => { button.disabled = true; });
    try { await ipcRenderer.invoke('rin:notification-action', name); }
    catch { document.getElementById('error').textContent = '처리하지 못했어. 잠깐 뒤에 다시 눌러 줘.'; }
    finally { buttons.forEach(button => { button.disabled = false; }); }
  };
  for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', () => action(button.dataset.action));
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); void action('dismiss'); } });
  document.documentElement.addEventListener('mouseenter', () => ipcRenderer.send('rin:notification-hover', true));
  document.documentElement.addEventListener('mouseleave', () => ipcRenderer.send('rin:notification-hover', false));
  ipcRenderer.on('rin:notification-lifetime', (_event, paused) => {
    document.body.classList.add('running'); document.body.classList.toggle('paused', paused);
  });
  ipcRenderer.on('rin:notification-pending', (_event, count) => {
    document.getElementById('pending').textContent = count ? `다음 알림 ${count}개` : '';
  });
});
