FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 relay
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY prisma ./prisma
RUN node_modules/.bin/prisma generate

USER relay
EXPOSE 3001
ENV PORT=3001
CMD ["node", "--experimental-vm-modules", "src/index.js"]
