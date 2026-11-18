// VIP Academy pages: public academy page, learning hub, course, lesson, community, certificate.
// All API data goes into the page as text (el / renderRich), never as HTML.

// Lesson text: "## " headings, "- " bullets, blank lines between paragraphs.
function renderRich(text) {
  const out = []; let list = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    if (/^##\s+/.test(line)) { list = null; out.push(el('h3', { class: 'rich-h', text: line.replace(/^##\s+/, '') })); }
    else if (/^[-•]\s+/.test(line)) { if (!list) { list = el('ul', { class: 'rich-ul' }); out.push(list); } list.append(el('li', { text: line.replace(/^[-•]\s+/, '') })); }
    else if (!line.trim()) list = null;
    else { list = null; out.push(el('p', { text: line })); }
  }
  return el('div', { class: 'rich' }, out);
}
const KIND = { LESSON: 'Урок', TUTORIAL: 'Разбор AI-инструмента', WORKSHOP: 'Воркшоп' };
const SUB = { SUBMITTED: ['На проверке', 'st-pending'], NEEDS_WORK: ['Нужна доработка', 'st-failed'], APPROVED: ['Принято', 'st-paid'] };
const when = d => new Date(d).toLocaleString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const bar = pct => el('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, el('i', { style: `width:${pct}%` }));
const lockMsg = (text = 'Это часть VIP Академии.') => el('div', { class: 'card lock-card' }, el('h3', { text: '🔒 Только для участников' }), el('p', { text }),
  el('a', { class: 'btn primary', href: 'academy.html#plans', style: 'margin-top:16px', text: 'Посмотреть тарифы' }));

const academyPages = {
  // ---------- public Academy page ----------
  async academy() {
    let d;
    try { d = await api('/api/academy'); } catch { return; }
    if (d.viewer.member) { const c = $('[data-hero-cta]'); c.textContent = 'Продолжить обучение'; c.href = 'learn.html'; }
    $('[data-roadmap]').replaceChildren(...d.courses.map(c => el('a', { class: 'step reveal in road', href: `course.html?slug=${encodeURIComponent(c.slug)}` },
      el('span', { class: 'n', text: c.month ? `МЕСЯЦ ${c.month}` : 'BONUS' }),
      el('div', {}, el('h3', { text: c.title }), el('p', { text: c.summary }),
        el('div', { class: 'tags' }, el('span', { class: 'tag', text: `${c.lessons} ${plural(c.lessons, 'урок', 'урока', 'уроков')}` }), c.minutes ? el('span', { class: 'tag', text: `~${Math.round(c.minutes / 60 * 10) / 10} ч` }) : null,
          c.assignments ? el('span', { class: 'tag', text: `${c.assignments} ${plural(c.assignments, 'задание', 'задания', 'заданий')}` }) : null,
          c.previews ? el('span', { class: 'tag free', text: `бесплатно: ${c.previews}` }) : null,
          c.progress?.done ? el('span', { class: 'tag', text: `пройдено ${c.progress.percent}%` }) : null)))));

    const intervals = ['MONTH', 'YEAR', 'ONE_TIME'].filter(i => d.plans.some(p => p.prices.some(x => x.interval === i)));
    let interval = intervals[0];
    const grid = $('[data-plans]'), err = $('[data-plan-err]');
    const render = () => grid.replaceChildren(...d.plans.map(p => {
      const price = p.prices.find(x => x.interval === interval) || p.prices[0];
      return el('div', { class: `card plan ${p.mentorship ? 'feat' : ''}` },
        p.mentorship ? el('span', { class: 'tag', text: 'С личным менторством' }) : null,
        el('h3', { style: 'margin-top:12px', text: p.name }), el('p', { text: p.description }),
        price ? el('div', { class: 'price' }, money(price.amount, price.currency), el('small', { text: PER[price.interval] })) : null,
        el('ul', {}, p.features.map(f => el('li', { text: f }))),
        price ? el('button', { class: `btn ${p.mentorship ? 'primary' : ''}`, text: `Выбрать «${p.name}»`, onclick: async e => {
          if (!d.viewer.loggedIn) { location.href = `register.html?next=${encodeURIComponent('academy.html#plans')}`; return; }
          e.target.disabled = true; hide(err);
          try { const { order } = await api('/api/academy/orders', { priceId: price.id }); location.href = `order.html?id=${encodeURIComponent(order.id)}`; }
          catch (x) { showError(err, x); e.target.disabled = false; }
        } }) : null);
    }));
    const tg = $('[data-interval]');
    tg.replaceChildren(...(intervals.length > 1 ? intervals.map(i => el('button', { type: 'button', class: i === interval ? 'on' : '', text: { MONTH: 'Ежемесячно', YEAR: 'Ежегодно', ONE_TIME: 'Разовый платёж' }[i],
      onclick: e => { interval = i; $$('button', tg).forEach(b => b.classList.toggle('on', b === e.target)); render(); } })) : []));
    tg.hidden = intervals.length < 2;
    render();
  },

  // ---------- learning hub ----------
  async learn() {
    let d;
    try { d = await api('/api/academy/me'); } catch (e) { if (e.status === 401) location.replace('login.html?next=learn.html'); return; }
    const m = d.membership, root = $('[data-learn]');
    const head = el('div', { class: 'dash-head' }, el('div', {}, el('span', { class: 'eyebrow', text: 'VIP Академия' }), el('h1', { text: 'Ваше обучение' })),
      d.next ? el('a', { class: 'btn primary', href: `lesson.html?id=${encodeURIComponent(d.next.id)}`, text: `Продолжить: ${d.next.title}` }) : null);
    const status = m.active || m.admin
      ? el('div', { class: 'alert ok', text: m.admin && !m.active ? 'Режим администратора: вам видны все уроки.' : `${m.plan} · доступ до ${fmtDate(m.endsAt)}${m.mentorship ? ' · менторство включено' : ''}` })
      : el('div', { class: 'alert warn' }, el('span', { text: 'Вы можете смотреть бесплатные ознакомительные уроки. Вступите в VIP Академию, чтобы открыть всё.' }), el('a', { class: 'btn', href: 'academy.html#plans', text: 'Тарифы' }));
    const total = d.courses.reduce((s, c) => s + c.progress.total, 0), done = d.courses.reduce((s, c) => s + c.progress.done, 0);
    const program = el('div', { class: 'card' }, el('div', { class: 'row-head' }, el('h3', { text: 'Шестимесячная программа' }), el('b', { text: `${total ? Math.round(done / total * 100) : 0}%` })),
      el('p', { text: `Пройдено уроков: ${done} из ${total}` }), bar(total ? Math.round(done / total * 100) : 0),
      el('div', { class: 'course-list' }, d.courses.map(c => el('a', { class: 'mini', href: `course.html?slug=${encodeURIComponent(c.slug)}` },
        el('span', { class: 'month-pill', text: c.month ? `M${c.month}` : '★' }),
        el('div', {}, el('b', { text: c.title }), el('small', { text: `Уроков: ${c.progress.done}/${c.progress.total}` }), bar(c.progress.percent)),
        d.certificates.some(x => x.title === c.title) ? el('span', { class: 'badge on', text: 'Сертификат' }) : null))));
    const side = el('div', { class: 'stack' },
      d.feedback.length ? el('div', { class: 'card' }, el('h3', { text: 'Вас ждёт отзыв' }), el('div', { class: 'minis' }, d.feedback.map(f => el('a', { class: 'mini', href: `lesson.html?id=${encodeURIComponent(f.lessonId)}` },
        el('div', {}, el('b', { text: f.title }), el('small', { text: f.feedback || '' })), el('span', { class: 'badge st-failed', text: 'Нужна доработка' }))))) : null,
      el('div', { class: 'card' }, el('div', { class: 'row-head' }, el('h3', { text: 'Живые воркшопы и Q&A' }), el('a', { class: 'btn sm', href: 'live.html', text: 'Все сессии' })),
        d.live.length ? el('div', { class: 'minis' }, d.live.map(s => el('div', { class: 'mini' }, el('div', {}, el('b', { text: s.title }), el('small', { text: `${s.kind === 'QA' ? 'Q&A' : 'Воркшоп'} · ${when(s.startsAt)}` })),
          s.joinUrl ? el('a', { class: 'btn sm primary', href: s.joinUrl, target: '_blank', rel: 'noopener', text: 'Подключиться' }) : null)))
          : el('p', { text: 'Сейчас нет запланированных сессий.' })),
      el('div', { class: 'card' }, el('h3', { text: 'Сертификаты' }),
        d.certificates.length ? el('div', { class: 'minis' }, d.certificates.map(c => el('a', { class: 'mini', href: `certificate.html?code=${c.code}` }, el('div', {}, el('b', { text: c.title }), el('small', { text: `Выдан ${fmtDate(c.issuedAt)}` })), el('span', { class: 'btn sm', text: 'Открыть' }))))
          : el('p', { text: 'Пройдите все уроки курса и сдайте задания, чтобы получить сертификат.' })),
      el('div', { class: 'grid g2 quick' },
        el('a', { class: 'card hover', href: 'community.html' }, el('h3', { text: 'Сообщество' }), el('p', { text: 'Задавайте вопросы, делитесь успехами.' })),
        el('a', { class: 'card hover', href: 'mentorship.html' }, el('h3', { text: 'Менторство' }), el('p', { text: m.mentorship ? 'Запишитесь на личную сессию.' : 'Доступно в тарифе VIP + Менторство.' }))));
    root.replaceChildren(head, status, el('div', { class: 'learn-grid' }, program, side));
  },

  // ---------- course ----------
  async course() {
    const root = $('[data-course]');
    let d;
    try { d = await api(`/api/academy/courses/${encodeURIComponent(params.get('slug') || 'x')}`); }
    catch { root.replaceChildren(el('h1', { text: 'Курс не найден' }), el('a', { class: 'btn', href: 'academy.html', style: 'margin-top:16px', text: 'Назад в Академию' })); return; }
    const c = d.course;
    document.title = `${c.title} · NeuralDesk`;
    $('[data-crumb]').textContent = c.title;
    const firstOpen = d.modules.flatMap(m => m.lessons).find(l => !l.locked && !l.completed) || d.modules.flatMap(m => m.lessons).find(l => !l.locked);
    root.replaceChildren(el('div', { class: 'two' },
      el('div', {},
        el('span', { class: 'eyebrow', text: c.month ? `Месяц ${c.month} · ${LEVEL_RU[c.level] || c.level}` : (LEVEL_RU[c.level] || c.level) }),
        el('h1', { class: 'agent-title', text: c.title }), el('p', { class: 'agent-lead', text: c.summary }),
        c.description ? renderRich(c.description) : null,
        el('div', { class: 'outline' }, d.modules.map((m, mi) => el('div', { class: 'card module' },
          el('h3', { text: `${mi + 1}. ${m.title}` }),
          el('div', { class: 'lesson-rows' }, m.lessons.map(l => el(l.locked ? 'div' : 'a', { class: `lesson-row ${l.locked ? 'locked' : ''}`, ...(l.locked ? {} : { href: `lesson.html?id=${encodeURIComponent(l.id)}` }) },
            el('span', { class: `dot ${l.completed ? 'done' : ''}`, 'aria-label': l.completed ? 'Пройден' : 'Не пройден', text: l.completed ? '✓' : l.locked ? '🔒' : '' }),
            el('div', {}, el('b', { text: l.title }), el('small', { text: [KIND[l.kind], l.durationMin ? `${l.durationMin} мин` : null, l.hasAssignment ? 'задание' : null].filter(Boolean).join(' · ') })),
            l.preview && !d.viewer.member ? el('span', { class: 'tag free', text: 'Бесплатно' }) : null,
            l.submission ? el('span', { class: `badge ${SUB[l.submission][1]}`, text: SUB[l.submission][0] }) : null))))))),
      el('aside', { class: 'side card' },
        el('h3', { text: 'Ваш прогресс' }), el('p', { text: `${d.progress.done} из ${d.progress.total} уроков` }), bar(d.progress.percent),
        d.certificate ? el('a', { class: 'btn primary', href: `certificate.html?code=${d.certificate.code}`, style: 'margin-top:18px;width:100%', text: '🎓 Открыть сертификат' }) : null,
        firstOpen ? el('a', { class: `btn ${d.certificate ? '' : 'primary'}`, href: `lesson.html?id=${encodeURIComponent(firstOpen.id)}`, style: 'margin-top:12px;width:100%', text: d.progress.done ? 'Продолжить' : 'Начать курс' }) : null,
        !d.viewer.member ? el('a', { class: 'btn', href: 'academy.html#plans', style: 'margin-top:12px;width:100%', text: 'Открыть все уроки' }) : null,
        el('p', { class: 'notice', text: 'Сертификат выдаётся, когда пройдены все уроки и приняты все задания.' }))));
  },

  // ---------- lesson ----------
  async lesson() {
    const root = $('[data-lesson]'), id = params.get('id');
    let l;
    try { l = await api(`/api/academy/lessons/${encodeURIComponent(id || 'x')}`); }
    catch (e) {
      if (e.data?.locked) {
        $('[data-crumb]').replaceChildren(el('a', { href: `course.html?slug=${encodeURIComponent(e.data.course.slug)}`, text: e.data.course.title }), ` / ${e.data.title}`);
        root.replaceChildren(el('h1', { class: 'agent-title', text: e.data.title }), lockMsg(e.data.error)); return;
      }
      root.replaceChildren(el('h1', { text: 'Урок не найден' })); return;
    }
    document.title = `${l.title} · NeuralDesk`;
    $('[data-crumb]').replaceChildren(el('a', { href: `course.html?slug=${encodeURIComponent(l.course.slug)}`, text: l.course.title }), ` / ${l.title}`);
    const flash = el('div', { class: 'alert ok', role: 'status', hidden: true });
    const doneBtn = el('button', { class: `btn ${l.completed ? '' : 'primary'}`, text: l.completed ? '✓ Пройден' : 'Отметить как пройденный' });
    doneBtn.addEventListener('click', async () => {
      if (!l.viewer.loggedIn) { location.href = `login.html?next=${encodeURIComponent(`lesson.html?id=${l.id}`)}`; return; }
      try {
        const r = await api(`/api/academy/lessons/${l.id}/complete`, { done: !l.completed });
        l.completed = r.completed; doneBtn.textContent = l.completed ? '✓ Пройден' : 'Отметить как пройденный'; doneBtn.className = `btn ${l.completed ? '' : 'primary'}`;
        if (r.certificate) { flash.replaceChildren('🎓 Вы получили сертификат за этот курс! ', el('a', { href: `certificate.html?code=${r.certificate}`, text: 'Открыть' })); flash.hidden = false; }
        else if (l.completed && l.nav.next) { flash.replaceChildren('Отличная работа! ', el('a', { href: `lesson.html?id=${l.nav.next.id}`, text: `Дальше: ${l.nav.next.title} →` })); flash.hidden = false; }
      } catch (e) { flash.className = 'alert err'; flash.textContent = e.message; flash.hidden = false; }
    });

    let assignment = null;
    if (l.assignment) {
      const s = l.submission;
      const err = el('div', { class: 'alert err', role: 'alert', hidden: true });
      const form = el('form', { novalidate: true },
        el('div', { class: 'field' }, el('label', { for: 'a-body', text: 'Ваш ответ' }), el('textarea', { id: 'a-body', name: 'body', rows: 6, maxlength: 10000, text: s?.body || '' })),
        el('div', { class: 'field' }, el('label', { for: 'a-link', text: 'Ссылка (необязательно)' }), el('input', { id: 'a-link', name: 'link', placeholder: 'https://…', value: s?.link || '' }),
          el('span', { class: 'hint', text: 'Google Doc, видео, ваш бот, папка со скриншотами.' })),
        err, el('button', { class: 'btn primary', type: 'submit', text: s ? 'Отправить снова' : 'Отправить на проверку' }));
      onSubmit(form, async d => {
        hide(err);
        if (!l.viewer.member) { showError(err, new Error('Задания проверяются для участников VIP. Вступите, чтобы отправить.')); return; }
        try { await api(`/api/academy/lessons/${l.id}/submission`, { body: d.body, link: d.link.trim() || undefined }); location.reload(); } catch (e) { showError(err, e); }
      });
      assignment = el('div', { class: 'card assignment', id: 'assignment' },
        el('div', { class: 'row-head' }, el('h3', { text: 'Задание' }), s ? el('span', { class: `badge ${SUB[s.status][1]}`, text: SUB[s.status][0] }) : null),
        el('p', { class: 'task', text: l.assignment }),
        s?.feedback ? el('div', { class: `alert ${s.status === 'APPROVED' ? 'ok' : 'warn'}`, style: 'display:block' }, el('b', { text: 'Feedback: ' }), s.feedback) : null,
        s?.status === 'APPROVED' ? el('p', { text: 'Принято. Отлично!' }) : form);
    }

    root.replaceChildren(
      el('span', { class: 'eyebrow', text: [KIND[l.kind], l.durationMin ? `${l.durationMin} мин` : null].filter(Boolean).join(' · ') }),
      el('h1', { class: 'agent-title', text: l.title }),
      l.preview && !l.viewer.member ? el('p', { class: 'notice', text: 'Бесплатный ознакомительный урок.' }) : null,
      l.videoUrl ? el('div', { class: 'video' }, el('iframe', { src: l.videoUrl, title: l.title, allow: 'fullscreen; picture-in-picture; encrypted-media', allowfullscreen: true, loading: 'lazy', referrerpolicy: 'strict-origin-when-cross-origin' }))
        : el('div', { class: 'video empty' }, el('p', { text: 'Видео скоро появится.' })),
      renderRich(l.body),
      l.materials.length ? el('div', { class: 'card' }, el('h3', { text: 'Материалы' }), el('ul', { class: 'materials' }, l.materials.map(m => el('li', {}, el('a', { href: m.url, target: '_blank', rel: 'noopener noreferrer', text: m.title }))))) : null,
      assignment, flash,
      el('div', { class: 'lesson-nav' },
        l.nav.prev ? el('a', { class: 'btn', href: `lesson.html?id=${l.nav.prev.id}`, text: '← Назад' }) : el('span'),
        doneBtn,
        l.nav.next ? el('a', { class: 'btn', href: `lesson.html?id=${l.nav.next.id}`, text: 'Дальше →' }) : el('a', { class: 'btn', href: `course.html?slug=${encodeURIComponent(l.course.slug)}`, text: 'О курсе' })));
  },

  // ---------- community ----------
  async community() {
    const root = $('[data-community]'), postId = params.get('post');
    try { await api('/api/academy/me'); } catch (e) { if (e.status === 401) { location.replace('login.html?next=community.html'); return; } }
    if (postId) {
      let d;
      try { d = await api(`/api/community/${encodeURIComponent(postId)}`); } catch (e) { root.replaceChildren(e.status === 403 ? lockMsg(e.message) : el('h2', { text: 'Пост не найден' })); return; }
      const p = d.post, err = el('div', { class: 'alert err', role: 'alert', hidden: true });
      const form = el('form', { class: 'card', novalidate: true }, el('div', { class: 'field' }, el('label', { for: 'cm', text: 'Ваш ответ' }), el('textarea', { id: 'cm', name: 'body', rows: 3, maxlength: 3000 })), err, el('button', { class: 'btn primary', type: 'submit', text: 'Ответить' }));
      onSubmit(form, async x => { hide(err); try { await api(`/api/community/${p.id}/comments`, { body: x.body }); location.reload(); } catch (e) { showError(err, e); } });
      const del = (url, label) => el('button', { class: 'btn sm danger', text: label, onclick: async e => {
        if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = 'Нажмите ещё раз'; return; }
        await api(url, {}); url.includes('/comments/') ? location.reload() : location.replace('community.html'); } });
      root.replaceChildren(el('a', { class: 'crumbs', href: 'community.html', text: '← Все посты' }),
        el('article', { class: 'card post-full' },
          el('div', { class: 'row-head' }, el('div', {}, el('h2', { text: p.title }), el('small', { class: 'muted', text: `${p.author}${p.team ? ' · Команда' : ''} · ${fmtDate(p.createdAt)}` })),
            el('div', { class: 'order-actions', style: 'margin:0' }, d.admin ? el('button', { class: 'btn sm', text: p.pinned ? 'Открепить' : 'Закрепить', onclick: async () => { await api(`/api/community/${p.id}/pin`, { pinned: !p.pinned }); location.reload(); } }) : null,
              p.canDelete ? del(`/api/community/${p.id}/delete`, 'Удалить') : null)),
          el('p', { class: 'post-body', text: p.body })),
        el('div', { class: 'stack', style: 'margin-top:18px' }, d.comments.map(cm => el('div', { class: 'card comment' },
          el('div', { class: 'row-head' }, el('small', { class: 'muted', text: `${cm.author}${cm.team ? ' · Команда' : ''} · ${fmtDate(cm.createdAt)}` }), cm.canDelete ? del(`/api/community/comments/${cm.id}/delete`, 'Удалить') : null),
          el('p', { class: 'post-body', text: cm.body }))), form));
      return;
    }
    let d;
    try { d = await api('/api/community'); } catch (e) { root.replaceChildren(e.status === 403 ? lockMsg('Закрытое сообщество — для студентов VIP Академии.') : el('p', { text: e.message })); return; }
    const err = el('div', { class: 'alert err', role: 'alert', hidden: true });
    const form = el('form', { class: 'card', novalidate: true }, el('h3', { text: 'Начать обсуждение' }),
      el('div', { class: 'field' }, el('label', { for: 'pt', text: 'Заголовок' }), el('input', { id: 'pt', name: 'title', maxlength: 140 })),
      el('div', { class: 'field' }, el('label', { for: 'pb', text: 'Сообщение' }), el('textarea', { id: 'pb', name: 'body', rows: 4, maxlength: 5000 })), err, el('button', { class: 'btn primary', type: 'submit', text: 'Опубликовать' }));
    onSubmit(form, async x => { hide(err); try { const r = await api('/api/community', x); location.href = `community.html?post=${r.id}`; } catch (e) { showError(err, e); } });
    root.replaceChildren(el('div', { class: 'learn-grid' },
      el('div', { class: 'stack' }, d.posts.length ? d.posts.map(p => el('a', { class: 'card hover post', href: `community.html?post=${encodeURIComponent(p.id)}` },
        el('div', { class: 'row-head' }, el('h3', { text: `${p.pinned ? '📌 ' : ''}${p.title}` }), el('small', { class: 'muted', text: `${p.comments} ${plural(p.comments, 'ответ', 'ответа', 'ответов')}` })),
        el('p', { text: p.body }), el('small', { class: 'muted', text: `${p.author}${p.team ? ' · Команда' : ''} · ${fmtDate(p.createdAt)}` }))) : el('p', { class: 'muted', text: 'Постов пока нет. Будьте первым!' })),
      form));
  },

  // ---------- live sessions ----------
  async live() {
    const d = await api('/api/academy/live').catch(() => ({ sessions: [], member: false }));
    const now = Date.now(), up = d.sessions.filter(s => Date.parse(s.startsAt) + s.durationMin * 60e3 > now).reverse(), past = d.sessions.filter(s => Date.parse(s.startsAt) + s.durationMin * 60e3 <= now);
    const row = s => el('div', { class: 'card live' }, el('div', { class: 'row-head' }, el('div', {}, el('span', { class: 'tag', text: s.kind === 'QA' ? 'Q&A' : 'Воркшоп' }), el('h3', { style: 'margin-top:8px', text: s.title })),
      s.joinUrl && Date.parse(s.startsAt) + s.durationMin * 60e3 > now ? el('a', { class: 'btn primary', href: s.joinUrl, target: '_blank', rel: 'noopener', text: 'Подключиться' }) : s.recordingUrl ? el('a', { class: 'btn', href: s.recordingUrl, target: '_blank', rel: 'noopener', text: 'Смотреть запись' }) : null),
      el('p', { text: `${when(s.startsAt)} · ${s.durationMin} мин` }), s.description ? el('p', { text: s.description }) : null);
    $('[data-live]').replaceChildren(!d.member ? el('div', { class: 'alert warn' }, el('span', { text: 'Ссылки на подключение и записи — для участников VIP.' }), el('a', { class: 'btn', href: 'academy.html#plans', text: 'Тарифы' })) : '',
      el('h3', { class: 'sec-title', text: 'Предстоящие' }), ...(up.length ? up.map(row) : [el('p', { class: 'muted', text: 'Пока ничего не запланировано.' })]),
      past.length ? el('h3', { class: 'sec-title', text: 'Прошедшие сессии' }) : '', ...past.map(row));
  },

  // ---------- mentorship ----------
  async mentorship() {
    let d;
    try { d = await api('/api/academy/mentorship'); } catch (e) { if (e.status === 401) location.replace('login.html?next=mentorship.html'); return; }
    const root = $('[data-mentor]');
    if (!d.available) { root.replaceChildren(lockMsg('Личные сессии с ментором входят в тариф VIP + Менторство.')); return; }
    const err = el('div', { class: 'alert err', role: 'alert', hidden: true });
    const form = el('form', { class: 'card', novalidate: true }, el('h3', { text: 'Запросить сессию' }),
      el('div', { class: 'field' }, el('label', { for: 'mt', text: 'Тема' }), el('input', { id: 'mt', name: 'topic', maxlength: 120, placeholder: 'Как оценить мой первый клиентский проект' })),
      el('div', { class: 'field' }, el('label', { for: 'mm', text: 'Над чем хотите поработать?' }), el('textarea', { id: 'mm', name: 'message', rows: 4, maxlength: 3000 })),
      err, el('button', { class: 'btn primary', type: 'submit', text: 'Отправить запрос' }));
    onSubmit(form, async x => { hide(err); try { await api('/api/academy/mentorship', x); location.reload(); } catch (e) { showError(err, e); } });
    const label = { OPEN: ['Ожидает', 'st-pending'], SCHEDULED: ['Назначена', 'st-paid'], DONE: ['Проведена', 'off'], CANCELED: ['Отменена', 'off'] };
    root.replaceChildren(el('div', { class: 'learn-grid' },
      el('div', { class: 'stack' }, d.requests.length ? d.requests.map(r => el('div', { class: 'card' },
        el('div', { class: 'row-head' }, el('h3', { text: r.topic }), el('span', { class: `badge ${label[r.status][1]}`, text: label[r.status][0] })),
        el('p', { text: r.message }),
        r.status === 'SCHEDULED' ? el('div', { class: 'alert ok', style: 'margin-top:12px' }, `${when(r.scheduledAt)} · `, el('a', { href: r.meetingUrl, target: '_blank', rel: 'noopener', text: 'Ссылка на подключение' })) : null,
        r.note ? el('p', { class: 'hint', text: r.note }) : null,
        ['OPEN', 'SCHEDULED'].includes(r.status) ? el('button', { class: 'btn sm', style: 'margin-top:12px', text: 'Отменить', onclick: async () => { await api(`/api/academy/mentorship/${r.id}/cancel`, {}); location.reload(); } }) : null))
        : el('p', { class: 'muted', text: 'Сессий пока нет.' })), form));
  },

  // ---------- certificate (public) ----------
  async certificate() {
    const root = $('[data-cert]');
    try {
      const { certificate: c } = await api(`/api/certificates/${encodeURIComponent(params.get('code') || 'x')}`);
      document.title = `Сертификат · ${c.name} · NeuralDesk`;
      root.replaceChildren(el('div', { class: 'cert' },
        el('div', { class: 'cert-logo' }, el('i'), 'VIP Академия NeuralDesk'),
        el('p', { class: 'cert-small', text: 'Сертификат о прохождении' }),
        el('p', { class: 'cert-small', text: 'Настоящим подтверждается, что' }),
        el('h1', { class: 'cert-name', text: c.name }),
        el('p', { class: 'cert-small', text: 'успешно прошёл(-ла) курс' }),
        el('h2', { class: 'cert-course', text: c.course }),
        el('p', { class: 'cert-meta', text: `${c.month ? `Месяц ${c.month} шестимесячной программы · ` : ''}уроков: ${c.lessons}, все задания сданы` }),
        el('div', { class: 'cert-foot' }, el('div', {}, el('b', { text: fmtDate(c.issuedAt) }), el('small', { text: 'Дата выдачи' })), el('div', {}, el('b', { text: c.code }), el('small', { text: 'Код проверки' })))),
        el('div', { class: 'order-actions no-print', style: 'justify-content:center' }, el('button', { class: 'btn primary', text: 'Печать или PDF', onclick: () => window.print() }),
          el('button', { class: 'btn', text: 'Копировать ссылку', onclick: async e => { try { await navigator.clipboard.writeText(location.href); e.target.textContent = 'Скопировано'; } catch { e.target.textContent = 'Не удалось скопировать'; } } })),
        el('p', { class: 'notice no-print', style: 'text-align:center', text: 'Любой, у кого есть эта ссылка, может проверить подлинность сертификата.' }));
    } catch { root.replaceChildren(el('div', { class: 'card', style: 'max-width:520px;margin:0 auto;text-align:center' }, el('h2', { text: 'Сертификат не найден' }), el('p', { text: 'Проверьте код и попробуйте ещё раз.' }))); }
  },
};

academyPages[document.body.dataset.page]?.();
