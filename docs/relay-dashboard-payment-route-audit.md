# Auditoria de Rotas do Relay

Data da auditoria: 2026-03-24  
Branch auditado: `stable`  
Commit auditado: `e204fb4`

## Objetivo deste documento

Separar, de forma prática, quais rotas:

- fazem parte do fluxo de sessão que coincide com o fluxo-alvo e não devem ser apagadas sem substituição direta;
- fazem parte do fluxo atual de pagamento/identidade e só podem ser removidas depois que o Dashboard/Backend pararem de chamá-las;
- são rotas duplicadas ou colidentes e precisam entrar no plano de migração.

Fluxo-alvo informado:

1. Cliente conecta no Wi-Fi.
2. MikroTik intercepta e redireciona para o portal.
3. Portal/Backend chama `POST /session/init`.
4. Relay cria sessão em Redis.
5. Frontend escolhe plano.
6. Backend chama autorização da sessão.
7. Relay autoriza no MikroTik e mantém o ciclo de vida da sessão.

## Camadas de autenticação que afetam o Dashboard

- Rotas sob `/session/*` passam por `validateRelayAuth` em `src/index.js:400` e `src/index.js:262`.
- Rotas sob `/relay/*` e `/internal/*` passam por `authMiddleware` em `src/index.js:543` e `src/index.js:232`.
- O webhook `POST /api/webhooks/pagarme` não usa Bearer/HMAC do Relay; ele valida assinatura própria do PagarMe em `src/routes/pagarmeWebhook.js:21`.

## 1. Rotas críticas que coincidem com o fluxo de sessão e não devem ser apagadas

Estas são as rotas mais próximas do fluxo canônico que você descreveu. Se houver refatoração, elas devem ser preservadas por nome/finalidade ou substituídas de forma explícita.

| Rota | Quem chama | Papel atual | Fonte | Observação crítica |
| --- | --- | --- | --- | --- |
| `POST /session/init` | Portal/Backend/MikroTik | Cria sessão `pending` no `sessionStore` | `src/routes/sessionRoutes.js:144` | É a rota que mais coincide com o fluxo-alvo, mas hoje exige `sessionId` e `router` no payload, em vez de gerar `sessionId` server-side e resolver por `identity`. |
| `POST /session/authorize` | Backend após escolha de plano/pagamento | Autoriza no MikroTik e atualiza a sessão | `src/routes/sessionRoutes.js:203` | É a rota central do ciclo de liberação. Hoje usa `tempo` e `plano`, não `planId`/`pedidoId`, e não é o único caminho de autorização existente. |
| `GET /session/:sessionId` | Dashboard/Backend para consulta/polling | Lê o estado da sessão | `src/index.js:514` | Importante para observabilidade e para o painel consultar status sem bater direto no MikroTik. |
| `POST /session/revoke` | Scheduler/ops/manual | Revoga sessão usando `sessionId` | `src/routes/sessionRoutes.js:293` | Não está no fluxo de compra, mas participa do ciclo de vida e é a rota mais coerente para revogação orientada por sessão. |

### Contratos atuais dessas rotas críticas

#### `POST /session/init`

Payload atual:

```json
{
  "sessionId": "uuid-vindo-do-chamador",
  "ip": "10.0.0.10",
  "mac": "AA:BB:CC:DD:EE:FF",
  "router": "router-ou-host"
}
```

Comportamento atual:

- valida `ip` e `mac`;
- rejeita se `sessionId` já existir;
- persiste em Redis via `sessionStore.createSession(...)` em `src/routes/sessionRoutes.js:176`;
- grava `status: "pending"`.

Desvio em relação ao fluxo-alvo:

- o `sessionId` não é gerado pelo Relay;
- usa `router`, não `identity`;
- não grava índices dedicados `idx:ip:{ip}` e `idx:mac:{mac}`; a busca por IP/MAC no store atual varre sessões em memória a partir de `SCAN` em `src/services/sessionStore.js:117` e `src/services/sessionStore.js:126`.

#### `POST /session/authorize`

Payload atual:

```json
{
  "sessionId": "uuid",
  "tempo": 3600000,
  "plano": "nome-ou-objeto-opcional"
}
```

Comportamento atual:

- carrega sessão pelo `sessionId`;
- só permite quando `status === "pending"`;
- chama `addHotspotBinding(session)` em `src/routes/sessionRoutes.js:239`;
- atualiza sessão para `status: "authorized"` em `src/routes/sessionRoutes.js:254`.

Desvio em relação ao fluxo-alvo:

- aceita `tempo` e `plano`, não `planId` e `pedidoId`;
- não há lock explícito de idempotência;
- convive com outras rotas de autorização fora do fluxo de sessão.

