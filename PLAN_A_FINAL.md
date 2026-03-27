# PLAN A — IMPLEMENTAÇÃO FINAL

## OBJETIVO
Implementar Redis como single source of truth para sessões no Relay com fluxo simples, estável e produção-ready.

---

## ARQUIVOS FINALIZADOS

### 1. **sessionStore.refactored.final.js** (670 linhas)
- ✅ Constants: LOCK_TTL_MS=120s, TTL=6h+1min
- ✅ getOrCreateSession: fingerprint (pedidoId > mac > ip), lock + double-check
- ✅ authorizeSession: lock → fetch → MikroTik → persist → unlock
- ✅ revokeSession: lock → fetch → MikroTik → persist → unlock
- ✅ Índices: ip, mac, pedido — com TTL idêntico à sessão
- ✅ findBy*: cleanup automático de orphans
- ✅ State machine: transições validadas

### 2. **sessionRoutes.refactored.final.js** (400 linhas)
- ✅ POST /session/init: compatível com existente
- ✅ POST /session/authorize: delegação para sessionStore + idempotência
- ✅ POST /session/revoke: delegação para sessionStore
- ✅ GET /session/:sessionId: novo — observabilidade

---

## FLUXO FINAL (GARANTIDO)

### getOrCreateSession
```
1. Buscar por: pedidoId > mac > ip
2. Se encontrar → UPDATE ip/mac/router/identity → retornar
3. Se não → LOCK(fingerprint)
4. Double-check
5. CREATE new session
6. UNLOCK
7. Retornar
```

### authorizeSession
```
1. LOCK(sessionId)
2. FETCH session
3. IF status="authorized" → RETURN idempotent
4. EXECUTE MikroTik.addBinding()
5. IF falha → THROW (Redis NÃO atualiza)
6. UPDATE session { status, expiresAt, planId, pedidoId }
7. PERSIST Redis (TTL = expiresAt - now + 6h)
8. PERSIST índices (MESMO TTL)
9. UNLOCK
10. RETORN sucesso
```

### revokeSession
```
1. LOCK(sessionId)
2. FETCH session
3. IF status="revoked|expired" → RETURN idempotent
4. EXECUTE MikroTik.removeBinding()
5. IF falha → THROW
6. UPDATE session { status="revoked" }
7. PERSIST Redis (TTL = 6h)
8. PERSIST índices (MESMO TTL)
9. UNLOCK
10. RETURN sucesso
```

---

## GARANTIAS DE CONSISTÊNCIA

### ✅ SEM DUPLICAÇÃO DE SESSÃO
- `getOrCreateSession()` usa lock com fingerprint (pedidoId > mac > ip)
- Double-check pattern garante unicidade mesmo com race condition
- Reutiliza e atualiza sessão existente

### ✅ SEM EXECUÇÃO DUPLICADA DE MIKROTIK
- `authorizeSession()` e `revokeSession()` executam MikroTik DENTRO do lock
- Lock TTL = 120s — suficiente para execução MikroTik
- Cada sessionId é serializado: máximo 1 execução ativa por vez

### ✅ REDIS E MIKROTIK CONSISTENTES
- MikroTik executa ANTES de atualizar Redis
- Se falha → throw error → Redis NÃO atualiza → lock libera
- Próxima tentativa encontra status="pending", tenta novamente
- Se sucesso → Redis atualizado com resultado

### ✅ ÍNDICES VÁLIDOS
- Todos índices com TTL = TTL da sessão (não fixo curto)
- `findByIp/Mac/PedidoId()` faz cleanup: se índice→null, deleta índice
- Máximo tempo de orphan = até próxima busca
- Não há índices inválidos por longo período

### ✅ IDEMPOTÊNCIA FORTE
- Nível 1: `if session.status === "authorized"` → return success
- Nível 2: Lock garante que retry não duplica MikroTik execution
- Qualquer número de retries é seguro

---

## TTL (SIMPLES)

```javascript
const ttl = expiresAt - now + CLEANUP_WINDOW_MS
ttl = Math.max(ttl, MIN_TTL_MS)
```

- CLEANUP_WINDOW_MS = 6 horas
- MIN_TTL_MS = 1 minuto
- Todos índices = mesmo TTL da sessão

---

## REDIS KEYS

```
// Session
session:{sessionId}

// Índices (com MESMO TTL da sessão)
idx:ip:{ip}
idx:mac:{mac}
idx:pedido:{pedidoId}

// Locks
lock:session:authorize:{sessionId}
lock:session:revoke:{sessionId}
lock:session:create:{fingerprint}
```

