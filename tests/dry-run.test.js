const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SingleTaskDryRunService } = require('../src/dry-run/single-task');
const { stableId } = require('../src/pinterest/account-board');

function serviceWith(overrides = {}) {
  return new SingleTaskDryRunService({
    storage: {
      getConfirmedImportItem: () => ({ item_id: 'i1', account_id: 'a1', board_id: 'b1', board: 'Home Decor', file_path: 'missing.mp4' }),
      getAccountById: () => ({ account_id: 'a1', bit_window_id: 'w1' }),
      validateBoard: () => ({ valid: true }),
      ...overrides
    },
    sleep: async () => {}
  });
}

test('requires a confirmed item before starting a dry run', async () => {
  const service = serviceWith({ getConfirmedImportItem: () => null });
  await assert.rejects(() => service.run({ itemId: 'i1', bitWindowId: 'w1', cdpEndpoint: 'ws://test' }), { code: 'TASK_NOT_CONFIRMED' });
});

test('blocks a dry run when the BitBrowser account does not match', async () => {
  const service = serviceWith({ getAccountById: () => ({ account_id: 'a1', bit_window_id: 'other-window' }) });
  await assert.rejects(() => service.run({ itemId: 'i1', bitWindowId: 'w1', cdpEndpoint: 'ws://test' }), { code: 'ACCOUNT_MISMATCH' });
});

test('rechecks Board before connecting to the browser', async () => {
  const service = serviceWith({ validateBoard: () => ({ valid: false }) });
  await assert.rejects(() => service.run({ itemId: 'i1', bitWindowId: 'w1', cdpEndpoint: 'ws://test' }), { code: 'BOARD_MISSING' });
});

test('runs the single-task dry run to Publish-ready without clicking Publish', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-dry-run-'));
  const videoPath = path.join(tempDir, 'demo.mp4');
  fs.writeFileSync(videoPath, 'video');
  const page = new FakeDryRunPage();
  const accountId = stableId('https://www.pinterest.com/alice/');
  const steps = [];
  let finished;
  const service = new SingleTaskDryRunService({
    chromium: { connectOverCDP: async () => ({ contexts: () => [{ newPage: async () => page }] }) },
    screenshotDir: tempDir,
    storage: {
      getConfirmedImportItem: () => ({ item_id: 'i1', account_id: accountId, board_id: 'b1', board: 'Home Decor', file_path: videoPath, title: 'Title', description: 'Description', product_url: 'https://example.com/p' }),
      getAccountById: () => ({ account_id: accountId, bit_window_id: 'w1' }),
      validateBoard: () => ({ valid: true, board: { board_id: 'b1', board_name: 'Home Decor', board_url: 'https://www.pinterest.com/alice/home-decor/' } }),
      createDryRunAttempt: () => ({ attempt_id: 'attempt-1', current_step: 'started' }),
      updateDryRunStep: (_id, step) => steps.push(step),
      finishDryRunAttempt: (_id, input) => { finished = input; },
      failDryRunAttempt: (_id, input) => { throw new Error(`dry run should not fail: ${JSON.stringify(input)}`); }
    }
  });
  const result = await service.run({ itemId: 'i1', bitWindowId: 'w1', cdpEndpoint: 'ws://test' });
  assert.equal(result.status, 'ready_before_publish');
  assert.equal(page.closed, false);
  assert.equal(page.publishClicked, false);
  assert.equal(finished.status, 'ready_before_publish');
  assert.deepEqual(steps, ['page_opened', 'account_verified', 'board_selected', 'video_uploaded', 'content_filled', 'ready_before_publish']);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

class FakeDryRunLocator {
  constructor(page, kind) { this.page = page; this.kind = kind; }
  first() { return this; }
  last() { return this; }
  nth() { return this; }
  filter() { return this; }
  or() { return this; }
  locator() { return this; }
  async count() { return 1; }
  async click() { if (this.kind === 'board') this.page.boardSelected = true; }
  async fill(value) { this.page.filled.push(value); }
  async setInputFiles(file) { this.page.uploadedFile = file; this.page.videoAdded = true; }
  async waitFor() {}
  async isVisible() { return true; }
  async isEnabled() { return true; }
  async getAttribute(name) { return name === 'href' ? '/alice/home-decor/' : null; }
  async innerText() { return this.kind === 'board' || this.kind === 'selected' ? 'Home Decor' : ''; }
  async evaluate(fn) { return fn({ files: [{ name: path.basename(this.page.uploadedFile || 'demo.mp4') }], getAttribute: (name) => name === 'href' ? '/alice/home-decor/' : null, closest: () => null }); }
  async evaluateAll() { return this.page.videoAdded ? ['blob:demo'] : []; }
}

class FakeDryRunPage {
  constructor() { this.urlValue = 'https://www.pinterest.com/'; this.filled = []; this.videoAdded = false; this.boardSelected = false; this.closed = false; this.publishClicked = false; }
  async goto(url) { this.urlValue = url; }
  url() { return this.urlValue; }
  async evaluate() { return { url: this.urlValue, bodyText: 'Home', profileMarkers: 1, profileUsername: '', links: [{ href: 'https://www.pinterest.com/alice/', text: 'Profile', ariaLabel: 'Profile' }] }; }
  getByLabel(pattern) { return new FakeDryRunLocator(this, /video|上传/i.test(String(pattern)) ? 'file' : 'field'); }
  getByPlaceholder() { return new FakeDryRunLocator(this, 'field'); }
  getByText(pattern) { return new FakeDryRunLocator(this, /uploaded|上传完成/i.test(String(pattern)) ? 'upload-marker' : 'board'); }
  getByRole(_role, options) { return new FakeDryRunLocator(this, /publish|发布/i.test(String(options?.name)) ? 'publish' : 'field'); }
  locator(selector) {
    if (selector === 'video') return new FakeDryRunLocator(this, 'video');
    if (selector.includes('data-upload-state') || selector.includes('data-status')) return new FakeDryRunLocator(this, 'upload-marker');
    if (selector === 'a[href]') return new FakeDryRunLocator(this, 'board');
    if (selector.includes('aria-selected')) return new FakeDryRunLocator(this, 'selected');
    return new FakeDryRunLocator(this, 'field');
  }
  async waitForFunction() {}
  async screenshot() {}
  async close() { this.closed = true; }
}
