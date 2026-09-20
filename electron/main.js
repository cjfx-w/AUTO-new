const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { BitBrowserClient } = require('../src/bitbrowser/client');
const { DEFAULT_BASE_URL } = require('../src/bitbrowser/client');
const { PinterestAccountBoardService } = require('../src/pinterest/account-board');
const { buildImportPreview } = require('../src/import/batch-preview');
const { scanProductFolder, buildProductPreview } = require('../src/import/product-folder');
const { SingleTaskDryRunService } = require('../src/dry-run/single-task');
const storage = require('../src/storage/database');

let mainWindow;
let bitBrowserClient;
let database;
let accountBoardService;
let dryRunService;
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
  ipcMain.handle('dry-run:start', async (event, input) => {
    assertTrustedSender(event);
    if (!input || typeof input !== 'object' || (typeof input.itemId !== 'string' && typeof input.taskId !== 'string') || typeof input.windowId !== 'string') throw new Error('预演参数不正确。');
    return dryRunService.run({ itemId: input.itemId, taskId: input.taskId, bitWindowId: input.windowId, allowCreateBoard: Boolean(input.allowCreateBoard), cdpEndpoint: activeCdpEndpoints.get(input.windowId) });
  });
  ipcMain.handle('product:accounts', async (event) => {
    assertTrustedSender(event);
    const discovered = [];
    const windows = await bitBrowserClient.listWindows({ baseUrl: DEFAULT_BASE_URL });
    for (const item of windows.windows.filter((windowItem) => windowItem.is_open)) {
      try {
        let endpoint = activeCdpEndpoints.get(item.window_id);
        if (!endpoint) { const opened = await bitBrowserClient.openWindow({ baseUrl: DEFAULT_BASE_URL, windowId: item.window_id }); endpoint = opened.cdp_endpoint; activeCdpEndpoints.set(item.window_id, endpoint); }
        const result = await accountBoardService.syncBoards({ bitWindowId: item.window_id, windowName: item.window_name, cdpEndpoint: endpoint });
        discovered.push(result.account);
      } catch (error) { discovered.push({ bit_window_id: item.window_id, window_name: item.window_name, verification_state: 'unavailable', error: error.message }); }
    }
    return discovered;
  });
  ipcMain.handle('product:scan-preview', async (event, input) => {
    assertTrustedSender(event);
    if (!input || typeof input !== 'object' || typeof input.folderPath !== 'string') throw new Error('产品导入参数不正确。');
    const assets = await scanProductFolder(input.folderPath, { hashCache: storage.getProductAssetHashCache(database) });
    let currentAccounts = storage.listAccounts(database);
    const selectedAccountIds = Array.isArray(input.selectedAccountIds) ? input.selectedAccountIds : currentAccounts.map((account) => account.account_id);
    const accounts = currentAccounts.filter((account) => selectedAccountIds.includes(account.account_id));
    const boardsByAccount = new Map(accounts.map((account) => [account.account_id, storage.getBoards(database, account.account_id)]));
    const preview = buildProductPreview({ ...input, assets, accounts, boardsByAccount, selectedAccountIds, existingHashes: storage.getProductAssetHashes(database, selectedAccountIds) });
    return { ...preview, duplicate_hashes: [...storage.getProductAssetHashes(database, selectedAccountIds)] };
  });
  ipcMain.handle('product:confirm', async (event, input) => {
    assertTrustedSender(event);
    if (!input || typeof input !== 'object' || !input.productName || !Array.isArray(input.assets) || !Array.isArray(input.selectedAccountIds)) throw new Error('产品确认参数不完整。');
    const currentAccounts = storage.listAccounts(database);
    const snapshotIds = (input.accountSnapshots ?? []).map((account) => account.account_id).sort();
    const selectedIds = [...input.selectedAccountIds].sort();
    if (snapshotIds.join('|') !== selectedIds.join('|')) throw new Error('账号选择已变化，请重新读取并确认账号。');
    const windows = (await bitBrowserClient.listWindows({ baseUrl: DEFAULT_BASE_URL })).windows;
    for (const snapshot of input.accountSnapshots ?? []) {
      const window = windows.find((item) => item.window_id === snapshot.bit_window_id && item.is_open);
      if (!window) throw new Error(`账号窗口已关闭：${snapshot.window_name || snapshot.bit_window_id}`);
      let endpoint = activeCdpEndpoints.get(window.window_id);
      if (!endpoint) { const opened = await bitBrowserClient.openWindow({ baseUrl: DEFAULT_BASE_URL, windowId: window.window_id }); endpoint = opened.cdp_endpoint; activeCdpEndpoints.set(window.window_id, endpoint); }
      const live = await accountBoardService.syncBoards({ bitWindowId: window.window_id, windowName: window.window_name, cdpEndpoint: endpoint });
      if (live.account.account_id !== snapshot.account_id) throw new Error(`账号窗口已切换账号：${window.window_name}`);
    }
    currentAccounts = storage.listAccounts(database);
    const currentById = new Map(currentAccounts.map((account) => [account.account_id, account]));
    const snapshotMap = new Map((input.accountSnapshots ?? []).map((account) => [account.account_id, account]));
    for (const snapshot of input.accountSnapshots ?? []) {
      const current = currentById.get(snapshot.account_id);
      if (!current || current.bit_window_id !== snapshot.bit_window_id || current.pinterest_username !== snapshot.pinterest_username || current.pinterest_profile_url !== snapshot.pinterest_profile_url) throw new Error('账号在预览后发生变化，请重新读取账号。');
    }
    const accounts = currentAccounts.filter((account) => input.selectedAccountIds.includes(account.account_id));
    const assets = input.folderPath ? await require('../src/import/product-folder').scanProductFolder(input.folderPath, { hashCache: storage.getProductAssetHashCache(database) }) : null;
    if (!assets) throw new Error('确认时必须重新提供产品文件夹。');
    const previewAssets = Array.isArray(input.assets) ? input.assets : [];
    const previewAssetKey = (asset) => `${asset.relative_path}:${asset.asset_hash}:${asset.file_size}:${asset.modified_at}`;
    const previewKeys = new Set(previewAssets.map(previewAssetKey));
    if (assets.length !== previewAssets.length || assets.some((asset) => !previewKeys.has(previewAssetKey(asset)))) throw new Error('视频文件在预览后发生变化，请重新扫描。');
    const boardsByAccount = new Map(accounts.map((account) => [account.account_id, storage.getBoards(database, account.account_id)]));
    const preview = buildProductPreview({ ...input, assets: await assets, accounts, boardsByAccount, existingHashes: storage.getProductAssetHashes(database, input.selectedAccountIds) });
    if (preview.errors.length) throw new Error(preview.errors.join(' '));
    const saved = storage.saveProductRun(database, preview);
    return { ...saved, tasks: saved.product_id ? storage.listProductTasks(database, saved.product_id) : [] };
  });
  ipcMain.handle('product:release-lock', (event, input) => {
    assertTrustedSender(event);
    if (!input || typeof input.accountId !== 'string' || typeof input.assetHash !== 'string' || typeof input.productId !== 'string' || input.reason !== 'pre_publish_failed') throw new Error('锁参数不正确。');
    return { released: storage.releasePublicationLock(database, input) };
  });
  ipcMain.handle('product:list-tasks', (event, productId) => {
    assertTrustedSender(event);
    if (typeof productId !== 'string' || !productId.trim()) throw new Error('产品参数不正确。');
    return storage.listProductTasks(database, productId);
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
  dryRunService = new SingleTaskDryRunService({
    storage: {
      getConfirmedImportItem: (itemId) => storage.getConfirmedImportItem(database, itemId),
      getDryRunTask: (input) => storage.getDryRunTask(database, input),
      getAccountById: (accountId) => storage.getAccountById(database, accountId),
      validateBoard: (input) => storage.validateBoard(database, input),
      saveCreatedBoard: (input) => storage.saveCreatedBoard(database, input),
      saveCreatedBoardAndUpdateItem: (input) => storage.saveCreatedBoardAndUpdateItem(database, input),
      updateImportItemBoard: (itemId, boardId, boardName) => storage.updateImportItemBoard(database, itemId, boardId, boardName),
      updateProductTaskBoard: (taskId, boardId, boardName) => storage.updateProductTaskBoard(database, taskId, boardId, boardName),
      releasePublicationLock: (input) => storage.releasePublicationLock(database, input),
      createDryRunAttempt: (input) => storage.createDryRunAttempt(database, input),
      updateDryRunStep: (attemptId, step, pageUrl, screenshotPath) => storage.updateDryRunStep(database, attemptId, step, pageUrl, screenshotPath),
      finishDryRunAttempt: (attemptId, input) => storage.finishDryRunAttempt(database, attemptId, input),
      failDryRunAttempt: (attemptId, input) => storage.failDryRunAttempt(database, attemptId, input)
    },
    screenshotDir: path.join(userDataPath, 'diagnostics', 'phase-04')
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
