// VIP Academy: memberships, courses, lessons, progress, assignments, certificates,
// live sessions, community and mentorship. Student routes + admin routes.
import crypto from 'node:crypto';

const DAY = 24 * 3600e3;
const ACCESS_DAYS = { MONTH: 31, YEAR: 366, ONE_TIME: 365 };
const INTERVALS = ['MONTH', 'YEAR', 'ONE_TIME'];
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();

// Called by the marketplace when an admin changes an Academy order's status (inside its transaction).
export function applyAcademyOrder(db, order, to) {
  if (to === 'PAID') {
    const plan = db.prepare('SELECT * FROM academy_plans WHERE id = ?').get(order.academy_plan_id);
    // Renewals stack: a new period starts when the current one ends.
    const current = db.prepare('SELECT MAX(ends_at) AS e FROM academy_memberships WHERE user_id = ?').get(order.user_id).e;
    const start = current && current > iso() ? current : iso();
    const end = new Date(Date.parse(start) + (ACCESS_DAYS[order.interval] || 31) * DAY).toISOString();
    db.prepare('INSERT INTO academy_memberships (id, user_id, plan_id, order_id, mentorship, starts_at, ends_at) VALUES (?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), order.user_id, order.academy_plan_id, order.id, plan?.mentorship ? 1 : 0, start, end);
  } else if (['REFUNDED', 'CANCELED', 'FAILED'].includes(to)) {
    db.prepare('DELETE FROM academy_memberships WHERE order_id = ?').run(order.id);
  }
}

// YouTube / Vimeo / Bunny Stream links → privacy-friendly embed URLs. Anything else is refused.
export function embedUrl(raw) {
  if (!raw) return null;
  let u; try { u = new URL(String(raw).trim()); } catch { return undefined; }
  if (u.protocol !== 'https:') return undefined;
  const h = u.hostname.replace(/^www\.|^m\./, '');
  let m;
  if (h === 'youtu.be' && (m = u.pathname.match(/^\/([\w-]{11})$/))) return `https://www.youtube-nocookie.com/embed/${m[1]}`;
  if ((h === 'youtube.com' || h === 'youtube-nocookie.com')) {
    const v = u.searchParams.get('v') || u.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/)?.[1];
    if (v && /^[\w-]{11}$/.test(v)) return `https://www.youtube-nocookie.com/embed/${v}`;
  }
  if (h === 'vimeo.com' && (m = u.pathname.match(/^\/(\d+)(?:\/([\da-f]+))?/))) return `https://player.vimeo.com/video/${m[1]}${m[2] ? `?h=${m[2]}` : ''}`;
  if (h === 'player.vimeo.com' && (m = u.pathname.match(/^\/video\/(\d+)/))) return `https://player.vimeo.com/video/${m[1]}${u.searchParams.get('h') ? `?h=${u.searchParams.get('h')}` : ''}`;
  if (h === 'iframe.mediadelivery.net' && (m = u.pathname.match(/^\/(?:embed|play)\/(\d+)\/([\w-]+)/))) return `https://iframe.mediadelivery.net/embed/${m[1]}/${m[2]}`;
  return undefined;
}
const httpsUrl = v => { try { const u = new URL(String(v)); return u.protocol === 'https:' ? u.toString() : null; } catch { return null; } };

