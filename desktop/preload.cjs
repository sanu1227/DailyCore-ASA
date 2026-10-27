const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rinDesktop', Object.freeze({
  minimize: () => ipcRenderer.send('rin:window', 'minimize'),
  maximize: () => ipcRenderer.send('rin:window', 'maximize'),
  close: () => ipcRenderer.send('rin:window', 'close'),
  quit: () => ipcRenderer.send('rin:window', 'quit'),
  openApp: (view = 'home') => ipcRenderer.invoke('rin:open-app', view),
  showWidget: () => ipcRenderer.invoke('rin:show-widget'),
  setClickThrough: enabled => ipcRenderer.send('rin:click-through', enabled),
  widgetPointer: () => ipcRenderer.invoke('rin:widget-pointer'),
  getWidgetSize: () => ipcRenderer.invoke('rin:widget-size', 'get'),
  resizeWidget: (width, height, keepPosition = false) => ipcRenderer.invoke('rin:widget-size', 'set', { width, height, keepPosition }),
  resetWidgetSize: () => ipcRenderer.invoke('rin:widget-size', 'reset'),
  openEclass: () => ipcRenderer.invoke('rin:eclass'),
  openDataFolder: () => ipcRenderer.invoke('rin:data-folder'),
  testNotification: volume => ipcRenderer.invoke('rin:test-notification', volume),
  startupStatus: () => ipcRenderer.invoke('rin:startup-status'),
  setStartup: enabled => ipcRenderer.invoke('rin:set-startup', enabled),
  listBackups: () => ipcRenderer.invoke('rin:backups'),
  restoreBackup: name => ipcRenderer.invoke('rin:restore-backup', name)
}));
