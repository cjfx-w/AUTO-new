const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { BitBrowserClient } = require('../src/bitbrowser/client');
const { PinterestAccountBoardService } = require('../src/pinterest/account-board');
const { buildImportPreview } = require('../src/import/batch-preview');
const storage = require('../src/storage/database');

let mainWindow;
let bitBrowserClient;
let database;
let accountBoardService;
const activeCdpEndpoints = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 720,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'auto.html'));
}

function registerIpc() {
  const assertTrustedSender = (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error('不受信任的窗口请求。');
  };
  ipcMain.handle('bitbrowser:health', (event, baseUrl) => {
    assertTrustedSender(event);
    if (baseUrl !== undefined && typeof baseUrl !== 'string') throw new Error('API 地址参数不正确。');
    return bitBrowserClient.health(baseUrl);
  });
  ipcMain.handle('bitbrowser:list', async (event, input) => {
    assertTrustedSender(event);
    if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) throw new Error('窗口列表参数不正确。');
    const result = await bitBrowserClient.listWindows(input);
    storage.saveBitBrowserWindows(database, result.windows);
    return result;
  });
  ipcMain.handle('bitbrowser:open', async (event, input) => {
    assertTrustedSender(event);
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.windowId !== 'string' || !input.windowId.trim()) throw new Error('打开窗口参数不正确。');
    const result = await bitBrowserClient.openWindow(input);
    activeCdpEndpoints.set(result.window_id, result.cdp_endpoint);
    return result;
  });
  ipcMain.handle('bitbrowser:close', async (event, input) => {
    assertTrustedSender(event);
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.windowId !== 'string' || !input.windowId.trim()) throw new Error('关闭窗口参数不正确。');
    const result = await bitBrowserClient.closeWindow(input);
    activeCdpEndpoints.delete(result.window_id);
    return result;
  });
  ipcMain.handle('account:identify', async (event, input) => {
    assertTrustedSender(event);
    const request = validateAccountWindowInput(input);
    return accountBoardService.identifyAccount({ bitWindowId: request.windowId, ...request, cdpEndpoint: activeCdpEndpoints.get(request.windowId) });
  });
  ipcMain.handle('account:sync-boards', async (event, input) => {
    assertTrustedSender(event);
    const request = validateAccountWindowInput(input);
    return accountBoardService.syncBoards({ bitWindowId: request.windowId, ...request, cdpEndpoint: activeCdpEndpoints.get(request.windowId) });
  });
  ipcMain.handle('account:get-boards', (event, accountId) => {
    assertTrustedSender(event);
    if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('账号参数不正确。');
    return accountBoardService.getBoards(accountId);
  });
  ipcMain.handle('account:get-snapshot', (event, windowId) => {
    assertTrustedSender(event);
    if (typeof windowId !== 'string' || !windowId.trim()) throw new Error('窗口参数不正确。');
    return storage.getAccountSnapshot(database, windowId);
  });
  ipcMain.handle('account:validate-board', (event, input) => {
    assertTrustedSender(event);
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.accountId !== 'string') throw new Error('Board 校验参数不正确。');
    return accountBoardService.validateBoard(input);
  });
  ipcMain.handle('import:preview-folder', async (event, folderPath) => {
    assertTrustedSender(event);
    if (typeof folderPath !== 'string' || !path.isAbsolute(folderPath)) throw new Error('素材文件夹路径不正确。');
    const accounts = storage.listAccounts(database);
    const boardsByAccount = new Map(accounts.map((account) => [account.account_id, storage.getBoards(database, account.account_id)]));
    const preview = await buildImportPreview({ folderPath, accounts, boardsByAccount, existingHashes: storage.listImportAssetHashes(database) });
    const savedBatches = storage.saveImportPreview(database, preview);
    return { ...preview, batches: savedBatches };
  });
  ipcMain.handle('import:update-item', (event, input) => {
    assertTrustedSender(event);
    if (!input || typeof input !== 'object' || typeof input.itemId !== 'string') throw new Error('预览修改参数不正确。');
    return { updated: true, item: storage.updateImportItem(database, input) };
  });
  ipcMain.handle('import:confirm-batch', (event, batchId) => {
    assertTrustedSender(event);
    if (typeof batchId !== 'string' || !batchId.trim()) throw new Error('批次参数不正确。');
    return storage.confirmImportBatch(database, batchId);
  });
  ipcMain.handle('import:list-batches', (event) => {
    assertTrustedSender(event);
    return storage.getImportBatches(database);
  });
}

function validateAccountWindowInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.windowId !== 'string' || !input.windowId.trim()) {
    throw new Error('窗口参数不正确。');
  }
  return { windowId: input.windowId, windowName: typeof input.windowName === 'string' ? input.windowName : '' };
}

app.whenReady().then(() => {
  const userDataPath = app.getPath('userData');
  database = storage.initDatabase(path.join(userDataPath, 'auto.sqlite3'));
  bitBrowserClient = new BitBrowserClient();
  const screenshotDir = path.join(userDataPath, 'diagnostics', 'phase-02');
  fs.mkdirSync(screenshotDir, { recursive: true });
  accountBoardService = new PinterestAccountBoardService({
    storage: {
      saveAccountAndBoards: (snapshot) => storage.saveAccountAndBoards(database, snapshot),
      saveAccountBinding: (account) => storage.saveAccountBinding(database, account),
      markBoardSyncFailed: (input) => storage.markBoardSyncFailed(database, input),
      getBoards: (accountId) => storage.getBoards(database, accountId),
      validateBoard: (input) => storage.validateBoard(database, input)
    },
    screenshotDir
  });
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (database) database.close();
});
