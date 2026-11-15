# Kurs bot — "С нуля до ИИ"

A Telegram bot that is a whole 6‑month course (120 lessons, 24 weekly tests, 6 monthly tests, 1 final exam)
for one student on an iPhone. Learner text is Russian; code and docs are English.

**Stack:** Python 3.13, aiogram 3 (async, first‑class webhook support for aiohttp — one dependency for bot + web server),
asyncpg, Postgres on Neon (free, persistent). Hosted on Render free tier as a Web Service with a webhook.

## How it works
- `content/` — the whole course as data (`course.json` + `m1.json` … `m6.json`, `library.json`, `ai_models.json`).
  The bot only renders it. Lessons with `"status": "outline"` show as ⏳ "coming soon".
- `bot/engine.py` — gating, scoring (server‑side), streaks, stats. `bot/handlers.py` — Telegram layer.
- `bot/store.py` — `PgStore` (production) and `MemoryStore` (tests). Schema: `migrations/001_init.sql`, applied on start.
- `bot/app.py` — aiohttp server: `POST /webhook` (Telegram, checked with `WEBHOOK_SECRET`), `GET /health`, `GET /tick`.
- Gating: every item (lesson → … → weekly test → … → monthly test → next module → … → final) opens only when the
  previous one is passed. A lesson quiz opens after "✅ Посмотрел видео".

## Environment variables
| var | what |
|---|---|
| `BOT_TOKEN` | from @BotFather |
| `ADMIN_ID` | admin's numeric Telegram id |
| `DATABASE_URL` | Neon Postgres connection string |
| `INVITE_CODE` | one‑time code; the first non‑admin who sends it becomes the student |
| `WEBHOOK_SECRET`, `TICK_SECRET` | random strings |
| `TEST_MODE` | `1` lets the admin take the course as a separate test learner (`/skip`, `/test_reset`) |

Secrets live only in Render env vars and a local `.env` (git‑ignored). See `.env.example`.

## Deploy (Render)
1. Web Service from this repo, runtime Python, build `pip install -r requirements.txt`, start `python -m bot.app`,
   health check path `/health`, plan Free. Set the env vars above.
2. On start the bot registers its webhook at `$RENDER_EXTERNAL_URL/webhook`.
3. Scheduler: Render free services sleep after 15 min idle, so there is no in‑process cron. GitHub Actions
   (`.github/workflows/tick.yml`) calls `/tick` every 10 min with header `X-Tick-Secret`. Repo secrets: `BOT_URL`, `TICK_SECRET`.
   The tick sends reminders (student idle 2+ days, max 1/day, not 21:00–09:00 Kyiv), the admin idle alert (3+ days) and
   the Sunday 19:00 digest. Backup pinger (recommended): cron-job.org → `https://<bot>/tick?key=<TICK_SECRET>` every 10 min.

## Content editing
- **Add/fix a lesson:** edit the lesson in `content/mN.json`, set `"status": "ready"`, run `python scripts/validate_content.py`.
- **Add a video:** fill `video` (and optional `alt_video`): `url, title, channel, duration, language, why_chosen,
  verified_at, status` (`verified` only if the page was actually checked), `needs_subtitles` for English.
- **Change a pass mark or question count:** `content/course.json` → `pass_marks` / `question_counts`.
- **"На досуге":** `content/library.json` (categories → items).

## Admin commands
`/admin` dashboard · `/unlock <id>` · `/reset_quiz <id>` · `/note <text>`. Ids: `m1w2l3` lesson, `m1w2t` weekly test,
`m1t` monthly test, `final`.

## Tests
```
python -m unittest -v            # scoring, gating, unlock, random selection, validator, ticks
python scripts/simulate.py       # fake student through module 1 (add --pg to run against DATABASE_URL)
```
