"""Course engine: gating, scoring, streaks, progress stats. No Telegram code here.

Used by the Telegram handlers, the tests and the simulation script.
"""
import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .config import TZ
from .content import Content

LOCKED, OPEN, PASSED, SOON = "locked", "open", "passed", "soon"


# ---- pure helpers --------------------------------------------------------
def score_attempt(attempt: dict) -> tuple[int, int, int]:
    """(score 0..100, correct, total). Computed only from the stored snapshot."""
    qs = attempt["questions"]
    ans = attempt["answers"]
    correct = sum(1 for i, q in enumerate(qs) if ans.get(str(i)) == q["correct"])
    total = len(qs)
    return (round(100 * correct / total) if total else 0), correct, total


def is_unlocked(content: Content, progress: dict, item_id: str) -> bool:
    if progress.get(item_id, {}).get("manual_unlock"):
        return True
    prev = content.prev_item(item_id)
    return prev is None or bool(progress.get(prev.id, {}).get("passed_at"))


def item_status(content: Content, progress: dict, item_id: str) -> str:
    if progress.get(item_id, {}).get("passed_at"):
        return PASSED
    if not is_unlocked(content, progress, item_id):
        return LOCKED
    return OPEN if content.item_ready(item_id) else SOON


def current_item(content: Content, progress: dict):
    """The first item that is not passed yet (where 'Continue' leads)."""
    for it in content.items:
        if not progress.get(it.id, {}).get("passed_at"):
            return it
    return None


def lessons_passed(content: Content, progress: dict) -> int:
    return sum(1 for lid in content.lesson_ids if progress.get(lid, {}).get("passed_at"))


def percent_done(content: Content, progress: dict) -> int:
    done = sum(1 for it in content.items if progress.get(it.id, {}).get("passed_at"))
    return round(100 * done / len(content.items))


def progress_bar(pct: int, width: int = 10) -> str:
    filled = round(width * pct / 100)
    return "▰" * filled + "▱" * (width - filled) + f" {pct}%"


def recommended_lessons(content: Content, started_at: datetime, now: datetime) -> int:
    days = max(0, (now - started_at).total_seconds() / 86400)
    per_week = content.course.get("pace_lessons_per_week", 5)
    return min(len(content.lesson_ids), int(days / 7 * per_week) + 1)


def xp(progress: dict) -> int:
    return sum(r["best_score"] or 0 for r in progress.values() if r.get("passed_at"))


def kyiv_day(now: datetime):
    return now.astimezone(TZ).date()


def week_done(content, progress, week_id) -> bool:
    return bool(progress.get(week_id + "t", {}).get("passed_at"))


def module_done(content, progress, module_id) -> bool:
    return bool(progress.get(module_id + "t", {}).get("passed_at"))


def badges(content: Content, progress: dict, user: dict) -> list[str]:
    out = []
    for m in content.modules:
        for w in m["weeks"]:
            if week_done(content, progress, w["id"]):
                out.append(f"🏅 Неделя «{w['title']}»")
        if module_done(content, progress, m["id"]):
            out.append(f"🏆 Месяц «{m['title']}»")
    if progress.get("final", {}).get("passed_at"):
        out.append("🎓 Выпускник курса")
    if user.get("best_streak", 0) >= 7:
        out.append("🔥 Серия 7 дней")
    if user.get("best_streak", 0) >= 30:
        out.append("🌋 Серия 30 дней")
    return out


@dataclass
class QuizResult:
    attempt: dict
    item_id: str
    kind: str
    score: int
    correct: int
    total: int
    passed: bool
    first_pass: bool
    missed_lessons: list = field(default_factory=list)   # lesson ids with wrong answers
    by_week: dict = field(default_factory=dict)          # week_id -> (correct, total)
    week_completed: str | None = None
    module_completed: str | None = None


