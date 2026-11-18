// Browser test. Run from the app folder:  node tests/browser/04-instagram.mjs   (needs: npm i -D playwright && npx playwright install chromium)
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const SHOTS = path.join(os.tmpdir(), 'neuraldesk-shots'); fs.mkdirSync(SHOTS, { recursive: true });
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { totp } from '../../server/auth.js';
import { startFakes } from '../fakes.js';
const { chromium } = await import('playwright');
const APP = fileURLToPath(new URL('../..', import.meta.url)), F = await startFakes(), B = 'http://localhost:3920', IG = '17841400000000777';
F.igConsent.redirectTo = `${B}/api/oauth/instagram/callback`; F.igConsent.code = 'consent-code-1'; F.igAccount('consent-code-1', IG, 'linen.store');
F.igProfile('IGSID_ANNA', 'Anna Melnyk', 'anna.m');
F.setAi(b => { const l = b.messages.at(-1); if (l.role === 'tool') return { content: 'Our manager will reply here shortly.' };
  return /return|refund/i.test(l.content) ? { tool_calls: [{ name: 'handoff_to_human', args: { reason: 'Return request' } }] } : { content: 'Yes! The beige linen dress in S is in stock: 2100 UAH.' }; });
const env = { ...process.env, PORT: '3920', DATABASE_FILE: path.join(os.tmpdir(), 'e2e5b-04-instagram.db'), ENCRYPTION_KEY: Buffer.alloc(32, 3).toString('base64'), TELEGRAM_API_BASE: F.base,
  OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: `${F.base}/v1`, INSTAGRAM_APP_ID: '990602627938098', INSTAGRAM_APP_SECRET: F.IG_SECRET, INSTAGRAM_VERIFY_TOKEN: 'verify-me',
  INSTAGRAM_OAUTH_BASE: F.base, INSTAGRAM_API_BASE: F.base, INSTAGRAM_GRAPH_BASE: F.base, PUBLIC_URL: 'https://platform.example.com' };
