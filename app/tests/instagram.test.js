import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startServer } from './helpers.js';
import { startFakes } from './fakes.js';
import { splitBytes } from '../server/channels/instagram.js';

let F, S, OFF;
const IG_ID = '17841400000000001';
before(async () => {
  F = await startFakes();
  const ig = { INSTAGRAM_APP_ID: '990602627938098', INSTAGRAM_APP_SECRET: F.IG_SECRET, INSTAGRAM_VERIFY_TOKEN: 'verify-me-123',
    INSTAGRAM_OAUTH_BASE: F.base, INSTAGRAM_API_BASE: F.base, INSTAGRAM_GRAPH_BASE: F.base, PUBLIC_URL: 'https://platform.example.com' };
  S = await startServer({ env: { ...ig, TELEGRAM_API_BASE: F.base, OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: `${F.base}/v1` } });
  OFF = await startServer({ env: { TELEGRAM_API_BASE: F.base } });
});
after(() => { S.close(); OFF.close(); F.close(); });

// Raw request helper (no cookie jar) for Meta → platform calls.
const meta = (path, { method = 'POST', body, headers = {} } = {}) => fetch(S.base + path, { method, body, headers, redirect: 'manual' });
const sign = raw => 'sha256=' + crypto.createHmac('sha256', F.IG_SECRET).update(raw).digest('hex');
const webhook = obj => { const raw = JSON.stringify(obj); return meta('/api/webhooks/instagram', { body: raw, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(raw) } }); };
const signedRequest = payload => { const p = Buffer.from(JSON.stringify(payload)).toString('base64url'); return `${crypto.createHmac('sha256', F.IG_SECRET).update(p).digest('base64url')}.${p}`; };
const runDelayedJobs = async () => { S.db.prepare("UPDATE jobs SET run_at = ? WHERE status = 'queued'").run(new Date(0).toISOString()); await S.engine.queue.drain(); };

// Goes through Meta login with the fake and returns the redirect location.
async function login(u, igId, username, code = `code-${igId}-${Math.random()}`, permissions) {
  F.igAccount(code, igId, username, permissions);
  const { url } = (await u.c('GET', `/api/installations/${u.inst}/instagram/connect`)).body;
  const state = new URL(url).searchParams.get('state');
  return u.c('GET', `/api/oauth/instagram/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`);
}

test('byte-safe splitting keeps every part under Meta\'s 1000-byte limit', () => {
  const ua = 'Привіт! '.repeat(300);                                   // ~4.5 KB of Cyrillic
  const parts = splitBytes(ua);
  assert.ok(parts.length >= 4);
  assert.ok(parts.every(p => Buffer.byteLength(p) <= 1000));
  assert.equal(parts.join(' ').replace(/\s+/g, ' '), ua.trim().replace(/\s+/g, ' '));
  assert.deepEqual(splitBytes('short'), ['short']);
});

test('not configured → clearly unavailable', async () => {
  const u = await OFF.customerWithAgent('instagram-assistant');
  const d = (await u.c('GET', `/api/installations/${u.inst}`)).body;
  assert.equal(d.options.instagramReady, false);
  assert.deepEqual(d.options.channels, ['INSTAGRAM']);
  assert.equal((await u.c('GET', `/api/installations/${u.inst}/instagram/connect`)).status, 503);
});

