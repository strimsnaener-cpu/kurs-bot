import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { totp } from '../server/auth.js';

let S, admin;
before(async () => { S = await startServer(); admin = await S.admin(); });
after(() => S.close());
const mail = (to, like) => S.db.prepare('SELECT * FROM outbox WHERE to_email = ? AND subject LIKE ? ORDER BY created_at DESC, rowid DESC').get(to, like);
const tokenIn = body => body.match(/[?&]t=([\w-]+)/)?.[1];

test('users: search, profile with orders/agents, suspend logs out and blocks login', async () => {
  const u = await S.customerWithAgent('telegram-assistant', 'Bohdan Hnatiuk');
  await u.c('POST', `/api/installations/${u.inst}/telegram`, {}).catch(() => {});
  S.db.prepare('UPDATE installations SET auto_reply = 1 WHERE id = ?').run(u.inst);

  const found = (await admin.c('GET', `/api/admin/users?q=hnatiuk`)).body.users;
  assert.equal(found.length, 1); assert.equal(found[0].suspended, false);
  assert.equal((await admin.c('GET', '/api/admin/users?role=ADMIN')).body.users.every(x => x.role === 'ADMIN'), true);

  const p = (await admin.c('GET', `/api/admin/users/${u.id}`)).body;
  assert.equal(p.orders[0].product, 'AI-ассистент для Telegram'); assert.equal(p.orders[0].status, 'PAID');
  assert.equal(p.agents.length, 1); assert.equal(p.agents[0].live, true);
  assert.equal(p.sessions, 1); assert.ok(p.activity.some(a => a.action === 'user.register'));

  assert.equal((await u.c('GET', `/api/admin/users/${u.id}`)).status, 403);
  assert.equal((await admin.c('POST', `/api/admin/users/${admin.id}/suspend`, { suspended: true, reason: 'test' })).status, 400);
  assert.equal((await admin.c('POST', `/api/admin/users/${u.id}/suspend`, { suspended: true })).status, 400);              // reason required
  assert.equal((await admin.c('POST', `/api/admin/users/${u.id}/suspend`, { suspended: true, reason: 'Spam bot reported by customers' })).status, 200);
  assert.equal((await u.c('GET', '/api/me')).status, 401);                                                                  // session gone
  const login = await S.client()('POST', '/api/auth/login', { email: u.email, password: 'correct-horse-battery' });
  assert.equal(login.status, 403); assert.match(login.body.error, /заблокирован/);
  assert.equal(S.db.prepare('SELECT auto_reply FROM installations WHERE id = ?').get(u.inst).auto_reply, 0);               // their bot paused
  assert.equal((await admin.c('GET', '/api/admin/users?status=suspended')).body.users.some(x => x.id === u.id), true);

  await admin.c('POST', `/api/admin/users/${u.id}/suspend`, { suspended: false });
  assert.equal((await S.client()('POST', '/api/auth/login', { email: u.email, password: 'correct-horse-battery' })).status, 200);
  assert.equal((await admin.c('POST', `/api/admin/users/${u.id}/logout`, {})).body.sessions, 1);
  const log = (await admin.c('GET', '/api/admin/logs/audit?action=admin.user_')).body.entries;
  assert.deepEqual(log.map(e => e.action).slice(0, 3), ['admin.user_logged_out', 'admin.user_restored', 'admin.user_suspended']);
  assert.equal(log.find(e => e.action === 'admin.user_suspended').meta.reason, 'Spam bot reported by customers');
});

