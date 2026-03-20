# Relay Cérebro Infra

Control-plane do relay com identidade persistente, HMAC obrigatório, segredos criptografados em repouso, locks distribuídos, circuit breaker em Redis e rotas de sessão/Hotspot apoiadas em Redis.

## Arquitetura
- **Borda HTTP** em [src/index.js](/Users/victorsantos/Desktop/AREA%20DE%20TRABALHO/RELAY-CEREBRO-INFRA/src/index.js): health, métricas, identidade, WireGuard interno, sessões e `device/hello`.
- **Segurança**: Bearer `RELAY_TOKEN` + HMAC `RELAY_API_SECRET`, janela de 300s, nonce dedup em Redis, `X-Request-ID` em toda resposta e logs com `reqId`.
- **Estado distribuído**: circuit breaker por roteador em Redis, `identityStore` com `SET NX`, jobs com lock renovável por heartbeat e sessões persistidas em Redis.
- **Escala Fase 2**: rate limit por `routerId`, validação e normalização de IP/MAC, parsers compartilhados de Hotspot e processamento paralelo com limite de concorrência.
- **Segredos**: `devices.json` usa AES-256-GCM com `RELAY_MASTER_KEY`; sem essa chave as senhas antigas não podem ser lidas.

## Setup rápido
1. Copie `.env.example` para `.env`.
2. Preencha no mínimo `RELAY_TOKEN`, `RELAY_API_SECRET`, `RELAY_MASTER_KEY`, `REDIS_URL` e `MIKROTIK_NODES`.
3. Instale dependências e rode os testes:
```bash
npm install
npm test
```
4. Suba o serviço:
```bash
npm start
```

## HMAC
- Headers: `Authorization: Bearer <RELAY_TOKEN>`, `x-relay-ts`, `x-relay-nonce`, `x-relay-signature: v1=<hex>`.
- Canonical usado pelo código: `METHOD\nPATH\nTS\nNONCE\nJSON_BODY`.
- O nonce é salvo em Redis pelo período de `HMAC_WINDOW_MS` para bloquear replay.
- As rotas `/relay/*` e `/internal/*` usam o mesmo Bearer + HMAC.

## Variáveis de ambiente
- `RELAY_TOKEN`: token Bearer principal do relay.
- `RELAY_API_SECRET`: segredo HMAC usado nas rotas protegidas.
- `RELAY_MASTER_KEY`: chave AES-256-GCM para criptografia de segredos em repouso.
- `DATABASE_URL`: conexão do banco usado pelo control plane/Prisma.
- `REDIS_URL`: URL de conexão principal com Redis.
- `REDIS_HOST`: host Redis usado quando `REDIS_URL` não for informado.
- `REDIS_PORT`: porta Redis usada quando `REDIS_URL` não for informado.
- `REDIS_PASSWORD`: senha Redis usada quando `REDIS_URL` não for informado.
- `REDIS_REQUIRED`: se `true`, o boot falha quando Redis estiver indisponível.
- `MIKROTIK_NODES`: JSON com os roteadores MikroTik conhecidos pelo relay.
- `CB_FAILURE_THRESHOLD`: número de falhas consecutivas para abrir o circuit breaker.
- `CB_RECOVERY_TIMEOUT_MS`: tempo de espera antes de permitir nova tentativa no circuit breaker.
- `HMAC_WINDOW_MS`: janela máxima de tolerância para timestamp HMAC.
- `RELAY_RATE_WINDOW_MS`: tamanho da janela do rate limiter global.
- `RELAY_RATE_LIMIT`: limite legado de requisições por janela.
- `RATE_LIMIT_PER_ROUTER`: limite efetivo por roteador quando `routerId` estiver disponível.
- `WG_INTERFACE`: interface WireGuard local.
- `WG_VPS_PUBLIC_KEY`: chave pública do VPS WireGuard.
- `WG_VPS_ENDPOINT`: endpoint público do VPS WireGuard.
- `CONTROL_PLANE_MODE`: modo do control plane.
- `CONTROL_PLANE_FALLBACK_JSON`: permite fallback para JSON quando DB não estiver disponível.
- `CONTROL_PLANE_WRITE_DB`: habilita escrita do estado reconciliado no banco.
- `JOB_RUNNER_ENABLED`: habilita o job runner no boot.
- `SESSION_PUBLIC`: permite rotas `/session/*` sem autenticação Bearer/HMAC.
- `SESSION_MONITOR_CONCURRENCY`: número de sessões processadas em paralelo no monitor.
- `SESSION_CLEANER_CONCURRENCY`: número de sessões expiradas processadas em paralelo no cleaner.
- `PORT`: porta HTTP do serviço.

## Operação
- Use `scripts/pre-deploy.sh` antes do deploy para validar variáveis, migrar `devices.json` legado e testar Redis.
- Use `scripts/test/fullFlow.mjs` e `scripts/test/sessionTest.mjs` para smoke tests manuais.
- Em produção, configure `RELAY_MASTER_KEY` em secret manager. Sem ela o relay perde acesso às senhas criptografadas.
