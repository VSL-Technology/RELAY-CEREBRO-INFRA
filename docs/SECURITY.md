# Segurança do Relay

- **Segredos obrigatórios**: `RELAY_TOKEN` (todas as chamadas), `RELAY_INTERNAL_TOKEN` (endpoints internos). Ative `RELAY_STRICT_SECURITY=1` para exigir também `RELAY_API_SECRET` (HMAC em POST/DELETE/SYNC) e `RELAY_INTERNAL_TOKEN` no boot.
- **HMAC**: use `RELAY_API_SECRET` para chamadas mutáveis; `BACKEND_HMAC_SECRET` para tráfego de eventos/ACKs. Combine com `BACKEND_REQUIRE_HMAC=1` para recusar respostas sem assinatura.
- **Rate-limit**: configure `RELAY_RATE_WINDOW_MS`/`RELAY_RATE_LIMIT`. Endpoints internos também dependem de whitelist `RELAY_INTERNAL_WHITELIST`.
- **WireGuard**: habilite `RELAY_RECONCILE_REMOVE=1` apenas quando seguro; alinhe mapeamento publicKey->deviceId via `peerBinding` para evitar peers órfãos.
- **Tokens/rotação**: planeje rotação periódica de `RELAY_TOKEN` e `RELAY_INTERNAL_TOKEN`; exponha novos valores via variables/secret manager e reinicie o relay de forma coordenada.
- **Ambientes**: mantenha `RELAY_DRY_RUN=1` em ambientes de teste para evitar comandos reais; em produção, desabilite e configure todos os segredos.
