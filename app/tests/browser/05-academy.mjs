// Browser test. Run from the app folder:  node tests/browser/05-academy.mjs   (needs: npm i -D playwright && npx playwright install chromium)
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const SHOTS = path.join(os.tmpdir(), 'neuraldesk-shots'); fs.mkdirSync(SHOTS, { recursive: true });
import { spawn, execFileSync } from 'node:child_process';
import { totp } from '../../server/auth.js';
const { chromium } = await import('playwright');
const APP = fileURLToPath(new URL('../..', import.meta.url)), B = 'http://localhost:3921';
const env = { ...process.env, PORT: '3921', DATABASE_FILE: path.join(os.tmpdir(), 'e2e6-05-academy.db'), ENCRYPTION_KEY: Buffer.alloc(32, 6).toString('base64') };
for (const f of [env.DATABASE_FILE, env.DATABASE_FILE + '-wal', env.DATABASE_FILE + '-shm']) fs.rmSync(f, { force: true });
const srv = spawn('node', ['server/index.js'], { env, cwd: APP }); let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
await new Promise(r => setTimeout(r, 1000));
const errs = [], ok = m => console.log('✓', m);
const watch = p => { p.on('pageerror', e => errs.push('pageerror: ' + e.message)); p.on('console', m => { if (m.type() === 'error' && !/status of 4\d\d|youtube|ERR_|net::/.test(m.text())) errs.push('console: ' + m.text()); }); };
const b = await chromium.launch();
try {
  const ad = await fetch(B + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Danya Founder', email: 'danya@example.com', password: 'danya-password-1' }) });
  const ck = ad.headers.getSetCookie()[0].split(';')[0];
  const sec = (await (await fetch(B + '/api/account/2fa/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: '{}' })).json()).secret;
  await fetch(B + '/api/account/2fa/enable', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: ck }, body: JSON.stringify({ code: totp(sec) }) });
  execFileSync('node', ['server/cli.js', 'make-admin', 'danya@example.com'], { env, cwd: APP });

  const s = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(s);
  await s.goto(B + '/academy.html'); await s.waitForSelector('[data-roadmap] .road');
  if ((await s.$$('[data-roadmap] .road')).length !== 6) throw new Error('expected 6 months'); await s.waitForSelector('[data-plans] .plan');
  ok('Academy page: 6-month roadmap and 2 plans from the database'); await s.screenshot({ path: SHOTS + '/s6-academy.png', fullPage: true });
  await s.click('.road:has-text("МЕСЯЦ 1")'); await s.waitForURL('**/course.html?slug=ai-foundations');
  await s.waitForSelector('.lesson-row.locked'); await s.click('a.lesson-row:has-text("Что такое AI")');
  await s.waitForSelector('.rich li:text("Что на самом деле делают большие языковые модели")'); await s.waitForSelector('.video.empty');
  ok('visitor opens a free preview lesson; locked lessons are not links');
  await s.goto(B + '/academy.html#plans'); await s.click('button:text("Выбрать «VIP Академия»")'); await s.waitForURL('**/register.html?next=*');
  await s.fill('#name', 'Taras Shevchuk'); await s.fill('#email', 'taras@example.com'); await s.fill('#password', 'taras-password-1'); await s.click('button[type=submit]');
  await s.waitForURL('**/academy.html#plans'); await s.waitForSelector('[data-plans] .plan button'); await s.click('button:text("Выбрать «VIP Академия»")');
  await s.waitForURL('**/order.html?id=*'); await s.waitForSelector('h1:text("Ваш заказ оформлен")'); await s.waitForSelector('text=Доступ к Академии откроется');
  ok('sign up from the plan card → back → order reserved with Academy wording');
  await s.goto(B + '/learn.html'); await s.waitForSelector('text=Вступите в VIP Академию, чтобы открыть всё'); ok('before payment: learning hub offers previews only');

  const a = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); watch(a);
  await a.goto(B + '/login.html?next=admin.html'); await a.fill('#email', 'danya@example.com'); await a.fill('#password', 'danya-password-1'); await a.click('button[type=submit]');
  await a.waitForSelector('[data-2fa]:not([hidden])'); await a.fill('#code', totp(sec, Date.now() + 30000)); await a.click('button[type=submit]'); await a.waitForURL('**/admin.html');
  await a.click('.tabs a[href="#orders"]'); await a.click('tr:has-text("taras@example.com") >> button:text("Отметить оплату")'); await a.waitForSelector('[data-flash]:text("отмечен как оплаченный")');
  ok('admin confirms the membership payment');
  await a.click('.tabs a[href="#academy"]'); await a.click('tr:has-text("Монетизация и карьера") >> button:text("Изменить")');
  await a.waitForSelector('.lesson-row.admin'); await a.click('.lesson-row.admin:has-text("Портфолио, которое продаёт") >> button:text("Изменить")');
  await a.fill('.lesson-edit input[name=videoUrl]', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'); await a.fill('.lesson-edit textarea[name=materials]', 'Portfolio template | https://docs.example.com/template');
  await a.click('.lesson-edit button:text("Сохранить урок")'); await a.waitForSelector('[data-flash]:text("Урок сохранён")');
  await a.waitForSelector('.lesson-row.admin:has-text("Портфолио, которое продаёт") small:has-text("видео")'); ok('admin adds a video link and materials to a lesson');
  await a.screenshot({ path: SHOTS + '/s6-admin-builder.png', fullPage: true });
  await a.click('.tabs a[href="#live"]'); await a.waitForSelector('h3:text("Запланировать сессию")'); await a.fill('input[name=title]', 'Live Q&A: finding your first client'); await a.selectOption('select[name=kind]', 'QA');
  await a.fill('input[name=startsAt]', new Date(Date.now() + 2 * 86400e3 - new Date().getTimezoneOffset() * 60e3).toISOString().slice(0, 16)); await a.fill('input[name=joinUrl]', 'https://meet.example.com/qa-1');
  await a.click('button:text("Запланировать")'); await a.waitForSelector('[data-flash]:text("Сессия сохранена")'); ok('admin schedules a live Q&A');

  await s.goto(B + '/learn.html'); await s.waitForSelector('.alert.ok:has-text("VIP Академия · доступ до")'); await s.waitForSelector('.mini:has-text("Live Q&A") a:text("Подключиться")');
  ok('after payment: plan shown, live session with Join link'); await s.screenshot({ path: SHOTS + '/s6-learn.png', fullPage: true });
  await s.goto(B + '/course.html?slug=monetization-career'); await s.click('a.lesson-row:has-text("Портфолио, которое продаёт")');
  await s.waitForSelector('.video iframe[src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]'); await s.waitForSelector('.materials a:text("Portfolio template")');
  await s.fill('#a-body', 'Short'); await s.click('button:text("Отправить на проверку")'); await s.waitForSelector('#assignment .alert.err:not([hidden])');
  await s.fill('#a-body', 'My portfolio with two case studies: a bakery bot and a support agent.'); await s.fill('#a-link', 'https://taras.example/portfolio');
  await s.click('button:text("Отправить на проверку")'); await s.waitForSelector('#assignment .badge:text("На проверке")');
  ok('lesson: privacy-friendly video embed, materials, assignment submitted');
  await s.click('button:text("Отметить как пройденный")'); await s.waitForSelector('button:text("✓ Пройден")'); await s.click('a:text("Дальше →")');
  await s.waitForSelector('h1:text("Ваши следующие 90 дней")'); await s.click('button:text("Отметить как пройденный")'); await s.waitForSelector('button:text("✓ Пройден")');
  await s.screenshot({ path: SHOTS + '/s6-lesson.png', fullPage: true });

  await a.click('.tabs a[href="#students"]'); await a.waitForSelector('.submission:has-text("Taras Shevchuk")');
  await a.fill('.submission textarea', 'Strong case studies. Add one number to each next time.'); await a.click('.submission button:text("Принять")');
  await a.waitForSelector('[data-flash]:text("Сертификат выдан!")'); await a.waitForSelector('tr:has-text("taras@example.com") td:has-text("1")');
  ok('admin approves → certificate issued automatically');
  await s.goto(B + '/learn.html'); await s.click('.mini:has-text("Монетизация и карьера") >> text=Открыть');
  await s.waitForSelector('.cert-name:text("Taras Shevchuk")'); const certUrl = s.url();
  const pub = await (await b.newContext({ viewport: { width: 1280, height: 900 } })).newPage(); await pub.goto(certUrl); await pub.waitForSelector('.cert-course:text("Монетизация и карьера")');
  await pub.screenshot({ path: SHOTS + '/s6-cert.png' }); ok('certificate page verifies publicly');

  await s.goto(B + '/community.html'); await s.fill('#pt', 'My first client said yes!'); await s.fill('#pb', 'A local bakery bought a Telegram assistant. Thanks for Month 4!');
  await s.click('button:text("Опубликовать")'); await s.waitForURL('**/community.html?post=*'); await s.fill('#cm', 'Next goal: two more clients.'); await s.click('button:text("Ответить")');
  await s.waitForSelector('.comment:has-text("Next goal")'); await s.waitForSelector('text=Taras S.');
  ok('community post and reply (names shown as "Taras S.")');
  await s.goto(B + '/mentorship.html'); await s.waitForSelector('text=входят в тариф VIP + Менторство'); ok('mentorship locked on the VIP plan');
  const outsider = await (await b.newContext()).newPage(); await outsider.goto(B + '/community.html'); await outsider.waitForURL('**/login.html?next=community.html'); ok('community requires login');

  const m = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage(); await m.context().addCookies(await s.context().cookies());
  for (const f of ['academy.html', 'learn.html', 'course.html?slug=monetization-career', certUrl.replace(B + '/', ''), 'community.html']) {
    await m.goto(`${B}/${f}`); await m.waitForTimeout(500); if (await m.evaluate(() => document.documentElement.scrollWidth > innerWidth)) errs.push(`${f} overflows on mobile`);
  }
  await m.goto(B + '/learn.html'); await m.waitForTimeout(400); await m.screenshot({ path: SHOTS + '/s6-learn-mobile.png', fullPage: true }); ok('Academy pages fit on a phone');
} catch (e) { errs.push('FAIL: ' + e.message.split('\n')[0]); for (const pg of b.contexts().flatMap(c => c.pages())) { await pg.screenshot({ path: SHOTS + '/fail6-' + Math.random().toString(36).slice(2, 6) + '.png' }).catch(() => {}); errs.push('at ' + pg.url()); } }
await b.close(); srv.kill();
console.log(errs.length ? 'ERRORS:\n' + errs.join('\n') + '\n--- server log:\n' + log : 'E2E PASSED');
if (errs.length) process.exitCode = 1;