for (const f of [env.DATABASE_FILE, env.DATABASE_FILE + '-wal', env.DATABASE_FILE + '-shm']) fs.rmSync(f, { force: true });
const srv = spawn('node', ['server/index.js'], { env, cwd: APP }); let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
await new Promise(r => setTimeout(r, 1000));
const errs = [], ok = m => console.log('✓', m);
const api = async (cookie, method, p, body) => { const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) }); return { cookie: r.headers.getSetCookie()[0]?.split(';')[0], body: await r.json() }; };
const hook = async obj => { const raw = JSON.stringify(obj); return fetch(B + '/api/webhooks/instagram', { method: 'POST', body: raw, headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': 'sha256=' + crypto.createHmac('sha256', F.IG_SECRET).update(raw).digest('hex') } }); };
const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise(r => setTimeout(r, 200)); } throw new Error('timed out waiting'); };
const b = await chromium.launch();
try {
  const cu = await api(null, 'POST', '/api/auth/register', { name: 'Olena Linen', email: 'olena@linen.example', password: 'olena-password-1' });
  const ad = await api(null, 'POST', '/api/auth/register', { name: 'Danya Admin', email: 'danya@example.com', password: 'danya-password-1' });
  const sec = (await api(ad.cookie, 'POST', '/api/account/2fa/setup', {})).body.secret; await api(ad.cookie, 'POST', '/api/account/2fa/enable', { code: totp(sec) });
  execFileSync('node', ['server/cli.js', 'make-admin', 'danya@example.com'], { env, cwd: APP });
  const ag = (await api(cu.cookie, 'GET', '/api/agents/instagram-assistant')).body.agent;
  const order = (await api(cu.cookie, 'POST', '/api/orders', { priceId: ag.plans[0].prices[0].id })).body.order;
  await api(ad.cookie, 'POST', `/api/admin/orders/${order.id}/status`, { status: 'PAID' });

  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
  p.on('pageerror', e => errs.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errs.push('console: ' + m.text()); });
  await p.goto(B + '/login.html'); await p.fill('#email', 'olena@linen.example'); await p.fill('#password', 'olena-password-1'); await p.click('button[type=submit]');
  await p.waitForURL('**/dashboard.html'); await p.click('[data-my-agents] button:text("Настроить")'); await p.waitForURL('**/setup.html?id=*');
  await p.waitForSelector('h3:text("Подключите аккаунт Instagram")');
  if (await p.$('h3:text("Подключите Telegram-бота")')) throw new Error('Telegram card shown for an Instagram-only agent');
  await p.waitForSelector('text=мы сразу пишем вам на email'); ok('Instagram agent: Instagram card only; alerts go by email');
  await p.screenshot({ path: SHOTS + '/s5b-before.png', fullPage: true });
  await p.click('button:text("Подключить Instagram")');
  await p.waitForURL(/setup\.html\?id=[\w-]+#connect$/); await p.waitForSelector('[data-flash]:text("Instagram подключён")');
  await p.waitForSelector('.kv b:text("@linen.store")'); await p.waitForSelector('text=продлевается автоматически');
  if (p.url().includes('ig=')) throw new Error('status left in URL');
  ok('Connect Instagram → Instagram login → back with @linen.store connected');
  await p.screenshot({ path: SHOTS + '/s5b-connected.png', fullPage: true });

  F.igConsent.deny = true; await p.click('button:text("Переподключить")');
  await p.waitForSelector('[data-flash].err:text("отменён")'); await p.waitForSelector('.kv b:text("@linen.store")');
  ok('cancelling on Instagram shows a clear message and keeps the existing connection'); F.igConsent.deny = false;

  await p.click('.switch-btn'); await p.waitForSelector('.live-box b:text("Работает")'); ok('automatic replies on');
  const ev = (from, text, mid) => ({ object: 'instagram', entry: [{ id: IG, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: IG }, timestamp: Date.now(), message: { mid, text } }] }] });
  await hook(ev('IGSID_ANNA', 'Is the beige linen dress available in S?', 'in-1'));
  await waitFor(() => F.igSent.some(m => m.recipient === 'IGSID_ANNA' && /2100 UAH/.test(m.text))); ok('customer DM answered through the Instagram API');
  await hook(ev('IGSID_ANNA', 'Actually, how do I return my last order?', 'in-2'));
  await waitFor(() => F.igSent.some(m => /manager will reply/.test(m.text)));
  await waitFor(async () => (await (await fetch(B + '/api/dev/outbox')).json()).emails.some(e => e.to_email === 'olena@linen.example' && /нужна ваша помощь/.test(e.subject)));
  ok('return request handed to a person; owner emailed');

  await p.click('.tabs a[href="#conversations"]'); await p.waitForSelector('.conv b:text("Anna Melnyk")'); await p.click('.conv');
  await p.waitForSelector('.inbox-thread small:text("@anna.m · INSTAGRAM")');
  await p.fill('.inbox-thread .chat-input input', 'Hi Anna! Send it back via Nova Poshta, we cover the cost.'); await p.click('.inbox-thread .chat-input button');
  await waitFor(() => F.igSent.some(m => m.text.startsWith('Hi Anna! Send it back'))); await p.waitForSelector('.msg.human');
  ok('owner replied from the dashboard; sent as an Instagram DM');
  await p.screenshot({ path: SHOTS + '/s5b-inbox.png' });

  // Meta data-deletion callback → status page
  const pl = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 'IGSID_ANNA' })).toString('base64url');
  const sr = `${crypto.createHmac('sha256', F.IG_SECRET).update(pl).digest('base64url')}.${pl}`;
  const del = await (await fetch(B + '/api/oauth/instagram/data-deletion', { method: 'POST', body: `signed_request=${sr}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).json();
  const pub = await (await b.newContext()).newPage(); await pub.goto(B + new URL(del.url).pathname + new URL(del.url).search);
  await pub.waitForSelector('[data-msg]:text("Готово.")'); ok('data-deletion status page confirms deletion');
  await p.reload(); await p.waitForSelector('.tabs a.on'); await p.click('.tabs a[href="#conversations"]'); await p.waitForSelector('text=Сообщений пока нет'); ok("customer's conversation removed from the inbox");

  const m = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage(); await m.context().addCookies(await ctx.cookies());
  await m.goto(`${B}/setup.html?id=${new URL(p.url()).searchParams.get('id')}#connect`); await m.waitForSelector('.kv'); 
  if (await m.evaluate(() => document.documentElement.scrollWidth > innerWidth)) errs.push('connect tab overflows on mobile');
  ok('connect tab fits on a phone');
} catch (e) { errs.push('FAIL: ' + e.message.split('\n')[0]); }
await b.close(); srv.kill(); F.close();
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') + '\n--- server log:\n' + log : 'E2E PASSED');
if (errs.length) process.exitCode = 1;
