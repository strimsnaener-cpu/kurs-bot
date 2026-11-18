import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { totp } from '../server/auth.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let server, base, db;

before(async () => {
  db = openDb(':memory:');
  const app = createApp({ db, encryptionKey: crypto.randomBytes(32).toString('base64'), publicDir: path.join(root, 'public') });
  server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// Tiny client with its own cookie jar.
function client() {
  let cookie = '';
  return async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';'); cookie = kv.endsWith('=') ? '' : kv;
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
}
const lastEmailTo = (to, subject) => db.prepare('SELECT * FROM outbox WHERE to_email = ? AND subject = ? ORDER BY created_at DESC, rowid DESC').get(to, subject);
const tokenFrom = mail => mail.body.match(/token=([\w-]+)/)[1];
let n = 0;
const fresh = () => ({ email: `user${++n}@example.com`, name: `User ${n}`, password: 'correct-horse-battery' });

test('register creates user, workspace and session; validates input', async () => {
  const c = client(), u = fresh();
  const r = await c('POST', '/api/auth/register', { ...u, email: u.email.toUpperCase() });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.email, u.email);
  assert.equal(r.body.user.role, 'USER');
  assert.equal(r.body.user.emailVerified, false);
  assert.match(r.headers.get('set-cookie'), /HttpOnly; SameSite=Lax/);
  const me = await c('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.organizations.length, 1);
  assert.equal(me.body.organizations[0].role, 'OWNER');

  assert.equal((await client()('POST', '/api/auth/register', u)).status, 409);
  assert.equal((await client()('POST', '/api/auth/register', { ...fresh(), password: 'short' })).status, 400);
  assert.equal((await client()('POST', '/api/auth/register', { ...fresh(), email: 'not-an-email' })).status, 400);
  assert.equal((await client()('POST', '/api/auth/register', { ...fresh(), name: '' })).status, 400);
});

test('secrets are never stored in plain text', async () => {
  const c = client(), u = fresh();
  await c('POST', '/api/auth/register', u);
  const row = db.prepare('SELECT password_hash FROM users WHERE email = ?').get(u.email);
  assert.ok(row.password_hash.startsWith('scrypt$'));
  assert.ok(!row.password_hash.includes(u.password));
  const s = db.prepare('SELECT s.id FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ?').get(u.email);
  assert.match(s.id, /^[a-f0-9]{64}$/); // sha256, not the cookie value
});

test('email verification works once', async () => {
  const c = client(), u = fresh();
  await c('POST', '/api/auth/register', u);
  const token = tokenFrom(lastEmailTo(u.email, 'Подтвердите email'));
  assert.equal((await client()('POST', '/api/auth/verify-email', { token })).status, 200);
  assert.equal((await c('GET', '/api/me')).body.user.emailVerified, true);
  assert.equal((await client()('POST', '/api/auth/verify-email', { token })).status, 400);
  assert.equal((await c('POST', '/api/auth/resend-verification', {})).status, 400);
});

test('logout, login, wrong password, rate limiting', async () => {
  const c = client(), u = fresh();
  await c('POST', '/api/auth/register', u);
  assert.equal((await c('POST', '/api/auth/logout', {})).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 401);
  const bad = await c('POST', '/api/auth/login', { email: u.email, password: 'wrong-password!' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'Неверный email или пароль');
  const unknown = await c('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'whatever-123' });
  assert.equal(unknown.body.error, bad.body.error); // no account enumeration
  assert.equal((await c('POST', '/api/auth/login', { email: u.email, password: u.password })).status, 200);
  assert.equal((await c('GET', '/api/me')).status, 200);

  const v = fresh(); await client()('POST', '/api/auth/register', v);
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await client()('POST', '/api/auth/login', { email: v.email, password: 'nope-nope-nope' })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.equal(statuses[10], 429);
  assert.equal((await client()('POST', '/api/auth/login', { email: v.email, password: v.password })).status, 429);
});

test('password reset: neutral response, single-use token, logs out other sessions', async () => {
  const c = client(), u = fresh();
  await c('POST', '/api/auth/register', u);
  const unknown = await client()('POST', '/api/auth/request-password-reset', { email: 'ghost@example.com' });
  const known = await client()('POST', '/api/auth/request-password-reset', { email: u.email });
  assert.deepEqual(unknown.body, known.body);
  const token = tokenFrom(lastEmailTo(u.email, 'Сброс пароля'));
  assert.equal((await client()('POST', '/api/auth/reset-password', { token, password: 'short' })).status, 400);
  assert.equal((await client()('POST', '/api/auth/reset-password', { token, password: 'brand-new-password-1' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/reset-password', { token, password: 'another-password-2' })).status, 400);
  assert.equal((await c('GET', '/api/me')).status, 401);
  assert.equal((await client()('POST', '/api/auth/login', { email: u.email, password: u.password })).status, 401);
  assert.equal((await client()('POST', '/api/auth/login', { email: u.email, password: 'brand-new-password-1' })).status, 200);
});

test('RBAC: admin panel needs ADMIN role and 2FA; TOTP blocks replays', async () => {
  const admin = client(), a = fresh(), other = client(), o = fresh();
  await admin('POST', '/api/auth/register', a);
  const oid = (await other('POST', '/api/auth/register', o)).body.user.id;

  assert.equal((await other('GET', '/api/admin/users')).status, 403);
  db.prepare("UPDATE users SET role = 'ADMIN' WHERE email = ?").run(a.email); // what cli.js make-admin does
  const no2fa = await admin('GET', '/api/admin/users');
  assert.equal(no2fa.status, 403);
  assert.match(no2fa.body.error, /двухфакторн/);

  const { secret } = (await admin('POST', '/api/account/2fa/setup', {})).body;
  const stored = db.prepare('SELECT totp_secret_enc FROM users WHERE email = ?').get(a.email).totp_secret_enc;
  assert.ok(!stored.includes(secret)); // encrypted at rest
  assert.equal((await admin('POST', '/api/account/2fa/enable', { code: '000000' })).status, 401);
  const code = totp(secret);
  assert.equal((await admin('POST', '/api/account/2fa/enable', { code })).status, 200);

  // Login now needs a code, and the same code can't be used twice.
  const fresh2 = client();
  const step1 = await fresh2('POST', '/api/auth/login', { email: a.email, password: a.password });
  assert.equal(step1.status, 401); assert.equal(step1.body.needs2fa, true);
  assert.equal((await fresh2('POST', '/api/auth/login', { email: a.email, password: a.password, code })).status, 401);
  const next = totp(secret, Date.now() + 30_000);
  assert.equal((await fresh2('POST', '/api/auth/login', { email: a.email, password: a.password, code: next })).status, 200);

  const list = await fresh2('GET', '/api/admin/users');
  assert.equal(list.status, 200);
  assert.ok(list.body.users.some(x => x.email === o.email));
  assert.equal((await fresh2('POST', `/api/admin/users/${oid}/role`, { role: 'GOD' })).status, 400);
  assert.equal((await fresh2('POST', `/api/admin/users/${oid}/role`, { role: 'SUPPORT' })).status, 200);
  assert.equal((await other('GET', '/api/me')).body.user.role, 'SUPPORT');
  const log = await fresh2('GET', '/api/admin/audit');
  assert.ok(log.body.entries.some(e => e.action === 'admin.role_changed' && e.target === oid));
});

test('CSRF, content-type and path traversal are blocked', async () => {
  const c = client(), u = fresh();
  await c('POST', '/api/auth/register', u);
  assert.equal((await c('POST', '/api/auth/logout', {}, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await c('GET', '/api/me')).status, 200); // still logged in
  assert.equal((await c('POST', '/api/auth/login', 'email=x', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await c('POST', '/api/auth/login', '{bad json')).status, 400);
  assert.equal((await c('GET', '/../server/app.js')).status, 404);
  assert.equal((await c('GET', '/%2e%2e/server/app.js')).status, 404);
  const page = await c('GET', '/index.html');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
