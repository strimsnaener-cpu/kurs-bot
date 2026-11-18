import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { createApp } from '../server/app.js';
import { seedCatalog } from '../server/seed.js';
import { seedAcademy } from '../server/academy-seed.js';
import { totp } from '../server/auth.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function startServer({ seed = true, env = {} } = {}) {
  const db = openDb(':memory:');
  if (seed) { seedCatalog(db); seedAcademy(db); }
  const quiet = { error() {} };
  const app = createApp({ db, encryptionKey: crypto.randomBytes(32).toString('base64'), publicDir: path.join(root, 'public'), env, log: quiet });
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    let cookie = '';
    return async (method, p, body, headers = {}) => {
      const res = await fetch(base + p, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'manual',
      });
      for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); cookie = kv.endsWith('=') ? '' : kv; }
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch { json = text; }
      return { status: res.status, body: json, location: res.headers.get('location') };
    };
  }

  let n = 0;
  async function user(name = 'Test User') {
    const c = client(), email = `u${++n}-${crypto.randomUUID().slice(0, 6)}@example.com`;
    const r = await c('POST', '/api/auth/register', { name, email, password: 'correct-horse-battery' });
    return { c, id: r.body.user.id, email };
  }
  async function admin() {
    const u = await user('Admin Person');
    db.prepare("UPDATE users SET role = 'ADMIN' WHERE id = ?").run(u.id);
    const { secret } = (await u.c('POST', '/api/account/2fa/setup', {})).body;
    await u.c('POST', '/api/account/2fa/enable', { code: totp(secret) });
    return u;
  }
  // A customer who bought `slug`, with the order paid and the agent installed.
  let adminUser;
  async function customerWithAgent(slug = 'telegram-assistant', name = 'Shop Owner') {
    adminUser ||= await admin();
    const u = await user(name);
    const agent = (await u.c('GET', `/api/agents/${slug}`)).body.agent;
    const order = (await u.c('POST', '/api/orders', { priceId: agent.plans[0].prices[0].id })).body.order;
    await adminUser.c('POST', `/api/admin/orders/${order.id}/status`, { status: 'PAID' });
    const inst = (await u.c('POST', '/api/installations', { orderId: order.id })).body.id;
    return { ...u, inst, orderId: order.id };
  }
  return { db, base, client, user, admin, customerWithAgent, engine: app.engine, adminClient: () => adminUser, close: () => server.close() };
}
