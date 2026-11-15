"""End-to-end through the real aiogram dispatcher with a fake Telegram API (no network)."""
import asyncio
import itertools
import unittest
from datetime import datetime, timezone

from aiogram import Bot, Dispatcher
from aiogram.client.session.base import BaseSession
from aiogram.methods import AnswerCallbackQuery, EditMessageText, SendMessage
from aiogram.types import CallbackQuery, Chat, InlineKeyboardMarkup, Message, Update, User

from bot import config
from bot.content import Content
from bot.engine import Engine
from bot.handlers import ctx, router
from bot.store import MemoryStore
from tests.fixture import ready_content_dir

ADMIN, STUDENT, STRANGER = 1000, 2000, 3000
ids = itertools.count(1)


class FakeSession(BaseSession):
    def __init__(self):
        super().__init__()
        self.calls = []

    async def make_request(self, bot, method, timeout=None):
        self.calls.append(method)
        if isinstance(method, (SendMessage, EditMessageText)):
            chat_id = getattr(method, "chat_id", None) or 0
            return Message(message_id=next(ids), date=datetime.now(timezone.utc),
                           chat=Chat(id=chat_id, type="private"), text=method.text,
                           reply_markup=method.reply_markup if isinstance(method.reply_markup, InlineKeyboardMarkup) else None)
        return True

    async def close(self):
        pass

    async def stream_content(self, *a, **k):
        yield b""


def user(uid, name="Ваня"):
    return User(id=uid, is_bot=False, first_name=name)


def msg(uid, text):
    return Update(update_id=next(ids), message=Message(message_id=next(ids), date=datetime.now(timezone.utc),
                  chat=Chat(id=uid, type="private"), from_user=user(uid), text=text))


def cb(uid, data):
    m = Message(message_id=next(ids), date=datetime.now(timezone.utc), chat=Chat(id=uid, type="private"),
                from_user=user(0, "bot"), text="x")
    return Update(update_id=next(ids), callback_query=CallbackQuery(id=str(next(ids)), from_user=user(uid),
                  chat_instance="ci", message=m, data=data))


class E2E(unittest.TestCase):
    def test_full_flow(self):
        asyncio.run(self._flow())

    async def _flow(self):
        config.ADMIN_ID, config.INVITE_CODE, config.TEST_MODE = ADMIN, "KURS-TEST", False
        content = Content(ready_content_dir())
        store = MemoryStore()
        session = FakeSession()
        bot = Bot("123:ABC", session=session)
        ctx.engine, ctx.bot = Engine(content, store), bot
        dp = Dispatcher()
        dp.include_router(router)

        async def send(update):
            session.calls.clear()
            await dp.feed_update(bot, update)
            return session.calls

        def texts(calls, chat=None):
            return [c.text for c in calls if isinstance(c, (SendMessage, EditMessageText))
                    and (chat is None or getattr(c, "chat_id", None) == chat)]

        # stranger without code is asked for it; wrong code refused
        self.assertIn("код приглашения", texts(await send(msg(STUDENT, "/start")))[0])
        self.assertIn("не подошёл", texts(await send(msg(STUDENT, "WRONG")))[0])
        # correct code registers + transparency notice + admin alert
        calls = await send(msg(STUDENT, "kurs-test"))
        self.assertIn("видит твой прогресс", texts(calls, STUDENT)[0])
        self.assertTrue(any("зарегистрировался" in t for t in texts(calls, ADMIN)))
        # second person refused
        self.assertIn("место уже занято", texts(await send(msg(STRANGER, "/start KURS-TEST")))[0])

        # continue -> lesson card; quiz locked until watched
        card = texts(await send(msg(STUDENT, "▶️ Продолжить")))[0]
        self.assertIn("Урок 1.", card)
        calls = await send(cb(STUDENT, "qs:m1w1l1"))
        self.assertTrue(any(isinstance(c, AnswerCallbackQuery) and c.show_alert for c in calls))
        # watched -> quiz
        await send(cb(STUDENT, "wv:m1w1l1"))
        calls = await send(cb(STUDENT, "qs:m1w1l1"))
        self.assertTrue(any("Вопрос 1/5" in t for t in texts(calls)))
        a = await store.active_attempt(STUDENT, "m1w1l1")
        # answer all wrong -> fail -> next lesson locked
        for i, q in enumerate(a["questions"]):
            calls = await send(cb(STUDENT, f"qa:{a['id']}:{i}:{(q['correct'] + 1) % 4}"))
            self.assertIn("Не совсем", texts(calls)[0])
            await send(cb(STUDENT, f"qa:{a['id']}:{i}:{q['correct']}"))      # double tap ignored
            calls = await send(cb(STUDENT, f"qn:{a['id']}"))
        res = texts(calls, STUDENT)[0]
        self.assertIn("0/100", res)
        self.assertTrue(any("❌" in t for t in texts(calls, ADMIN)))
        calls = await send(cb(STUDENT, "o:m1w1l2"))
        self.assertTrue(any(isinstance(c, AnswerCallbackQuery) and c.show_alert for c in calls))
        # retake, all right -> pass -> next lesson opens
        await send(cb(STUDENT, "qs:m1w1l1"))
        a = await store.active_attempt(STUDENT, "m1w1l1")
        for i, q in enumerate(a["questions"]):
            await send(cb(STUDENT, f"qa:{a['id']}:{i}:{q['correct']}"))
            calls = await send(cb(STUDENT, f"qn:{a['id']}"))
        self.assertIn("Тест пройден", texts(calls, STUDENT)[0])
        self.assertIn("Урок 2.", texts(await send(cb(STUDENT, "go")))[0])

        # menu sections and garbage input don't crash
        for t in ("📊 Мой прогресс", "📚 Курс", "🎧 На досуге", "🤖 Модели ИИ", "🛠 Мой проект", "ℹ️ Помощь", "что-то"):
            self.assertTrue(texts(await send(msg(STUDENT, t))), t)
        for data in ("m:m1", "w:m1w1", "w:zzz", "qa:1:x:y", "qn:999", "o:nope", "map", "", "lib"):
            await send(cb(STUDENT, data))

        # admin
        dash = texts(await send(msg(ADMIN, "/admin")))[0]
        self.assertIn("Панель", dash)
        self.assertIn("m1w1l1", dash)
        await send(msg(ADMIN, "/unlock m1w3l1"))
        self.assertEqual((await store.get_progress(STUDENT))["m1w3l1"]["manual_unlock"], True)
        calls = await send(msg(ADMIN, "/note Молодец!"))
        self.assertTrue(any("Молодец" in t for t in texts(calls, STUDENT)))
        await send(msg(ADMIN, "/reset_quiz m1w1l1"))
        self.assertNotIn("m1w1l1", await store.get_progress(STUDENT))
        # student cannot use admin commands
        self.assertFalse(any("Панель" in t for t in texts(await send(msg(STUDENT, "/admin")))))


if __name__ == "__main__":
    unittest.main()
