const WG_PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}=$/;

export function validateWgPublicKey(key) {
  const normalized = String(key || "").trim();
  if (!WG_PUBLIC_KEY_RE.test(normalized)) {
    throw new Error("invalid WireGuard publicKey (expected base64 44 chars)");
  }
  return normalized;
}

export default {
  validateWgPublicKey
};
