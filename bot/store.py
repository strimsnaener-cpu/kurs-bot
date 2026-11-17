"""Persistence. PgStore (Postgres via asyncpg) for production, MemoryStore for tests/simulation.

Both expose the same async interface. Writes that must not double-count
(answering a question, finishing an attempt) are atomic conditional updates.
"""
import copy
import json
from datetime import datetime
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .config import ROOT

USER_FIELDS = ("first_name", "role", "started_at", "last_active", "streak", "best_streak",
               "last_streak_day", "last_reminder_day", "idle_alert_sent")


class MemoryStore:
    def __init__(self):
        self.users: dict[int, dict] = {}
        self.progress: dict[tuple, dict] = {}
        self.attempts: dict[int, dict] = {}
        self.kv: dict[str, str] = {}
        self.projects: dict[int, dict] = {}
        self._aid = 0

    async def close(self):
        pass

    async def get_user(self, uid):
        u = self.users.get(uid)
        return dict(u) if u else None

    async def create_user(self, uid, first_name, role, now):
        self.users.setdefault(uid, {"id": uid, "first_name": first_name, "role": role, "started_at": now,
                                    "last_active": now, "streak": 0, "best_streak": 0, "last_streak_day": None,
                                    "last_reminder_day": None, "idle_alert_sent": False})
        return dict(self.users[uid])

    async def update_user(self, uid, **fields):
        assert set(fields) <= set(USER_FIELDS)
        self.users[uid].update(fields)

    async def get_student(self):
        st = await self.get_students()
        return st[0] if st else None

    async def get_students(self):
        return sorted((dict(u) for u in self.users.values() if u["role"] == "student"), key=lambda u: u["started_at"])

    async def get_progress(self, uid):
        return {k[1]: dict(v) for k, v in self.progress.items() if k[0] == uid}

    def _row(self, uid, item):
        return self.progress.setdefault((uid, item), {"watched_at": None, "passed_at": None,
                                                      "best_score": None, "manual_unlock": False})

    async def mark_watched(self, uid, item, now):
        r = self._row(uid, item)
        r["watched_at"] = r["watched_at"] or now

    async def record_result(self, uid, item, score, passed, now):
        r = self._row(uid, item)
        r["best_score"] = score if r["best_score"] is None else max(r["best_score"], score)
        if passed and not r["passed_at"]:
            r["passed_at"] = now

    async def manual_unlock(self, uid, item):
        self._row(uid, item)["manual_unlock"] = True

    async def reset_item(self, uid, item):
        self.progress.pop((uid, item), None)
        for a in self.attempts.values():
            if a["user_id"] == uid and a["item_id"] == item and a["status"] == "active":
                a["status"] = "done"

    async def active_attempt(self, uid, item):
        for a in sorted(self.attempts.values(), key=lambda a: -a["id"]):
            if a["user_id"] == uid and a["item_id"] == item and a["status"] == "active":
                return copy.deepcopy(a)
        return None

    async def create_attempt(self, uid, item, kind, questions, now):
        self._aid += 1
        self.attempts[self._aid] = {"id": self._aid, "user_id": uid, "item_id": item, "kind": kind,
                                    "questions": questions, "answers": {}, "status": "active", "score": None,
                                    "passed": None, "started_at": now, "finished_at": None}
        return copy.deepcopy(self.attempts[self._aid])

    async def get_attempt(self, aid):
        a = self.attempts.get(aid)
        return copy.deepcopy(a) if a else None

    async def answer(self, aid, qidx, opt):
        a = self.attempts.get(aid)
        if not a or a["status"] != "active" or str(qidx) in a["answers"]:
            return None
        a["answers"][str(qidx)] = opt
        return copy.deepcopy(a)

    async def finish_attempt(self, aid, score, passed, now):
        a = self.attempts.get(aid)
        if not a or a["status"] != "active":
            return False
        a.update(status="done", score=score, passed=passed, finished_at=now)
        return True

    async def recent_attempts(self, uid, limit=10):
        done = [a for a in self.attempts.values() if a["user_id"] == uid and a["status"] == "done" and a["score"] is not None]
        done.sort(key=lambda a: a["finished_at"], reverse=True)
        return [copy.deepcopy(a) for a in done[:limit]]

    async def attempts_since(self, uid, since):
        return [copy.deepcopy(a) for a in self.attempts.values()
                if a["user_id"] == uid and a["score"] is not None and a["finished_at"] >= since]

    async def kv_get(self, key):
        return self.kv.get(key)

    async def kv_set(self, key, value):
        self.kv[key] = value

    async def get_project(self, uid):
        return copy.deepcopy(self.projects.get(uid, {}))

    async def set_project(self, uid, data):
        self.projects[uid] = copy.deepcopy(data)

    async def delete_user_data(self, uid):
        self.users.pop(uid, None)
        self.projects.pop(uid, None)
        for k in [k for k in self.progress if k[0] == uid]:
            del self.progress[k]
        for k in [k for k, a in self.attempts.items() if a["user_id"] == uid]:
            del self.attempts[k]


def _clean_dsn(dsn: str) -> str:
    """asyncpg does not understand libpq's channel_binding param."""
    parts = urlsplit(dsn)
    q = [(k, v) for k, v in parse_qsl(parts.query) if k != "channel_binding"]
    return urlunsplit(parts._replace(query=urlencode(q)))


