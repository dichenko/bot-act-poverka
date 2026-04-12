FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=base /app/dist ./dist
COPY --from=base /app/migrations ./migrations

RUN mkdir -p /app/storage/acts /app/storage/offers

CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]

