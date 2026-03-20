# Validação rápida do Relay (DRY_RUN)

> Objetivo: exercitar os fluxos principais sem tocar Mikrotik/WireGuard, usando DRY_RUN, Bearer e HMAC.

## 1) Variáveis de ambiente mínimas
```bash
export RELAY_TOKEN=relay-test-token
export RELAY_API_SECRET=relay-hmac
export RELAY_DRY_RUN=1
export RELAY_OFFLINE_MAX_AGE_SEC=0   # desativa bloqueio de peer offline no teste
export PORT=3001
```

## 2) Subir o relay
```bash
npm install          # se ainda não instalou
npm run start        # inicia em modo DRY_RUN
```

> `npm test` usa mock de `ioredis`, então a suíte local não precisa de Redis real para passar.

## 3) Exercitar endpoints
Defina um helper simples para assinar requests:
```bash
sign() {
  METHOD="$1"
  PATHNAME="$2"
  BODY="${3:-}"
  TS=$(node -e 'process.stdout.write(String(Date.now()))')
  NONCE=$(node -e 'process.stdout.write(require("crypto").randomBytes(12).toString("hex"))')
  SIG=$(node -e 'const crypto=require("crypto"); const [method,path,ts,nonce,body]=process.argv.slice(1); process.stdout.write(crypto.createHmac("sha256", process.env.RELAY_API_SECRET).update(`${method}\n${path}\n${ts}\n${nonce}\n${body}`).digest("hex"))' "$METHOD" "$PATHNAME" "$TS" "$NONCE" "$BODY")
  printf '%s\n%s\n%s\n' "$TS" "$NONCE" "$SIG"
}
```

- **device/hello** (gera token persistido em `data/devices.json`)
```bash
BODY='{"mikId":"LOPESUL-HOTSPOT-06","ip":"10.0.0.2","mac":"AA:BB:CC:DD:EE:FF"}'
read TS NONCE SIG <<EOF
$(sign POST /relay/device/hello "$BODY")
EOF
curl -s -X POST http://localhost:3001/relay/device/hello \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "x-relay-ts: $TS" \
  -H "x-relay-nonce: $NONCE" \
  -H "x-relay-signature: v1=$SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

- **authorize via action** (usa DRY_RUN, não toca Mikrotik)
```bash
BODY='{"action":"AUTHORIZE_BY_PEDIDO","payload":{"pedidoId":"123","mikId":"LOPESUL-HOTSPOT-06","ipAtual":"10.0.0.2","macAtual":"AA:BB:CC:DD:EE:FF"}}'
read TS NONCE SIG <<EOF
$(sign POST /relay/action "$BODY")
EOF
curl -s -X POST http://localhost:3001/relay/action \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "x-relay-ts: $TS" \
  -H "x-relay-nonce: $NONCE" \
  -H "x-relay-signature: v1=$SIG" \
  -H "Content-Type: application/json" \
  -d "$BODY"
```

- **metrics** (confirma contadores/latência)
```bash
curl -s http://localhost:3001/relay/metrics | head
```

- **internal WireGuard status** (usa Bearer + HMAC; DRY_RUN retorna vazio)
```bash
TS=$(node -e 'process.stdout.write(String(Date.now()))')
NONCE=$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')
BODY='{}'
SIG=$(node -e 'const crypto=require("crypto"); const method="GET"; const path="/internal/wireguard/peers/status"; const ts=process.argv[1]; const nonce=process.argv[2]; const body=process.argv[3]; const secret=process.env.RELAY_API_SECRET; process.stdout.write(crypto.createHmac("sha256", secret).update(`${method}\n${path}\n${ts}\n${nonce}\n${body}`).digest("hex"))' "$TS" "$NONCE" "$BODY")
curl -s http://localhost:3001/internal/wireguard/peers/status \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "x-relay-ts: $TS" \
  -H "x-relay-nonce: $NONCE" \
  -H "x-relay-signature: v1=$SIG"
```

## 4) Observação de logs
- Verifique logs de auditoria JSON no stdout: tentativas/sucesso/falha devem ter `traceId`.
- Toda request HTTP deve devolver `X-Request-ID` e os logs estruturados devem carregar `reqId`.
- Métricas de ação por roteador aparecem com prefixo `router.<mikId>.action.*` e `router.<mikId>.latency_ms_total` em `/relay/metrics`.

## 5) Limpeza
- Dados persistidos em `data/` (`devices.json`, jobs, processed events). Remova se precisar resetar:
```bash
rm -f data/devices.json data/jobs.json data/processed_events.json
```

## 6) Produção
- Desligue `RELAY_DRY_RUN`.
- Defina `RELAY_STRICT_SECURITY=1` para forçar segredos.
- Defina `RELAY_MASTER_KEY` antes de qualquer leitura de credenciais criptografadas.
- Ajuste `WG_INTERFACE`, `WG_VPS_PUBLIC_KEY`, `WG_VPS_ENDPOINT` e metas por roteador antes de aplicar configs reais.
