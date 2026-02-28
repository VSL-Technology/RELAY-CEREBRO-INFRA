import crypto from "crypto";

const SECRET = "COLE_AQUI_SEU_RELAY_API_SECRET";
const method = "POST";
const path = "/relay/action";
const body = JSON.stringify({
  action: "PING_ROUTER",
  payload: { routerId: "BUS05" }
});

const ts = Date.now().toString();
const nonce = crypto.randomBytes(16).toString("hex");

const baseString = [
  method,
  path,
  ts,
  nonce,
  body
].join("\n");

const signature = crypto
  .createHmac("sha256", SECRET)
  .update(baseString)
  .digest("hex");

console.log("TS:", ts);
console.log("NONCE:", nonce);
console.log("SIGNATURE:", signature);
console.log("BODY:", body);
