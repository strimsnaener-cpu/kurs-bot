# NeuralDesk: project context for AI assistants

Read this first. It is the full handoff from the build so far (stages 1–7 of 9). The owner (Danya, Ukraine, writes in Russian) continues the work from Windows PowerShell. Reply to him in Russian; keep code, comments and commit messages in English.

## What this is
A commercial platform with three parts:
1. **AI Agent Marketplace**: customers buy AI agents (Telegram assistant, Instagram assistant, sales agent, support agent, business assistant).
2. **Agent runtime**: purchased agents actually answer customers in Telegram and Instagram DMs, using the customer's own knowledge base, with human handoff, leads and stats.
3. **VIP AI Academy**: a six-month paid course the founder teaches personally (lessons, assignments, certificates, community, live sessions, mentorship).

Plus an admin panel for the owner. Original brief and plan: `docs/ARCHITECTURE.md` (Stage 1). Database plan for the future Postgres port: `prisma/schema.prisma`.

## Important: actual stack vs. planned stack
The build environment could not install npm packages, so the app is **zero-dependency Node.js** (built-ins only), not the planned Next.js/Prisma/Postgres:
| Built | Planned port |
|---|---|
| `node:http` server + route modules (`server/*.js`) | Next.js route handlers (same URL paths) |
| SQLite via `node:sqlite` (`server/db.js`, `data/app.db`) | PostgreSQL + Prisma |
| scrypt passwords | Argon2id (`scrypt$` prefix keeps old hashes valid) |
| `jobs` table queue, in-process worker | BullMQ + Redis worker |
| BM25 keyword search (`runtime/knowledge.js`) | OpenAI embeddings + pgvector |
| outbox table instead of real email | Resend / Postmark |
| hand-written HTML/CSS/JS in `public/` | Next.js + Tailwind + shadcn/ui |
Requires **Node.js 22.13+** (uses `node:sqlite`, `--env-file`, `node --test`). Package installs DO work on the owner's PC, so the port is possible now; it has not been decided. Ask before starting it.

## Run / test
```
cd app
copy .env.example .env      # set ENCRYPTION_KEY (command inside the file); or run ..\start.ps1
npm test                    # 41 backend test groups, ~15 s, no network needed
npm start                   # http://localhost:3000
npm run make-admin -- you@example.com     # then log in and turn on 2FA (required for /admin.html)
npm i -D playwright; npx playwright install chromium; npm run test:browser   # 6 browser flows, 88 steps
```
Dev emails (verification, reset, support replies) are NOT sent; read them at `http://localhost:3000/api/dev/outbox`.

## Layout
- `app/server/index.js` start, seeding · `app.js` HTTP core: auth, sessions, CSRF, CSP, rate limits, static files, module loading · `auth.js` crypto (scrypt, AES-GCM, TOTP) · `db.js` schema + `migrate()` · `cli.js` make-admin
- `marketplace.js` catalog, orders, reviews, admin catalog · `seed.js` 5 agents
- `agents-api.js` installations, Telegram/Instagram connect + webhooks, knowledge, conversations, leads, stats, test chat
- `runtime/` `engine.js` (inbound → queue → brain → deliver, handoff, polling, IG OAuth/refresh) · `brain.js` (AI mode + FAQ mode) · `agents.js` (per-agent plugin: role + tools; config validation) · `llm.js` (OpenAI-compatible fetch) · `knowledge.js` · `queue.js`
- `channels/telegram.js`, `channels/instagram.js` official APIs only
- `academy.js` + `academy-seed.js` VIP Academy · `ops.js` users admin, support tickets, announcements, insights, logs
- `app/public/` pages; `assets/core.js` shared helpers (`api`, `el`, `money`, `safeNext`…), `auth.js`, `market.js` (marketplace, dashboard, admin shell), `setup.js` (agent control panel), `academy.js`, `admin-academy.js`, `admin-ops.js`, `site.js` (pricing/contact/support)
- `app/tests/*.test.js` API tests (`helpers.js` = in-memory server; `fakes.js` = stand-in Telegram, Instagram/Meta and OpenAI servers) · `tests/browser/` Playwright flows

