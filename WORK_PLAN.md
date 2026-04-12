# Implementation Checklist

## Phase 1 — Project bootstrap
- [x] Initialize TypeScript project
- [x] Add MAX SDK
- [x] Create project structure
- [x] Add environment config support
- [x] Prepare Dockerfiles

## Phase 2 — Infrastructure and deployment
- [x] Create Docker Compose setup
- [x] Add PostgreSQL service
- [x] Add pgAdmin service
- [x] Configure internal networking
- [x] Prepare reverse proxy / webhook-ready HTTP setup
- [x] Document VPS deployment steps

## Phase 3 — Database design
- [x] Create internal DB schema
- [x] Add migrations
- [x] Add users table
- [x] Add acts table
- [x] Add payments table
- [x] Add settings table
- [x] Add offer versions storage
- [x] Add fields `user_fullname` and `org_name`

## Phase 4 — Authentication, roles, and offer flow
- [x] Implement admin detection from `.env`
- [x] Implement role-based start behavior
- [x] Implement current-offer check
- [x] Implement offer acceptance persistence
- [x] Implement re-accept flow for new offer version
- [x] Implement `/new_oferta`

## Phase 5 — User menus and navigation
- [x] Implement ordinary user menu
- [x] Implement verified user menu
- [x] Implement help flow
- [x] Implement cancel handling

## Phase 6 — Manual act creation
- [x] Implement manual FSM / step flow
- [x] Add field validation
- [x] Add valid-until calculation
- [x] Add final summary
- [x] Add free-flow generation path
- [x] Add paid-flow handoff

## Phase 7 — Deep link + external DB integration
- [x] Parse submission ID from deep link
- [x] Connect to external DB
- [x] Read `meter_submissions`
- [x] Read external user data
- [x] Read `equipment_types`
- [x] Implement ownership check
- [x] Implement mapping rules
- [x] Ignore forbidden fields
- [x] Implement imported-data confirmation step
- [x] Mark verified users permanently

## Phase 8 — PDF generation
- [x] Implement PDF generation service
- [x] Send PDF to MAX chat
- [x] Store PDF for history/download
- [x] Handle duplicate act numbers correctly

## Phase 9 — YooKassa payments
- [x] Implement one-time payment flow
- [x] Implement balance top-up flow
- [x] Implement payment webhook handling
- [x] Implement failed-payment notifications
- [x] Implement balance deduction flow
- [x] Implement refunds for admin command

## Phase 10 — History and system messages
- [x] Implement act history view
- [x] Remove history entries with missing files
- [x] Implement success messages
- [x] Implement error messages

## Phase 11 — Admin tools
- [x] Implement `/stats`
- [x] Implement `/setprice`
- [x] Implement `/setprice_verified`
- [x] Implement `/user`
- [x] Implement `/addbalance`
- [x] Implement `/broadcast`
- [x] Implement `/refund`

## Phase 12 — Testing and handoff
- [ ] Test ordinary user flows
- [ ] Test verified user flows
- [ ] Test admin flows
- [ ] Test webhook delivery
- [ ] Test payment webhooks
- [ ] Test Docker Compose deployment on VPS
- [x] Write final README
- [x] Mark all completed steps in checklist

## Local validation completed
- [x] TypeScript typecheck (`npm run typecheck`)
- [x] Build (`npm run build`)

