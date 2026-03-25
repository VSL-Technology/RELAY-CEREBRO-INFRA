const crypto = require("crypto");
const fetch = (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const RELAY_URL = "http://localhost:3000";
const TOKEN = process.env.RELAY_TOKEN;
const SECRET = process.env.RELAY_API_SECRET;

async function run() {
  const ts = Date.now().toString();
  const nonce = crypto.randomBytes(12).toString("hex");

  const bodyObj = {
    host: "10.200.200.6",
    user: "relay-api",
    pass: "APIJNF8T7IOBI",
    port: 8728,
    command: "/system/identity/print",
    params: {}
  };

  const body = JSON.stringify(bodyObj);

  const base = `POST\n/relay/exec\n${ts}\n${nonce}\n${body}`;

  const signature = crypto
    .createHmac("sha256", SECRET)
    .update(base)
    .digest("hex");

  console.log("TS:", ts);
  console.log("NONCE:", nonce);
  console.log("SIGNATURE:", signature);

  const res = await fetch(`${RELAY_URL}/relay/exec`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "x-relay-ts": ts,
      "x-relay-nonce": nonce,
      "x-relay-signature": signature,
      "Content-Type": "application/json"
    },
    body
  });

  const text = await res.text();

  console.log("STATUS:", res.status);
  console.log("RESPONSE:", text);
}

run();