test('Instagram login: official authorize URL, state checks, long-lived encrypted token, webhook subscription', async () => {
  const tgOnly = await S.customerWithAgent('telegram-assistant');
  assert.equal((await tgOnly.c('GET', `/api/installations/${tgOnly.inst}/instagram/connect`)).status, 400);

  const u = await S.customerWithAgent('instagram-assistant');
  const { url } = (await u.c('GET', `/api/installations/${u.inst}/instagram/connect`)).body;
  const a = new URL(url);
  assert.equal(a.pathname, '/oauth/authorize');
  assert.equal(a.searchParams.get('client_id'), '990602627938098');
  assert.equal(a.searchParams.get('redirect_uri'), 'https://platform.example.com/api/oauth/instagram/callback');
  assert.equal(a.searchParams.get('scope'), 'instagram_business_basic,instagram_business_manage_messages');
  assert.equal(a.searchParams.get('response_type'), 'code');
  const state = a.searchParams.get('state');
  assert.ok(state.length >= 30);

  const cb = qs => `/api/oauth/instagram/callback?${qs}`;
  assert.match((await meta(cb(`code=x&state=${state}`), { method: 'GET' })).headers.get('location'), /login\.html/); // no session
  const stranger = await S.user();
  assert.equal((await stranger.c('GET', cb(`code=x&state=${state}`))).status, 302);                                  // other account: refused
  assert.equal(S.db.prepare("SELECT COUNT(*) AS n FROM channel_connections WHERE channel = 'INSTAGRAM'").get().n, 0);
  const bad = await fetch(S.base + cb('code=x&state=forged'), { headers: { Cookie: '' }, redirect: 'manual' });
  assert.equal(bad.status, 302);

  // User cancels on Instagram's page
  const cancelled = await u.c('GET', cb(`error=access_denied&error_reason=user_denied&state=${state}`));
  assert.equal(cancelled.status, 302);
  assert.match(decodeURIComponent(cancelled.location), new RegExp(`setup\\.html\\?id=${u.inst}&ig=error&msg=Вход в Instagram отменён`));
  const loc0 = await fetch(S.base + cb(`error=access_denied&state=${state}`), { redirect: 'manual' }); // state already used
  assert.equal(loc0.status, 302);

  // Success
  const ok = await login(u, IG_ID, 'hoodie.shop');
  assert.equal(ok.status, 302);
  assert.equal(ok.location, `/setup.html?id=${u.inst}&ig=connected#connect`);
  const conn = S.db.prepare("SELECT * FROM channel_connections WHERE installation_id = ? AND channel = 'INSTAGRAM'").get(u.inst);
  assert.equal(conn.external_id, IG_ID);                                  // the professional account id from /me, not the app-scoped one
  assert.equal(conn.display_name, '@hoodie.shop');
  assert.ok(!conn.credentials_enc.includes('long-'));                     // encrypted
  assert.ok(Date.parse(conn.token_expires_at) - Date.now() > 59 * 86400e3);
  assert.ok(F.igCalls.some(c => c.path.endsWith('/me/subscribed_apps')));
  const view = (await u.c('GET', `/api/installations/${u.inst}`)).body.installation;
  assert.equal(view.connections[0].name, '@hoodie.shop');
  assert.ok(!JSON.stringify(view).includes('long-'));

  // Missing message permission, and the same account on another agent
  const v = await S.customerWithAgent('sales-agent');
  const noperm = await login(v, '17841400000000099', 'noperm', undefined, 'instagram_business_basic');
  assert.match(decodeURIComponent(noperm.location), /Разрешите доступ к сообщениям/);
  assert.equal(S.db.prepare('SELECT COUNT(*) AS n FROM channel_connections WHERE installation_id = ?').get(v.inst).n, 0);
  const dup = await login(v, IG_ID, 'hoodie.shop');
  assert.match(decodeURIComponent(dup.location), /уже подключён к другому агенту/);
  assert.equal(S.db.prepare('SELECT COUNT(*) AS n FROM channel_connections WHERE installation_id = ?').get(v.inst).n, 0);
});

test('webhook: verification handshake and signature check', async () => {
  const v = p => meta(`/api/webhooks/instagram?${p}`, { method: 'GET' });
  assert.equal((await v('hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123')).status, 403);
  const r = await v('hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=1158201444');
  assert.equal(r.status, 200); assert.equal(await r.text(), '1158201444');
  const raw = JSON.stringify(F.igEvent(IG_ID, 'cust1', IG_ID, 'hi'));
  assert.equal((await meta('/api/webhooks/instagram', { body: raw, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + 'a'.repeat(64) } })).status, 403);
  assert.equal((await meta('/api/webhooks/instagram', { body: raw, headers: { 'Content-Type': 'application/json' } })).status, 403);
});