## 2. Rotas do fluxo atual de pagamento/identidade

Estas rotas não são o fluxo canônico de sessão. Elas representam o fluxo de pagamento/acoplamento legado que hoje também fala com o Relay e, em vários casos, libera acesso no MikroTik sem passar pelo contrato de sessão.

Se o Dashboard ou o Backend ainda usam essas rotas, elas não podem ser apagadas de imediato. Primeiro é preciso migrar o chamador para o fluxo de sessão.

| Rota | Quem chama | Finalidade atual | Fonte | Observação |
| --- | --- | --- | --- | --- |
| `POST /api/webhooks/pagarme` | PagarMe | Valida a assinatura do webhook | `src/routes/pagarmeWebhook.js:21` | Hoje essa rota só valida e loga. Ela **não** autoriza sessão sozinha. |
| `POST /relay/authorize-by-pedido` | Backend/Painel | Liberação direta por `pedidoId + mikId + deviceToken` | `src/index.js:1727` | Bypassa o fluxo por `sessionId`. |
| `POST /relay/resync-device` | Backend/Painel | “Já paguei e não liberou” | `src/index.js:1752` | Re-sincroniza IP/MAC do device e chama autorização de pagamento de novo. |
| `POST /relay/revoke` | Scheduler/Painel técnico | Revoga por `mikId + ip/mac` | `src/index.js:1777` | Duplica semanticamente `POST /session/revoke`, mas sem usar `sessionId`. |
| `POST /relay/action` | Backend/Painel | Action bus genérico | `src/index.js:1798` | Pode disparar `AUTHORIZE_BY_PEDIDO`, `RESYNC_DEVICE` e `REVOKE_SESSION`. É outro caminho concorrente. |
| `POST /relay/identity/refresh` | Portal/Backend | Resolve `sid` + contexto atual e tenta autorizar pagamento pendente | `src/index.js:1818` | É uma ponte entre identidade pendente e liberação no MikroTik. |
| `GET /relay/identity/status` | Portal/Painel | Consulta estado público/operacional da identidade `sid` | `src/index.js:1834` | Não consulta `sessionStore`; consulta `identityStore`. |
| `POST /relay/identity/retry-now` | Painel operacional | Força reprocessamento imediato de pagamento pendente | `src/index.js:1952` | Usa cooldown por `sid` e agenda job. |

### Observação importante sobre webhook de pagamento

No estado atual do branch auditado:

- `POST /api/webhooks/pagarme` só verifica assinatura e registra log em `src/routes/pagarmeWebhook.js:61`;
- o acoplamento real de pagamento acontece fora dessa rota, pelo `stateMachine` em `src/services/stateMachine.js:199`;
- o estado pendente de pagamento vai para `identityStore`, não para `sessionStore`, em `src/services/stateMachine.js:201` e `src/services/identityStore.js:153`.

Ou seja: o fluxo de pagamento atual não está centralizado em sessão.

## 3. Rotas do Dashboard que são operacionais/monitoramento

Estas rotas não são necessariamente do fluxo de compra, mas costumam ser relevantes para painel, suporte e operação.

| Rota | Uso | Fonte | Observação |
| --- | --- | --- | --- |
| `GET /relay/status` | Status geral do Relay para o Dashboard | `src/index.js:556` | Monitoramento autenticado. |
| `GET /relay/wireguard/status` | Estado do túnel WireGuard | `src/index.js:594` | Observabilidade técnica. |
| `GET /relay/health` | Healthcheck simples autenticado | `src/index.js:551` | Útil para o painel; não confundir com `/health`. |
| `GET /health`, `GET /health/ready`, `GET /health/live` | Health público de deploy/infra | `src/index.js:349` | Importante para deploy e infra, não para pagamento. |
| `POST /relay/routers/routers/register` | Cadastro de roteador/MikroTik via dashboard | `src/index.js:632` + `src/routes/routerRegistry.js:11` | O path final ficou duplicado por causa do mount. Se o painel usa isso, não apagar sem corrigir o cliente. |
| `POST /relay/manager/register` | Provisionamento de manager/túnel | `src/index.js:1671` | Operacional, fora do fluxo de sessão/pagamento. |

## 4. Colisões de fluxo que você precisa tratar no desenho da migração

### Colisão A: criação de sessão

Existem dois pontos de entrada para “começar” uma sessão:

- `POST /session/init` em `src/routes/sessionRoutes.js:144`
- `POST /session/start` em `src/index.js:403`

Impacto:

- os dois criam sessão;
- só um deles coincide com o nome do fluxo-alvo (`/session/init`);
- manter os dois aumenta o risco de o Dashboard ou o Portal chamar o endpoint errado.

### Colisão B: autorização

