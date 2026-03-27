#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

BASE="http://localhost:3000"
TOKEN="efd78541c4d1f19b410e6e013bc028398273e9942bad0c427aa9db9e7584d013"
SECRET="bcf6fe386622dde4bc8fd0ff127f7b1e165584013dafd5003b0fe15380f83296"

NODE="/Users/victorsantos/.nvm/versions/node/v24.14.0/bin/node"

METHOD="POST"
PATH="/session/authorize"

SESSION_ID="${1:?uso: ./test-authorize.sh <sessionId>}"

BODY="{\"sessionId\":\"$SESSION_ID\",\"tempo\":600000}"

TS=$($NODE -e 'process.stdout.write(String(Date.now()))')
NONCE=$($NODE -e 'const crypto=require("crypto"); process.stdout.write(crypto.randomUUID().replace(/-/g,""))')

SIG=$($NODE -e "
const crypto = require('crypto');
const base = '${METHOD}\n${PATH}\n${TS}\n${NONCE}\n${BODY}';
process.stdout.write(
  crypto.createHmac('sha256','${SECRET}').update(base).digest('hex')
);
")

/usr/bin/curl -s -X "$METHOD" "$BASE$PATH" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-relay-ts: $TS" \
  -H "x-relay-nonce: $NONCE" \
  -H "x-relay-signature: $SIG" \
  -d "$BODY"