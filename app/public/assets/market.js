// Marketplace, agent pages, orders, dashboard extras and the admin panel.
// Every piece of data from the API is inserted with textContent via el(), never as HTML.

function agentCard(a) {
  return el('a', { class: 'card hover', href: `agent.html?slug=${encodeURIComponent(a.slug)}` },
    icon(a.icon),
    el('h3', { text: a.name }),
    el('p', { text: a.tagline }),
    el('div', { class: 'tags' }, a.platforms.map(p => el('span', { class: 'tag', text: PLATFORM_LABEL[p] || p }))),
    el('div', { class: 'card-foot' },
      a.fromPrice ? el('div', { class: 'price' }, `от ${money(a.fromPrice.amount, a.fromPrice.currency)}`, el('small', { text: PER[a.fromPrice.interval] })) : el('div'),
      a.reviewCount ? el('span', { class: 'rating' }, stars(a.rating), el('small', { text: ` ${a.rating} (${a.reviewCount})` })) : null));
}

const marketPages = {
  async marketplace() {
    const grid = $('[data-agents]'), search = $('[data-search]'), status = $('[data-status]');
    let agents = [], cat = 'all';
    try { agents = (await api('/api/agents')).agents; }
    catch { status.textContent = "Не удалось загрузить каталог. Обновите страницу."; status.hidden = false; return; }
    const render = () => {
      const text = search.value.trim().toLowerCase();
      const shown = agents.filter(a => (cat === 'all' || a.category.split(' ').includes(cat)) && (!text || `${a.name} ${a.tagline}`.toLowerCase().includes(text)));
      grid.replaceChildren(...shown.map(agentCard));
      status.hidden = shown.length > 0;
      status.textContent = 'По вашему запросу агентов не найдено.';
    };
    $('.filters').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $$('.filters button').forEach(x => x.classList.toggle('on', x === b)); cat = b.dataset.cat; render();
    });
    search.addEventListener('input', render);
    render();
  },

  async agent() {
    const slug = params.get('slug');
    const root = $('[data-agent]');
    let data;
    try { if (!slug) throw new Error(); data = await api(`/api/agents/${encodeURIComponent(slug)}`); }
    catch { root.replaceChildren(el('div', { class: 'card', style: 'margin:60px auto;max-width:520px;text-align:center' }, el('h2', { text: 'Агент не найден' }), el('p', { text: 'Возможно, его удалили или переименовали.' }), el('a', { class: 'btn primary', href: 'marketplace.html', style: 'margin-top:20px', text: 'Назад в маркетплейс' }))); return; }
    const { agent: a, reviews, viewer } = data;
    document.title = `${a.name} · NeuralDesk`;
    $('[data-crumb]').textContent = a.name;

    const intervals = ['MONTH', 'YEAR', 'ONE_TIME'].filter(i => a.plans.some(p => p.prices.some(x => x.interval === i)));
    let interval = intervals[0], selected = null;
    const planBox = el('div', { class: 'plans' }), buyBtn = el('button', { class: 'btn primary lg', text: 'Купить' }), buyErr = el('div', { class: 'alert err', role: 'alert', hidden: true });
    const renderPlans = () => {
      const avail = a.plans.filter(p => p.prices.some(x => x.interval === interval));
      if (!avail.some(p => p.id === selected?.plan.id)) selected = null;
      planBox.replaceChildren(...avail.map((p, i) => {
        const price = p.prices.find(x => x.interval === interval);
        const input = el('input', { type: 'radio', name: 'plan', value: p.id, checked: selected ? selected.plan.id === p.id : i === 0 });
        if (input.checked) selected = { plan: p, price };
        input.addEventListener('change', () => { selected = { plan: p, price }; });
        return el('label', { class: 'plan-opt' }, input,
          el('div', {}, el('div', { class: 'plan-row' }, el('b', { text: p.name }), el('span', { class: 'plan-price' }, money(price.amount, price.currency), el('small', { text: PER[interval] }))),
            el('ul', {}, p.features.map(f => el('li', { text: f })))));
      }));
    };
    const toggle = intervals.length > 1 ? el('div', { class: 'toggle' }, intervals.map(i =>
      el('button', { type: 'button', class: i === interval ? 'on' : '', text: { MONTH: 'Помесячно', YEAR: 'На год', ONE_TIME: 'Разово' }[i],
        onclick: e => { interval = i; $$('button', e.target.parentNode).forEach(b => b.classList.toggle('on', b === e.target)); renderPlans(); } }))) : null;
    renderPlans();
    buyBtn.addEventListener('click', async () => {
      if (!selected) return;
      if (!viewer.loggedIn) { location.href = `login.html?next=${encodeURIComponent(`agent.html?slug=${a.slug}`)}`; return; }
      buyBtn.disabled = true; buyErr.hidden = true;
      try { const { order } = await api('/api/orders', { priceId: selected.price.id }); location.href = `order.html?id=${encodeURIComponent(order.id)}`; }
      catch (e) { showError(buyErr, e); buyBtn.disabled = false; }
    });

    const section = (title, ...kids) => el('div', { class: 'agent-sec' }, el('h3', { text: title }), ...kids);
    const reviewArea = el('div');
    const renderReviews = () => {
      reviewArea.replaceChildren(
        reviews.length ? el('div', { class: 'grid g2' }, reviews.map(r => el('div', { class: 'card' }, stars(r.rating), el('p', { text: r.body }), el('div', { class: 'review-meta', text: `${r.author} · ${fmtDate(r.createdAt)}` }))))
          : el('p', { class: 'muted', text: 'Отзывов пока нет.' }));
      if (viewer.canReview) {
        const mine = viewer.myReview;
        const form = el('form', { class: 'card review-form', novalidate: true },
          el('h3', { text: mine ? 'Изменить отзыв' : 'Написать отзыв' }),
          mine && !mine.approved ? el('p', { text: 'Ваш отзыв появится после быстрой проверки.' }) : null,
          el('div', { class: 'field' }, el('label', { for: 'rating', text: 'Оценка' }),
            el('select', { id: 'rating', name: 'rating' }, [5, 4, 3, 2, 1].map(n => el('option', { value: n, selected: (mine?.rating ?? 5) === n, text: `${'★'.repeat(n)} ${n}` })))),
          el('div', { class: 'field' }, el('label', { for: 'body', text: 'Ваш опыт' }), el('textarea', { id: 'body', name: 'body', rows: 4, maxlength: 1500, text: mine?.body || '' })),
          el('div', { class: 'alert err', role: 'alert', hidden: true }), el('div', { class: 'alert ok', role: 'status', hidden: true }),
          el('button', { class: 'btn primary', type: 'submit', text: 'Отправить отзыв' }));
        onSubmit(form, async d => {
          hide($('.alert.err', form)); hide($('.alert.ok', form));
          try { const r = await api(`/api/agents/${a.slug}/reviews`, { rating: Number(d.rating), body: d.body }); const ok = $('.alert.ok', form); ok.textContent = r.message; ok.hidden = false; }
          catch (e) { showError($('.alert.err', form), e); }
        });
        reviewArea.append(form);
      } else {
        reviewArea.append(el('p', { class: 'notice', text: 'Отзывы оставляют только подтверждённые покупатели этого агента.' }));
      }
    };
    renderReviews();

    root.replaceChildren(el('div', { class: 'two' },
      el('div', {},
        icon(a.icon),
        el('h1', { class: 'agent-title', text: a.name }),
        el('p', { class: 'agent-lead', text: a.tagline }),
        el('div', { class: 'tags' }, a.platforms.map(p => el('span', { class: 'tag', text: PLATFORM_LABEL[p] || p })),
          a.reviewCount ? el('span', { class: 'rating' }, stars(a.rating), el('small', { text: ` ${a.rating} · отзывов: ${a.reviewCount}` })) : null),
        el('p', { class: 'agent-desc', text: a.description }),
        section('Что умеет', el('div', { class: 'check' }, a.features.map(f => el('div', { text: f })))),
        a.problems.length ? section('Какие проблемы решает', el('div', { class: 'grid g3' }, a.problems.map(p => el('div', { class: 'card' }, el('h3', { text: p.title }), el('p', { text: p.text }))))) : null,
        a.demo.length ? section('Пример работы', el('div', { class: 'chat', id: 'demo' },
          el('div', { class: 'chat-top' }, el('i'), el('div', {}, el('b', { text: a.name }), el('div', { class: 'muted', style: 'font-size:.75rem', text: 'пример диалога' }))),
          a.demo.map(m => el('div', { class: `msg ${m.from === 'agent' ? 'out' : 'in'}`, text: m.text })))) : null,
        a.installSteps.length ? section('Установка', a.installSteps.map((s, i) => el('div', { class: 'step' }, el('span', { class: 'n', text: String(i + 1).padStart(2, '0') }), el('p', { style: 'margin:0', text: s })))) : null,
        el('div', { class: 'agent-sec', id: 'reviews' }, el('h3', { text: 'Отзывы клиентов' }), reviewArea)),
      el('aside', { class: 'side card buy' },
        viewer.owned ? el('div', { class: 'alert ok' }, 'Этот агент у вас уже есть. ', el('a', { href: 'dashboard.html', text: 'Открыть кабинет →' })) : null,
        el('div', { class: 'tags', style: 'margin:0 0 16px' }, el('span', { class: 'tag', text: 'Выберите тариф' })),
        toggle, planBox, buyErr, buyBtn,
        el('p', { class: 'notice', text: 'Заказ закрепляет за вами тариф. Агент станет доступен после подтверждения оплаты.' }))));
  },

  async order() {
    const root = $('[data-order]');
    let order;
    try { order = (await api(`/api/orders/${encodeURIComponent(params.get('id') || 'x')}`)).order; }
    catch (e) { if (e.status === 401) { location.replace(`login.html?next=${encodeURIComponent(location.pathname.slice(1) + location.search)}`); return; } root.replaceChildren(el('h1', { text: 'Заказ не найден' }), el('a', { class: 'btn', href: 'dashboard.html', text: 'Перейти в кабинет' })); return; }
    const label = { PENDING: 'Ожидает оплаты', PAID: 'Оплачен', FAILED: 'Оплата не прошла', REFUNDED: 'Возврат', CANCELED: 'Отменён' }[order.status];
    const err = el('div', { class: 'alert err', role: 'alert', hidden: true });
    root.replaceChildren(
      el('span', { class: 'eyebrow', text: `Заказ ${order.id.slice(0, 8).toUpperCase()}` }),
      el('h1', { text: order.status === 'PAID' ? (order.productType === 'ACADEMY' ? 'Добро пожаловать в VIP Академию!' : 'Спасибо! Ваш агент готов.') : order.status === 'PENDING' ? 'Ваш заказ оформлен' : `Заказ: ${label.toLowerCase()}` }),
      el('div', { class: 'kv' },
        el('div', {}, el('span', { text: order.productType === 'ACADEMY' ? 'Участие' : 'Агент' }), el('b', { text: order.agentName })),
        el('div', {}, el('span', { text: 'Тариф' }), el('b', { text: order.planName })),
        el('div', {}, el('span', { text: 'Цена' }), el('b', {}, money(order.amount, order.currency), el('small', { class: 'muted', text: PER[order.interval] }))),
        el('div', {}, el('span', { text: 'Статус' }), el('span', { class: `badge st-${order.status.toLowerCase()}`, text: label })),
        el('div', {}, el('span', { text: 'Создан' }), el('b', { text: fmtDate(order.createdAt) }))),
      order.status === 'PENDING' ? el('p', { class: 'order-note' }, 'Онлайн-оплата картой пока подключается. До этого оплату подтверждает наша команда: мы напишем вам на ',
        el('b', { text: order.customerEmail || 'ваш email' }), ` и пришлём реквизиты для оплаты. ${order.productType === 'ACADEMY' ? 'Доступ к Академии откроется' : 'Агент станет доступен в кабинете'} сразу после подтверждения оплаты.`) : null,
      err,
      el('div', { class: 'order-actions' },
        el('a', { class: 'btn primary', href: 'dashboard.html', text: 'Перейти в кабинет' }),
        order.status === 'PENDING' ? el('button', { class: 'btn', text: 'Отменить заказ', onclick: async e => {
          e.target.disabled = true;
          try { await api(`/api/orders/${order.id}/cancel`, {}); location.reload(); } catch (x) { showError(err, x); e.target.disabled = false; }
        } }) : null,
        order.productType === 'ACADEMY' ? el('a', { class: 'btn', href: 'learn.html', text: 'Моё обучение' }) : el('a', { class: 'btn', href: `agent.html?slug=${encodeURIComponent(order.agentSlug)}`, text: 'Смотреть агента' })));
  },

  async dashboard() {
    const mine = $('[data-my-agents]'), orders = $('[data-orders]');
    const [a, o, ac] = await Promise.all([api('/api/my/agents').catch(() => null), api('/api/orders').catch(() => null), api('/api/academy/me').catch(() => null)]);
    if (!a || !o) return;
    if (ac?.membership.active) $('[data-admin-link]').before(el('a', { class: 'btn', href: 'learn.html', text: 'Моё обучение' }));
    const open = async x => {
      try { const r = x.installationId ? { id: x.installationId } : await api('/api/installations', { orderId: x.orderId }); location.href = `setup.html?id=${encodeURIComponent(r.id)}`; }
      catch (e) { mine.prepend(el('div', { class: 'alert err', text: e.message })); }
    };
    mine.replaceChildren(...(a.agents.length ? a.agents.map(x => el('div', { class: 'mini' },
      icon(x.icon), el('div', {}, el('b', { text: x.name }), el('small', { text: `Тариф ${x.planName} · с ${fmtDate(x.since)}` })),
      el('button', { class: `btn sm ${x.installationId ? '' : 'primary'}`, text: x.installationId ? 'Открыть' : 'Настроить', onclick: () => open(x) })))
      : [el('p', { text: "Вы ещё не купили ни одного агента." }), el('a', { class: 'btn primary', href: 'marketplace.html', style: 'margin-top:14px', text: 'Смотреть агентов' })]));
    const label = { PENDING: 'Ожидает оплаты', PAID: 'Оплачен', FAILED: 'Не прошла', REFUNDED: 'Возврат', CANCELED: 'Отменён' };
    orders.replaceChildren(...(o.orders.length ? o.orders.slice(0, 8).map(x => el('a', { class: 'mini', href: `order.html?id=${encodeURIComponent(x.id)}` },
      el('div', {}, el('b', { text: x.agentName }), el('small', { text: `${x.planName} · ${money(x.amount, x.currency)}${PER[x.interval]} · ${fmtDate(x.createdAt)}` })),
      el('span', { class: `badge st-${x.status.toLowerCase()}`, text: label[x.status] }))) : [el('p', { text: 'Заказов пока нет.' })]));
  },
};

