import { EventEmitter } from "events";

const store = new Map();
const expiries = new Map();

function now() {
  return Date.now();
}

function clearExpiredKey(key) {
  const expiresAt = expiries.get(key);
  if (expiresAt && expiresAt <= now()) {
    expiries.delete(key);
    store.delete(key);
  }
}

function getEntry(key, type = null) {
  clearExpiredKey(key);
  const entry = store.get(key);
  if (!entry) return null;
  if (type && entry.type !== type) return null;
  return entry;
}

function setEntry(key, type, value) {
  store.set(key, { type, value });
}

function deleteKey(key) {
  clearExpiredKey(key);
  const deleted = store.delete(key);
  expiries.delete(key);
  return deleted ? 1 : 0;
}

function parsePattern(pattern) {
  const escaped = String(pattern || "*").replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function parseSetArgs(args) {
  let ttlMs = null;
  let onlyIfMissing = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = String(args[index] || "").toUpperCase();
    if (token === "PX") {
      ttlMs = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (token === "NX") {
      onlyIfMissing = true;
    }
  }

  return { ttlMs, onlyIfMissing };
}

function getHash(key) {
  const entry = getEntry(key, "hash");
  if (entry) return entry.value;
  const value = new Map();
  setEntry(key, "hash", value);
  return value;
}

function getSet(key) {
  const entry = getEntry(key, "set");
  if (entry) return entry.value;
  const value = new Set();
  setEntry(key, "set", value);
  return value;
}

function getZSet(key) {
  const entry = getEntry(key, "zset");
  if (entry) return entry.value;
  const value = new Map();
  setEntry(key, "zset", value);
  return value;
}

function sortedZSetMembers(zset) {
  return Array.from(zset.entries())
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([member, score]) => ({ member, score }));
}

export function resetRedisMock() {
  store.clear();
  expiries.clear();
}

class MockPipeline {
  constructor(client) {
    this.client = client;
    this.operations = [];
  }

  addOperation(name, args) {
    this.operations.push({ name, args });
    return this;
  }

  del(...args) { return this.addOperation("del", args); }
  zadd(...args) { return this.addOperation("zadd", args); }
  hmset(...args) { return this.addOperation("hmset", args); }
  hset(...args) { return this.addOperation("hset", args); }
  expire(...args) { return this.addOperation("expire", args); }
  sadd(...args) { return this.addOperation("sadd", args); }

  async exec() {
    const results = [];
    for (const operation of this.operations) {
      const value = await this.client[operation.name](...operation.args);
      results.push([null, value]);
    }
    return results;
  }
}

export default class MockRedis extends EventEmitter {
  constructor() {
    super();
    queueMicrotask(() => this.emit("connect"));
  }

  async ping() {
    return "PONG";
  }

  async set(key, value, ...args) {
    clearExpiredKey(key);
    const { ttlMs, onlyIfMissing } = parseSetArgs(args);
    if (onlyIfMissing && store.has(key)) {
      return null;
    }
    setEntry(key, "string", String(value));
    if (ttlMs && Number.isFinite(ttlMs) && ttlMs > 0) {
      expiries.set(key, now() + ttlMs);
    } else {
      expiries.delete(key);
    }
    return "OK";
  }

  async get(key) {
    const entry = getEntry(key, "string");
    return entry ? entry.value : null;
  }

  async del(...keys) {
    const list = Array.isArray(keys[0]) ? keys[0] : keys;
    return list.reduce((count, key) => count + deleteKey(key), 0);
  }

  async mget(keys) {
    const list = Array.isArray(keys) ? keys : Array.from(arguments);
    return list.map((key) => {
      const entry = getEntry(key, "string");
      return entry ? entry.value : null;
    });
  }

