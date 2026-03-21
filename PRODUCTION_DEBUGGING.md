# Production Debugging — Padrão Profissional

> Documento aplicando o feedback de arquitetura para evitar problemas nível produção.

---

## 🎯 O Problema Real (sem romantizar)

Seu deploy **não falha por Docker, CI ou código quebrado**.

Ele falha porque:

```
👉 Processo Node aborta no boot
👉 Container fica "up" mas unhealthy
👉 Healthcheck começa a dar HTTP 503
👉 Pipeline interpreta como falha geral
```

**Causa raiz em 99% dos casos:**

```
Variável obrigatória não chegou ao container
(mesmo que exista no .env do host)
```

---

## 🔥 Os 3 cenários que quase ninguém percebe

### ❌ Cenário 1: `.env` existe, mas não está sendo carregado

```bash
# Host tem .env aqui:
ls -la /opt/lopesul/apps/relay/.env  # ✅ existe

# Mas docker não carrega:
docker exec relay-real printenv | grep HMAC_SECRET  # ❌ vazio
```

**Causa:** docker-compose.yml não tem `env_file: - .env`

**Solução:**
```yaml
services:
  relay:
    env_file:
      - .env  # 👈 ISSO É CRÍTICO
```

---

### ❌ Cenário 2: `.env` está em outro path

```
/opt/lopesul/apps/relay/.env          ✅
mas docker-compose roda em:
/opt/lopesul/apps/relay/infra/
```

Resultado:
```
docker-compose up -d
# procura por ./infra/.env ❌
# não encontra /opt/lopesul/apps/relay/.env
```

**Solução:** Use caminho absoluto ou verifique onde docker-compose é executado

```yaml
env_file:
  - /opt/lopesul/apps/relay/.env  # caminho absoluto é mais seguro
```

---

### ❌ Cenário 3: Variável existe mas está vazia

```env
HMAC_SECRET=
DATABASE_URL=
```

Isso **quebra o boot** porque:

```js
if (!String(process.env[HMAC_SECRET] || "").trim()) {
  // Trata vazio como "não existe"
  bootError("missing env");
}
```

**Solução:** Validar no .env se variáveis têm valores

```bash
bash scripts/diagnose-env.sh
```

---

## ✅ Diagnóstico Profissional em 30 segundos

### 1. Ver logs de erro do container

```bash
docker logs relay-real | tail -n 50
```

Se aparecer:
```
dotenv failed
missing required env
```

👉 **É 100% variável de ambiente. Fim.**

---

### 2. Verificar se variáveis chegaram ao container

```bash
docker exec -it relay-real sh
```

Dentro do container:
```bash
printenv | grep HMAC_SECRET
printenv | grep DATABASE_URL
```

Se não aparecer nada:
👉 **Container não recebeu as vars**
👉 Solução: `docker-compose down && docker-compose up -d`

---

### 3. Usar o script de diagnóstico

```bash
bash scripts/diagnose-env.sh
```

Ele verifica:
- ✅ `.env` existe?
- ✅ `docker-compose.yml` tem `env_file`?
- ✅ Variáveis obrigatórias têm valores?
- ✅ Container recebeu as vars?
- ✅ Container está healthy?

---

## 🚀 Workflow Profissional para Deploy

### Pré-deploy (no servidor)

```bash
# 1. Clone/update repo
cd /opt/lopesul/apps/relay
git pull origin main

# 2. Verificar .env
cat .env | head -20  # validar valores

# 3. Diagnostic check
bash scripts/diagnose-env.sh

# Se passou:
docker-compose down -v
docker-compose up -d
```

### Pós-deploy (verificação)

```bash
# Aguarde 60 segundos
sleep 60

# Check 1: Logs
docker logs relay-real | tail -20

# Check 2: Health
curl http://localhost:3000/health/live
# Deve retornar: {"status":"live"}

# Check 3: Process
docker ps relay-real
# Status deve ser: Up ... (healthy)
```

---

## 📊 Tabela de Diagnóstico

| Sintoma | Causa | Verificar | Solução |
|---------|-------|-----------|---------|
| `dotenv failed` | .env não carregado | `docker logs relay` | Verificar `env_file` em docker-compose.yml |
| `missing required env: HMAC_SECRET` | Var vazia ou ausente | `docker exec relay-real printenv \| grep HMAC` | Editar .env com valor não-vazio |
| `HTTP 503` contínuo | App não subiu | `docker logs relay \| tail -50` | Rodar `diagnose-env.sh` |
| `Container unhealthy` | Healthcheck falha | `docker exec relay-real wget -qO- http://127.0.0.1:3000/health/live` | Ver logs da aplicação |
| Var existe mas vazia | Arquivo .env mal preenchido | `grep HMAC_SECRET .env` | Adicionar valor: `HMAC_SECRET=valor_aqui` |

---

## 💡 Insights Arquiteturais

### Por que HMAC_SECRET é tão crítico?

```
1. Assina requisições entre Dashboard → Relay
2. Valida integridade de comandos MikroTik
3. Protege fluxo Pix → Liberação de acesso

Sem isso: ❌ Qualquer um consegue libertar cliente
```

### Por que container fica "up" mas unhealthy?

```
Docker vê:
- Processo node está rodando ✅

Mas healthcheck vê:
- GET /health/live → 503 ❌
- App não consegue servir requisições

Resultado: container está "up" mas "unhealthy"
```

---

## 🛡️ Checklist Blindado para Produção

- [ ] `.env` existe em `/opt/lopesul/apps/relay/.env`
- [ ] `docker-compose.yml` tem `env_file: - .env` configurado
- [ ] `HMAC_SECRET` tem valor não-vazio
- [ ] `DATABASE_URL` aponta para DB acessível
- [ ] `WG_PRIVATE_KEY` é uma chave válida (formato wg genkey)
- [ ] `WG_INTERFACE` existe no host (`ip link show wg0`)
- [ ] `NODE_ENV=production`
- [ ] Redis está rodando (`docker exec relay-redis redis-cli ping`)
- [ ] Healthcheck passa (`curl http://localhost:3000/health/live`)
- [ ] Logs não têm erros (`docker logs relay-real | tail -20`)

---

## 🧪 Teste de Verdade

```bash
# 1. Stop tudo
docker-compose down -v

# 2. Remova credenciais de .env (simule falha)
cp .env .env.backup
echo "HMAC_SECRET=" > .env

# 3. Inicie
docker-compose up -d

# 4. Rode diagnóstico
bash scripts/diagnose-env.sh
# Deve falhar com mensagem clara

# 5. Restaure
cp .env.backup .env
docker-compose restart relay

# 6. Rode diagnóstico novamente
bash scripts/diagnose-env.sh
# Deve passar
```

---

## 📞 Suporte Rápido

Se healthcheck falha:

```bash
# 1. Primeiro passo SEMPRE
docker logs relay-real | tail -50

# 2. Se vir "missing required env"
bash scripts/diagnose-env.sh

# 3. Se diagnóstico passa mas healthcheck falha
docker exec relay-real wget -qO- http://127.0.0.1:3000/health
# Ver qual check específico está falhando

# 4. Se não souber, jogue tudo pra cima:
docker-compose down -v && docker-compose up -d && sleep 60 && curl http://localhost:3000/health/live
```

---

**Última lição:** Quando healthcheck falha em produção, 95% das vezes é env var não chegando ao container. Os outros 5% é Redis não estar acessível. Diagnóstico rapido solve tudo.

