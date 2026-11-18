import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { startFakes } from './fakes.js';

let F, AI, FAQ;
const TOKEN = n => `${7000000000 + n}:AAH${'x'.repeat(30)}${n}`;
let botN = 0;
const newBot = () => { const n = ++botN; F.addBot(TOKEN(n), 7000000000 + n, `shop${n}_bot`); return TOKEN(n); };

before(async () => {
  F = await startFakes();
  AI = await startServer({ env: { TELEGRAM_API_BASE: F.base, OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: `${F.base}/v1`, OPENAI_MODEL: 'test-model' } });
  FAQ = await startServer({ env: { TELEGRAM_API_BASE: F.base } });
});
after(() => { AI.close(); FAQ.close(); F.close(); });

// Connects a bot (polling mode, as on a PC) and turns auto-reply on.
async function live(S, slug = 'telegram-assistant') {
  const u = await S.customerWithAgent(slug);
  const token = newBot();
  const r = await u.c('POST', `/api/installations/${u.inst}/telegram`, { token });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await u.c('POST', `/api/installations/${u.inst}/auto-reply`, { enabled: true })).status, 200);
  const conn = S.db.prepare('SELECT * FROM channel_connections WHERE installation_id = ?').get(u.inst);
  // Deliver a customer message the way Telegram does (polling), then run the worker.
  const say = async (text, opts) => { F.queueUpdate(token, F.update(text, opts)); await S.engine.pollOnce(S.db.prepare('SELECT * FROM channel_connections WHERE id = ?').get(conn.id), 0); await S.engine.queue.drain(); };
  return { u, token, conn, say };
}

test('installation: only for the buyer, only after payment, one per order', async () => {
  const S = AI;
  const u = await S.user();
  const agent = (await u.c('GET', '/api/agents/telegram-assistant')).body.agent;
  const order = (await u.c('POST', '/api/orders', { priceId: agent.plans[0].prices[0].id })).body.order;
  assert.equal((await u.c('POST', '/api/installations', { orderId: order.id })).status, 402);      // unpaid
  const paid = await S.customerWithAgent();
  assert.equal((await paid.c('POST', '/api/installations', { orderId: paid.orderId })).body.id, paid.inst); // idempotent
  assert.equal((await u.c('POST', '/api/installations', { orderId: paid.orderId })).status, 404);  // someone else's order
  assert.equal((await u.c('GET', `/api/installations/${paid.inst}`)).status, 404);                 // someone else's agent
  const d = (await paid.c('GET', `/api/installations/${paid.inst}`)).body;
  assert.equal(d.installation.config.language, 'auto');
  assert.deepEqual(d.options.channels, ['TELEGRAM']);
  assert.match(d.installation.managerCode, /^[A-Z0-9]{6}$/);
});

