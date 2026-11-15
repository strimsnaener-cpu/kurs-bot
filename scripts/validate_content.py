"""Validate content/*.json against the course schema. Exit code 1 on problems."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from bot.content import Content, validate  # noqa: E402

c = Content()
errs = validate(c)
ready = sum(1 for lid in c.lesson_ids if c.lesson_ready(lid))
unverified = [lid for lid in c.lesson_ids if c.lesson_ready(lid) and c.lessons[lid]["video"]["status"] != "verified"]
print(f"lessons ready: {ready}/{len(c.lesson_ids)}; unverified videos: {len(unverified)}")
for e in errs:
    print("ERROR:", e)
sys.exit(1 if errs else 0)
