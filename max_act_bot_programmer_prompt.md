# Prompt for the programmer: MAX act-generation bot

Build a production-ready **MAX messenger bot** in **TypeScript** using the **official MAX SDK**, **PostgreSQL**, and **pgAdmin**. The project must be deployable to my VPS with **Docker Compose** and must use **webhooks**.

The bot generates **PDF inspection certificates (acts) for water meters**. It must support user roles, offer acceptance, act creation from an external submission, manual act creation, balance payments via YooKassa, act history, and admin tools.

---

## 1. Main goal

Build a MAX bot that:
- works via **webhooks**;
- is written in **TypeScript**;
- uses **PostgreSQL** as the main database;
- includes **pgAdmin** for DB administration;
- is deployed on my VPS via **Docker Compose**;
- stores and serves bot data reliably;
- supports admin-only commands;
- supports offer versioning and forced re-acceptance after a new offer is published.

---

## 2. Deployment and infrastructure requirements

### Stack
- TypeScript
- Node.js
- Official MAX SDK
- PostgreSQL
- pgAdmin
- Docker + Docker Compose
- Reverse proxy with HTTPS for webhook delivery

### VPS deployment
Prepare the project for installation on my VPS using Docker Compose.

### Webhooks
The bot must work via **webhooks**, not polling.

### Subdomains
I will have three subdomains:
1. **Bot subdomain** вЂ” for webhook endpoint and bot-related HTTP endpoints
2. **Database-related subdomain** вЂ” if needed for DB tooling / service access
3. **pgAdmin subdomain** вЂ” for pgAdmin web access

Important:
- Keep PostgreSQL secure.
- Do **not** expose raw PostgreSQL publicly over HTTP just because there is a DB-related subdomain. PostgreSQL should stay private unless there is a very specific and justified reason.
- pgAdmin may be exposed behind authentication.
- Webhook endpoint must use HTTPS.

### Docker Compose
Provide a working `docker-compose.yml` setup for:
- bot service
- postgres service
- pgAdmin service

Also prepare environment configuration through `.env`.

---

## 3. Admin identification

Admin MAX user IDs must be stored in `.env`.

Example idea:
- `ADMIN_MAX_IDS=12345,67890`

Only these users may use admin commands.

---

## 4. Core business idea

The bot generates **PDF acts** for water meter inspections.
Users can create acts in two ways:
1. **Manually**
2. **From an external submission via deep link**

The bot must support:
- ordinary users
- verified users
- administrators

---

## 5. User roles

### Ordinary user
A user who entered the bot directly and did not come from the external report bot by deep link.

Can:
- create an act manually;
- top up balance;
- open history;
- open help.

Price is based on `act_price_default`.

### Verified user
A user who has entered the bot at least once via deep link from the external report bot.

Rules:
- once verified, always verified;
- set `verified = true` permanently after the first successful deep-link flow;
- verified users have a separate tariff `act_price_verified`.

Even if the verified tariff is currently `0`, the balance top-up button must still stay visible because the admin may later change the tariff.

### Administrator
A user whose MAX user ID is listed in `.env`.

When admin opens the bot or sends `/start`, they must not see the normal user menu.
Instead they must see:
- a message saying they are an administrator;
- the list of available admin commands with short descriptions and examples.

---

## 6. Offer acceptance logic

### General rule
The bot has an offer (public offer / terms document).
The user must accept the **current offer version** before using the service.

### First-time or outdated offer flow
If the user has never accepted the current offer version, the bot must show:
- the current offer document;
- buttons:
  - `вњ… Accept offer`
  - `вќЊ Decline offer`

### Behavior
- If user accepts: save acceptance timestamp and accepted offer version.
- If user declines: block access to main bot features.

### New offer version flow
When a new offer version is published, all users must be required to accept the new version again.

Implement admin command:
- `/new_oferta`

Flow:
1. Admin sends `/new_oferta`
2. Bot asks admin to upload the new offer PDF
3. Admin uploads the PDF
4. Bot asks admin to send the offer version string, for example `4.1`
5. Admin sends version
6. Bot saves the new offer as the current version
7. Bot starts a broadcast to all users:
   - offer PDF
   - message about updated offer
   - buttons:
     - `вњ… Accept offer`
     - `вќЊ Decline offer`
8. On every future interaction, if user has not accepted the current version, block all main features and show the current offer again.

