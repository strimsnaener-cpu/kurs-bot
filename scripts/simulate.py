"""Simulate a fake student going through a whole module (default m1) and print a summary.

  python scripts/simulate.py            # in-memory store, dummy content for unfilled lessons
  python scripts/simulate.py --pg       # against DATABASE_URL (uses a fake user id, cleaned up after)
"""
import asyncio
import random
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bot import config, render, scheduler                      # noqa: E402
from bot import engine as en                                    # noqa: E402
from bot.content import Content                                 # noqa: E402
from bot.store import MemoryStore, PgStore                      # noqa: E402
from tests.fixture import ready_content_dir                     # noqa: E402

FAKE_UID = -424242


async def main(module="m1", use_pg=False):
    c = Content(ready_content_dir())
    store = await PgStore.connect(config.DATABASE_URL) if use_pg else MemoryStore()
    await store.delete_user_data(FAKE_UID)
    rng = random.Random(7)
    eng = en.Engine(c, store, rng)
    t = datetime.now(timezone.utc)
    await store.create_user(FAKE_UID, "Симулянт", "student", t)
    attempts = fails = 0
    first = next(i for i in c.items if i.module_id == module)
    await store.manual_unlock(FAKE_UID, first.id)   # start mid-course for modules > 1
    try:
        for it in [i for i in c.items if i.module_id == module]:
            while True:
                t += timedelta(minutes=37)
                if it.kind == "lesson":
                    assert await eng.mark_watched(FAKE_UID, it.id, t), it.id
                    render.lesson_card(c, await store.get_progress(FAKE_UID), it.id)
                a, why = await eng.start_quiz(FAKE_UID, it.id, t)
                assert a, (it.id, why)
                p_right = 0.55
                for i, q in enumerate(a["questions"]):
                    opt = q["correct"] if rng.random() < p_right else (q["correct"] + 1) % 4
                    a, ok = await eng.answer(FAKE_UID, a["id"], i, opt)
                    render.feedback(a, i, ok)
                res = await eng.finish(FAKE_UID, a["id"], t)
                render.result(c, res, "Симулянт")
                attempts += 1
                if res.passed:
                    break
                fails += 1
                nxt = c.next_item(it.id)
                assert nxt is None or await eng.status(FAKE_UID, nxt.id) == en.LOCKED
        st = await eng.stats(FAKE_UID, t)
        print(f"module {module}: {attempts} attempts, {fails} failed, lessons {st['lessons_done']}, "
              f"avg(last10) {st['avg']}, xp {st['xp']}, badges {len(st['badges'])}")
        print("next item:", st["current"].id, await eng.status(FAKE_UID, st["current"].id))
        dash = await scheduler.dashboard(eng, t)
        print("dashboard ok:", "Панель" in dash or "ученик" in dash.lower())
    finally:
        await store.delete_user_data(FAKE_UID)
        await store.close()


if __name__ == "__main__":
    mod = next((a for a in sys.argv[1:] if not a.startswith("--")), "m1")
    asyncio.run(main(mod, "--pg" in sys.argv))