// ---------------- Admin panel ----------------
const toCents = v => { const s = String(v).trim().replace(',', '.'); if (!s) return null; const n = Number(s); if (!isFinite(n) || n < 0) throw new Error(`«${v}» — неверная цена`); return Math.round(n * 100); };
const lines = v => String(v || '').split('\n').map(s => s.trim()).filter(Boolean);

marketPages.admin = async function () {
  const root = $('[data-admin-root]'), flash = $('[data-flash]');
  const say = (t, bad) => { flash.textContent = t; flash.className = `alert ${bad ? 'err' : 'ok'}`; flash.hidden = false; scrollTo({ top: 0, behavior: 'smooth' }); };
  let me;
  try { me = await api('/api/me'); } catch { location.replace('login.html?next=admin.html'); return; }
  let supportOnly = false;
  try { await api('/api/admin/stats'); }
  catch (e) {
    // Support staff get the Support tab only.
    if (me.user.role === 'SUPPORT' && await api('/api/admin/support').then(() => true, () => false)) supportOnly = true;
    else {
    root.replaceChildren(el('div', { class: 'card', style: 'max-width:560px' }, el('h2', { text: 'Нужен доступ администратора' }), el('p', { text: e.message }),
      el('a', { class: 'btn primary', href: 'dashboard.html', style: 'margin-top:18px', text: 'Перейти в кабинет' })));
    $('.tabs').hidden = true; return;
    }
  }

  const views = {
    async overview() {
      const [s, rt] = await Promise.all([api('/api/admin/stats'), api('/api/admin/runtime')]);
      const tile = (v, l) => el('div', {}, el('b', { text: v }), el('span', { text: l }));
      const problems = [...rt.failedJobs.map(j => `${fmtDate(j.at)} · ${j.kind}: ${j.error}`), ...rt.channelErrors.map(c => `${c.bot}: ${c.error}`)];
      return el('div', {},
        el('div', { class: 'stats' },
          tile(s.revenue.length ? s.revenue.map(r => money(r.total, r.currency)).join(' + ') : '$0', 'выручка (оплаченные заказы)'),
          tile(String(s.pendingOrders), 'заказов ждут оплаты'), tile(String(s.users), 'зарегистрированных пользователей'), tile(String(s.agents), 'опубликованных агентов')),
        el('div', { class: 'stats', style: 'margin-top:18px' },
          tile(`${rt.live} / ${rt.installations}`, 'агентов работает / установлено'), tile(rt.messages24h.toLocaleString('ru-RU'), 'сообщений за 24 ч'),
          tile(rt.tokens24h.toLocaleString('ru-RU'), 'AI-токенов за 24 ч'), tile(rt.aiMode, 'режим ответов')),
        el('div', { class: 'card', style: 'margin-top:18px' }, el('h3', { text: 'Проблемы агентов' }),
          problems.length ? el('ul', { class: 'problems' }, problems.slice(0, 15).map(t => el('li', { text: t }))) : el('p', { text: 'Ошибок доставки и каналов нет.' })),
        el('div', { class: 'grid g3', style: 'margin-top:18px' },
          el('a', { class: 'card hover', href: '#orders' }, el('h3', { text: 'Заказы' }), el('p', { text: 'Подтверждение оплат, неудачные заказы, возвраты.' })),
          el('a', { class: 'card hover', href: '#reviews' }, el('h3', { text: `Отзывы${s.pendingReviews ? ` (новых: ${s.pendingReviews})` : ''}` }), el('p', { text: 'Одобрение и скрытие отзывов клиентов.' })),
          el('a', { class: 'card hover', href: 'dashboard.html' }, el('h3', { text: 'Пользователи и роли' }), el('p', { text: 'Смена ролей в таблице пользователей.' }))));
    },

    async agents() {
      const editor = el('div'), tbody = el('tbody');
      async function refreshList() {
        const { agents } = await api('/api/admin/agents');
        tbody.replaceChildren(...agents.map(a => el('tr', {},
          el('td', { text: a.name }), el('td', { class: 'mono', text: a.slug }),
          el('td', {}, el('span', { class: `badge ${a.published ? 'on' : 'off'}`, text: a.published ? 'Опубликован' : 'Скрыт' })),
          el('td', { text: a.fromPrice ? money(a.fromPrice.amount, a.fromPrice.currency) + PER[a.fromPrice.interval] : '—' }),
          el('td', { text: String(a.orders) }),
          el('td', {}, el('button', { class: 'btn sm', text: 'Изменить', onclick: () => openEditor(a.id) })))));
      }
      await refreshList();
      const table = el('div', { class: 'card' },
        el('div', { class: 'row-head' }, el('h3', { text: 'Агенты' }), el('button', { class: 'btn primary', text: '+ Новый агент', onclick: () => openEditor(null) })),
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Агент', 'Адрес (slug)', 'Статус', 'От', 'Заказы', ''].map(h => el('th', { text: h })))), tbody)));

      async function openEditor(id) {
        const a = id ? (await api(`/api/admin/agents/${id}`)).agent : { slug: '', name: '', tagline: '', description: '', category: 'support', icon: 'chat', features: [], problems: [], demo: [], installSteps: [], platforms: [], published: false, plans: [] };
        const f = (name, label, input, hint) => el('div', { class: 'field' }, el('label', { for: `f-${name}`, text: label }), input, hint ? el('span', { class: 'hint', text: hint }) : null);
        const ta = (name, value, rows = 4) => el('textarea', { id: `f-${name}`, name, rows, text: value });
        const form = el('form', { class: 'card editor', novalidate: true },
          el('div', { class: 'row-head' }, el('h3', { text: id ? `Редактирование: ${a.name}` : 'Новый агент' }), el('button', { type: 'button', class: 'btn sm', text: 'Закрыть', onclick: () => editor.replaceChildren() })),
          el('div', { class: 'grid g2' },
            f('name', 'Название', el('input', { id: 'f-name', name: 'name', value: a.name })),
            f('slug', 'Адрес (slug)', el('input', { id: 'f-slug', name: 'slug', value: a.slug }), 'Латиница в нижнем регистре, цифры, дефисы. После первого заказа менять нельзя.')),
          f('tagline', 'Короткое описание', el('input', { id: 'f-tagline', name: 'tagline', value: a.tagline })),
          f('description', 'Описание', ta('description', a.description, 5)),
          el('div', { class: 'grid g2' },
            f('category', 'Категории', el('input', { id: 'f-category', name: 'category', value: a.category }), 'Через пробел: sales support ops'),
            f('icon', 'Иконка', el('select', { id: 'f-icon', name: 'icon' }, Object.keys(ICONS).map(k => el('option', { value: k, selected: a.icon === k, text: k }))))),
          el('fieldset', { class: 'field' }, el('legend', { text: 'Платформы' }),
            el('div', { class: 'checks' }, Object.entries(PLATFORM_LABEL).map(([k, v]) => el('label', {}, el('input', { type: 'checkbox', name: 'platform', value: k, checked: a.platforms.includes(k) }), ` ${v}`)))),
          f('features', 'Возможности', ta('features', a.features.join('\n')), 'По одной на строку.'),
          f('problems', 'Какие проблемы решает', ta('problems', a.problems.map(p => `${p.title}: ${p.text}`).join('\n')), 'По одной на строку, в формате «Заголовок: пояснение».'),
          f('demo', 'Пример диалога', ta('demo', a.demo.map(m => `${m.from === 'agent' ? 'A' : 'C'}: ${m.text}`).join('\n'), 5), 'По одному сообщению на строку. «C:» — клиент, «A:» — агент.'),
          f('install', 'Шаги установки', ta('install', a.installSteps.join('\n')), 'По одному шагу на строку.'),
          el('label', { class: 'switch' }, el('input', { type: 'checkbox', name: 'published', checked: a.published }), ' Опубликован (виден в маркетплейсе)'),
          el('div', { class: 'order-actions' }, el('button', { class: 'btn primary', type: 'submit', text: id ? 'Сохранить' : 'Создать агента' }),
            id ? el('button', { type: 'button', class: 'btn danger', text: 'Удалить агента', onclick: async e => {
              if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = 'Нажмите ещё раз для удаления'; return; }
              try { await api(`/api/admin/agents/${id}/delete`, {}); say('Агент удалён.'); editor.replaceChildren(); refreshList(); } catch (x) { say(x.message, true); }
            } }) : null));
        onSubmit(form, async () => {
          const fd = new FormData(form);
          try {
            const body = {
              name: fd.get('name'), slug: fd.get('slug').trim(), tagline: fd.get('tagline'), description: fd.get('description'),
              category: fd.get('category'), icon: fd.get('icon'), platforms: fd.getAll('platform'), published: fd.get('published') === 'on',
              features: lines(fd.get('features')), installSteps: undefined, install_steps: lines(fd.get('install')),
              problems: lines(fd.get('problems')).map(l => { const i = l.indexOf(':'); if (i < 1) throw new Error(`Проблема «${l}» должна быть в формате «Заголовок: пояснение»`); return { title: l.slice(0, i).trim(), text: l.slice(i + 1).trim() }; }),
              demo: lines(fd.get('demo')).map(l => { const m = l.match(/^([CA])\s*:\s*(.+)$/i); if (!m) throw new Error(`Строка диалога «${l}» должна начинаться с «C:» или «A:»`); return { from: m[1].toUpperCase() === 'A' ? 'agent' : 'customer', text: m[2] }; }),
            };
            if (!id) { delete body.published; const r = await api('/api/admin/agents', body); say('Агент создан. Добавьте тариф с ценой и опубликуйте.'); openEditor(r.agent.id); refreshList(); return; }
            await api(`/api/admin/agents/${id}`, body); say('Сохранено.'); refreshList();
          } catch (x) { say(x.message, true); }
        });

        const plans = id ? el('div', { class: 'card editor' }, el('h3', { text: 'Тарифы и цены' }),
          el('p', { text: 'Цены в долларах (например, 29 или 29.90). Оставьте поле пустым, чтобы убрать этот вариант оплаты. Новая цена не меняет уже оформленные заказы.' }),
          a.plans.map(p => planForm(p)), planForm(null)) : null;
        function planForm(p) {
          const price = i => { const x = p?.prices.find(y => y.interval === i); return x ? String(x.amount / 100) : ''; };
          const pf = el('form', { class: 'plan-edit', novalidate: true },
            el('div', { class: 'grid g2' },
              el('div', { class: 'field' }, el('label', { text: p ? 'Название тарифа' : 'Название нового тарифа' }), el('input', { name: 'name', value: p?.name || '' })),
              el('div', { class: 'grid g3 prices' }, ['MONTH', 'YEAR', 'ONE_TIME'].map(i => el('div', { class: 'field' }, el('label', { text: { MONTH: 'В месяц, $', YEAR: 'В год, $', ONE_TIME: 'Разово, $' }[i] }), el('input', { name: i, inputmode: 'decimal', value: price(i) }))))),
            el('div', { class: 'field' }, el('label', { text: 'Возможности (по одной на строку)' }), el('textarea', { name: 'features', rows: 3, text: (p?.features || []).join('\n') })),
            p ? el('label', { class: 'switch' }, el('input', { type: 'checkbox', name: 'active', checked: p.active }), ' Тариф доступен для покупки') : null,
            el('button', { class: `btn ${p ? '' : 'primary'} sm`, type: 'submit', text: p ? 'Сохранить тариф' : '+ Добавить тариф' }));
          onSubmit(pf, async () => {
            const fd = new FormData(pf);
            try {
              const prices = {}; for (const i of ['MONTH', 'YEAR', 'ONE_TIME']) { const c = toCents(fd.get(i)); if (c !== null || p?.prices.some(x => x.interval === i)) prices[i] = c; }
              const body = { name: fd.get('name'), features: lines(fd.get('features')), prices };
              if (p) await api(`/api/admin/plans/${p.id}`, { ...body, active: fd.get('active') === 'on' });
              else await api(`/api/admin/agents/${id}/plans`, body);
              say(p ? 'Тариф сохранён.' : 'Тариф добавлен.'); openEditor(id); refreshList();
            } catch (x) { say(x.message, true); }
          });
          return pf;
        }
        editor.replaceChildren(form, plans || '');
        editor.scrollIntoView({ behavior: 'smooth' });
      }
      return el('div', { class: 'stack' }, table, editor);
    },

    async orders() {
      const status = params.get('status') || '';
      const box = el('div', { class: 'card' });
      const filter = el('select', { 'aria-label': 'Фильтр по статусу', onchange: e => { load(e.target.value); } },
        [['', 'Все заказы'], ['PENDING', 'Ожидает оплаты'], ['PAID', 'Оплачен'], ['FAILED', 'Не прошла'], ['REFUNDED', 'Возврат'], ['CANCELED', 'Отменён']].map(([v, t]) => el('option', { value: v, text: t, selected: v === status })));
      const body = el('tbody');
      async function load(s) {
        const { orders } = await api(`/api/admin/orders${s ? `?status=${s}` : ''}`);
        const act = (o, to, text, cls = '') => el('button', { class: `btn sm ${cls}`, text, onclick: async e => {
          e.target.disabled = true;
          try { await api(`/api/admin/orders/${o.id}/status`, { status: to }); say(`Заказ ${o.customerEmail}: ${({ PAID: 'отмечен как оплаченный', FAILED: 'оплата не прошла', REFUNDED: 'оформлен возврат', CANCELED: 'отменён' })[to]}.`); load(filter.value); } catch (x) { say(x.message, true); e.target.disabled = false; }
        } });
        body.replaceChildren(...(orders.length ? orders.map(o => el('tr', {},
          el('td', { text: fmtDate(o.createdAt) }),
          el('td', {}, el('div', { text: o.customerName }), el('small', { class: 'muted', text: o.customerEmail })),
          el('td', {}, el('div', { text: o.agentName }), el('small', { class: 'muted', text: o.planName })),
          el('td', { text: money(o.amount, o.currency) + PER[o.interval] }),
          el('td', {}, el('span', { class: `badge st-${o.status.toLowerCase()}`, text: o.status })),
          el('td', { class: 'actions' }, o.status === 'PENDING' ? [act(o, 'PAID', 'Отметить оплату', 'primary'), act(o, 'FAILED', 'Не прошла')] : o.status === 'PAID' ? act(o, 'REFUNDED', 'Возврат') : null)))
          : [el('tr', {}, el('td', { colspan: 6, class: 'muted', text: 'Заказов нет.' }))]));
      }
      await load(status);
      box.append(el('div', { class: 'row-head' }, el('h3', { text: 'Заказы' }), filter),
        el('p', { text: 'Пока онлайн-оплата не подключена, подтверждайте каждую оплату здесь после её получения. «Отметить оплату» открывает клиенту доступ к агенту.' }),
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Дата', 'Клиент', 'Агент / тариф', 'Сумма', 'Статус', ''].map(h => el('th', { text: h })))), body)));
      return box;
    },

    async reviews() {
      const { reviews } = await api('/api/admin/reviews');
      const act = (r, body, text, cls = '') => el('button', { class: `btn sm ${cls}`, text, onclick: async () => {
        try { await api(`/api/admin/reviews/${r.id}`, body); say('Отзыв обновлён.'); show('reviews'); } catch (x) { say(x.message, true); }
      } });
      return el('div', { class: 'card' }, el('h3', { text: 'Отзывы' }), el('p', { text: 'Отзывы оставляют только покупатели. Новые и изменённые отзывы ждут здесь одобрения.' }),
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Агент', 'Автор', 'Оценка', 'Отзыв', 'Статус', ''].map(h => el('th', { text: h })))),
          el('tbody', {}, reviews.length ? reviews.map(r => el('tr', {},
            el('td', { text: r.agentName }), el('td', {}, el('div', { text: r.author }), el('small', { class: 'muted', text: r.email })),
            el('td', {}, stars(r.rating)), el('td', { class: 'review-cell', text: r.body }),
            el('td', {}, el('span', { class: `badge ${r.approved ? 'on' : 'off'}`, text: r.approved ? 'Виден' : 'Ждёт' })),
            el('td', { class: 'actions' }, r.approved ? act(r, { approved: false }, 'Скрыть') : act(r, { approved: true }, 'Одобрить', 'primary'), act(r, { action: 'delete' }, 'Удалить', 'danger'))))
            : el('tr', {}, el('td', { colspan: 6, class: 'muted', text: 'Отзывов пока нет.' }))))));
    },
  };

  // Extra tabs (Academy etc.) registered by other scripts.
  for (const [k, f] of Object.entries(window.ADMIN_EXTRA || {})) views[k] = () => f({ say, show });

  if (supportOnly) { $$('.tabs a').forEach(a => { if (a.hash !== '#support') a.remove(); }); $('.dash-head h1').textContent = 'Поддержка клиентов'; }
  async function show(name) {
    if (supportOnly) name = 'support';
    if (!views[name]) name = 'overview';
    $$('.tabs a').forEach(a => a.classList.toggle('on', a.hash === `#${name}`));
    root.replaceChildren(el('p', { class: 'muted', text: 'Загрузка…' }));
    try { root.replaceChildren(await views[name]()); } catch (e) { root.replaceChildren(el('div', { class: 'alert err', text: e.message })); }
  }
  addEventListener('hashchange', () => { flash.hidden = true; show(location.hash.slice(1)); });
  show(location.hash.slice(1));
};

marketPages[document.body.dataset.page]?.();
