# Deploy checklist — Relay Cérebro

## Primeiro deploy (Railway)

### 1. Executar pré-deploy no servidor
  sh scripts/pre-deploy.sh

### 2. Variáveis obrigatórias no Railway → Settings → Variables
| Variável | Como gerar |
|---|---|
| RELAY_MASTER_KEY | openssl rand -hex 32 |
| REDIS_URL | gerado pelo Railway Redis — copiar do painel |
| HMAC_SECRET | deve ser igual ao RELAY_TOKEN do Dashboard |
| HMAC_WINDOW_MS | 300000 |
| CB_FAILURE_THRESHOLD | 5 |
| SESSION_MONITOR_CONCURRENCY | 10 |
| RELAY_LOCK_HEARTBEAT_INTERVAL_MS | 15000 |
| PORT | 3001 |

### 3. Verificar após deploy
- [ ] GET /health → 200
- [ ] POST /relay/device/hello sem HMAC → 401
- [ ] Logs aparecem com reqId em todas as linhas
- [ ] Circuit breaker keys no Redis: KEYS cb:router:*

## A cada deploy
- [ ] npm test passa sem ECONNREFUSED
- [ ] git status limpo antes do push
- [ ] RELAY_MASTER_KEY não mudou (mudar quebra devices.json)

## Atenção crítica
**RELAY_MASTER_KEY nunca deve mudar após o primeiro deploy.**
Se precisar rotacionar: rode encrypt-devices.js com a nova chave
ANTES de fazer deploy com ela.

## Rollback
Railway mantém histórico — use "Rollback" na interface.
Redis mantém estado das sessões ativas — rollback de código
não afeta sessões em andamento.