## Conventions (keep them)
- New backend area = a module returning `{ routes, paramRoutes }`, registered in `app.js` (`for (const mod of [...])`). Use the `kit` helpers: `requireUser`, `requireAdmin` (role + 2FA), `audit`, `throttle`, `str`, `sendMail`.
- Every tenant query checks ownership (see `own()` in `agents-api.js`). Admin actions are written to `audit_log`.
- Schema changes: add to `SCHEMA` in `db.js` and, for existing tables, a guarded step in `migrate()` (old databases must upgrade; there is a test for this).
- Frontend: never `innerHTML` with data; build DOM with `el()` / `textContent`. Strict CSP: no inline scripts, external JS files only. Browser scripts share one global scope, so **top-level names must be unique across `public/assets/*.js`**. Admin tabs are added via `window.ADMIN_EXTRA`.
- Secrets: never hardcoded; bot/Instagram tokens and 2FA secrets are AES-256-GCM encrypted with `ENCRYPTION_KEY`. Never ask users for social media passwords.
- External APIs get a stand-in in `tests/fakes.js` and tests against it. No fake buttons: anything not built yet says so honestly.
- Academy copy never promises income or employment.
- Write a test for each feature, run `npm test` and the relevant browser test before calling it done.

## Status
Done and tested: 1 plan · 2 design · 3 accounts (2FA, reset, roles) · 4 marketplace (manual "Mark paid") · 5 Telegram agents (AI + FAQ mode, webhook or polling) · 5b Instagram (Business Login, webhooks, 24 h rule, token refresh, Meta deletion callbacks) · 6 VIP Academy · 7 admin panel (users/suspend, support tickets, announcements, insights, agents live, logs) + Pricing/About/Docs/Contact/Support pages.

Never tested against the real services (no network in the build environment): Telegram, Meta/Instagram, OpenAI. First live run should be on the owner's PC.

## Next
**Stage 8, payments** (blocked on the owner's choice of provider; he hasn't answered yet). Options discussed: WayForPay or LiqPay for UAH cards (Stripe doesn't onboard Ukrainian businesses); Paddle or Lemon Squeezy (merchant of record) for international. Plan:
- `PaymentProvider` interface: `createCheckout(order) → redirect URL`, `verifyWebhook(raw, headers)`, `parseEvent() → { orderId, status, providerRef, amount, currency, periodEnd }`, plus recurring charges for MONTH/YEAR plans.
- `subscriptions` table (user, order, provider, provider_ref, status ACTIVE/PAST_DUE/CANCELED, current_period_end, cancel_at_period_end). Renewals extend agent access and Academy `academy_memberships`; failed renewal → PAST_DUE with a short grace period → pause the agent's auto-reply / end Academy access. Customer can cancel at period end from the dashboard.
- Checkout button on agent and Academy plans replaces "order reserved"; keep manual "Mark paid" for bank transfers. Receipts by email.
- Look up the provider's current API docs before writing code (signature schemes change). Add a stand-in provider to `tests/fakes.js` and tests for paid, failed, renewal, refund, duplicate webhook.

**Stage 9, production**: real email sender (replace the outbox, required: verification, resets and support replies currently go nowhere), HTTPS hosting + `PUBLIC_URL` (needed for Instagram and Telegram webhooks), SQLite backups or Postgres port, privacy policy + terms pages (Meta App Review needs a privacy policy URL), Meta App Review, monitoring, load test.

## Placeholders the owner must replace
Prices (all placeholders, edit in admin), brand name "NeuralDesk", founder story on `about.html`, Academy lesson videos and full content (only outlines are seeded), privacy policy.

## Language
- The whole UI, server messages, emails and seed content are in Russian (`lang="ru"`, `ru-RU` dates and money).
- Code, comments and commit messages stay English. Enum values (roles, levels, statuses, tone/language keys) stay English in the database and API; the UI maps them with `ROLE_RU`, `LEVEL_RU`, `PER`, `TONE_RU`, `LANG_RU` (core.js / setup.js). Russian plurals: `plural(n, one, few, many)` in core.js.
- AI system prompts stay English; the agent's reply language comes from the config.
- Tests assert on the Russian strings.
