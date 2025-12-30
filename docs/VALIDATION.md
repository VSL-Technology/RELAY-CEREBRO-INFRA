# Validação rápida do Relay (DRY_RUN)

> Objetivo: exercitar os fluxos principais sem tocar Mikrotik/WireGuard, usando DRY_RUN e tokens fictícios.

## 1) Variáveis de ambiente mínimas
```bash
export RELAY_TOKEN=relay-test-token
export RELAY_INTERNAL_TOKEN=relay-internal
export RELAY_API_SECRET=relay-hmac
export BACKEND_HMAC_SECRET=backend-hmac
export RELAY_DRY_RUN=1
export RELAY_OFFLINE_MAX_AGE_SEC=0   # desativa bloqueio de peer offline no teste
export PORT=3001
```

## 2) Subir o relay
```bash
npm install          # se ainda não instalou
npm run start        # inicia em modo DRY_RUN
```

## 3) Exercitar endpoints
- **device/hello** (gera token persistido em `data/devices.json`)
```bash
curl -s -X POST http://localhost:3001/relay/device/hello \
  -H "x-relay-token: $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mikId":"LOPESUL-HOTSPOT-06","ip":"10.0.0.2","mac":"AA:BB:CC:DD:EE:FF"}'
```

- **authorize via action** (usa DRY_RUN, não toca Mikrotik)
```bash
curl -s -X POST http://localhost:3001/relay/action \
  -H "x-relay-token: $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"action":"AUTHORIZE_BY_PEDIDO","payload":{"pedidoId":"123","mikId":"LOPESUL-HOTSPOT-06","ipAtual":"10.0.0.2","macAtual":"AA:BB:CC:DD:EE:FF"}}'
```

- **metrics** (confirma contadores/latência)
```bash
curl -s http://localhost:3001/relay/metrics | head
```

- **internal WireGuard status** (usa internal token; DRY_RUN retorna vazio)
```bash
curl -s http://localhost:3001/internal/wireguard/peers/status \
  -H "x-relay-internal-token: $RELAY_INTERNAL_TOKEN"
```

## 4) Observação de logs
- Verifique logs de auditoria JSON no stdout: tentativas/sucesso/falha devem ter `traceId`.
- Métricas de ação por roteador aparecem com prefixo `router.<mikId>.action.*` e `router.<mikId>.latency_ms_total` em `/relay/metrics`.

## 5) Limpeza
- Dados persistidos em `data/` (`devices.json`, jobs, processed events). Remova se precisar resetar:
```bash
rm -f data/devices.json data/jobs.json data/processed_events.json
```

## 6) Produção
- Desligue `RELAY_DRY_RUN`.
- Defina `RELAY_STRICT_SECURITY=1` para forçar segredos.
- Ajuste `WG_INTERFACE`, `WG_VPS_PUBLIC_KEY`, `WG_VPS_ENDPOINT` e metas por roteador antes de aplicar configs reais.
