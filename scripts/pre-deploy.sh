#!/bin/sh
set -e

echo "==> Verificando variáveis obrigatórias..."
REQUIRED_VARS="RELAY_MASTER_KEY REDIS_URL HMAC_SECRET MIKROTIK_NODES"
for var in $REQUIRED_VARS; do
  if [ -z "$(eval echo \$$var)" ]; then
    echo "ERRO: $var não está definido"
    exit 1
  fi
done

echo "==> Criptografando senhas legadas em devices.json..."
if [ -f "data/devices.json" ]; then
  node src/scripts/encrypt-devices.js
else
  echo "data/devices.json não encontrado — pulando migração"
fi

echo "==> Verificando conectividade Redis..."
node -e "
import { createClient } from 'redis';
const c = createClient({ url: process.env.REDIS_URL });
await c.connect();
await c.ping();
await c.disconnect();
console.log('Redis OK');
" 2>/dev/null || node -e "
const Redis = require('ioredis');
const r = new Redis(process.env.REDIS_URL);
r.ping().then(() => { console.log('Redis OK'); r.disconnect(); process.exit(0); })
  .catch(e => { console.error('Redis FALHOU:', e.message); process.exit(1); });
"

echo "==> Tudo pronto para deploy"