class Engine:
    def __init__(self, content: Content, store, rng: random.Random | None = None):
        self.c = content
        self.s = store
        self.rng = rng or random.Random()

    async def touch(self, uid: int, now: datetime):
        await self.s.update_user(uid, last_active=now, idle_alert_sent=False)

    async def status(self, uid, item_id) -> str:
        return item_status(self.c, await self.s.get_progress(uid), item_id)

    async def can_open(self, uid, item_id) -> tuple[bool, str]:
        if item_id not in self.c.by_id:
            return False, "unknown"
        st = await self.status(uid, item_id)
        if st == LOCKED:
            return False, LOCKED
        if st == SOON:
            return False, SOON
        return True, st

    async def mark_watched(self, uid, lid, now):
        ok, why = await self.can_open(uid, lid)
        if not ok or self.c.by_id[lid].kind != "lesson":
            return False
        await self.s.mark_watched(uid, lid, now)
        return True

    async def start_quiz(self, uid, item_id, now) -> tuple[dict | None, str]:
        """Return (attempt, '') or (None, reason). Resumes an unfinished attempt (double-tap safe)."""
        ok, why = await self.can_open(uid, item_id)
        if not ok:
            return None, why
        it = self.c.by_id[item_id]
        if it.kind == "lesson":
            prog = await self.s.get_progress(uid)
            if not prog.get(item_id, {}).get("watched_at"):
                return None, "not_watched"
        active = await self.s.active_attempt(uid, item_id)
        if active:
            return active, ""
        qs = self.c.select_questions(item_id, self.rng)
        return await self.s.create_attempt(uid, item_id, it.kind, qs, now), ""

    async def answer(self, uid, aid, qidx, opt):
        """Record one answer. Returns (attempt, is_correct) or (None, None) if rejected/duplicate."""
        a = await self.s.get_attempt(aid)
        if not a or a["user_id"] != uid or a["status"] != "active":
            return None, None
        if qidx != len(a["answers"]) or not 0 <= qidx < len(a["questions"]):
            return None, None
        if not 0 <= opt < len(a["questions"][qidx]["options"]):
            return None, None
        a = await self.s.answer(aid, qidx, opt)
        if not a:
            return None, None
        return a, a["questions"][qidx]["correct"] == opt

    async def finish(self, uid, aid, now) -> QuizResult | None:
        a = await self.s.get_attempt(aid)
        if not a or a["user_id"] != uid or a["status"] != "active" or len(a["answers"]) < len(a["questions"]):
            return None
        score, correct, total = score_attempt(a)
        passed = score >= self.c.pass_marks[a["kind"]]
        if not await self.s.finish_attempt(aid, score, passed, now):
            return None          # already finished by a concurrent tap
        before = await self.s.get_progress(uid)
        first_pass = passed and not before.get(a["item_id"], {}).get("passed_at")
        await self.s.record_result(uid, a["item_id"], score, passed, now)
        await self._bump_streak(uid, now)
        res = QuizResult(a, a["item_id"], a["kind"], score, correct, total, passed, first_pass)
        for i, q in enumerate(a["questions"]):
            wk = self.c.by_id[q["lid"]].week_id
            c, t = res.by_week.get(wk, (0, 0))
            ok = a["answers"].get(str(i)) == q["correct"]
            res.by_week[wk] = (c + ok, t + 1)
            if not ok and q["lid"] not in res.missed_lessons:
                res.missed_lessons.append(q["lid"])
        if first_pass and a["kind"] == "week":
            res.week_completed = self.c.by_id[a["item_id"]].week_id
        if first_pass and a["kind"] == "month":
            res.module_completed = self.c.by_id[a["item_id"]].module_id
        return res

    async def _bump_streak(self, uid, now):
        u = await self.s.get_user(uid)
        today = kyiv_day(now)
        last = u.get("last_streak_day")
        if last == today:
            return
        streak = u["streak"] + 1 if last == today - timedelta(days=1) else 1
        await self.s.update_user(uid, streak=streak, best_streak=max(streak, u["best_streak"]), last_streak_day=today)

    async def stats(self, uid, now) -> dict:
        u = await self.s.get_user(uid)
        prog = await self.s.get_progress(uid)
        cur = current_item(self.c, prog)
        done = lessons_passed(self.c, prog)
        rec = recommended_lessons(self.c, u["started_at"], now)
        streak = u["streak"] if u.get("last_streak_day") and kyiv_day(now) - u["last_streak_day"] <= timedelta(days=1) else 0
        recent = await self.s.recent_attempts(uid, 10)
        scores = [a["score"] for a in recent]
        return {"user": u, "progress": prog, "current": cur, "lessons_done": done, "recommended": rec,
                "ahead": done - rec, "percent": percent_done(self.c, prog), "xp": xp(prog), "streak": streak,
                "recent": recent, "avg": round(sum(scores) / len(scores)) if scores else None,
                "failed": sum(1 for a in recent if not a["passed"]), "badges": badges(self.c, prog, u)}
