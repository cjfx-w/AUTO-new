const fs = require('node:fs');
const path = require('node:path');
const { PinterestValidationError, } = require('../pinterest/errors');
const { extractPinterestAccount } = require('../pinterest/account-board');

const PINTEREST_HOME = 'https://www.pinterest.com/';
const PIN_BUILDER = 'https://www.pinterest.com/pin-builder/';

function isDisconnect(error) {
  return /disconnect|Target page|context or browser has been closed|ECONNRESET/i.test(String(error?.message ?? error));
}

class SingleTaskDryRunService {
  constructor({ chromium, storage, screenshotDir, sleep, now } = {}) {
    this.chromium = chromium;
    this.storage = storage;
    this.screenshotDir = screenshotDir;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = now ?? (() => new Date().toISOString());
  }

  getChromium() { return this.chromium ?? require('playwright').chromium; }

  async snapshot(page) {
    return page.evaluate(() => ({
      url: location.href,
      bodyText: document.body?.innerText?.slice(0, 12000) ?? '',
      profileMarkers: document.querySelectorAll('[data-test-id*="profile" i], [aria-label*="profile" i], [aria-label*="个人" i]').length,
      profileUsername: document.querySelector('[data-test-id="profile-username"], [data-test-id="profileName"]')?.textContent?.trim() ?? '',
      links: [...document.querySelectorAll('a')].slice(0, 1000).map((link) => ({ href: link.href, text: link.innerText, ariaLabel: link.getAttribute('aria-label') }))
    }));
  }

  async screenshot(page, attemptId, step) {
    if (!this.screenshotDir) return null;
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    const safeStep = step.replace(/[^a-zA-Z0-9_-]/g, '_');
    const target = path.join(this.screenshotDir, `${attemptId}-${safeStep}.png`);
    try { await page.screenshot({ path: target, fullPage: true }); return target; } catch { return null; }
  }

  async locateFileInput(page) {
    const candidates = [page.getByLabel(/video|视频|上传/i), page.locator('input[type="file"]')];
    for (const locator of candidates) if (await locator.count()) return locator.first();
    throw new PinterestValidationError('PAGE_CONTROL_NOT_FOUND', '无法确认视频上传控件。');
  }

  async fillFirst(page, patterns, value, step) {
    for (const pattern of patterns) {
      const locator = page.getByLabel(pattern).or(page.getByPlaceholder(pattern));
      if (await locator.count()) { await locator.first().fill(value); return; }
    }
    throw new PinterestValidationError('PAGE_CONTROL_NOT_FOUND', `无法确认${step}控件。`);
  }

