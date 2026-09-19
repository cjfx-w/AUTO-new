class BitBrowserError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'BitBrowserError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.cause = options.cause;
  }
}

function classifyError(error) {
  if (error instanceof BitBrowserError) return error;
  if (error?.name === 'AbortError') {
    return new BitBrowserError('TIMEOUT', 'BitBrowser 请求超时。', { retryable: true, cause: error });
  }
  return new BitBrowserError('UNAVAILABLE', '无法连接 BitBrowser，请检查 API 地址和 BitBrowser 是否已启动。', {
    retryable: true,
    cause: error
  });
}

module.exports = { BitBrowserError, classifyError };
