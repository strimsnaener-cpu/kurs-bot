import asyncio
import random
import unittest
from collections import Counter
from datetime import datetime, timedelta, timezone

from bot import engine as en
from bot import scheduler
from bot.content import Content, validate
from bot.store import MemoryStore
from tests.fixture import ready_content_dir

C = Content(ready_content_dir())
T0 = datetime(2026, 11, 16, 10, 0, tzinfo=timezone.utc)   # Monday 12:00 Kyiv
UID = 111


def run(coro):
    return asyncio.run(coro)


async def new_engine():
    s = MemoryStore()
    await s.create_user(UID, "Тест", "student", T0)
    return en.Engine(C, s, random.Random(1)), s


async def take(eng, item, n_correct, now=T0):
    """Answer an item's quiz with exactly n_correct right answers."""
    if C.by_id[item].kind == "lesson":
        await eng.mark_watched(UID, item, now)
    a, why = await eng.start_quiz(UID, item, now)
    assert a, why
    for i, q in enumerate(a["questions"]):
        opt = q["correct"] if i < n_correct else (q["correct"] + 1) % 4
        a2, ok = await eng.answer(UID, a["id"], i, opt)
        assert a2 is not None
    return await eng.finish(UID, a["id"], now)


class Scoring(unittest.TestCase):
    def test_score(self):
        a = {"questions": [{"correct": 1}] * 5, "answers": {"0": 1, "1": 1, "2": 0, "3": 1, "4": 3}}
        self.assertEqual(en.score_attempt(a), (60, 3, 5))

    def test_lesson_scores_are_multiples_of_20(self):
        async def go():
            eng, _ = await new_engine()
            res = await take(eng, "m1w1l1", 2)
            return res
        r = run(go())
        self.assertEqual(r.score, 40)
        self.assertTrue(r.passed)   # 40 is the pass mark

    def test_progress_bar(self):
        self.assertEqual(en.progress_bar(37, 8), "▰▰▰▱▱▱▱▱ 37%")


class Gating(unittest.TestCase):
    def test_first_open_rest_locked(self):
        async def go():
            eng, _ = await new_engine()
            return await eng.status(UID, "m1w1l1"), await eng.status(UID, "m1w1l2")
        self.assertEqual(run(go()), (en.OPEN, en.LOCKED))

    def test_quiz_requires_watched(self):
        async def go():
            eng, _ = await new_engine()
            return await eng.start_quiz(UID, "m1w1l1", T0)
        a, why = run(go())
        self.assertIsNone(a)
        self.assertEqual(why, "not_watched")

    def test_fail_blocks_then_retake_unlocks(self):
        async def go():
            eng, _ = await new_engine()
            r1 = await take(eng, "m1w1l1", 1)          # 20 < 40
            st1 = await eng.status(UID, "m1w1l2")
            r2 = await take(eng, "m1w1l1", 4)          # 80
            st2 = await eng.status(UID, "m1w1l2")
            return r1, st1, r2, st2
        r1, st1, r2, st2 = run(go())
        self.assertFalse(r1.passed)
        self.assertEqual(st1, en.LOCKED)
        self.assertTrue(r2.passed and r2.first_pass)
        self.assertEqual(st2, en.OPEN)

    def test_locked_lesson_cannot_be_watched_or_quizzed(self):
        async def go():
            eng, _ = await new_engine()
            return await eng.mark_watched(UID, "m1w1l3", T0), await eng.start_quiz(UID, "m1w1l3", T0)
        w, (a, why) = run(go())
        self.assertFalse(w)
        self.assertEqual(why, en.LOCKED)

    def test_week_month_chain(self):
        async def go():
            eng, s = await new_engine()
            out = {}
            for w in C.module_by_id["m1"]["weeks"]:
                for l in w["lessons"]:
                    await take(eng, l["id"], 5)
                out.setdefault("before_test", await eng.status(UID, "m1w2l1"))
                r = await take(eng, w["id"] + "t", 4)       # 40 < 50 -> fail
                out.setdefault("week_fail", r)
                r = await take(eng, w["id"] + "t", 10)
                out.setdefault("week_pass", r)
            out["m2_before"] = await eng.status(UID, "m2w1l1")
            out["month_fail"] = await take(eng, "m1t", 11)     # 55 < 60
            out["m2_after_fail"] = await eng.status(UID, "m2w1l1")
            out["month_pass"] = await take(eng, "m1t", 12)     # 60
            out["m2_after"] = await eng.status(UID, "m2w1l1")
            return out
        o = run(go())
        self.assertEqual(o["before_test"], en.LOCKED)
        self.assertFalse(o["week_fail"].passed)
        self.assertTrue(o["week_fail"].missed_lessons)
        self.assertEqual(o["week_pass"].week_completed, "m1w1")
        self.assertEqual(o["m2_before"], en.LOCKED)
        self.assertFalse(o["month_fail"].passed)
        self.assertEqual(o["m2_after_fail"], en.LOCKED)
        self.assertEqual(o["month_pass"].module_completed, "m1")
        self.assertEqual(o["m2_after"], en.OPEN)

    def test_manual_unlock(self):
        async def go():
            eng, s = await new_engine()
            await s.manual_unlock(UID, "m1w3l2")
            return await eng.status(UID, "m1w3l2")
        self.assertEqual(run(go()), en.OPEN)

    def test_soon_for_outline_lessons(self):
        real = Content()
        prog = {}
        # with the real (partly outline) content, an unfilled first lesson is SOON, never OPEN
        st = en.item_status(real, prog, real.items[0].id)
        self.assertIn(st, (en.OPEN, en.SOON))


