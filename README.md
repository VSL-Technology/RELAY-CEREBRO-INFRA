# Relay Cérebro Infra

Control-plane do relay (cérebro) já na versão “v3”: identidade persistente, idempotência, health model por roteador, HMAC obrigatório e tokens por escopo.

## Visão geral
- **Autenticação forte**: Bearer por escopo (`TOOLS`, `EXEC`, `INTERNAL`) + HMAC (`x-relay-signature` v1, `x-relay-ts`, `x-relay-nonce`) com proteção contra replay.
- **Identidade v3**: `sid` persistente, pending/applied/failed com idempotência e backoff (`AUTHORIZE_PENDING`), status público/ops e retry-now ops-only.
- **Circuit breaker**: health por roteador (WireGuard/Mikrotik) com classificação de erro (setup/auth/transiente), backoff e give-up cliente-first.
- **Endpoints chave**:
  - `GET /relay/health` (barato, protegido por token)
  - `GET /relay/identity/status` (public/ops)
  - `POST /relay/identity/retry-now` (ops)
  - `/relay/ping`, `/relay/arp-print`, `/relay/exec-by-device` (TOOLS/EXEC + HMAC + circuit breaker)
- **Observabilidade**: métricas Prometheus, logs estruturados, códigos de erro estáveis, testes de regressão.

## Requisitos
- Node.js 18+ (ESM).
- `npm install` para dependências.

## Setup rápido
1. Copie `.env.example` para `.env` e preencha:
   - `RELAY_API_SECRET`, `RELAY_TOKEN_TOOLS`, `RELAY_TOKEN_EXEC`, `RELAY_INTERNAL_TOKEN` (opcional `RELAY_TOKEN_HEALTH`).
   - `MIKROTIK_NODES` (JSON) e `WG_INTERFACE` fora de DRY_RUN.
   - `RELAY_DRY_RUN=1` para simular sem tocar Mikrotik/WG.
2. Instale e teste:
   ```bash
   npm install
   npm test -- --runInBand
   ```
3. Suba o relay:
   ```bash
   npm start   # ou node src/index.js
   ```

## Assinatura HMAC
- Headers: `Authorization: Bearer <token do escopo>` (ou `x-relay-token`), `x-relay-ts`, `x-relay-nonce`, `x-relay-signature: v1=<hex>`.
- Canonical: `METHOD\nPATH_WITH_QUERY\nTS\nNONCE\nBODY_SHA256`.
- Janela ±120s; nonce TTL 5 min.

## Fluxo de identidade (v3)
- Backend emite `PAYMENT_CONFIRMED(sid, pedidoId, planId, routerId?)`.
- Backend/portal chama `POST /relay/identity/refresh` com `sid/ip/mac/identity/routerHint`.
- Falha transiente → agenda `AUTHORIZE_PENDING` (backoff 2s→240s) e responde `pending_authorization`.
- Após 8 tentativas falhas → `FAILED` com cooldown, histórico preservado para ops.
- Status público: `authorized/pending/failed/no_pending_payment` + `retryInMs`. Ops (com `X-Relay-Internal`) vê pending/applied/lastSeen/health.

## Health e bind seguro
- `GET /relay/health` não toca Mikrotik/WG/state; protegido por token.
- Produção: `BIND_HOST=127.0.0.1` e expose via proxy.

## Estrutura
- `src/` serviços do relay (auth/HMAC, identity, health, WG/Mikrotik, reconciler, jobRunner).
- `__tests__/` regressões: lazy Mikrotik env, DRY_RUN, WG env, state machine, probe.
- `docs/` contratos e visão de arquitetura.

## Comandos úteis
- Métricas: `GET /relay/metrics`.
- Status identidade: `GET /relay/identity/status?sid=...` (public/ops).
- Retry manual (ops): `POST /relay/identity/retry-now` com `X-Relay-Internal`.

## Notas de produção
- Circuit breaker retorna `router_circuit_open` em EXEC/TOOLS quando health está aberto.
- Evite retry automático de POST no caller; use idempotência do relay.
- Para múltiplas instâncias, migrar `identityStore` para SQLite/Redis mantendo a interface.
