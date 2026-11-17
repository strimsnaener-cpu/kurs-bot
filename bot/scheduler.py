"""Scheduled work, driven by the external /tick ping (Render free services sleep, so no in-process cron).

The tick decides what is due: student reminder, admin idle alert, Sunday digest.
"""
import logging
from datetime import datetime, timedelta
from html import escape as e

from . import config
from . import engine as en
from .strings import t

log = logging.getLogger("kurs")


def _ago(now: datetime, then: datetime) -> str:
    d = (now - then).days
    return "сегодня" if d == 0 else f"{d} дн. назад"


async def dashboard(engine: en.Engine, now: datetime, who: str = "") -> str:
    students = await engine.s.get_students()
    if not students:
        return f"👑 <b>Панель</b>\n\nЕщё никто не зарегистрировался.\nКод приглашения задан: {'да' if config.INVITE_CODE else 'НЕТ'}"
    who = who.strip().lower()
    if who:
        found = [u for u in students if who == str(u["id"]) or who == (u["first_name"] or "").lower()]
        if found:
            return await student_card(engine, found[0], now)
    if len(students) == 1:
        return await student_card(engine, students[0], now)
    lines = [f"👑 <b>Панель — учеников: {len(students)}</b>\n"]
    for u in students:
        st = await engine.stats(u["id"], now)
        cur = st["current"]
        where = f"<code>{cur.id}</code>" if cur else "🎓 пройден"
        lines.append(f"• <b>{e(u['first_name'])}</b> (id <code>{u['id']}</code>) — {st['percent']}% · {where} · "
                     f"⭐ {st['xp']} · активность {_ago(now, u['last_active'])}")
    lines.append("\nПодробно: /admin id  ·  в /unlock, /reset_quiz допиши id или имя в конце")
    return "\n".join(lines)


async def student_card(engine: en.Engine, st_user: dict, now: datetime) -> str:
    c = engine.c
    st = await engine.stats(st_user["id"], now)
    u = st["user"]
    cur = st["current"]
    if cur:
        m = [x["id"] for x in c.modules].index(cur.module_id) + 1 if cur.module_id else 6
        w = cur.week_id.split("w")[1] if cur.week_id else "—"
        where = f"{e(cur.title)} (<code>{cur.id}</code>, месяц {m}, неделя {w})"
    else:
        where = "курс пройден 🎓"
    day_n = (now - u["started_at"]).days + 1
    ahead = st["ahead"]
    pace = "в графике 👍" if ahead == 0 else (f"впереди на {ahead} ур. 🚀" if ahead > 0 else f"отстаёт на {-ahead} ур.")
    recent = ", ".join(f"{a['score']}{'' if a['passed'] else '❌'}" for a in st["recent"]) or "—"
    fails = [a for a in st["recent"] if not a["passed"]]
    fail_txt = ", ".join(f"<code>{a['item_id']}</code>" for a in fails) or "нет"
    return (
        f"👑 <b>Панель — {e(u['first_name'])}</b>\n\n"
        f"📅 Старт: {u['started_at'].astimezone(config.TZ):%d.%m.%Y} (день {day_n})\n"
        f"📍 Сейчас: {where}\n"
        f"{en.progress_bar(st['percent'])}\n"
        f"📖 Уроков: {st['lessons_done']}/{len(c.lesson_ids)} · рекомендовано {st['recommended']} → {pace}\n"
        f"🕒 Активность: {_ago(now, u['last_active'])}\n"
        f"🔥 Серия: {st['streak']} (рекорд {u['best_streak']}) · ⭐ {st['xp']} XP\n"
        f"📝 Последние 10: {recent}\n"
        f"📈 Средний: {st['avg'] if st['avg'] is not None else '—'}\n"
        f"❌ Неудачные (из последних 10): {fail_txt}"
    )


async def digest(engine: en.Engine, now: datetime) -> str:
    parts = ["🗞 <b>Итоги недели</b>"]
    for u in await engine.s.get_students():
        week = await engine.s.attempts_since(u["id"], now - timedelta(days=7))
        passed = sorted({a["item_id"] for a in week if a["passed"]})
        scores = [a["score"] for a in week]
        avg = round(sum(scores) / len(scores)) if scores else "—"
        parts.append(f"<b>{e(u['first_name'])}</b>: шагов {len(passed)} · попыток {len(week)} · средний {avg} · "
                     f"неудачных {sum(1 for a in week if not a['passed'])}")
    return "\n".join(parts) + "\n\n" + await dashboard(engine, now)


async def tick(engine: en.Engine, bot, now: datetime) -> list[str]:
    """Run due jobs. Returns a list of what was done (for logs/tests)."""
    s = engine.s
    done = []
    students = await s.get_students()
    if not students:
        return done
    local = now.astimezone(config.TZ)
    for u in students:
        done += await _student_jobs(engine, bot, u, now, local)

    if local.weekday() == config.DIGEST_WEEKDAY and local.hour >= config.DIGEST_HOUR:
        key = f"digest:{local.isocalendar()[0]}-{local.isocalendar()[1]}"
        if not await s.kv_get(key):
            await s.kv_set(key, now.isoformat())
            await _send(bot, config.ADMIN_ID, await digest(engine, now))
            done.append("digest")
    return done


async def _student_jobs(engine: en.Engine, bot, u: dict, now: datetime, local: datetime) -> list[str]:
    s = engine.s
    done = []
    today = local.date()
    idle = now - u["last_active"]
    prog = await s.get_progress(u["id"])
    finished = en.current_item(engine.c, prog) is None
    quiet = local.hour >= config.QUIET_FROM or local.hour < config.QUIET_TO

    if (not finished and idle >= timedelta(days=config.REMIND_AFTER_DAYS) and not quiet
            and u.get("last_reminder_day") != today):
        await s.update_user(u["id"], last_reminder_day=today)
        await _send(bot, u["id"], t("remind", name=e(u["first_name"])))
        done.append("remind")

    if idle >= timedelta(days=config.ADMIN_IDLE_ALERT_DAYS) and not u.get("idle_alert_sent"):
        await s.update_user(u["id"], idle_alert_sent=True)
        await _send(bot, config.ADMIN_ID, t("adm_idle", name=e(u["first_name"]), days=idle.days))
        done.append("idle_alert")
    return done


async def _send(bot, chat_id, text):
    if bot is None or not chat_id:
        return
    try:
        await bot.send_message(chat_id, text)
    except Exception as ex:
        log.warning("send failed: %s", type(ex).__name__)
