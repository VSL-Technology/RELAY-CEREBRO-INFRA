import crypto from "crypto";
import fetch from "node-fetch";

const BASE = (process.env.RELAY_BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const RELAY_TOKEN = process.env.RELAY_TOKEN || "";
const RELAY_API_SECRET = process.env.RELAY_API_SECRET || "";

function buildHeaders(method, path, body) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (!RELAY_TOKEN || !RELAY_API_SECRET) {
    return headers;
  }

  const ts = String(Date.now());
  const nonce = crypto.randomBytes(12).toString("hex");
  const serializedBody = body ? JSON.stringify(body) : "";
  const base = `${method}\n${path}\n${ts}\n${nonce}\n${serializedBody}`;
  const signature = crypto
    .createHmac("sha256", RELAY_API_SECRET)
    .update(base)
    .digest("hex");

  headers.Authorization = `Bearer ${RELAY_TOKEN}`;
  headers["x-relay-ts"] = ts;
  headers["x-relay-nonce"] = nonce;
  headers["x-relay-signature"] = signature;

  return headers;
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function relayFetch(path, options = {}) {
  const method = options.method || "GET";
  const body = options.body;

  return fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      ...buildHeaders(method, path, body),
      ...(options.headers || {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function run() {
  console.log("1. creating session...");

  const start = await relayFetch("/session/start", {
    method: "POST",
    body: {
      ip: "192.168.88.10",
      mac: "aa:bb:cc:dd:ee:ff",
      router: "router-1"
    }
  });

  const s = await readJson(start);
  console.log("session:", { status: start.status, body: s });

  if (!s || !s.sessionId) {
    throw new Error("failed to create session");
  }

  console.log("2. authorizing...");

  const auth = await relayFetch("/session/authorize", {
    method: "POST",
    body: {
      sessionId: s.sessionId,
      plano: "12h",
      tempo: 120000
    }
  });

  const result = await readJson(auth);
  console.log("authorize:", { status: auth.status, body: result });

  console.log("3. checking active...");

  const active = await relayFetch("/session/active");
  console.log("active:", { status: active.status, body: await readJson(active) });
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
