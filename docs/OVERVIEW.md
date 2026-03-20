# Relay “Cérebro” – Visão Geral

## Flows principais
- **HTTP API** (`src/index.js`): health, metrics, `device/hello`, identidade, sessões, action allowlist, WireGuard internos e upload de redirect.
- **Ações** (`src/services/actionHandler.js`): AUTHORIZE_BY_PEDIDO, RESYNC_DEVICE, REVOKE_SESSION com validação + auditoria + métricas/latência (por ação e por roteador).
- **Eventos** (`src/services/eventConsumer.js` + `stateMachine.js`): consome BACKEND_EVENTS_URL com HMAC opcional, deduplica, processa TRIAL/RELEASE/REVOKE, cria jobs de revoke, circuit breaker por roteador e opcional por peer OFFLINE (handshake age).
- **Jobs** (`jobStore`/`jobRunner`): file/SQLite/Redis, heartbeat de lock, backoff configurável e retries idempotentes.
- **WireGuard** (`wireguardManager`, `wireguardStatus`, `reconciler`): adiciona/remove peers, lê estado, reconcilia desired vs real e cria bindings faltantes (peer→deviceId/mikrotikIp).
- **Mikrotik** (`mikrotik.js`, `mikrotikService.js`, `mikrotikProbe.service.js`): comandos idempotentes, parsers compartilhados de hotspot, modo DRY_RUN, bootstrap/config mínima e usuário técnico.
- **Registro** (`registry/deviceRegistry.js`): devices/peers/tokens unificados em `data/devices.json`.
- **Sessões** (`sessionStore`, `sessionCleaner`, `activeSessionMonitor`, `sessionRoutes`): persistência em Redis, limpeza paralela e monitor de atividade por roteador.

## Segurança e HMAC
- Tokens: `RELAY_TOKEN` é o Bearer único usado nas rotas protegidas.
- HMAC: `RELAY_API_SECRET` para POST/DELETE/SYNC; `BACKEND_HMAC_SECRET` para eventos/ACKs (`BACKEND_REQUIRE_HMAC=1` para forçar).
- Modo estrito: `RELAY_STRICT_SECURITY=1` endurece o boot de segurança.
- Replay protection: nonce dedup em Redis e janela de 300s (`HMAC_WINDOW_MS`).
- Request tracing: toda request recebe `X-Request-ID` e gera logs com `reqId`.
- Rate-limit: `RELAY_RATE_WINDOW_MS`/`RATE_LIMIT_PER_ROUTER` com chave por roteador.

## Observabilidade
- Métricas em `/relay/metrics`: counters por ação/roteador (`action.*`, `router.<mikId>.*`), jobs, processed events.
- Auditoria JSON com `traceId`/`eventId` em tentativas/sucesso/falha (actions e eventos).
- Circuit breaker: `RELAY_OFFLINE_MAX_AGE_SEC` para recusar peers WG offline por tempo; logs e métricas `events.rejected_*`.

## WireGuard/Mikrotik
- WG: `WG_INTERFACE`, `WG_VPS_PUBLIC_KEY`, `WG_VPS_ENDPOINT`; reconciliador com `RELAY_RECONCILE_INTERVAL_MS`, `RELAY_RECONCILE_REMOVE`.
- Mikrotik config mínima (`applyMinimalConfig`) exige `tunnelIp/tunnelCidr`, `vpsPublicKey`, `vpsEndpoint`; `ensureTechnicalUser` exige senha. DRY_RUN mantém segurança em dev.

## Eventos/ACKs
- `BACKEND_EVENTS_URL`: relay chama com headers `x-relay-ts`, `x-relay-hmac`.
- Validação exige `eventId`, `type` e campos por tipo; dedupe via jobStore.
- `BACKEND_ACK_URL` opcional: relay envia `{eventId, ok, payload}` com HMAC; retries configuráveis (`BACKEND_ACK_RETRIES`, `BACKEND_ACK_RETRY_DELAY_MS`).

## Banco de dados (Railway Postgres)
- Cliente PG em `src/services/db.js`; usa `RELAY_DATABASE_URL` ou `DATABASE_URL`, SSL por padrão (`RELAY_DB_SSL`, `RELAY_DB_POOL_SIZE`, `RELAY_DB_IDLE_MS`).
- Recomendado: credencial dedicada, de leitura, e mapear as tabelas necessárias antes de consultar.

## DRY_RUN / validação
- `RELAY_DRY_RUN=1` evita comandos reais (WG/Mikrotik). Playbook em `docs/VALIDATION.md`.

## Referências
- Contrato backend: `docs/BACKEND_CONTRACT.md`
- Segurança: `docs/SECURITY.md`
- Env/DB: `docs/ENV_AND_DB.md`
- Validação DRY_RUN: `docs/VALIDATION.md`
