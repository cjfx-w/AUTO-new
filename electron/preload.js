const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autoAPI', {
  bitBrowser: {
    health: (baseUrl) => ipcRenderer.invoke('bitbrowser:health', baseUrl),
    listWindows: (input) => ipcRenderer.invoke('bitbrowser:list', input),
    openWindow: (input) => ipcRenderer.invoke('bitbrowser:open', input),
    closeWindow: (input) => ipcRenderer.invoke('bitbrowser:close', input)
  }
});
