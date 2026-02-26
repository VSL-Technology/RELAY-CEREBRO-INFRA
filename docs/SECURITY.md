# Segurança do Relay

- **Segredos obrigatórios**: `RELAY_INTERNAL_TOKEN` (endpoints internos) e pelo menos um token de borda (`RELAY_TOKEN` ou `RELAY_TOKEN_TOOLS`/`RELAY_TOKEN_EXEC`). Ative `RELAY_STRICT_SECURITY=1` para exigir também `RELAY_API_SECRET` no boot.
- **HMAC**: use `RELAY_API_SECRET` para chamadas mutáveis; `BACKEND_HMAC_SECRET` para tráfego de eventos/ACKs. Combine com `BACKEND_REQUIRE_HMAC=1` para recusar respostas sem assinatura.
- **Rate-limit**: configure `RELAY_RATE_WINDOW_MS`/`RELAY_RATE_LIMIT`. Endpoints internos usam middleware único (token interno + whitelist `RELAY_INTERNAL_WHITELIST`) com logs estruturados de negação.
- **WireGuard**: habilite `RELAY_RECONCILE_REMOVE=1` apenas quando seguro; alinhe mapeamento publicKey->deviceId via `peerBinding` para evitar peers órfãos.
- **Tokens/rotação**: planeje rotação periódica de `RELAY_TOKEN` e `RELAY_INTERNAL_TOKEN`; exponha novos valores via variables/secret manager e reinicie o relay de forma coordenada.
- **Ambientes**: mantenha `RELAY_DRY_RUN=1` em ambientes de teste para evitar comandos reais; em produção, desabilite e configure todos os segredos.
