import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let S;
before(async () => { S = await startServer(); });
after(() => S.close());

const anon = () => S.client();
const firstMonthly = agent => agent.plans[0].prices.find(p => p.interval === 'MONTH');

test('catalog: 5 seeded agents with full product pages; filter and search', async () => {
  const list = (await anon()('GET', '/api/agents')).body.agents;
  assert.equal(list.length, 5);
  assert.deepEqual(list.map(a => a.slug), ['telegram-assistant', 'instagram-assistant', 'sales-agent', 'support-agent', 'business-assistant']);
  assert.deepEqual(list[0].fromPrice, { amount: 2900, currency: 'USD', interval: 'MONTH' });

  const d = (await anon()('GET', '/api/agents/telegram-assistant')).body;
  for (const k of ['name', 'description', 'features', 'problems', 'demo', 'installSteps', 'platforms', 'plans'])
    assert.ok(d.agent[k] && (typeof d.agent[k] === 'string' || d.agent[k].length), `missing ${k}`);
  assert.equal(d.agent.plans.length, 2);
  assert.deepEqual(d.reviews, []);
  assert.equal(d.viewer.loggedIn, false);

  const sales = (await anon()('GET', '/api/agents?category=sales')).body.agents.map(a => a.slug);
  assert.deepEqual(sales, ['instagram-assistant', 'sales-agent']);
  assert.deepEqual((await anon()('GET', `/api/agents?q=${encodeURIComponent('ОТЧЁТЫ')}`)).body.agents.map(a => a.slug), ['business-assistant']);
  assert.equal((await anon()('GET', '/api/agents/nope')).status, 404);
  assert.equal((await anon()('GET', '/api/agents/business-assistant')).body.agent.plans[1].prices[0].interval, 'ONE_TIME');
});

test('orders: login required, idempotent, snapshot price, cancel; only own orders visible', async () => {
  const price = firstMonthly((await anon()('GET', '/api/agents/telegram-assistant')).body.agent);
  assert.equal((await anon()('POST', '/api/orders', { priceId: price.id })).status, 401);
  const u = await S.user();
  const o1 = await u.c('POST', '/api/orders', { priceId: price.id });
  assert.equal(o1.status, 201);
  assert.equal(o1.body.order.status, 'PENDING');
  assert.equal(o1.body.order.amount, 2900);
  const o2 = await u.c('POST', '/api/orders', { priceId: price.id });
  assert.equal(o2.body.order.id, o1.body.order.id);                                // double-click safe
  assert.equal((await u.c('POST', '/api/orders', { priceId: 'fake' })).status, 400);

  const other = await S.user();
  assert.equal((await other.c('GET', `/api/orders/${o1.body.order.id}`)).status, 404);
  assert.equal((await other.c('POST', `/api/orders/${o1.body.order.id}/cancel`, {})).status, 404);
  assert.equal((await u.c('GET', '/api/orders')).body.orders.length, 1);
  assert.equal((await u.c('POST', `/api/orders/${o1.body.order.id}/cancel`, {})).status, 200);
  assert.equal((await u.c('POST', `/api/orders/${o1.body.order.id}/cancel`, {})).status, 400);
});

test('purchase → admin confirms payment → My agents → review → moderation → public', async () => {
  const admin = await S.admin(), u = await S.user('Olena Kovalenko');
  const agent = (await anon()('GET', '/api/agents/sales-agent')).body.agent;
  const order = (await u.c('POST', '/api/orders', { priceId: firstMonthly(agent).id })).body.order;

  assert.equal((await u.c('POST', '/api/agents/sales-agent/reviews', { rating: 5, body: 'Great agent, works well.' })).status, 403);
  assert.equal((await u.c('POST', `/api/admin/orders/${order.id}/status`, { status: 'PAID' })).status, 403); // customers can't mark paid
  assert.equal((await u.c('GET', '/api/my/agents')).body.agents.length, 0);

  const paid = await admin.c('POST', `/api/admin/orders/${order.id}/status`, { status: 'PAID' });
  assert.equal(paid.body.order.status, 'PAID');
  assert.ok(paid.body.order.paidAt);
  assert.equal((await admin.c('POST', `/api/admin/orders/${order.id}/status`, { status: 'FAILED' })).status, 400);
  assert.equal((await u.c('POST', `/api/orders/${order.id}/cancel`, {})).status, 400);

  const mine = (await u.c('GET', '/api/my/agents')).body.agents;
  assert.deepEqual(mine.map(a => [a.slug, a.planName]), [['sales-agent', 'Стандарт']]);

  assert.equal((await u.c('POST', '/api/agents/sales-agent/reviews', { rating: 9, body: 'Great agent, works well.' })).status, 400);
  assert.equal((await u.c('POST', '/api/agents/sales-agent/reviews', { rating: 5, body: 'short' })).status, 400);
  assert.equal((await u.c('POST', '/api/agents/sales-agent/reviews', { rating: 5, body: 'Answers objections better than our juniors.' })).status, 200);
  assert.equal((await anon()('GET', '/api/agents/sales-agent')).body.reviews.length, 0);           // waits for approval
  const view = (await u.c('GET', '/api/agents/sales-agent')).body.viewer;
  assert.equal(view.owned, true); assert.equal(view.myReview.approved, false);

  const pending = (await admin.c('GET', '/api/admin/reviews')).body.reviews.find(r => r.author === 'Olena Kovalenko');
  await admin.c('POST', `/api/admin/reviews/${pending.id}`, { approved: true });
  const pub = (await anon()('GET', '/api/agents/sales-agent')).body;
  assert.equal(pub.reviews.length, 1);
  assert.equal(pub.reviews[0].author, 'Olena K.');                                             // surname shortened
  assert.equal(pub.agent.rating, 5); assert.equal(pub.agent.reviewCount, 1);
  assert.ok(!JSON.stringify(pub).includes('@example.com'));                                    // no emails leak publicly

  const stats = (await admin.c('GET', '/api/admin/stats')).body;
  assert.deepEqual(stats.revenue.map(r => [r.currency, r.total]), [['USD', 4900]]);
});