export function academy({ db, HttpError, requireUser, requireAdmin, audit, throttle, str, sendMail, publicBase }) {
  const q = sql => db.prepare(sql);
  const J = s => JSON.parse(s || '[]');
  const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const shortName = n => { const [f, l] = String(n).trim().split(/\s+/); return l ? `${f} ${l[0]}.` : f; };

  // ---------- access ----------
  function access(c) {
    const u = c.user;
    if (!u) return { user: null, member: false, mentorship: false, admin: false };
    const rows = q('SELECT m.*, p.name AS plan_name FROM academy_memberships m JOIN academy_plans p ON p.id = m.plan_id WHERE m.user_id = ? AND m.starts_at <= ? AND m.ends_at > ? ORDER BY m.ends_at DESC').all(u.id, iso(), iso());
    const admin = u.role === 'ADMIN';
    const endsAt = q('SELECT MAX(ends_at) AS e FROM academy_memberships WHERE user_id = ?').get(u.id).e;
    return { user: u, admin, member: rows.length > 0 || admin, paidMember: rows.length > 0, mentorship: rows.some(r => r.mentorship) || admin,
      plan: rows[0]?.plan_name || null, endsAt: rows.length ? endsAt : null };
  }
  const requireMember = c => { const a = access(c); if (!a.user) throw new HttpError(401, 'Пожалуйста, войдите'); if (!a.member) throw new HttpError(403, 'Это часть VIP Академии. Вступите, чтобы открыть.'); return a; };

  // ---------- read models ----------
  const lessonsOf = (courseId, all = false) => q(`SELECT l.*, m.title AS module_title, m.position AS module_pos FROM lessons l JOIN course_modules m ON m.id = l.module_id
    WHERE l.course_id = ? ${all ? '' : 'AND l.published = 1'} ORDER BY m.position, l.position`).all(courseId);
  function progressOf(userId, courseId) {
    const total = q('SELECT COUNT(*) AS n FROM lessons WHERE course_id = ? AND published = 1').get(courseId).n;
    const done = userId ? q('SELECT COUNT(*) AS n FROM lesson_progress p JOIN lessons l ON l.id = p.lesson_id WHERE p.user_id = ? AND l.course_id = ? AND l.published = 1').get(userId, courseId).n : 0;
    return { done, total, percent: total ? Math.round(done / total * 100) : 0 };
  }
  const courseCard = (c, userId) => {
    const ls = lessonsOf(c.id);
    return { id: c.id, slug: c.slug, title: c.title, summary: c.summary, month: c.month, level: c.level, icon: c.icon, published: !!c.published,
      lessons: ls.length, minutes: ls.reduce((s, l) => s + (l.duration_min || 0), 0), previews: ls.filter(l => l.free_preview).length,
      assignments: ls.filter(l => l.assignment).length, ...(userId ? { progress: progressOf(userId, c.id) } : {}) };
  };
  const plansOut = (all = false) => q(`SELECT * FROM academy_plans ${all ? '' : 'WHERE active = 1'} ORDER BY sort_order, name`).all().map(p => ({
    id: p.id, name: p.name, description: p.description, features: J(p.features), mentorship: !!p.mentorship, active: !!p.active,
    prices: q("SELECT id, interval, amount, currency FROM academy_prices WHERE plan_id = ? AND active = 1 ORDER BY CASE interval WHEN 'MONTH' THEN 0 WHEN 'YEAR' THEN 1 ELSE 2 END").all(p.id) }));

  // ---------- certificates ----------
  function maybeIssueCertificate(userId, courseId) {
    if (q('SELECT 1 FROM certificates WHERE user_id = ? AND course_id = ?').get(userId, courseId)) return null;
    const ls = lessonsOf(courseId);
    if (!ls.length) return null;
    const done = new Set(q('SELECT lesson_id FROM lesson_progress WHERE user_id = ?').all(userId).map(r => r.lesson_id));
    if (!ls.every(l => done.has(l.id))) return null;
    const approved = new Set(q("SELECT lesson_id FROM submissions WHERE user_id = ? AND status = 'APPROVED'").all(userId).map(r => r.lesson_id));
    if (!ls.filter(l => l.assignment).every(l => approved.has(l.id))) return null;
    const user = q('SELECT name, email FROM users WHERE id = ?').get(userId), course = q('SELECT title FROM courses WHERE id = ?').get(courseId);
    const code = crypto.randomBytes(5).toString('hex').toUpperCase();
    q('INSERT INTO certificates (id, code, user_id, course_id, name_on_certificate) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), code, userId, courseId, user.name);
    sendMail(user.email, `Сертификат: ${course.title}`, `Поздравляем, ${user.name}!\n\nВы прошли курс «${course.title}». Ваш сертификат: ${publicBase}/certificate.html?code=${code}`);
    audit(userId, 'academy.certificate_issued', courseId, { code });
    return code;
  }

  // ---------- validation ----------
  const optInt = (v, field, min, max) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field}: целое число от ${min} до ${max}`); return n; };
  function courseInput(b, partial) {
    const o = {}, has = k => b[k] !== undefined, need = k => { if (!partial && !has(k)) throw new HttpError(400, `Поле «${k}» обязательно`); return has(k); };
    if (need('slug')) { if (typeof b.slug !== 'string' || !SLUG_RE.test(b.slug)) throw new HttpError(400, 'Слаг: строчные латинские буквы, цифры и дефисы'); o.slug = b.slug; }
    if (need('title')) o.title = str(b.title, 'Название', 3, 120);
    if (need('summary')) o.summary = str(b.summary, 'Краткое описание', 5, 300);
    if (has('description')) o.description = typeof b.description === 'string' ? b.description.slice(0, 5000) : '';
    if (has('month')) o.month = optInt(b.month, 'Месяц', 1, 12);
    if (has('level')) { if (!['Beginner', 'Intermediate', 'Advanced'].includes(b.level)) throw new HttpError(400, 'Неверный уровень курса'); o.level = b.level; }
    if (has('icon')) o.icon = ['book', 'bolt', 'chat', 'chart', 'shield', 'cart'].includes(b.icon) ? b.icon : 'book';
    if (has('published')) o.published = b.published ? 1 : 0;
    return o;
  }
  function lessonInput(b, partial) {
    const o = {}, has = k => b[k] !== undefined;
    if (!partial || has('title')) o.title = str(b.title, 'Название урока', 2, 160);
    if (has('kind')) { if (!['LESSON', 'TUTORIAL', 'WORKSHOP'].includes(b.kind)) throw new HttpError(400, 'Тип должен быть LESSON, TUTORIAL или WORKSHOP'); o.kind = b.kind; }
    if (has('videoUrl')) { const e = embedUrl(b.videoUrl); if (e === undefined) throw new HttpError(400, 'Используйте ссылку YouTube, Vimeo или Bunny Stream (https)'); o.video_url = e; }
    if (has('body')) { if (typeof b.body !== 'string' || b.body.length > 20000) throw new HttpError(400, 'Текст урока слишком длинный (максимум 20 000 символов)'); o.body = b.body; }
    if (has('durationMin')) o.duration_min = optInt(b.durationMin, 'Длительность', 1, 600);
    if (has('assignment')) o.assignment = typeof b.assignment === 'string' && b.assignment.trim() ? b.assignment.trim().slice(0, 3000) : null;
    if (has('freePreview')) o.free_preview = b.freePreview ? 1 : 0;
    if (has('published')) o.published = b.published ? 1 : 0;
    if (has('materials')) {
      if (!Array.isArray(b.materials) || b.materials.length > 20) throw new HttpError(400, 'Материалы: не более 20 ссылок');
      o.materials = JSON.stringify(b.materials.map((m, i) => {
        const url = httpsUrl(m?.url); if (!url) throw new HttpError(400, `Материал №${i + 1}: ссылка должна начинаться с https://`);
        return { title: str(m?.title, `Material #${i + 1} title`, 1, 120), url };
      }));
    }
    return o;
  }
  const update = (table, id, o) => { const cols = Object.keys(o); if (cols.length) q(`UPDATE ${table} SET ${cols.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...cols.map(k => o[k]), id); };

  const routes = {
    // ---------- public ----------
    'GET /api/academy': async c => {
      const a = access(c);
      return {
        plans: plansOut(),
        courses: q('SELECT * FROM courses WHERE published = 1 ORDER BY sort_order, month, title').all().map(x => courseCard(x, a.user?.id)),
        viewer: { loggedIn: !!a.user, member: a.member, mentorship: a.mentorship },
      };
    },

    // ---------- student ----------
    'GET /api/academy/me': async c => {
      const a = access(c);
      if (!a.user) throw new HttpError(401, 'Пожалуйста, войдите');
      const courses = q('SELECT * FROM courses WHERE published = 1 ORDER BY sort_order, month, title').all();
      const done = new Set(q('SELECT lesson_id FROM lesson_progress WHERE user_id = ?').all(a.user.id).map(r => r.lesson_id));
      let next = null;
      for (const co of courses) { const l = lessonsOf(co.id).find(x => !done.has(x.id) && (a.member || x.free_preview)); if (l) { next = { id: l.id, title: l.title, course: co.title }; break; } }
      const live = q('SELECT * FROM live_sessions WHERE starts_at > ? ORDER BY starts_at LIMIT 5').all(iso(-3 * 3600e3)).map(s => liveOut(s, a.member));
      return {
        membership: { active: a.paidMember, admin: a.admin, plan: a.plan, endsAt: a.endsAt, mentorship: a.mentorship },
        courses: courses.map(x => courseCard(x, a.user.id)), next, live,
        certificates: q('SELECT ce.code, ce.issued_at AS issuedAt, co.title FROM certificates ce JOIN courses co ON co.id = ce.course_id WHERE ce.user_id = ? ORDER BY ce.issued_at').all(a.user.id),
        feedback: q("SELECT s.status, s.feedback, l.id AS lessonId, l.title FROM submissions s JOIN lessons l ON l.id = s.lesson_id WHERE s.user_id = ? AND s.status = 'NEEDS_WORK'").all(a.user.id),
      };
    },
    'POST /api/academy/orders': async c => {
      const u = requireUser(c);
      throttle(`order:${u.id}`, 20, 3600e3);
      const p = typeof c.body.priceId === 'string' && q('SELECT pr.*, p.name AS plan_name, p.active AS plan_active FROM academy_prices pr JOIN academy_plans p ON p.id = pr.plan_id WHERE pr.id = ?').get(c.body.priceId);
      if (!p || !p.active || !p.plan_active) throw new HttpError(400, 'Этот тариф больше недоступен. Обновите страницу.');
      const existing = q("SELECT id FROM orders WHERE user_id = ? AND price_id = ? AND status = 'PENDING'").get(u.id, p.id);
      if (existing) return { order: { id: existing.id } };
      const org = q("SELECT org_id FROM memberships WHERE user_id = ? AND role = 'OWNER' LIMIT 1").get(u.id);
      const id = crypto.randomUUID();
      q(`INSERT INTO orders (id, user_id, org_id, product_type, academy_plan_id, price_id, plan_name, interval, amount, currency) VALUES (?,?,?,'ACADEMY',?,?,?,?,?,?)`)
        .run(id, u.id, org.org_id, p.plan_id, p.id, p.plan_name, p.interval, p.amount, p.currency);
      audit(u.id, 'order.created', id, { product: 'ACADEMY', amount: p.amount });
      c.status = 201;
      return { order: { id } };
    },
    'GET /api/academy/live': async c => {
      const a = access(c);
      return { sessions: q('SELECT * FROM live_sessions ORDER BY starts_at DESC LIMIT 50').all().map(s => liveOut(s, a.member)), member: a.member };
    },
    'GET /api/academy/mentorship': async c => {
      const a = access(c); if (!a.user) throw new HttpError(401, 'Пожалуйста, войдите');
      return { available: a.mentorship, requests: q('SELECT id, topic, message, status, scheduled_at AS scheduledAt, meeting_url AS meetingUrl, mentor_note AS note, created_at AS createdAt FROM mentorship_requests WHERE user_id = ? ORDER BY created_at DESC').all(a.user.id) };
    },
    'POST /api/academy/mentorship': async c => {
      const a = requireMember(c);
      if (!a.mentorship) throw new HttpError(403, 'Личное менторство входит в тариф VIP + Менторство');
      throttle(`mentor:${a.user.id}`, 5, DAY);
      if (q("SELECT COUNT(*) AS n FROM mentorship_requests WHERE user_id = ? AND status = 'OPEN'").get(a.user.id).n >= 3) throw new HttpError(400, 'У вас уже 3 открытых обращения. Дождитесь ответа.');
      const id = crypto.randomUUID();
      q('INSERT INTO mentorship_requests (id, user_id, topic, message) VALUES (?,?,?,?)').run(id, a.user.id, str(c.body.topic, 'Тема', 3, 120), str(c.body.message, 'Сообщение', 10, 3000));
      for (const ad of q("SELECT email FROM users WHERE role = 'ADMIN'").all()) sendMail(ad.email, `Запрос на менторство от ${a.user.name}`, `${a.user.name} просит сессию: «${c.body.topic}».\n\nОткрыть: ${publicBase}/admin.html#mentorship`);
      c.status = 201;
      return { id };
    },

    // ---------- community (members only) ----------
    'GET /api/community': async c => {
      requireMember(c);
      const posts = q(`SELECT p.*, u.name AS author, u.role AS author_role, (SELECT COUNT(*) FROM community_comments WHERE post_id = p.id) AS comments
                       FROM community_posts p JOIN users u ON u.id = p.user_id ORDER BY p.pinned DESC, p.created_at DESC LIMIT 100`).all();
      return { posts: posts.map(p => ({ id: p.id, title: p.title, body: p.body.length > 400 ? `${p.body.slice(0, 400)}…` : p.body, pinned: !!p.pinned,
        author: shortName(p.author), team: p.author_role === 'ADMIN', comments: p.comments, createdAt: p.created_at, mine: p.user_id === c.user.id })) };
    },
    'POST /api/community': async c => {
      const a = requireMember(c);
      throttle(`post:${a.user.id}`, 10, DAY);
      const id = crypto.randomUUID();
      q('INSERT INTO community_posts (id, user_id, title, body) VALUES (?,?,?,?)').run(id, a.user.id, str(c.body.title, 'Название', 3, 140), str(c.body.body, 'Пост', 3, 5000));
      c.status = 201;
      return { id };
    },
    // ---------- admin ----------
    'GET /api/admin/academy/courses': async c => {
      requireAdmin(c);
      return { courses: q('SELECT * FROM courses ORDER BY sort_order, month, title').all().map(x => ({ ...courseCard(x), students: q('SELECT COUNT(DISTINCT p.user_id) AS n FROM lesson_progress p JOIN lessons l ON l.id = p.lesson_id WHERE l.course_id = ?').get(x.id).n })) };
    },
    'POST /api/admin/academy/courses': async c => {
      const admin = requireAdmin(c);
      const o = courseInput(c.body, false);
      if (q('SELECT 1 FROM courses WHERE slug = ?').get(o.slug)) throw new HttpError(409, 'Курс с таким слагом уже существует');
      o.sort_order = q('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM courses').get().n;
      const id = crypto.randomUUID(), cols = Object.keys(o);
      q(`INSERT INTO courses (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(id, ...cols.map(k => o[k]));
      audit(admin.id, 'academy.course_created', id);
      c.status = 201;
      return { id };
    },
    'GET /api/admin/academy/plans': async c => { requireAdmin(c); return { plans: plansOut(true) }; },
    'POST /api/admin/academy/plans': async c => {
      const admin = requireAdmin(c);
      const id = crypto.randomUUID();
      tx(() => {
        q('INSERT INTO academy_plans (id, name, description, features, mentorship, sort_order) VALUES (?,?,?,?,?,(SELECT COALESCE(MAX(sort_order), 0) + 1 FROM academy_plans))')
          .run(id, str(c.body.name, 'Название тарифа', 2, 60), String(c.body.description || '').slice(0, 300), JSON.stringify(features(c.body.features)), c.body.mentorship ? 1 : 0);
        savePrices(id, c.body.prices || {});
      });
      audit(admin.id, 'academy.plan_created', id);
      c.status = 201;
      return { plans: plansOut(true) };
    },
    'GET /api/admin/academy/students': async c => {
      requireAdmin(c);
      const total = q('SELECT COUNT(*) AS n FROM lessons l JOIN courses co ON co.id = l.course_id WHERE l.published = 1 AND co.published = 1').get().n;
      const rows = q(`SELECT u.id, u.name, u.email, MAX(m.ends_at) AS ends_at, MAX(m.mentorship) AS mentorship, MIN(m.starts_at) AS since,
                      (SELECT p.name FROM academy_memberships mm JOIN academy_plans p ON p.id = mm.plan_id WHERE mm.user_id = u.id ORDER BY mm.ends_at DESC LIMIT 1) AS plan,
                      (SELECT COUNT(*) FROM lesson_progress WHERE user_id = u.id) AS done,
                      (SELECT MAX(completed_at) FROM lesson_progress WHERE user_id = u.id) AS last_active,
                      (SELECT COUNT(*) FROM certificates WHERE user_id = u.id) AS certs
                      FROM users u JOIN academy_memberships m ON m.user_id = u.id GROUP BY u.id ORDER BY since DESC`).all();
      return { totalLessons: total, students: rows.map(r => ({ id: r.id, name: r.name, email: r.email, plan: r.plan, active: r.ends_at > iso(), endsAt: r.ends_at,
        mentorship: !!r.mentorship, since: r.since, done: r.done, percent: total ? Math.round(r.done / total * 100) : 0, lastActive: r.last_active, certificates: r.certs })) };
    },
    'POST /api/admin/academy/access': async c => {
      const admin = requireAdmin(c);
      const u = typeof c.body.email === 'string' && q('SELECT * FROM users WHERE email = ?').get(c.body.email.trim().toLowerCase());
      if (!u) throw new HttpError(404, 'Аккаунта с таким email нет. Попросите студента сначала зарегистрироваться.');
      const days = optInt(c.body.days, 'Дни', 1, 1000);
      if (!days) throw new HttpError(400, 'Укажите количество дней');
      const plan = q(`SELECT * FROM academy_plans WHERE mentorship = ? ORDER BY active DESC, sort_order LIMIT 1`).get(c.body.mentorship ? 1 : 0) || q('SELECT * FROM academy_plans LIMIT 1').get();
      const current = q('SELECT MAX(ends_at) AS e FROM academy_memberships WHERE user_id = ?').get(u.id).e;
      const start = current && current > iso() ? current : iso();
      q('INSERT INTO academy_memberships (id, user_id, plan_id, mentorship, starts_at, ends_at) VALUES (?,?,?,?,?,?)')
        .run(crypto.randomUUID(), u.id, plan.id, c.body.mentorship ? 1 : 0, start, new Date(Date.parse(start) + days * DAY).toISOString());
      audit(admin.id, 'academy.access_granted', u.id, { days, mentorship: !!c.body.mentorship });
      return { ok: true };
    },
    'GET /api/admin/academy/submissions': async c => {
      requireAdmin(c);
      const status = new URL(c.req.url, 'http://x').searchParams.get('status') || 'SUBMITTED';
      return { submissions: q(`SELECT s.*, u.name, u.email, l.title AS lesson, l.assignment, co.title AS course FROM submissions s JOIN users u ON u.id = s.user_id
                               JOIN lessons l ON l.id = s.lesson_id JOIN courses co ON co.id = l.course_id WHERE s.status = ? ORDER BY s.updated_at LIMIT 200`).all(status)
        .map(s => ({ id: s.id, student: s.name, email: s.email, course: s.course, lesson: s.lesson, assignment: s.assignment, body: s.body, link: s.link, status: s.status, feedback: s.feedback, updatedAt: s.updated_at })) };
    },
    'GET /api/admin/academy/live': async c => { requireAdmin(c); return { sessions: q('SELECT * FROM live_sessions ORDER BY starts_at DESC').all().map(s => liveOut(s, true)) }; },
    'POST /api/admin/academy/live': async c => {
      const admin = requireAdmin(c);
      const id = crypto.randomUUID(), s = liveInput(c.body);
      q('INSERT INTO live_sessions (id, title, description, kind, starts_at, duration_min, join_url, recording_url) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, s.title, s.description, s.kind, s.starts_at, s.duration_min, s.join_url, s.recording_url);
      audit(admin.id, 'academy.live_created', id);
      c.status = 201;
      return { id };
    },
    'GET /api/admin/academy/mentorship': async c => {
      requireAdmin(c);
      return { requests: q(`SELECT r.*, u.name, u.email FROM mentorship_requests r JOIN users u ON u.id = r.user_id ORDER BY (r.status = 'OPEN') DESC, r.created_at DESC LIMIT 200`).all()
        .map(r => ({ id: r.id, student: r.name, email: r.email, topic: r.topic, message: r.message, status: r.status, scheduledAt: r.scheduled_at, meetingUrl: r.meeting_url, note: r.mentor_note, createdAt: r.created_at })) };
    },
  };

  function features(v) { if (v === undefined) return []; if (!Array.isArray(v) || v.length > 15) throw new HttpError(400, 'Что входит: не более 15 строк'); return v.map((x, i) => str(x, `Feature #${i + 1}`, 2, 120)); }
  function savePrices(planId, prices) {
    for (const [interval, amount] of Object.entries(prices)) {
      if (!INTERVALS.includes(interval)) throw new HttpError(400, `Период оплаты должен быть одним из: ${INTERVALS.join(', ')}`);
      if (amount !== null && (!Number.isInteger(amount) || amount < 0 || amount > 100_000_000)) throw new HttpError(400, 'Цена должна быть целым числом центов');
      const cur = q('SELECT * FROM academy_prices WHERE plan_id = ? AND interval = ? AND active = 1').get(planId, interval);
      if (cur && cur.amount === amount) continue;
      if (cur) q('UPDATE academy_prices SET active = 0 WHERE id = ?').run(cur.id);   // kept for past orders
      if (amount !== null) q('INSERT INTO academy_prices (id, plan_id, interval, amount) VALUES (?,?,?,?)').run(crypto.randomUUID(), planId, interval, amount);
    }
  }
  function liveInput(b) {
    const t = Date.parse(b.startsAt);
    if (!Number.isFinite(t)) throw new HttpError(400, 'Укажите время начала');
    const join = b.joinUrl ? httpsUrl(b.joinUrl) : null, rec = b.recordingUrl ? httpsUrl(b.recordingUrl) : null;
    if (b.joinUrl && !join) throw new HttpError(400, 'Ссылка на подключение должна начинаться с https://');
    if (b.recordingUrl && !rec) throw new HttpError(400, 'Ссылка на запись должна начинаться с https://');
    return { title: str(b.title, 'Название', 3, 140), description: String(b.description || '').slice(0, 2000), kind: b.kind === 'QA' ? 'QA' : 'WORKSHOP',
      starts_at: new Date(t).toISOString(), duration_min: optInt(b.durationMin, 'Длительность', 10, 480) || 60, join_url: join, recording_url: rec };
  }
  function liveOut(s, member) {
    return { id: s.id, title: s.title, description: s.description, kind: s.kind, startsAt: s.starts_at, durationMin: s.duration_min,
      joinUrl: member ? s.join_url : null, recordingUrl: member ? s.recording_url : null, hasRecording: !!s.recording_url };
  }

  const ID = '([\\w-]+)';
  const R = (method, path) => new RegExp(`^${method} ${path.replace(/:id/g, ID)}$`);
  const paramRoutes = [
    // ---------- course & lesson pages ----------
    [R('GET', '/api/academy/courses/([a-z0-9-]+)'), async (c, [slug]) => {
      const a = access(c);
      const co = q('SELECT * FROM courses WHERE slug = ?').get(slug);
      if (!co || (!co.published && !a.admin)) throw new HttpError(404, 'Курс не найден');
      const done = a.user ? new Set(q('SELECT lesson_id FROM lesson_progress WHERE user_id = ?').all(a.user.id).map(r => r.lesson_id)) : new Set();
      const subs = a.user ? Object.fromEntries(q('SELECT lesson_id, status FROM submissions WHERE user_id = ?').all(a.user.id).map(r => [r.lesson_id, r.status])) : {};
      const modules = q('SELECT * FROM course_modules WHERE course_id = ? ORDER BY position').all(co.id).map(m => ({ id: m.id, title: m.title,
        lessons: lessonsOf(co.id).filter(l => l.module_id === m.id).map(l => ({ id: l.id, title: l.title, kind: l.kind, durationMin: l.duration_min, preview: !!l.free_preview,
          locked: !(a.member || l.free_preview), completed: done.has(l.id), hasAssignment: !!l.assignment, submission: subs[l.id] || null, hasVideo: !!l.video_url })) }));
      const cert = a.user && q('SELECT code, issued_at FROM certificates WHERE user_id = ? AND course_id = ?').get(a.user.id, co.id);
      return { course: { ...courseCard(co), description: co.description }, modules, progress: progressOf(a.user?.id, co.id),
        certificate: cert ? { code: cert.code, issuedAt: cert.issued_at } : null, viewer: { loggedIn: !!a.user, member: a.member } };
    }],
    [R('GET', '/api/academy/lessons/:id'), async (c, [id]) => {
      const a = access(c);
      const l = q('SELECT l.*, co.slug AS course_slug, co.title AS course_title, co.published AS course_published FROM lessons l JOIN courses co ON co.id = l.course_id WHERE l.id = ?').get(id);
      if (!l || ((!l.published || !l.course_published) && !a.admin)) throw new HttpError(404, 'Урок не найден');
      const seq = lessonsOf(l.course_id), i = seq.findIndex(x => x.id === l.id);
      const nav = { prev: seq[i - 1] ? { id: seq[i - 1].id, title: seq[i - 1].title } : null, next: seq[i + 1] ? { id: seq[i + 1].id, title: seq[i + 1].title } : null };
      const base = { id: l.id, title: l.title, kind: l.kind, durationMin: l.duration_min, course: { slug: l.course_slug, title: l.course_title }, nav, preview: !!l.free_preview };
      if (!(a.member || l.free_preview)) { c.status = 403; return { ...base, locked: true, error: 'Этот урок — часть VIP Академии. Вступите, чтобы открыть.' }; }
      const sub = a.user && q('SELECT body, link, status, feedback, updated_at FROM submissions WHERE lesson_id = ? AND user_id = ?').get(l.id, a.user.id);
      return { ...base, locked: false, videoUrl: l.video_url, body: l.body, materials: J(l.materials), assignment: l.assignment,
        completed: !!(a.user && q('SELECT 1 FROM lesson_progress WHERE user_id = ? AND lesson_id = ?').get(a.user.id, l.id)),
        submission: sub ? { body: sub.body, link: sub.link, status: sub.status, feedback: sub.feedback, updatedAt: sub.updated_at } : null,
        viewer: { loggedIn: !!a.user, member: a.member } };
    }],
    [R('POST', '/api/academy/lessons/:id/complete'), async (c, [id]) => {
      const a = access(c);
      if (!a.user) throw new HttpError(401, 'Пожалуйста, войдите');
      const l = q('SELECT * FROM lessons WHERE id = ? AND published = 1').get(id);
      if (!l) throw new HttpError(404, 'Урок не найден');
      if (!(a.member || l.free_preview)) throw new HttpError(403, 'Вступите в VIP Академию, чтобы отмечать прогресс');
      if (c.body.done === false) q('DELETE FROM lesson_progress WHERE user_id = ? AND lesson_id = ?').run(a.user.id, id);
      else q('INSERT INTO lesson_progress (user_id, lesson_id) VALUES (?,?) ON CONFLICT DO NOTHING').run(a.user.id, id);
      const certificate = c.body.done === false ? null : maybeIssueCertificate(a.user.id, l.course_id);
      return { completed: c.body.done !== false, progress: progressOf(a.user.id, l.course_id), certificate };
    }],
    [R('POST', '/api/academy/lessons/:id/submission'), async (c, [id]) => {
      const a = requireMember(c);
      const l = q('SELECT * FROM lessons WHERE id = ? AND published = 1').get(id);
      if (!l || !l.assignment) throw new HttpError(404, 'В этом уроке нет задания');
      throttle(`submit:${a.user.id}`, 30, DAY);
      const body = str(c.body.body, 'Ваш ответ', 10, 10000);
      const link = c.body.link ? httpsUrl(c.body.link) : null;
      if (c.body.link && !link) throw new HttpError(400, 'Ссылка должна начинаться с https://');
      const prev = q('SELECT status FROM submissions WHERE lesson_id = ? AND user_id = ?').get(id, a.user.id);
      if (prev?.status === 'APPROVED') throw new HttpError(400, 'Это задание уже принято');
      q(`INSERT INTO submissions (id, lesson_id, user_id, body, link) VALUES (?,?,?,?,?)
         ON CONFLICT (lesson_id, user_id) DO UPDATE SET body = excluded.body, link = excluded.link, status = 'SUBMITTED', updated_at = ?`).run(crypto.randomUUID(), id, a.user.id, body, link, iso());
      audit(a.user.id, 'academy.submitted', id);
      return { status: 'SUBMITTED' };
    }],
    [R('GET', '/api/certificates/([A-F0-9]{10})'), async (c, [code]) => {
      const r = q('SELECT ce.*, co.title, co.month, co.level FROM certificates ce JOIN courses co ON co.id = ce.course_id WHERE ce.code = ?').get(code);
      if (!r) throw new HttpError(404, 'Сертификат не найден');
      return { certificate: { code: r.code, name: r.name_on_certificate, course: r.title, month: r.month, level: r.level, issuedAt: r.issued_at,
        lessons: lessonsOf(r.course_id).length } };
    }],
    [R('POST', '/api/academy/mentorship/:id/cancel'), async (c, [id]) => {
      const a = access(c); if (!a.user) throw new HttpError(401, 'Пожалуйста, войдите');
      const r = q('SELECT * FROM mentorship_requests WHERE id = ? AND user_id = ?').get(id, a.user.id);
      if (!r) throw new HttpError(404, 'Запрос не найден');
      if (!['OPEN', 'SCHEDULED'].includes(r.status)) throw new HttpError(400, 'Это обращение уже закрыто');
      q("UPDATE mentorship_requests SET status = 'CANCELED' WHERE id = ?").run(id);
      return { ok: true };
    }],

    // ---------- community ----------
    [R('GET', '/api/community/:id'), async (c, [id]) => {
      requireMember(c);
      const p = q('SELECT p.*, u.name AS author, u.role AS author_role FROM community_posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?').get(id);
      if (!p) throw new HttpError(404, 'Пост не найден');
      const admin = c.user.role === 'ADMIN';
      return { post: { id: p.id, title: p.title, body: p.body, pinned: !!p.pinned, author: shortName(p.author), team: p.author_role === 'ADMIN', createdAt: p.created_at, canDelete: admin || p.user_id === c.user.id },
        comments: q('SELECT cm.*, u.name AS author, u.role AS author_role FROM community_comments cm JOIN users u ON u.id = cm.user_id WHERE cm.post_id = ? ORDER BY cm.created_at').all(id)
          .map(x => ({ id: x.id, body: x.body, author: shortName(x.author), team: x.author_role === 'ADMIN', createdAt: x.created_at, canDelete: admin || x.user_id === c.user.id })), admin };
    }],
    [R('POST', '/api/community/:id/comments'), async (c, [id]) => {
      const a = requireMember(c);
      if (!q('SELECT 1 FROM community_posts WHERE id = ?').get(id)) throw new HttpError(404, 'Пост не найден');
      throttle(`comment:${a.user.id}`, 60, DAY);
      q('INSERT INTO community_comments (id, post_id, user_id, body) VALUES (?,?,?,?)').run(crypto.randomUUID(), id, a.user.id, str(c.body.body, 'Комментарий', 1, 3000));
      c.status = 201;
      return { ok: true };
    }],
    [R('POST', '/api/community/:id/delete'), async (c, [id]) => {
      requireMember(c);
      const p = q('SELECT * FROM community_posts WHERE id = ?').get(id);
      if (!p || (p.user_id !== c.user.id && c.user.role !== 'ADMIN')) throw new HttpError(404, 'Пост не найден');
      q('DELETE FROM community_posts WHERE id = ?').run(id);
      if (p.user_id !== c.user.id) audit(c.user.id, 'community.post_removed', id);
      return { ok: true };
    }],
    [R('POST', '/api/community/comments/:id/delete'), async (c, [id]) => {
      requireMember(c);
      const x = q('SELECT * FROM community_comments WHERE id = ?').get(id);
      if (!x || (x.user_id !== c.user.id && c.user.role !== 'ADMIN')) throw new HttpError(404, 'Комментарий не найден');
      q('DELETE FROM community_comments WHERE id = ?').run(id);
      return { ok: true };
    }],
    [R('POST', '/api/community/:id/pin'), async (c, [id]) => {
      requireAdmin(c);
      q('UPDATE community_posts SET pinned = ? WHERE id = ?').run(c.body.pinned ? 1 : 0, id);
      return { ok: true };
    }],

    // ---------- admin: courses, modules, lessons ----------
    [R('GET', '/api/admin/academy/courses/:id'), async (c, [id]) => {
      requireAdmin(c);
      const co = q('SELECT * FROM courses WHERE id = ?').get(id);
      if (!co) throw new HttpError(404, 'Курс не найден');
      return { course: { ...courseCard(co), description: co.description },
        modules: q('SELECT * FROM course_modules WHERE course_id = ? ORDER BY position').all(id).map(m => ({ id: m.id, title: m.title, position: m.position,
          lessons: lessonsOf(id, true).filter(l => l.module_id === m.id).map(l => ({ id: l.id, title: l.title, kind: l.kind, videoUrl: l.video_url, body: l.body,
            durationMin: l.duration_min, materials: J(l.materials), assignment: l.assignment, freePreview: !!l.free_preview, published: !!l.published })) })) };
    }],
    [R('POST', '/api/admin/academy/courses/:id'), async (c, [id]) => {
      const admin = requireAdmin(c);
      const co = q('SELECT * FROM courses WHERE id = ?').get(id);
      if (!co) throw new HttpError(404, 'Курс не найден');
      const o = courseInput(c.body, true);
      if (o.slug && o.slug !== co.slug && q('SELECT 1 FROM courses WHERE slug = ?').get(o.slug)) throw new HttpError(409, 'Курс с таким слагом уже существует');
      if (o.published === 1 && !lessonsOf(id).length) throw new HttpError(400, 'Перед публикацией добавьте хотя бы один урок');
      update('courses', id, o);
      audit(admin.id, 'academy.course_updated', id, { fields: Object.keys(o) });
      return { ok: true };
    }],
    [R('POST', '/api/admin/academy/courses/:id/delete'), async (c, [id]) => {
      const admin = requireAdmin(c);
      if (q('SELECT 1 FROM certificates WHERE course_id = ?').get(id)) throw new HttpError(409, 'По этому курсу уже выданы сертификаты, его можно только снять с публикации');
      if (!q('DELETE FROM courses WHERE id = ?').run(id).changes) throw new HttpError(404, 'Курс не найден');
      audit(admin.id, 'academy.course_deleted', id);
      return { ok: true };
    }],
    [R('POST', '/api/admin/academy/courses/:id/modules'), async (c, [id]) => {
      requireAdmin(c);
      if (!q('SELECT 1 FROM courses WHERE id = ?').get(id)) throw new HttpError(404, 'Курс не найден');
      const mid = crypto.randomUUID();
      q('INSERT INTO course_modules (id, course_id, title, position) VALUES (?,?,?,(SELECT COALESCE(MAX(position), -1) + 1 FROM course_modules WHERE course_id = ?))').run(mid, id, str(c.body.title, 'Название модуля', 2, 120), id);
      c.status = 201;
      return { id: mid };
    }],
    [R('POST', '/api/admin/academy/modules/:id'), async (c, [id]) => {
      requireAdmin(c);
      if (!q('UPDATE course_modules SET title = ? WHERE id = ?').run(str(c.body.title, 'Название модуля', 2, 120), id).changes) throw new HttpError(404, 'Модуль не найден');
      return { ok: true };
    }],
    [R('POST', '/api/admin/academy/modules/:id/delete'), async (c, [id]) => {
      requireAdmin(c);
      if (q('SELECT 1 FROM lessons WHERE module_id = ?').get(id)) throw new HttpError(409, 'Сначала перенесите или удалите уроки этого модуля');
      q('DELETE FROM course_modules WHERE id = ?').run(id);
      return { ok: true };
    }],
    [R('POST', '/api/admin/academy/modules/:id/lessons'), async (c, [id]) => {
      const admin = requireAdmin(c);
      const m = q('SELECT * FROM course_modules WHERE id = ?').get(id);
      if (!m) throw new HttpError(404, 'Модуль не найден');
      const o = lessonInput(c.body, false), lid = crypto.randomUUID();
      o.position = q('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM lessons WHERE module_id = ?').get(id).n;
      const cols = Object.keys(o);
      q(`INSERT INTO lessons (id, module_id, course_id, ${cols.join(', ')}) VALUES (?,?,?, ${cols.map(() => '?').join(', ')})`).run(lid, id, m.course_id, ...cols.map(k => o[k]));
      audit(admin.id, 'academy.lesson_created', lid);
      c.status = 201;
      return { id: lid };
    }],
    [R('POST', '/api/admin/academy/lessons/:id'), async (c, [id]) => {
      const admin = requireAdmin(c);
      if (!q('SELECT 1 FROM lessons WHERE id = ?').get(id)) throw new HttpError(404, 'Урок не найден');
      const o = lessonInput(c.body, true);
      update('lessons', id, o);
      audit(admin.id, 'academy.lesson_updated', id, { fields: Object.keys(o) });
      return { ok: true };
    }],
    [R('POST', '/api/admin/academy/lessons/:id/move'), async (c, [id]) => {
      requireAdmin(c);
      const l = q('SELECT * FROM lessons WHERE id = ?').get(id);
      if (!l) throw new HttpError(404, 'Урок не найден');
      const sib = q(`SELECT * FROM lessons WHERE module_id = ? AND position ${c.body.dir < 0 ? '<' : '>'} ? ORDER BY position ${c.body.dir < 0 ? 'DESC' : 'ASC'} LIMIT 1`).get(l.module_id, l.position);
      if (sib) tx(() => { q('UPDATE lessons SET position = ? WHERE id = ?').run(sib.position, l.id); q('UPDATE lessons SET position = ? WHERE id = ?').run(l.position, sib.id); });
      return { ok: true };
    }],
    [R('POST', '/api/admin/academy/lessons/:id/delete'), async (c, [id]) => {
      const admin = requireAdmin(c);
      if (!q('DELETE FROM lessons WHERE id = ?').run(id).changes) throw new HttpError(404, 'Урок не найден');
      audit(admin.id, 'academy.lesson_deleted', id);
      return { ok: true };
    }],

    // ---------- admin: plans, submissions, live, mentorship ----------
    [R('POST', '/api/admin/academy/plans/:id'), async (c, [id]) => {
      const admin = requireAdmin(c);
      const p = q('SELECT * FROM academy_plans WHERE id = ?').get(id);
      if (!p) throw new HttpError(404, 'Тариф не найден');
      const b = c.body;
      tx(() => {
        q('UPDATE academy_plans SET name = ?, description = ?, features = ?, mentorship = ?, active = ? WHERE id = ?').run(
          b.name !== undefined ? str(b.name, 'Название тарифа', 2, 60) : p.name, b.description !== undefined ? String(b.description).slice(0, 300) : p.description,
          b.features !== undefined ? JSON.stringify(features(b.features)) : p.features, b.mentorship !== undefined ? (b.mentorship ? 1 : 0) : p.mentorship,
          b.active !== undefined ? (b.active ? 1 : 0) : p.active, id);
        if (b.prices) savePrices(id, b.prices);
      });
      audit(admin.id, 'academy.plan_updated', id);
      return { plans: plansOut(true) };
    }],
    [R('POST', '/api/admin/academy/submissions/:id'), async (c, [id]) => {
      const admin = requireAdmin(c);
      const s = q('SELECT s.*, l.course_id, l.title AS lesson, u.email, u.name FROM submissions s JOIN lessons l ON l.id = s.lesson_id JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(id);
      if (!s) throw new HttpError(404, 'Ответ не найден');
      if (!['APPROVED', 'NEEDS_WORK'].includes(c.body.status)) throw new HttpError(400, 'Статус должен быть APPROVED или NEEDS_WORK');
      const feedback = typeof c.body.feedback === 'string' ? c.body.feedback.trim().slice(0, 5000) : '';
      if (c.body.status === 'NEEDS_WORK' && feedback.length < 5) throw new HttpError(400, 'Напишите коротко, что улучшить');
      q('UPDATE submissions SET status = ?, feedback = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?').run(c.body.status, feedback || null, admin.id, iso(), iso(), id);
      sendMail(s.email, c.body.status === 'APPROVED' ? `Задание принято: ${s.lesson}` : `Отзыв на ваше задание: ${s.lesson}`,
        `Здравствуйте, ${s.name}!\n\n${c.body.status === 'APPROVED' ? 'Ваше задание принято.' : 'Ваше задание нужно немного доработать.'}${feedback ? `\n\nОтзыв:\n${feedback}` : ''}\n\nОткрыть урок: ${publicBase}/lesson.html?id=${s.lesson_id}`);
      audit(admin.id, 'academy.submission_reviewed', id, { status: c.body.status });
      const certificate = c.body.status === 'APPROVED' ? maybeIssueCertificate(s.user_id, s.course_id) : null;
      return { ok: true, certificate };
    }],
    [R('POST', '/api/admin/academy/live/:id'), async (c, [id]) => {
      const admin = requireAdmin(c);
      const s = liveInput(c.body);
      if (!q('UPDATE live_sessions SET title = ?, description = ?, kind = ?, starts_at = ?, duration_min = ?, join_url = ?, recording_url = ? WHERE id = ?')
        .run(s.title, s.description, s.kind, s.starts_at, s.duration_min, s.join_url, s.recording_url, id).changes) throw new HttpError(404, 'Сессия не найдена');
      audit(admin.id, 'academy.live_updated', id);
      return { ok: true };
    }],
    [R('POST', '/api/admin/academy/live/:id/delete'), async (c, [id]) => { requireAdmin(c); q('DELETE FROM live_sessions WHERE id = ?').run(id); return { ok: true }; }],
    [R('POST', '/api/admin/academy/mentorship/:id'), async (c, [id]) => {
      const admin = requireAdmin(c);
      const r = q('SELECT r.*, u.email, u.name FROM mentorship_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?').get(id);
      if (!r) throw new HttpError(404, 'Запрос не найден');
      const status = c.body.status;
      if (!['SCHEDULED', 'DONE', 'CANCELED'].includes(status)) throw new HttpError(400, 'Статус должен быть SCHEDULED, DONE или CANCELED');
      let when = null, link = null;
      if (status === 'SCHEDULED') {
        when = Date.parse(c.body.scheduledAt); if (!Number.isFinite(when)) throw new HttpError(400, 'Выберите дату и время');
        link = httpsUrl(c.body.meetingUrl); if (!link) throw new HttpError(400, 'Ссылка на встречу должна начинаться с https://');
        when = new Date(when).toISOString();
      }
      const note = typeof c.body.note === 'string' ? c.body.note.slice(0, 2000) : null;
      q('UPDATE mentorship_requests SET status = ?, scheduled_at = COALESCE(?, scheduled_at), meeting_url = COALESCE(?, meeting_url), mentor_note = ? WHERE id = ?').run(status, when, link, note, id);
      if (status === 'SCHEDULED') sendMail(r.email, `Сессия с ментором назначена: ${r.topic}`, `Здравствуйте, ${r.name}!\n\nВаша сессия «${r.topic}» назначена на ${when} (UTC).\nПодключиться: ${link}${note ? `\n\n${note}` : ''}`);
      audit(admin.id, 'academy.mentorship_updated', id, { status });
      return { ok: true };
    }],
  ];
  return { routes, paramRoutes };
}
