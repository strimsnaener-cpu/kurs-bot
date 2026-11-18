# NeuralDesk platform: Stages 3–7 (accounts, marketplace, AI agents on Telegram + Instagram, VIP Academy, admin)

Zero dependencies. Needs **Node.js 22.13+** only.

## Run it
```
cp .env.example .env          # then fill ENCRYPTION_KEY (command is in the file)
npm start                     # http://localhost:3000
npm test                      # 41 test groups, ~15 s
npm run test:browser          # 6 browser flows (first: npm i -D playwright; npx playwright install chromium)
npm run make-admin -- you@example.com
```
Without an email service, verification and reset emails land in
http://localhost:3000/api/dev/outbox (disabled when NODE_ENV=production).

## What's here
- Register / log in / log out, email confirmation, password reset (single-use, 1 h, logs out all devices)
- A workspace (organization) is created for every new account, the owner is its OWNER
- Roles: USER, STUDENT, SUPPORT, ADMIN. Admin panel requires ADMIN **and** 2FA
- TOTP 2FA (any authenticator app), with replay protection
- Admin: user list, role changes, audit log (`GET /api/admin/audit`)

## Marketplace (Stage 4)
- 5 starter agents are seeded on first start (placeholder USD prices). After that, everything is edited in the admin panel at `/admin.html`
- Agent pages: description, features, problems solved, demo chat, plans with monthly / yearly / one-time prices, installation steps, platforms, reviews
- Checkout creates a **pending order**. Until online payment is connected (Stage 8), you confirm payment in Admin → Orders → "Mark paid", which unlocks the agent in the customer's "My agents"
- Price changes never alter existing orders (each order stores the price it was placed at)
- Only paying customers can review; reviews wait for your approval; surnames are shortened publicly
- Admin: revenue overview, agent create/edit/publish/delete, plans & prices, orders, reviews, users & roles, audit log
- New agents can be added from the admin panel without code. Their runtime (how they answer messages) plugs in at Stage 5

## Live agents (Stage 5)
After a customer's order is paid: Dashboard → My agents → **Set up**.
- **Connect**: paste a bot token from @BotFather. Stored encrypted; only the bot is connected, never a personal account.
  - On your PC (no `PUBLIC_URL`): the server polls Telegram every second. Nothing else to configure.
  - On a server with HTTPS (`PUBLIC_URL` set): Telegram webhooks with a secret header.
- **Manager alerts**: send `/manager CODE` (shown on the Connect tab) to the bot from your own Telegram. Handoffs then ping you there.
- **Behavior**: business name, assistant name, tone, reply language (or "same as customer"), greeting, handoff message, lead collection, extra instructions.
- **Knowledge**: FAQs and documents (paste text or load .txt/.md). Searched on every message; the best matches go to the AI.
- **Test chat**: try the agent without sending anything to Telegram.
- **Automatic replies** switch: off = messages are saved but not answered.
- **Conversations**: full history; "Needs you" when handed off. Reply as a person (sent through the bot), then "Return to AI".
- **Leads**: contact details from chats (phone/email also detected automatically). Copy as CSV.
- **Stats**: conversations, replies, leads, handoffs, 7-day chart, AI token usage.
- **Admin overview**: agents live, messages and AI tokens in the last 24 h, failed deliveries and bot errors.

Reply engines (both channels):
- **AI mode** (`OPENAI_API_KEY` set): knowledge search + prompt + tools (`save_lead`, `handoff_to_human`). Each agent type (Telegram, Instagram, Sales, Support, Business) has its own role and tools in `server/runtime/agents.js`.
- **FAQ mode** (no key): answers only clear FAQ matches (works across word forms in UA/RU/EN), hands everything else to you.

Reliability: messages go through a durable job queue (survives restarts), failed sends retry with backoff; "bot blocked by user" is not retried. Duplicate Telegram deliveries are ignored. Several quick messages from a customer get one reply.

Not yet: photos/voice messages, PDF/Word uploads.

## Instagram (Stage 5b)
Customers click **Connect Instagram**, log in on Instagram's own page, and allow message access. The platform never sees their password.
- Works with Professional (Business or Creator) accounts. No Facebook Page needed.
- DMs arrive by webhook (signature-checked), replies go through the official Graph API, long messages are split under Meta's 1000-byte limit.
- Instagram allows replies only within **24 hours** of the customer's last message; the dashboard says so instead of failing silently.
- If the owner replies in the Instagram app, that reply shows in the dashboard and the AI steps back in that chat.
- Logins last 60 days and renew automatically; problems show on the Connect tab and the admin overview.
- Handoff alerts: Telegram manager chat if paired, otherwise email to the workspace owner.
- Meta's "deauthorize" and "data deletion" callbacks are built in, with a status page at `/deletion.html`.