test('announcements: audience targeting, dismiss, schedule window, optional email', async () => {
  const customer = await S.customerWithAgent('sales-agent', 'Cust Omer');
  const plain = await S.user('Plain User');
  const bad = await admin.c('POST', '/api/admin/announcements', { title: 'Hi', body: 'x' });
  assert.equal(bad.status, 400);
  const r = await admin.c('POST', '/api/admin/announcements', { title: 'Telegram maintenance tonight', body: 'Replies may be delayed 22:00–23:00 Kyiv time.', audience: 'CUSTOMERS', level: 'IMPORTANT', email: true });
  assert.equal(r.status, 201); assert.ok(r.body.emailed >= 1);
  assert.ok(mail(customer.email, 'Telegram maintenance tonight'));
  assert.equal(mail(plain.email, 'Telegram maintenance tonight'), undefined);                     // not in audience
  const seen = (await customer.c('GET', '/api/announcements')).body.announcements;
  assert.equal(seen[0].title, 'Telegram maintenance tonight'); assert.equal(seen[0].level, 'IMPORTANT');
  assert.equal((await plain.c('GET', '/api/announcements')).body.announcements.length, 0);
  await customer.c('POST', `/api/announcements/${seen[0].id}/dismiss`, {});
  assert.equal((await customer.c('GET', '/api/announcements')).body.announcements.length, 0);

  const future = await admin.c('POST', '/api/admin/announcements', { title: 'New year sale', body: 'Coming soon', startsAt: new Date(Date.now() + 86400e3).toISOString() });
  assert.equal((await plain.c('GET', '/api/announcements')).body.announcements.length, 0);
  await admin.c('POST', `/api/admin/announcements/${future.body.id}`, { title: 'New year sale', body: 'Live now!', startsAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await plain.c('GET', '/api/announcements')).body.announcements[0].body, 'Live now!');
  await admin.c('POST', `/api/admin/announcements/${future.body.id}/end`, {});
  assert.equal((await plain.c('GET', '/api/announcements')).body.announcements.length, 0);
  const list = (await admin.c('GET', '/api/admin/announcements')).body.announcements;
  assert.equal(list.find(a => a.title === 'Telegram maintenance tonight').dismissed, 1);
  assert.equal((await plain.c('GET', '/api/admin/announcements')).status, 403);
});

test('support: guest ticket with private link, staff reply by email, customer replies, account tickets', async () => {
  const guest = S.client();
  assert.equal((await guest('POST', '/api/support/tickets', { name: 'Guest', email: 'bad', subject: 'Hello', message: 'Need help please' })).status, 400);
  const t = await guest('POST', '/api/support/tickets', { name: 'Olha Moroz', email: 'olha@shop.example', subject: 'Custom bot for my clinic', category: 'CUSTOM', message: 'We need a bot that books appointments. Can you build it?' });
  assert.equal(t.status, 201); assert.ok(t.body.number > 1000); assert.ok(t.body.token);
  const confirm = mail('olha@shop.example', `Мы получили ваше сообщение (№${t.body.number})`);
  assert.equal(tokenIn(confirm.body), t.body.token);
  assert.ok(mail(admin.email, `Новое обращение №${t.body.number}%`));

  assert.equal((await S.client()('GET', `/api/support/tickets/${t.body.id}`)).status, 404);                               // no token
  assert.equal((await S.client()('GET', `/api/support/tickets/${t.body.id}?t=${'x'.repeat(32)}`)).status, 404);
  const view = (await S.client()('GET', `/api/support/tickets/${t.body.id}?t=${t.body.token}`)).body.ticket;
  assert.equal(view.messages[0].body, 'We need a bot that books appointments. Can you build it?');

  const q = (await admin.c('GET', '/api/admin/support')).body;
  assert.ok(q.counts.OPEN >= 1); assert.equal(q.tickets[0].status, 'OPEN');
  assert.equal((await admin.c('POST', `/api/admin/support/${t.body.id}/reply`, { body: 'Yes! Could you share your booking system?' })).body.status, 'PENDING');
  const reply = mail('olha@shop.example', `Re: Custom bot for my clinic (№${t.body.number})`);
  assert.match(reply.body, /Could you share your booking system/);
  const newToken = tokenIn(reply.body);
  assert.ok(newToken && newToken !== t.body.token);
  assert.equal((await S.client()('POST', `/api/support/tickets/${t.body.id}/reply`, { body: 'We use Google Calendar.', t: newToken })).status, 200);
  const full = (await admin.c('GET', `/api/admin/support/${t.body.id}`)).body.ticket;
  assert.equal(full.status, 'OPEN');
  assert.deepEqual(full.messages.map(m => m.fromStaff), [false, true, false]);
  assert.match(full.messages[1].author, /\(поддержка\)$/);

  // Logged-in customer
  const u = await S.user('Account Holder');
  const mine = await u.c('POST', '/api/support/tickets', { subject: 'Invoice please', category: 'BILLING', message: 'Can I get an invoice for my order?' });
  assert.equal(mine.body.token, undefined);
  assert.equal((await u.c('GET', '/api/support/tickets')).body.tickets[0].subject, 'Invoice please');
  assert.equal((await u.c('GET', `/api/support/tickets/${mine.body.id}`)).status, 200);
  const other = await S.user();
  assert.equal((await other.c('GET', `/api/support/tickets/${mine.body.id}`)).status, 404);
  assert.equal((await u.c('POST', `/api/support/tickets/${mine.body.id}/close`, {})).status, 200);
  assert.equal((await u.c('GET', '/api/support/tickets')).body.tickets[0].status, 'CLOSED');

  // Support staff need 2FA; customers can't see the queue
  assert.equal((await u.c('GET', '/api/admin/support')).status, 403);
  const staff = await S.user('Support Agent');
  S.db.prepare("UPDATE users SET role = 'SUPPORT' WHERE id = ?").run(staff.id);
  assert.match((await staff.c('GET', '/api/admin/support')).body.error, /двухфакторн/);
  const { secret } = (await staff.c('POST', '/api/account/2fa/setup', {})).body;
  await staff.c('POST', '/api/account/2fa/enable', { code: totp(secret) });
  assert.equal((await staff.c('GET', '/api/admin/support')).status, 200);
  assert.equal((await staff.c('GET', '/api/admin/users')).status, 403);                                                   // support ≠ admin

  // Honeypot: bots filling the hidden field get a fake success and no ticket
  const before = S.db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n;
  await S.client()('POST', '/api/support/tickets', { name: 'Bot', email: 'bot@spam.example', subject: 'Cheap SEO', message: 'Buy links now!!!', website: 'http://spam' });
  assert.equal(S.db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n, before);
});