test('DMs: AI replies through the Graph API, echoes recognised, owner replies in the app pause the AI', async () => {
  const u = await S.customerWithAgent('instagram-assistant');
  const igId = '17841400000000002';
  await login(u, igId, 'linen.store');
  assert.equal((await u.c('POST', `/api/installations/${u.inst}/auto-reply`, { enabled: true })).status, 200);
  await u.c('POST', `/api/installations/${u.inst}/knowledge`, { kind: 'FAQ', title: 'Beige linen dress price?', content: '2100 UAH, free delivery over 2000 UAH.' });
  F.igProfile('IGSID_ANNA', 'Anna Melnyk', 'anna.m');
  F.setAi(() => ({ content: 'Yes! The beige linen dress is 2100 UAH with free delivery.' }));

  assert.equal((await webhook(F.igEvent(igId, 'IGSID_ANNA', igId, 'Is the beige linen dress available?', { mid: 'in-1' }))).status, 200);
  assert.equal((await webhook(F.igEvent(igId, 'IGSID_ANNA', igId, 'Is the beige linen dress available?', { mid: 'in-1' }))).status, 200); // Meta retry
  await S.engine.queue.drain();
  const sent = F.igSent.filter(m => m.recipient === 'IGSID_ANNA');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, 'Yes! The beige linen dress is 2100 UAH with free delivery.');
  const sys = F.aiRequests.at(-1).messages[0].content;
  assert.match(sys, /Instagram Direct/); assert.match(sys, /2100 UAH/);
  let conv = (await u.c('GET', `/api/installations/${u.inst}/conversations`)).body.conversations[0];
  assert.deepEqual([conv.name, conv.handle, conv.channel], ['Anna Melnyk', '@anna.m', 'INSTAGRAM']);

  // Meta echoes our own message back: recognised by id, nothing changes.
  await webhook(F.igEvent(igId, igId, 'IGSID_ANNA', sent[0].text, { mid: sent[0].mid, echo: true }));
  await runDelayedJobs();
  conv = (await u.c('GET', `/api/conversations/${conv.id}`)).body;
  assert.equal(conv.conversation.status, 'open');
  assert.equal(conv.messages.filter(m => m.author === 'human').length, 0);

  // The owner answers from the Instagram app: shown as a person's reply, AI pauses in that chat.
  await webhook(F.igEvent(igId, igId, 'IGSID_ANNA', 'Hi Anna, it\'s Olena from the shop 🙂', { mid: 'owner-1', echo: true }));
  await runDelayedJobs();
  conv = (await u.c('GET', `/api/conversations/${conv.conversation.id}`)).body;
  assert.equal(conv.conversation.status, 'handoff');
  assert.equal(conv.messages.at(-1).author, 'human');
  const before = F.aiRequests.length;
  await webhook(F.igEvent(igId, 'IGSID_ANNA', igId, 'Great, thanks!', { mid: 'in-2' }));
  await S.engine.queue.drain();
  assert.equal(F.aiRequests.length, before);

  // Human reply from the dashboard goes out via the API and its echo is ignored.
  assert.equal((await u.c('POST', `/api/conversations/${conv.conversation.id}/reply`, { text: 'Sending the dress today!' })).status, 200);
  const mine = F.igSent.at(-1);
  assert.equal(mine.text, 'Sending the dress today!');
  await webhook(F.igEvent(igId, igId, 'IGSID_ANNA', mine.text, { mid: mine.mid, echo: true }));
  await runDelayedJobs();
  assert.equal((await u.c('GET', `/api/conversations/${conv.conversation.id}`)).body.messages.filter(m => m.text === 'Sending the dress today!').length, 1);

  // Long AI answer is split into parts under 1000 bytes, each stored.
  await u.c('POST', `/api/conversations/${conv.conversation.id}/resolve`, {});
  F.setAi(() => ({ content: 'Розмірна сітка: '.repeat(80) }));
  await webhook(F.igEvent(igId, 'IGSID_ANNA', igId, 'Розмірна сітка?', { mid: 'in-3' }));
  await S.engine.queue.drain();
  const parts = F.igSent.filter(m => m.text.startsWith('Розмірна'));
  assert.ok(parts.length >= 2 && parts.every(p => Buffer.byteLength(p.text) <= 1000));

  // 24-hour rule: replying to an old conversation is refused with a clear reason.
  S.db.prepare("UPDATE messages SET created_at = ? WHERE conversation_id = ? AND direction = 'IN'").run(new Date(Date.now() - 25 * 3600e3).toISOString(), conv.conversation.id);
  const late = await u.c('POST', `/api/conversations/${conv.conversation.id}/reply`, { text: 'Are you still interested?' });
  assert.equal(late.status, 502); assert.match(late.body.error, /24 часов/);

  // Messages for an account nobody connected are ignored.
  assert.equal((await webhook(F.igEvent('999', 'x', '999', 'hello'))).status, 200);
});

test('handoff without a Telegram manager emails the owner', async () => {
  const u = await S.customerWithAgent('support-agent');
  const igId = '17841400000000003';
  await login(u, igId, 'support.desk');
  await u.c('POST', `/api/installations/${u.inst}/auto-reply`, { enabled: true });
  F.setAi(b => b.messages.at(-1).role === 'tool' ? { content: 'A colleague will reply shortly.' } : { tool_calls: [{ name: 'handoff_to_human', args: { reason: 'Refund request', category: 'billing' } }] });
  await webhook(F.igEvent(igId, 'IGSID_BOB', igId, 'I want a refund now', { mid: 'r-1' }));
  await S.engine.queue.drain();
  const mail = S.db.prepare("SELECT * FROM outbox WHERE to_email = ? AND subject LIKE 'Клиенту нужна ваша помощь%'").get(u.email);
  assert.ok(mail, 'owner email missing');
  assert.match(mail.body, /в Instagram нужен живой человек/); assert.match(mail.body, /billing: Refund request/);
  assert.match(mail.body, new RegExp(`setup\\.html\\?id=${u.inst}#conversations`));
});

