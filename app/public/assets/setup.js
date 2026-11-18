// Russian labels for settings whose English values are sent to the AI.
const TONE_RU = { friendly: 'Дружелюбный — тепло и простыми словами', professional: 'Профессиональный — вежливо и по-деловому', concise: 'Краткий — коротко и по делу' };
const LANG_RU = { auto: 'Как у клиента', uk: 'Украинский', en: 'Английский', ru: 'Русский', pl: 'Польский', de: 'Немецкий' };
// Agent setup & control: connect, behavior, knowledge, test chat, conversations, leads, stats.
(async () => {
  if (document.body.dataset.page !== 'setup') return;
  const id = params.get('id');
  const root = $('[data-root]'), flash = $('[data-flash]');
  const say = (t, bad) => { flash.textContent = t; flash.className = `alert ${bad ? 'err' : 'ok'}`; flash.hidden = false; };
  let data;
  async function load() { data = await api(`/api/installations/${encodeURIComponent(id || 'x')}`); return data; }
  try { await load(); }
  catch (e) {
    if (e.status === 401) { location.replace(`login.html?next=${encodeURIComponent(`setup.html?id=${id}`)}`); return; }
    root.replaceChildren(el('div', { class: 'card' }, el('h2', { text: 'Агент не найден' }), el('a', { class: 'btn primary', href: 'dashboard.html', style: 'margin-top:16px', text: 'Назад в кабинет' })));
    return;
  }
  const inst = () => data.installation, opts = () => data.options;
  const hasChannels = () => opts().channels.length > 0;
  document.title = `${inst().name} · NeuralDesk`;

  // ---------- header ----------
  const head = $('[data-head]');
  function renderHead() {
    const i = inst(), live = i.autoReply;
    const toggle = el('button', { class: `switch-btn ${live ? 'on' : ''}`, role: 'switch', 'aria-checked': String(live), 'aria-label': 'Автоответы',
      onclick: async () => {
        try { await api(`/api/installations/${id}/auto-reply`, { enabled: !live }); await load(); renderHead(); say(!live ? 'Автоответы включены. Агент работает.' : 'Автоответы выключены. Сообщения по-прежнему сохраняются.'); }
        catch (e) { say(e.message, true); }
      } }, el('span'));
    head.replaceChildren(
      el('div', { class: 'setup-title' }, icon(i.agent.icon), el('div', {}, el('span', { class: 'eyebrow', text: i.agent.name }), el('h1', { text: i.name }))),
      el('div', { class: 'live-box' },
        el('div', {}, el('b', { text: live ? 'Работает' : 'Выключен' }), el('small', { text: hasChannels() ? 'Автоответы' : 'Помощник в кабинете' })),
        hasChannels() ? toggle : null));
  }
  renderHead();
  // Coming back from Instagram's login page
  if (params.get('ig') === 'connected') say('Instagram подключён. Новые сообщения из Direct будут приходить сюда.');
  if (params.get('ig') === 'error') say(params.get('msg') || "Instagram не подключён.", true);
  if (params.get('ig')) history.replaceState(null, '', `setup.html?id=${encodeURIComponent(id)}${location.hash}`);

  // ---------- views ----------
  const views = {
    connect() {
      const i = inst(), box = el('div', { class: 'stack' }), chans = opts().channels;
      if (!chans.length) {
        box.append(el('div', { class: 'card' }, el('h3', { text: 'Работает внутри кабинета' }),
          el('p', { text: 'У этого агента нет мессенджера. Добавьте знания о компании и пользуйтесь им на вкладке «Тестовый чат».' }),
          el('a', { class: 'btn primary', href: '#test', style: 'margin-top:16px', text: 'Открыть чат' })));
        return box;
      }
      const armed = (btn, label, fn) => async e => {
        if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = label; return; }
        await fn();
      };
      const nextHint = () => !i.autoReply && i.connections.length ? el('p', { class: 'hint-box', text: 'Дальше: добавьте частые вопросы в «Знания», проверьте агента в «Тестовом чате» и включите «Автоответы» вверху.' }) : null;

      // ----- Telegram -----
      if (chans.includes('TELEGRAM')) {
        const tg = i.connections.find(c => c.channel === 'TELEGRAM');
        const err = el('div', { class: 'alert err', role: 'alert', hidden: true });
        if (tg) {
          box.append(el('div', { class: 'card' },
            el('div', { class: 'row-head' }, el('h3', { text: 'Telegram' }), el('span', { class: 'badge on', text: '● Подключён' })),
            el('div', { class: 'kv' },
              el('div', {}, el('span', { text: 'Бот' }), el('b', { text: tg.name })),
              el('div', {}, el('span', { text: 'Получение сообщений' }), el('b', { text: tg.mode === 'webhook' ? 'Вебхук (мгновенно)' : 'Опрос (проверка каждую секунду)' })),
              el('div', {}, el('span', { text: 'Подключён' }), el('b', { text: fmtDate(tg.connectedAt) }))),
            tg.lastError ? el('div', { class: 'alert err', style: 'margin-top:14px', text: `Последняя ошибка: ${tg.lastError}` }) : null,
            err,
            el('div', { class: 'order-actions' }, el('button', { class: 'btn danger', text: 'Отключить бота', onclick: armed(null, 'Нажмите ещё раз для отключения', async () => {
              try { await api(`/api/installations/${id}/telegram/disconnect`, {}); await load(); renderHead(); show('connect'); say('Telegram-бот отключён.'); } catch (x) { showError(err, x); }
            }) }))));
        } else {
          const form = el('form', { class: 'card', novalidate: true },
            el('h3', { text: 'Подключите Telegram-бота' }),
            el('ol', { class: 'howto' },
              el('li', {}, 'В Telegram откройте ', el('b', { text: '@BotFather' }), ' и отправьте ', el('code', { text: '/newbot' }), '.'),
              el('li', { text: 'Придумайте имя и username, который заканчивается на «bot».' }),
              el('li', { text: 'BotFather пришлёт токен вида 123456789:AAH… Скопируйте его и вставьте ниже.' })),
            el('div', { class: 'field' }, el('label', { for: 'token', text: 'Токен бота' }), el('input', { id: 'token', name: 'token', autocomplete: 'off', spellcheck: 'false', placeholder: '123456789:AAH…' }),
              el('span', { class: 'hint', text: 'Хранится в зашифрованном виде. Подключается только бот, а не ваш личный аккаунт Telegram.' })),
            err, el('button', { class: 'btn primary', type: 'submit', text: 'Подключить бота' }));
          onSubmit(form, async d => {
            hide(err);
            try { const r = await api(`/api/installations/${id}/telegram`, { token: d.token }); await load(); renderHead(); show('connect'); say(`Подключён @${r.username}.`); }
            catch (x) { showError(err, x); }
          });
          box.append(form);
        }
      }

      // ----- Instagram -----
      if (chans.includes('INSTAGRAM')) {
        const igc = i.connections.find(c => c.channel === 'INSTAGRAM');
        const err = el('div', { class: 'alert err', role: 'alert', hidden: true });
        if (igc) {
          box.append(el('div', { class: 'card' },
            el('div', { class: 'row-head' }, el('h3', { text: 'Instagram' }), el('span', { class: 'badge on', text: '● Подключён' })),
            el('div', { class: 'kv' },
              el('div', {}, el('span', { text: 'Аккаунт' }), el('b', { text: igc.name })),
              el('div', {}, el('span', { text: 'Вход действует до' }), el('b', { text: igc.tokenExpiresAt ? `${fmtDate(igc.tokenExpiresAt)} (продлевается автоматически)` : '—' })),
              el('div', {}, el('span', { text: 'Подключён' }), el('b', { text: fmtDate(igc.connectedAt) }))),
            igc.lastError ? el('div', { class: 'alert err', style: 'margin-top:14px', text: igc.lastError }) : null,
            el('p', { class: 'hint', style: 'margin-top:14px', text: "Instagram разрешает отвечать только в течение 24 часов после последнего сообщения клиента. Если вы ответите сами в приложении Instagram, AI перестанет отвечать в этом диалоге." }),
            err,
            el('div', { class: 'order-actions' },
              el('button', { class: 'btn', text: 'Переподключить', onclick: () => startIg(err) }),
              el('button', { class: 'btn danger', text: 'Отключить Instagram', onclick: armed(null, 'Нажмите ещё раз для отключения', async () => {
                try { await api(`/api/installations/${id}/instagram/disconnect`, {}); await load(); renderHead(); show('connect'); say('Instagram отключён.'); } catch (x) { showError(err, x); }
              }) }))));
        } else if (!opts().instagramReady) {
          box.append(el('div', { class: 'card muted-card' }, el('h3', { text: 'Instagram' }),
            el('p', { text: "Подключение Instagram на платформе пока не включено. Напишите в поддержку — мы сообщим, когда оно появится." })));
        } else {
          box.append(el('div', { class: 'card' },
            el('h3', { text: 'Подключите аккаунт Instagram' }),
            el('ol', { class: 'howto' },
              el('li', { text: 'Аккаунт должен быть профессиональным (бизнес или автор). Переключить: Instagram → Настройки → Тип аккаунта.' }),
              el('li', { text: 'Нажмите кнопку ниже. Вы входите на странице самого Instagram, а ваш пароль мы не видим.' }),
              el('li', { text: 'Когда Instagram спросит, разрешите доступ к сообщениям, чтобы агент мог отвечать в Direct.' })),
            err,
            el('button', { class: 'btn primary', text: 'Подключить Instagram', onclick: () => startIg(err) })));
        }
      }
      async function startIg(err) {
        hide(err);
        try { const { url } = await api(`/api/installations/${id}/instagram/connect`); location.href = url; } catch (x) { showError(err, x); }
      }
      const hint = nextHint(); if (hint) box.prepend(hint);

      // ----- Alerts -----
      box.append(chans.includes('TELEGRAM')
        ? el('div', { class: 'card' },
            el('div', { class: 'row-head' }, el('h3', { text: 'Уведомления менеджеру' }), el('span', { class: `badge ${i.managerConnected ? 'on' : 'off'}`, text: i.managerConnected ? '● Telegram' : 'Email' })),
            el('p', { text: 'Когда клиенту нужен человек, мы пишем вам на email. Чтобы получать уведомления в Telegram, отправьте своему боту это сообщение со своего аккаунта:' }),
            el('div', { class: 'code', style: 'margin:12px 0', text: `/manager ${i.managerCode}` }),
            el('p', { class: 'hint', text: 'Никому не показывайте этот код. Если отправить его с другого аккаунта, уведомления будут приходить туда.' }))
        : el('div', { class: 'card' }, el('h3', { text: 'Уведомления менеджеру' }), el('p', { text: 'Когда клиенту нужен человек, мы сразу пишем вам на email со ссылкой на диалог.' })));
      return box;
    },

    behavior() {
      const c = inst().config;
      const f = (name, label, input, hint) => el('div', { class: 'field' }, el('label', { for: `b-${name}`, text: label }), input, hint ? el('span', { class: 'hint', text: hint }) : null);
      const sel = (name, map, value) => el('select', { id: `b-${name}`, name }, Object.entries(map).map(([k, v]) => el('option', { value: k, selected: k === value, text: (name === 'tone' ? TONE_RU : LANG_RU)[k] || v })));
      const err = el('div', { class: 'alert err', role: 'alert', hidden: true });
      const form = el('form', { class: 'card', novalidate: true },
        el('h3', { text: 'Как общается ваш агент' }),
        el('div', { class: 'grid g2' },
          f('businessName', 'Название бизнеса', el('input', { id: 'b-businessName', name: 'businessName', value: c.businessName, maxlength: 80 })),
          f('assistantName', 'Имя помощника', el('input', { id: 'b-assistantName', name: 'assistantName', value: c.assistantName, maxlength: 40 }), 'Как он представляется, например «Оля из Hoodie Shop».')),
        f('about', 'О вашем бизнесе', el('textarea', { id: 'b-about', name: 'about', rows: 4, maxlength: 3000, text: c.about }), 'Что продаёте, куда доставляете, часы работы. Подробности — в «Знаниях».'),
        el('div', { class: 'grid g2' }, f('tone', 'Тон', sel('tone', opts().tones, c.tone)), f('language', 'Язык ответов', sel('language', opts().languages, c.language))),
        f('greeting', 'Приветствие (отправляется, когда нажимают «Старт»)', el('textarea', { id: 'b-greeting', name: 'greeting', rows: 2, maxlength: 500, text: c.greeting })),
        f('handoffMessage', 'Сообщение при передаче человеку', el('textarea', { id: 'b-handoffMessage', name: 'handoffMessage', rows: 2, maxlength: 300, text: c.handoffMessage })),
        el('label', { class: 'switch' }, el('input', { type: 'checkbox', name: 'collectLeads', checked: c.collectLeads }), ' Спрашивать контакты у заинтересованных клиентов и сохранять их как заявки'),
        f('extraInstructions', 'Дополнительные указания (необязательно)', el('textarea', { id: 'b-extraInstructions', name: 'extraInstructions', rows: 3, maxlength: 1500, text: c.extraInstructions }), 'Например: «Всегда упоминай бесплатную доставку от 2000 грн». Работает в AI-режиме.'),
        err, el('button', { class: 'btn primary', type: 'submit', text: 'Сохранить' }));
      onSubmit(form, async d => {
        hide(err);
        try { await api(`/api/installations/${id}/config`, { config: { ...d, collectLeads: d.collectLeads === 'on' } }); await load(); say('Сохранено. Новые сообщения пойдут с этими настройками.'); }
        catch (x) { showError(err, x); }
      });
      return form;
    },

    async knowledge() {
      const { items } = await api(`/api/installations/${id}/knowledge`);
      const list = el('div', { class: 'card' }, el('h3', { text: `Ваши знания (${items.length})` }),
        items.length ? el('div', { class: 'kb-list' }, items.map(k => el('div', { class: 'kb-item' },
          el('span', { class: 'tag', text: k.kind === 'FAQ' ? 'FAQ' : 'Документ' }),
          el('div', {}, el('b', { text: k.title }), el('p', { text: k.content.length > 220 ? k.content.slice(0, 220) + '…' : k.content })),
          el('button', { class: 'btn sm danger', text: 'Удалить', 'aria-label': `Удалить ${k.title}`, onclick: async () => { try { await api(`/api/knowledge/${k.id}/delete`, {}); show('knowledge'); } catch (e) { say(e.message, true); } } }))))
          : el('p', { text: 'Пока пусто. Начните с 5–10 самых частых вопросов клиентов.' }));
      const faqErr = el('div', { class: 'alert err', role: 'alert', hidden: true });
      const faq = el('form', { class: 'card', novalidate: true }, el('h3', { text: 'Добавить вопрос и ответ' }),
        el('div', { class: 'field' }, el('label', { for: 'k-q', text: 'Вопрос' }), el('input', { id: 'k-q', name: 'title', placeholder: 'Сколько стоит доставка?', maxlength: 300 })),
        el('div', { class: 'field' }, el('label', { for: 'k-a', text: 'Ответ' }), el('textarea', { id: 'k-a', name: 'content', rows: 3, maxlength: 2000, placeholder: 'Доставка Новой почтой — 70 грн, от 2000 грн бесплатно.' })),
        faqErr, el('button', { class: 'btn primary', type: 'submit', text: 'Добавить' }));
      onSubmit(faq, async d => { hide(faqErr); try { await api(`/api/installations/${id}/knowledge`, { kind: 'FAQ', ...d }); show('knowledge'); say('Добавлено.'); } catch (e) { showError(faqErr, e); } });
      const docErr = el('div', { class: 'alert err', role: 'alert', hidden: true });
      const file = el('input', { type: 'file', accept: '.txt,.md,.csv,text/plain,text/markdown', 'aria-label': 'Загрузить текстовый файл' });
      const doc = el('form', { class: 'card', novalidate: true }, el('h3', { text: 'Добавить документ' }),
        el('p', { text: 'Прайс-листы, условия доставки и возврата, описания товаров. Вставьте текст или загрузите файл .txt / .md.' }),
        el('div', { class: 'field' }, el('label', { for: 'k-t', text: 'Заголовок' }), el('input', { id: 'k-t', name: 'title', placeholder: 'Условия возврата', maxlength: 300 })),
        el('div', { class: 'field' }, el('label', { for: 'k-c', text: 'Текст' }), el('textarea', { id: 'k-c', name: 'content', rows: 6, maxlength: 50000 })),
        el('div', { class: 'field' }, file),
        docErr, el('button', { class: 'btn primary', type: 'submit', text: 'Добавить документ' }));
      file.addEventListener('change', async () => {
        const f = file.files[0]; if (!f) return;
        if (f.size > 50000) { showError(docErr, new Error('Файл больше 50 КБ. Разделите его на части.')); return; }
        $('#k-c', doc).value = await f.text();
        if (!$('#k-t', doc).value) $('#k-t', doc).value = f.name.replace(/\.\w+$/, '');
      });
      onSubmit(doc, async d => { hide(docErr); try { await api(`/api/installations/${id}/knowledge`, { kind: 'DOC', title: d.title, content: d.content }); show('knowledge'); say('Документ добавлен.'); } catch (e) { showError(docErr, e); } });
      return el('div', { class: 'stack' }, el('div', { class: 'grid g2' }, faq, doc), list);
    },

    test() {
      const history = [];
      const log = el('div', { class: 'chat-log', 'aria-live': 'polite' }, el('p', { class: 'chat-note', text: opts().aiEnabled ? 'Отсюда сообщения никуда не отправляются. Задайте вопрос, который задают ваши клиенты.' : 'Режим FAQ: агент отвечает только на вопросы из ваших FAQ. Для полноценных AI-ответов добавьте ключ AI на сервере.' }));
      const input = el('input', { name: 'text', placeholder: 'Напишите сообщение от имени клиента…', autocomplete: 'off', maxlength: 2000, 'aria-label': 'Сообщение' });
      const err = el('div', { class: 'alert err', role: 'alert', hidden: true });
      const form = el('form', { class: 'chat-input', novalidate: true }, input, el('button', { class: 'btn primary', type: 'submit', text: 'Отправить' }));
      const bubble = (cls, text) => { log.append(el('div', { class: `msg ${cls}`, text })); log.scrollTop = log.scrollHeight; };
      onSubmit(form, async d => {
        const text = d.text.trim(); if (!text) return;
        hide(err); bubble('in', text); input.value = '';
        try {
          const r = await api(`/api/installations/${id}/test`, { text, history });
          history.push({ author: 'customer', text }, { author: 'agent', text: r.reply });
          bubble('out', r.reply);
          for (const a of r.actions) log.append(el('p', { class: 'chat-note', text: a.type === 'lead' ? `→ Сохранил бы заявку: ${Object.values(a.data).join(', ')}` : `→ Передал бы человеку: ${a.reason}` }));
        } catch (e) { showError(err, e); }
        input.focus();
      });
      return el('div', { class: 'card test-chat' }, el('div', { class: 'row-head' }, el('h3', { text: 'Тестовый чат' }), el('span', { class: 'tag', text: opts().aiMode })), log, err, form);
    },

    async conversations() {
      const wrap = el('div', { class: 'inbox' }), listBox = el('div', { class: 'card inbox-list' }), thread = el('div', { class: 'card inbox-thread' }, el('p', { class: 'muted', text: 'Выберите диалог.' }));
      let current = null;
      async function renderList() {
        const { conversations } = await api(`/api/installations/${id}/conversations`);
        listBox.replaceChildren(el('h3', { text: 'Диалоги' }), ...(conversations.length ? conversations.map(c => el('button', {
          class: `conv ${c.id === current ? 'on' : ''}`, onclick: () => { current = c.id; renderList(); renderThread(); } },
          el('div', { class: 'conv-top' }, el('b', { text: c.name || c.handle || 'Клиент' }), c.status === 'handoff' ? el('span', { class: 'badge st-pending', text: 'Нужны вы' }) : null),
          el('small', { text: (c.lastText || '').slice(0, 80) })))
          : [el('p', { text: hasChannels() ? 'Сообщений пока нет. Новые сообщения клиентов появятся здесь.' : 'У этого агента нет мессенджера.' })]));
      }
      async function renderThread() {
        if (!current) return;
        const { conversation: c, messages } = await api(`/api/conversations/${current}`);
        const err = el('div', { class: 'alert err', role: 'alert', hidden: true });
        const box = el('div', { class: 'chat-log' }, messages.map(m => el('div', { class: `msg ${m.direction === 'IN' ? 'in' : 'out'} ${m.author === 'human' ? 'human' : ''}` },
          el('span', { text: m.text }), el('small', { text: `${m.author === 'human' ? 'Вы' : m.author === 'agent' ? 'AI' : ''} ${new Date(m.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`.trim() }))));
        const form = el('form', { class: 'chat-input', novalidate: true }, el('input', { name: 'text', placeholder: 'Ответить от себя…', 'aria-label': 'Ответ', maxlength: 4000, autocomplete: 'off' }), el('button', { class: 'btn primary', type: 'submit', text: 'Отправить' }));
        onSubmit(form, async d => { if (!d.text.trim()) return; hide(err); try { await api(`/api/conversations/${current}/reply`, { text: d.text.trim() }); renderThread(); renderList(); } catch (e) { showError(err, e); } });
        thread.replaceChildren(
          el('div', { class: 'row-head' }, el('div', {}, el('h3', { text: c.name || 'Клиент' }), el('small', { class: 'muted', text: [c.handle, c.channel].filter(Boolean).join(' · ') })),
            c.status === 'handoff' ? el('button', { class: 'btn sm', text: 'Вернуть AI', onclick: async () => { await api(`/api/conversations/${current}/resolve`, {}); renderThread(); renderList(); } }) : null),
          c.status === 'handoff' ? el('div', { class: 'alert warn', text: `Ждёт вас: ${c.handoffReason || 'клиенту нужен человек'}. AI молчит, пока вы не вернёте ему диалог.` }) : null,
          box, err, form);
        box.scrollTop = box.scrollHeight;
      }
      await renderList();
      wrap.append(listBox, thread);
      const timer = setInterval(() => { if (!document.body.contains(wrap)) return clearInterval(timer); renderList(); if (current && !document.activeElement?.closest('.chat-input')) renderThread(); }, 5000);
      return wrap;
    },

    async leads() {
      const { leads } = await api(`/api/installations/${id}/leads`);
      const csv = () => [['Дата', 'Имя', 'Телефон', 'Email', 'Telegram', 'Заметка'], ...leads.map(l => [new Date(l.createdAt).toISOString().slice(0, 16).replace('T', ' '), l.name, l.phone, l.email, l.handle, l.note])]
        .map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
      return el('div', { class: 'card' },
        el('div', { class: 'row-head' }, el('h3', { text: `Заявки (${leads.length})` }),
          leads.length ? el('button', { class: 'btn sm', text: 'Скопировать как CSV', onclick: async () => { try { await navigator.clipboard.writeText(csv()); say('Скопировано. Вставьте в Excel или Google Таблицы.'); } catch { say("Не удалось скопировать: браузер заблокировал буфер обмена.", true); } } }) : null),
        leads.length ? el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Дата', 'Имя', 'Телефон', 'Email', 'Заметка'].map(h => el('th', { text: h })))),
          el('tbody', {}, leads.map(l => el('tr', {}, el('td', { text: fmtDate(l.createdAt) }), el('td', {}, el('div', { text: l.name || '—' }), l.handle ? el('small', { class: 'muted', text: l.handle }) : null),
            el('td', { text: l.phone || '—' }), el('td', { text: l.email || '—' }), el('td', { class: 'review-cell', text: l.note || '' }))))))
          : el('p', { text: 'Здесь появятся контакты, которые клиенты оставят в чате.' }));
    },

    async stats() {
      const s = await api(`/api/installations/${id}/stats`);
      const max = Math.max(1, ...s.incoming, ...s.replies);
      const tile = (v, l) => el('div', {}, el('b', { text: String(v) }), el('span', { text: l }));
      return el('div', { class: 'stack' },
        el('div', { class: 'stats' }, tile(s.totals.conversations, 'диалогов'), tile(s.totals.replies, 'автоответов'), tile(s.totals.leads, 'заявок собрано'), tile(s.totals.handoffs, 'передано человеку')),
        el('div', { class: 'card' }, el('div', { class: 'row-head' }, el('h3', { text: 'Последние 7 дней' }),
          el('div', { class: 'legend' }, el('span', { class: 'k in', text: 'Входящие' }), el('span', { class: 'k out', text: 'Ответы' }))),
          el('div', { class: 'bars', role: 'img', 'aria-label': `Сообщения по дням: ${s.days.map((d, k) => `${d}: входящих ${s.incoming[k]}, ответов ${s.replies[k]}`).join('; ')}` },
            s.days.map((d, k) => el('div', { class: 'bar-col' },
              el('div', { class: 'bar-pair' }, el('i', { class: 'in', style: `height:${(s.incoming[k] / max) * 100}%`, title: `входящих: ${s.incoming[k]}` }), el('i', { class: 'out', style: `height:${(s.replies[k] / max) * 100}%`, title: `ответов: ${s.replies[k]}` })),
              el('small', { text: new Date(d).toLocaleDateString(undefined, { weekday: 'short' }) }))))),
        el('p', { class: 'notice', text: `Использовано AI-токенов: ${s.totals.tokens.toLocaleString('ru-RU')}.` }));
    },
  };

  async function show(name) {
    if (!views[name]) name = 'connect';
    $$('.tabs a').forEach(a => a.classList.toggle('on', a.hash === `#${name}`));
    try { root.replaceChildren(await views[name]()); } catch (e) { root.replaceChildren(el('div', { class: 'alert err', text: e.message })); }
  }
  addEventListener('hashchange', () => { flash.hidden = true; show(location.hash.slice(1)); });
  show(location.hash.slice(1));
})();
