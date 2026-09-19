const test = require('node:test');
const assert = require('node:assert/strict');
const { BitBrowserClient, normalizeBaseUrl, normalizeWindow } = require('../src/bitbrowser/client');

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

test('normalizes a local API address and window fields without sensitive fields', () => {
  assert.equal(normalizeBaseUrl('127.0.0.1:54345'), 'http://127.0.0.1:54345');
  assert.equal(normalizeBaseUrl('http://localhost:54345'), 'http://localhost:54345');
  assert.throws(() => normalizeBaseUrl('https://example.com:54345'), { code: 'INVALID_URL' });
  assert.throws(() => normalizeBaseUrl('http://user:pass@127.0.0.1:54345'), { code: 'INVALID_URL' });
  assert.deepEqual(normalizeWindow({ id: 'w1', name: '窗口 01', remark: 'demo', status: 1, password: 'x', cookie: 'secret' }), {
    window_id: 'w1', window_name: '窗口 01', remark: 'demo', is_open: true, seq: null
  });
});

test('checks health and reads a paginated window list', async () => {
  const calls = [];
  const client = new BitBrowserClient({
    fetch: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (url.endsWith('/health')) return response({ success: true });
      if (calls.length === 2) return response({ success: true, data: { list: [{ id: 'w1', name: '一号', status: 0 }], total: 2 } });
      return response({ success: true, data: { list: [{ id: 'w2', name: '二号', status: 1 }], total: 2 } });
    }
  });
  await client.health('http://127.0.0.1:54345');
  const result = await client.listWindows({ baseUrl: 'http://127.0.0.1:54345', pageSize: 1 });
  assert.deepEqual(result.windows.map((item) => item.window_id), ['w1', 'w2']);
  assert.equal(calls[1].body.page, 0);
  assert.equal(calls[2].body.page, 1);
});

test('supports ws and http endpoints returned by open', async () => {
  let calls = 0;
  const client = new BitBrowserClient({
    fetch: async (_url, options) => {
      calls += 1;
      assert.deepEqual(JSON.parse(options.body), { id: 'w1', queue: true });
      return response({ success: true, data: { ws: 'ws://127.0.0.1:1234/devtools/browser/x' } });
    }
  });
  const result = await client.openWindow({ windowId: 'w1' });
  assert.equal(result.cdp_endpoint.startsWith('ws://'), true);
  assert.equal(calls, 1);
});

test('accepts an http debug endpoint and rejects invalid retry limits', async () => {
  const client = new BitBrowserClient({
    fetch: async () => response({ success: true, data: { http: '127.0.0.1:4321' } })
  });
  const result = await client.openWindow({ windowId: 'w1' });
  assert.equal(result.cdp_endpoint, '127.0.0.1:4321');
  await assert.rejects(() => client.openWindow({ windowId: 'w1', maxAttempts: Infinity }), { code: 'INVALID_INPUT' });
  await assert.rejects(() => client.listWindows({ maxPages: 0 }), { code: 'INVALID_INPUT' });
});

test('retries a transient health failure a finite number of times', async () => {
  let calls = 0;
  const client = new BitBrowserClient({
    fetch: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('connection reset');
      return response({ success: true });
    },
    sleep: async () => {}
  });
  assert.deepEqual(await client.health('http://127.0.0.1:54345'), { ok: true, status: 'connected' });
  assert.equal(calls, 2);
});

test('stops a malformed unbounded page stream', async () => {
  let calls = 0;
  const client = new BitBrowserClient({
    fetch: async () => {
      calls += 1;
      return response({ success: true, data: { list: [{ id: `w${calls}`, name: '窗口' }] } });
    },
    sleep: async () => {}
  });
  await assert.rejects(() => client.listWindows({ pageSize: 1, maxPages: 2 }), { code: 'PAGINATION_LIMIT' });
  assert.equal(calls, 2);
});

test('does not retry forever when an opened window has no CDP address', async () => {
  let calls = 0;
  const client = new BitBrowserClient({
    fetch: async () => { calls += 1; return response({ success: true, data: {} }); },
    sleep: async () => {}
  });
  await assert.rejects(() => client.openWindow({ windowId: 'w1', maxAttempts: 2 }), { code: 'NO_CDP_ENDPOINT' });
  assert.equal(calls, 2);
});

test('closes a selected window', async () => {
  let body;
  const client = new BitBrowserClient({
    fetch: async (_url, options) => { body = JSON.parse(options.body); return response({ success: true }); }
  });
  assert.deepEqual(await client.closeWindow({ windowId: 'w1' }), { window_id: 'w1', closed: true });
  assert.deepEqual(body, { id: 'w1' });
});
