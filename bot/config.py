"""Runtime configuration. Secrets come only from environment variables (or a local .env)."""
import os
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
CONTENT_DIR = ROOT / "content"


def _load_dotenv() -> None:
    env = ROOT / ".env"
    if not env.exists():
        return
    for line in env.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()


def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


BOT_TOKEN = _env("BOT_TOKEN")
ADMIN_ID = int(_env("ADMIN_ID", "0") or 0)
DATABASE_URL = _env("DATABASE_URL")
WEBHOOK_SECRET = _env("WEBHOOK_SECRET")
TICK_SECRET = _env("TICK_SECRET")
INVITE_CODE = _env("INVITE_CODE")
TEST_MODE = _env("TEST_MODE", "0").lower() in ("1", "true", "yes")
PUBLIC_URL = (_env("PUBLIC_URL") or _env("RENDER_EXTERNAL_URL")).rstrip("/")
PORT = int(_env("PORT", "10000"))

TZ = ZoneInfo("Europe/Kyiv")
QUIET_FROM, QUIET_TO = 21, 9          # no reminders 21:00-09:00 Kyiv time
REMIND_AFTER_DAYS = 2                 # remind the student after 2 idle days
ADMIN_IDLE_ALERT_DAYS = 3             # alert the admin after 3 idle days
DIGEST_WEEKDAY, DIGEST_HOUR = 6, 19   # Sunday 19:00 Kyiv
