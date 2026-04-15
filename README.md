# MAX Act Generation Bot

Production-oriented MAX messenger bot in TypeScript for generating water meter inspection acts (PDF), with PostgreSQL, pgAdmin, YooKassa payments, external DB import, admin tools, and webhook mode.
## Tmp  docker compose exec bot npm run test:act:once:prod
## Implemented stack

- TypeScript + Node.js
- Official MAX SDK: `@maxhub/max-bot-api`
- PostgreSQL + SQL migrations
- pgAdmin (in Docker Compose)
- Webhook HTTP server on Express
- Dedicated queue worker for act generation
- YooKassa integration (payments + webhook)
- Excel template-based generation + XLSX to PDF conversion (LibreOffice)
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
- Dynamic prices from DB table `prices`:
  - `ordinary` (default `40` RUB)
  - `verified` (default `0` RUB)
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
  - `/setprice {rub}`
  - `/setprice_verified {rub}`
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
- `src/services/act-template.service.ts` - Excel template fill + PDF conversion
- `src/services/act-generation-queue.service.ts` - queue processing logic
- `src/worker/index.ts` - standalone worker process
- `src/services/pdf.service.ts` - PDF generation
- `migrations/001_init.sql` - schema initialization
- `migrations/003_act_generation_jobs.sql` - queue and debug file path storage
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
- `POSTGRES_HOST`
- `POSTGRES_PORT`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `EXTERNAL_DATABASE_URL`
- `YOOKASSA_SHOP_ID`
- `YOOKASSA_SECRET_KEY`
- `YOOKASSA_RETURN_URL`
- `YOOKASSA_RECEIPT_EMAIL`
- `YOOKASSA_RECEIPT_VAT_CODE` (`1..6`, usually `1` for "без НДС")
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
- `worker` (polling queued act-generation jobs)
- `postgres` (private internal network)
- `pgadmin` (proxied through HTTPS subdomain, image tag `dpage/pgadmin4:9.13`)

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

Deep-link payload rule:
- pass current `meter_submissions.id` (recommended key: `submission_id`).
- generic `id` in query payload is ignored to avoid mixing with `submission_status_history.id`.

Water type mapping:
- `HVS` -> `ХВС`
- `GVS` -> `ГВС`

Ignored fields from submission:
- `phone`
- `production_year`

## Known production follow-ups

- Add integration tests against real MAX webhook payloads and YooKassa sandbox.
- Optional: configure custom font (`PDF_FONT_PATH`) to guarantee Cyrillic rendering quality in all PDF viewers.

## Template placeholders

Put your template `.xlsx` file into `template/` (or set `ACT_TEMPLATE_FILE`).
Supported placeholders inside cells:

- `{{act_number}}`
- `{{user_id}}`
- `{{user_fullname}}`
- `{{org_name}}`
- `{{address}}`
- `{{water_type}}`
- `{{meter_model}}`
- `{{serial_number}}`
- `{{current_reading}}`
- `{{check_date}}`
- `{{interval_years}}`
- `{{valid_until}}`
- `{{result}}`
- `{{price_rub}}`
- `{{source}}`
- `{{submission_id}}`

## One-shot generation test

You can create and process a single test generation request (without sending files to MAX) and verify both files exist:

```bash
npm run test:act:once
```

Optional env overrides for test:

- `TEST_MAX_USER_ID` (default: `990000001`)
- `TEST_PRICE_RUB` (default: `0`)
