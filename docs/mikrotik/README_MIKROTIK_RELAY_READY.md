# MikroTik Relay-ready (3F)

Este pacote configura um MikroTik para operar com o Relay CEREBRO INFRA no modelo atual:
- liberacao de pagos por `address-list` + `ip-binding type=bypassed`
- hotspot padrao `hotspot1`
- API RouterOS 8728 restrita a origem da VPS
- WireGuard opcional usando endpoint DNS

Arquivo principal: [`MIKROTIK_HOTSPOT_RELAY_READY.rsc`](./MIKROTIK_HOTSPOT_RELAY_READY.rsc)

## Como aplicar
1. Ajuste as variaveis no topo do `.rsc` (identity, senha API, IP WG local, IP VPS).
2. No Winbox/SSH, importe o script:
```rsc
/import file-name=MIKROTIK_HOTSPOT_RELAY_READY.rsc
```
3. Revise mensagens `[warn]` no terminal.

## Por que cada bloco existe
- DNS: garante resolucao do portal e endpoint WG.
- Hotspot base (`hs-pool`, `hs-profile`, `hotspot1`): padroniza o ambiente para o fluxo cativo.
- Walled Garden: permite portal/pagamento antes de autenticar.
- NAT WAN: garante saida para internet no cenario padrao.
- `paid_clients` + bypass: compatibilidade direta com o que o Relay escreve hoje.
- API 8728 segura: Relay so acessa RouterOS vindo da VPS autorizada.
- WireGuard opcional: prepara tunel de gestao e deixa endpoint por DNS.

## Nomes que precisam casar com o Relay
- `RELAY_PAID_CLIENTS_LIST` (Relay): default `paid_clients`.
  - No script: variavel `RELAY_PAID_LIST`.
- `RELAY_HOTSPOT_SERVER` (padrao operacional): use `hotspot1`.
  - No script: variavel `HOTSPOT_SERVER` (default `hotspot1`).
  - Observacao: no codigo atual do Relay, o nome do hotspot nao e lido diretamente; manter `hotspot1` evita divergencia com playbooks/processo.

## Walled Garden e wildcard
No RouterOS, wildcard em `dst-host` pode variar conforme versao. Por isso o script:
- cria entradas explicitas (`painel.3fconnet.cloud`, `3fconnet.cloud`, etc.)
- adiciona `*.3fconnet.cloud` apenas como best-effort adicional

Para Pagar.me, o script inclui hosts recomendados e placeholders comentados para completar conforme o checkout real.

## Conflitos comuns (ip-binding)
Se ja existir `ip-binding` legado para o mesmo cliente com `type=blocked`/`regular`, isso pode conflitar com o bypass criado pelo Relay (`type=bypassed`).
Revise periodicamente:
```rsc
/ip hotspot ip-binding print detail
```

## WireGuard (modelo correto)
- IP local do MikroTik: `10.200.200.X/24`
- Peer da VPS (`allowed-address` no MikroTik): `10.200.200.1/32`
- Endpoint: `wg.3fconnet.cloud:51820`
- `persistent-keepalive=25`

## Checklist final
1. DNS resolve `painel.3fconnet.cloud` e `wg.3fconnet.cloud`.
2. Hotspot `hotspot1` esta `running`.
3. API 8728 responde apenas da VPS (WG e/ou IP publico configurado).
4. WireGuard mostra handshake (quando enlace/roteamento permitir).
5. Teste do portal abre: `http://painel.3fconnet.cloud/pagamento`.

## Comandos de validacao rapida
```rsc
/system identity print
/ip hotspot print detail where name="hotspot1"
/ip hotspot walled-garden print where comment~"relay-wg"
/ip firewall address-list print where list="paid_clients"
/ip service print where name="api"
/ip firewall filter print where comment~"RELAY API"
/interface wireguard print
/interface wireguard peers print detail
```
