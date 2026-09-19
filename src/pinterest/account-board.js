const crypto = require('node:crypto');
const path = require('node:path');
const { PinterestValidationError } = require('./errors');

const PINTEREST_HOME = 'https://www.pinterest.com/';
const IGNORED_PROFILE_SEGMENTS = new Set([
  'about', 'business', 'categories', 'contact', 'downloads', 'explore', 'help', 'ideas', 'legal', 'login', 'news', 'pin', 'press', 'privacy', 'search', 'settings', 'signup', 'terms', 'today'
]);
const IGNORED_BOARD_SEGMENTS = new Set(['about', 'boards', 'followers', 'following', 'pins', 'settings']);

function stableId(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 24);
}

function asAbsoluteUrl(href) {
  try {
    return new URL(href, PINTEREST_HOME).toString();
  } catch {
    return null;
  }
}

function pinterestPathParts(href) {
  const url = asAbsoluteUrl(href);
  if (!url) return [];
  const parsed = new URL(url);
  if (!/(^|\.)pinterest\.com$/i.test(parsed.hostname)) return [];
  return parsed.pathname.split('/').filter(Boolean);
}

function normalizeProfileUrl(href, username) {
  const candidate = asAbsoluteUrl(href);
  if (candidate) return `https://www.pinterest.com/${encodeURIComponent(username)}/`;
  return `${PINTEREST_HOME}${encodeURIComponent(username)}/`;
}

function canonicalBoardUrl(href) {
  const candidate = asAbsoluteUrl(href);
  if (!candidate) return null;
  const url = new URL(candidate);
  if (!/(^|\.)pinterest\.com$/i.test(url.hostname) || url.username || url.password) return null;
  url.protocol = 'https:';
  url.hostname = 'www.pinterest.com';
  url.search = '';
  url.hash = '';
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
}