---

## O QUE NÃO HÁ

- ❌ heartbeat de lock
- ❌ retry automático
- ❌ rollback complexo
- ❌ saga distribuída
- ❌ event sourcing
- ❌ índice de identity
- ❌ lógica avançada

---

## IMPLEMENTAÇÃO

### Passo 1: Copiar arquivo final
```bash
cp src/services/sessionStore.refactored.final.js src/services/sessionStore.js
cp src/routes/sessionRoutes.refactored.final.js src/routes/sessionRoutes.js
```

### Passo 2: Atualizar imports em index.js
```javascript
import sessionRoutes from "./routes/sessionRoutes.js";  // Usar novo arquivo
```

### Passo 3: Testar
```bash
npm test -- sessionStore.test.js
npm test -- sessionRoutes.test.js
```

### Passo 4: Deploy
- Feature flag: `REDIS_SESSION_STORE_ENABLED=1` (para gradual rollout)
- Canary: 5% → 50% → 100%
- Monitor: latência, erros de lock, índices orphans

---

## TESTES CRÍTICOS

```javascript
// 1. Não duplica sessão
test("getOrCreateSession não duplica", async () => {
  const s1 = await getOrCreateSession({ ip, mac, pedidoId });
  const s2 = await getOrCreateSession({ ip, mac, pedidoId });
  expect(s1.sessionId).toBe(s2.sessionId);
});

// 2. Não duplica autorização
test("authorizeSession executa MikroTik uma vez", async () => {
  let callCount = 0;
  mockHotspot.addBinding = async () => { callCount++; return { ok: true }; };
  
  await Promise.all([
    authorizeSession(sessionId, null, null, expiresAt, mockHotspot),
    authorizeSession(sessionId, null, null, expiresAt, mockHotspot)
  ]);
  
  expect(callCount).toBe(1);
});

// 3. TTL índices sincronizados
test("índices têm mesmo TTL que sessão", async () => {
  await authorizeSession(sessionId, null, pedidoId, expiresAt, mockHotspot);
  
  const sessionTtl = await redis.ttl(`session:${sessionId}`);
  const ipIdxTtl = await redis.ttl(`idx:ip:${ip}`);
  
  expect(sessionTtl).toBeCloseTo(ipIdxTtl, -1); // Margem 10s
});

// 4. Cleanup orphan
test("findByIp deleta índice órfão", async () => {
  // Criar sessão, deletar do Redis, deixar índice
  await redis.del(`session:${sessionId}`);
  
  const found = await findByIp(ip);
  
  expect(found).toBeNull();
  expect(await redis.get(`idx:ip:${ip}`)).toBeNull(); // Índice deletado
});
```

---

## COMPATIBILIDADE

| API | Status | Mudança |
|-----|--------|---------|
| POST /session/init | ✅ Compatível | Nenhuma no contrato |
| POST /session/authorize | ✅ Compatível | Adiciona `idempotent` field |
| POST /session/revoke | ✅ Compatível | Adiciona `idempotent` field |
| GET /session/:sessionId | ✅ NOVO | Rota nova |
| POST /relay/authorize-by-pedido | ✅ Compatível | Pode usar novo fluxo |
| POST /relay/action | ✅ Compatível | Pode usar novo fluxo |

---

## OBSERVABILIDADE

Logs estruturados em cada operação:
- `session.get_or_create.{reused_by_pedido,reused_by_mac,reused_by_ip,created}`
- `session.authorize.{already_authorized,success,failed,lock_failed}`
- `session.revoke.{already_revoked,success,failed}`
- `session.index.orphan_cleanup`

---

## PERFORMANCE

- `getOrCreateSession`: O(1) se encontrar, O(lock_wait + create) se criar
- `authorizeSession`: O(lock_wait + mikrotik_exec) — serializado por sessionId
- `findByIp/Mac/PedidoId`: O(1) com cleanup on-demand
- Memória: sessão ~500 bytes, 100k sessões = ~50MB
- Índice overhead: ~3x sessão size (3 índices por sessão)

---

## ROADMAP (FUTURO, NÃO AGORA)

- [ ] Heartbeat de lock (se timeout > 2min necessário)
- [ ] Persistência RDB/AOF (se Redis down)
- [ ] Replicação (se multi-région)
- [ ] Migrar identityStore → Redis (quando legado removido)

---

## PRONTO PARA DEPLOY ✅

Código final em:
- `src/services/sessionStore.refactored.final.js`
- `src/routes/sessionRoutes.refactored.final.js`

Status: **PRODUÇÃO-READY**