test('admin manages catalog: prices, plans, publish rules, create, delete', async () => {
  const admin = await S.admin(), u = await S.user();
  assert.equal((await u.c('GET', '/api/admin/agents')).status, 403);
  const tg = (await admin.c('GET', '/api/admin/agents')).body.agents.find(a => a.slug === 'telegram-assistant');
  const full = (await admin.c('GET', `/api/admin/agents/${tg.id}`)).body.agent;
  const starter = full.plans[0], oldPrice = firstMonthly(full);

  // A customer ordered at the old price; the change must not touch that order.
  const order = (await u.c('POST', '/api/orders', { priceId: oldPrice.id })).body.order;
  const upd = await admin.c('POST', `/api/admin/plans/${starter.id}`, { prices: { MONTH: 3500, YEAR: null } });
  assert.equal(upd.status, 200);
  const pub = (await anon()('GET', '/api/agents/telegram-assistant')).body.agent;
  assert.deepEqual(pub.plans[0].prices.map(p => [p.interval, p.amount]), [['MONTH', 3500]]);
  assert.equal((await u.c('GET', `/api/orders/${order.id}`)).body.order.amount, 2900);
  assert.equal((await u.c('POST', '/api/orders', { priceId: oldPrice.id })).status, 400);         // retired price can't be bought again
  assert.equal((await admin.c('POST', `/api/admin/plans/${starter.id}`, { prices: { MONTH: 19.99 } })).status, 400);
  assert.equal((await admin.c('POST', `/api/admin/plans/${starter.id}`, { prices: { WEEK: 100 } })).status, 400);

  // Edit content, unpublish, publish
  assert.equal((await admin.c('POST', `/api/admin/agents/${tg.id}`, { tagline: 'Updated tagline for Telegram' })).status, 200);
  assert.equal((await anon()('GET', '/api/agents/telegram-assistant')).body.agent.tagline, 'Updated tagline for Telegram');
  await admin.c('POST', `/api/admin/agents/${tg.id}`, { published: false });
  assert.equal((await anon()('GET', '/api/agents')).body.agents.length, 4);
  assert.equal((await anon()('GET', '/api/agents/telegram-assistant')).status, 404);
  assert.equal((await admin.c('GET', '/api/agents/telegram-assistant')).status, 200);             // admin preview
  await admin.c('POST', `/api/admin/agents/${tg.id}`, { published: true });
  assert.equal((await admin.c('POST', `/api/admin/agents/${tg.id}/delete`, {})).status, 409);     // has orders

  // New agent: can't publish without a priced plan; add plan; publish; delete
  const bad = await admin.c('POST', '/api/admin/agents', { slug: 'Bad Slug', name: 'X', tagline: 'x', description: 'x', category: 'sales' });
  assert.equal(bad.status, 400);
  const created = await admin.c('POST', '/api/admin/agents', {
    slug: 'email-agent', name: 'AI Email Agent', tagline: 'Answers your inbox politely', category: 'support', icon: 'bolt',
    description: 'Replies to customer emails using your knowledge base.', features: ['Replies to email'], platforms: ['EMAIL'],
    demo: [{ from: 'customer', text: 'Hi' }, { from: 'agent', text: 'Hello!' }], problems: [{ title: 'Slow inbox', text: 'Faster replies.' }] });
  assert.equal(created.status, 201);
  const id = created.body.agent.id;
  assert.equal((await admin.c('POST', '/api/admin/agents', { ...created.body.agent, slug: 'email-agent', installSteps: undefined })).status, 409);
  assert.equal((await admin.c('POST', `/api/admin/agents/${id}`, { published: true })).status, 400);
  assert.equal((await admin.c('POST', `/api/admin/agents/${id}/plans`, { name: 'Basic', features: ['1 inbox'], prices: { MONTH: 1900 } })).status, 201);
  assert.equal((await admin.c('POST', `/api/admin/agents/${id}`, { published: true })).status, 200);
  assert.equal((await anon()('GET', '/api/agents')).body.agents.at(-1).slug, 'email-agent');
  assert.equal((await admin.c('POST', `/api/admin/agents/${id}/delete`, {})).status, 200);
  assert.equal((await anon()('GET', '/api/agents/email-agent')).status, 404);
});
