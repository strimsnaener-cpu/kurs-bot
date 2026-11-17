"""Telegram handlers (aiogram 3). Thin layer: parse input -> Engine -> render."""
import logging
from datetime import datetime, timezone
from html import escape as e

from aiogram import F, Bot, Router
from aiogram.exceptions import TelegramBadRequest
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (CallbackQuery, ErrorEvent, KeyboardButton, Message, ReplyKeyboardMarkup)

from . import config, render
from . import engine as en
from .strings import t
from . import sections

log = logging.getLogger("kurs")
router = Router()


class Ctx:
    engine: en.Engine = None
    bot: Bot = None


ctx = Ctx()


def now() -> datetime:
    return datetime.now(timezone.utc)


MENU = ReplyKeyboardMarkup(resize_keyboard=True, is_persistent=True, keyboard=[
    [KeyboardButton(text=t("btn_continue")), KeyboardButton(text=t("btn_course"))],
    [KeyboardButton(text=t("btn_progress")), KeyboardButton(text=t("btn_leisure"))],
    [KeyboardButton(text=t("btn_models")), KeyboardButton(text=t("btn_project")), KeyboardButton(text=t("btn_help"))],
])


def is_admin(uid: int) -> bool:
    return uid == config.ADMIN_ID


async def learner(uid: int):
    """The user row if this Telegram user may take the course, else None."""
    u = await ctx.engine.s.get_user(uid)
    if not u:
        return None
    if u["role"] == "student" or (u["role"] == "admin" and config.TEST_MODE):
        return u
    return None


async def notify_admin(u: dict, text: str):
    if not config.ADMIN_ID:
        return
    if u["role"] == "admin":
        text = "🧪 " + text
    try:
        await ctx.bot.send_message(config.ADMIN_ID, text)
    except Exception as ex:  # never break the student's flow because of a notification
        log.warning("admin notify failed: %s", type(ex).__name__)


async def edit(cb: CallbackQuery, text: str, markup=None):
    try:
        await cb.message.edit_text(text, reply_markup=markup)
    except TelegramBadRequest as ex:
        if "not modified" not in str(ex):
            await cb.message.answer(text, reply_markup=markup)


# ---- registration --------------------------------------------------------
@router.message(CommandStart())
async def start(msg: Message, command: CommandObject):
    uid, name = msg.from_user.id, msg.from_user.first_name or ""
    s = ctx.engine.s
    if is_admin(uid):
        await s.create_user(uid, name, "admin", now())
        await msg.answer(t("admin_hello", test=t("admin_test_on") if config.TEST_MODE else ""), reply_markup=MENU)
        return
    u = await s.get_user(uid)
    if u:
        await msg.answer(t("help"), reply_markup=MENU)
        return
    if command.args:
        await try_code(msg, command.args.strip())
    else:
        await msg.answer(t("ask_code"))


async def try_code(msg: Message, code: str):
    s = ctx.engine.s
    if not config.INVITE_CODE or code.upper() != config.INVITE_CODE.upper():
        await msg.answer(t("bad_code"))
        return
    name = msg.from_user.first_name or "друг"
    u = await s.create_user(msg.from_user.id, name, "student", now())
    await msg.answer(t("welcome", name=e(name)), reply_markup=MENU)
    await notify_admin(u, t("adm_registered", name=e(name)))


# ---- menu ----------------------------------------------------------------
async def guard(msg: Message):
    u = await learner(msg.from_user.id)
    if not u:
        if is_admin(msg.from_user.id):
            await msg.answer(t("admin_hello", test=""))
        else:
            await msg.answer(t("ask_code"))
        return None
    await ctx.engine.touch(u["id"], now())
    return u


@router.message(F.text == t("btn_course"))
async def m_course(msg: Message):
    if u := await guard(msg):
        text, kb = render.course_map(ctx.engine.c, await ctx.engine.s.get_progress(u["id"]))
        await msg.answer(text, reply_markup=kb)


@router.message(F.text == t("btn_continue"))
async def m_continue(msg: Message):
    if u := await guard(msg):
        text, kb = await continue_view(u["id"])
        await msg.answer(text, reply_markup=kb)


@router.message(F.text == t("btn_progress"))
async def m_progress(msg: Message):
    if u := await guard(msg):
        st = await ctx.engine.stats(u["id"], now())
        await msg.answer(render.progress_text(ctx.engine.c, st))


@router.message(F.text == t("btn_help"))
async def m_help(msg: Message):
    if await guard(msg):
        await msg.answer(t("help"), reply_markup=MENU)


@router.message(F.text == t("btn_leisure"))
async def m_leisure(msg: Message):
    if await guard(msg):
        text, kb = sections.leisure_menu(ctx.engine.c)
        await msg.answer(text, reply_markup=kb)


@router.message(F.text == t("btn_models"))
async def m_models(msg: Message):
    if await guard(msg):
        await msg.answer(sections.models_text(ctx.engine.c))


@router.message(F.text == t("btn_project"))
async def m_project(msg: Message):
    if u := await guard(msg):
        text, kb = await sections.project_entry(ctx.engine, u)
        await msg.answer(text, reply_markup=kb)


