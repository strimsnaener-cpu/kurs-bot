// Public site pages: Pricing (live prices), Contact (support form), Support (ticket threads).
const CATEGORIES = { GENERAL: 'Общий вопрос', BILLING: 'Оплата и счета', TECHNICAL: 'Техническая проблема', CUSTOM: 'Внедрение агентов и обучение команды' };
const LEGACY_CATEGORY = { ACADEMY: 'Обучение' };   // tickets created before the Academy was removed
const STATUS = { OPEN: ['Уже занимаемся', 'st-pending'], PENDING: ['Ждём вашего ответа', 'st-paid'], CLOSED: ['Закрыто', 'off'] };

const sitePages = {
  async pricing() {
    const ag = await api('/api/agents').catch(() => ({ agents: [] }));
    $('[data-agent-prices]').replaceChildren(...ag.agents.map(a => el('a', { class: 'card hover price-card', href: `agent.html?slug=${encodeURIComponent(a.slug)}` },
      icon(a.icon), el('h3', { text: a.name }), el('p', { text: a.tagline }),
      a.fromPrice ? el('div', { class: 'price' }, `от ${money(a.fromPrice.amount, a.fromPrice.currency)}`, el('small', { text: PER[a.fromPrice.interval] })) : null,
      el('span', { class: 'btn sm', style: 'margin-top:16px', text: 'Смотреть тарифы' }))));
  },

  async contact() {
    const me = await api('/api/me').catch(() => null);
    const form = $('[data-contact]'), done = $('[data-done]'), err = $('.alert.err', form);
    if (me) { $$('[data-guest]', form).forEach(x => x.remove()); $('[data-who]').textContent = `Отправляется от имени ${me.user.name} (${me.user.email}).`; }
    const sel = $('#category');
    for (const [k, v] of Object.entries(CATEGORIES)) sel.add(new Option(v, k));
    if (params.get('topic') === 'custom') sel.value = 'CUSTOM';
    onSubmit(form, async d => {
      hide(err);
      try {
        const r = await api('/api/support/tickets', d);
        form.hidden = true;
        done.replaceChildren(el('h2', { text: r.number ? `Спасибо! Обращение №${r.number} получено.` : 'Спасибо! Мы получили ваше сообщение.' }),
          el('p', { text: me ? 'Мы ответим на email и на странице поддержки.' : 'Мы отправили на ваш email подтверждение с личной ссылкой на эту переписку.' }),
          r.id ? el('a', { class: 'btn primary', style: 'margin-top:18px', href: `support.html?ticket=${encodeURIComponent(r.id)}${r.token ? `&t=${encodeURIComponent(r.token)}` : ''}`, text: 'Открыть обращение' }) : null);
        done.hidden = false;
      } catch (e) { showError(err, e); }
    });
  },

  async support() {
    const root = $('[data-support]'), id = params.get('ticket');
    // The private link code is moved out of the address bar (so it doesn't end up in history or screenshots)
    // and kept for this browser tab only, so replying and refreshing keep working.
    const key = `ticket-token:${id}`;
    let token = params.get('t');
    try { if (token) sessionStorage.setItem(key, token); else token = sessionStorage.getItem(key); } catch { /* storage blocked: token stays in memory */ }
    if (params.get('t')) history.replaceState(null, '', `support.html?ticket=${encodeURIComponent(id)}`);
    if (id) {
      async function render() {
        let t;
        try { t = (await api(`/api/support/tickets/${encodeURIComponent(id)}${token ? `?t=${encodeURIComponent(token)}` : ''}`)).ticket; }
        catch { root.replaceChildren(el('div', { class: 'card' }, el('h2', { text: 'Обращение не найдено' }), el('p', { text: 'Откройте ссылку из последнего письма или войдите в аккаунт, с которого писали.' }))); return; }
        const err = el('div', { class: 'alert err', role: 'alert', hidden: true });
        const form = el('form', { novalidate: true }, el('div', { class: 'field' }, el('label', { for: 'r', text: 'Ваш ответ' }), el('textarea', { id: 'r', name: 'body', rows: 4, maxlength: 5000 })), err,
          el('div', { class: 'order-actions', style: 'margin-top:0' }, el('button', { class: 'btn primary', type: 'submit', text: 'Отправить' }),
            t.status !== 'CLOSED' ? el('button', { class: 'btn', type: 'button', text: 'Вопрос решён', onclick: async () => { await api(`/api/support/tickets/${t.id}/close`, { t: token || undefined }); render(); } }) : null));
        onSubmit(form, async d => {
          hide(err);
          try { await api(`/api/support/tickets/${t.id}/reply`, { body: d.body, t: token || undefined }); await render(); } catch (e) { showError(err, e); }
        });
        root.replaceChildren(el('div', { class: 'card' },
          el('div', { class: 'row-head' }, el('div', {}, el('span', { class: 'eyebrow', text: `Обращение №${t.number} · ${CATEGORIES[t.category] || LEGACY_CATEGORY[t.category] || t.category}` }), el('h2', { text: t.subject })),
            el('span', { class: `badge ${STATUS[t.status][1]}`, text: STATUS[t.status][0] })),
          el('div', { class: 'chat-log thread' }, t.messages.map(m => el('div', { class: `msg ${m.fromStaff ? 'in' : 'out'}` }, el('span', { text: m.body }), el('small', { text: `${m.fromStaff ? m.author : 'Вы'} · ${new Date(m.createdAt).toLocaleString('ru-RU')}` })))),
          form,
          token ? el('p', { class: 'notice', text: 'Чтобы вернуться позже, используйте ссылку из нашего последнего письма.' }) : null));
      }
      await render();
      return;
    }
    let list;
    try { list = (await api('/api/support/tickets')).tickets; }
    catch { root.replaceChildren(el('div', { class: 'card' }, el('h2', { text: 'Ваши обращения' }), el('p', { text: 'Войдите, чтобы увидеть обращения, или откройте ссылку из нашего письма.' }),
      el('div', { class: 'order-actions' }, el('a', { class: 'btn primary', href: 'login.html?next=support.html', text: 'Войти' }), el('a', { class: 'btn', href: 'contact.html', text: 'Новое обращение' })))); return; }
    root.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'row-head' }, el('h2', { text: 'Ваши обращения' }), el('a', { class: 'btn primary', href: 'contact.html', text: 'Новое обращение' })),
      list.length ? el('div', { class: 'minis' }, list.map(t => el('a', { class: 'mini', href: `support.html?ticket=${encodeURIComponent(t.id)}` },
        el('div', {}, el('b', { text: `№${t.number} ${t.subject}` }), el('small', { text: `Обновлено ${fmtDate(t.updatedAt)}` })), el('span', { class: `badge ${STATUS[t.status][1]}`, text: STATUS[t.status][0] }))))
        : el('p', { text: 'Обращений пока нет.' })));
  },
};
sitePages[document.body.dataset.page]?.();
