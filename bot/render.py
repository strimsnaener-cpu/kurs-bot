"""Turn content + progress into Telegram HTML text and inline keyboards."""
from html import escape as e

from aiogram.types import InlineKeyboardButton as B, InlineKeyboardMarkup as KB

from . import engine as en
from .content import Content
from .strings import t

MARK = {en.PASSED: "✅", en.OPEN: "▶️", en.LOCKED: "🔒", en.SOON: "⏳"}


def kb(rows) -> KB:
    return KB(inline_keyboard=[r for r in rows if r])


def lesson_number(c: Content, lid: str) -> int:
    return c.lesson_ids.index(lid) + 1


def mw(c: Content, item) -> tuple[int, int]:
    m = [x["id"] for x in c.modules].index(item.module_id) + 1
    w = int(item.week_id.split("w")[1]) if item.week_id else 0
    return m, w


def course_map(c: Content, prog: dict):
    rows = []
    for n, m in enumerate(c.modules, 1):
        st = en.item_status(c, prog, m["id"] + "t")
        first = en.item_status(c, prog, m["weeks"][0]["lessons"][0]["id"])
        mark = "✅" if st == en.PASSED else ("🔒" if first == en.LOCKED else ("⏳" if first == en.SOON else "▶️"))
        rows.append([B(text=f"{mark} {m['emoji']} {n}. {m['title']}", callback_data=f"m:{m['id']}")])
    return t("map_title", bar=en.progress_bar(en.percent_done(c, prog))), kb(rows)


def module_view(c: Content, prog: dict, mid: str):
    m = c.module_by_id[mid]
    n = [x["id"] for x in c.modules].index(mid) + 1
    rows = []
    for wn, w in enumerate(m["weeks"], 1):
        st = en.item_status(c, prog, w["id"] + "t")
        first = en.item_status(c, prog, w["lessons"][0]["id"])
        mark = "✅" if st == en.PASSED else MARK[first if first != en.PASSED else en.OPEN]
        rows.append([B(text=f"{mark} Неделя {wn}. {w['title']}", callback_data=f"w:{w['id']}")])
    tid = mid + "t"
    rows.append([B(text=f"{MARK[en.item_status(c, prog, tid)]} 🏁 Тест месяца", callback_data=f"o:{tid}")])
    rows.append([B(text=t("back"), callback_data="map")])
    return t("module_title", emoji=m["emoji"], n=n, title=e(m["title"])), kb(rows)


def week_view(c: Content, prog: dict, wid: str):
    w = c.weeks[wid]
    wn = int(wid.split("w")[1])
    rows = []
    for l in w["lessons"]:
        st = en.item_status(c, prog, l["id"])
        rows.append([B(text=f"{MARK[st]} {lesson_number(c, l['id'])}. {l['title']}", callback_data=f"o:{l['id']}")])
    tid = wid + "t"
    rows.append([B(text=f"{MARK[en.item_status(c, prog, tid)]} 📝 Тест недели", callback_data=f"o:{tid}")])
    rows.append([B(text=t("back"), callback_data=f"m:{c.by_id[tid].module_id}")])
    return t("week_title", n=wn, title=e(w["title"])), kb(rows)


def lesson_card(c: Content, prog: dict, lid: str):
    it = c.by_id[lid]
    l = it.lesson
    m, w = mw(c, it)
    p = prog.get(lid, {})
    v = l["video"]
    parts = [t("lesson_head", num=lesson_number(c, lid), title=e(l["title"]), m=m, w=w),
             t("why", text=e(l["why"])),
             t("eli5", text=e(l["eli5"])),
             t("terms") + "\n" + "\n".join(f"• <b>{e(x['term'])}</b> — {e(x['def'])}" for x in l["terms"]),
             t("video", title=e(v["title"]), channel=e(v["channel"]), duration=e(v["duration"]))]
    if v.get("needs_subtitles"):
        parts.append(t("subs"))
    parts.append(t("notes") + "\n" + "\n".join(f"{n}. {e(x)}" for n, x in enumerate(l["notes"], 1)))
    parts.append(t("ask_ai") + "\n" + "\n".join(f"<code>{e(x)}</code>" for x in l["ai_prompts"]))
    if l.get("money"):
        parts.append(t("money", text=e(l["money"])))
    if p.get("passed_at"):
        parts.append(t("passed_mark", score=p.get("best_score")))
    rows = [[B(text=t("btn_video"), url=v["url"])]]
    if l.get("alt_video"):
        rows[0].append(B(text=t("btn_alt"), url=l["alt_video"]["url"]))
    if not p.get("watched_at"):
        rows.append([B(text=t("btn_watched"), callback_data=f"wv:{lid}")])
    elif not p.get("passed_at"):
        rows.append([B(text=t("btn_quiz"), callback_data=f"qs:{lid}")])
    else:
        rows.append([B(text=t("btn_retake"), callback_data=f"qs:{lid}")])
        rows.append([B(text=t("btn_next"), callback_data="go")])
    rows.append([B(text=t("to_map"), callback_data=f"w:{it.week_id}")])
    return "\n\n".join(parts), kb(rows)


