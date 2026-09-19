const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { BitBrowserClient } = require('../src/bitbrowser/client');
const { initDatabase, saveBitBrowserWindows } = require('../src/storage/database');

let mainWindow;
let bitBrowserClient;
let database;
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
    saveBitBrowserWindows(database, result.windows);
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
}

app.whenReady().then(() => {
  database = initDatabase(path.join(app.getPath('userData'), 'auto.sqlite3'));
  bitBrowserClient = new BitBrowserClient();
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
