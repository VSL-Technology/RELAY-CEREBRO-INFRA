# Variáveis de ambiente e dados compartilhados (Relay ↔ Backend)

## Segredos compartilhados com o backend
- `RELAY_TOKEN`: header `x-relay-token` que o backend envia para o relay.
- `RELAY_API_SECRET`: HMAC para POST/DELETE/SYNC; backend deve assinar o body e enviar `x-relay-signature` (hex).
- `RELAY_INTERNAL_TOKEN`: protege endpoints internos; não deve sair do ambiente controlado.
- `BACKEND_HMAC_SECRET`: HMAC bidirecional para tráfego de eventos/ACKs (`BACKEND_EVENTS_URL` e `BACKEND_ACK_URL`); precisa ser igual em ambos.

## Config do consumer de eventos
- `BACKEND_EVENTS_URL`: endpoint GET no backend que entrega eventos.
- `BACKEND_REQUIRE_HMAC` (1/0): se 1, relay rejeita resposta sem `x-backend-hmac`.
- `BACKEND_ACK_URL`: endpoint POST para o relay devolver ACK dos eventos.
- `BACKEND_ACK_RETRIES`, `BACKEND_ACK_RETRY_DELAY_MS`: tentativas e atraso para ACK.

## Segurança e política
- `RELAY_STRICT_SECURITY` (1/0): se 1, relay exige `RELAY_API_SECRET` e `RELAY_INTERNAL_TOKEN` no boot.
- `RELAY_RATE_WINDOW_MS`, `RELAY_RATE_LIMIT`: rate-limit por IP.
- `RELAY_OFFLINE_MAX_AGE_SEC`: recusa ações se peer WG estiver offline há mais que X s (quando `peerPublicKey` é enviado no payload).

## WireGuard / Mikrotik
- `MIKROTIK_NODES` **obrigatório**: JSON com id/host/user/pass/port/timeout (ex.: `[{"id":"HOTSPOT-01","host":"10.200.1.10","user":"relay","pass":"<senha>","port":8728}]`).
- `WG_INTERFACE`: interface WG no host do relay (necessário fora de DRY_RUN).
- `WG_VPS_PUBLIC_KEY`, `WG_VPS_ENDPOINT`: chave/endpoint do VPS usados em bootstrap/config Mikrotik.
- `RELAY_RECONCILE_INTERVAL_MS`, `RELAY_RECONCILE_REMOVE`: reconciliador de peers (intervalo e remoção de peers órfãos).
- Mikrotik meta por device pode ser gravada no registry (deviceId → publicKey → mikrotikIp) para bindings.

## Job store / locks
- `RELAY_USE_SQLITE` (1/0): usa SQLite em `data/relay.db`.
- `RELAY_STORE=redis`: usa Redis; requer `REDIS_URL` e `RELAY_NAMESPACE`.
- `RELAY_JOB_MAX_ATTEMPTS`, `RELAY_JOB_BACKOFF_BASE_MS`, `RELAY_LOCK_TTL_MS`: política de retries/lock.

## DRY_RUN e testes
- `RELAY_DRY_RUN` (1/0): não executa comandos reais (Mikrotik/WG); usar 1 em dev/teste.
- `PORT`: porta HTTP (default 3001).

## Integração com banco de dados do backend
O relay atualmente persiste em arquivos/Redis/SQLite. Para consultar dados reais do backend:
- Provisionar credenciais específicas para o relay, preferencialmente **read-only** (ex.: `RELAY_DATABASE_URL` ou `DATABASE_URL` do Railway). Há um pool em `src/services/db.js` que usa `pg` com SSL (rejectUnauthorized=false por padrão).
- Segregar permissões: uma role de leitura para consultas e, se necessário, outra restrita para inserções específicas (logs/ACKs).
- Mapear quais tabelas/visões o relay precisa (ex.: pedidos, devices, vínculos Mikrotik). Evite usar credenciais de aplicação full-access.
- Planejar caching/limites: consultas devem ser idempotentes e rápidas; alinhar índices no backend.
- Riscos: compartilhar o mesmo banco aumenta acoplamento; defina SLA e monitore conexões/latência. Considere um replica/read-replica se houver carga.

## Checklist mínimo (prod)
1) `RELAY_TOKEN`, `RELAY_API_SECRET`, `RELAY_INTERNAL_TOKEN`, `BACKEND_HMAC_SECRET` definidos e roteados via secret manager.
2) `WG_INTERFACE`, `WG_VPS_PUBLIC_KEY`, `WG_VPS_ENDPOINT` configurados; reconciliador habilitado com intervalos seguros.
3) `BACKEND_EVENTS_URL`/`BACKEND_ACK_URL` ativos e assinando com `BACKEND_HMAC_SECRET`.
4) Decisão sobre `RELAY_RECONCILE_REMOVE` (0 inicialmente) e `RELAY_OFFLINE_MAX_AGE_SEC`.
5) Se for usar o banco do backend: criar credenciais dedicadas e apontar `RELAY_DATABASE_URL` (ou `DATABASE_URL`) para elas; ajustar `RELAY_DB_SSL`, `RELAY_DB_POOL_SIZE` se necessário.
