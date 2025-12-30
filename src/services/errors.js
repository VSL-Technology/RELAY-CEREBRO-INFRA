// src/services/errors.js
export class RelayError extends Error {
  constructor(message, code = 'relay_error', status = 400, meta = {}) {
    super(message);
    this.name = 'RelayError';
    this.code = code;
    this.status = status;
    this.meta = meta;
  }
}

export function wrapError(err) {
  if (err instanceof RelayError) return err;
  return new RelayError(err.message || 'internal_error', 'internal_error', 500);
}

export default { RelayError, wrapError };
