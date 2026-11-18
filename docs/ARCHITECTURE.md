> Note: this is the original Stage 1 plan. The app was then built zero-dependency (Node built-ins + SQLite); see ../CLAUDE.md for what actually exists and the port mapping.

# AI Business Automation Platform: Stage 1 Plan

## 1. Analysis: what this really is
Three products on one account system:
1. **Marketplace**: catalog + checkout of AI agents (one-time or subscription).
2. **Agent runtime**: the hard part. Purchased agents must actually answer Telegram/Instagram messages 24/7, using each customer's own knowledge base.
3. **Academy**: LMS (courses, video, assignments, progress, certificates, community, live sessions).

Shared core: auth, billing, RBAC, admin panel, audit logs.

### Hardest technical challenges
| Challenge | Decision |
|---|---|
| Multi-tenant isolation (customer A's data never reaches B) | `organization_id` on every tenant table, enforced in a data-access layer; Postgres Row-Level Security as second barrier |
| Always-on message handling | Webhooks → queue → worker. The web app never calls the LLM inline |
| Instagram access | Official Meta Instagram Messaging API via OAuth. Needs a Meta app + App Review (weeks) |
| Telegram access | Customer creates a bot in @BotFather and pastes the bot token (a bot token, never a personal password). Encrypted at rest, webhook auto-registered |
| Per-customer knowledge (FAQ/docs) | Upload → chunk → embed → pgvector → retrieval at answer time (RAG) |
| Adding agents without rebuilding | Agents are **data + a plugin**: a DB definition plus a registered runtime module (see §3) |
| Cost control | Per-org token metering, plan limits, rate limits, provider abstraction |
| Payments in target market | Provider interface; see §6 |
| Secrets | Env vars + AES-256-GCM encryption for stored tokens; nothing hardcoded |

## 2. Stack (final choices)
- **Frontend/BFF**: Next.js 15 (App Router) + React + TypeScript, Tailwind, shadcn/ui, Framer Motion (sparingly)
- **API**: Next.js route handlers/server actions for the web app; validation with Zod; typed with tRPC-free simple services layer
- **Worker**: separate Node.js process (same repo, `apps/worker`) using **BullMQ + Redis**
- **DB**: PostgreSQL + **Prisma**, `pgvector` extension for embeddings
- **Auth**: Auth.js (email+password with Argon2id, Google OAuth), email verification, 2FA (TOTP) mandatory for admins, RBAC: `USER | STUDENT | ADMIN | SUPPORT`
- **LLM**: `LLMProvider` interface; OpenAI first, Anthropic/others pluggable
- **Storage**: S3-compatible (Cloudflare R2) for documents/materials; **Mux or Bunny Stream** for lesson video (signed playback)
- **Email**: Resend/Postmark
- **Deploy**: Docker; web on Vercel or Render, worker + Redis + Postgres on Render/Fly/Railway. CI with GitHub Actions
- **Monorepo** (pnpm workspaces):
```
apps/web        Next.js (site, dashboard, admin)
apps/worker     queue consumers, channel senders, RAG ingest
packages/db     Prisma schema + client
packages/agents agent plugin SDK + built-in agents
packages/channels Telegram, Instagram adapters
packages/llm    provider abstraction
packages/billing payment provider abstraction
packages/ui     design system
```

## 3. Agent plugin architecture (extensibility core)
```ts
interface AgentPlugin {
  slug: string;                       // "telegram-assistant"
  channels: ChannelType[];            // ["TELEGRAM"]
  configSchema: ZodSchema;            // renders the settings form automatically
  handle(ctx: ConversationContext): Promise<AgentReply>; // RAG + prompt + tools
  tools?: AgentTool[];                // collect_lead, handoff_to_human, ...
}
```
- DB `Agent` row = what is sold (copy, pricing, features, media). `AgentPlugin` = how it runs.
- New agent = one new plugin folder + one admin-panel entry. No platform rebuild.
- `Installation` = a customer's instance of an agent (config, connected channel, status).
- Shared building blocks: knowledge retrieval, human handoff, lead capture, personality/style prompt, language settings.

### Message flow
`Telegram/Meta webhook → verify signature → store Message → enqueue job → worker loads Installation + RAG → LLM → send via channel API → store reply + usage → (handoff? notify manager)`

Rules: idempotency by external message ID, per-conversation lock, retries with backoff, kill-switch per installation ("auto-reply" toggle).

## 4. Pages
Public: Home, Marketplace, Agent Details, Academy, About, Pricing, Documentation, Contact, Login/Register.
Customer: Dashboard, My Agents (+ per-agent setup wizard, knowledge, conversations, stats), Integrations, Billing, Academy player.
Admin (`/admin`, role + 2FA): agents, pricing/plans, users/subscriptions, revenue, courses/lessons, students/progress, announcements, support tickets, agent performance, system/audit logs.

## 5. Database
See `prisma/schema.prisma`. Groups: identity (User, Account, Session, Organization, Membership), catalog (Agent, AgentVersion, Plan, Price, Review), commerce (Order, Subscription, Payment, Coupon), runtime (Installation, ChannelConnection, KnowledgeSource, KnowledgeChunk, Conversation, Message, UsageRecord, HandoffRequest, Lead), academy (Course, Module, Lesson, Enrollment, LessonProgress, Assignment, Submission, Certificate, LiveSession, Announcement), ops (SupportTicket, TicketMessage, AuditLog, SystemLog, Setting).
Pricing lives in `Plan/Price` rows, so it is editable from the admin panel.

## 6. External credentials needed (you must supply these)
| Integration | What you need | Notes |
|---|---|---|
| OpenAI (or other LLM) | API key | Platform-level key; per-org usage metered |
| Telegram | **Nothing platform-wide.** Each customer's bot token from @BotFather | Webhook secret generated by us |
| Instagram / Meta | Meta developer app, App ID/Secret, Business verification, **App Review** for `instagram_business_manage_messages` | Customer's account must be Professional and linked via OAuth. Replies limited to the 24h window |
| Payments | See below | |
| Postgres / Redis | Connection URLs | Managed services |
| S3/R2 | Bucket + keys | |
| Video | Mux or Bunny key | |
| Email | Resend/Postmark key | |
| Google OAuth (optional) | Client ID/Secret | |
| ENCRYPTION_KEY | 32-byte random | Generate yourself, never commit |

**Payments (important for Ukraine)**: Stripe does not onboard Ukrainian businesses directly. Practical options: **WayForPay / LiqPay / Fondy** for UAH cards and local customers, and **Paddle or Lemon Squeezy (merchant of record)** for international subscriptions. Billing is built behind a `PaymentProvider` interface; I will implement one provider first (recommend WayForPay or LiqPay for UAH, plus Paddle for international). Tell me which you have an account with.

## 7. Security baseline
Argon2id passwords, CSRF-safe sessions, httpOnly cookies, Zod validation everywhere, rate limiting, webhook signature verification, encrypted channel tokens, OAuth only (no social passwords ever), admin 2FA, audit log on admin actions, signed URLs for video/files, GDPR-style data export/delete, no secrets in repo (`.env.example` only).

## 8. Design direction
Dark premium SaaS. Background `#07080B` / charcoal `#0E1016`, surfaces `#141722` with 1px hairline borders (`white/8%`). Accent: electric blue `#4C7DFF` → violet `#8B5CF6`, cyan `#22D3EE` used only for status/highlights. Gradients only on hero glow and primary CTA. Glass blur only on nav and modals. Type: Inter (UI) + a display face (Space Grotesk/Geist) for headings. Motion: 150-250 ms fades and hover lifts, scroll reveals once. Dashboards use dense data cards, sparklines, and tables, not template widgets. Fully responsive (mobile-first).

## 9. Roadmap (each stage ends with tests before moving on)
1. **Foundation**: monorepo, Docker Compose (Postgres+Redis), Prisma schema, CI. *Test: migrations run, seed works.*
2. **Design system + public site**: tokens, components, Home/Marketplace/Pricing/About/Docs/Contact shells. *Test: Lighthouse, responsive checks.*
3. **Auth + accounts**: register/login/verify/reset, orgs, roles, 2FA. *Test: auth + RBAC integration tests.*
4. **Marketplace**: agent CRUD (seeded with the 5 agents), detail pages, reviews, cart/order stubs.
5. **Runtime**: plugin SDK, Telegram adapter (end-to-end first), RAG ingestion, conversations, handoff, then Instagram adapter (needs Meta approval; built and tested against Meta test users).
6. **Academy**: courses, lessons, video, progress, assignments, certificates, live sessions, 6-month path seeded.
7. **Admin panel**: all management screens, logs, announcements, support.
8. **Payments**: provider integration, subscriptions, webhooks, entitlements gating installs.
9. **Hardening**: load/security tests, observability (Sentry), backups, production deploy runbook.

Academy copy rule: no guaranteed income or employment claims anywhere in UI or seed data.
