FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache wireguard-tools

# Copia manifestos primeiro
COPY package*.json ./
COPY prisma ./prisma

# Instala dependências
RUN npm ci --omit=dev

# Gera Prisma Client
RUN npx prisma generate

# Copia restante do projeto
COPY . .

EXPOSE 3001

CMD ["node", "src/index.js"]