async def continue_view(uid: int):
    c, s = ctx.engine.c, ctx.engine.s
    prog = await s.get_progress(uid)
    cur = en.current_item(c, prog)
    if cur is None:
        return t("all_done"), None
    return item_view(c, prog, cur.id)


def item_view(c, prog, item_id):
    st = en.item_status(c, prog, item_id)
    if st == en.LOCKED:
        return t("locked"), None
    if st == en.SOON:
        return t("soon"), None
    it = c.by_id[item_id]
    return render.lesson_card(c, prog, item_id) if it.kind == "lesson" else render.test_intro(c, prog, item_id)


# ---- callbacks -----------------------------------------------------------
@router.callback_query()
async def callbacks(cb: CallbackQuery):
    data = cb.data or ""
    uid = cb.from_user.id
    u = await learner(uid)
    if not u:
        await cb.answer(t("ask_code")[:190].replace("<b>", "").replace("</b>", ""), show_alert=True)
        return
    eng = ctx.engine
    c, s = eng.c, eng.s
    await eng.touch(uid, now())
    kind, _, arg = data.partition(":")

    if kind == "map":
        await edit(cb, *render.course_map(c, await s.get_progress(uid)))
    elif kind == "m" and arg in c.module_by_id:
        await edit(cb, *render.module_view(c, await s.get_progress(uid), arg))
    elif kind == "w" and arg in c.weeks:
        await edit(cb, *render.week_view(c, await s.get_progress(uid), arg))
    elif kind == "o" and arg in c.by_id:
        prog = await s.get_progress(uid)
        st = en.item_status(c, prog, arg)
        if st in (en.LOCKED, en.SOON):
            await cb.answer(t(st).replace("<b>", "").replace("</b>", "")[:190], show_alert=True)
            return
        text, kb = item_view(c, prog, arg)
        await cb.message.answer(text, reply_markup=kb)
    elif kind == "go":
        text, kb = await continue_view(uid)
        await cb.message.answer(text, reply_markup=kb)
    elif kind == "wv" and arg in c.lessons:
        if await eng.mark_watched(uid, arg, now()):
            await edit(cb, *render.lesson_card(c, await s.get_progress(uid), arg))
            await cb.answer(t("watched_ok"))
            return
    elif kind == "el" and arg in c.lessons and c.lesson_ready(arg):
        await cb.message.answer(t("eli5", text=e(c.lessons[arg]["eli5"])))
    elif kind == "qs" and arg in c.by_id:
        a, why = await eng.start_quiz(uid, arg, now())
        if not a:
            await cb.answer(t({"not_watched": "need_watch"}.get(why, why if why in ("locked", "soon") else "error"))
                            .replace("<b>", "").replace("</b>", "")[:190], show_alert=True)
            return
        it = c.by_id[arg]
        if not a["answers"]:
            await cb.message.answer(t("quiz_start", title=e(it.title), n=len(a["questions"]), need=c.pass_marks[it.kind]))
        qt, qk = render.question(a)
        await cb.message.answer(qt, reply_markup=qk)
    elif kind == "qa":
        try:
            aid, qidx, opt = (int(x) for x in arg.split(":"))
        except ValueError:
            await cb.answer()
            return
        a, correct = await eng.answer(uid, aid, qidx, opt)
        if a is None:
            await cb.answer()
            return
        await edit(cb, *render.feedback(a, qidx, correct))
        await cb.answer("✅" if correct else "❌")
        return
    elif kind == "qn":
        try:
            aid = int(arg)
        except ValueError:
            await cb.answer()
            return
        a = await s.get_attempt(aid)
        if not a or a["user_id"] != uid or a["status"] != "active":
            await cb.answer(t("quiz_gone"), show_alert=True)
            return
        if len(a["answers"]) < len(a["questions"]):
            await edit(cb, *render.question(a))
        else:
            res = await eng.finish(uid, aid, now())
            if res:
                await on_result(cb, u, res)
    elif kind == "lib" or kind == "libc":
        await edit(cb, *sections.leisure_view(c, data))
    elif kind == "pj":
        await sections.project_callback(cb, eng, u, arg)
        return
    await cb.answer()


async def on_result(cb: CallbackQuery, u: dict, res: en.QuizResult):
    c = ctx.engine.c
    stats = await ctx.engine.stats(u["id"], now()) if res.kind == "final" else None
    await edit(cb, *render.result(c, res, u["first_name"], stats))
    it = c.by_id[res.item_id]
    name = e(u["first_name"])
    await notify_admin(u, t("adm_quiz", name=name, title=e(it.title), score=res.score, mark="✅" if res.passed else "❌ не сдал"))
    if res.week_completed:
        await notify_admin(u, t("adm_week", name=name, title=e(c.weeks[res.week_completed]["title"])))
    if res.module_completed:
        await notify_admin(u, t("adm_module", name=name, title=e(c.module_by_id[res.module_completed]["title"])))


