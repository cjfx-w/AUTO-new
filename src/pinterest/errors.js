class PinterestValidationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'PinterestValidationError';
    this.code = code;
    this.cause = options.cause;
    this.retryable = Boolean(options.retryable);
  }
}

module.exports = { PinterestValidationError };
