// Admin panel tabs for the VIP Academy. Registered into the admin panel (market.js) via ADMIN_EXTRA.
const dollars = c => (c === undefined || c === null ? '' : String(c / 100));
const cents = v => { const s = String(v ?? '').trim().replace(',', '.'); if (!s) return null; const n = Number(s); if (!isFinite(n) || n < 0) throw new Error(`«${v}» — неверная цена`); return Math.round(n * 100); };
const linesOf = v => String(v || '').split('\n').map(s => s.trim()).filter(Boolean);
const field = (label, input, hint) => el('div', { class: 'field' }, el('label', { text: label }), input, hint ? el('span', { class: 'hint', text: hint }) : null);
const twoClick = (label, fn) => el('button', { type: 'button', class: 'btn sm danger', text: label, onclick: async e => {
  if (e.target.dataset.armed !== '1') { e.target.dataset.armed = '1'; e.target.textContent = 'Нажмите ещё раз для подтверждения'; return; }
  await fn();
} });
const localInput = iso => { if (!iso) return ''; const d = new Date(iso); return new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16); };
const fmtWhen = d => new Date(d).toLocaleString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

window.ADMIN_EXTRA = {
  // ---------------- Courses & plans ----------------
  async academy({ say }) {
    const list = el('tbody'), editor = el('div', { class: 'stack' }), plansBox = el('div', { class: 'stack' });
    async function refresh() {
      const { courses } = await api('/api/admin/academy/courses');
      list.replaceChildren(...courses.map(c => el('tr', {},
        el('td', { text: c.month ? `M${c.month}` : '—' }), el('td', { text: c.title }), el('td', { text: String(c.lessons) }), el('td', { text: String(c.students) }),
        el('td', {}, el('span', { class: `badge ${c.published ? 'on' : 'off'}`, text: c.published ? 'Опубликован' : 'Скрыт' })),
        el('td', {}, el('button', { class: 'btn sm', text: 'Изменить', onclick: () => openCourse(c.id) })))));
    }

    async function openCourse(id) {
      const d = id ? await api(`/api/admin/academy/courses/${id}`) : { course: { slug: '', title: '', summary: '', description: '', month: '', level: 'Beginner', published: false }, modules: [] };
      const c = d.course;
      const f = el('form', { class: 'card', novalidate: true },
        el('div', { class: 'row-head' }, el('h3', { text: id ? `Курс: ${c.title}` : 'Новый курс' }), el('button', { type: 'button', class: 'btn sm', text: 'Закрыть', onclick: () => editor.replaceChildren() })),
        el('div', { class: 'grid g2' }, field('Название', el('input', { name: 'title', value: c.title })), field('Слаг (URL)', el('input', { name: 'slug', value: c.slug }), 'Строчные латинские буквы, цифры, дефисы')),
        field('Краткое описание', el('input', { name: 'summary', value: c.summary })),
        field('Описание', el('textarea', { name: 'description', rows: 3, text: c.description || '' }), 'Необязательно. «## » — заголовки, «- » — списки.'),
        el('div', { class: 'grid g2' }, field('Месяц программы', el('input', { name: 'month', inputmode: 'numeric', value: c.month ?? '' }), '1–6, или пусто для бонусного курса'),
          field('Уровень', el('select', { name: 'level' }, ['Beginner', 'Intermediate', 'Advanced'].map(l => el('option', { value: l, selected: c.level === l, text: LEVEL_RU[l] }))))),
        el('label', { class: 'switch' }, el('input', { type: 'checkbox', name: 'published', checked: c.published }), ' Published'),
        el('div', { class: 'order-actions' }, el('button', { class: 'btn primary', type: 'submit', text: id ? 'Сохранить курс' : 'Создать курс' }),
          id ? twoClick('Удалить курс', async () => { try { await api(`/api/admin/academy/courses/${id}/delete`, {}); say('Курс удалён.'); editor.replaceChildren(); refresh(); } catch (e) { say(e.message, true); } }) : null));
      onSubmit(f, async () => {
        const fd = new FormData(f);
        const body = { title: fd.get('title'), slug: fd.get('slug').trim(), summary: fd.get('summary'), description: fd.get('description'), month: fd.get('month') ? Number(fd.get('month')) : null, level: fd.get('level'), published: fd.get('published') === 'on' };
        try {
          if (id) { await api(`/api/admin/academy/courses/${id}`, body); say('Курс сохранён.'); }
          else { delete body.published; const r = await api('/api/admin/academy/courses', body); say('Курс создан. Добавьте модуль и уроки, затем опубликуйте.'); refresh(); return openCourse(r.id); }
          refresh();
        } catch (e) { say(e.message, true); }
      });

      const modules = id ? el('div', { class: 'stack' }, d.modules.map(m => moduleCard(id, m)),
        (() => { const mf = el('form', { class: 'card add-row', novalidate: true }, el('input', { name: 'title', placeholder: 'Название нового модуля', 'aria-label': 'Название нового модуля' }), el('button', { class: 'btn', type: 'submit', text: '+ Добавить модуль' }));
          onSubmit(mf, async x => { try { await api(`/api/admin/academy/courses/${id}/modules`, x); openCourse(id); } catch (e) { say(e.message, true); } }); return mf; })()) : null;
      editor.replaceChildren(f, modules || '');
      editor.scrollIntoView({ behavior: 'smooth' });

      function moduleCard(courseId, m) {
        const title = el('input', { value: m.title, 'aria-label': 'Название модуля' });
        return el('div', { class: 'card' },
          el('div', { class: 'add-row' }, title,
            el('button', { class: 'btn sm', text: 'Переименовать', onclick: async () => { try { await api(`/api/admin/academy/modules/${m.id}`, { title: title.value }); say('Модуль переименован.'); } catch (e) { say(e.message, true); } } }),
            twoClick('Удалить', async () => { try { await api(`/api/admin/academy/modules/${m.id}/delete`, {}); openCourse(courseId); } catch (e) { say(e.message, true); } })),
          el('div', { class: 'lesson-rows', style: 'margin-top:12px' }, m.lessons.map(l => lessonRow(courseId, l))),
          el('button', { class: 'btn sm primary', style: 'margin-top:12px', text: '+ Добавить урок', onclick: e => e.target.replaceWith(lessonForm(courseId, m.id, null)) }));
      }
      function lessonRow(courseId, l) {
        const row = el('div', { class: 'lesson-row admin' },
          el('div', {}, el('b', { text: l.title }), el('small', { text: [KIND[l.kind], l.videoUrl ? 'видео' : 'видео ещё нет', l.assignment ? 'задание' : null, l.freePreview ? 'бесплатно' : null, l.published ? null : 'скрыт'].filter(Boolean).join(' · ') })),
          el('div', { class: 'actions' },
            el('button', { class: 'btn sm', 'aria-label': 'Выше', text: '↑', onclick: async () => { await api(`/api/admin/academy/lessons/${l.id}/move`, { dir: -1 }); openCourse(courseId); } }),
            el('button', { class: 'btn sm', 'aria-label': 'Ниже', text: '↓', onclick: async () => { await api(`/api/admin/academy/lessons/${l.id}/move`, { dir: 1 }); openCourse(courseId); } }),
            el('button', { class: 'btn sm', text: 'Изменить', onclick: () => row.replaceWith(lessonForm(courseId, null, l)) })));
        return row;
      }
      function lessonForm(courseId, moduleId, l) {
        l ||= { title: '', kind: 'LESSON', videoUrl: '', durationMin: '', body: '', materials: [], assignment: '', freePreview: false, published: true };
        const lf = el('form', { class: 'card lesson-edit', novalidate: true },
          el('div', { class: 'grid g2' }, field('Название урока', el('input', { name: 'title', value: l.title })),
            field('Тип', el('select', { name: 'kind' }, Object.entries(KIND).map(([k, v]) => el('option', { value: k, selected: l.kind === k, text: v }))))),
          el('div', { class: 'grid g2' }, field('Ссылка на видео', el('input', { name: 'videoUrl', value: l.videoUrl || '', placeholder: 'https://youtu.be/… · vimeo.com/… · Bunny Stream' }), 'YouTube (по ссылке), Vimeo или Bunny Stream.'),
            field('Длительность (мин)', el('input', { name: 'durationMin', inputmode: 'numeric', value: l.durationMin ?? '' }))),
          field('Текст урока', el('textarea', { name: 'body', rows: 6, text: l.body || '' }), '«## » — заголовки, «- » — пункты списка.'),
          field('Материалы', el('textarea', { name: 'materials', rows: 2, text: l.materials.map(m => `${m.title} | ${m.url}`).join('\n') }), 'По одному в строке: Название | https://ссылка'),
          field('Задание (необязательно)', el('textarea', { name: 'assignment', rows: 3, text: l.assignment || '' }), 'Студенты отправляют ответ; вы принимаете его или просите доработать.'),
          el('div', { class: 'checks' }, el('label', {}, el('input', { type: 'checkbox', name: 'freePreview', checked: l.freePreview }), ' Бесплатный урок (открыт всем)'),
            el('label', {}, el('input', { type: 'checkbox', name: 'published', checked: l.published }), ' Виден студентам')),
          el('div', { class: 'order-actions' }, el('button', { class: 'btn primary', type: 'submit', text: l.id ? 'Сохранить урок' : 'Добавить урок' }),
            el('button', { type: 'button', class: 'btn', text: 'Отмена', onclick: () => openCourse(courseId) }),
            l.id ? twoClick('Удалить урок', async () => { await api(`/api/admin/academy/lessons/${l.id}/delete`, {}); say('Урок удалён.'); openCourse(courseId); refresh(); }) : null));
        onSubmit(lf, async () => {
          const fd = new FormData(lf);
          try {
            const body = { title: fd.get('title'), kind: fd.get('kind'), videoUrl: fd.get('videoUrl').trim() || null, durationMin: fd.get('durationMin') ? Number(fd.get('durationMin')) : null,
              body: fd.get('body'), assignment: fd.get('assignment'), freePreview: fd.get('freePreview') === 'on', published: fd.get('published') === 'on',
              materials: linesOf(fd.get('materials')).map(line => { const [t, ...u] = line.split('|'); if (!u.length) throw new Error(`Материал «${line}» должен быть в формате «Название | https://ссылка»`); return { title: t.trim(), url: u.join('|').trim() }; }) };
            if (l.id) await api(`/api/admin/academy/lessons/${l.id}`, body); else await api(`/api/admin/academy/modules/${moduleId}/lessons`, body);
            say(l.id ? 'Урок сохранён.' : 'Урок добавлен.'); openCourse(courseId); refresh();
          } catch (e) { say(e.message, true); }
        });
        return lf;
      }
    }

    async function renderPlans() {
      const { plans } = await api('/api/admin/academy/plans');
      const planForm = p => {
        const price = i => dollars(p?.prices.find(x => x.interval === i)?.amount);
        const pf = el('form', { class: 'card', novalidate: true },
          el('div', { class: 'grid g2' }, field('Название тарифа', el('input', { name: 'name', value: p?.name || '' })), field('Краткое описание', el('input', { name: 'description', value: p?.description || '' }))),
          el('div', { class: 'grid g3 prices' }, [['MONTH', 'В месяц $'], ['YEAR', 'В год $'], ['ONE_TIME', 'Разово $']].map(([i, t]) => field(t, el('input', { name: i, inputmode: 'decimal', value: price(i) })))),
          field('Что входит (по одному в строке)', el('textarea', { name: 'features', rows: 3, text: (p?.features || []).join('\n') })),
          el('div', { class: 'checks' }, el('label', {}, el('input', { type: 'checkbox', name: 'mentorship', checked: !!p?.mentorship }), ' Включает личное менторство'),
            p ? el('label', {}, el('input', { type: 'checkbox', name: 'active', checked: p.active }), ' В продаже') : null),
          el('button', { class: `btn ${p ? '' : 'primary'} sm`, type: 'submit', style: 'margin-top:12px', text: p ? 'Сохранить тариф' : '+ Добавить тариф' }));
        onSubmit(pf, async () => {
          const fd = new FormData(pf);
          try {
            const prices = {}; for (const i of ['MONTH', 'YEAR', 'ONE_TIME']) { const c = cents(fd.get(i)); if (c !== null || p?.prices.some(x => x.interval === i)) prices[i] = c; }
            const body = { name: fd.get('name'), description: fd.get('description'), features: linesOf(fd.get('features')), mentorship: fd.get('mentorship') === 'on', prices };
            if (p) await api(`/api/admin/academy/plans/${p.id}`, { ...body, active: fd.get('active') === 'on' }); else await api('/api/admin/academy/plans', body);
            say('Тариф сохранён. Новые цены действуют только для новых заказов.'); renderPlans();
          } catch (e) { say(e.message, true); }
        });
        return pf;
      };
      plansBox.replaceChildren(el('h3', { class: 'sec-title', text: 'Тарифы и цены' }), ...plans.map(planForm), planForm(null));
    }

    await Promise.all([refresh(), renderPlans()]);
    return el('div', { class: 'stack' },
      el('div', { class: 'card' }, el('div', { class: 'row-head' }, el('h3', { text: 'Курсы' }), el('button', { class: 'btn primary', text: '+ Новый курс', onclick: () => openCourse(null) })),
        el('p', { text: 'Вставьте ссылки на видео (YouTube по ссылке, Vimeo или Bunny Stream) в каждый урок. Уроки без видео показывают «Видео скоро появится».' }),
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Месяц', 'Курс', 'Уроки', 'Студенты', 'Статус', ''].map(h => el('th', { text: h })))), list))),
      editor, plansBox);
  },

  // ---------------- Students & assignments ----------------
  async students({ say, show }) {
    const [{ students, totalLessons }, subs] = await Promise.all([api('/api/admin/academy/students'), api('/api/admin/academy/submissions?status=SUBMITTED')]);
    const grant = el('form', { class: 'card add-row wrap-row', novalidate: true },
      el('input', { name: 'email', type: 'email', placeholder: 'student@email.com', 'aria-label': 'Email студента' }),
      el('input', { name: 'days', inputmode: 'numeric', placeholder: 'Дней', style: 'max-width:100px', 'aria-label': 'Дней доступа' }),
      el('label', { class: 'switch' }, el('input', { type: 'checkbox', name: 'mentorship' }), ' с менторством'),
      el('button', { class: 'btn', type: 'submit', text: 'Выдать бесплатный доступ' }));
    onSubmit(grant, async d => { try { await api('/api/admin/academy/access', { email: d.email, days: Number(d.days), mentorship: d.mentorship === 'on' }); say(`Доступ выдан: ${d.email}.`); show('students'); } catch (e) { say(e.message, true); } });
    const review = s => {
      const fb = el('textarea', { rows: 2, placeholder: 'Отзыв для студента (обязателен для «Нужна доработка»)', 'aria-label': 'Отзыв' });
      const act = (status, text, cls) => el('button', { class: `btn sm ${cls}`, text, onclick: async () => {
        try { const r = await api(`/api/admin/academy/submissions/${s.id}`, { status, feedback: fb.value }); say(`${s.student}: ${status === 'APPROVED' ? 'принято' : 'возвращено с отзывом'}.${r.certificate ? ' Сертификат выдан!' : ''}`); show('students'); }
        catch (e) { say(e.message, true); } } });
      return el('div', { class: 'card submission' },
        el('div', { class: 'row-head' }, el('div', {}, el('b', { text: s.student }), el('small', { class: 'muted', text: ` ${s.course} → ${s.lesson}` })), el('small', { class: 'muted', text: fmtDate(s.updatedAt) })),
        el('p', { class: 'task', text: s.assignment }), el('p', { class: 'post-body', text: s.body }),
        s.link ? el('a', { href: s.link, target: '_blank', rel: 'noopener noreferrer', text: s.link }) : null,
        el('div', { class: 'field', style: 'margin-top:12px' }, fb),
        el('div', { class: 'order-actions', style: 'margin-top:4px' }, act('APPROVED', 'Принять', 'primary'), act('NEEDS_WORK', 'Нужна доработка', '')));
    };
    return el('div', { class: 'stack' },
      el('h3', { class: 'sec-title', text: `Задания на проверку (${subs.submissions.length})` }),
      ...(subs.submissions.length ? subs.submissions.map(review) : [el('p', { class: 'muted', text: 'Ничего не ждёт. 🎉' })]),
      el('div', { class: 'card' }, el('h3', { text: `Студенты (${students.length})` }), el('p', { text: `Прогресс считается из ${totalLessons} уроков всех опубликованных курсов.` }),
        grant,
        el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['Студент', 'Тариф', 'Доступ', 'Прогресс', 'Сертификаты', 'Последняя активность'].map(h => el('th', { text: h })))),
          el('tbody', {}, students.length ? students.map(s => el('tr', {},
            el('td', {}, el('div', { text: s.name }), el('small', { class: 'muted', text: s.email })),
            el('td', { text: `${s.plan || '—'}${s.mentorship ? ' + ментор' : ''}` }),
            el('td', {}, el('span', { class: `badge ${s.active ? 'on' : 'off'}`, text: s.active ? `до ${fmtDate(s.endsAt)}` : 'Истёк' })),
            el('td', {}, el('div', { text: `${s.percent}%` }), bar(s.percent)),
            el('td', { text: String(s.certificates) }), el('td', { text: s.lastActive ? fmtDate(s.lastActive) : '—' })))
            : el('tr', {}, el('td', { colspan: 6, class: 'muted', text: 'Студентов пока нет.' })))))));
  },

  // ---------------- Live sessions ----------------
  async live({ say, show }) {
    const { sessions } = await api('/api/admin/academy/live');
    const form = s => {
      const f = el('form', { class: 'card', novalidate: true }, el('h3', { text: s ? `Изменить: ${s.title}` : 'Запланировать сессию' }),
        el('div', { class: 'grid g2' }, field('Название', el('input', { name: 'title', value: s?.title || '' })),
          field('Тип', el('select', { name: 'kind' }, [['WORKSHOP', 'Воркшоп'], ['QA', 'Q&A']].map(([v, t]) => el('option', { value: v, selected: s?.kind === v, text: t }))))),
        el('div', { class: 'grid g2' }, field('Начало (ваше местное время)', el('input', { name: 'startsAt', type: 'datetime-local', value: localInput(s?.startsAt) })),
          field('Длительность (мин)', el('input', { name: 'durationMin', inputmode: 'numeric', value: s?.durationMin ?? 60 }))),
        el('div', { class: 'grid g2' }, field('Ссылка на подключение', el('input', { name: 'joinUrl', value: s?.joinUrl || '', placeholder: 'https://meet… / zoom…' }), 'Видна только участникам.'),
          field('Ссылка на запись (после сессии)', el('input', { name: 'recordingUrl', value: s?.recordingUrl || '' }))),
        field('Описание', el('textarea', { name: 'description', rows: 2, text: s?.description || '' })),
        el('div', { class: 'order-actions' }, el('button', { class: 'btn primary', type: 'submit', text: s ? 'Сохранить' : 'Запланировать' }),
          s ? twoClick('Удалить', async () => { await api(`/api/admin/academy/live/${s.id}/delete`, {}); say('Сессия удалена.'); show('live'); }) : null));
      onSubmit(f, async d => {
        try {
          const body = { ...d, startsAt: d.startsAt ? new Date(d.startsAt).toISOString() : '', durationMin: Number(d.durationMin) || 60, joinUrl: d.joinUrl.trim() || null, recordingUrl: d.recordingUrl.trim() || null };
          if (s) await api(`/api/admin/academy/live/${s.id}`, body); else await api('/api/admin/academy/live', body);
          say('Сессия сохранена.'); show('live');
        } catch (e) { say(e.message, true); }
      });
      return f;
    };
    const holder = el('div', { class: 'stack' }, form(null));
    return el('div', { class: 'stack' }, holder,
      el('div', { class: 'card' }, el('h3', { text: 'Все сессии' }),
        sessions.length ? el('div', { class: 'minis' }, sessions.map(s => el('div', { class: 'mini' },
          el('div', {}, el('b', { text: s.title }), el('small', { text: `${s.kind === 'QA' ? 'Q&A' : 'Воркшоп'} · ${fmtWhen(s.startsAt)} · ${s.durationMin} мин${s.recordingUrl ? ' · запись добавлена' : ''}` })),
          el('button', { class: 'btn sm', text: 'Изменить', onclick: () => { holder.replaceChildren(form(s)); holder.scrollIntoView({ behavior: 'smooth' }); } }))))
          : el('p', { text: 'Сессий пока нет.' })));
  },

  // ---------------- Mentorship ----------------
  async mentorship({ say, show }) {
    const { requests } = await api('/api/admin/academy/mentorship');
    const label = { OPEN: ['Новая', 'st-pending'], SCHEDULED: ['Назначена', 'st-paid'], DONE: ['Проведена', 'off'], CANCELED: ['Отменена', 'off'] };
    return el('div', { class: 'stack' }, el('h3', { class: 'sec-title', text: 'Запросы на менторство' }),
      ...(requests.length ? requests.map(r => {
        const f = el('form', { class: 'grid g3 prices', novalidate: true },
          field('Дата и время', el('input', { name: 'scheduledAt', type: 'datetime-local', value: localInput(r.scheduledAt) })),
          field('Ссылка на встречу', el('input', { name: 'meetingUrl', value: r.meetingUrl || '', placeholder: 'https://…' })),
          field('Заметка для студента', el('input', { name: 'note', value: r.note || '' })));
        const set = (status, text, cls = '') => el('button', { class: `btn sm ${cls}`, type: 'button', text, onclick: async () => {
          const fd = new FormData(f);
          try { await api(`/api/admin/academy/mentorship/${r.id}`, { status, scheduledAt: fd.get('scheduledAt') ? new Date(fd.get('scheduledAt')).toISOString() : null, meetingUrl: fd.get('meetingUrl'), note: fd.get('note') });
            say(status === 'SCHEDULED' ? `Назначено. ${r.student} получит письмо со ссылкой.` : 'Обновлено.'); show('mentorship'); }
          catch (e) { say(e.message, true); } } });
        return el('div', { class: 'card' },
          el('div', { class: 'row-head' }, el('div', {}, el('h3', { text: r.topic }), el('small', { class: 'muted', text: `${r.student} · ${r.email} · ${fmtDate(r.createdAt)}` })), el('span', { class: `badge ${label[r.status][1]}`, text: label[r.status][0] })),
          el('p', { class: 'post-body', text: r.message }),
          ['OPEN', 'SCHEDULED'].includes(r.status) ? [f, el('div', { class: 'order-actions', style: 'margin-top:4px' }, set('SCHEDULED', r.status === 'SCHEDULED' ? 'Перенести' : 'Запланировать', 'primary'), set('DONE', 'Отметить проведённой'), set('CANCELED', 'Отмена', 'danger'))] : null);
      }) : [el('p', { class: 'muted', text: 'Запросов пока нет.' })]));
  },
};
