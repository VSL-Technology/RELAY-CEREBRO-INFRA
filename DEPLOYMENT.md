# Deployment Guide — Relay Cerebro Infra

## Pre-requisites

Antes de fazer deploy, certifique-se que o servidor tem:

- Docker e Docker Compose instalados
- PostgreSQL rodando (ou uma URL de banco disponível)
- Redis rodando (ou será criado via docker-compose)
- WireGuard configurado no host (se usar WG)

## Server Setup

### 1. Clone o repositório

```bash
cd /opt/lopesul/apps
git clone https://github.com/VSL-Technology/RELAY-CEREBRO-INFRA.git relay
cd relay
```

### 2. Configure o arquivo `.env` (CRÍTICO)

```bash
cp .env.example .env
nano .env  # ou seu editor preferido
```

### ⚠️ VARIÁVEIS OBRIGATÓRIAS

Edite o `.env` e preencha **todas estas variáveis**:

```
# Environment
NODE_ENV=production

# ⚠️ REQUIRED - Gere com: openssl rand -hex 32
RELAY_API_SECRET=seu_secret_aqui

# ⚠️ REQUIRED - Gere com: wg genkey
WG_PRIVATE_KEY=sua_chave_privada_wg_aqui

# ⚠️ REQUIRED - Sua interface WireGuard
WG_INTERFACE=wg0

# ⚠️ REQUIRED - URL do PostgreSQL
DATABASE_URL=postgresql://user:pass@localhost:5432/relay

# Redis (deixar como está se usar docker-compose)
REDIS_URL=redis://redis:6379
REDIS_HOST=redis
```

**Gerar chaves:**

```bash
# Para RELAY_API_SECRET:
openssl rand -hex 32

# Para WG_PRIVATE_KEY:
wg genkey
```

### 3. Inicie os containers

```bash
docker-compose up -d
```

### 4. Verifique se está saudável

```bash
# Aguarde 30-60 segundos, depois:
curl http://localhost:3000/health/live

# Deve retornar: {"status":"live"}
```

Se retornar 503, veja os logs:

```bash
docker-compose logs relay
```

## Health Check Failures

### 503 "redis.error: connect ECONNREFUSED"

**Causa:** Redis não está rodando ou não está acessível.

**Solução:**

```bash
# Verifique se Redis está rodando
docker-compose ps relay-redis

# Se não estiver, inicie:
docker-compose up -d redis

# Ou limpe tudo e reinicie:
docker-compose down -v
docker-compose up -d
```

### 503 "missing env: RELAY_API_SECRET"

**Causa:** Variável obrigatória não está no `.env`.

**Solução:**

1. Verifique se `.env` existe: `ls -la /opt/lopesul/apps/relay/.env`
2. Verifique se tem `RELAY_API_SECRET`: `grep RELAY_API_SECRET .env`
3. Se estiver vazio ou faltando, edite e preencha:

```bash
nano .env
# Procure por RELAY_API_SECRET= e preencha com um valor gerado:
# openssl rand -hex 32
```

4. Reinicie o container:

```bash
docker-compose restart relay
```

## GitHub Actions Deployment

Quando você faz push para `main`, o GitHub Actions automaticamente:

1. ✅ Faz build da imagem Docker
2. ✅ SSH para o servidor
3. ✅ Faz `git pull origin main`
4. ✅ Executa `docker-compose down && docker-compose up -d`
5. ✅ Verifica health check

**Se falhar:**

- Verifique o `.env` no servidor: `cat /opt/lopesul/apps/relay/.env`
- Verifique os logs: `docker-compose logs -f relay`
- Confirme as variáveis obrigatórias estão todas preenchidas

## Monitoring

### Ver logs em tempo real

```bash
docker-compose logs -f relay
```

### Check health status

```bash
curl http://localhost:3000/health
```

Deve retornar:

```json
{
  "status": "ok",
  "uptime": 1234,
  "checks": {
    "database": "ok",
    "redis": "ok"
  }
}
```

## Troubleshooting

| Erro | Causa | Solução |
|------|-------|--------|
| `dotenv failed` | .env não encontrado | Criar .env com variáveis obrigatórias |
| `missing env: RELAY_API_SECRET` | Variável não preenchida | Editar .env e preencher |
| `connect ECONNREFUSED 127.0.0.1:6379` | Redis não está rodando | `docker-compose up -d redis` |
| `HTTP 503` | App não está saudável | Ver logs: `docker-compose logs relay` |

---

**Dúvidas?** Verifique `.env.example` para lista completa de variáveis disponíveis.
