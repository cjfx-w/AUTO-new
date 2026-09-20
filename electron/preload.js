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
  },
  imports: {
    previewFolder: (folderPath) => ipcRenderer.invoke('import:preview-folder', folderPath),
    updateItem: (input) => ipcRenderer.invoke('import:update-item', input),
    confirmBatch: (batchId) => ipcRenderer.invoke('import:confirm-batch', batchId),
    listBatches: () => ipcRenderer.invoke('import:list-batches')
  },
  dryRun: {
    start: (input) => ipcRenderer.invoke('dry-run:start', input)
  },
  product: {
    listAccounts: () => ipcRenderer.invoke('product:accounts'),
    scanPreview: (input) => ipcRenderer.invoke('product:scan-preview', input),
    confirm: (input) => ipcRenderer.invoke('product:confirm', input),
    releaseLock: (input) => ipcRenderer.invoke('product:release-lock', input),
    listTasks: (productId) => ipcRenderer.invoke('product:list-tasks', productId)
  }
});
