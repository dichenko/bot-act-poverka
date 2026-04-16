FROM node:20-alpine AS base
WORKDIR /app

COPY package*.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY template ./template

RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache libreoffice ttf-dejavu

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=base /app/dist ./dist
COPY --from=base /app/migrations ./migrations
COPY --from=base /app/template ./template

RUN mkdir -p /app/storage/acts /app/storage/acts/xlsx /app/storage/offers /app/template

CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]

