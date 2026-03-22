FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache wireguard-tools && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 relay && \
    chmod u+s /usr/bin/wg

COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY prisma ./prisma
RUN npx --yes prisma generate

RUN mkdir -p data && chown relay:nodejs data
USER relay
EXPOSE 3001
ENV PORT=3001
ENV HOSTNAME=0.0.0.0
CMD ["sh", "-c", "node src/index.js"]
