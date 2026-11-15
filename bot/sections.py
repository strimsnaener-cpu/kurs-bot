"""Ungated sections: "На досуге" library, AI models cheat-sheet, project wizard."""
from html import escape as e

from aiogram.types import InlineKeyboardButton as B

from .render import kb
from .strings import t


# ---- На досуге -----------------------------------------------------------
def leisure_menu(c):
    lib = c.library
    if not lib or not lib.get("categories"):
        return t("leisure_soon"), None
    rows = [[B(text=f"{cat['emoji']} {cat['title']} ({len(cat['items'])})", callback_data=f"libc:{cat['id']}")]
            for cat in lib["categories"]]
    return t("leisure_head"), kb(rows)


def leisure_view(c, data: str):
    if data.startswith("libc:"):
        cid = data[5:]
        cat = next((x for x in (c.library or {}).get("categories", []) if x["id"] == cid), None)
        if cat:
            lines = [f"{cat['emoji']} <b>{e(cat['title'])}</b>\n"]
            rows = []
            for n, it in enumerate(cat["items"], 1):
                flag = " 🇬🇧" if it.get("language") == "en" else ""
                kind = "🎙" if it.get("kind") == "podcast" else "🎬"
                lines.append(f"{kind} <b>{n}. {e(it['title'])}</b>{flag}\n<i>{e(it['channel'])}"
                             f"{' · ' + e(it['duration']) if it.get('duration') else ''}</i>\n{e(it.get('about', ''))}")
                btns = [B(text=f"{kind} {n}", url=it["url"])]
                for extra in it.get("links", []):
                    btns.append(B(text=f"{extra['label']} {n}", url=extra["url"]))
                rows.append(btns)
            if any(it.get("language") == "en" for it in cat["items"]):
                lines.append("\n🇬🇧 — на английском: включи субтитры ⚙️ → Субтитры → Перевести → Русский.")
            rows.append([B(text=t("back"), callback_data="lib")])
            return "\n\n".join(lines), kb(rows)
    return leisure_menu(c)


# ---- Модели ИИ -----------------------------------------------------------
def models_text(c) -> str:
    m = c.ai_models
    if not m:
        return t("models_soon")
    parts = [f"🤖 <b>{e(m['title'])}</b>\n<i>{e(m['intro'])}</i>"]
    for sec in m["sections"]:
        parts.append(f"{sec['emoji']} <b>{e(sec['title'])}</b>\n" + "\n".join(f"• {e(x)}" for x in sec["items"]))
    parts.append(f"<i>Проверено: {e(m['verified_at'])}</i>")
    return "\n\n".join(parts)


# ---- Мой проект (filled in with Module 6) --------------------------------
async def project_entry(engine, user):
    return t("project_soon"), None


async def project_callback(cb, engine, user, arg):
    await cb.answer()


async def project_text(msg, engine, user) -> bool:
    return False
