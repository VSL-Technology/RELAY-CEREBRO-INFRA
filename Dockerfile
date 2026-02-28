FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache wireguard-tools

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["npm","start"]