Hoje existem pelo menos quatro caminhos de autorização:

- `POST /session/authorize`
- `POST /relay/authorize-by-pedido`
- `POST /relay/action` com `AUTHORIZE_BY_PEDIDO`
- `POST /relay/identity/refresh`

Impacto:

- mais de um contrato faz liberação no MikroTik;
- nem todos usam `sessionId`;
- parte do fluxo trabalha com `pedidoId + mikId + deviceToken`, e outra parte com `sid`.

### Colisão C: revogação

Hoje existem dois caminhos principais de revogação:

- `POST /session/revoke` orientado por `sessionId`
- `POST /relay/revoke` orientado por `mikId + ip/mac`

Impacto:

- o primeiro é coerente com ciclo de vida de sessão;
- o segundo bypassa a sessão e fala direto em termos de roteador/endereço.

### Colisão D: origem do estado

O fluxo de sessão usa Redis em `src/services/sessionStore.js:81`.  
O fluxo de pagamento/identidade usa:

- `identityStore` file-backed em `src/services/identityStore.js:10`;
- `jobStore` com fallback file/SQLite/Redis em `src/services/jobStore.js:2`;
- `eventConsumer` com fallback em arquivo `events_queue.json` em `src/services/eventConsumer.js:2`.

Impacto:

- o Dashboard pode estar conversando com rotas que não usam a mesma fonte de verdade;
- qualquer limpeza de rota precisa considerar a migração de estado, não só do endpoint.

## 5. Classificação prática do que não apagar agora

### Grupo A — manter obrigatoriamente no fluxo-alvo

Estas rotas devem continuar existindo como base do fluxo de sessão:

- `POST /session/init`
- `POST /session/authorize`
- `GET /session/:sessionId`
- `POST /session/revoke`

### Grupo B — manter até migrar o painel/backend

Estas rotas hoje participam do fluxo real de pagamento ou identidade. Não apagar antes de confirmar que nenhum chamador ainda depende delas:

- `POST /api/webhooks/pagarme`
- `POST /relay/authorize-by-pedido`
- `POST /relay/resync-device`
- `POST /relay/revoke`
- `POST /relay/action`
- `POST /relay/identity/refresh`
- `GET /relay/identity/status`
- `POST /relay/identity/retry-now`

### Grupo C — candidatas fortes a congelar/deprecar quando o fluxo de sessão assumir tudo

Estas rotas são duplicadas, auxiliares ou contradizem o fluxo único que você quer atingir:

- `POST /session/start`
- `POST /session/kick`
- `GET /session/active`
- `POST /relay/authorize-by-pedido`
- `POST /relay/resync-device`
- `POST /relay/revoke`
- `POST /relay/action`
- `POST /relay/identity/refresh`
- `GET /relay/identity/status`
- `POST /relay/identity/retry-now`

## 6. Tradução do fluxo-alvo para as rotas atuais

### Trecho do fluxo que já tem rota equivalente

| Etapa do fluxo | Rota equivalente hoje | Situação |
| --- | --- | --- |
| Criar sessão inicial | `POST /session/init` | Existe, mas com contrato divergente |
| Consultar sessão | `GET /session/:sessionId` | Existe |
| Autorizar sessão | `POST /session/authorize` | Existe, mas com contrato divergente |
| Encerrar/revogar sessão | `POST /session/revoke` | Existe |

### Trecho do fluxo que hoje está fora da trilha de sessão

| Etapa do fluxo | Como acontece hoje |
| --- | --- |
| Pagamento confirmado | Pode entrar por webhook, por event consumer, por `stateMachine` ou por painel/backend direto |
| Liberação pós-pagamento | Pode acontecer por `authorize-by-pedido`, `action`, `identity/refresh` ou `session/authorize` |
| Reprocesso de falha | Pode acontecer por `resync-device`, `identity/retry-now`, jobs e event consumer |

## 7. Leitura final para decisão de produto/arquitetura

Se a meta é “um fluxo só”, o que você deve considerar como base imutável do contrato externo é:

- `POST /session/init`
- `POST /session/authorize`
- `GET /session/:sessionId`
- `POST /session/revoke`

Todo o resto que fala de:

- `pedidoId + mikId + deviceToken`,
- `sid` fora de `sessionStore`,
- jobs/eventos de pagamento,
- revogação direta por `ip/mac`,

é fluxo paralelo, legado ou transitório no estado atual do branch auditado.

Em outras palavras:

- o Dashboard não deve perder as rotas de sessão acima;
- o fluxo de pagamento atual ainda depende de rotas fora de sessão;
- antes de apagar rotas de pagamento/identidade, você precisa confirmar se o painel/backend ainda chama alguma delas.
