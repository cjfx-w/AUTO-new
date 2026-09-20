const { BitBrowserError, classifyError } = require('./errors');

const DEFAULT_BASE_URL = 'http://127.0.0.1:54345';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_PAGE_COUNT = 100;
const MAX_ATTEMPT_COUNT = 3;

function boundedInteger(value, fallback, max, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) throw new BitBrowserError('INVALID_INPUT', `${field} 参数不正确。`);
  return Math.min(value, max);
}

function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  const raw = String(value).trim();
  if (!raw) return DEFAULT_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withProtocol);
  if (!['http:', 'https:'].includes(url.protocol)) throw new BitBrowserError('INVALID_URL', 'API 地址格式不正确。');
  const hostname = url.hostname.toLowerCase();
  const loopback = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!loopback.has(hostname) || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new BitBrowserError('INVALID_URL', 'BitBrowser API 只能使用本机地址。');
  }
  return url.toString().replace(/\/$/, '');
}

function extractData(payload) {
  if (payload && typeof payload === 'object' && 'data' in payload) return payload.data;
  return payload;
}

function assertSuccess(payload, endpoint) {
  if (payload?.success === false || payload?.code === 0 && payload?.success === false) {
    throw new BitBrowserError('API_ERROR', `BitBrowser ${endpoint} 返回失败。`);
  }
  return payload;
}

function normalizeWindow(item) {
  const rawOpenState = item?.opened ?? item?.isOpen ?? item?.open ?? item?.status ?? item?.state;
  const normalizedOpenState = typeof rawOpenState === 'boolean'
    ? rawOpenState
    : typeof rawOpenState === 'number'
      ? rawOpenState === 1
      : ['open', 'opened', 'running', 'active', '1', 'true'].includes(String(rawOpenState ?? '').trim().toLowerCase());
  return {
    window_id: String(item?.id ?? item?.browserId ?? item?.browser_id ?? ''),
    window_name: String(item?.name ?? item?.browserName ?? item?.title ?? ''),
    remark: String(item?.remark ?? ''),
    is_open: normalizedOpenState,
    seq: item?.seq ?? null
  };
}

