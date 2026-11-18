// Admin tabs: Overview (with charts), Users, Support, Agents live, Announcements, Logs.
const CAT = { GENERAL: 'Общий вопрос', BILLING: 'Оплата', TECHNICAL: 'Техническая проблема', ACADEMY: 'Академия', CUSTOM: 'Индивидуальное решение' };
const TST = { OPEN: ['Ждёт нашего ответа', 'st-pending'], PENDING: ['Ждёт клиента', 'off'], CLOSED: ['Закрыт', 'off'] };
const ago = d => { if (!d) return '—'; const s = (Date.now() - Date.parse(d)) / 1000; return s < 60 ? 'только что' : s < 3600 ? `${Math.floor(s / 60)} мин назад` : s < 86400 ? `${Math.floor(s / 3600)} ч назад` : fmtDate(d); };
const monthLabel = m => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('ru-RU', { month: 'short' });

// Stacked monthly bars (agents + academy), labelled for screen readers.
function revenueChart(d) {
  const max = Math.max(1, ...d.months.map((_, i) => d.agents[i] + d.academy[i]));
  return el('div', {},
    el('div', { class: 'legend' }, el('span', { class: 'k in', text: 'AI-агенты' }), el('span', { class: 'k out', text: 'Академия' })),
    el('div', { class: 'bars twelve', role: 'img', 'aria-label': `Выручка по месяцам, ${d.currency}: ${d.months.map((m, i) => `${monthLabel(m)} ${money(d.agents[i] + d.academy[i], d.currency)}`).join('; ')}` },
      d.months.map((m, i) => el('div', { class: 'bar-col', title: `${monthLabel(m)}: агенты ${money(d.agents[i], d.currency)} + академия ${money(d.academy[i], d.currency)}` },
        el('div', { class: 'bar-stack' }, el('i', { class: 'out', style: `height:${d.academy[i] / max * 100}%` }), el('i', { class: 'in', style: `height:${d.agents[i] / max * 100}%` })),
        el('small', { text: monthLabel(m) })))));
}

