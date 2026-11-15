"""Course content: loading, schema validation, the ordered item chain and question selection.

The course is pure data (content/*.json). The bot only renders it.
Item chain: m1w1l1..m1w1l5, m1w1t, ..., m1w4t, m1t, m2w1l1, ..., m6t, final.
"""
import json
import random
import re
from dataclasses import dataclass, field
from pathlib import Path

from .config import CONTENT_DIR

KINDS = ("lesson", "week", "month", "final")
URL_RE = re.compile(r"^https://(www\.)?(youtube\.com/watch\?v=[\w-]{11}|youtu\.be/[\w-]{11})")


@dataclass
class Item:
    id: str
    kind: str                 # lesson | week | month | final
    title: str
    module_id: str
    week_id: str = ""
    lesson: dict | None = None
    sources: list = field(default_factory=list)   # lesson ids feeding a test

    @property
    def is_test(self) -> bool:
        return self.kind != "lesson"


class Content:
    def __init__(self, directory: Path = CONTENT_DIR):
        self.dir = Path(directory)
        self.course = json.loads((self.dir / "course.json").read_text(encoding="utf-8"))
        self.modules = [json.loads((self.dir / f).read_text(encoding="utf-8")) for f in self.course["modules"]]
        self.pass_marks = self.course["pass_marks"]
        self.counts = self.course["question_counts"]
        self.items: list[Item] = []
        self.weeks: dict[str, dict] = {}
        self.module_by_id: dict[str, dict] = {}
        for m in self.modules:
            self.module_by_id[m["id"]] = m
            m_lessons = []
            for w in m["weeks"]:
                self.weeks[w["id"]] = w
                w_lessons = []
                for l in w["lessons"]:
                    self.items.append(Item(l["id"], "lesson", l["title"], m["id"], w["id"], lesson=l))
                    w_lessons.append(l["id"])
                self.items.append(Item(w["id"] + "t", "week", f"Тест недели: {w['title']}", m["id"], w["id"], sources=w_lessons))
                m_lessons += w_lessons
            self.items.append(Item(m["id"] + "t", "month", f"Тест месяца: {m['title']}", m["id"], sources=m_lessons))
        self.items.append(Item("final", "final", "Финальный экзамен", "", sources=[i.id for i in self.items if i.kind == "lesson"]))
        self.index = {it.id: n for n, it in enumerate(self.items)}
        self.by_id = {it.id: it for it in self.items}
        self.lessons = {it.id: it.lesson for it in self.items if it.kind == "lesson"}
        self.lesson_ids = [it.id for it in self.items if it.kind == "lesson"]
        self.library = self._optional("library.json")
        self.ai_models = self._optional("ai_models.json")

    def _optional(self, name):
        p = self.dir / name
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    # ---- readiness -------------------------------------------------------
    def lesson_ready(self, lid: str) -> bool:
        return self.lessons[lid].get("status") == "ready"

    def item_ready(self, item_id: str) -> bool:
        it = self.by_id[item_id]
        if it.kind == "lesson":
            return self.lesson_ready(it.id)
        return all(self.lesson_ready(s) for s in it.sources)

    def next_item(self, item_id: str) -> Item | None:
        n = self.index[item_id] + 1
        return self.items[n] if n < len(self.items) else None

    def prev_item(self, item_id: str) -> Item | None:
        n = self.index[item_id] - 1
        return self.items[n] if n >= 0 else None

    def week_of(self, lid: str) -> dict:
        return self.weeks[self.by_id[lid].week_id]

    # ---- questions -------------------------------------------------------
    def select_questions(self, item_id: str, rng: random.Random | None = None) -> list[dict]:
        """Pick questions for an attempt and shuffle their options.

        Returns snapshots: {lid, q, options, correct, explain} so scoring never depends
        on later content edits.
        """
        rng = rng or random.Random()
        it = self.by_id[item_id]
        n = self.counts[it.kind]
        if it.kind == "lesson":
            bank = [(it.id, q) for q in it.lesson["questions"]]
            picked = rng.sample(bank, min(n, len(bank)))
        elif it.kind == "final":
            picked = []
            per = n // len(self.modules)
            for m in self.modules:
                lids = [l["id"] for w in m["weeks"] for l in w["lessons"]]
                picked += self._round_robin(lids, per, rng)
            rng.shuffle(picked)
        else:
            picked = self._round_robin(it.sources, n, rng)
            rng.shuffle(picked)
        return [self._snapshot(lid, q, rng) for lid, q in picked]

    def _round_robin(self, lids: list[str], n: int, rng: random.Random) -> list:
        pools = []
        for lid in lids:
            qs = list(self.lessons[lid].get("questions", []))
            rng.shuffle(qs)
            pools.append([(lid, q) for q in qs])
        rng.shuffle(pools)
        out = []
        while len(out) < n and any(pools):
            for pool in pools:
                if pool and len(out) < n:
                    out.append(pool.pop())
        return out

    @staticmethod
    def _snapshot(lid: str, q: dict, rng: random.Random) -> dict:
        order = list(range(len(q["options"])))
        rng.shuffle(order)
        return {"lid": lid, "q": q["q"], "options": [q["options"][i] for i in order],
                "correct": order.index(q["correct"]), "explain": q.get("explain", "")}