function extractPinterestAccount(snapshot) {
  const url = String(snapshot?.url ?? '');
  const bodyText = String(snapshot?.bodyText ?? '');
  if (/\/login(?:[/?#]|$)/i.test(url)) {
    throw new PinterestValidationError('NOT_LOGGED_IN', '请先在 BitBrowser 中登录 Pinterest。');
  }

  const candidates = (snapshot?.links ?? []).map((link) => {
    const parts = pinterestPathParts(link.href);
    const username = parts[0];
    return { link, parts, username };
  }).filter(({ username, parts }) => username && parts.length === 1 && !IGNORED_PROFILE_SEGMENTS.has(username.toLowerCase()));

  const currentParts = pinterestPathParts(url);
  const currentUsername = currentParts[0] && snapshot?.profileUsername && snapshot.profileUsername.toLowerCase() === currentParts[0].toLowerCase() && !IGNORED_PROFILE_SEGMENTS.has(currentParts[0].toLowerCase()) ? currentParts[0] : null;
  const semanticCandidates = candidates.filter(({ link }) => /profile|account|头像|个人资料/i.test(`${link.ariaLabel ?? ''} ${link.text ?? ''}`));
  const candidate = semanticCandidates.length === 1 ? semanticCandidates[0] : null;
  const username = currentUsername ?? candidate?.username;
  if (!username) {
    if (/\b(log in|sign up)\b|登录|注册/i.test(bodyText)) throw new PinterestValidationError('NOT_LOGGED_IN', '请先在 BitBrowser 中登录 Pinterest。');
    throw new PinterestValidationError('PAGE_STRUCTURE', '无法识别当前 Pinterest 账号。');
  }

  const profileUrl = normalizeProfileUrl(candidate?.link?.href ?? url, username);
  return {
    account_id: stableId(profileUrl.toLowerCase()),
    pinterest_username: username,
    pinterest_profile_url: profileUrl,
    verification_state: 'verified'
  };
}

function extractBoards(snapshot, account) {
  const username = account.pinterest_username.toLowerCase();
  const boards = new Map();
  for (const link of snapshot?.links ?? []) {
    const parts = pinterestPathParts(link.href);
    if (parts.length !== 2 || parts[0].toLowerCase() !== username || IGNORED_BOARD_SEGMENTS.has(parts[1].toLowerCase())) continue;
    const boardUrl = canonicalBoardUrl(link.href);
    const boardName = String(link.text ?? link.ariaLabel ?? '').trim();
    if (!boardUrl || !boardName) continue;
    const boardId = String(link.boardId ?? link.dataId ?? parts[1]);
    boards.set(boardUrl, {
      account_id: account.account_id,
      board_id: stableId(boardId),
      board_name: boardName,
      board_url: boardUrl,
      synced_at: new Date().toISOString()
    });
  }
  return [...boards.values()];
}

function hasBoardStructure(snapshot, account) {
  try {
    const url = new URL(snapshot?.url ?? PINTEREST_HOME);
    if (!/(^|\.)pinterest\.com$/i.test(url.hostname)) return false;
    const parts = url.pathname.split('/').filter(Boolean);
    return parts.length === 2 && decodeURIComponent(parts[0]).toLowerCase() === account.pinterest_username.toLowerCase() && parts[1].toLowerCase() === 'boards';
  } catch {
    return false;
  }
}

function isCdpDisconnect(error) {
  return /Target page, context or browser has been closed|disconnected|ECONNRESET|connect/i.test(String(error?.message ?? error));
}

class PinterestAccountBoardService {
  constructor({ chromium, storage, screenshotDir, sleep, now } = {}) {
    this.chromium = chromium;
    this.storage = storage;
    this.screenshotDir = screenshotDir;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = now ?? (() => new Date().toISOString());
  }

  getChromium() {
    return this.chromium ?? require('playwright').chromium;
  }

  async readPageSnapshot(page) {
    return page.evaluate(() => ({
      url: location.href,
      bodyText: document.body?.innerText?.slice(0, 20000) ?? '',
      boardMarkers: document.querySelectorAll('[data-test-id*="board" i], [data-test-id*="Board"]').length,
      profileMarkers: document.querySelectorAll('[data-test-id*="profile" i], [aria-label*="profile" i], [aria-label*="个人" i]').length,
      profileUsername: document.querySelector('[data-test-id="profile-username"], [data-test-id="profileName"]')?.textContent?.trim() ?? '',
      links: [...document.querySelectorAll('a')].slice(0, 2000).map((link) => ({
        href: link.href,
        text: link.innerText,
        ariaLabel: link.getAttribute('aria-label'),
        dataId: link.getAttribute('data-test-id')
      }))
    }));
  }

  async withPinterestPage(cdpEndpoint, operation, windowId) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let browser;
      let page;
      try {
        browser = await this.getChromium().connectOverCDP(cdpEndpoint, { timeout: 10000 });
        const context = browser.contexts()[0];
        if (!context) throw new PinterestValidationError('CDP_DISCONNECTED', '无法连接 BitBrowser 窗口。', { retryable: true });
        page = await context.newPage();
        await page.goto(PINTEREST_HOME, { waitUntil: 'domcontentloaded', timeout: 15000 });
        return await operation(page);
      } catch (error) {
        lastError = error;
        if (error instanceof PinterestValidationError && error.code === 'PAGE_STRUCTURE') {
          error.diagnosticPath = await this.capturePageScreenshot(page, windowId);
          throw error;
        }
        if (attempt === 0 && isCdpDisconnect(error)) {
          await this.sleep(250);
          continue;
        }
        throw this.toValidationError(error);
      } finally {
        if (page) await page.close().catch(() => {});
      }
    }
    throw this.toValidationError(lastError);
  }

  async identifyAccount({ cdpEndpoint, bitWindowId, windowName } = {}) {
    if (!cdpEndpoint || !bitWindowId) throw new PinterestValidationError('INVALID_INPUT', '缺少窗口连接信息。');
    try {
      const account = await this.withPinterestPage(cdpEndpoint, async (page) => {
        const snapshot = await this.readPageSnapshot(page);
        return extractPinterestAccount(snapshot);
      }, bitWindowId);
      const binding = { ...account, bit_window_id: bitWindowId, window_name: windowName ?? '', last_verified_at: this.now() };
      this.storage?.saveAccountBinding?.(binding);
      return { account: binding };
    } catch (error) {
      throw await this.captureAndNormalize(error, cdpEndpoint, bitWindowId);
    }
  }

  async syncBoards({ cdpEndpoint, bitWindowId, windowName } = {}) {
    if (!cdpEndpoint || !bitWindowId) throw new PinterestValidationError('INVALID_INPUT', '缺少窗口连接信息。');
    try {
      const result = await this.withPinterestPage(cdpEndpoint, async (page) => {
        const account = extractPinterestAccount(await this.readPageSnapshot(page));
        await page.goto(`${account.pinterest_profile_url}boards/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const boardSnapshot = await this.readPageSnapshot(page);
        if (!hasBoardStructure(boardSnapshot, account)) throw new PinterestValidationError('PAGE_STRUCTURE', '无法识别 Pinterest Board 页面。');
        const boards = extractBoards(boardSnapshot, account);
        return { account, boards };
      }, bitWindowId);
      const account = { ...result.account, bit_window_id: bitWindowId, window_name: windowName ?? '', last_verified_at: this.now() };
      this.storage.saveAccountAndBoards({ account, boards: result.boards });
      return { account, boards: result.boards };
    } catch (error) {
      const normalized = await this.captureAndNormalize(error, cdpEndpoint, bitWindowId);
      if (normalized.code !== 'ACCOUNT_MISMATCH') {
        this.storage.markBoardSyncFailed?.({ bitWindowId, errorState: normalized.code, diagnosticPath: normalized.diagnosticPath ?? null, checkedAt: this.now() });
      }
      throw normalized;
    }
  }

  validateBoard(input) {
    return this.storage.validateBoard(input);
  }

  getBoards(accountId) {
    return this.storage.getBoards(accountId);
  }

  async captureAndNormalize(error) {
    if (error instanceof PinterestValidationError) return error;
    return this.toValidationError(error);
  }

  async capturePageScreenshot(page, windowId) {
    if (!this.screenshotDir) return null;
    try {
      if (!page) return null;
      const filename = path.join(this.screenshotDir, `pinterest-${String(windowId).replace(/[^a-zA-Z0-9_-]/g, '_')}-${Date.now()}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      return filename;
    } catch {
      return null;
    }
  }

  toValidationError(error) {
    if (error instanceof PinterestValidationError) return error;
    if (/Target page, context or browser has been closed|disconnected|connect/i.test(String(error?.message))) {
      return new PinterestValidationError('CDP_DISCONNECTED', 'BitBrowser 窗口连接已断开，请重试。', { cause: error, retryable: true });
    }
    return new PinterestValidationError('PAGE_ERROR', 'Pinterest 页面读取失败，请稍后重试。', { cause: error });
  }
}

module.exports = { PinterestAccountBoardService, extractPinterestAccount, extractBoards, stableId, PINTEREST_HOME, canonicalBoardUrl };
