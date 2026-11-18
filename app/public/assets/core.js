// Shared helpers for every page. Loaded before the page scripts.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

async function api(path, data) {
  const res = await fetch(path, {
    method: data ? 'POST' : 'GET',
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
    credentials: 'same-origin',
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || 'Что-то пошло не так. Попробуйте ещё раз.'), { status: res.status, data: body });
  return body;
}

function showError(box, err) { if (!box) return; box.textContent = err.message; box.hidden = false; }
function hide(box) { if (box) box.hidden = true; }
const formData = form => Object.fromEntries(new FormData(form).entries());

// Disable the button while a request runs so double-clicks can't send twice.
function onSubmit(form, handler) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('button[type="submit"]', form);
    btn.disabled = true;
    try { await handler(formData(form)); } finally { btn.disabled = false; }
  });
}

const params = new URLSearchParams(location.search);
// Drop the token from the address bar and history once it's been read.
function takeToken() {
  const t = params.get('token');
  if (t) history.replaceState(null, '', location.pathname);
  return t;
}

$$('[data-action="logout"]').forEach(b => b.addEventListener('click', async () => {
  await api('/api/auth/logout', {}).catch(() => {});
  location.href = 'index.html';
}));


const ICONS = {
  chat: '<path d="M21 12a8 8 0 0 1-11.5 7.2L4 20l1-4.5A8 8 0 1 1 21 12z"/>',
  camera: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".8" fill="currentColor"/>',
  cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M3 4h2l2.5 11h11L21 7H6"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
};
// Icon markup comes only from the fixed table above, never from user data.
function icon(name) {
  const s = document.createElement('span'); s.className = 'icon';
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.chat}</svg>`;
  return s;
}
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter(x => x !== null && x !== undefined && x !== false));
  return e;
}
function money(amount, currency) {
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, minimumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
}
const ROLE_RU = { USER: 'Клиент', STUDENT: 'Студент', SUPPORT: 'Поддержка', ADMIN: 'Администратор' };
const LEVEL_RU = { Beginner: 'Начальный', Intermediate: 'Средний', Advanced: 'Продвинутый' };
const PER = { MONTH: ' / мес', YEAR: ' / год', ONE_TIME: ' разово' };
const PLATFORM_LABEL = { TELEGRAM: 'Telegram', INSTAGRAM: 'Instagram', WEB: 'Сайт', API: 'API', EMAIL: 'Email' };
const fmtDate = d => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
function stars(n) { return el('span', { class: 'stars', 'aria-label': `${n} из 5 звёзд`, text: '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n)) }); }
// Only same-site page paths are allowed as post-login redirects.
function safeNext(v) { return v && /^[a-z0-9-]+\.html(\?[\w=&%.-]*)?(#[\w-]+)?$/i.test(v) ? v : null; }

// Swap "Log in / Get started" for "Dashboard / Log out" when a session exists.
(async () => {
  const cta = $('.nav-cta'); const login = cta && $('a[href="login.html"]', cta);
  if (!login) return;
  try { const me = await api('/api/me'); login.replaceWith(el('button', { class: 'btn', text: 'Выйти', onclick: async () => { await api('/api/auth/logout', {}).catch(() => {}); location.href = 'index.html'; } }));
    const start = $('a[href="register.html"]', cta); if (start) { start.href = me.user.role === 'ADMIN' ? 'admin.html' : 'dashboard.html'; start.textContent = me.user.role === 'ADMIN' ? 'Админка' : 'Кабинет'; } } catch {}
})();

// Announcements from the team, shown on signed-in pages until dismissed.
(async () => {
  if (!['dashboard', 'learn', 'setup', 'course', 'lesson', 'community', 'support'].includes(document.body.dataset.page)) return;
  let d; try { d = await api('/api/announcements'); } catch { return; }
  const host = $('main .wrap') || $('section .wrap');
  if (!host) return;
  for (const a of d.announcements.slice().reverse()) host.prepend(el('div', { class: `announce ${a.level === 'IMPORTANT' ? 'important' : ''}`, role: 'status' },
    el('div', {}, el('b', { text: a.title }), el('p', { text: a.body })),
    el('button', { class: 'btn sm', 'aria-label': `Скрыть: ${a.title}`, text: 'Скрыть', onclick: async e => { e.target.closest('.announce').remove(); await api(`/api/announcements/${a.id}/dismiss`, {}).catch(() => {}); } })));
})();

// Russian plural forms: plural(5, 'урок', 'урока', 'уроков') → 'уроков'.
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
