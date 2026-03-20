import { AsyncLocalStorage } from "async_hooks";

const requestContextStorage = new AsyncLocalStorage();

export function runWithRequestContext(context, callback) {
  return requestContextStorage.run(context || {}, callback);
}

export function getRequestContext() {
  return requestContextStorage.getStore() || {};
}
