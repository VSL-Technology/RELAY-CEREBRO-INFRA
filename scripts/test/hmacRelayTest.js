import crypto from "crypto";
import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config();

const RELAY_URL = (process.env.RELAY_URL || "http://localhost:3000").replace(/\/+$/, "");
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const RELAY_API_SECRET = process.env.RELAY_API_SECRET;

if (!RELAY_TOKEN || !RELAY_API_SECRET) {
  console.error("Missing RELAY_TOKEN or RELAY_API_SECRET.");
  process.exit(1);
}

const METHOD = "POST";
const PATH = "/relay/exec";
const BODY = {
  host: process.env.MIKROTIK_HOST || "10.200.200.6",
  user: process.env.MIKROTIK_USER || "relay-api",
  pass: process.env.MIKROTIK_PASS || "APIJNF8T7IOBI",
  port: Number(process.env.MIKROTIK_PORT || 8728),
  command: "/system/identity/print",
  params: {}
};

const ts = String(Date.now());
const nonce = crypto.randomUUID().replace(/-/g, "");
const rawBody = JSON.stringify(BODY);
const base = `${METHOD}\n${PATH}\n${ts}\n${nonce}\n${rawBody}`;
const signature = crypto
  .createHmac("sha256", RELAY_API_SECRET)
  .update(base)
  .digest("hex");

async function run() {
  console.log("[test] request", {
    url: `${RELAY_URL}${PATH}`,
    method: METHOD,
    headers: {
      Authorization: `Bearer ${RELAY_TOKEN}`,
      "x-relay-ts": ts,
      "x-relay-nonce": nonce,
      "x-relay-signature": signature
    },
    body: BODY
  });

  const response = await fetch(`${RELAY_URL}${PATH}`, {
    method: METHOD,
    headers: {
      Authorization: `Bearer ${RELAY_TOKEN}`,
      "Content-Type": "application/json",
      "x-relay-ts": ts,
      "x-relay-nonce": nonce,
      "x-relay-signature": signature
    },
    body: rawBody
  });

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  console.log("[test] response", {
    status: response.status,
    body: parsed
  });

  if (!response.ok || !parsed || parsed.ok !== true) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error("[test] unexpected_error", error);
  process.exit(1);
});
