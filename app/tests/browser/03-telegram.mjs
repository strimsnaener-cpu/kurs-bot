// Browser test. Run from the app folder:  node tests/browser/03-telegram.mjs   (needs: npm i -D playwright && npx playwright install chromium)
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const SHOTS = path.join(os.tmpdir(), 'neuraldesk-shots'); fs.mkdirSync(SHOTS, { recursive: true });
import { spawn, execFileSync } from 'node:child_process';
import { totp } from '../../server/auth.js';
import { startFakes } from '../fakes.js';
const { chromium } = await import('playwright');
const APP = fileURLToPath(new URL('../..', import.meta.url)), F = await startFakes();
const TOKEN = `7123456789:AAH${'k'.repeat(32)}`; F.addBot(TOKEN, 7123456789, 'hoodieshop_bot');
F.setAi(body => {
  const last = body.messages.at(-1);
  if (last.role === 'tool') return { content: body.messages.at(-2).tool_calls?.[0]?.function.name === 'save_lead' ? 'Thanks, Ivan! I saved your number.' : "I've asked our manager to join. They'll reply here shortly." };
  if (/manager|bulk/i.test(last.content)) return { tool_calls: [{ name: 'handoff_to_human', args: { reason: 'Bulk order request' } }] };
  if (/\+380/.test(last.content)) return { tool_calls: [{ name: 'save_lead', args: { name: 'Ivan', phone: '+380671234567', note: 'Grey hoodie M' } }] };
  return { content: `Sure! The grey hoodie is 1450 UAH. (answer to: ${last.content})` };
});
const env = { ...process.env, PORT: '3919', DATABASE_FILE: path.join(os.tmpdir(), 'e2e5-03-telegram.db'), ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'), TELEGRAM_API_BASE: F.base, OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: `${F.base}/v1`, OPENAI_MODEL: 'gpt-test' };
for (const f of [env.DATABASE_FILE, env.DATABASE_FILE + '-wal', env.DATABASE_FILE + '-shm']) fs.rmSync(f, { force: true });
const srv = spawn('node', ['server/index.js'], { env, cwd: APP }); let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
await new Promise(r => setTimeout(r, 1000));
const B = 'http://localhost:3919', errs = [], ok = m => console.log('✓', m);
const api = async (cookie, method, p, body) => { const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body && JSON.stringify(body) }); return { cookie: r.headers.getSetCookie()[0]?.split(';')[0], body: await r.json() }; };
const waitFor = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 200)); } throw new Error('timed out waiting'); };
const b = await chromium.launch();
try {
  // Setup through the API: customer buys, admin confirms payment.
  const cu = await api(null, 'POST', '/api/auth/register', { name: 'Olena Shop', email: 'olena@example.com', password: 'olena-password-1' });
  const ad = await api(null, 'POST', '/api/auth/register', { name: 'Danya Admin', email: 'danya@example.com', password: 'danya-password-1' });
  const sec = (await api(ad.cookie, 'POST', '/api/account/2fa/setup', {})).body.secret; await api(ad.cookie, 'POST', '/api/account/2fa/enable', { code: totp(sec) });
  execFileSync('node', ['server/cli.js', 'make-admin', 'danya@example.com'], { env, cwd: APP });
  const ag = (await api(cu.cookie, 'GET', '/api/agents/telegram-assistant')).body.agent;
  const order = (await api(cu.cookie, 'POST', '/api/orders', { priceId: ag.plans[0].prices[0].id })).body.order;
  await api(ad.cookie, 'POST', `/api/admin/orders/${order.id}/status`, { status: 'PAID' });

  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const p = await ctx.newPage();
  p.on('pageerror', e => errs.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errs.push('console: ' + m.text()); });
  await p.goto(B + '/login.html'); await p.fill('#email', 'olena@example.com'); await p.fill('#password', 'olena-password-1'); await p.click('button[type=submit]');
  await p.waitForURL('**/dashboard.html'); await p.click('[data-my-agents] button:text("Настроить")'); await p.waitForURL('**/setup.html?id=*');
  await p.waitForSelector('h3:text("Подключите Telegram-бота")'); ok('My agents → Set up opens the agent setup');
  await p.fill('#token', 'not-a-token'); await p.click('button:text("Подключить бота")'); await p.waitForSelector('.alert.err:not([hidden])'); ok('bad token rejected with explanation');
  await p.fill('#token', TOKEN); await p.click('button:text("Подключить бота")'); await p.waitForSelector('[data-flash]:text("Подключён @hoodieshop_bot")');
  await p.waitForSelector('text=Опрос (проверка каждую секунду)'); const code = (await p.textContent('.code')).trim().replace('/manager ', ''); ok(`bot connected (polling mode); manager code shown: ${code}`);
  await p.screenshot({ path: SHOTS + '/s5-connect.png', fullPage: true });

  await p.click('.tabs a[href="#behavior"]'); await p.fill('#b-businessName', 'Hoodie Shop'); await p.fill('#b-assistantName', 'Olya'); await p.selectOption('#b-language', 'uk');
  await p.click('button:text("Сохранить")'); await p.waitForSelector('[data-flash]:text("Сохранено")'); ok('behavior saved (name, assistant, language)');
  await p.click('.tabs a[href="#knowledge"]'); await p.fill('#k-q', 'How much is delivery?'); await p.fill('#k-a', 'Nova Poshta delivery is 70 UAH.'); await p.click('form:has(#k-q) button[type=submit]');
  await p.waitForSelector('.kb-item b:text("How much is delivery?")');
  await p.setInputFiles('input[type=file]', { name: 'returns.txt', mimeType: 'text/plain', buffer: Buffer.from('Returns are accepted within 14 days with a receipt.') });
  await p.waitForFunction(() => document.querySelector('#k-t').value === 'returns'); await p.click('button:text("Добавить документ")');
  await p.waitForSelector('.kb-item b:text("returns")'); ok('FAQ added and a .txt document loaded into knowledge');

  await p.click('.tabs a[href="#test"]'); await p.fill('.chat-input input', 'How much is the grey hoodie?'); await p.click('.chat-input button');
  await p.waitForSelector('.msg.out:has-text("1450 UAH")');
  const sys = F.aiRequests.at(-1).messages[0].content; if (!/Hoodie Shop/.test(sys) || !/Ukrainian/.test(sys) || !/Olya/.test(sys)) throw new Error('settings not in prompt');
  ok('test chat answers; prompt uses Hoodie Shop / Olya / Ukrainian'); await p.screenshot({ path: SHOTS + '/s5-test.png' });
  if (F.sent(TOKEN).length) throw new Error('test chat sent something to Telegram');

  await p.click('.switch-btn'); await p.waitForSelector('.live-box b:text("Работает")'); ok('automatic replies switched on');
  // Manager pairs from Telegram; a customer writes.
  F.queueUpdate(TOKEN, F.update(`/manager ${code}`, { chatId: 900, first: 'Olena', username: 'olena_boss' }));
  await waitFor(() => F.sent(TOKEN).some(m => m.chat === '900' && /будут приходить уведомления/.test(m.text))); ok('manager paired from Telegram with /manager code');
  F.queueUpdate(TOKEN, F.update('/start')); F.queueUpdate(TOKEN, F.update('Hi, do you have hoodies?'));
  await waitFor(() => F.sent(TOKEN).some(m => m.chat === '5550001' && /1450 UAH/.test(m.text)));
  ok('quick /start + question → one reply to the latest message');
  F.queueUpdate(TOKEN, F.update('Great, I am Ivan, +380 67 123 45 67'));
  await waitFor(() => F.sent(TOKEN).some(m => m.chat === '5550001' && m.text === 'Thanks, Ivan! I saved your number.')); ok('lead message answered');
  F.queueUpdate(TOKEN, F.update('Can I talk to a manager about a bulk order?'));
  await waitFor(() => F.sent(TOKEN).some(m => m.chat === '900' && m.text.startsWith('🔔'))); ok('handoff: manager alerted in Telegram');

  await p.click('.tabs a[href="#conversations"]'); await p.waitForSelector('.conv .badge:text("Нужны вы")'); await p.click('.conv');
  await p.waitForSelector('.inbox-thread .alert.warn'); await p.fill('.inbox-thread .chat-input input', 'Hi Ivan! For 50+ pcs we give 10% off.'); await p.click('.inbox-thread .chat-input button');
  await waitFor(() => F.sent(TOKEN).some(m => m.text === 'Hi Ivan! For 50+ pcs we give 10% off.')); await p.waitForSelector('.msg.human');
  ok('owner replied as a person from the dashboard; customer received it');
  await p.screenshot({ path: SHOTS + '/s5-inbox.png' });
  await p.click('button:text("Вернуть AI")'); await p.waitForSelector('.inbox-thread .alert.warn', { state: 'detached' }); ok('conversation returned to AI');

  await p.click('.tabs a[href="#leads"]'); await p.waitForSelector('td:text("+380671234567")'); ok('lead saved with phone');
  await p.click('.tabs a[href="#stats"]'); await p.waitForSelector('.bars .bar-col'); const conv = await p.textContent('.stats div:first-child b'); if (conv !== '1') throw new Error('stats conversations ' + conv); ok('stats show 1 conversation and daily bars');
  await p.screenshot({ path: SHOTS + '/s5-stats.png' });

  const ap = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await ap.goto(B + '/login.html?next=admin.html'); await ap.fill('#email', 'danya@example.com'); await ap.fill('#password', 'danya-password-1'); await ap.click('button[type=submit]');
  await ap.waitForSelector('[data-2fa]:not([hidden])'); await ap.fill('#code', totp(sec, Date.now() + 30000)); await ap.click('button[type=submit]');
  await ap.waitForSelector('.kv b:text("1 / 1")'); await ap.waitForSelector('text=Ошибок доставки и каналов нет.'); ok('admin overview: 1 / 1 agents live, no errors');

  const m = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await m.context().addCookies(await ctx.cookies());
  for (const t of ['connect', 'conversations', 'test', 'stats']) { await m.goto(`${p.url().split('#')[0]}#${t}`); await m.waitForTimeout(500); if (await m.evaluate(() => document.documentElement.scrollWidth > innerWidth)) errs.push(`setup #${t} overflows on mobile`); }
  await m.screenshot({ path: SHOTS + '/s5-mobile.png', fullPage: true }); ok('setup tabs fit on a phone');
} catch (e) { errs.push('FAIL: ' + e.message.split('\n')[0]); for (const pg of b.contexts().flatMap(c => c.pages())) { await pg.screenshot({ path: SHOTS + '/fail-' + Math.random().toString(36).slice(2,6) + '.png' }).catch(()=>{}); errs.push('at ' + pg.url()); } }
await b.close(); srv.kill(); F.close();
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') + '\n--- server log:\n' + log : 'E2E PASSED');
if (errs.length) process.exitCode = 1;