If admin uploads invalid file or duplicate version, show a clear error.

---

## 7. Main menus

### Ordinary user menu
Show:
- balance
- total acts created
- current user price
- buttons:
  - `вњЏпёЏ Enter manually`
  - `рџ’і Top up balance`
  - `рџ—‚пёЏ History`
  - `вќ“ Help`

Important:
- ordinary users must **not** have the вЂњpaste/import from report botвЂќ button.

### Verified user menu
Show:
- balance
- total acts created
- current verified-user price
- buttons:
  - `рџ“‹ Create act from submission`
  - `вњЏпёЏ Enter manually`
  - `рџ’і Top up balance`
  - `рџ—‚пёЏ Act history`
  - `вќ“ Help`

### Help
When user presses `Help`, the bot simply sends admin contact details.

---

## 8. Manual act creation flow

Implement a step-by-step flow.

Fields:
1. Address
2. Water type (`РҐР’РЎ` / `Р“Р’РЎ`)
3. Meter model / meter type
4. Serial number
5. Current reading
6. Check date (default today, but user may change it)
7. Inspection interval (`4 years` / `5 years` / `6 years`)
8. Result (`вњ… Fit` / `вќЊ Unfit`)

Validation rules:
- address: non-empty
- water type: required selection
- meter model: non-empty
- serial: non-empty
- reading: numeric, >= 0
- check date: valid date, not in the future
- interval: one of 4 / 5 / 6
- result: required selection

At every step show `вќЊ Cancel`.
If user cancels, terminate flow and return to main menu.

### Summary step
After all fields are collected, show a final summary:
- address
- water type
- meter model
- serial number
- current reading
- check date
- interval
- valid until
- result
- price

Buttons:
- if price > 0: `вњ… Confirm and pay`
- if price = 0: `вњ… Get act`
- always: `вќЊ Cancel`

Important:
- do **not** implement an вЂњEditвЂќ button;
- use only `Cancel`.

---

## 9. Deep link flow from the external report bot

This is a critical scenario.

### Input
Deep link payload contains **submission ID** from the **external database**.

### External database
The bot must read data from an **external DB**.
You need to implement integration with these external tables:
- `meter_submissions`
- `users` (external users table)
- `equipment_types`

### `meter_submissions` relevant fields
Use data such as:
- `user_id`
- `meter_number`
- `current_value`
- `address`
- `phone`
- `water_type`
- `equipment_type_id`
- `production_year`
- `custom_equipment_type_name`

### Security rule
Strict ownership check is required:
- current MAX user ID **must match** `meter_submissions.user_id`
- if it does not match, deny access to the submission

Show a clear error like:
- `This submission belongs to another user and is unavailable.`

### Missing submission
If submission is not found, show:
- `The submission was not found or is no longer available.`

### Verified status rule
If the submission is found and ownership check passes:
- set internal user `verified = true` permanently
- if already verified, keep it true

### User synchronization from external DB
When processing a valid submission, save/update user data into the internal DB.
Add these fields to the internal users table:
- `user_fullname`
- `org_name`

### Mapping rules for act data
Map submission data into the act draft:
- address в†ђ `address`
- reading в†ђ `current_value`
- serial number в†ђ `meter_number`
- water type в†ђ `water_type`
- meter model/type:
  - if `custom_equipment_type_name` is filled в†’ use it
  - otherwise lookup `equipment_types.name` by `equipment_type_id`

### Water type mapping
- `HVS` в†’ `РҐР’РЎ`
- `GVS` в†’ `Р“Р’РЎ`

### Ignore fields
These fields from external submission must be ignored completely:
- `phone`
- `production_year`

Do not store them in the internal act data and do not include them in the PDF.

### User confirmation flow after import
After collecting and validating submission data:
1. show imported data to user;
2. show buttons:
   - `вњ… Confirm`
   - `вќЊ Cancel`
3. if user confirms, ask the 3 remaining questions:
   - check date
   - inspection interval
   - result
4. then show final summary
5. then continue to free generation or payment flow

### Incomplete imported data
If required fields cannot be extracted or validated, stop the scenario and show:
- `Could not recognize all required fields. Please try again.`

### Reuse rule
It must be allowed to create **multiple acts from the same external submission**.
This is valid behavior.

---

## 10. Valid-until date calculation

