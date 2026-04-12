# MAX Act Generation Bot

Production-oriented MAX messenger bot in TypeScript for generating water meter inspection acts (PDF), with PostgreSQL, pgAdmin, YooKassa payments, external DB import, admin tools, and webhook mode.

## Implemented stack

- TypeScript + Node.js
- Official MAX SDK: `@maxhub/max-bot-api`
- PostgreSQL + SQL migrations
- pgAdmin (in Docker Compose)
- Webhook HTTP server on Express
- YooKassa integration (payments + webhook)
- PDF generation
- Docker Compose deployment for VPS
- HTTPS reverse proxy via Caddy

## Important MAX SDK webhook note

Current `@maxhub/max-bot-api` (v0.2.2) publicly exposes polling startup (`bot.start()`).
To keep webhook mode as required, this project receives webhook updates over HTTP and forwards them into SDK internals via `bot.handleUpdate(...)`.

## Main features

- Roles: ordinary user, verified user, admin
- Offer acceptance with versioning and forced re-acceptance
- Manual act creation FSM with validation and cancel on every step
- Deep-link / submission import from external DB with strict ownership check
- Permanent verified flag after first valid import
- Dynamic prices:
  - `act_price_default`
  - `act_price_verified`
- Payment scenarios:
  - free generation when price is `0`
  - balance charge when funds are enough
  - one-time YooKassa payment when balance is insufficient
  - top-up balance via YooKassa
- Payment status persistence and failed-payment notifications
- Act history with "No file = no history entry" cleanup
- Admin commands:
  - `/start`
  - `/stats`
  - `/setprice {kopecks}`
  - `/setprice_verified {kopecks}`
  - `/user {id}`
  - `/refund {payment_id}`
  - `/addbalance {user_id} {amount}`
  - `/broadcast {text}`
  - `/new_oferta`

## Project structure

- `src/index.ts` - HTTP server and webhooks
- `src/bot/max-bot.service.ts` - bot core logic
- `src/db/migrate.ts` - migration runner
- `src/db/repository.ts` - DB access layer
- `src/integrations/external/submission.service.ts` - external DB import
- `src/integrations/yookassa/client.ts` - YooKassa API client
- `src/services/act.service.ts` - act creation orchestration
- `src/services/pdf.service.ts` - PDF generation
- `migrations/001_init.sql` - schema initialization
- `docker-compose.yml` - bot + postgres + pgAdmin + Caddy
- `deploy/Caddyfile` - HTTPS reverse proxy config
- `WORK_PLAN.md` - required checklist with progress marks

## Environment

1. Copy env template:

```bash
cp .env.example .env
```

2. Fill required values in `.env`:
- `BOT_TOKEN`
- `WEBHOOK_SECRET`
- `DATABASE_URL`
- `EXTERNAL_DATABASE_URL`
- `YOOKASSA_SHOP_ID`
- `YOOKASSA_SECRET_KEY`
- `YOOKASSA_RETURN_URL`
- `ADMIN_MAX_IDS`
- domains: `BOT_DOMAIN`, `PGADMIN_DOMAIN`, `DB_DOMAIN`

## Local run (without Docker)

```bash
npm install
npm run migrate
npm run dev
```

Webhook endpoints:
- MAX: `POST {WEBHOOK_PATH}` with header `x-webhook-secret: {WEBHOOK_SECRET}`
- YooKassa: `POST {YOOKASSA_WEBHOOK_PATH}`

Health endpoints:
- `GET /health`
- `GET /db-health`

## VPS deployment with Docker Compose

```bash
docker compose --env-file .env up -d --build
```

Services:
- `bot` (internal port `3000`)
- `postgres` (private internal network)
- `pgadmin` (proxied through HTTPS subdomain)
- `caddy` (TLS termination + reverse proxy)

## Security notes

- PostgreSQL is not exposed publicly by Compose ports.
- Webhook endpoint requires `x-webhook-secret`.
- pgAdmin is protected by login/password.

## External DB mapping details

Used external tables:
- `meter_submissions`
- `users`
- `equipment_types`

Ownership rule:
- submission is accepted only when `meter_submissions.user_id == current MAX user ID`.

Water type mapping:
- `HVS` -> `ХВС`
- `GVS` -> `ГВС`

Ignored fields from submission:
- `phone`
- `production_year`

## Known production follow-ups

- Add integration tests against real MAX webhook payloads and YooKassa sandbox.
- Optional: configure custom font (`PDF_FONT_PATH`) to guarantee Cyrillic rendering quality in all PDF viewers.