function normalizePortEndpoint(value) {
  const endpoint = value?.ws ?? value?.websocket ?? value?.webSocketDebuggerUrl ?? value?.http ?? value?.port ?? value;
  if (typeof endpoint !== 'string' && typeof endpoint !== 'number') return null;
  const text = String(endpoint).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return `http://127.0.0.1:${text}`;
  if (/^(?:https?|ws):\/\//i.test(text)) return text;
  if (/^127\.0\.0\.1:\d+$/.test(text)) return `http://${text}`;
  return null;
}

function normalizeOpenPortEntries(data) {
  const rows = Array.isArray(data) ? data : (data?.list ?? data?.rows ?? data?.ports ?? null);
  if (Array.isArray(rows)) {
    return rows.map((item) => ({
      window_id: String(item?.id ?? item?.browserId ?? item?.browser_id ?? ''),
      cdp_endpoint: normalizePortEndpoint(item)
    })).filter((item) => item.window_id && item.cdp_endpoint);
  }
  if (data && typeof data === 'object') {
    return Object.entries(data).map(([windowId, value]) => ({
      window_id: String(windowId),
      cdp_endpoint: normalizePortEndpoint(value)
    })).filter((item) => item.window_id && item.cdp_endpoint);
  }
  return [];
}

class BitBrowserClient {
  constructor(options = {}) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.minRequestIntervalMs = options.minRequestIntervalMs ?? 50;
    this.requestTail = Promise.resolve();
  }

  async request(baseUrl, endpoint, body = {}) {
    const run = this.requestTail.then(async () => {
      const waitMs = this.minRequestIntervalMs - (Date.now() - (this.lastRequestAt ?? 0));
      if (waitMs > 0) await this.sleep(waitMs);
      this.lastRequestAt = Date.now();
      const result = await this.requestRaw(baseUrl, endpoint, body);
      this.lastRequestAt = Date.now();
      return result;
    });
    this.requestTail = run.catch(() => {});
    return run;
  }

  async requestRaw(baseUrl, endpoint, body = {}) {
    const url = `${normalizeBaseUrl(baseUrl)}${endpoint}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch (error) {
        throw new BitBrowserError('INVALID_RESPONSE', `BitBrowser ${endpoint} 返回了无效数据。`, { cause: error });
      }
      if (!response.ok) throw new BitBrowserError('HTTP_ERROR', `BitBrowser ${endpoint} 请求失败（${response.status}）。`, { retryable: response.status >= 500 });
      return assertSuccess(payload, endpoint);
    } catch (error) {
      throw classifyError(error);
    } finally {
      clearTimeout(timeout);
    }
  }

  async requestWithRetry(baseUrl, endpoint, body = {}, maxAttempts = 2) {
    let last;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.request(baseUrl, endpoint, body);
      } catch (error) {
        last = error;
        if (!error.retryable || attempt === maxAttempts) throw error;
        await this.sleep(150 * attempt);
      }
    }
    throw last;
  }

  async health(baseUrl) {
    await this.requestWithRetry(baseUrl, '/health');
    return { ok: true, status: 'connected' };
  }

  async listWindows(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new BitBrowserError('INVALID_INPUT', '窗口列表参数不正确。');
    const { baseUrl = DEFAULT_BASE_URL, pageSize = 100 } = options;
    const effectivePageSize = boundedInteger(pageSize, 100, 100, 'pageSize');
    const maxPages = boundedInteger(options.maxPages, MAX_PAGE_COUNT, MAX_PAGE_COUNT, 'maxPages');
    const windows = [];
    const seenPages = new Set();
    let page = 0;
    while (page < maxPages) {
      const payload = await this.requestWithRetry(baseUrl, '/browser/list', { page, pageSize: effectivePageSize, sort: 'asc' });
      const data = extractData(payload);
      const rows = Array.isArray(data) ? data : (data?.list ?? data?.rows ?? data?.data ?? []);
      const normalizedRows = rows.map(normalizeWindow).filter((item) => item.window_id);
      const pageKey = normalizedRows.map((item) => item.window_id).join('|');
      if (pageKey && seenPages.has(pageKey)) break;
      if (pageKey) seenPages.add(pageKey);
      windows.push(...normalizedRows);
      const total = Number(data?.total ?? data?.totalCount ?? data?.count ?? 0);
      if (rows.length === 0 || rows.length < effectivePageSize || (total > 0 && windows.length >= total)) break;
      page += 1;
    }
    if (page >= maxPages) throw new BitBrowserError('PAGINATION_LIMIT', 'BitBrowser 窗口列表页数异常，已停止读取。');
    return { windows };
  }

  async listOpenPorts(options = {}) {
    const { baseUrl = DEFAULT_BASE_URL } = options;
    const payload = await this.requestWithRetry(baseUrl, '/browser/ports', {});
    return { endpoints: normalizeOpenPortEntries(extractData(payload)) };
  }

  async openWindow(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new BitBrowserError('INVALID_INPUT', '打开窗口参数不正确。');
    const { baseUrl = DEFAULT_BASE_URL, windowId } = options;
    const maxAttempts = boundedInteger(options.maxAttempts, MAX_ATTEMPT_COUNT, MAX_ATTEMPT_COUNT, 'maxAttempts');
    if (typeof windowId !== 'string' || !windowId.trim()) throw new BitBrowserError('INVALID_WINDOW_ID', '请选择要打开的窗口。');
    let last;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const payload = await this.request(baseUrl, '/browser/open', { id: windowId, queue: true });
        const data = extractData(payload) ?? {};
        const cdpEndpoint = data.ws ?? data.websocket ?? data.webSocketDebuggerUrl ?? data.http;
        if (cdpEndpoint) return { window_id: String(windowId), cdp_endpoint: cdpEndpoint, opened_at: new Date().toISOString() };
        last = new BitBrowserError('NO_CDP_ENDPOINT', '窗口已返回，但没有可用的临时连接地址。');
      } catch (error) {
        last = error;
        if (!error.retryable && !/opening|starting/i.test(error.message)) break;
      }
      if (attempt < maxAttempts) await this.sleep(250 * attempt);
    }
    throw last ?? new BitBrowserError('OPEN_FAILED', '窗口打开失败。');
  }

  async closeWindow(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new BitBrowserError('INVALID_INPUT', '关闭窗口参数不正确。');
    const { baseUrl = DEFAULT_BASE_URL, windowId } = options;
    if (typeof windowId !== 'string' || !windowId.trim()) throw new BitBrowserError('INVALID_WINDOW_ID', '请选择要关闭的窗口。');
    await this.requestWithRetry(baseUrl, '/browser/close', { id: windowId });
    return { window_id: String(windowId), closed: true };
  }
}

module.exports = { BitBrowserClient, DEFAULT_BASE_URL, MAX_PAGE_COUNT, MAX_ATTEMPT_COUNT, normalizeBaseUrl, normalizeWindow, normalizeOpenPortEntries };
