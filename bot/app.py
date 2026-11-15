"""Web entry point: Telegram webhook + /health + /tick.

Run on Render:  python -m bot.app
Local polling (only for development, removes the webhook!):  python -m bot.app --polling
"""
import asyncio
import hmac
import logging
import sys
import time
from datetime import datetime, timezone

from aiohttp import ClientSession, web
from aiogram import Bot, Dispatcher
from aiogram.client.default import DefaultBotProperties
from aiogram.webhook.aiohttp_server import SimpleRequestHandler, setup_application

from . import config, scheduler
from .content import Content, validate
from .engine import Engine
from .handlers import ctx, router
from .store import MemoryStore, PgStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("aiogram.event").setLevel(logging.WARNING)
log = logging.getLogger("kurs")

WEBHOOK_PATH = "/webhook"
TICK_WORK_EVERY = 50 * 60        # do DB work at most every 50 min (keeps Neon compute usage low)
_last_tick_work = 0.0


async def build():
    content = Content()
    problems = validate(content)
    if problems:
        raise SystemExit("content invalid:\n" + "\n".join(problems[:30]))
    store = await PgStore.connect(config.DATABASE_URL) if config.DATABASE_URL else MemoryStore()
    if not config.DATABASE_URL:
        log.warning("DATABASE_URL not set: using in-memory store (data is lost on restart)")
    bot = Bot(config.BOT_TOKEN, default=DefaultBotProperties(parse_mode="HTML", link_preview_is_disabled=True))
    ctx.engine, ctx.bot = Engine(content, store), bot
    dp = Dispatcher()
    dp.include_router(router)
    return bot, dp, store


async def health(_req):
    return web.json_response({"ok": True})


async def tick(req: web.Request):
    global _last_tick_work
    key = req.headers.get("X-Tick-Secret") or req.query.get("key", "")
    if not config.TICK_SECRET or not hmac.compare_digest(key, config.TICK_SECRET):
        return web.Response(status=403, text="forbidden")
    if time.monotonic() - _last_tick_work < TICK_WORK_EVERY and _last_tick_work:
        return web.json_response({"ok": True, "done": [], "skipped": True})
    _last_tick_work = time.monotonic()
    done = await scheduler.tick(ctx.engine, ctx.bot, datetime.now(timezone.utc))
    return web.json_response({"ok": True, "done": done})


async def self_ping(app):
    """While awake, ping our own /health every 10 min so Render does not put us to sleep."""
    async def loop():
        async with ClientSession() as http:
            while True:
                await asyncio.sleep(600)
                try:
                    await http.get(config.PUBLIC_URL + "/health", timeout=20)
                except Exception:
                    pass
    if config.PUBLIC_URL and config.SELF_PING:
        app["ping"] = asyncio.create_task(loop())


def main():
    if "--polling" in sys.argv:
        async def run():
            bot, dp, _ = await build()
            await bot.delete_webhook()
            await dp.start_polling(bot)
        asyncio.run(run())
        return

    async def make_app():
        bot, dp, store = await build()
        app = web.Application()
        app.router.add_get("/health", health)
        app.router.add_get("/", health)
        app.router.add_route("*", "/tick", tick)
        SimpleRequestHandler(dp, bot, secret_token=config.WEBHOOK_SECRET or None).register(app, path=WEBHOOK_PATH)
        setup_application(app, dp, bot=bot)

        async def on_startup(_app):
            if config.PUBLIC_URL:
                await bot.set_webhook(config.PUBLIC_URL + WEBHOOK_PATH, secret_token=config.WEBHOOK_SECRET or None,
                                      allowed_updates=["message", "callback_query"], drop_pending_updates=False)
                log.info("webhook set")

        async def on_cleanup(_app):
            await store.close()
        app.on_startup.append(on_startup)
        app.on_startup.append(self_ping)
        app.on_cleanup.append(on_cleanup)
        return app

    web.run_app(make_app(), host="0.0.0.0", port=config.PORT)


if __name__ == "__main__":
    main()