def test_intro(c: Content, prog: dict, item_id: str):
    it = c.by_id[item_id]
    p = prog.get(item_id, {})
    text = t("quiz_start", title=e(it.title), n=c.counts[it.kind], need=c.pass_marks[it.kind])
    if p.get("passed_at"):
        text += "\n\n" + t("passed_mark", score=p.get("best_score"))
    rows = [[B(text=t("btn_retake") if p.get("passed_at") else t("btn_quiz"), callback_data=f"qs:{item_id}")]]
    if p.get("passed_at") and c.next_item(item_id):
        rows.append([B(text="➡️ Дальше", callback_data="go")])
    back = f"w:{it.week_id}" if it.kind == "week" else (f"m:{it.module_id}" if it.kind == "month" else "map")
    rows.append([B(text=t("back"), callback_data=back)])
    return text, kb(rows)


LETTERS = "ABCD"


def question(a: dict):
    i = len(a["answers"])
    q = a["questions"][i]
    text = t("q_head", i=i + 1, n=len(a["questions"]), q=e(q["q"]))
    text += "\n" + "\n".join(f"<b>{LETTERS[n]})</b> {e(o)}" for n, o in enumerate(q["options"]))
    row = [B(text=LETTERS[n], callback_data=f"qa:{a['id']}:{i}:{n}") for n in range(len(q["options"]))]
    return text, kb([row])


def feedback(a: dict, qidx: int, correct: bool):
    q = a["questions"][qidx]
    chosen = a["answers"][str(qidx)]
    text = t("q_head", i=qidx + 1, n=len(a["questions"]), q=e(q["q"]))
    text += f"\nТвой ответ: <b>{LETTERS[chosen]}) {e(q['options'][chosen])}</b>\n\n"
    text += t("right") if correct else t("wrong", ans=f"{LETTERS[q['correct']]}) {e(q['options'][q['correct']])}")
    if q.get("explain"):
        text += f"\n💬 {e(q['explain'])}"
    last = len(a["answers"]) >= len(a["questions"])
    btn = B(text=t("btn_result") if last else t("btn_nextq"), callback_data=f"qn:{a['id']}")
    return text, kb([[btn]])


def result(c: Content, res: en.QuizResult, name: str, stats: dict | None = None):
    it = c.by_id[res.item_id]
    need = c.pass_marks[res.kind]
    rows = []
    if res.passed:
        text = t("res_pass", score=res.score, c=res.correct, t=res.total, bar=en.progress_bar(res.score))
    else:
        text = t("res_fail", score=res.score, c=res.correct, t=res.total, need=need)
    if res.kind in ("month", "final") and res.by_week:
        strong = [c.weeks[w]["title"] for w, (ok, tot) in res.by_week.items() if ok / tot >= 0.75]
        weak = [c.weeks[w]["title"] for w, (ok, tot) in res.by_week.items() if ok / tot < 0.5]
        if strong:
            text += "\n\n" + t("res_strong", text=e(", ".join(strong)))
        if weak:
            text += "\n" + t("res_weak", text=e(", ".join(weak)))
    if res.week_completed:
        text += "\n\n" + t("week_done")
    if res.module_completed:
        text += "\n\n" + t("module_done", title=e(c.module_by_id[res.module_completed]["title"]))
    if res.kind == "final" and res.passed and stats:
        text += "\n\n" + t("final_done", name=e(name), score=res.score, lessons=stats["lessons_done"],
                           streak=stats["user"]["best_streak"], xp=stats["xp"])
    if res.passed:
        if c.next_item(res.item_id):
            rows.append([B(text=t("btn_next") if res.kind == "lesson" else "➡️ Дальше", callback_data="go")])
    else:
        if res.kind == "lesson":
            l = it.lesson
            rows.append([B(text=t("btn_video"), url=l["video"]["url"])])
            if l.get("alt_video"):
                rows[-1].append(B(text=t("btn_alt"), url=l["alt_video"]["url"]))
            rows.append([B(text=t("btn_eli5"), callback_data=f"el:{it.id}")])
        else:
            text += "\n\n" + t("res_week_fail")
            for lid in res.missed_lessons[:8]:
                rows.append([B(text=f"📖 {lesson_number(c, lid)}. {c.lessons[lid]['title']}", callback_data=f"o:{lid}")])
        rows.append([B(text=t("btn_retake"), callback_data=f"qs:{res.item_id}")])
    return text, kb(rows)


def progress_text(c: Content, st: dict) -> str:
    cur = st["current"]
    cur_t = e(cur.title) if cur else "курс пройден 🎓"
    b = st["badges"]
    badges = (t("badges_head") + "\n".join(b)) if b else t("no_badges")
    return t("progress", bar=en.progress_bar(st["percent"]), done=st["lessons_done"], total=len(c.lesson_ids),
             current=cur_t, streak=st["streak"], best=st["user"]["best_streak"], xp=st["xp"],
             avg=st["avg"] if st["avg"] is not None else "—", badges=badges)
