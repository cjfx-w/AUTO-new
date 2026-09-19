const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autoAPI', {
  bitBrowser: {
    health: (baseUrl) => ipcRenderer.invoke('bitbrowser:health', baseUrl),
    listWindows: (input) => ipcRenderer.invoke('bitbrowser:list', input),
    openWindow: (input) => ipcRenderer.invoke('bitbrowser:open', input),
    closeWindow: (input) => ipcRenderer.invoke('bitbrowser:close', input)
  },
  accounts: {
    identify: (input) => ipcRenderer.invoke('account:identify', input),
    syncBoards: (input) => ipcRenderer.invoke('account:sync-boards', input),
    getSnapshot: (windowId) => ipcRenderer.invoke('account:get-snapshot', windowId),
    getBoards: (accountId) => ipcRenderer.invoke('account:get-boards', accountId),
    validateBoard: (input) => ipcRenderer.invoke('account:validate-board', input)
  }
});
