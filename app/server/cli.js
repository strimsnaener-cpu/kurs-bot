// Usage: node --env-file=.env server/cli.js make-admin you@example.com
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [cmd, email] = process.argv.slice(2);
const db = openDb(process.env.DATABASE_FILE || path.join(root, 'data', 'app.db'));

if (cmd === 'make-admin' && email) {
  const r = db.prepare("UPDATE users SET role = 'ADMIN' WHERE email = ?").run(email.trim().toLowerCase());
  if (!r.changes) { console.error(`Пользователя с email ${email} нет. Сначала зарегистрируйтесь.`); process.exit(1); }
  db.prepare('INSERT INTO audit_log (id, actor_id, action, target) VALUES (?,?,?,?)').run(crypto.randomUUID(), null, 'cli.make_admin', email);
  console.log(`${email} теперь ADMIN. Войдите и включите двухфакторную аутентификацию, чтобы открыть админку.`);
} else {
  console.log('Usage: node --env-file=.env server/cli.js make-admin <email>');
  process.exit(1);
}
