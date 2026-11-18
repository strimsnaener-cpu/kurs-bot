// Browser test. Run from the app folder:  node tests/browser/02-marketplace.mjs   (needs: npm i -D playwright && npx playwright install chromium)
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const SHOTS = path.join(os.tmpdir(), 'neuraldesk-shots'); fs.mkdirSync(SHOTS, { recursive: true });
import { totp } from '../../server/auth.js';
import { execFileSync, spawn } from 'node:child_process';
const { chromium } = await import('playwright');
const APP = fileURLToPath(new URL('../..', import.meta.url));
const env = { ...process.env, PORT: '3918', DATABASE_FILE: path.join(os.tmpdir(), 'e2e4-02-marketplace.db'), ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };
for (const f of [env.DATABASE_FILE, env.DATABASE_FILE + '-wal', env.DATABASE_FILE + '-shm']) fs.rmSync(f, { force: true });
const srv = spawn('node', ['server/index.js'], { env, cwd: APP }); let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
await new Promise(r => setTimeout(r, 1000));
const B = 'http://localhost:3918', errs = [], ok = m => console.log('✓', m);
const watch = p => { p.on('pageerror', e => errs.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/status of 40[0139]/.test(m.text())) errs.push('console: ' + m.text()); }); };
const b = await chromium.launch();
try {
  const cust = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(cust);
  await cust.goto(B + '/marketplace.html'); await cust.waitForSelector('[data-agents] .card');
  if ((await cust.$$('[data-agents] .card')).length !== 5) throw new Error('expected 5 agents'); ok('marketplace lists 5 agents from the database');
  await cust.click('.filters button[data-cat="sales"]'); if ((await cust.$$('[data-agents] .card')).length !== 2) throw new Error('sales filter'); 
  await cust.click('.filters button[data-cat="all"]'); await cust.fill('[data-search]', 'отчёт'); if ((await cust.$$('[data-agents] .card')).length !== 1) throw new Error('search'); ok('category filter and search work');
  await cust.screenshot({ path: SHOTS + '/s4-market.png' });
  await cust.fill('[data-search]', ''); await cust.click('text=AI-ассистент для Telegram');
  await cust.waitForSelector('.agent-title'); for (const h of ['Что умеет', 'Какие проблемы решает', 'Пример работы', 'Установка', 'Отзывы клиентов']) if (!(await cust.$(`h3:text("${h}")`))) throw new Error('missing section ' + h);
  ok('agent page shows all product sections');
  await cust.click('.buy .toggle button:text("На год")'); if (!(await cust.textContent('.plans')).includes('290\u00a0$')) throw new Error('yearly price'); ok('monthly/yearly switch updates prices');
  await cust.click('.buy .toggle button:text("Помесячно")');
  await cust.click('.buy > .btn.primary'); await cust.waitForURL('**/login.html?next=*'); ok('Purchase while logged out → login page');
  await cust.click('main >> text=Создать аккаунт'); await cust.waitForURL('**/register.html?next=*');
  await cust.fill('#name', 'Olena Kovalenko'); await cust.fill('#email', 'olena@example.com'); await cust.fill('#password', 'olena-password-1'); await cust.click('button[type=submit]');
  await cust.waitForURL('**/agent.html?slug=telegram-assistant'); ok('after sign-up, back on the same agent page');
  await cust.waitForSelector('.buy > .btn.primary'); await cust.click('.buy > .btn.primary'); await cust.waitForURL('**/order.html?id=*');
  await cust.waitForSelector('h1:text("Ваш заказ оформлен")'); if (!(await cust.textContent('.order-card')).includes('olena@example.com')) throw new Error('email on order');
  ok('order created: "reserved", awaiting payment'); await cust.screenshot({ path: SHOTS + '/s4-order.png' });
  await cust.goto(B + '/admin.html'); await cust.waitForSelector('h2:text("Нужен доступ администратора")'); ok('customer is blocked from the admin panel');
  await cust.goto(B + '/dashboard.html'); await cust.waitForSelector('[data-orders] .badge:text("Ожидает оплаты")'); await cust.waitForSelector('[data-my-agents] >> text=не купили'); ok('dashboard shows the pending order, no agents yet');

  // Admin: sign up via API, make admin, 2FA, log in via the browser
  const reg = await fetch(B + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Danya Admin', email: 'danya@example.com', password: 'danya-password-1' }) });
  const cookie = reg.headers.getSetCookie()[0].split(';')[0];
  const setup = await (await fetch(B + '/api/account/2fa/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' })).json();
  await fetch(B + '/api/account/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ code: totp(setup.secret) }) });
  execFileSync('node', ['server/cli.js', 'make-admin', 'danya@example.com'], { env, cwd: APP });
  const adm = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(adm);
  await adm.goto(B + '/login.html?next=admin.html'); await adm.fill('#email', 'danya@example.com'); await adm.fill('#password', 'danya-password-1'); await adm.click('button[type=submit]');
  await adm.waitForSelector('[data-2fa]:not([hidden])'); await adm.fill('#code', totp(setup.secret, Date.now() + 30000)); await adm.click('button[type=submit]');
  await adm.waitForURL('**/admin.html'); await adm.waitForSelector('.stats b'); ok('admin logs in with 2FA and lands on the admin overview');
  await adm.click('.tabs a[href="#orders"]'); await adm.waitForSelector('td >> text=olena@example.com');
  await adm.click('button:text("Отметить оплату")'); await adm.waitForSelector('[data-flash]:text("отмечен как оплаченный")'); ok('admin marks the order paid');
  await adm.screenshot({ path: SHOTS + '/s4-admin-orders.png' });
  await adm.click('.tabs a[href="#overview"]'); await adm.waitForSelector('.stats b:text("29\u00a0$")'); ok('revenue shows $29');

  // Admin edits a price
  await adm.click('.tabs a[href="#agents"]'); await adm.waitForSelector('tbody tr');
  await adm.click('tr:has-text("telegram-assistant") >> button:text("Изменить")'); await adm.waitForSelector('.plan-edit');
  const starter = adm.locator('.plan-edit').first(); await starter.locator('input[name="MONTH"]').fill('35'); await starter.locator('button[type=submit]').click();
  await adm.waitForSelector('[data-flash]:text("Тариф сохранён")'); ok('admin changes Старт price to $35');
  await adm.screenshot({ path: SHOTS + '/s4-admin-editor.png', fullPage: true });
  // Admin creates and publishes a new agent
  await adm.click('button:text("+ Новый агент")'); await adm.waitForSelector('h3:text("Новый агент")');
  await adm.fill('#f-name', 'AI Email Agent'); await adm.fill('#f-slug', 'email-agent'); await adm.fill('#f-tagline', 'Answers your inbox politely and fast.');
  await adm.fill('#f-description', 'Replies to customer emails using your knowledge base and hands tricky ones to you.'); await adm.fill('#f-category', 'support');
  await adm.check('input[value="EMAIL"]'); await adm.fill('#f-features', 'Replies to emails\nSorts your inbox'); await adm.fill('#f-problems', 'Full inbox: Replies go out within minutes.');
  await adm.fill('#f-demo', 'C: Where is my invoice?\nA: I have just re-sent it to you.'); await adm.click('button:text("Создать агента")');
  await adm.waitForSelector('[data-flash]:text("Агент создан")'); await adm.waitForSelector('h3:text("Редактирование: AI Email Agent")');
  const np = adm.locator('.plan-edit').last(); await np.locator('input[name="name"]').fill('Basic'); await np.locator('input[name="MONTH"]').fill('19'); await np.locator('textarea').fill('1 inbox'); await np.locator('button[type=submit]').click();
  await adm.waitForSelector('[data-flash]:text("Тариф добавлен")'); await adm.check('input[name="published"]'); await adm.click('button:text("Сохранить")'); await adm.waitForSelector('[data-flash]:text("Сохранено")');
  ok('admin creates, prices and publishes a new agent');

  await cust.goto(B + '/marketplace.html'); await cust.waitForSelector('[data-agents] .card'); if ((await cust.$$('[data-agents] .card')).length !== 6) throw new Error('new agent not listed');
  if (!(await cust.textContent('[data-agents]')).includes('35\u00a0$')) throw new Error('new price not shown'); ok('marketplace shows the new agent and the $35 price');
  await cust.goto(B + '/dashboard.html'); await cust.waitForSelector('[data-my-agents] >> text=AI-ассистент для Telegram'); ok('customer sees the agent in My agents');
  await cust.screenshot({ path: SHOTS + '/s4-dashboard.png', fullPage: true });
  await cust.goto(B + '/agent.html?slug=telegram-assistant'); await cust.waitForSelector('.review-form'); await cust.fill('#body', 'Answers our customers at night. Saves us hours every week!');
  await cust.click('.review-form button[type=submit]'); await cust.waitForSelector('.review-form .alert.ok:not([hidden])'); ok('verified buyer submits a review');
  await adm.goto(B + '/admin.html#reviews'); await adm.waitForSelector('button:text("Одобрить")'); await adm.click('button:text("Одобрить")'); await adm.waitForSelector('[data-flash]:text("Отзыв обновлён")'); ok('admin approves the review');
  const pub = await (await b.newContext()).newPage(); await pub.goto(B + '/agent.html?slug=telegram-assistant'); await pub.waitForSelector('.review-meta:text("Olena K.")'); ok('review is public as "Olena K." with stars');
  await pub.screenshot({ path: SHOTS + '/s4-agent.png', fullPage: true });
  await pub.goto(B + '/agent.html?slug=does-not-exist'); await pub.waitForSelector('h2:text("Агент не найден")'); ok('unknown agent shows a friendly not-found page');

  const m = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage(); watch(m);
  for (const f of ['marketplace.html', 'agent.html?slug=sales-agent']) { await m.goto(B + '/' + f); await m.waitForTimeout(400); if (await m.evaluate(() => document.documentElement.scrollWidth > innerWidth)) errs.push(f + ' overflows on mobile'); }
  await m.screenshot({ path: SHOTS + '/s4-agent-mobile.png', fullPage: true }); ok('marketplace and agent pages fit on a phone');
} catch (e) { errs.push('FAIL: ' + e.message.split('\n')[0]); }
await b.close(); srv.kill();
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') + '\n--- server log:\n' + log : 'E2E PASSED');
if (errs.length) process.exitCode = 1;