window.ADMIN_EXTRA = {
  ...(window.ADMIN_EXTRA || {}),

  async overview() {
    const [s, rt, ins] = await Promise.all([api('/api/admin/stats'), api('/api/admin/runtime'), api('/api/admin/insights')]);
    const tile = (v, l, href) => el(href ? 'a' : 'div', href ? { href } : {}, el('b', { text: v }), el('span', { text: l }));
    const thisMonth = ins.agents[11] + ins.academy[11];
    const problems = [...rt.failedJobs.map(j => `${fmtDate(j.at)} · ${j.kind}: ${j.error}`), ...rt.channelErrors.map(c => `${c.bot}: ${c.error}`)];
    return el('div', { class: 'stack' },
      el('div', { class: 'stats' },
        tile(money(thisMonth, ins.currency), 'выручка за месяц'), tile(String(s.pendingOrders), 'заказов ждут оплаты', '#orders'),
        tile(String(ins.openTickets), 'обращений ждут ответа', '#support'), tile(String(s.pendingReviews), 'отзывов на модерации', '#reviews')),
      el('div', { class: 'card' }, el('div', { class: 'row-head' }, el('h3', { text: 'Выручка за 12 месяцев' }),
        el('small', { class: 'muted', text: `За всё время: ${s.revenue.length ? s.revenue.map(r => money(r.total, r.currency)).join(' + ') : money(0, ins.currency)}${ins.refunds.n ? ` · возвратов: ${ins.refunds.n}` : ''}` })),
        revenueChart(ins), ins.otherCurrencies.length ? el('p', { class: 'notice', text: `На графике — ${ins.currency}. Также получено: ${ins.otherCurrencies.join(', ')}.` }) : null),
      el('div', { class: 'grid g2' },
        el('div', { class: 'card' }, el('h3', { text: 'Топ агентов' }), ins.topAgents.length ? el('div', { class: 'kv' }, ins.topAgents.map(a => el('div', {}, el('span', { text: `${a.name} · продаж: ${a.orders}` }), el('b', { text: money(a.total, a.currency) }))))
          : el('p', { text: 'Оплаченных заказов агентов пока нет.' })),
        el('div', { class: 'card' }, el('h3', { text: 'Платформа' }), el('div', { class: 'kv' },
          el('div', {}, el('span', { text: 'Зарегистрировано пользователей' }), el('b', { text: String(s.users) })),
          el('div', {}, el('span', { text: 'Новых пользователей за месяц' }), el('b', { text: String(ins.newUsers[11]) })),
          el('div', {}, el('span', { text: 'Активных студентов Академии' }), el('b', { text: String(ins.students) })),
          el('div', {}, el('span', { text: 'Агентов работает / установлено' }), el('b', { text: `${rt.live} / ${rt.installations}` })),
          el('div', {}, el('span', { text: 'Сообщений за 24 ч' }), el('b', { text: rt.messages24h.toLocaleString('ru-RU') })),
          el('div', {}, el('span', { text: 'Движок ответов' }), el('b', { text: rt.aiMode }))))),
      el('div', { class: 'card' }, el('div', { class: 'row-head' }, el('h3', { text: 'Проблемы агентов' }), el('a', { class: 'btn sm', href: '#logs', text: 'Все логи' })),
        problems.length ? el('ul', { class: 'problems' }, problems.slice(0, 10).map(t => el('li', { text: t }))) : el('p', { text: 'Ошибок доставки и каналов нет.' })));
  },

  // ---------------- Users ----------------
  async users({ say, show }) {
    const box = el('div', { class: 'stack' }), detail = el('div');
    const form = el('form', { class: 'card add-row wrap-row', novalidate: true, style: 'margin:0' },
      el('input', { name: 'q', type: 'search', placeholder: 'Поиск по имени или email', 'aria-label': 'Поиск пользователей', value: params.get('q') || '' }),
      el('select', { name: 'role', 'aria-label': 'Фильтр по роли' }, [['', 'Все роли'], ['USER', 'Пользователи'], ['STUDENT', 'Студенты'], ['SUPPORT', 'Поддержка'], ['ADMIN', 'Админы']].map(([v, t]) => el('option', { value: v, text: t }))),
      el('select', { name: 'status', 'aria-label': 'Фильтр по статусу' }, [['', 'Любой статус'], ['active', 'Активен'], ['suspended', 'Заблокирован']].map(([v, t]) => el('option', { value: v, text: t }))),
      el('button', { class: 'btn', type: 'submit', text: 'Найти' }));
    const body = el('tbody');
    async function load() {
      const fd = new FormData(form), qs = new URLSearchParams([...fd].filter(([, v]) => v)).toString();
      const { users } = await api(`/api/admin/users${qs ? `?${qs}` : ''}`);
      body.replaceChildren(...(users.length ? users.map(u => el('tr', {},
        el('td', {}, el('div', { text: u.name }), el('small', { class: 'muted', text: u.email })),
        el('td', { text: ROLE_RU[u.role] || u.role }), el('td', {}, u.suspended ? el('span', { class: 'badge st-failed', text: 'Заблокирован' }) : el('span', { class: 'badge on', text: 'Активен' })),
        el('td', { text: `${u.emailVerified ? 'Email ✓' : 'Email ✗'} · ${u.twoFactorEnabled ? '2FA ✓' : '2FA ✗'}` }), el('td', { text: fmtDate(u.createdAt) }),
        el('td', {}, el('button', { class: 'btn sm', text: 'Открыть', onclick: () => open(u.id) })))) : [el('tr', {}, el('td', { colspan: 6, class: 'muted', text: 'Пользователи не найдены.' }))]));
    }
    onSubmit(form, load);

    async function open(id) {
      const d = await api(`/api/admin/users/${id}`), u = d.user;
      const reason = el('input', { placeholder: 'Причина (видна в журнале)', 'aria-label': 'Причина блокировки' });
      const pause = el('input', { type: 'checkbox', checked: true });
      const roleSel = el('select', { 'aria-label': `Роль для ${u.email}` }, ['USER', 'STUDENT', 'SUPPORT', 'ADMIN'].map(r => el('option', { value: r, selected: r === u.role, text: ROLE_RU[r] })));
      const section = (title, rows, empty) => el('div', { class: 'card' }, el('h3', { text: title }), rows.length ? el('div', { class: 'minis' }, rows) : el('p', { text: empty }));
      detail.replaceChildren(el('div', { class: 'stack' },
        el('div', { class: 'card' },
          el('div', { class: 'row-head' }, el('div', {}, el('h3', { text: u.name }), el('small', { class: 'muted', text: `${u.email} · с ${fmtDate(u.createdAt)} · активных сессий: ${d.sessions}` })),
            el('button', { class: 'btn sm', text: 'Закрыть', onclick: () => detail.replaceChildren() })),
          u.suspended ? el('div', { class: 'alert err', style: 'margin-top:14px' }, `Заблокирован ${fmtDate(u.suspendedAt)}: ${u.suspendReason}`) : null,
          el('div', { class: 'order-actions' },
            el('label', { class: 'switch', style: 'margin:0' }, el('span', { text: 'Роль', 'aria-hidden': 'true' }), roleSel),
            el('button', { class: 'btn sm', text: 'Изменить роль', onclick: async () => { try { await api(`/api/admin/users/${u.id}/role`, { role: roleSel.value }); say(`${u.email}: роль «${ROLE_RU[roleSel.value]}».`); load(); } catch (e) { say(e.message, true); } } }),
            el('button', { class: 'btn sm', text: 'Выйти на всех устройствах', onclick: async () => { const r = await api(`/api/admin/users/${u.id}/logout`, {}); say(`Завершено сессий: ${r.sessions}.`); open(u.id); } })),
          u.suspended
            ? el('button', { class: 'btn primary sm', style: 'margin-top:14px', text: 'Восстановить аккаунт', onclick: async () => { await api(`/api/admin/users/${u.id}/suspend`, { suspended: false }); say('Аккаунт восстановлен.'); open(u.id); load(); } })
            : el('div', { class: 'add-row wrap-row' }, reason, el('label', { class: 'switch', style: 'margin:0' }, pause, ' также приостановить его агентов'),
              el('button', { class: 'btn sm danger', text: 'Заблокировать аккаунт', onclick: async () => {
                try { await api(`/api/admin/users/${u.id}/suspend`, { suspended: true, reason: reason.value, pauseAgents: pause.checked }); say(`${u.email} заблокирован и разлогинен.`); open(u.id); load(); } catch (e) { say(e.message, true); }
              } }))),
        el('div', { class: 'grid g2' },
          section('Заказы', d.orders.map(o => el('div', { class: 'mini' }, el('div', {}, el('b', { text: o.product }), el('small', { text: `${o.plan} · ${money(o.amount, o.currency)}${PER[o.interval]} · ${fmtDate(o.createdAt)}` })), el('span', { class: `badge st-${o.status.toLowerCase()}`, text: o.status }))), 'Заказов нет.'),
          section('Агенты', d.agents.map(a => el('div', { class: 'mini' }, el('div', {}, el('b', { text: a.name }), el('small', { text: a.channels || 'канал не подключён' })), el('span', { class: `badge ${a.live ? 'on' : 'off'}`, text: a.live ? 'Работает' : 'Выключен' }))), 'Агенты не установлены.'),
          section('Академия', d.academy.map(m => el('div', { class: 'mini' }, el('div', {}, el('b', { text: m.plan }), el('small', { text: `${fmtDate(m.startsAt)} → ${fmtDate(m.endsAt)}${m.mentorship ? ' · менторство' : ''}` })), el('span', { class: `badge ${m.active ? 'on' : 'off'}`, text: m.active ? 'Активен' : 'Завершён' }))), 'Нет доступа к Академии.'),
          section('Поддержка', d.tickets.map(t => el('a', { class: 'mini', href: `#support`, onclick: () => sessionStorage?.setItem?.('openTicket', t.id) }, el('div', {}, el('b', { text: `#${t.number} ${t.subject}` }), el('small', { text: fmtDate(t.updatedAt) })), el('span', { class: `badge ${TST[t.status][1]}`, text: TST[t.status][0] }))), 'Обращений нет.')),
        section('Последние действия', d.activity.map(a => el('div', { class: 'mini' }, el('div', {}, el('b', { text: a.action }), el('small', { text: ago(a.at) })))), 'Действий пока нет.')));
      detail.scrollIntoView({ behavior: 'smooth' });
    }
    await load();
    box.append(form, el('div', { class: 'card' }, el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Пользователь', 'Роль', 'Статус', 'Безопасность', 'Регистрация', ''].map(h => el('th', { text: h })))), body))), detail);
    return box;
  },

  // ---------------- Support ----------------
  async support({ say, show }) {
    const status = el('select', { 'aria-label': 'Фильтр' }, [['', 'Сначала требующие внимания'], ['OPEN', 'Ждёт нашего ответа'], ['PENDING', 'Ждёт клиента'], ['CLOSED', 'Закрыт']].map(([v, t]) => el('option', { value: v, text: t })));
    const list = el('div', { class: 'minis' }), thread = el('div', { class: 'inbox-thread' });
    async function load() {
      const d = await api(`/api/admin/support${status.value ? `?status=${status.value}` : ''}`);
      list.replaceChildren(...(d.tickets.length ? d.tickets.map(t => el('button', { class: 'mini ticket-row', onclick: () => open(t.id) },
        el('div', {}, el('b', { text: `#${t.number} ${t.subject}` }), el('small', { text: `${t.name} · ${CAT[t.category]} · ${ago(t.updatedAt)}` }), el('small', { class: 'clip', text: t.last || '' })),
        el('span', { class: `badge ${TST[t.status][1]}`, text: TST[t.status][0] }))) : [el('p', { text: 'Здесь обращений нет.' })]));
      return d;
    }
    async function open(id) {
      const { ticket: t, account } = await api(`/api/admin/support/${id}`);
      const reply = el('textarea', { rows: 4, 'aria-label': 'Ответ', placeholder: 'Напишите ответ. Клиент получит его по email.' });
      const send = close => async () => {
        try { await api(`/api/admin/support/${t.id}/reply`, { body: reply.value, close }); say(`Ответ отправлен: ${t.email}.`); await load(); open(t.id); } catch (e) { say(e.message, true); }
      };
      thread.replaceChildren(el('div', { class: 'card' },
        el('div', { class: 'row-head' }, el('div', {}, el('h3', { text: `#${t.number} ${t.subject}` }), el('small', { class: 'muted', text: `${t.name} · ${t.email} · ${CAT[t.category]}${account ? ` · аккаунт: ${account.role}` : ' · гость'}` })),
          el('span', { class: `badge ${TST[t.status][1]}`, text: TST[t.status][0] })),
        el('div', { class: 'chat-log thread' }, t.messages.map(m => el('div', { class: `msg ${m.fromStaff ? 'out' : 'in'}` }, el('span', { text: m.body }), el('small', { text: `${m.author} · ${new Date(m.createdAt).toLocaleString('ru-RU')}` })))),
        el('div', { class: 'field' }, reply),
        el('div', { class: 'order-actions', style: 'margin-top:0' }, el('button', { class: 'btn primary', text: 'Отправить ответ', onclick: send(false) }), el('button', { class: 'btn', text: 'Отправить и закрыть', onclick: send(true) }),
          t.status !== 'CLOSED' ? el('button', { class: 'btn sm', text: 'Закрыть без ответа', onclick: async () => { await api(`/api/admin/support/${t.id}/status`, { status: 'CLOSED' }); await load(); open(t.id); } })
            : el('button', { class: 'btn sm', text: 'Открыть снова', onclick: async () => { await api(`/api/admin/support/${t.id}/status`, { status: 'OPEN' }); await load(); open(t.id); } }))));
    }
    status.addEventListener('change', load);
    const d = await load();
    const want = sessionStorage?.getItem?.('openTicket'); if (want) { sessionStorage.removeItem('openTicket'); open(want); } else if (d.tickets[0]) open(d.tickets[0].id);
    return el('div', { class: 'inbox' }, el('div', { class: 'card inbox-list' }, el('div', { class: 'row-head' }, el('h3', { text: 'Обращения' }), status), list), thread);
  },

  // ---------------- Agents live ----------------
  async performance() {
    const { installations } = await api('/api/admin/agents/performance');
    return el('div', { class: 'card' }, el('h3', { text: 'Установленные агенты, за 7 дней' }),
      el('p', { text: 'Частая передача менеджеру обычно значит, что агенту не хватает знаний. Ошибки приходят от Telegram или Instagram.' }),
      el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Агент', 'Владелец', 'Каналы', 'Входящие', 'Ответы', 'Передачи', 'Заявки', 'AI-токены', 'Последнее сообщение'].map(h => el('th', { text: h })))),
        el('tbody', {}, installations.length ? installations.map(i => el('tr', {},
          el('td', {}, el('div', { text: i.agent }), el('span', { class: `badge ${i.live ? 'on' : 'off'}`, text: i.live ? 'Работает' : 'Выключен' })),
          el('td', {}, el('div', { text: i.workspace }), el('small', { class: 'muted', text: i.owner || '' })),
          el('td', {}, el('div', { text: i.channels.join(', ') || '—' }), ...i.errors.map(e => el('small', { class: 'err-text', text: e }))),
          el('td', { text: String(i.incoming) }), el('td', {}, el('div', { text: String(i.replies) }), i.failedJobs ? el('small', { class: 'err-text', text: `ошибок: ${i.failedJobs}` }) : null),
          el('td', { text: `${i.handoffs}${i.incoming ? ` (${i.handoffRate}%)` : ''}` }), el('td', { text: String(i.leads) }), el('td', { text: i.tokens.toLocaleString('ru-RU') }),
          el('td', { text: ago(i.lastMessageAt) })))
          : el('tr', {}, el('td', { colspan: 9, class: 'muted', text: 'Агентов пока не установлено.' }))))));
  },

  // ---------------- Announcements ----------------
  async announcements({ say, show }) {
    const { announcements } = await api('/api/admin/announcements');
    const AUD = { ALL: 'Все', CUSTOMERS: 'Клиенты агентов', STUDENTS: 'Студенты Академии' };
    const form = a => {
      const f = el('form', { class: 'card', novalidate: true }, el('h3', { text: a ? `Изменить: ${a.title}` : 'Новое объявление' }),
        field('Заголовок', el('input', { name: 'title', value: a?.title || '', maxlength: 120 })),
        field('Сообщение', el('textarea', { name: 'body', rows: 3, maxlength: 2000, text: a?.body || '' })),
        el('div', { class: 'grid g2' },
          field('Кто видит', el('select', { name: 'audience' }, Object.entries(AUD).map(([v, t]) => el('option', { value: v, selected: a?.audience === v, text: t })))),
          field('Стиль', el('select', { name: 'level' }, [['INFO', 'Инфо'], ['IMPORTANT', 'Важное (выделено)']].map(([v, t]) => el('option', { value: v, selected: a?.level === v, text: t }))))),
        el('div', { class: 'grid g2' }, field('Показывать с', el('input', { name: 'startsAt', type: 'datetime-local', value: localInput(a?.startsAt) }), 'Пусто = сейчас'),
          field('Показывать до', el('input', { name: 'endsAt', type: 'datetime-local', value: localInput(a?.endsAt) }), 'Пусто = пока не завершите')),
        !a ? el('label', { class: 'switch' }, el('input', { type: 'checkbox', name: 'email' }), ' Также отправить по email этой аудитории сейчас') : null,
        el('button', { class: 'btn primary', type: 'submit', text: a ? 'Сохранить' : 'Опубликовать' }));
      onSubmit(f, async d => {
        const body = { title: d.title, body: d.body, audience: d.audience, level: d.level, startsAt: d.startsAt ? new Date(d.startsAt).toISOString() : undefined, endsAt: d.endsAt ? new Date(d.endsAt).toISOString() : null, email: d.email === 'on' };
        try { const r = a ? await api(`/api/admin/announcements/${a.id}`, body) : await api('/api/admin/announcements', body); say(a ? 'Сохранено.' : `Опубликовано${r.emailed ? `, отправлено по email: ${r.emailed}` : ''}.`); show('announcements'); }
        catch (e) { say(e.message, true); }
      });
      return f;
    };
    const holder = el('div', {}, form(null));
    return el('div', { class: 'stack' }, holder,
      el('div', { class: 'card' }, el('h3', { text: 'Все объявления' }),
        announcements.length ? el('div', { class: 'minis' }, announcements.map(a => el('div', { class: 'mini' },
          el('div', {}, el('b', { text: `${a.level === 'IMPORTANT' ? '⚠️ ' : ''}${a.title}` }),
            el('small', { text: `${AUD[a.audience]} (${a.reach}) · ${fmtDate(a.startsAt)}${a.endsAt ? ` → ${fmtDate(a.endsAt)}` : ''} · скрыли: ${a.dismissed}${a.emailedAt ? ' · отправлено по email' : ''}` })),
          el('span', { class: `badge ${a.active ? 'on' : 'off'}`, text: a.active ? 'Показывается' : 'Не показывается' }),
          el('button', { class: 'btn sm', text: 'Изменить', onclick: () => { holder.replaceChildren(form(a)); holder.scrollIntoView({ behavior: 'smooth' }); } }),
          a.active ? el('button', { class: 'btn sm', text: 'Завершить сейчас', onclick: async () => { await api(`/api/admin/announcements/${a.id}/end`, {}); show('announcements'); } }) : null)))
          : el('p', { text: 'Пока ничего.' })));
  },

  // ---------------- Logs ----------------
  async logs() {
    const [sys] = await Promise.all([api('/api/admin/logs/system')]);
    const f = el('form', { class: 'add-row wrap-row', novalidate: true }, el('input', { name: 'action', placeholder: 'Действие начинается с… напр. admin. или order.', 'aria-label': 'Действие' }),
      el('input', { name: 'actor', placeholder: 'Кто (email)', 'aria-label': 'Email исполнителя' }), el('button', { class: 'btn', type: 'submit', text: 'Фильтр' }));
    const body = el('tbody'), more = el('button', { class: 'btn sm', text: 'Загрузить старые', hidden: true });
    let next = null;
    async function load(append) {
      const fd = new FormData(f), qs = new URLSearchParams([...fd].filter(([, v]) => v));
      if (append && next) qs.set('before', next);
      const d = await api(`/api/admin/logs/audit?${qs}`);
      const rows = d.entries.map(e => el('tr', {}, el('td', { text: new Date(e.at).toLocaleString('ru-RU') }), el('td', { class: 'mono', text: e.action }), el('td', { text: e.actor }),
        el('td', { class: 'mono', text: e.target ? String(e.target).slice(0, 12) : '' }), el('td', { class: 'mono review-cell', text: e.meta ? JSON.stringify(e.meta) : '' })));
      append ? body.append(...rows) : body.replaceChildren(...rows);
      next = d.next; more.hidden = !next;
    }
    onSubmit(f, () => load(false)); more.addEventListener('click', () => load(true));
    await load(false);
    return el('div', { class: 'stack' },
      el('div', { class: 'card' }, el('h3', { text: 'Системные ошибки' }), el('p', { text: 'Ошибки сервера и фоновых задач (Telegram, Instagram, AI).' }),
        sys.entries.length ? el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Когда', 'Где', 'Сообщение'].map(h => el('th', { text: h })))),
          el('tbody', {}, sys.entries.map(e => el('tr', {}, el('td', { text: new Date(e.at).toLocaleString('ru-RU') }), el('td', { text: e.source }), el('td', { class: 'mono review-cell', text: e.message }))))))
          : el('p', { text: 'Ошибок не зафиксировано. 👍' })),
      el('div', { class: 'card' }, el('h3', { text: 'Журнал действий' }), el('p', { text: 'Каждый вход, покупка, изменение настроек и действие администратора.' }), f,
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Когда', 'Действие', 'Кто', 'Объект', 'Подробности'].map(h => el('th', { text: h })))), body)), more));
  },
};
