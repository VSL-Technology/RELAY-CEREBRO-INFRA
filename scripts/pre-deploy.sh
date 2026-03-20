#!/bin/sh
set -e

echo "[pre-deploy] Verificando variáveis obrigatórias..."
MISSING=""
for var in RELAY_MASTER_KEY REDIS_URL HMAC_SECRET; do
  eval "val=\$$var"
  if [ -z "$val" ]; then
    MISSING="$MISSING $var"
  fi
done
if [ -n "$MISSING" ]; then
  echo "[pre-deploy] ERRO: variáveis não definidas:$MISSING"
  exit 1
fi
echo "[pre-deploy] Variáveis OK"

echo "[pre-deploy] Criptografando senhas em devices.json..."
if [ -f "data/devices.json" ]; then
  node src/scripts/encrypt-devices.js && echo "[pre-deploy] devices.json atualizado"
else
  echo "[pre-deploy] data/devices.json não encontrado — pulando"
fi

echo "[pre-deploy] Testando conexão Redis..."
node --input-type=module << 'EOF'
import Redis from 'ioredis'
const r = new Redis(process.env.REDIS_URL, { lazyConnect: true })
await r.connect()
await r.ping()
await r.quit()
console.log('[pre-deploy] Redis OK')
EOF

echo "[pre-deploy] Tudo pronto para deploy ✓"