### One-time Meta setup (platform owner)
1. developers.facebook.com → Create app → type **Business** → add product **Instagram** → **API setup with Instagram login**.
2. Copy the **Instagram app ID** and **Instagram app secret** into `.env` (`INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`). Set `INSTAGRAM_VERIFY_TOKEN` to a long random string.
3. `PUBLIC_URL` must be your HTTPS address. For testing on your PC, use a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000`) and put the https URL it prints in `PUBLIC_URL`.
4. Business login settings → OAuth redirect URI: `PUBLIC_URL/api/oauth/instagram/callback`
5. Webhooks → Callback URL `PUBLIC_URL/api/webhooks/instagram`, Verify token = `INSTAGRAM_VERIFY_TOKEN`, subscribe to **messages**.
6. Deauthorize callback URL `PUBLIC_URL/api/oauth/instagram/deauthorize`; Data deletion request URL `PUBLIC_URL/api/oauth/instagram/data-deletion`.
7. Until App Review: add your own Instagram account under **Roles → Instagram testers** and accept the invite in Instagram (Settings → Website permissions). Only testers can connect.
8. To open it to customers: Business verification + App Review for `instagram_business_basic` and `instagram_business_manage_messages` (Advanced Access). Meta also requires a **privacy policy URL**: not built yet.


## VIP Academy (Stage 6)
First start seeds the six-month program (6 courses, 16 lessons with outlines and goals, 6 assignments) and two plans: **VIP Academy** and **VIP + Mentorship** (placeholder prices). Videos and full lesson content are yours to add.

For students:
- `/academy.html`: roadmap and plans. Joining creates an order; **Admin → Orders → Mark paid** starts access (monthly 31 days, yearly 366, one payment 365; renewals add on top; a refund removes the access).
- `/learn.html`: program progress, "Continue" to the next lesson, live sessions, certificates, feedback waiting.
- Course and lesson pages: video, text, materials, "Mark as complete", assignments with your feedback. Free-preview lessons are open to everyone.
- A **certificate** is issued automatically when every lesson in a course is complete and every assignment is approved. Public verification page, printable / save as PDF.
- `/community.html`: private posts and replies for members (surnames shortened). You can pin and remove posts.
- `/live.html`: workshops and Q&A; join links and recordings only for members.
- `/mentorship.html`: on VIP + Mentorship, students request sessions; you schedule them with a date and link (they get an email).

For you, in the admin panel:
- **Academy**: course builder (courses, modules, lessons, ordering, preview/visible switches), video links, materials, assignments, plans and prices.
- **Students**: everyone with access and their progress; assignments to review (Approve / Needs work with feedback); **Give free access** by email for scholarships or partners.
- **Live** and **Mentorship** tabs.

Video: paste a YouTube, Vimeo or Bunny Stream link per lesson. YouTube links play through youtube-nocookie.com. Unlisted YouTube videos can still be shared by anyone who has the link; for paid content, Bunny Stream or Vimeo with domain restrictions is the safer choice (token-protected playback can be added with a Bunny key).

The Academy copy says plainly that results depend on effort and nothing guarantees income or employment.

## Admin panel (Stage 7)
`/admin.html` (Admin role + 2FA):
- **Overview**: revenue this month, 12-month revenue chart (agents vs Academy), orders awaiting payment, support requests waiting, top agents, platform numbers, agent problems.
- **Orders**, **Agents & prices**, **Reviews**, **Academy**, **Students**, **Live**, **Mentorship** (earlier stages).
- **Users**: search and filter; profile with orders, agents, Academy access, support requests and recent activity; change role; log out everywhere; **suspend** (with a reason, logs them out, optionally pauses their bots) and restore.
- **Support**: all requests from the Contact form; reply (sent by email), close, reopen. Customers see the thread at `/support.html`. Guests use a private link from their email.
- **Agents live**: every installed agent for the last 7 days: incoming, replies, handoffs (and handoff rate), leads, AI tokens, channel errors.
- **Announcements**: banners for everyone, agent customers or Academy students, with start/end dates; optionally emailed. People can dismiss them.
- **Logs**: system errors (server and background jobs) and the full activity log with filters.

The **Support** role can only answer support requests (and also needs 2FA).

Public pages added: live **Pricing** (from the admin panel), **About**, **Docs** (setup guides), **Contact** (with spam protection) and **Support**. Footer links work on every page.

## Security
scrypt password hashing · session and email tokens stored only as SHA-256 hashes ·
HttpOnly SameSite cookies (`__Host-` + Secure in production) · 2FA secrets AES-256-GCM encrypted ·
login rate limiting · no account enumeration · CSRF origin check + JSON-only API ·
strict Content-Security-Policy · user data rendered as text only.

## Port to the target stack (when package installs are available)
| Here | Target |
|---|---|
| node:sqlite (`server/db.js`) | PostgreSQL + Prisma (`../prisma/schema.prisma`) |
| scrypt | Argon2id (old hashes still verify via the `scrypt$` prefix) |
| in-memory rate limiter | Redis |
| `jobs` table queue + in-process worker | BullMQ + Redis, separate worker |
| keyword search (BM25) | OpenAI embeddings + pgvector |
| outbox table | Resend / Postmark |
| `server/app.js` routes | Next.js route handlers, same paths |
| `public/*.html` | Next.js pages with the same design tokens |
