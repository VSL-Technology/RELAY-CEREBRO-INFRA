# Control Plane Core (Mode B)

Este modo faz migracao gradual:
- estado desejado em Postgres (Prisma)
- estado real lido via `wg show <interface> dump`
- fallback para JSON quando `CONTROL_PLANE_FALLBACK_JSON=true`

## Flags
- `CONTROL_PLANE_MODE` (default: `B`)
- `CONTROL_PLANE_FALLBACK_JSON` (default: `true`)
- `CONTROL_PLANE_WRITE_DB` (default: `true`)

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
1. Le desired state do banco.
2. Se DB falhar e fallback estiver habilitado, usa JSON.
3. Le estado real com `wg show`.
4. Atualiza `actualState`, `lastHandshake`, `bytesRx`, `bytesTx` no banco.

## Logs esperados
- `reconciler.started`
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
