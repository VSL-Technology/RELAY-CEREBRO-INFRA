# Segurança do Relay

- **Segredos obrigatórios**: `RELAY_TOKEN`, `RELAY_API_SECRET` e `RELAY_MASTER_KEY`. Ative `RELAY_STRICT_SECURITY=1` para falhar no boot sem Bearer/HMAC válidos.
- **HMAC**: use `RELAY_API_SECRET` em todas as rotas `/relay/*` e `/internal/*`. O relay valida `x-relay-ts`, `x-relay-nonce` e `x-relay-signature`, com deduplicação de nonce em Redis.
- **Request tracing**: toda resposta HTTP devolve `X-Request-ID`; os logs estruturados carregam `reqId` automaticamente.
- **Rate-limit**: configure `RELAY_RATE_WINDOW_MS` e `RATE_LIMIT_PER_ROUTER`. A chave de limitação agora prioriza `routerId`/`mikId`/`x-router-id` antes do fallback para IP.
- **Validação de borda**: `/session/start` e `/relay/device/hello` validam IP e normalizam MAC para `AA:BB:CC:DD:EE:FF`.
- **WireGuard**: habilite `RELAY_RECONCILE_REMOVE=1` apenas quando seguro; alinhe mapeamento publicKey->deviceId via `peerBinding` para evitar peers órfãos.
- **Tokens/rotação**: planeje rotação periódica de `RELAY_TOKEN`, `RELAY_API_SECRET` e `RELAY_MASTER_KEY`; exponha novos valores via secret manager e reinicie o relay de forma coordenada.
- **Ambientes**: mantenha `RELAY_DRY_RUN=1` em ambientes de teste para evitar comandos reais; em produção, desabilite e configure todos os segredos.
