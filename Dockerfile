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

RUN apk add --no-cache ca-certificates libreoffice ttf-dejavu

COPY package*.json ./
RUN npm ci --omit=dev

COPY certs/russian-trusted/*.crt /usr/local/share/ca-certificates/
RUN update-ca-certificates \
    && { \
         for cert in /usr/local/share/ca-certificates/russian_trusted_*.crt; do \
           cat "$cert"; \
           printf '\n'; \
         done; \
       } > /etc/ssl/certs/russian-trusted-ca-bundle.pem

ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/russian-trusted-ca-bundle.pem

COPY --from=base /app/dist ./dist
COPY --from=base /app/migrations ./migrations
COPY --from=base /app/template ./template

RUN mkdir -p /app/storage/acts /app/storage/acts/xlsx /app/storage/offers /app/template

CMD ["sh", "-c", "node dist/db/migrate.js && node dist/index.js"]

