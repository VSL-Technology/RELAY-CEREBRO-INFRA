#!/usr/bin/env bash
set -euo pipefail

RELAY_BASE_URL="${RELAY_BASE_URL:-http://localhost:3000}"
RELAY_TOKEN="${RELAY_TOKEN:-efd78541c4d1f19b410e6e013bc028398273e9942bad0c427aa9db9e7584d013}"
RELAY_API_SECRET="${RELAY_API_SECRET:-bcf6fe386622dde4bc8fd0ff127f7b1e165584013dafd5003b0fe15380f83296}"

METHOD="GET"
PATH_ONLY="/relay/health"
BODY=""

TS="$(node -e 'process.stdout.write(String(Date.now()))')"
NONCE="$(node -e 'const crypto=require("crypto"); process.stdout.write(crypto.randomUUID().replace(/-/g, ""))')"

SIG="$(
  node -e '
    const crypto = require("crypto");
    const [method, path, ts, nonce, body, secret] = process.argv.slice(1);
    const base = `${method}\n${path}\n${ts}\n${nonce}\n${body}`;
    process.stdout.write(
      crypto.createHmac("sha256", secret).update(base).digest("hex")
    );
  ' \
  "$METHOD" "$PATH_ONLY" "$TS" "$NONCE" "$BODY" "$RELAY_API_SECRET"
)"

curl --fail-with-body \
  -X "$METHOD" \
  "${RELAY_BASE_URL%/}${PATH_ONLY}" \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "x-relay-ts: $TS" \
  -H "x-relay-nonce: $NONCE" \
  -H "x-relay-signature: $SIG"