# ---- schema validation ---------------------------------------------------
def validate(content: Content) -> list[str]:
    """Return a list of human-readable problems (empty = OK)."""
    errs: list[str] = []
    seen = set()
    for k in KINDS:
        if k not in content.pass_marks or k not in content.counts:
            errs.append(f"course.json: missing pass mark / count for {k}")
    if len(content.modules) != 6:
        errs.append(f"expected 6 modules, found {len(content.modules)}")
    for m in content.modules:
        if len(m.get("weeks", [])) != 4:
            errs.append(f"{m.get('id')}: expected 4 weeks")
        for w in m.get("weeks", []):
            if len(w.get("lessons", [])) != 5:
                errs.append(f"{w.get('id')}: expected 5 lessons")
            for l in w.get("lessons", []):
                lid = l.get("id", "?")
                if lid in seen:
                    errs.append(f"duplicate id {lid}")
                seen.add(lid)
                if not l.get("title"):
                    errs.append(f"{lid}: no title")
                if l.get("status") == "ready":
                    errs += _validate_lesson(l, content.counts["lesson"])
                elif l.get("status") != "outline":
                    errs.append(f"{lid}: status must be 'ready' or 'outline'")
    total = sum(1 for i in content.items if i.kind == "lesson")
    if total != 120:
        errs.append(f"expected 120 lessons, found {total}")
    if content.library:
        errs += _validate_library(content.library)
    return errs


def _validate_video(v: dict, where: str) -> list[str]:
    errs = []
    for f in ("url", "title", "channel", "duration", "language", "why_chosen", "verified_at", "status"):
        if not v.get(f):
            errs.append(f"{where}: video.{f} missing")
    if v.get("url") and not URL_RE.match(v["url"]):
        errs.append(f"{where}: bad YouTube url {v['url']}")
    if v.get("status") not in ("verified", "unverified"):
        errs.append(f"{where}: video.status must be verified/unverified")
    return errs


def _validate_lesson(l: dict, min_q: int) -> list[str]:
    lid = l["id"]
    errs = []
    for f in ("why", "eli5"):
        if not l.get(f):
            errs.append(f"{lid}: {f} missing")
    if not 2 <= len(l.get("terms", [])) <= 5:
        errs.append(f"{lid}: need 2-5 terms")
    if len(l.get("notes", [])) != 3:
        errs.append(f"{lid}: need exactly 3 notes prompts")
    if not 1 <= len(l.get("ai_prompts", [])) <= 2:
        errs.append(f"{lid}: need 1-2 ai_prompts")
    v = l.get("video")
    if not v:
        errs.append(f"{lid}: video missing")
    else:
        errs += _validate_video(v, lid)
    if l.get("alt_video"):
        errs += _validate_video(l["alt_video"], lid + " alt")
    qs = l.get("questions", [])
    if not max(6, min_q) <= len(qs) <= 8:
        errs.append(f"{lid}: need 6-8 questions, found {len(qs)}")
    for n, q in enumerate(qs):
        opts = q.get("options", [])
        if not q.get("q") or len(opts) != 4 or len(set(opts)) != 4:
            errs.append(f"{lid} q{n}: need text and 4 distinct options")
        if not isinstance(q.get("correct"), int) or not 0 <= q["correct"] < 4:
            errs.append(f"{lid} q{n}: correct must be 0..3")
        if not q.get("explain"):
            errs.append(f"{lid} q{n}: explain missing")
    return errs


def _validate_library(lib: dict) -> list[str]:
    errs = []
    for c in lib.get("categories", []):
        for e in c.get("items", []):
            where = f"library/{c.get('id')}/{e.get('title', '?')}"
            for f in ("url", "title", "channel", "language", "verified_at"):
                if not e.get(f):
                    errs.append(f"{where}: {f} missing")
    return errs
