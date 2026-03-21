# Deploy checklist — Relay Cérebro

## Antes do primeiro deploy
- [ ] Executar: sh scripts/pre-deploy.sh
- [ ] Configurar variáveis (ver .env.example)
- [ ] Configurar `RELAY_STORE=redis` para job lock distribuído entre instâncias
- [ ] Confirmar RELAY_MASTER_KEY salvo em lugar seguro (sem ela as senhas são ilegíveis)
- [ ] Redis provisionado e REDIS_URL configurada
- [ ] data/devices.json NÃO está no Dockerfile (ver .dockerignore)

## A cada deploy
- [ ] npm test passa sem ECONNREFUSED
- [ ] git status limpo (sem arquivos pendentes)
- [ ] Testar /health endpoint após subir

## Variáveis críticas
RELAY_MASTER_KEY, REDIS_URL, HMAC_SECRET, HMAC_WINDOW_MS,
METRICS_TOKEN → openssl rand -hex 32
CB_FAILURE_THRESHOLD, SESSION_MONITOR_CONCURRENCY,
RELAY_LOCK_HEARTBEAT_INTERVAL_MS
