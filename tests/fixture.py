"""Build a temporary, fully 'ready' copy of the course for tests (real titles, dummy lessons)."""
import json
import shutil
import tempfile
from pathlib import Path

from bot.config import CONTENT_DIR


def dummy_lesson(l):
    lid = l["id"]
    v = {"url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "title": "t", "channel": "c", "duration": "10:00",
         "language": "ru", "why_chosen": "test", "verified_at": "2026-11-15", "status": "verified"}
    return {**l, "status": "ready", "why": "w", "eli5": "e", "terms": [{"term": "a", "def": "b"}, {"term": "c", "def": "d"}],
            "notes": ["1", "2", "3"], "ai_prompts": ["p"], "video": v,
            "questions": [{"q": f"{lid} q{n}", "options": [f"right{n}", f"w1-{n}", f"w2-{n}", f"w3-{n}"], "correct": 0,
                           "explain": "x"} for n in range(7)]}


def ready_content_dir() -> Path:
    d = Path(tempfile.mkdtemp(prefix="kurs-"))
    for f in CONTENT_DIR.glob("*.json"):
        shutil.copy(f, d / f.name)
    course = json.loads((d / "course.json").read_text(encoding="utf-8"))
    for name in course["modules"]:
        m = json.loads((d / name).read_text(encoding="utf-8"))
        for w in m["weeks"]:
            w["lessons"] = [l if l.get("status") == "ready" else dummy_lesson(l) for l in w["lessons"]]
        (d / name).write_text(json.dumps(m, ensure_ascii=False), encoding="utf-8")
    return d
