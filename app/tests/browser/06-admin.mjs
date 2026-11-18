// Browser test. Run from the app folder:  node tests/browser/06-admin.mjs   (needs: npm i -D playwright && npx playwright install chromium)
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const SHOTS = path.join(os.tmpdir(), 'neuraldesk-shots'); fs.mkdirSync(SHOTS, { recursive: true });
import { spawn, execFileSync } from 'node:child_process';
import { totp } from '../../server/auth.js';
const { chromium } = await import('playwright');
const APP = fileURLToPath(new URL('../..', import.meta.url)), B = 'http://localhost:3922';
const env = { ...process.env, PORT: '3922', DATABASE_FILE: path.join(os.tmpdir(), 'e2e7-06-admin.db'), ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
for (const f of [env.DATABASE_FILE, env.DATABASE_FILE + '-wal', env.DATABASE_FILE + '-shm']) fs.rmSync(f, { force: true });
const srv = spawn('node', ['server/index.js'], { env, cwd: APP }); let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
await new Promise(r => setTimeout(r, 1000));
const errs = [], ok = m => console.log('✓', m);
const watch = p => { p.on('pageerror', e => errs.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errs.push('console: ' + m.text()); }); };
const call = async (ck, method, p, body) => { const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) }, body: body && JSON.stringify(body) }); return { ck: r.headers.getSetCookie()[0]?.split(';')[0], body: await r.json().catch(() => ({})) }; };
const outbox = async () => (await (await fetch(B + '/api/dev/outbox')).json()).emails;
const b = await chromium.launch();
try {
  const ad = await call(null, 'POST', '/api/auth/register', { name: 'Danya Founder', email: 'danya@example.com', password: 'danya-password-1' });
  const sec = (await call(ad.ck, 'POST', '/api/account/2fa/setup', {})).body.secret; await call(ad.ck, 'POST', '/api/account/2fa/enable', { code: totp(sec) });
  execFileSync('node', ['server/cli.js', 'make-admin', 'danya@example.com'], { env, cwd: APP });

  const g = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(g);
  await g.goto(B + '/index.html'); await g.click('.foot-links a:text("Справка")'); await g.waitForSelector('#telegram h2'); ok('footer links work (Docs)');
  await g.click('.foot-links a:text("Цены")'); await g.waitForSelector('[data-agent-prices] .price-card');
  if ((await g.$$('[data-agent-prices] .price-card')).length !== 5) throw new Error('5 agents expected'); await g.waitForSelector('[data-academy-prices] .plan:has-text("VIP + Менторство")');
  ok('Pricing shows live agent and Academy prices'); await g.screenshot({ path: SHOTS + '/s7-pricing.png', fullPage: true });
  await g.click('a:text("Расскажите, что нужно")'); await g.waitForURL('**/contact.html?topic=custom');
  if (await g.inputValue('#category') !== 'CUSTOM') throw new Error('topic not preselected');
  await g.fill('#name', 'Olha Moroz'); await g.fill('#email', 'olha@clinic.example'); await g.fill('#subject', 'Booking bot for our clinic');
  await g.fill('#message', 'We need a Telegram bot that books appointments into Google Calendar.'); await g.click('button:text("Отправить")');
  await g.waitForSelector('[data-done] h2:has-text("получено")'); await g.click('a:text("Открыть обращение")');
  await g.waitForSelector('.msg:has-text("books appointments")'); if (/[?&]t=/.test(g.url())) throw new Error('token left in URL');
  ok('guest contact form → ticket → private thread (token hidden from address bar)');

  const a = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(a);
  await a.goto(B + '/login.html?next=admin.html'); await a.fill('#email', 'danya@example.com'); await a.fill('#password', 'danya-password-1'); await a.click('button[type=submit]');
  await a.waitForSelector('[data-2fa]:not([hidden])'); await a.fill('#code', totp(sec, Date.now() + 30000)); await a.click('button[type=submit]');
  await a.waitForURL('**/admin.html'); await a.waitForSelector('.bars.twelve .bar-col'); await a.waitForSelector('.stats b:text("1")');
  ok('admin overview: 12-month revenue chart and "1 support request waiting"'); await a.screenshot({ path: SHOTS + '/s7-overview.png', fullPage: true });
  await a.click('.tabs a[href="#support"]'); await a.waitForSelector('.inbox-thread h3:has-text("Booking bot")');
  await a.fill('.inbox-thread textarea', 'Yes, we can build that. Which calendar do your doctors use?'); await a.click('button:text("Отправить ответ")');
  await a.waitForSelector('[data-flash]:text("Ответ отправлен: olha@clinic.example")'); await a.waitForSelector('.inbox-thread .badge:text("Ждёт клиента")');
  ok('admin replies from Support');
  const re = (await outbox()).find(e => e.to_email === 'olha@clinic.example' && e.subject.startsWith('Re:'));
  await g.goto(re.body.match(/http\S+/)[0]); await g.waitForSelector('.msg:has-text("Which calendar")');
  await g.fill('#r', 'Google Calendar, three doctors.'); await g.click('button:text("Отправить")'); await g.waitForSelector('.msg:has-text("three doctors")');
  ok('customer opens the emailed link and replies');

  // Users: suspend a customer
  const cu = await call(null, 'POST', '/api/auth/register', { name: 'Spammy Seller', email: 'spammy@example.com', password: 'spammy-password-1' });
  const c = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(c);
  await c.goto(B + '/login.html'); await c.fill('#email', 'spammy@example.com'); await c.fill('#password', 'spammy-password-1'); await c.click('button[type=submit]'); await c.waitForURL('**/dashboard.html');
  await a.click('.tabs a[href="#users"]'); await a.fill('input[name=q]', 'spammy'); await a.click('button:text("Найти")');
  await a.click('tr:has-text("spammy@example.com") >> button:text("Открыть")'); await a.waitForSelector('h3:text("Spammy Seller")');
  await a.fill('input[placeholder^="Причина"]', 'Sending spam through the bot'); await a.click('button:text("Заблокировать аккаунт")');
  await a.waitForSelector('[data-flash]:text("заблокирован и разлогинен")'); await a.waitForSelector('.alert.err:has-text("Sending spam")');
  await c.reload(); await c.waitForURL('**/login.html'); await c.fill('#email', 'spammy@example.com'); await c.fill('#password', 'spammy-password-1'); await c.click('button[type=submit]');
  await c.waitForSelector('.alert.err:has-text("заблокирован")'); ok('suspended user is logged out and sees why they cannot log in');
  await a.click('button:text("Восстановить аккаунт")'); await a.waitForSelector('[data-flash]:text("Аккаунт восстановлен")'); ok('account restored');

  // Announcements
  await a.click('.tabs a[href="#announcements"]'); await a.waitForSelector('h3:text("Новое объявление")');
  await a.fill('input[name=title]', 'Telegram maintenance tonight'); await a.fill('textarea[name=body]', 'Replies may be delayed between 22:00 and 23:00 Kyiv time.');
  await a.selectOption('select[name=level]', 'IMPORTANT'); await a.click('button:text("Опубликовать")'); await a.waitForSelector('[data-flash]:text("Опубликовано")');
  await c.click('button[type=submit]').catch(() => {}); await c.goto(B + '/login.html'); await c.fill('#email', 'spammy@example.com'); await c.fill('#password', 'spammy-password-1'); await c.click('button[type=submit]');
  await c.waitForURL('**/dashboard.html'); await c.waitForSelector('.announce.important b:text("Telegram maintenance tonight")');
  await c.screenshot({ path: SHOTS + '/s7-banner.png' });
  await c.click('.announce button:text("Скрыть")'); await c.reload(); await c.waitForSelector('[data-name]'); await c.waitForTimeout(500);
  if (await c.$('.announce')) throw new Error('banner came back after dismiss'); ok('announcement banner shows on the dashboard and stays dismissed');

  await a.click('.tabs a[href="#performance"]'); await a.waitForSelector('h3:text("Установленные агенты, за 7 дней")');
  await a.click('.tabs a[href="#logs"]'); await a.waitForSelector('td.mono:text("admin.user_suspended")');
  await a.fill('input[name=action]', 'support.'); await a.click('button:text("Фильтр")');
  await a.waitForSelector('td.mono:text("admin.user_suspended")', { state: 'detached' }); await a.waitForSelector('td.mono:text("support.replied")'); ok('Agents live and Logs tabs; log filter works');

  // Support staff
  const st = await call(null, 'POST', '/api/auth/register', { name: 'Iryna Support', email: 'iryna@example.com', password: 'iryna-password-1' });
  const ss = (await call(st.ck, 'POST', '/api/account/2fa/setup', {})).body.secret; await call(st.ck, 'POST', '/api/account/2fa/enable', { code: totp(ss) });
  const uid = (await call(ad.ck, 'GET', '/api/admin/users?q=iryna')).body.users?.[0]?.id;
  const ap = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(ap);
  await a.click('.tabs a[href="#users"]'); await a.fill('input[name=q]', 'iryna'); await a.click('button:text("Найти")'); await a.click('tr:has-text("iryna@example.com") >> button:text("Открыть")');
  await a.selectOption('select[aria-label="Роль для iryna@example.com"]', 'SUPPORT');
  await a.click('button:text("Изменить роль")'); await a.waitForSelector('[data-flash]:text("роль «Поддержка»")');
  await ap.goto(B + '/login.html?next=admin.html'); await ap.fill('#email', 'iryna@example.com'); await ap.fill('#password', 'iryna-password-1'); await ap.click('button[type=submit]');
  await ap.waitForSelector('[data-2fa]:not([hidden])'); await ap.fill('#code', totp(ss, Date.now() + 30000)); await ap.click('button[type=submit]');
  await ap.waitForURL('**/admin.html'); await ap.waitForSelector('h1:text("Поддержка клиентов")'); await ap.waitForSelector('.inbox-thread h3:has-text("Booking bot")');
  if ((await ap.$$('.tabs a')).length !== 1) throw new Error('support staff sees more than Support'); ok('support staff see only the Support tab');

  const m = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  for (const f of ['pricing.html', 'docs.html', 'contact.html', 'about.html']) { await m.goto(`${B}/${f}`); await m.waitForTimeout(400); if (await m.evaluate(() => document.documentElement.scrollWidth > innerWidth)) errs.push(`${f} overflows on mobile`); }
  await m.context().addCookies(await a.context().cookies()); await m.goto(B + '/admin.html'); await m.waitForSelector('.bars.twelve'); await m.waitForTimeout(300);
  if (await m.evaluate(() => document.documentElement.scrollWidth > innerWidth)) errs.push('admin overview overflows on mobile: ' + await m.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1 && !e.closest('.tabs') && ![...e.children].some(c => c.getBoundingClientRect().right > innerWidth + 1)).slice(0, 8).map(e => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right) + ' ' + (e.textContent || '').slice(0, 40)).join(' | ')));
  ok('new pages and admin overview fit on a phone');
} catch (e) { errs.push('FAIL: ' + e.message.split('\n')[0]); for (const pg of b.contexts().flatMap(c => c.pages())) { await pg.screenshot({ path: SHOTS + '/fail7-' + Math.random().toString(36).slice(2, 6) + '.png' }).catch(() => {}); errs.push('at ' + pg.url()); } }
await b.close(); srv.kill();
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') + '\n--- server log:\n' + log : 'E2E PASSED');
if (errs.length) process.exitCode = 1;