Implement automatic calculation of `valid_until` using this rule:
- `valid_until = check_date - 1 day + interval_years`

Examples:
- 06.04.2026 + 4 years в†’ 05.04.2030
- 06.04.2026 + 5 years в†’ 05.04.2031
- 06.04.2026 + 6 years в†’ 05.04.2032

---

## 11. PDF act generation

Generate a PDF act after successful confirmation/payment.

Requirements:
- PDF must be generated from bot data;
- user receives PDF directly in MAX chat;
- store the generated PDF for later download/history;
- PDF generation should be reliable and reusable.

Use the fields collected in the act flow.

Important business rule:
- duplicate act numbers are allowed;
- each act is a separate document even if serial number repeats.

---

## 12. Pricing and payments

### Pricing
Support two dynamic settings:
- `act_price_default`
- `act_price_verified`

Admin must be able to change them at runtime.

### Free act scenario
If current user price = `0`:
- show `вњ… Get act`
- generate PDF immediately
- do not create payment
- do not check balance

### Paid act using balance
If price > 0 and balance is sufficient:
- deduct balance
- generate PDF
- send PDF

### Insufficient balance
If balance is insufficient, show:
- `Your balance is insufficient.`

Buttons:
- `One-time payment`
- `Top up balance`

### One-time payment
Flow:
1. user chooses `One-time payment`
2. create YooKassa payment link for the service price
3. send payment link
4. wait for successful webhook
5. generate PDF and send it

### Failed one-time payment
If YooKassa sends a failed/unsuccessful payment webhook:
- notify the user that payment failed
- keep transaction status in DB

Do **not** implement the old вЂњstore act for 24 hours after failed paymentвЂќ idea.
Instead, just store transaction records and statuses.

### Balance top-up
Flow:
1. user clicks `Top up balance`
2. show choices:
   - `10 в‚Ѕ`
   - `50 в‚Ѕ`
   - `100 в‚Ѕ`
   - `Other amount`
3. if `Other amount`, user enters a custom amount
4. minimum allowed amount is `10 в‚Ѕ`
5. create YooKassa payment
6. after successful webhook, add funds to balance and notify user

### Failed balance top-up
If payment fails, notify the user.

---

## 13. Act history

### History view
User opens history and sees their recent acts with download buttons.

### File retention rule
If the PDF file no longer exists, then the history entry must also be removed.

Business rule:
- **No file = no history entry**

Do not show broken or expired entries.

---

## 14. System messages

Implement explicit success/error messages.
At minimum cover:

### Success messages
- offer accepted
- act created successfully
- payment succeeded
- balance topped up successfully
- offer updated successfully
- user verified successfully via deep link

### Error messages
- submission not found
- access denied to submission
- could not recognize all required fields
- insufficient balance
- payment failed
- invalid file uploaded for offer
- duplicate offer version
- operation cancelled by user

---

## 15. Admin commands

Implement these admin commands:

### `/start`
Show admin-only help text with commands.

### `/stats`
Show stats:
- users
- acts
- revenue
- for day / month / total

### `/setprice {kopecks}`
Update ordinary-user price.
Apply immediately.

### `/setprice_verified {kopecks}`
Update verified-user price.
Apply immediately.

### `/user {id}`
Show user card:
- balance
- acts
- payments
- user type

### `/refund {payment_id}`
Trigger YooKassa refund and show result.

### `/addbalance {user_id} {amount}`
Manually add funds to a user balance.

### `/broadcast {text}`
Broadcast a message to all users.

### `/new_oferta`
Admin-only flow to upload a new offer PDF and version.

---

## 16. Database requirements

Use PostgreSQL as the internal main DB.

You must design and implement the DB schema for:
- internal users
- acts
- payments
- settings
- offer versions / current offer

Update internal users schema to include at least:
- `user_fullname`
- `org_name`

Also keep fields needed for:
- verified status
- accepted offer version
- accepted offer timestamp
- balance
- act count
- timestamps

You may refine schema design, but do not remove required business fields.

---

## 17. pgAdmin

Set up pgAdmin in Docker Compose.
It must be reachable through the dedicated pgAdmin subdomain.
Use authentication and safe configuration.

---

## 18. Deliverables

I expect:
- source code
- Docker Compose configuration
- environment variables template
- database migrations / schema setup
- webhook setup
- MAX bot implementation in TypeScript
- PostgreSQL integration
- pgAdmin integration
- README / run instructions
- completed work plan with checkboxes