test('insights: monthly agent revenue, top agents, open tickets; no Academy data', async () => {
  await S.customerWithAgent('support-agent');
  const d = (await admin.c('GET', '/api/admin/insights')).body;
  assert.equal(d.months.length, 12); assert.equal(d.months[11], new Date().toISOString().slice(0, 7));
  assert.ok(d.agents[11] > 0); assert.equal(d.academy, undefined); assert.equal(d.students, undefined);
  assert.ok(d.topAgents.length >= 1); assert.ok(d.newUsers[11] >= 1);
  assert.equal((await admin.c('GET', '/api/academy')).status, 404);                                  // the Academy API is gone
  const t = (await S.client()('POST', '/api/support/tickets', { name: 'Old', email: 'old@x.example', subject: 'Course', message: 'About the course please', category: 'ACADEMY' })).body;
  assert.equal(S.db.prepare('SELECT category FROM tickets WHERE id = ?').get(t.id).category, 'GENERAL');  // retired category falls back
});

test('agent performance and system logs', async () => {
  const perf = (await admin.c('GET', '/api/admin/agents/performance')).body.installations;
  assert.ok(perf.length >= 1);
  for (const k of ['agent', 'owner', 'live', 'incoming', 'replies', 'handoffs', 'leads', 'handoffRate', 'channels']) assert.ok(k in perf[0], k);
  // A failing background job lands in the system log.
  S.engine.queue.enqueue('reply', { messageId: 'does-not-exist' });
  S.db.prepare("INSERT INTO jobs (id, kind, payload, run_at) VALUES ('j-bad', 'nope', '{}', ?)").run(new Date().toISOString());
  await S.engine.queue.drain().catch(() => {});
  const sys = (await admin.c('GET', '/api/admin/logs/system')).body.entries;
  assert.ok(sys.some(e => e.source === 'runtime' && /job nope/.test(e.message)), JSON.stringify(sys.slice(0, 3)));
  const ins = S.db.prepare("INSERT INTO audit_log (id, actor_id, action, created_at) VALUES (?, ?, 'test.filler', ?)");
  for (let i = 0; i < 120; i++) ins.run(`fill-${i}`, admin.id, new Date(Date.now() - 1000 - i * 1000).toISOString());
  const audit = (await admin.c('GET', '/api/admin/logs/audit')).body;
  assert.equal(audit.entries.length, 100); assert.ok(audit.next);
  const page2 = (await admin.c('GET', `/api/admin/logs/audit?before=${encodeURIComponent(audit.next)}`)).body.entries;
  assert.ok(page2.length > 0 && page2[0].at <= audit.next);
});