class PgStore:
    def __init__(self, pool):
        self.pool = pool

    @classmethod
    async def connect(cls, dsn: str):
        import asyncpg

        async def init(conn):
            await conn.set_type_codec("jsonb", encoder=json.dumps, decoder=json.loads, schema="pg_catalog")

        # statement_cache_size=0: required behind Neon's pgbouncer pooler
        pool = await asyncpg.create_pool(_clean_dsn(dsn), min_size=0, max_size=4,
                                         statement_cache_size=0, init=init)
        sql = (ROOT / "migrations" / "001_init.sql").read_text(encoding="utf-8")
        async with pool.acquire() as c:
            await c.execute(sql)
        return cls(pool)

    async def close(self):
        await self.pool.close()

    async def _one(self, sql, *args):
        r = await self.pool.fetchrow(sql, *args)
        return dict(r) if r else None

    async def get_user(self, uid):
        return await self._one("SELECT * FROM users WHERE id=$1", uid)

    async def create_user(self, uid, first_name, role, now):
        await self.pool.execute(
            "INSERT INTO users (id, first_name, role, started_at, last_active) VALUES ($1,$2,$3,$4,$4) "
            "ON CONFLICT (id) DO NOTHING", uid, first_name, role, now)
        return await self.get_user(uid)

    async def update_user(self, uid, **fields):
        assert set(fields) <= set(USER_FIELDS)
        cols = list(fields)
        sets = ", ".join(f"{c}=${i + 2}" for i, c in enumerate(cols))
        await self.pool.execute(f"UPDATE users SET {sets} WHERE id=$1", uid, *[fields[c] for c in cols])

    async def get_student(self):
        st = await self.get_students()
        return st[0] if st else None

    async def get_students(self):
        rows = await self.pool.fetch("SELECT * FROM users WHERE role='student' ORDER BY started_at")
        return [dict(r) for r in rows]

    async def get_progress(self, uid):
        rows = await self.pool.fetch("SELECT * FROM progress WHERE user_id=$1", uid)
        return {r["item_id"]: {k: r[k] for k in ("watched_at", "passed_at", "best_score", "manual_unlock")} for r in rows}

    async def mark_watched(self, uid, item, now):
        await self.pool.execute(
            "INSERT INTO progress (user_id, item_id, watched_at) VALUES ($1,$2,$3) "
            "ON CONFLICT (user_id, item_id) DO UPDATE SET watched_at=COALESCE(progress.watched_at, EXCLUDED.watched_at)",
            uid, item, now)

    async def record_result(self, uid, item, score, passed, now):
        await self.pool.execute(
            "INSERT INTO progress (user_id, item_id, best_score, passed_at) VALUES ($1,$2,$3,$4) "
            "ON CONFLICT (user_id, item_id) DO UPDATE SET "
            "best_score=GREATEST(COALESCE(progress.best_score, 0), EXCLUDED.best_score), "
            "passed_at=COALESCE(progress.passed_at, EXCLUDED.passed_at)",
            uid, item, score, now if passed else None)

    async def manual_unlock(self, uid, item):
        await self.pool.execute(
            "INSERT INTO progress (user_id, item_id, manual_unlock) VALUES ($1,$2,TRUE) "
            "ON CONFLICT (user_id, item_id) DO UPDATE SET manual_unlock=TRUE", uid, item)

    async def reset_item(self, uid, item):
        async with self.pool.acquire() as c, c.transaction():
            await c.execute("DELETE FROM progress WHERE user_id=$1 AND item_id=$2", uid, item)
            await c.execute("UPDATE attempts SET status='done' WHERE user_id=$1 AND item_id=$2 AND status='active'", uid, item)

    async def active_attempt(self, uid, item):
        return await self._one("SELECT * FROM attempts WHERE user_id=$1 AND item_id=$2 AND status='active' "
                               "ORDER BY id DESC LIMIT 1", uid, item)

    async def create_attempt(self, uid, item, kind, questions, now):
        return await self._one("INSERT INTO attempts (user_id, item_id, kind, questions, started_at) "
                               "VALUES ($1,$2,$3,$4,$5) RETURNING *", uid, item, kind, questions, now)

    async def get_attempt(self, aid):
        return await self._one("SELECT * FROM attempts WHERE id=$1", aid)

    async def answer(self, aid, qidx, opt):
        return await self._one(
            "UPDATE attempts SET answers = answers || jsonb_build_object($2::text, $3::int) "
            "WHERE id=$1 AND status='active' AND NOT (answers ? $2::text) RETURNING *", aid, str(qidx), opt)

    async def finish_attempt(self, aid, score, passed, now):
        r = await self.pool.fetchval("UPDATE attempts SET status='done', score=$2, passed=$3, finished_at=$4 "
                                     "WHERE id=$1 AND status='active' RETURNING id", aid, score, passed, now)
        return r is not None

    async def recent_attempts(self, uid, limit=10):
        rows = await self.pool.fetch("SELECT * FROM attempts WHERE user_id=$1 AND score IS NOT NULL "
                                     "ORDER BY finished_at DESC LIMIT $2", uid, limit)
        return [dict(r) for r in rows]

    async def attempts_since(self, uid, since: datetime):
        rows = await self.pool.fetch("SELECT * FROM attempts WHERE user_id=$1 AND score IS NOT NULL "
                                     "AND finished_at >= $2", uid, since)
        return [dict(r) for r in rows]

    async def kv_get(self, key):
        return await self.pool.fetchval("SELECT value FROM kv WHERE key=$1", key)

    async def kv_set(self, key, value):
        await self.pool.execute("INSERT INTO kv (key, value) VALUES ($1,$2) "
                                "ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", key, value)

    async def get_project(self, uid):
        v = await self.pool.fetchval("SELECT data FROM projects WHERE user_id=$1", uid)
        return v or {}

    async def set_project(self, uid, data):
        await self.pool.execute("INSERT INTO projects (user_id, data) VALUES ($1,$2) "
                                "ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data", uid, data)

    async def delete_user_data(self, uid):
        await self.pool.execute("DELETE FROM users WHERE id=$1", uid)
