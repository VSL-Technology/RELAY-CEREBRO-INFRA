// src/security/hmacVerify.js
import crypto from "crypto";

const TS_SKEW_MS = Number(process.env.RELAY_TS_SKEW_MS || 120_000);     // ±120s
const NONCE_TTL_MS = Number(process.env.RELAY_NONCE_TTL_MS || 5 * 60_000); // 5 min

const nonceCache = new Map(); // nonce -> expiresAt

function cleanup(now = Date.now()) {
  for (const [n, exp] of nonceCache) {
    if (exp <= now) nonceCache.delete(n);
  }
}

function hmacHex(secret, msg) {
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}

function safeEqHex(expectedHex, providedHex) {
  let a, b;
  try {
    a = Buffer.from(expectedHex, "hex");
    b = Buffer.from(providedHex, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Canonical string:
 * METHOD\nPATH\nTS\nNONCE\nRAW_BODY
 */
export function verifyRelaySignature({ method, path, rawBody, ts, nonce, signatureHex, secret }) {
  const now = Date.now();
  if (!secret) return { ok: false, code: "HMAC_SECRET_NOT_CONFIGURED" };
  if (!signatureHex) return { ok: false, code: "HMAC_SIGNATURE_MISSING" };

  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) return { ok: false, code: "HMAC_TS_INVALID" };
  if (!nonce || typeof nonce !== "string" || nonce.length < 8) return { ok: false, code: "HMAC_NONCE_INVALID" };

  if (Math.abs(now - tsNum) > TS_SKEW_MS) return { ok: false, code: "HMAC_TS_OUT_OF_RANGE" };

  cleanup(now);
  if (nonceCache.has(nonce)) return { ok: false, code: "HMAC_REPLAY" };
  nonceCache.set(nonce, now + NONCE_TTL_MS);

  const rawBodyString = Buffer.isBuffer(rawBody)
    ? rawBody.toString("utf8")
    : String(rawBody || "");

  const canonical = `${String(method || "").toUpperCase()}\n${path || ""}\n${String(tsNum)}\n${nonce}\n${rawBodyString}`;
  const expected = hmacHex(secret, canonical);

  if (!safeEqHex(expected, String(signatureHex))) {
    return { ok: false, code: "HMAC_SIGNATURE_INVALID" };
  }

  return { ok: true };
}

export default { verifyRelaySignature };