test('token refresh, Meta deauthorize and data-deletion callbacks, disconnect', async () => {
  const u = await S.customerWithAgent('instagram-assistant');
  const igId = '17841400000000004';
  await login(u, igId, 'refresh.me');
  const c0 = S.db.prepare("SELECT * FROM channel_connections WHERE external_id = ?").get(igId);
  // Not yet due → untouched
  assert.equal(await S.engine.refreshInstagramTokens(), 0);
  S.db.prepare('UPDATE channel_connections SET token_expires_at = ?, token_refreshed_at = ? WHERE id = ?').run(new Date(Date.now() + 10 * 86400e3).toISOString(), new Date(Date.now() - 2 * 86400e3).toISOString(), c0.id);
  assert.equal(await S.engine.refreshInstagramTokens(), 1);
  const c1 = S.db.prepare('SELECT * FROM channel_connections WHERE id = ?').get(c0.id);
  assert.notEqual(c1.credentials_enc, c0.credentials_enc);
  assert.ok(Date.parse(c1.token_expires_at) - Date.now() > 59 * 86400e3);
  assert.ok(F.igCalls.some(c => c.path === '/refresh_access_token' && c.query.grant_type === 'ig_refresh_token'));
  // Revoked token → visible error with a reconnect date
  for (const [t, acc] of F.igTokens) if (acc.igId === igId) F.igTokens.delete(t);
  S.db.prepare('UPDATE channel_connections SET token_expires_at = ?, token_refreshed_at = ? WHERE id = ?').run(new Date(Date.now() + 5 * 86400e3).toISOString(), new Date(Date.now() - 2 * 86400e3).toISOString(), c0.id);
  await S.engine.refreshInstagramTokens();
  assert.match(S.db.prepare('SELECT last_error FROM channel_connections WHERE id = ?').get(c0.id).last_error, /Переподключите Instagram/);

  // Deauthorize (person removed the app in Instagram settings)
  const form = sr => ({ method: 'POST', body: `signed_request=${encodeURIComponent(sr)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  assert.equal((await meta('/api/oauth/instagram/deauthorize', form('bad.sig'))).status, 400);
  assert.equal((await meta('/api/oauth/instagram/deauthorize', form(signedRequest({ algorithm: 'HMAC-SHA256', user_id: igId })))).status, 200);
  assert.equal(S.db.prepare("SELECT COUNT(*) AS n FROM channel_connections WHERE external_id = ?").get(igId).n, 0);

  // Data deletion request from a customer who messaged a shop
  const w = await S.customerWithAgent('instagram-assistant');
  const shop = '17841400000000005';
  await login(w, shop, 'del.shop');
  await w.c('POST', `/api/installations/${w.inst}/auto-reply`, { enabled: true });
  F.setAi(() => ({ content: 'Hello!' }));
  await webhook(F.igEvent(shop, 'IGSID_ERASE', shop, 'hi', { mid: 'd-1' }));
  await S.engine.queue.drain();
  assert.equal(S.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE external_chat_id = 'IGSID_ERASE'").get().n, 1);
  const del = await meta('/api/oauth/instagram/data-deletion', form(signedRequest({ algorithm: 'HMAC-SHA256', user_id: 'IGSID_ERASE' })));
  const dj = await del.json();
  assert.match(dj.url, /^https:\/\/platform\.example\.com\/deletion\.html\?code=[A-F0-9]{16}$/);
  assert.equal(S.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE external_chat_id = 'IGSID_ERASE'").get().n, 0);
  assert.equal((await (await fetch(`${S.base}/api/deletion/${dj.confirmation_code}`)).json()).status, 'completed');

  // Disconnect from the dashboard turns auto-reply off when no channel is left
  assert.equal((await w.c('POST', `/api/installations/${w.inst}/instagram/disconnect`, {})).status, 200);
  const after = (await w.c('GET', `/api/installations/${w.inst}`)).body.installation;
  assert.equal(after.connections.length, 0); assert.equal(after.autoReply, false);
});
