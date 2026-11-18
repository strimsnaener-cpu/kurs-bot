import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from './helpers.js';
import { embedUrl } from '../server/academy.js';
import { openDb } from '../server/db.js';

let S, admin;
before(async () => { S = await startServer(); admin = await S.admin(); });
after(() => S.close());
const anon = () => S.client();

// Buys a plan and has the admin confirm payment.
async function member(planName = 'VIP Академия', interval = 'MONTH', name = 'Student Person') {
  const u = await S.user(name);
  const plan = (await u.c('GET', '/api/academy')).body.plans.find(p => p.name === planName);
  const price = plan.prices.find(p => p.interval === interval);
  const { order } = (await u.c('POST', '/api/academy/orders', { priceId: price.id })).body;
  await admin.c('POST', `/api/admin/orders/${order.id}/status`, { status: 'PAID' });
  return { ...u, orderId: order.id };
}
const course = async (c, slug) => (await c('GET', `/api/academy/courses/${slug}`)).body;
const lessonIds = co => co.modules.flatMap(m => m.lessons.map(l => l.id));

test('video links become privacy-friendly embeds; everything else is refused', () => {
  assert.equal(embedUrl('https://youtu.be/dQw4w9WgXcQ'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(embedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal(embedUrl('https://vimeo.com/76979871/abc123'), 'https://player.vimeo.com/video/76979871?h=abc123');
  assert.equal(embedUrl('https://iframe.mediadelivery.net/play/12345/0e7c-video'), 'https://iframe.mediadelivery.net/embed/12345/0e7c-video');
  for (const bad of ['http://youtu.be/dQw4w9WgXcQ', 'https://evil.example/embed/x', 'javascript:alert(1)', 'https://youtube.com/watch?v=short']) assert.equal(embedUrl(bad), undefined, bad);
  assert.equal(embedUrl(''), null);
});

test('old databases are upgraded without losing orders', () => {
  const file = `/tmp/academy-migrate-${process.pid}.db`;
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, role TEXT, created_at TEXT);
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, slug TEXT, created_at TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, slug TEXT, name TEXT, tagline TEXT, description TEXT, category TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE orders (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, org_id TEXT NOT NULL, agent_id TEXT NOT NULL, price_id TEXT NOT NULL,
      plan_name TEXT NOT NULL, interval TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'PENDING',
      provider TEXT NOT NULL DEFAULT 'manual', provider_ref TEXT, created_at TEXT NOT NULL DEFAULT 'x', paid_at TEXT);
    INSERT INTO orders (id, user_id, org_id, agent_id, price_id, plan_name, interval, amount, currency, status) VALUES ('o1','u1','g1','a1','p1','Старт','MONTH',2900,'USD','PAID');`);
  old.close();
  const db = openDb(file);
  const row = db.prepare('SELECT * FROM orders').get();
  assert.deepEqual([row.id, row.product_type, row.agent_id, row.amount, row.status], ['o1', 'AGENT', 'a1', 2900, 'PAID']);
  db.close(); fs.rmSync(file, { force: true });
});

test('catalog is public; free previews open; the rest is locked', async () => {
  const a = (await anon()('GET', '/api/academy')).body;
  assert.deepEqual(a.courses.map(c => c.month), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(a.plans.map(p => p.name), ['VIP Академия', 'VIP + Менторство']);
  assert.equal(a.viewer.loggedIn, false);
  const c1 = await course(anon(), 'ai-foundations');
  const [free, , locked] = c1.modules.flatMap(m => m.lessons);
  assert.equal(free.preview, true); assert.equal(free.locked, false); assert.equal(locked.locked, true);
  const f = await anon()('GET', `/api/academy/lessons/${free.id}`);
  assert.equal(f.status, 200); assert.match(f.body.body, /большие языковые модели/);
  const l = await anon()('GET', `/api/academy/lessons/${locked.id}`);
  assert.equal(l.status, 403); assert.equal(l.body.locked, true); assert.equal(l.body.body, undefined); assert.equal(l.body.assignment, undefined);
  assert.equal((await anon()('GET', '/api/community')).status, 401);
});

test('membership: order → admin confirms payment → access; renewals stack; refund removes access', async () => {
  const u = await S.user('Iryna Bondar');
  const plan = (await u.c('GET', '/api/academy')).body.plans[0];
  const { order } = (await u.c('POST', '/api/academy/orders', { priceId: plan.prices[0].id })).body;
  assert.equal((await u.c('POST', '/api/academy/orders', { priceId: plan.prices[0].id })).body.order.id, order.id); // double-click safe
  const listed = (await u.c('GET', '/api/orders')).body.orders[0];
  assert.deepEqual([listed.productType, listed.agentName, listed.status], ['ACADEMY', 'VIP Академия', 'PENDING']);
  assert.equal((await u.c('GET', '/api/academy/me')).body.membership.active, false);

  await admin.c('POST', `/api/admin/orders/${order.id}/status`, { status: 'PAID' });
  const m1 = (await u.c('GET', '/api/academy/me')).body.membership;
  assert.equal(m1.active, true); assert.equal(m1.plan, 'VIP Академия'); assert.equal(m1.mentorship, false);
  const days = (Date.parse(m1.endsAt) - Date.now()) / 86400e3;
  assert.ok(days > 30 && days < 32);
  const locked = lessonIds(await course(u.c, 'ai-foundations'))[2];
  assert.equal((await u.c('GET', `/api/academy/lessons/${locked}`)).status, 200);

  const { order: o2 } = (await u.c('POST', '/api/academy/orders', { priceId: plan.prices[0].id })).body;
  await admin.c('POST', `/api/admin/orders/${o2.id}/status`, { status: 'PAID' });
  const stacked = (Date.parse((await u.c('GET', '/api/academy/me')).body.membership.endsAt) - Date.now()) / 86400e3;
  assert.ok(stacked > 61 && stacked < 63, `stacked ${stacked}`);

  await admin.c('POST', `/api/admin/orders/${order.id}/status`, { status: 'REFUNDED' });
  await admin.c('POST', `/api/admin/orders/${o2.id}/status`, { status: 'REFUNDED' });
  assert.equal((await u.c('GET', '/api/academy/me')).body.membership.active, false);
  assert.equal((await u.c('GET', `/api/academy/lessons/${locked}`)).status, 403);
});

test('progress, assignment review and automatic certificate', async () => {
  const s = await member('VIP Академия', 'MONTH', 'Taras Shevchuk');
  const co = await course(s.c, 'monetization-career');
  const [withTask, last] = co.modules.flatMap(m => m.lessons);
  assert.equal(withTask.hasAssignment, true);
  for (const id of [withTask.id, last.id]) assert.equal((await s.c('POST', `/api/academy/lessons/${id}/complete`, { done: true })).status, 200);
  let c2 = await course(s.c, 'monetization-career');
  assert.deepEqual(c2.progress, { done: 2, total: 2, percent: 100 });
  assert.equal(c2.certificate, null);                                     // assignment not approved yet

  assert.equal((await s.c('POST', `/api/academy/lessons/${last.id}/submission`, { body: 'no task here, long enough' })).status, 404);
  assert.equal((await s.c('POST', `/api/academy/lessons/${withTask.id}/submission`, { body: 'short' })).status, 400);
  assert.equal((await s.c('POST', `/api/academy/lessons/${withTask.id}/submission`, { body: 'My portfolio with two case studies.', link: 'http://insecure.example' })).status, 400);
  assert.equal((await s.c('POST', `/api/academy/lessons/${withTask.id}/submission`, { body: 'My portfolio with two case studies.', link: 'https://taras.example/portfolio' })).status, 200);

  const queue = (await admin.c('GET', '/api/admin/academy/submissions')).body.submissions;
  const sub = queue.find(x => x.student === 'Taras Shevchuk');
  assert.equal(sub.link, 'https://taras.example/portfolio');
  assert.equal((await admin.c('POST', `/api/admin/academy/submissions/${sub.id}`, { status: 'NEEDS_WORK' })).status, 400);     // needs a note
  assert.equal((await admin.c('POST', `/api/admin/academy/submissions/${sub.id}`, { status: 'NEEDS_WORK', feedback: 'Add numbers to case study 2.' })).status, 200);
  const fb = (await s.c('GET', '/api/academy/me')).body.feedback;
  assert.equal(fb[0].feedback, 'Add numbers to case study 2.');
  assert.ok(S.db.prepare("SELECT 1 FROM outbox WHERE to_email = ? AND subject LIKE 'Отзыв на ваше задание%'").get(s.email));

  await s.c('POST', `/api/academy/lessons/${withTask.id}/submission`, { body: 'Updated: case study 2 now shows 30% faster replies.' });
  const again = (await admin.c('GET', '/api/admin/academy/submissions')).body.submissions.find(x => x.student === 'Taras Shevchuk');
  const ok = (await admin.c('POST', `/api/admin/academy/submissions/${again.id}`, { status: 'APPROVED', feedback: 'Great work!' })).body;
  assert.match(ok.certificate, /^[A-F0-9]{10}$/);
  assert.equal((await s.c('POST', `/api/academy/lessons/${withTask.id}/submission`, { body: 'trying to change after approval' })).status, 400);

  const cert = (await anon()('GET', `/api/certificates/${ok.certificate}`)).body.certificate;
  assert.deepEqual([cert.name, cert.course, cert.month], ['Taras Shevchuk', 'Монетизация и карьера', 6]);
  assert.equal((await anon()('GET', '/api/certificates/0000000000')).status, 404);
  assert.equal((await s.c('GET', '/api/academy/me')).body.certificates[0].code, ok.certificate);
  assert.ok(S.db.prepare("SELECT 1 FROM outbox WHERE to_email = ? AND subject = 'Сертификат: Монетизация и карьера'").get(s.email));

  const students = (await admin.c('GET', '/api/admin/academy/students')).body;
  const row = students.students.find(x => x.email === s.email);
  assert.equal(row.done, 2); assert.equal(row.certificates, 1); assert.equal(row.active, true);
});

test('community: members only, own posts deletable, admin can pin and remove', async () => {
  const outsider = await S.user();
  assert.equal((await outsider.c('POST', '/api/community', { title: 'Hello', body: 'Can I join?' })).status, 403);
  const a = await member(undefined, undefined, 'Oksana Kravets'), b = await member(undefined, undefined, 'Petro Lysenko');
  const { id } = (await a.c('POST', '/api/community', { title: 'My first bot works!', body: 'Built the Telegram assistant from Month 3.' })).body;
  assert.equal((await b.c('POST', `/api/community/${id}/comments`, { body: 'Congrats! Which model did you use?' })).status, 201);
  const list = (await b.c('GET', '/api/community')).body.posts;
  assert.deepEqual([list[0].author, list[0].comments, list[0].mine], ['Oksana K.', 1, false]);
  const thread = (await a.c('GET', `/api/community/${id}`)).body;
  assert.equal(thread.comments[0].author, 'Petro L.'); assert.ok(!JSON.stringify(thread).includes('@example.com'));
  assert.equal((await b.c('POST', `/api/community/${id}/delete`, {})).status, 404);             // not b's post
  assert.equal((await b.c('POST', `/api/community/${id}/pin`, { pinned: true })).status, 403);
  await admin.c('POST', `/api/community/${id}/pin`, { pinned: true });
  assert.equal((await b.c('GET', '/api/community')).body.posts[0].pinned, true);
  assert.equal((await a.c('POST', `/api/community/${id}/delete`, {})).status, 200);
});

test('mentorship: only on the mentorship plan; admin schedules with a link', async () => {
  const vip = await member();
  assert.equal((await vip.c('POST', '/api/academy/mentorship', { topic: 'Pricing', message: 'How should I price my first project?' })).status, 403);
  const m = await member('VIP + Менторство', 'MONTH', 'Andrii Melnyk');
  assert.equal((await m.c('GET', '/api/academy/mentorship')).body.available, true);
  const { id } = (await m.c('POST', '/api/academy/mentorship', { topic: 'Pricing my first client', message: 'A bakery wants a Telegram bot. What should I charge?' })).body;
  assert.ok(S.db.prepare("SELECT 1 FROM outbox WHERE subject = 'Запрос на менторство от Andrii Melnyk'").get());
  assert.equal((await admin.c('POST', `/api/admin/academy/mentorship/${id}`, { status: 'SCHEDULED', scheduledAt: '2026-12-01T15:00:00Z', meetingUrl: 'zoom.us/j/1' })).status, 400);
  assert.equal((await admin.c('POST', `/api/admin/academy/mentorship/${id}`, { status: 'SCHEDULED', scheduledAt: '2026-12-01T15:00:00Z', meetingUrl: 'https://meet.example/abc', note: 'Bring your offer draft.' })).status, 200);
  const r = (await m.c('GET', '/api/academy/mentorship')).body.requests[0];
  assert.deepEqual([r.status, r.meetingUrl, r.note], ['SCHEDULED', 'https://meet.example/abc', 'Bring your offer draft.']);
  assert.ok(S.db.prepare('SELECT 1 FROM outbox WHERE to_email = ? AND subject LIKE ?').get(m.email, 'Сессия с ментором назначена%'));
  assert.equal((await m.c('POST', `/api/academy/mentorship/${id}/cancel`, {})).status, 200);
});

test('live sessions: join links only for members', async () => {
  assert.equal((await admin.c('POST', '/api/admin/academy/live', { title: 'Q&A: your first client', kind: 'QA', startsAt: new Date(Date.now() + 86400e3).toISOString(), joinUrl: 'http://x' })).status, 400);
  assert.equal((await admin.c('POST', '/api/admin/academy/live', { title: 'Q&A: your first client', kind: 'QA', startsAt: new Date(Date.now() + 86400e3).toISOString(), joinUrl: 'https://meet.example/qa' })).status, 201);
  const pub = (await anon()('GET', '/api/academy/live')).body.sessions[0];
  assert.equal(pub.title, 'Q&A: your first client'); assert.equal(pub.joinUrl, null);
  const m = await member();
  assert.equal((await m.c('GET', '/api/academy/live')).body.sessions[0].joinUrl, 'https://meet.example/qa');
  assert.equal((await m.c('GET', '/api/academy/me')).body.live[0].joinUrl, 'https://meet.example/qa');
});

test('admin course builder: course, modules, lessons, video, materials, publish rules', async () => {
  const s = await S.user();
  assert.equal((await s.c('GET', '/api/admin/academy/courses')).status, 403);
  assert.equal((await admin.c('POST', '/api/admin/academy/courses', { slug: 'Bad Slug', title: 'X course', summary: 'Something' })).status, 400);
  const { id } = (await admin.c('POST', '/api/admin/academy/courses', { slug: 'ai-for-designers', title: 'AI for Designers', summary: 'Image tools for real projects', level: 'Intermediate' })).body;
  assert.equal((await admin.c('POST', `/api/admin/academy/courses/${id}`, { published: true })).status, 400);   // no lessons yet
  const mod = (await admin.c('POST', `/api/admin/academy/courses/${id}/modules`, { title: 'Getting started' })).body.id;
  assert.equal((await admin.c('POST', `/api/admin/academy/modules/${mod}/lessons`, { title: 'Bad video', videoUrl: 'https://random.example/v.mp4' })).status, 400);
  assert.equal((await admin.c('POST', `/api/admin/academy/modules/${mod}/lessons`, { title: 'Bad link', materials: [{ title: 'Slides', url: 'http://x.example' }] })).status, 400);
  const l1 = (await admin.c('POST', `/api/admin/academy/modules/${mod}/lessons`, { title: 'Image prompts', videoUrl: 'https://youtu.be/dQw4w9WgXcQ', body: '## Goals\n- Write image prompts', durationMin: 12,
    materials: [{ title: 'Prompt sheet', url: 'https://drive.example/sheet' }], assignment: 'Create three images for a brand.', freePreview: true })).body.id;
  const l2 = (await admin.c('POST', `/api/admin/academy/modules/${mod}/lessons`, { title: 'Upscaling', kind: 'TUTORIAL' })).body.id;
  await admin.c('POST', `/api/admin/academy/lessons/${l2}/move`, { dir: -1 });
  const full = (await admin.c('GET', `/api/admin/academy/courses/${id}`)).body;
  assert.deepEqual(full.modules[0].lessons.map(l => l.title), ['Upscaling', 'Image prompts']);
  assert.equal(full.modules[0].lessons[1].videoUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ');
  assert.equal((await admin.c('POST', `/api/admin/academy/courses/${id}`, { published: true, month: 7 })).status, 200);
  assert.ok((await anon()('GET', '/api/academy')).body.courses.some(c => c.slug === 'ai-for-designers'));
  const pv = (await anon()('GET', `/api/academy/lessons/${l1}`)).body;
  assert.equal(pv.materials[0].url, 'https://drive.example/sheet'); assert.equal(pv.assignment, 'Create three images for a brand.');
  assert.equal((await admin.c('POST', `/api/admin/academy/modules/${mod}/delete`, {})).status, 409);
  await admin.c('POST', `/api/admin/academy/lessons/${l1}`, { published: false });
  assert.equal((await anon()('GET', `/api/academy/lessons/${l1}`)).status, 404);
  assert.equal((await admin.c('POST', `/api/admin/academy/courses/${id}/delete`, {})).status, 200);
  assert.equal((await anon()('GET', '/api/academy/courses/ai-for-designers')).status, 404);
  const certCourse = (await admin.c('GET', '/api/admin/academy/courses')).body.courses.find(c => c.slug === 'monetization-career');
  assert.equal((await admin.c('POST', `/api/admin/academy/courses/${certCourse.id}/delete`, {})).status, 409);   // certificates exist
});

test('admin: plan prices and manual access (scholarships)', async () => {
  const plans = (await admin.c('GET', '/api/admin/academy/plans')).body.plans;
  const vip = plans.find(p => p.name === 'VIP Академия');
  const r = await admin.c('POST', `/api/admin/academy/plans/${vip.id}`, { prices: { MONTH: 7900, YEAR: null } });
  assert.deepEqual(r.body.plans.find(p => p.id === vip.id).prices.map(p => [p.interval, p.amount]), [['MONTH', 7900]]);
  const u = await S.user('Scholarship Student');
  assert.equal((await admin.c('POST', '/api/admin/academy/access', { email: 'nobody@example.com', days: 30 })).status, 404);
  assert.equal((await admin.c('POST', '/api/admin/academy/access', { email: u.email, days: 90, mentorship: true })).status, 200);
  const m = (await u.c('GET', '/api/academy/me')).body.membership;
  assert.equal(m.active, true); assert.equal(m.mentorship, true);
});
