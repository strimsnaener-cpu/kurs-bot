-- Course bot schema. Applied automatically on start (idempotent).
CREATE TABLE IF NOT EXISTS users (
    id                BIGINT PRIMARY KEY,          -- Telegram user id
    first_name        TEXT NOT NULL DEFAULT '',
    role              TEXT NOT NULL,               -- 'student' | 'admin'
    started_at        TIMESTAMPTZ NOT NULL,        -- course start = first /start
    last_active       TIMESTAMPTZ NOT NULL,
    streak            INT NOT NULL DEFAULT 0,
    best_streak       INT NOT NULL DEFAULT 0,
    last_streak_day   DATE,
    last_reminder_day DATE,
    idle_alert_sent   BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS progress (
    user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id       TEXT NOT NULL,
    watched_at    TIMESTAMPTZ,
    passed_at     TIMESTAMPTZ,
    best_score    INT,
    manual_unlock BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (user_id, item_id)
);

CREATE TABLE IF NOT EXISTS attempts (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    item_id     TEXT NOT NULL,
    kind        TEXT NOT NULL,
    questions   JSONB NOT NULL,                    -- snapshot of asked questions
    answers     JSONB NOT NULL DEFAULT '{}'::jsonb,
    status      TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'done'
    score       INT,
    passed      BOOLEAN,
    started_at  TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS attempts_user_idx ON attempts (user_id, finished_at DESC);

CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data    JSONB NOT NULL DEFAULT '{}'::jsonb
);