  async run({ itemId, bitWindowId, cdpEndpoint } = {}) {
    if (!itemId || !bitWindowId || !cdpEndpoint) throw new PinterestValidationError('INVALID_INPUT', '缺少预演任务、窗口或 CDP 信息。');
    const item = this.storage.getConfirmedImportItem(itemId);
    if (!item) throw new PinterestValidationError('TASK_NOT_CONFIRMED', '只能预演已确认的单视频任务。');
    const account = this.storage.getAccountById(item.account_id);
    if (!account || account.bit_window_id !== bitWindowId) throw new PinterestValidationError('ACCOUNT_MISMATCH', '任务账号与当前 BitBrowser 窗口不一致。');
    const boardCheck = this.storage.validateBoard({ accountId: item.account_id, boardId: item.board_id, boardName: item.board, boardUrl: null });
    if (!boardCheck.valid) throw new PinterestValidationError('BOARD_MISSING', '预演前 Board 校验失败。');
    if (!item.file_path || !fs.existsSync(item.file_path) || !fs.statSync(item.file_path).isFile()) throw new PinterestValidationError('ASSET_MISSING', '视频素材不存在。');

    const attempt = this.storage.createDryRunAttempt({ itemId, bitWindowId, accountId: item.account_id });
    let browser;
    let page;
    let lastError;
    let uploadStarted = false;
    let keepPageOpen = false;
    for (let connectionAttempt = 0; connectionAttempt < 2; connectionAttempt += 1) {
      try {
        browser = await this.getChromium().connectOverCDP(cdpEndpoint, { timeout: 10000 });
        const context = browser.contexts()[0];
        page = await context.newPage();
        await page.goto(PINTEREST_HOME, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await this.step(attempt, page, 'page_opened');
        const identity = extractPinterestAccount(await this.snapshot(page));
        if (identity.account_id !== item.account_id) throw new PinterestValidationError('ACCOUNT_MISMATCH', '当前 Pinterest 账号与任务账号不一致。');
        await this.step(attempt, page, 'account_verified');
        await page.goto(PIN_BUILDER, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const targetBoardPath = new URL(boardCheck.board.board_url).pathname.replace(/\/+$/, '').toLowerCase();
        const boardLinks = page.locator('a[href]').filter({ hasText: item.board });
        let boardControl = null;
        for (let index = 0; index < await boardLinks.count(); index += 1) {
          const candidate = boardLinks.nth(index);
          const href = await candidate.getAttribute('href');
          try { if (new URL(href, page.url()).pathname.replace(/\/+$/, '').toLowerCase() === targetBoardPath) { boardControl = candidate; break; } } catch {}
        }
        if (!boardControl) throw new PinterestValidationError('BOARD_CONTROL_NOT_FOUND', '无法在创建 Pin 页面确认目标 Board。');
        const parentControl = boardControl.locator('xpath=..');
        const parentTag = await parentControl.evaluate((element) => `${element.tagName}:${element.getAttribute('role') || ''}`);
        await (/button|option|menuitem/i.test(parentTag) ? parentControl : boardControl).click();
        const selectedBoard = page.locator('[aria-selected="true"], [data-selected="true"]').filter({ hasText: item.board });
        if (!(await selectedBoard.count())) throw new PinterestValidationError('BOARD_NOT_SELECTED', '无法确认页面已选中目标 Board。');
        if (!await this.selectedBoardMatchesUrl(selectedBoard.first(), boardCheck.board.board_url, page)) throw new PinterestValidationError('BOARD_NOT_SELECTED', '页面选中的 Board 与目标 Board 不一致。');
        await this.step(attempt, page, 'board_selected');
        const fileInput = await this.locateFileInput(page);
        const beforeVideoSources = await page.locator('video').evaluateAll((elements) => elements.map((element) => element.currentSrc || element.src || ''));
        uploadStarted = true;
        await fileInput.setInputFiles(item.file_path);
        const selectedFileName = await fileInput.evaluate((element) => element.files?.[0]?.name ?? '');
        if (selectedFileName !== path.basename(item.file_path)) throw new PinterestValidationError('UPLOAD_NOT_CONFIRMED', '页面未接收本次预演视频文件。');
        const uploadedVideo = page.locator('video').last();
        await uploadedVideo.waitFor({ state: 'visible', timeout: 15000 });
        await page.waitForFunction((previousSources) => {
          const currentSources = [...document.querySelectorAll('video')].map((element) => element.currentSrc || element.src || '');
          return currentSources.length > previousSources.length || currentSources.some((source) => source && !previousSources.includes(source));
        }, beforeVideoSources, { timeout: 15000 });
        const uploadedVideoIndex = await page.locator('video').count() - 1;
        await page.waitForFunction((index) => {
          const video = document.querySelectorAll('video')[index];
          return Boolean(video && video.readyState >= 2 && !/uploading|处理中|上传中|processing/i.test(document.body?.innerText ?? ''));
        }, uploadedVideoIndex, { timeout: 15000 });
        const uploadCompleteMarker = page.locator('[data-upload-state="complete"], [data-status="uploaded"], [aria-label*="upload complete" i], [aria-label*="上传完成" i]');
        if (!(await uploadCompleteMarker.count()) || !(await uploadCompleteMarker.first().isVisible())) throw new PinterestValidationError('UPLOAD_NOT_CONFIRMED', '页面没有明确的上传完成状态。');
        await this.step(attempt, page, 'video_uploaded');
        await this.fillFirst(page, [/title|标题/i], item.title, '标题');
        await this.fillFirst(page, [/description|描述/i], item.description, '描述');
        await this.fillFirst(page, [/link|url|链接/i], item.product_url, '产品链接');
        await this.step(attempt, page, 'content_filled');
        const finalBoard = page.locator('[aria-selected="true"], [data-selected="true"]').filter({ hasText: item.board });
        if (!(await finalBoard.count()) || !await this.selectedBoardMatchesUrl(finalBoard.first(), boardCheck.board.board_url, page)) throw new PinterestValidationError('BOARD_NOT_SELECTED', 'Publish 前未确认目标 Board。');
        const publishButton = page.getByRole('button', { name: /publish|发布/i });
        if (!(await publishButton.count()) || !(await publishButton.first().isEnabled())) throw new PinterestValidationError('PAGE_CONTROL_NOT_FOUND', '无法确认可用的 Publish 控件，已停止预演。');
        await this.step(attempt, page, 'ready_before_publish');
        this.storage.finishDryRunAttempt(attempt.attempt_id, { status: 'ready_before_publish', pageUrl: page.url() });
        keepPageOpen = true;
        return { ...attempt, status: 'ready_before_publish', page_url: page.url() };
      } catch (error) {
        lastError = error;
        if (connectionAttempt === 0 && !uploadStarted && isDisconnect(error)) { await this.sleep(250); continue; }
        const normalized = error instanceof PinterestValidationError ? error : new PinterestValidationError('DRY_RUN_FAILED', `预演失败：${error?.message || '未知页面错误'}`, { cause: error });
        const screenshotPath = page ? await this.screenshot(page, attempt.attempt_id, attempt.current_step || 'failed') : null;
        if (page) this.storage.updateDryRunStep(attempt.attempt_id, attempt.current_step || 'failed', page.url(), screenshotPath);
        this.storage.failDryRunAttempt(attempt.attempt_id, { code: normalized.code, message: normalized.message, pageUrl: page?.url?.() ?? null, screenshotPath });
        throw normalized;
      } finally {
        if (page && !keepPageOpen) await page.close().catch(() => {});
      }
    }
    throw lastError;
  }

  async step(attempt, page, step) {
    attempt.current_step = step;
    const screenshotPath = await this.screenshot(page, attempt.attempt_id, step);
    this.storage.updateDryRunStep(attempt.attempt_id, step, page.url(), screenshotPath);
  }

  async selectedBoardMatchesUrl(locator, expectedUrl, page) {
    const expected = new URL(expectedUrl).pathname.replace(/\/+$/, '').toLowerCase();
    const href = await locator.evaluate((element) => element.getAttribute('href') || element.getAttribute('data-url') || element.closest('a,[data-url]')?.getAttribute('href') || element.closest('a,[data-url]')?.getAttribute('data-url'));
    if (!href) return false;
    try { return new URL(href, page.url()).pathname.replace(/\/+$/, '').toLowerCase() === expected; } catch { return false; }
  }
}

module.exports = { SingleTaskDryRunService, PINTEREST_HOME };
