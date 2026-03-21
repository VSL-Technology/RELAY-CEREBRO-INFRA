# Control Plane Core (Mode B)

Este modo faz migracao gradual:
- estado desejado em Postgres (Prisma)
- estado real lido via `wg show <interface> dump`
- fallback para JSON quando `CONTROL_PLANE_FALLBACK_JSON=true`

## Flags
- `CONTROL_PLANE_MODE` (default: `B`)
- `CONTROL_PLANE_FALLBACK_JSON` (default: `true`)
- `CONTROL_PLANE_WRITE_DB` (default: `true`)
- `TENANT_AUTO_DISCOVERY_MODE` (default: `default`)
- `TENANT_IP_MAP` (default: vazio)

## JOB_RUNNER_ENABLED
- `true` (default): ativa execucao de jobs e mantem comportamento atual (inclui uso de `MIKROTIK_NODES` quando necessario durante processamento)
- `false`: desativa o JobRunner no boot e ignora validacao de `MIKROTIK_NODES` nessa etapa

## Modelo de dados
- `Router`: estado desejado + estado real agregado por roteador
- `WireguardPeer`: estado desejado + estado real por peer

## Seed inicial (nao destrutivo)
```bash
node scripts/control-plane/seedFromJson.js
```

Le os arquivos abaixo se existirem:
- `data/devices.json`
- `data/peers.meta.json`
- `src/state/peers.meta.json`

## Reconciler (modo B)
1. Lista tenants ativos (com fallback seguro para `default`).
2. Le estado real do WireGuard via `wg show`.
3. Executa mini-ciclo por tenant (`tenant-scoped`).
4. Atualiza `actualState`, `lastHandshake`, `bytesRx`, `bytesTx` no banco somente do tenant em processamento.
5. Mantem fallback JSON no tenant `default` quando habilitado.

## Multi-tenant isolation
- `Router` e `WireguardPeer` sao lidos/escritos com filtro por tenant no Mode B.
- O reconciler evita atualizar roteador/peer fora do tenant corrente.
- Em caso de mismatch, o ciclo registra `reconciler.tenant_mismatch_skip` e ignora o item.

## Auto-discovery por tenant
- Modo `default`: peers extras caem no tenant `default`.
- Modo `by-endpoint-ip`: tenta resolver o tenant pelo host do endpoint WireGuard.

Formato de `TENANT_IP_MAP`:
```bash
TENANT_IP_MAP="149.19.175.236=default;10.10.0.5=clienteX"
```

Regras:
- se o `slug` mapeado existir, auto-discovery usa esse tenant.
- se o `slug` nao existir, faz fallback para `default`.
- se nao houver match de IP, faz fallback para `default`.

## Logs esperados
- `reconciler.started`
- `reconciler.tenant_cycle_started`
- `reconciler.tenant_db_read_ok`
- `reconciler.tenant_write_db_ok`
- `reconciler.tenant_cycle_done`
- `reconciler.db_read_ok`
- `reconciler.db_read_fail`
- `reconciler.wg_dump_ok`
- `reconciler.wg_dump_fail`
- `reconciler.write_db_ok`
- `reconciler.write_db_fail`
- `reconciler.fallback_json_used`

## Health
`GET /health` retorna:
- `controlPlane.mode`
- `controlPlane.dbConnected`
- `controlPlane.wgInterface`
- `controlPlane.wgInterfacePresent`
