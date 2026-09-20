const fs = require('node:fs');
const path = require('node:path');
const { PinterestValidationError, } = require('../pinterest/errors');
const { extractPinterestAccount } = require('../pinterest/account-board');
const { stableId } = require('../pinterest/account-board');

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

  async run({ itemId, taskId, bitWindowId, cdpEndpoint, allowCreateBoard = false } = {}) {
    if ((!itemId && !taskId) || !bitWindowId || !cdpEndpoint) throw new PinterestValidationError('INVALID_INPUT', '缺少预演任务、窗口或 CDP 信息。');
    const item = this.storage.getDryRunTask ? this.storage.getDryRunTask({ taskId, itemId }) : this.storage.getConfirmedImportItem(itemId);
    if (!item) throw new PinterestValidationError('TASK_NOT_CONFIRMED', '只能预演已确认的单视频任务。');
    const account = this.storage.getAccountById(item.account_id);
    if (!account || account.bit_window_id !== bitWindowId) throw new PinterestValidationError('ACCOUNT_MISMATCH', '任务账号与当前 BitBrowser 窗口不一致。');
    let boardCheck = this.storage.validateBoard({ accountId: item.account_id, boardId: item.board_id, boardName: item.board, boardUrl: null });
    if (!boardCheck.valid) boardCheck = this.storage.validateBoard({ accountId: item.account_id, boardId: null, boardName: item.board, boardUrl: null });
    if (!boardCheck.valid && !allowCreateBoard) throw new PinterestValidationError('BOARD_CREATION_CONFIRM_REQUIRED', `当前账号不存在 Board“${item.board}”，是否创建？`);
    if (boardCheck.valid && boardCheck.board?.board_id && item.board_id !== boardCheck.board.board_id) {
      if (item.task_id) this.storage.updateProductTaskBoard?.(item.task_id, boardCheck.board.board_id, boardCheck.board.board_name);
      else this.storage.updateImportItemBoard?.(item.item_id, boardCheck.board.board_id, boardCheck.board.board_name);
    }
    if (!item.file_path || !fs.existsSync(item.file_path) || !fs.statSync(item.file_path).isFile()) throw new PinterestValidationError('ASSET_MISSING', '视频素材不存在。');

    const effectiveTaskId = item.task_id ?? taskId ?? item.item_id;
    if (!effectiveTaskId) throw new PinterestValidationError('INVALID_INPUT', '预演任务缺少唯一任务 ID。');
    const attempt = this.storage.createDryRunAttempt({ itemId: item.item_id ?? effectiveTaskId, taskId: item.task_id ?? taskId ?? null, bitWindowId, accountId: item.account_id });
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
        if (!boardCheck.valid) {
          boardCheck = await this.createBoardAndRefresh(page, item, account);
        }
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
        if (item.product_url) await this.fillFirst(page, [/link|url|链接/i], item.product_url, '产品链接');
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
        if (item.product_id && item.asset_hash) this.storage.releasePublicationLock?.({ productId: item.product_id, accountId: item.account_id, assetHash: item.asset_hash, reason: 'pre_publish_failed' });
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

  async createBoardAndRefresh(page, item, account) {
    await page.goto(PINTEREST_HOME, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const currentIdentity = extractPinterestAccount(await this.snapshot(page));
    if (currentIdentity.account_id !== item.account_id) throw new PinterestValidationError('ACCOUNT_MISMATCH', '创建 Board 前当前账号发生变化。');
    await page.goto(`${account.pinterest_profile_url}boards/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const currentLinks = await this.findBoardLink(page, item.board);
    for (const link of currentLinks) {
      const href = await link.getAttribute('href');
      if (!href) continue;
      const parsed = new URL(href, page.url());
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts.length === 2 && parts[0].toLowerCase() === account.pinterest_username.toLowerCase()) {
        const boardUrl = `https://www.pinterest.com/${parts[0]}/${parts[1]}/`;
        const boardId = stableId(parts[1]);
        (this.storage.saveCreatedBoardAndUpdateItem ?? ((input) => { this.storage.saveCreatedBoard(input); if (input.taskId) this.storage.updateProductTaskBoard?.(input.taskId, input.boardId, input.boardName); else this.storage.updateImportItemBoard?.(input.itemId, input.boardId, input.boardName); }))({ accountId: item.account_id, boardId, boardName: item.board, boardUrl, itemId: item.item_id, taskId: item.task_id });
        return { valid: true, board: { account_id: item.account_id, board_id: boardId, board_name: item.board, board_url: boardUrl } };
      }
    }
    await page.goto(PIN_BUILDER, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const createButton = page.getByRole('button', { name: /create board|创建.*board|创建看板/i });
    if (!(await createButton.count())) throw new PinterestValidationError('BOARD_CREATE_FAILED', '无法确认创建 Board 控件。');
    await createButton.first().click();
    const nameInput = page.getByLabel(/board name|名称/i).or(page.getByPlaceholder(/board name|名称/i));
    if (!(await nameInput.count())) throw new PinterestValidationError('BOARD_CREATE_FAILED', '无法确认 Board 名称输入框。');
    await nameInput.first().fill(item.board);
    const confirmButton = page.getByRole('button', { name: /create|创建/i });
    if (!(await confirmButton.count())) throw new PinterestValidationError('BOARD_CREATE_FAILED', '无法确认创建按钮。');
    await confirmButton.last().click();
    await page.goto(`${account.pinterest_profile_url}boards/`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    let boardLinks = await this.findBoardLink(page, item.board);
    let boardLinkCount = boardLinks.length;
    for (let attempt = 0; attempt < 10 && !boardLinkCount; attempt += 1) { await page.waitForTimeout(1000); boardLinks = await this.findBoardLink(page, item.board); boardLinkCount = boardLinks.length; }
    if (!boardLinkCount) throw new PinterestValidationError('BOARD_CREATE_FAILED', 'Board 创建后重新读取失败。');
    const boardLink = boardLinks[0];
    await boardLink.waitFor({ state: 'visible', timeout: 10000 });
    const href = await boardLink.getAttribute('href');
    if (!href) throw new PinterestValidationError('BOARD_CREATE_FAILED', '创建成功但无法读取 Board 地址。');
    const parsedBoardUrl = new URL(href, page.url());
    if (!/(^|\.)pinterest\.com$/i.test(parsedBoardUrl.hostname) || parsedBoardUrl.username || parsedBoardUrl.password) throw new PinterestValidationError('BOARD_CREATE_FAILED', '创建后读取到的 Board 地址不是安全的 Pinterest 地址。');
    parsedBoardUrl.protocol = 'https:';
    parsedBoardUrl.hostname = 'www.pinterest.com';
    parsedBoardUrl.search = '';
    parsedBoardUrl.hash = '';
    parsedBoardUrl.pathname = `${parsedBoardUrl.pathname.replace(/\/+$/, '')}/`;
    const boardUrl = parsedBoardUrl.toString();
    const identity = extractPinterestAccount(await this.snapshot(page));
    if (identity.account_id !== item.account_id) throw new PinterestValidationError('ACCOUNT_MISMATCH', '创建 Board 后当前账号发生变化。');
    const boardPath = new URL(boardUrl).pathname.split('/').filter(Boolean);
    if (boardPath.length !== 2 || boardPath[0].toLowerCase() !== identity.pinterest_username.toLowerCase()) throw new PinterestValidationError('BOARD_CREATE_FAILED', '重新读取到的 Board 不属于当前账号。');
    const boardId = stableId(boardPath[1]);
    (this.storage.saveCreatedBoardAndUpdateItem ?? ((input) => { this.storage.saveCreatedBoard(input); if (input.taskId) this.storage.updateProductTaskBoard?.(input.taskId, input.boardId, input.boardName); else this.storage.updateImportItemBoard?.(input.itemId, input.boardId, input.boardName); }))({ accountId: item.account_id, boardId, boardName: item.board, boardUrl, itemId: item.item_id, taskId: item.task_id });
    await page.goto(PIN_BUILDER, { waitUntil: 'domcontentloaded', timeout: 15000 });
    return { valid: true, board: { account_id: item.account_id, board_id: boardId, board_name: item.board, board_url: boardUrl } };
  }

  async findBoardLink(page, boardName) {
    const links = page.locator('a[href]');
    const matches = [];
    for (let index = 0; index < await links.count(); index += 1) {
      const link = links.nth(index);
      if ((await link.innerText()).trim().toLowerCase() === boardName.toLowerCase()) matches.push(link);
    }
    return matches;
  }
}

module.exports = { SingleTaskDryRunService, PINTEREST_HOME };
