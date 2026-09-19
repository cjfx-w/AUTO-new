const test = require('node:test');
const assert = require('node:assert/strict');
const { PinterestAccountBoardService, extractPinterestAccount, extractBoards, canonicalBoardUrl } = require('../src/pinterest/account-board');
const { PinterestValidationError } = require('../src/pinterest/errors');
const { canonicalizeBoardQuery } = require('../src/storage/database');

function fakePage(snapshots) {
  let index = 0;
  return {
    async goto(url) { this.url = url; if (url === 'https://www.pinterest.com/') index = 0; },
    async evaluate() { return snapshots[Math.min(index++, snapshots.length - 1)]; },
    async close() {},
    async screenshot() { this.screenshotTaken = true; }
  };
}

function fakeChromium(page, options = {}) {
  let connections = 0;
  return {
    get connections() { return connections; },
    async connectOverCDP() {
      connections += 1;
      if (options.failFirst && connections === 1) throw new Error('browser disconnected');
      return { contexts: () => [{ newPage: async () => page, pages: () => [page] }] };
    }
  };
}

test('extracts a stable Pinterest account from a profile link', () => {
  const account = extractPinterestAccount({
    url: 'https://www.pinterest.com/',
    bodyText: 'Home',
    links: [{ href: 'https://www.pinterest.com/alice/', text: 'Alice', ariaLabel: 'Profile' }]
  });
  assert.equal(account.pinterest_username, 'alice');
  assert.match(account.pinterest_profile_url, /\/alice\/$/);
  assert.equal(account.verification_state, 'verified');
});

test('canonicalizes Pinterest profile hosts and rejects a non-Boards route', async () => {
  const account = extractPinterestAccount({
    url: 'https://de.pinterest.com/',
    bodyText: 'Home',
    links: [{ href: 'https://de.pinterest.com/alice/', text: 'Alice', ariaLabel: 'Profile' }]
  });
  assert.equal(account.pinterest_profile_url, 'https://www.pinterest.com/alice/');
  const page = fakePage([
    { url: 'https://www.pinterest.com/', bodyText: 'Home', links: [{ href: 'https://www.pinterest.com/alice/', text: 'Alice', ariaLabel: 'Profile' }] },
    { url: 'https://www.pinterest.com/alice/pins/', bodyText: 'Pins', links: [{ href: 'https://www.pinterest.com/alice/home-decor/', text: 'Home Decor' }] }
  ]);
  const service = new PinterestAccountBoardService({
    chromium: fakeChromium(page),
    storage: { saveAccountAndBoards: () => assert.fail('should not save'), markBoardSyncFailed: () => {}, getBoards: () => [], validateBoard: () => ({ valid: false }) },
    sleep: async () => {}
  });
  await assert.rejects(() => service.syncBoards({ cdpEndpoint: 'ws://127.0.0.1/devtools', bitWindowId: 'w1' }), { code: 'PAGE_STRUCTURE' });
});

test('distinguishes not logged in from an unrecognized page', () => {
  assert.throws(() => extractPinterestAccount({ url: 'https://www.pinterest.com/login/', bodyText: '', links: [] }), { code: 'NOT_LOGGED_IN' });
  assert.throws(() => extractPinterestAccount({ url: 'https://www.pinterest.com/', bodyText: 'Unexpected page', links: [] }), { code: 'PAGE_STRUCTURE' });
});

test('keeps same-named boards separate by account', () => {
  const first = { account_id: 'a1', pinterest_username: 'alice' };
  const second = { account_id: 'a2', pinterest_username: 'bob' };
  const links = [{ href: 'https://www.pinterest.com/alice/home-decor/', text: 'Home Decor' }];
  assert.equal(extractBoards({ links }, first)[0].account_id, 'a1');
  assert.equal(extractBoards({ links: links.map((link) => ({ ...link, href: link.href.replace('alice', 'bob') })) }, second)[0].account_id, 'a2');
});

test('canonicalizes Board URLs before saving snapshots', () => {
  assert.equal(canonicalBoardUrl('https://de.pinterest.com/alice/home-decor/?foo=1#board'), 'https://www.pinterest.com/alice/home-decor/');
  assert.equal(canonicalBoardUrl('https://user:pass@www.pinterest.com/alice/home-decor/'), null);
  assert.deepEqual(canonicalizeBoardQuery('https://example.com/fake-board'), { valid: false, value: null });
  assert.deepEqual(canonicalizeBoardQuery('https://user:pass@www.pinterest.com/alice/home-decor/'), { valid: false, value: null });
  assert.deepEqual(canonicalizeBoardQuery('https://www.pinterest.com/alice/boards/'), { valid: false, value: null });
  assert.deepEqual(canonicalizeBoardQuery('https://www.pinterest.com/boards/home-decor/'), { valid: false, value: null });
  assert.deepEqual(canonicalizeBoardQuery('https://www.pinterest.com/%62oards/home-decor/'), { valid: false, value: null });
  assert.deepEqual(canonicalizeBoardQuery('https://de.pinterest.com/alice/home-decor/?foo=1'), { valid: true, value: 'https://www.pinterest.com/alice/home-decor/' });
});

