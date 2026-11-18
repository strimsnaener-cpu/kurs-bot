// SQLite (node:sqlite) stand-in for Postgres. Tables mirror prisma/schema.prisma
// (User, Session, Organization, Membership, AuditLog) so the port to Prisma is 1:1.
import { DatabaseSync } from 'node:sqlite';

// Orders sell either an agent plan or an Academy membership. Snapshot columns keep what was bought,
// so later price edits never change an order.
const ordersTable = name => `CREATE TABLE IF NOT EXISTS ${name} (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  org_id TEXT NOT NULL REFERENCES organizations(id),
  product_type TEXT NOT NULL DEFAULT 'AGENT' CHECK (product_type IN ('AGENT','ACADEMY')),
  agent_id TEXT REFERENCES agents(id),
  academy_plan_id TEXT REFERENCES academy_plans(id),
  price_id TEXT NOT NULL,                                  -- prices.id or academy_prices.id
  plan_name TEXT NOT NULL, interval TEXT NOT NULL,
  amount INTEGER NOT NULL, currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','FAILED','REFUNDED','CANCELED')),
  provider TEXT NOT NULL DEFAULT 'manual', provider_ref TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  paid_at TEXT,
  CHECK ((product_type = 'AGENT' AND agent_id IS NOT NULL) OR (product_type = 'ACADEMY' AND academy_plan_id IS NOT NULL))
);`;

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER','STUDENT','SUPPORT','ADMIN')),
  email_verified_at TEXT,
  totp_secret_enc TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,               -- sha256 of the cookie token; raw token is never stored
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  ip TEXT, user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'OWNER' CHECK (role IN ('OWNER','MEMBER')),
  PRIMARY KEY (user_id, org_id)
);
CREATE TABLE IF NOT EXISTS tokens (
  hash TEXT PRIMARY KEY,             -- sha256 of the emailed token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('verify','reset')),
  expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target TEXT, meta TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,           -- matches the runtime plugin slug (Stage 5)
  name TEXT NOT NULL, tagline TEXT NOT NULL, description TEXT NOT NULL,
  category TEXT NOT NULL, icon TEXT NOT NULL DEFAULT 'chat',
  features TEXT NOT NULL DEFAULT '[]', problems TEXT NOT NULL DEFAULT '[]',
  demo TEXT NOT NULL DEFAULT '[]', install_steps TEXT NOT NULL DEFAULT '[]',
  platforms TEXT NOT NULL DEFAULT '[]',
  published INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL, features TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS prices (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  interval TEXT NOT NULL CHECK (interval IN ('ONE_TIME','MONTH','YEAR')),
  amount INTEGER NOT NULL CHECK (amount >= 0),   -- minor units (cents / kopecks)
  currency TEXT NOT NULL DEFAULT 'USD',
  active INTEGER NOT NULL DEFAULT 1
);
${ordersTable('orders')}
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id);
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (agent_id, user_id)
);
-- ---------- Stage 5: agent runtime ----------
CREATE TABLE IF NOT EXISTS installations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),    -- one installation per paid order
  name TEXT NOT NULL,
  auto_reply INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  manager_code TEXT NOT NULL, manager_chat_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS channel_connections (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('TELEGRAM','INSTAGRAM')),
  external_id TEXT NOT NULL, display_name TEXT,
  credentials_enc TEXT NOT NULL,                          -- AES-256-GCM
  webhook_secret TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'webhook' CHECK (mode IN ('webhook','polling')),
  poll_offset INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (channel, external_id)
);
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('FAQ','DOC')),
  title TEXT NOT NULL, content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id TEXT PRIMARY KEY,
  knowledge_id TEXT NOT NULL REFERENCES knowledge(id) ON DELETE CASCADE,
  installation_id TEXT NOT NULL,
  content TEXT NOT NULL, terms TEXT NOT NULL              -- search terms (JSON); pgvector embeddings in production
);
CREATE INDEX IF NOT EXISTS kc_inst ON knowledge_chunks(installation_id);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  channel TEXT NOT NULL, external_chat_id TEXT NOT NULL,
  contact_name TEXT, contact_handle TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','handoff')), handoff_reason TEXT,
  last_message_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (installation_id, channel, external_chat_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('IN','OUT')),
  author TEXT NOT NULL CHECK (author IN ('customer','agent','human')),
  text TEXT NOT NULL, external_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (conversation_id, external_id)                   -- Telegram retries can't create duplicates
);
CREATE INDEX IF NOT EXISTS msg_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  name TEXT, phone TEXT, email TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY, installation_id TEXT NOT NULL, kind TEXT NOT NULL, quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS usage_inst ON usage_records(installation_id, created_at);
CREATE TABLE IF NOT EXISTS jobs (                         -- BullMQ + Redis in production
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  attempts INTEGER NOT NULL DEFAULT 0, run_at TEXT NOT NULL, last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(status, run_at);
-- ---------- Stage 5b: Instagram ----------
CREATE TABLE IF NOT EXISTS oauth_states (
  hash TEXT PRIMARY KEY,                                   -- sha256 of the state sent to Meta
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL, used_at TEXT
);
CREATE TABLE IF NOT EXISTS deletion_requests (
  code TEXT PRIMARY KEY, external_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- ---------- Stage 6: VIP Academy ----------
CREATE TABLE IF NOT EXISTS academy_plans (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  features TEXT NOT NULL DEFAULT '[]', mentorship INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS academy_prices (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES academy_plans(id) ON DELETE CASCADE,
  interval TEXT NOT NULL CHECK (interval IN ('ONE_TIME','MONTH','YEAR')),
  amount INTEGER NOT NULL CHECK (amount >= 0), currency TEXT NOT NULL DEFAULT 'USD', active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS academy_memberships (          -- one row per paid order; access = any row with ends_at in the future
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES academy_plans(id), order_id TEXT UNIQUE REFERENCES orders(id),
  mentorship INTEGER NOT NULL DEFAULT 0, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS am_user ON academy_memberships(user_id, ends_at);
CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, summary TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', month INTEGER CHECK (month BETWEEN 1 AND 12), level TEXT NOT NULL DEFAULT 'Beginner',
  icon TEXT NOT NULL DEFAULT 'book', published INTEGER NOT NULL DEFAULT 0, sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS course_modules (
  id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY, module_id TEXT NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL, position INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'LESSON' CHECK (kind IN ('LESSON','TUTORIAL','WORKSHOP')),
  video_url TEXT, body TEXT NOT NULL DEFAULT '', duration_min INTEGER,
  materials TEXT NOT NULL DEFAULT '[]', assignment TEXT,   -- assignment = task text, NULL = none
  free_preview INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS lessons_course ON lessons(course_id);
CREATE TABLE IF NOT EXISTS lesson_progress (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL, link TEXT,
  status TEXT NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','NEEDS_WORK','APPROVED')),
  feedback TEXT, reviewed_by TEXT, reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (lesson_id, user_id)
);
CREATE TABLE IF NOT EXISTS certificates (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE, name_on_certificate TEXT NOT NULL,
  issued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), UNIQUE (user_id, course_id)
);
CREATE TABLE IF NOT EXISTS live_sessions (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'WORKSHOP' CHECK (kind IN ('WORKSHOP','QA')),
  starts_at TEXT NOT NULL, duration_min INTEGER NOT NULL DEFAULT 60,
  join_url TEXT, recording_url TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS community_posts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, body TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS community_comments (
  id TEXT PRIMARY KEY, post_id TEXT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS mentorship_requests (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic TEXT NOT NULL, message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','SCHEDULED','DONE','CANCELED')),
  scheduled_at TEXT, meeting_url TEXT, mentor_note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
-- ---------- Stage 7: operations ----------
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'ALL' CHECK (audience IN ('ALL','CUSTOMERS','STUDENTS')),
  level TEXT NOT NULL DEFAULT 'INFO' CHECK (level IN ('INFO','IMPORTANT')),
  starts_at TEXT NOT NULL, ends_at TEXT, emailed_at TEXT, created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS announcement_dismissals (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, announcement_id)
);
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'GENERAL' CHECK (category IN ('GENERAL','BILLING','TECHNICAL','ACADEMY','CUSTOM')),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PENDING','CLOSED')),   -- OPEN = waiting for us, PENDING = waiting for the customer
  access_hash TEXT NOT NULL,                                -- sha256 of the private link token (for guests)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS tickets_status ON tickets(status, updated_at);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id TEXT PRIMARY KEY, ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_user_id TEXT, from_staff INTEGER NOT NULL DEFAULT 0, body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS system_logs (
  id TEXT PRIMARY KEY, level TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, meta TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS syslog_created ON system_logs(created_at);
`;

export function openDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after a table first shipped. Safe to run on every start.
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  // Stage 6: orders can now hold Academy memberships (agent_id becomes optional). SQLite needs a table rebuild.
  if (!has('orders', 'product_type')) {
    const cols = 'id, user_id, org_id, agent_id, price_id, plan_name, interval, amount, currency, status, provider, provider_ref, created_at, paid_at';
    db.exec('PRAGMA foreign_keys = OFF; BEGIN;');
    try {
      db.exec(`${ordersTable('orders_v2')} INSERT INTO orders_v2 (${cols}, product_type) SELECT ${cols}, 'AGENT' FROM orders;
               DROP TABLE orders; ALTER TABLE orders_v2 RENAME TO orders; CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id); COMMIT;`);
    } catch (e) { db.exec('ROLLBACK'); throw e; } finally { db.exec('PRAGMA foreign_keys = ON;'); }
  }
  if (!has('users', 'suspended_at')) db.exec('ALTER TABLE users ADD COLUMN suspended_at TEXT; ALTER TABLE users ADD COLUMN suspend_reason TEXT;');
  if (!has('channel_connections', 'token_expires_at')) db.exec('ALTER TABLE channel_connections ADD COLUMN token_expires_at TEXT');
  if (!has('channel_connections', 'token_refreshed_at')) db.exec('ALTER TABLE channel_connections ADD COLUMN token_refreshed_at TEXT');
}
