if (document.querySelector('a[href*="/ilos/lo/logout.acl"]')) {
  chrome.runtime.sendMessage({ type: 'RIN_ECLASS_AUTO_SYNC' }, () => void chrome.runtime.lastError);
}