test('identifies and syncs boards without reading credentials or cookies', async () => {
  const page = fakePage([
    { url: 'https://www.pinterest.com/', bodyText: 'Home', links: [{ href: 'https://www.pinterest.com/alice/', text: 'Alice', ariaLabel: 'Profile' }] },
    { url: 'https://www.pinterest.com/alice/boards/', bodyText: 'Boards', links: [{ href: 'https://www.pinterest.com/alice/home-decor/', text: 'Home Decor' }] }
  ]);
  const saved = [];
  const service = new PinterestAccountBoardService({
    chromium: fakeChromium(page),
    storage: {
      saveAccountAndBoards: (snapshot) => saved.push(snapshot),
      getBoards: () => [],
      validateBoard: () => ({ valid: false, board: null })
    },
    now: () => '2026-09-19T00:00:00.000Z',
    sleep: async () => {}
  });
  const identified = await service.identifyAccount({ cdpEndpoint: 'ws://127.0.0.1/devtools', bitWindowId: 'w1', windowName: '窗口 1' });
  assert.equal(identified.account.pinterest_username, 'alice');
  const synced = await service.syncBoards({ cdpEndpoint: 'ws://127.0.0.1/devtools', bitWindowId: 'w1', windowName: '窗口 1' });
  assert.equal(synced.boards[0].board_name, 'Home Decor');
  assert.equal(saved.length, 1);
  assert.equal(Object.hasOwn(saved[0].account, 'password'), false);
  assert.equal(Object.hasOwn(saved[0].account, 'cookie'), false);
});

test('retries one CDP disconnect and then succeeds', async () => {
  const page = fakePage([{ url: 'https://www.pinterest.com/', bodyText: 'Home', links: [{ href: 'https://www.pinterest.com/alice/', text: 'Alice', ariaLabel: 'Profile' }] }]);
  const chromium = fakeChromium(page, { failFirst: true });
  const service = new PinterestAccountBoardService({ chromium, sleep: async () => {} });
  const result = await service.identifyAccount({ cdpEndpoint: 'ws://127.0.0.1/devtools', bitWindowId: 'w1' });
  assert.equal(result.account.pinterest_username, 'alice');
  assert.equal(chromium.connections, 2);
});

test('does not save when an existing window is bound to another account', async () => {
  const page = fakePage([
    { url: 'https://www.pinterest.com/', bodyText: 'Home', links: [{ href: 'https://www.pinterest.com/bob/', text: 'Bob', ariaLabel: 'Profile' }] },
    { url: 'https://www.pinterest.com/bob/boards/', bodyText: 'Boards', links: [] }
  ]);
  let markedFailed = false;
  const service = new PinterestAccountBoardService({
    chromium: fakeChromium(page),
    storage: {
      saveAccountAndBoards: () => { throw new PinterestValidationError('ACCOUNT_MISMATCH', '当前窗口登录了其他账号，已阻止覆盖原绑定。'); },
      markBoardSyncFailed: () => { markedFailed = true; },
      getBoards: () => [],
      validateBoard: () => ({ valid: false, board: null })
    },
    sleep: async () => {}
  });
  await assert.rejects(() => service.syncBoards({ cdpEndpoint: 'ws://127.0.0.1/devtools', bitWindowId: 'w1' }), { code: 'ACCOUNT_MISMATCH' });
  assert.equal(markedFailed, false);
});

test('treats an unrecognized Board page as a failure and preserves old data', async () => {
  const page = fakePage([
    { url: 'https://www.pinterest.com/', bodyText: 'Home', links: [{ href: 'https://www.pinterest.com/alice/', text: 'Alice', ariaLabel: 'Profile' }] },
    { url: 'https://www.pinterest.com/alice/pins/', bodyText: 'Unexpected page', links: [] }
  ]);
  const failures = [];
  let saves = 0;
  const service = new PinterestAccountBoardService({
    chromium: fakeChromium(page),
    screenshotDir: 'D:/tmp/phase2',
    storage: {
      saveAccountAndBoards: () => { saves += 1; },
      markBoardSyncFailed: (input) => failures.push(input),
      getBoards: () => [],
      validateBoard: () => ({ valid: false, board: null })
    },
    sleep: async () => {}
  });
  await assert.rejects(() => service.syncBoards({ cdpEndpoint: 'ws://127.0.0.1/devtools', bitWindowId: 'w1' }), { code: 'PAGE_STRUCTURE' });
  assert.equal(saves, 0);
  assert.equal(failures[0].errorState, 'PAGE_STRUCTURE');
  assert.equal(page.screenshotTaken, true);
});