  async scan(cursor, ...args) {
    const matchIndex = args.findIndex((item) => String(item).toUpperCase() === "MATCH");
    const pattern = matchIndex >= 0 ? args[matchIndex + 1] : "*";
    const regex = parsePattern(pattern);
    const keys = Array.from(store.keys()).filter((key) => {
      clearExpiredKey(key);
      return regex.test(key) && store.has(key);
    });
    return ["0", keys];
  }

  async hgetall(key) {
    const hash = getEntry(key, "hash");
    if (!hash) return {};
    return Object.fromEntries(hash.value.entries());
  }

  async hset(key, field, value) {
    const hash = getHash(key);
    if (typeof field === "object" && field !== null) {
      Object.entries(field).forEach(([itemKey, itemValue]) => hash.set(itemKey, String(itemValue)));
      return Object.keys(field).length;
    }
    hash.set(String(field), String(value));
    return 1;
  }

  async hmset(key, values) {
    return this.hset(key, values);
  }

  async hincrby(key, field, increment) {
    const hash = getHash(key);
    const current = Number(hash.get(String(field)) || 0);
    const next = current + Number(increment);
    hash.set(String(field), String(next));
    return next;
  }

  async zadd(key, ...args) {
    const zset = getZSet(key);
    for (let index = 0; index < args.length; index += 2) {
      const score = Number(args[index]);
      const member = String(args[index + 1]);
      zset.set(member, score);
    }
    return zset.size;
  }

  async zrangebyscore(key, min, max, ...args) {
    const zset = getEntry(key, "zset");
    if (!zset) return [];
    const minScore = min === "-inf" ? Number.NEGATIVE_INFINITY : Number(min);
    const maxScore = max === "+inf" ? Number.POSITIVE_INFINITY : Number(max);
    let members = sortedZSetMembers(zset.value)
      .filter((item) => item.score >= minScore && item.score <= maxScore)
      .map((item) => item.member);

    const limitIndex = args.findIndex((item) => String(item).toUpperCase() === "LIMIT");
    if (limitIndex >= 0) {
      const offset = Number(args[limitIndex + 1] || 0);
      const count = Number(args[limitIndex + 2] || members.length);
      members = members.slice(offset, offset + count);
    }

    return members;
  }

  async zrange(key, start, stop) {
    const zset = getEntry(key, "zset");
    if (!zset) return [];
    const members = sortedZSetMembers(zset.value).map((item) => item.member);
    const normalizedStop = Number(stop) === -1 ? members.length : Number(stop) + 1;
    return members.slice(Number(start), normalizedStop);
  }

  async zrem(key, member) {
    const zset = getEntry(key, "zset");
    if (!zset) return 0;
    return zset.value.delete(String(member)) ? 1 : 0;
  }

  async sadd(key, ...members) {
    const setValue = getSet(key);
    members.forEach((member) => setValue.add(String(member)));
    return setValue.size;
  }

  async smembers(key) {
    const setValue = getEntry(key, "set");
    return setValue ? Array.from(setValue.value) : [];
  }

  async sismember(key, member) {
    const setValue = getEntry(key, "set");
    return setValue && setValue.value.has(String(member)) ? 1 : 0;
  }

  async expire(key, seconds) {
    if (!store.has(key)) return 0;
    expiries.set(key, now() + Number(seconds) * 1000);
    return 1;
  }

  async pexpire(key, ttlMs) {
    if (!store.has(key)) return 0;
    expiries.set(key, now() + Number(ttlMs));
    return 1;
  }

  async eval(script, _numKeys, key, token, arg) {
    const entry = getEntry(key, "string");
    if (!entry || entry.value !== String(token)) {
      return 0;
    }
    if (script.includes("PEXPIRE")) {
      return this.pexpire(key, Number(arg));
    }
    if (script.includes("DEL")) {
      return this.del(key);
    }
    return 0;
  }

  pipeline() {
    return new MockPipeline(this);
  }

  disconnect() {
    this.emit("end");
  }

  quit() {
    this.disconnect();
  }
}

