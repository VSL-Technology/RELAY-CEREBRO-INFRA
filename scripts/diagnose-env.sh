#!/bin/bash

# Script de diagnóstico profissional — verifica se ambiente está blindado

set -e

echo "════════════════════════════════════════════════════════"
echo "🔍 DIAGNÓSTICO DE AMBIENTE — Relay Cerebro Infra"
echo "════════════════════════════════════════════════════════"
echo ""

# 1. Verificar se .env existe
echo "1️⃣  Verificando arquivo .env..."
if [ -f ".env" ]; then
  echo "   ✅ .env existe"
  echo "   📍 Localização: $(pwd)/.env"
else
  echo "   ❌ .env NÃO ENCONTRADO"
  echo "   💡 Solução: cp .env.example .env && nano .env"
  exit 1
fi

# 2. Verificar se docker-compose tem env_file
echo ""
echo "2️⃣  Verificando docker-compose.yml..."
if grep -q "env_file:" docker-compose.yml; then
  echo "   ✅ docker-compose.yml tem 'env_file' configurado"
else
  echo "   ❌ docker-compose.yml sem 'env_file'"
  echo "   💡 Solução: adicione 'env_file: - .env' na seção 'relay'"
  exit 1
fi

# 3. Verificar variáveis obrigatórias no .env
echo ""
echo "3️⃣  Verificando variáveis obrigatórias..."

REQUIRED=("DATABASE_URL" "RELAY_API_SECRET" "WG_PRIVATE_KEY" "WG_INTERFACE" "NODE_ENV")
MISSING=()

for var in "${REQUIRED[@]}"; do
  VALUE=$(grep "^${var}=" .env | cut -d'=' -f2- | xargs)
  if [ -z "$VALUE" ]; then
    echo "   ❌ ${var} = <VAZIO>"
    MISSING+=("$var")
  else
    # Mostrar apenas primeiros 16 caracteres (segurança)
    SHORT=$(echo "$VALUE" | cut -c1-16)
    echo "   ✅ ${var} = ${SHORT}..."
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  echo "   🚨 VARIÁVEIS FALTANDO: ${MISSING[*]}"
  echo "   💡 Solução: nano .env e preencha com valores não-vazios"
  exit 1
fi

# 4. Se container está rodando, verificar se recebeu as vars
echo ""
echo "4️⃣  Verificando se Docker recebeu as variáveis..."

if docker ps | grep -q "relay-real"; then
  echo "   🐳 Container 'relay-real' está rodando"

  # Verificar RELAY_API_SECRET inside container
  if docker exec relay-real printenv | grep -q "^RELAY_API_SECRET="; then
    echo "   ✅ Container recebeu RELAY_API_SECRET"
  else
    echo "   ❌ Container NÃO recebeu RELAY_API_SECRET"
    echo "   💡 Solução: docker-compose down && docker-compose up -d"
    exit 1
  fi

  # Verificar health status
  HEALTH=$(docker inspect relay-real --format='{{.State.Health.Status}}' 2>/dev/null || echo "no healthcheck")
  if [ "$HEALTH" = "healthy" ]; then
    echo "   ✅ Container está HEALTHY"
  elif [ "$HEALTH" = "unhealthy" ]; then
    echo "   ❌ Container está UNHEALTHY"
    echo "   💡 Veja logs: docker-compose logs relay"
    exit 1
  else
    echo "   ⏳ Health status: $HEALTH (aguarde 60s)"
  fi
else
  echo "   ⏳ Container 'relay-real' não está rodando"
  echo "   💡 Inicie com: docker-compose up -d"
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "✅ TUDO OK — Ambiente está blindado para produção"
echo "════════════════════════════════════════════════════════"
echo ""
echo "Próximos passos:"
echo "  • docker-compose logs -f relay  (para monitorar em tempo real)"
echo "  • curl http://localhost:3000/health/live  (verificar se está saudável)"
echo ""