# ---- admin ---------------------------------------------------------------
@router.message(Command("admin"))
async def a_dashboard(msg: Message, command: CommandObject):
    if not is_admin(msg.from_user.id):
        return
    from .scheduler import dashboard
    await msg.answer(await dashboard(ctx.engine, now(), command.args or ""))


async def _student_or_say(msg: Message, who: str = ""):
    """Pick the target student: by Telegram id or name (who), or the only one if there is just one."""
    students = await ctx.engine.s.get_students()
    if not students:
        await msg.answer("Ещё никто не зарегистрировался.")
        return None
    who = who.strip()
    if who:
        for st in students:
            if who == str(st["id"]) or who.lower() == (st["first_name"] or "").lower():
                return st
        await msg.answer(f"Ученик «{e(who)}» не найден. Список: /admin")
        return None
    if len(students) == 1:
        return students[0]
    await msg.answer("Учеников несколько — допиши в конце id или имя ученика (список: /admin).")
    return None


def _split(args: str | None) -> tuple[str, str]:
    parts = (args or "").strip().split(maxsplit=1)
    return (parts[0] if parts else ""), (parts[1] if len(parts) > 1 else "")


@router.message(Command("unlock"))
async def a_unlock(msg: Message, command: CommandObject):
    if not is_admin(msg.from_user.id):
        return
    item, who = _split(command.args)
    if item not in ctx.engine.c.by_id:
        await msg.answer("Формат: /unlock m1w2l3 [id или имя] (или m1w1t, m1t, final)")
        return
    if st := await _student_or_say(msg, who):
        await ctx.engine.s.manual_unlock(st["id"], item)
        await msg.answer(f"🔓 Открыто для {e(st['first_name'])}: {item}")


@router.message(Command("reset_quiz"))
async def a_reset(msg: Message, command: CommandObject):
    if not is_admin(msg.from_user.id):
        return
    item, who = _split(command.args)
    if item not in ctx.engine.c.by_id:
        await msg.answer("Формат: /reset_quiz m1w2l3 [id или имя]")
        return
    if st := await _student_or_say(msg, who):
        await ctx.engine.s.reset_item(st["id"], item)
        await msg.answer(f"♻️ Сброшено: {item} (история попыток сохранена)")


@router.message(Command("note"))
async def a_note(msg: Message, command: CommandObject):
    if not is_admin(msg.from_user.id):
        return
    text = (command.args or "").strip()
    if not text:
        await msg.answer("Формат: /note текст (одному ученику)  или  /note всем текст  или  /note id: текст")
        return
    students = await ctx.engine.s.get_students()
    if text.lower().startswith("всем "):
        body, targets = text[5:].strip(), students
    elif ":" in text.split(maxsplit=1)[0]:
        who, body = text.split(":", 1)
        st = await _student_or_say(msg, who)
        targets, body = ([st] if st else []), body.strip()
        if not st:
            return
    else:
        st = await _student_or_say(msg)
        if not st:
            return
        targets, body = [st], text
    sent = 0
    for st in targets:
        try:
            await ctx.bot.send_message(st["id"], t("note_from_admin", text=e(body)))
            sent += 1
        except Exception as ex:
            log.warning("note failed: %s", type(ex).__name__)
    await msg.answer(f"📨 Отправлено: {sent}.")


@router.message(Command("skip"))
async def a_skip(msg: Message):
    """TEST_MODE only: mark the admin's own current step as passed."""
    if not (is_admin(msg.from_user.id) and config.TEST_MODE):
        return
    eng = ctx.engine
    prog = await eng.s.get_progress(msg.from_user.id)
    cur = en.current_item(eng.c, prog)
    if cur:
        await eng.s.mark_watched(msg.from_user.id, cur.id, now())
        await eng.s.record_result(msg.from_user.id, cur.id, 100, True, now())
        await msg.answer(f"⏭ Засчитано: {cur.id}")


@router.message(Command("test_reset"))
async def a_test_reset(msg: Message):
    if not (is_admin(msg.from_user.id) and config.TEST_MODE):
        return
    await ctx.engine.s.delete_user_data(msg.from_user.id)
    await ctx.engine.s.create_user(msg.from_user.id, msg.from_user.first_name or "", "admin", now())
    await msg.answer("🧹 Твои тестовые данные сброшены.")


@router.message(F.text)
async def any_text(msg: Message):
    uid = msg.from_user.id
    if not is_admin(uid) and not await ctx.engine.s.get_user(uid):
        await try_code(msg, msg.text.strip())
        return
    u = await learner(uid)
    if u and await sections.project_text(msg, ctx.engine, u):
        return
    await msg.answer(t("unknown"), reply_markup=MENU)


@router.message()
async def any_other(msg: Message):
    await msg.answer(t("unknown"))


@router.errors()
async def on_error(event: ErrorEvent):
    log.exception("handler error: %s", type(event.exception).__name__)
    upd = event.update
    try:
        if upd.callback_query:
            await upd.callback_query.answer(t("error"), show_alert=True)
        elif upd.message:
            await upd.message.answer(t("error"))
    except Exception:
        pass
    return True