class Idempotency(unittest.TestCase):
    def test_double_answer_and_double_finish(self):
        async def go():
            eng, s = await new_engine()
            await eng.mark_watched(UID, "m1w1l1", T0)
            a, _ = await eng.start_quiz(UID, "m1w1l1", T0)
            a_again, _ = await eng.start_quiz(UID, "m1w1l1", T0)     # double tap resumes
            r1 = await eng.answer(UID, a["id"], 0, 0)
            r2 = await eng.answer(UID, a["id"], 0, 1)                 # same question again
            skip = await eng.answer(UID, a["id"], 3, 0)               # out of order
            for i in range(1, 5):
                await eng.answer(UID, a["id"], i, 0)
            f1 = await eng.finish(UID, a["id"], T0)
            f2 = await eng.finish(UID, a["id"], T0)
            other = await eng.answer(999, a["id"], 0, 0)              # another user
            return a, a_again, r1, r2, skip, f1, f2, other
        a, a2, r1, r2, skip, f1, f2, other = run(go())
        self.assertEqual(a["id"], a2["id"])
        self.assertIsNotNone(r1[0])
        self.assertEqual(r2, (None, None))
        self.assertEqual(skip, (None, None))
        self.assertIsNotNone(f1)
        self.assertIsNone(f2)
        self.assertEqual(other, (None, None))


class Selection(unittest.TestCase):
    def test_lesson_pick_5_distinct_and_shuffled(self):
        rng = random.Random(3)
        seen_orders = set()
        for _ in range(20):
            qs = C.select_questions("m1w1l1", rng)
            self.assertEqual(len(qs), 5)
            self.assertEqual(len({q["q"] for q in qs}), 5)
            bank = {b["q"]: b for b in C.lessons["m1w1l1"]["questions"]}
            for q in qs:
                orig = bank[q["q"]]
                self.assertEqual(q["options"][q["correct"]], orig["options"][orig["correct"]])
                self.assertEqual(sorted(q["options"]), sorted(orig["options"]))
            seen_orders.add(tuple(q["q"] for q in qs))
        self.assertGreater(len(seen_orders), 1)

    def test_week_month_final_distribution(self):
        rng = random.Random(5)
        wk = Counter(q["lid"] for q in C.select_questions("m1w1t", rng))
        self.assertEqual(sum(wk.values()), 10)
        self.assertEqual(set(wk.values()), {2})
        mo = Counter(q["lid"] for q in C.select_questions("m1t", rng))
        self.assertEqual(sum(mo.values()), 20)
        self.assertEqual(len(mo), 20)
        fin = Counter(q["lid"][:2] for q in C.select_questions("final", rng))
        self.assertEqual(fin, Counter({m: 5 for m in ("m1", "m2", "m3", "m4", "m5", "m6")}))


class Validator(unittest.TestCase):
    def test_real_content_valid(self):
        self.assertEqual(validate(Content()), [])

    def test_fixture_valid(self):
        self.assertEqual(validate(C), [])

    def test_detects_problems(self):
        c = Content(ready_content_dir())
        l = c.lessons["m1w1l1"]
        l["questions"][0]["correct"] = 7
        l["questions"][1]["options"] = ["a", "a", "b", "c"]
        l["video"]["url"] = "https://example.com/x"
        l["notes"] = ["only one"]
        errs = "\n".join(validate(c))
        for needle in ("correct must be", "4 distinct", "bad YouTube url", "3 notes"):
            self.assertIn(needle, errs)


class Streak(unittest.TestCase):
    def test_streak_counts_consecutive_days(self):
        async def go():
            eng, s = await new_engine()
            await take(eng, "m1w1l1", 5, T0)
            await take(eng, "m1w1l2", 5, T0 + timedelta(hours=1))
            await take(eng, "m1w1l3", 5, T0 + timedelta(days=1))
            u1 = await s.get_user(UID)
            await take(eng, "m1w1l4", 5, T0 + timedelta(days=3))
            u2 = await s.get_user(UID)
            return u1, u2
        u1, u2 = run(go())
        self.assertEqual((u1["streak"], u2["streak"], u2["best_streak"]), (2, 1, 2))


class Ticks(unittest.TestCase):
    def test_reminder_quiet_hours_once_per_day_and_admin_alert(self):
        async def go():
            eng, s = await new_engine()
            out = []
            night = T0 + timedelta(days=2, hours=10)       # 22:00 Kyiv -> quiet
            out.append(await scheduler.tick(eng, None, night))
            day = T0 + timedelta(days=3)                   # 12:00 Kyiv, 3 days idle
            out.append(await scheduler.tick(eng, None, day))
            out.append(await scheduler.tick(eng, None, day + timedelta(hours=2)))
            await eng.touch(UID, day + timedelta(hours=3))
            out.append(await scheduler.tick(eng, None, day + timedelta(hours=4)))
            return out
        o = run(go())
        self.assertNotIn("remind", o[0])
        self.assertEqual(sorted(o[1]), ["idle_alert", "remind"])
        self.assertEqual(o[2], [])
        self.assertEqual(o[3], [])

    def test_sunday_digest_once(self):
        async def go():
            eng, s = await new_engine()
            sun = datetime(2026, 11, 22, 18, 0, tzinfo=timezone.utc)   # Sunday 20:00 Kyiv
            await eng.touch(UID, sun)
            return await scheduler.tick(eng, None, sun), await scheduler.tick(eng, None, sun + timedelta(minutes=30))
        a, b = run(go())
        self.assertEqual(a, ["digest"])
        self.assertEqual(b, [])

    def test_dashboard_renders(self):
        async def go():
            eng, s = await new_engine()
            await take(eng, "m1w1l1", 1)
            return await scheduler.dashboard(eng, T0 + timedelta(days=8))
        txt = run(go())
        self.assertIn("отстаёт", txt)
        self.assertIn("m1w1l1", txt)


if __name__ == "__main__":
    unittest.main()
