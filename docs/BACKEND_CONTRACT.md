# Backend <-> Relay Contract

## Evento -> Relay
- **Endpoint**: `BACKEND_EVENTS_URL` (GET). Relay envia headers `x-relay-ts` (timestamp) e `x-relay-hmac` (HMAC do ts usando `BACKEND_HMAC_SECRET` se configurado).
- **Resposta esperada**: JSON array de eventos `{ eventId: string, type: string, payload: object, timestamp?: number }`.
- **Integridade**: Relay valida `x-backend-hmac` sobre o corpo usando `BACKEND_HMAC_SECRET` quando `BACKEND_REQUIRE_HMAC=1` ou segredo presente.
- **Validação**: eventId e type obrigatórios; tipos aceitos hoje: `TRIAL_REQUESTED`, `RELEASE_REQUESTED`, `REVOKE_REQUESTED` com campos mínimos:
  - TRIAL/RELEASE: `pedidoId`, `mikId`, `ip`, `mac`
  - REVOKE: `mikId` e (`ip` ou `mac`)

## ACK do Relay -> Backend
- **Endpoint**: `BACKEND_ACK_URL` (POST) opcional.
- **Payload**: `{ eventId, ok, payload }`, onde `payload` é o resultado do processamento.
- **Headers**: `x-relay-ts`, `x-relay-hmac` (HMAC do body com `BACKEND_HMAC_SECRET` quando presente).
- **Retry**: Relay reenvia até `BACKEND_ACK_RETRIES` (default 2) com intervalo `BACKEND_ACK_RETRY_DELAY_MS` (default 500ms).

## Segurança
- Configure `BACKEND_HMAC_SECRET` em ambos os lados para HMAC bidirecional.
- Use `RELAY_API_SECRET` para HMAC em endpoints HTTP mutáveis.
- Token de acesso: usar `Authorization: Bearer <RELAY_TOKEN>` em todas as rotas protegidas.
- Toda request protegida deve carregar `x-relay-ts`, `x-relay-nonce` e `x-relay-signature: v1=<hex>`.
- Rate-limit: `RELAY_RATE_WINDOW_MS` e `RATE_LIMIT_PER_ROUTER`.

## Observabilidade
- Métricas expostas em `/relay/metrics`.
- Auditoria: logs JSON com `traceId/eventId` em cada etapa (attempt/success/fail).
- Request tracing HTTP: `X-Request-ID` em todas as respostas e `reqId` nos logs.