test('behavior settings are validated and saved', async () => {
  const u = await AI.customerWithAgent();
  const cfg = (await u.c('GET', `/api/installations/${u.inst}`)).body.installation.config;
  assert.equal((await u.c('POST', `/api/installations/${u.inst}/config`, { config: { ...cfg, tone: 'rude' } })).status, 400);
  assert.equal((await u.c('POST', `/api/installations/${u.inst}/config`, { config: { ...cfg, businessName: '' } })).status, 400);
  const ok = await u.c('POST', `/api/installations/${u.inst}/config`, { config: { ...cfg, businessName: 'Hoodie Shop', language: 'uk', evil: 'x' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.config.businessName, 'Hoodie Shop');
  assert.equal(ok.body.config.evil, undefined);
});

test('telegram connect: token checks, encrypted storage, webhook vs polling, one bot per agent', async () => {
  const u = await AI.customerWithAgent();
  assert.equal((await u.c('POST', `/api/installations/${u.inst}/auto-reply`, { enabled: true })).status, 400); // nothing connected
  assert.equal((await u.c('POST', `/api/installations/${u.inst}/telegram`, { token: 'hello' })).status, 400);
  const unknown = await u.c('POST', `/api/installations/${u.inst}/telegram`, { token: `123456789:AAH${'z'.repeat(32)}` });
  assert.equal(unknown.status, 400); assert.match(unknown.body.error, /не принял/);
  const token = newBot();
  const r = await u.c('POST', `/api/installations/${u.inst}/telegram`, { token });
  assert.equal(r.body.mode, 'polling');
  assert.ok(F.calls.some(c => c.token === token && c.method === 'deleteWebhook'));
  const row = AI.db.prepare('SELECT credentials_enc FROM channel_connections WHERE installation_id = ?').get(u.inst);
  assert.ok(!row.credentials_enc.includes(token.split(':')[1]));                                       // encrypted at rest
  assert.ok(!JSON.stringify((await u.c('GET', `/api/installations/${u.inst}`)).body).includes(token));  // never sent back
  const other = await AI.customerWithAgent();
  assert.equal((await other.c('POST', `/api/installations/${other.inst}/telegram`, { token })).status, 409);
  // Business Assistant has no Telegram channel
  const biz = await AI.customerWithAgent('business-assistant');
  assert.equal((await biz.c('POST', `/api/installations/${biz.inst}/telegram`, { token: newBot() })).status, 400);

  // With a public HTTPS URL, Telegram pushes to our webhook with a secret header.
  const W = await startServer({ env: { TELEGRAM_API_BASE: F.base, PUBLIC_URL: 'https://platform.example.com' } });
  const w = await W.customerWithAgent(); const wt = newBot();
  assert.equal((await w.c('POST', `/api/installations/${w.inst}/telegram`, { token: wt })).body.mode, 'webhook');
  const hook = F.calls.find(c => c.token === wt && c.method === 'setWebhook').body;
  assert.match(hook.url, /^https:\/\/platform\.example\.com\/api\/webhooks\/telegram\/[\w-]+$/);
  const path = new URL(hook.url).pathname, upd = F.update('Привіт');
  const post = (secret, body = upd) => fetch(W.base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post(null)).status, 403);
  assert.equal((await post('wrong')).status, 403);
  assert.equal((await post(hook.secret_token)).status, 200);
  assert.equal((await post(hook.secret_token)).status, 200);                                            // Telegram retry
  assert.equal(W.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE direction = 'IN'").get().n, 1);  // stored once
  W.close();
});

test('AI mode: replies with knowledge, saves leads, hands off, human reply, back to AI', async () => {
  const { u, token, say } = await live(AI);
  const kb = await u.c('POST', `/api/installations/${u.inst}/knowledge`, { kind: 'DOC', title: 'Returns', content: 'Refund policy: returns are accepted within 14 days with the receipt.' });
  assert.equal(kb.status, 201);
  await u.c('POST', `/api/installations/${u.inst}/knowledge`, { kind: 'FAQ', title: 'Delivery cost?', content: 'Nova Poshta delivery is 70 UAH.' });

  F.setAi(() => ({ content: 'Returns are accepted within 14 days with the receipt.' }));
  await say('/start');
  await say('Can I return a hoodie? refund');
  const sent = F.sent(token);
  assert.equal(sent[0].text, 'Здравствуйте! 👋 Чем могу помочь?');                                     // greeting, no AI call
  assert.equal(sent[1].text, 'Returns are accepted within 14 days with the receipt.');
  const sys = F.aiRequests.at(-1).messages[0].content;
  assert.match(sys, /Refund policy: returns are accepted within 14 days/);                             // retrieval reached the prompt
  assert.match(sys, /same language the customer writes in/);
  assert.equal(F.aiRequests.at(-1).model, 'test-model');
  assert.ok(F.aiRequests.at(-1).tools.some(t => t.function.name === 'handoff_to_human'));

  // The model calls save_lead, then writes the reply.
  F.setAi((body, n) => body.messages.at(-1).role === 'tool' ? { content: 'Thanks, Ivan! Our manager will call you.' } : { tool_calls: [{ name: 'save_lead', args: { name: 'Ivan', phone: '+380671234567', note: 'grey hoodie M' } }] });
  await say('I want the grey hoodie M, my phone +380 67 123 45 67');
  const leads = (await u.c('GET', `/api/installations/${u.inst}/leads`)).body.leads;
  assert.equal(leads.length, 1);
  assert.deepEqual([leads[0].name, leads[0].phone, leads[0].handle], ['Ivan', '+380671234567', '@ivanp']);
  assert.equal(F.sent(token).at(-1).text, 'Thanks, Ivan! Our manager will call you.');

  // Manager pairs their own Telegram chat, then a handoff alerts them.
  const code = (await u.c('GET', `/api/installations/${u.inst}`)).body.installation.managerCode;
  await say('/manager WRONG1', { chatId: 999, first: 'Boss', username: 'boss' });
  assert.equal(F.sent(token).at(-1).text, 'Этот код недействителен.');
  await say(`/manager ${code.toLowerCase()}`, { chatId: 999, first: 'Boss', username: 'boss' });
  assert.match(F.sent(token).at(-1).text, /будут приходить уведомления/);
  F.setAi(body => body.messages.at(-1).role === 'tool' ? { content: "I've asked our manager to help with your bulk order." } : { tool_calls: [{ name: 'handoff_to_human', args: { reason: 'Bulk order of 50 hoodies', category: 'other' } }] });
  await say('I need 50 hoodies for my company');
  const alert = F.sent(token).find(m => m.chat === '999' && m.text.startsWith('🔔'));
  assert.ok(alert); assert.match(alert.text, /Ivan Petrenko @ivanp/); assert.match(alert.text, /Bulk order of 50 hoodies/);

  const convs = (await u.c('GET', `/api/installations/${u.inst}/conversations`)).body.conversations;
  assert.equal(convs.length, 1);                                                                       // the manager chat isn't a customer
  assert.equal(convs[0].status, 'handoff');
  const before = F.aiRequests.length;
  await say('hello? anyone?');
  assert.equal(F.aiRequests.length, before);                                                           // AI stays quiet during handoff
  assert.equal((await u.c('POST', `/api/conversations/${convs[0].id}/reply`, { text: 'Hi Ivan, this is Olena. 50 pcs is 1200 UAH each.' })).status, 200);
  assert.equal(F.sent(token).at(-1).text, 'Hi Ivan, this is Olena. 50 pcs is 1200 UAH each.');
  await u.c('POST', `/api/conversations/${convs[0].id}/resolve`, {});
  F.setAi(() => ({ content: 'Anything else I can help with?' }));
  await say('thanks!');
  assert.equal(F.sent(token).at(-1).text, 'Anything else I can help with?');

  const thread = (await u.c('GET', `/api/conversations/${convs[0].id}`)).body.messages;
  assert.deepEqual([...new Set(thread.map(m => m.author))].sort(), ['agent', 'customer', 'human']);
  const stats = (await u.c('GET', `/api/installations/${u.inst}/stats`)).body;
  assert.equal(stats.totals.incoming, 6); assert.equal(stats.totals.leads, 1); assert.equal(stats.totals.handoffs, 1);
  assert.ok(stats.totals.tokens > 0); assert.equal(stats.days.length, 7);
  const stranger = await AI.user();
  assert.equal((await stranger.c('GET', `/api/conversations/${convs[0].id}`)).status, 404);
  assert.equal((await stranger.c('POST', `/api/conversations/${convs[0].id}/reply`, { text: 'spam' })).status, 404);
});

test('auto-reply off: messages are stored but not answered; groups are ignored', async () => {
  const { u, token, say } = await live(AI);
  await u.c('POST', `/api/installations/${u.inst}/auto-reply`, { enabled: false });
  await say('Hello?');
  assert.equal(F.sent(token).length, 0);
  assert.equal((await u.c('GET', `/api/installations/${u.inst}/conversations`)).body.conversations[0].lastText, 'Hello?');
  await u.c('POST', `/api/installations/${u.inst}/auto-reply`, { enabled: true });
  await say('Hi from a group', { chatId: -100123, type: 'supergroup' });
  assert.equal(F.sent(token).length, 0);
});

test('FAQ mode (no AI key): answers clear FAQ matches in any word form, hands off the rest', async () => {
  const { u, token, say } = await live(FAQ);
  await u.c('POST', `/api/installations/${u.inst}/knowledge`, { kind: 'FAQ', title: 'Яка вартість доставки?', content: 'Доставка Новою поштою — 70 грн, від 2000 грн безкоштовно.' });
  await u.c('POST', `/api/installations/${u.inst}/knowledge`, { kind: 'FAQ', title: 'Where is your store in Kyiv?', content: 'Khreshchatyk 10, open 10:00–20:00.' });
  const opts = (await u.c('GET', `/api/installations/${u.inst}`)).body.options;
  assert.equal(opts.aiEnabled, false);
  await say('Скільки коштує доставка?');
  assert.equal(F.sent(token).at(-1).text, 'Доставка Новою поштою — 70 грн, від 2000 грн безкоштовно.');
  await say('what are your opening hours for the kyiv store?', { chatId: 222 });
  assert.equal(F.sent(token).at(-1).text, 'Khreshchatyk 10, open 10:00–20:00.');
  await say('Do you sell gift cards?', { chatId: 333 });
  assert.match(F.sent(token).at(-1).text, /передал ваш вопрос менеджеру/);
  await say('Хочу замовити, мій номер 067 123 45 67', { chatId: 444 });
  const leads = (await u.c('GET', `/api/installations/${u.inst}/leads`)).body.leads;
  assert.equal(leads.length, 1); assert.equal(leads[0].phone, '0671234567');
  const convs = (await u.c('GET', `/api/installations/${u.inst}/conversations`)).body.conversations;
  assert.equal(convs.filter(c => c.status === 'handoff').length, 2);
});

test('test chat works without any channel and changes nothing', async () => {
  const u = await FAQ.customerWithAgent('business-assistant');
  await u.c('POST', `/api/installations/${u.inst}/knowledge`, { kind: 'FAQ', title: 'When is payday?', content: 'Salaries are paid on the 5th.' });
  const r = await u.c('POST', `/api/installations/${u.inst}/test`, { text: 'when is payday', history: [] });
  assert.equal(r.status, 200); assert.equal(r.body.reply, 'Salaries are paid on the 5th.'); assert.equal(r.body.mode, 'faq');
  const r2 = await u.c('POST', `/api/installations/${u.inst}/test`, { text: 'call me +380671234567' });
  assert.ok(r2.body.actions.some(a => a.type === 'lead') === false);                                   // business assistant has no lead tool
  assert.equal(FAQ.db.prepare('SELECT COUNT(*) AS n FROM leads WHERE installation_id = ?').get(u.inst).n, 0);
  const kid = (await u.c('GET', `/api/installations/${u.inst}/knowledge`)).body.items[0].id;
  const stranger = await FAQ.user();
  assert.equal((await stranger.c('POST', `/api/knowledge/${kid}/delete`, {})).status, 404);
  assert.equal((await u.c('POST', `/api/knowledge/${kid}/delete`, {})).status, 200);
  assert.equal(FAQ.db.prepare('SELECT COUNT(*) AS n FROM knowledge_chunks WHERE installation_id = ?').get(u.inst).n, 0);
});

test('failures: blocked bot is not retried forever; AI outage retries; admin sees it', async () => {
  const { u, token, say } = await live(AI);
  F.blocked.add('7777');
  F.setAi(() => ({ content: 'hi' }));
  await say('hello', { chatId: 7777 });
  const job = AI.db.prepare("SELECT * FROM jobs WHERE kind = 'reply' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(job.status, 'failed'); assert.equal(job.attempts, 1); assert.match(job.last_error, /blocked/);

  F.setAi(() => { throw new Error('boom'); });                                                          // fake returns 500
  await say('are you there?', { chatId: 8888 });
  const j2 = AI.db.prepare("SELECT * FROM jobs WHERE kind = 'reply' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(j2.status, 'queued'); assert.equal(j2.attempts, 1);                                      // will retry later
  const rt = (await AI.adminClient().c('GET', '/api/admin/runtime')).body;
  assert.ok(rt.failedJobs.some(j => /blocked/.test(j.error)));
  assert.equal(rt.aiMode, 'AI (test-model)');
  assert.equal((await u.c('GET', '/api/admin/runtime')).status, 403);
  F.setAi(() => ({ content: 'ok' }));
});