---

## 19. Required work plan with checkboxes

While doing the task, maintain a checklist in the project documentation and mark each step as completed when done.
Use markdown checkboxes.

Example style:
- [x] Step completed
- [ ] Step not completed yet

Use a plan like this and update it during implementation:

### Phase 1 вЂ” Project bootstrap
- [ ] Initialize TypeScript project
- [ ] Add MAX SDK
- [ ] Create project structure
- [ ] Add environment config support
- [ ] Prepare Dockerfiles

### Phase 2 вЂ” Infrastructure and deployment
- [ ] Create Docker Compose setup
- [ ] Add PostgreSQL service
- [ ] Add pgAdmin service
- [ ] Configure internal networking
- [ ] Prepare reverse proxy / webhook-ready HTTP setup
- [ ] Document VPS deployment steps

### Phase 3 вЂ” Database design
- [ ] Create internal DB schema
- [ ] Add migrations
- [ ] Add users table
- [ ] Add acts table
- [ ] Add payments table
- [ ] Add settings table
- [ ] Add offer versions storage
- [ ] Add fields `user_fullname` and `org_name`

### Phase 4 вЂ” Authentication, roles, and offer flow
- [ ] Implement admin detection from `.env`
- [ ] Implement role-based start behavior
- [ ] Implement current-offer check
- [ ] Implement offer acceptance persistence
- [ ] Implement re-accept flow for new offer version
- [ ] Implement `/new_oferta`

### Phase 5 вЂ” User menus and navigation
- [ ] Implement ordinary user menu
- [ ] Implement verified user menu
- [ ] Implement help flow
- [ ] Implement cancel handling

### Phase 6 вЂ” Manual act creation
- [ ] Implement manual FSM / step flow
- [ ] Add field validation
- [ ] Add valid-until calculation
- [ ] Add final summary
- [ ] Add free-flow generation path
- [ ] Add paid-flow handoff

### Phase 7 вЂ” Deep link + external DB integration
- [ ] Parse submission ID from deep link
- [ ] Connect to external DB
- [ ] Read `meter_submissions`
- [ ] Read external user data
- [ ] Read `equipment_types`
- [ ] Implement ownership check
- [ ] Implement mapping rules
- [ ] Ignore forbidden fields
- [ ] Implement imported-data confirmation step
- [ ] Mark verified users permanently

### Phase 8 вЂ” PDF generation
- [ ] Implement PDF generation service
- [ ] Send PDF to MAX chat
- [ ] Store PDF for history/download
- [ ] Handle duplicate act numbers correctly

### Phase 9 вЂ” YooKassa payments
- [ ] Implement one-time payment flow
- [ ] Implement balance top-up flow
- [ ] Implement payment webhook handling
- [ ] Implement failed-payment notifications
- [ ] Implement balance deduction flow
- [ ] Implement refunds for admin command

### Phase 10 вЂ” History and system messages
- [ ] Implement act history view
- [ ] Remove history entries with missing files
- [ ] Implement success messages
- [ ] Implement error messages

### Phase 11 вЂ” Admin tools
- [ ] Implement `/stats`
- [ ] Implement `/setprice`
- [ ] Implement `/setprice_verified`
- [ ] Implement `/user`
- [ ] Implement `/addbalance`
- [ ] Implement `/broadcast`
- [ ] Implement `/refund`

### Phase 12 вЂ” Testing and handoff
- [ ] Test ordinary user flows
- [ ] Test verified user flows
- [ ] Test admin flows
- [ ] Test webhook delivery
- [ ] Test payment webhooks
- [ ] Test Docker Compose deployment on VPS
- [ ] Write final README
- [ ] Mark all completed steps in checklist

---

## 20. Implementation expectations

Do not build a demo. Build a structured, production-ready project.

Important expectations:
- keep code clean and modular;
- separate bot handlers, services, DB logic, and integrations;
- provide safe error handling;
- make webhook flow stable;
- make deployment reproducible;
- document assumptions clearly;
- if any requirement is ambiguous, choose the safest business interpretation and document it.

---

## 21. Final instruction

Implement the project step by step according to the checklist above.
As each phase or task is completed, update the markdown checklist and mark the completed items with `[x]`.
Do not leave the work plan static вЂ” it must reflect actual progress.


