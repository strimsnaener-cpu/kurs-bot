// Marketplace: catalog, orders, reviews, and the admin endpoints that manage them.
import crypto from 'node:crypto';
import { applyAcademyOrder } from './academy.js';

const CATEGORIES = ['sales', 'support', 'ops'];
const ICONS = ['chat', 'camera', 'cart', 'shield', 'chart', 'bolt'];
const PLATFORMS = ['TELEGRAM', 'INSTAGRAM', 'WEB', 'API', 'EMAIL'];
const INTERVALS = ['MONTH', 'YEAR', 'ONE_TIME'];
const CURRENCIES = ['USD', 'EUR', 'UAH'];
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export function marketplace({ db, HttpError, requireUser, requireAdmin, audit, throttle, str }) {
  const q = sql => db.prepare(sql);
  const now = () => new Date().toISOString();
  const J = s => JSON.parse(s || '[]');

  // ---------- validation ----------
  function list(v, field, max, item) {
    if (!Array.isArray(v)) throw new HttpError(400, `${field}: нужен список`);
    if (v.length > max) throw new HttpError(400, `${field}: at most ${max} items`);
    return v.map((x, i) => item(x, `${field} #${i + 1}`));
  }
  function agentInput(b, partial) {
    const out = {};
    const has = k => b[k] !== undefined;
    const need = k => { if (!partial && !has(k)) throw new HttpError(400, `Поле «${k}» обязательно`); return has(k); };
    if (need('slug')) { if (typeof b.slug !== 'string' || !SLUG_RE.test(b.slug)) throw new HttpError(400, 'Слаг: 2–40 строчных латинских букв, цифр или дефисов'); out.slug = b.slug; }
    if (need('name')) out.name = str(b.name, 'Имя', 2, 60);
    if (need('tagline')) out.tagline = str(b.tagline, 'Слоган', 5, 160);
    if (need('description')) out.description = str(b.description, 'Описание', 20, 3000);
    if (need('category')) {
      const cats = String(b.category).trim().split(/\s+/);
      if (!cats.length || cats.some(c => !CATEGORIES.includes(c))) throw new HttpError(400, `Категория должна быть из списка: ${CATEGORIES.join(', ')}`);
      out.category = [...new Set(cats)].join(' ');
    }
    if (has('icon')) { if (!ICONS.includes(b.icon)) throw new HttpError(400, `Icon must be one of: ${ICONS.join(', ')}`); out.icon = b.icon; }
    if (has('features')) out.features = JSON.stringify(list(b.features, 'Что входит', 20, (x, f) => str(x, f, 2, 200)));
    if (has('install_steps')) out.install_steps = JSON.stringify(list(b.install_steps, 'Шаги установки', 10, (x, f) => str(x, f, 2, 300)));
    if (has('problems')) out.problems = JSON.stringify(list(b.problems, 'Проблемы', 8, (x, f) => ({ title: str(x?.title, `${f} title`, 2, 60), text: str(x?.text, `${f} text`, 2, 240) })));
    if (has('demo')) out.demo = JSON.stringify(list(b.demo, 'Демо', 12, (x, f) => {
      if (!['customer', 'agent'].includes(x?.from)) throw new HttpError(400, `${f}: "from" должно быть customer или agent`);
      return { from: x.from, text: str(x.text, f, 1, 400) };
    }));
    if (has('platforms')) {
      const p = list(b.platforms, 'Платформы', 5, x => { if (!PLATFORMS.includes(x)) throw new HttpError(400, `Platform must be one of: ${PLATFORMS.join(', ')}`); return x; });
      out.platforms = JSON.stringify([...new Set(p)]);
    }
    if (has('published')) out.published = b.published ? 1 : 0;
    if (has('sort_order')) { if (!Number.isInteger(b.sort_order)) throw new HttpError(400, 'Порядок сортировки должен быть целым числом'); out.sort_order = b.sort_order; }
    return out;
  }
  function priceMap(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Цены должны быть объектом вида {"MONTH": 2900}');
    const out = {};
    for (const [k, amt] of Object.entries(v)) {
      if (!INTERVALS.includes(k)) throw new HttpError(400, `Период оплаты должен быть одним из: ${INTERVALS.join(', ')}`);
      if (amt === null || amt === '') { out[k] = null; continue; }   // null removes this interval
      if (!Number.isInteger(amt) || amt < 0 || amt > 100_000_000) throw new HttpError(400, 'Цена должна быть целым числом центов');
      out[k] = amt;
    }
    return out;
  }

  // ---------- read models ----------
  const ratingOf = agentId => q('SELECT ROUND(AVG(rating), 1) AS avg, COUNT(*) AS n FROM reviews WHERE agent_id = ? AND approved = 1').get(agentId);
  function plansOf(agentId, includeInactive) {
    const plans = q(`SELECT * FROM plans WHERE agent_id = ? ${includeInactive ? '' : 'AND active = 1'} ORDER BY sort_order, name`).all(agentId);
    return plans.map(p => ({
      id: p.id, name: p.name, features: J(p.features), active: !!p.active, sortOrder: p.sort_order,
      prices: q("SELECT id, interval, amount, currency FROM prices WHERE plan_id = ? AND active = 1 ORDER BY CASE interval WHEN 'MONTH' THEN 0 WHEN 'YEAR' THEN 1 ELSE 2 END").all(p.id),
    }));
  }
  function cardOf(a) {
    const min = q(`SELECT pr.amount, pr.currency, pr.interval FROM prices pr JOIN plans p ON p.id = pr.plan_id
                   WHERE p.agent_id = ? AND p.active = 1 AND pr.active = 1
                   ORDER BY CASE pr.interval WHEN 'MONTH' THEN 0 WHEN 'ONE_TIME' THEN 1 ELSE 2 END, pr.amount LIMIT 1`).get(a.id);
    const r = ratingOf(a.id);
    return { id: a.id, slug: a.slug, name: a.name, tagline: a.tagline, category: a.category, icon: a.icon, platforms: J(a.platforms),
      published: !!a.published, fromPrice: min || null, rating: r.avg, reviewCount: r.n };
  }
  function detailOf(a) {
    return { ...cardOf(a), description: a.description, features: J(a.features), problems: J(a.problems), demo: J(a.demo),
      installSteps: J(a.install_steps), sortOrder: a.sort_order, updatedAt: a.updated_at };
  }
  const orderOut = o => ({ id: o.id, status: o.status, productType: o.product_type, agentId: o.agent_id, agentName: o.agent_name, agentSlug: o.agent_slug, planName: o.plan_name,
    interval: o.interval, amount: o.amount, currency: o.currency, createdAt: o.created_at, paidAt: o.paid_at,
    ...(o.email ? { customerEmail: o.email, customerName: o.user_name } : {}) });
  const ORDER_SQL = `SELECT o.*, COALESCE(a.name, ap.name) AS agent_name, a.slug AS agent_slug, u.email, u.name AS user_name
                     FROM orders o LEFT JOIN agents a ON a.id = o.agent_id LEFT JOIN academy_plans ap ON ap.id = o.academy_plan_id
                     JOIN users u ON u.id = o.user_id`;
  const ownsAgent = (userId, agentId) => !!q("SELECT 1 FROM orders WHERE user_id = ? AND agent_id = ? AND status = 'PAID'").get(userId, agentId);

  function savePrices(planId, prices, currency) {
    for (const [interval, amount] of Object.entries(prices)) {
      const cur = q('SELECT * FROM prices WHERE plan_id = ? AND interval = ? AND active = 1').get(planId, interval);
      if (cur && amount !== null && cur.amount === amount && cur.currency === currency) continue;
      // Old price rows are kept (inactive) so past orders still point to what was bought.
      if (cur) q('UPDATE prices SET active = 0 WHERE id = ?').run(cur.id);
      if (amount !== null) q('INSERT INTO prices (id, plan_id, interval, amount, currency) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), planId, interval, amount, currency);
    }
  }
  const currencyOf = c => { const x = c ?? 'USD'; if (!CURRENCIES.includes(x)) throw new HttpError(400, `Currency must be one of: ${CURRENCIES.join(', ')}`); return x; };
  const tx = fn => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  const routes = {
    // ---------- public catalog ----------
    'GET /api/agents': async c => {
      const url = new URL(c.req.url, 'http://x');
      const cat = url.searchParams.get('category'), text = (url.searchParams.get('q') || '').trim().toLowerCase().slice(0, 80);
      let rows = q('SELECT * FROM agents WHERE published = 1 ORDER BY sort_order, name').all();
      if (cat && cat !== 'all') rows = rows.filter(a => a.category.split(' ').includes(cat));
      if (text) rows = rows.filter(a => `${a.name} ${a.tagline} ${a.description}`.toLowerCase().includes(text));
      return { agents: rows.map(cardOf) };
    },

    // ---------- customer ----------
    'POST /api/orders': async c => {
      const u = requireUser(c);
      throttle(`order:${u.id}`, 20, 3600e3);
      const price = typeof c.body.priceId === 'string' && q(`SELECT pr.*, p.name AS plan_name, p.active AS plan_active, p.agent_id, a.published
                     FROM prices pr JOIN plans p ON p.id = pr.plan_id JOIN agents a ON a.id = p.agent_id WHERE pr.id = ?`).get(c.body.priceId);
      if (!price || !price.active || !price.plan_active || !price.published) throw new HttpError(400, 'Этот тариф больше недоступен. Обновите страницу.');
      const existing = q("SELECT id FROM orders WHERE user_id = ? AND price_id = ? AND status = 'PENDING'").get(u.id, price.id);
      if (existing) return { order: orderOut(q(`${ORDER_SQL} WHERE o.id = ?`).get(existing.id)) };   // double-click safe
      const org = q("SELECT org_id FROM memberships WHERE user_id = ? AND role = 'OWNER' LIMIT 1").get(u.id);
      if (!org) throw new HttpError(400, 'У вашего аккаунта нет рабочего пространства');
      const id = crypto.randomUUID();
      q(`INSERT INTO orders (id, user_id, org_id, agent_id, price_id, plan_name, interval, amount, currency) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(id, u.id, org.org_id, price.agent_id, price.id, price.plan_name, price.interval, price.amount, price.currency);
      audit(u.id, 'order.created', id, { amount: price.amount, currency: price.currency });
      c.status = 201;
      return { order: orderOut(q(`${ORDER_SQL} WHERE o.id = ?`).get(id)) };
    },
    'GET /api/orders': async c => {
      const u = requireUser(c);
      return { orders: q(`${ORDER_SQL} WHERE o.user_id = ? ORDER BY o.created_at DESC`).all(u.id).map(o => { const x = orderOut(o); delete x.customerEmail; delete x.customerName; return x; }) };
    },
    'GET /api/my/agents': async c => {
      const u = requireUser(c);
      const rows = q(`SELECT a.*, o.id AS order_id, o.plan_name, o.interval, o.paid_at, (SELECT id FROM installations WHERE order_id = o.id) AS installation_id FROM orders o JOIN agents a ON a.id = o.agent_id
                      WHERE o.user_id = ? AND o.status = 'PAID' ORDER BY o.paid_at DESC`).all(u.id);
      const seen = new Set();
      return { agents: rows.filter(r => !seen.has(r.id) && seen.add(r.id)).map(r => ({ ...cardOf(r), orderId: r.order_id, installationId: r.installation_id, planName: r.plan_name, interval: r.interval, since: r.paid_at })) };
    },

    // ---------- admin ----------
    'GET /api/admin/stats': async c => {
      requireAdmin(c);
      return {
        revenue: q("SELECT currency, SUM(amount) AS total, COUNT(*) AS orders FROM orders WHERE status = 'PAID' GROUP BY currency").all(),
        pendingOrders: q("SELECT COUNT(*) AS n FROM orders WHERE status = 'PENDING'").get().n,
        users: q('SELECT COUNT(*) AS n FROM users').get().n,
        agents: q('SELECT COUNT(*) AS n FROM agents WHERE published = 1').get().n,
        pendingReviews: q('SELECT COUNT(*) AS n FROM reviews WHERE approved = 0').get().n,
      };
    },
    'GET /api/admin/agents': async c => {
      requireAdmin(c);
      return { agents: q('SELECT * FROM agents ORDER BY sort_order, name').all().map(a => ({ ...cardOf(a), orders: q('SELECT COUNT(*) AS n FROM orders WHERE agent_id = ?').get(a.id).n })) };
    },
    'POST /api/admin/agents': async c => {
      const admin = requireAdmin(c);
      const d = agentInput(c.body, false);
      if (q('SELECT 1 FROM agents WHERE slug = ?').get(d.slug)) throw new HttpError(409, 'Агент с таким слагом уже существует');
      if (d.sort_order === undefined) d.sort_order = q('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM agents').get().n; // new agents go last
      const id = crypto.randomUUID();
      const cols = Object.keys(d);
      q(`INSERT INTO agents (id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`).run(id, ...cols.map(k => d[k]));
      audit(admin.id, 'agent.created', id, { slug: d.slug });
      c.status = 201;
      return { agent: detailOf(q('SELECT * FROM agents WHERE id = ?').get(id)) };
    },
    'GET /api/admin/orders': async c => {
      requireAdmin(c);
      const status = new URL(c.req.url, 'http://x').searchParams.get('status');
      const rows = status ? q(`${ORDER_SQL} WHERE o.status = ? ORDER BY o.created_at DESC LIMIT 200`).all(status) : q(`${ORDER_SQL} ORDER BY o.created_at DESC LIMIT 200`).all();
      return { orders: rows.map(orderOut) };
    },
    'GET /api/admin/reviews': async c => {
      requireAdmin(c);
      return { reviews: q(`SELECT r.*, a.name AS agent_name, u.email, u.name AS user_name FROM reviews r JOIN agents a ON a.id = r.agent_id JOIN users u ON u.id = r.user_id
                           ORDER BY r.approved, r.created_at DESC LIMIT 200`).all()
        .map(r => ({ id: r.id, agentName: r.agent_name, author: r.user_name, email: r.email, rating: r.rating, body: r.body, approved: !!r.approved, createdAt: r.created_at })) };
    },
  };

  const paramRoutes = [
    [/^GET \/api\/agents\/([a-z0-9-]+)$/, async (c, [slug]) => {
      const a = q('SELECT * FROM agents WHERE slug = ?').get(slug);
      const isAdmin = c.user?.role === 'ADMIN';
      if (!a || (!a.published && !isAdmin)) throw new HttpError(404, 'Агент не найден');
      const reviews = q(`SELECT r.rating, r.body, r.created_at, u.name FROM reviews r JOIN users u ON u.id = r.user_id
                         WHERE r.agent_id = ? AND r.approved = 1 ORDER BY r.created_at DESC LIMIT 50`).all(a.id)
        .map(r => { const [f, l] = r.name.split(/\s+/); return { rating: r.rating, body: r.body, createdAt: r.created_at, author: l ? `${f} ${l[0]}.` : f }; });
      let viewer = { loggedIn: false, owned: false, canReview: false, myReview: null };
      if (c.user) {
        const owned = ownsAgent(c.user.id, a.id);
        const mine = q('SELECT rating, body, approved FROM reviews WHERE agent_id = ? AND user_id = ?').get(a.id, c.user.id);
        viewer = { loggedIn: true, owned, canReview: owned, myReview: mine ? { ...mine, approved: !!mine.approved } : null };
      }
      return { agent: { ...detailOf(a), plans: plansOf(a.id, false) }, reviews, viewer };
    }],
    [/^POST \/api\/agents\/([a-z0-9-]+)\/reviews$/, async (c, [slug]) => {
      const u = requireUser(c);
      const a = q('SELECT * FROM agents WHERE slug = ? AND published = 1').get(slug);
      if (!a) throw new HttpError(404, 'Агент не найден');
      if (!ownsAgent(u.id, a.id)) throw new HttpError(403, 'Оставить отзыв могут только клиенты, купившие этого агента');
      throttle(`review:${u.id}`, 10, 3600e3);
      const rating = c.body.rating;
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Оценка должна быть от 1 до 5 звёзд');
      const body = str(c.body.body, 'Отзыв', 10, 1500);
      q(`INSERT INTO reviews (id, agent_id, user_id, rating, body) VALUES (?,?,?,?,?)
         ON CONFLICT (agent_id, user_id) DO UPDATE SET rating = excluded.rating, body = excluded.body, approved = 0, created_at = excluded.created_at`)
        .run(crypto.randomUUID(), a.id, u.id, rating, body);
      audit(u.id, 'review.submitted', a.id, { rating });
      return { ok: true, message: 'Спасибо! Отзыв появится после быстрой проверки.' };
    }],
    [/^GET \/api\/orders\/([\w-]+)$/, async (c, [id]) => {
      const u = requireUser(c);
      const o = q(`${ORDER_SQL} WHERE o.id = ?`).get(id);
      if (!o || (o.user_id !== u.id && u.role !== 'ADMIN')) throw new HttpError(404, 'Заказ не найден');
      return { order: orderOut(o) };
    }],
    [/^POST \/api\/orders\/([\w-]+)\/cancel$/, async (c, [id]) => {
      const u = requireUser(c);
      const o = q('SELECT * FROM orders WHERE id = ?').get(id);
      if (!o || o.user_id !== u.id) throw new HttpError(404, 'Заказ не найден');
      if (o.status !== 'PENDING') throw new HttpError(400, 'Отменить можно только неоплаченный заказ');
      q("UPDATE orders SET status = 'CANCELED' WHERE id = ?").run(id);
      audit(u.id, 'order.canceled', id);
      return { ok: true };
    }],

    // ---------- admin: agents & plans ----------
    [/^GET \/api\/admin\/agents\/([\w-]+)$/, async (c, [id]) => {
      requireAdmin(c);
      const a = q('SELECT * FROM agents WHERE id = ?').get(id);
      if (!a) throw new HttpError(404, 'Агент не найден');
      return { agent: { ...detailOf(a), plans: plansOf(a.id, true) } };
    }],
    [/^POST \/api\/admin\/agents\/([\w-]+)$/, async (c, [id]) => {
      const admin = requireAdmin(c);
      const a = q('SELECT * FROM agents WHERE id = ?').get(id);
      if (!a) throw new HttpError(404, 'Агент не найден');
      const d = agentInput(c.body, true);
      if (d.slug && d.slug !== a.slug) {
        if (q('SELECT 1 FROM orders WHERE agent_id = ?').get(id)) throw new HttpError(409, 'Слаг нельзя изменить, если у агента уже есть заказы');
        if (q('SELECT 1 FROM agents WHERE slug = ?').get(d.slug)) throw new HttpError(409, 'Агент с таким слагом уже существует');
      }
      if (d.published === 1 && !plansOf(id, false).some(p => p.prices.length)) throw new HttpError(400, 'Перед публикацией добавьте хотя бы один активный тариф с ценой');
      const cols = Object.keys(d);
      if (cols.length) q(`UPDATE agents SET ${cols.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map(k => d[k]), now(), id);
      audit(admin.id, 'agent.updated', id, { fields: cols });
      return { agent: { ...detailOf(q('SELECT * FROM agents WHERE id = ?').get(id)), plans: plansOf(id, true) } };
    }],
    [/^POST \/api\/admin\/agents\/([\w-]+)\/delete$/, async (c, [id]) => {
      const admin = requireAdmin(c);
      if (!q('SELECT 1 FROM agents WHERE id = ?').get(id)) throw new HttpError(404, 'Агент не найден');
      if (q('SELECT 1 FROM orders WHERE agent_id = ?').get(id)) throw new HttpError(409, 'У этого агента есть заказы, его можно только снять с публикации, но не удалить');
      q('DELETE FROM agents WHERE id = ?').run(id);
      audit(admin.id, 'agent.deleted', id);
      return { ok: true };
    }],
    [/^POST \/api\/admin\/agents\/([\w-]+)\/plans$/, async (c, [agentId]) => {
      const admin = requireAdmin(c);
      if (!q('SELECT 1 FROM agents WHERE id = ?').get(agentId)) throw new HttpError(404, 'Агент не найден');
      const name = str(c.body.name, 'Название тарифа', 2, 40);
      const features = list(c.body.features ?? [], 'Что входит в тариф', 15, (x, f) => str(x, f, 2, 120));
      const prices = priceMap(c.body.prices ?? {}), currency = currencyOf(c.body.currency);
      const id = crypto.randomUUID();
      tx(() => {
        const order = q('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM plans WHERE agent_id = ?').get(agentId).n;
        q('INSERT INTO plans (id, agent_id, name, features, sort_order) VALUES (?,?,?,?,?)').run(id, agentId, name, JSON.stringify(features), order);
        savePrices(id, prices, currency);
      });
      audit(admin.id, 'plan.created', id, { agentId });
      c.status = 201;
      return { plans: plansOf(agentId, true) };
    }],
    [/^POST \/api\/admin\/plans\/([\w-]+)$/, async (c, [id]) => {
      const admin = requireAdmin(c);
      const p = q('SELECT * FROM plans WHERE id = ?').get(id);
      if (!p) throw new HttpError(404, 'Тариф не найден');
      const b = c.body;
      const name = b.name !== undefined ? str(b.name, 'Название тарифа', 2, 40) : p.name;
      const features = b.features !== undefined ? JSON.stringify(list(b.features, 'Что входит в тариф', 15, (x, f) => str(x, f, 2, 120))) : p.features;
      const active = b.active !== undefined ? (b.active ? 1 : 0) : p.active;
      const prices = b.prices !== undefined ? priceMap(b.prices) : null;
      const currency = currencyOf(b.currency);
      tx(() => {
        q('UPDATE plans SET name = ?, features = ?, active = ? WHERE id = ?').run(name, features, active, id);
        if (prices) savePrices(id, prices, currency);
      });
      audit(admin.id, 'plan.updated', id, { prices: prices ?? undefined, active: !!active });
      return { plans: plansOf(p.agent_id, true) };
    }],

    // ---------- admin: orders & reviews ----------
    [/^POST \/api\/admin\/orders\/([\w-]+)\/status$/, async (c, [id]) => {
      const admin = requireAdmin(c);
      const o = q('SELECT * FROM orders WHERE id = ?').get(id);
      if (!o) throw new HttpError(404, 'Заказ не найден');
      const to = c.body.status;
      const allowed = { PENDING: ['PAID', 'FAILED', 'CANCELED'], PAID: ['REFUNDED'] }[o.status] || [];
      if (!allowed.includes(to)) throw new HttpError(400, `Нельзя перевести заказ из ${o.status} в ${to}`);
      tx(() => {
        q('UPDATE orders SET status = ?, paid_at = CASE WHEN ? = \'PAID\' THEN ? ELSE paid_at END WHERE id = ?').run(to, to, now(), id);
        if (o.product_type === 'ACADEMY') applyAcademyOrder(db, o, to);   // grant or revoke Academy access
      });
      audit(admin.id, 'order.status_changed', id, { from: o.status, to });
      return { order: orderOut(q(`${ORDER_SQL} WHERE o.id = ?`).get(id)) };
    }],
    [/^POST \/api\/admin\/reviews\/([\w-]+)$/, async (c, [id]) => {
      const admin = requireAdmin(c);
      if (!q('SELECT 1 FROM reviews WHERE id = ?').get(id)) throw new HttpError(404, 'Отзыв не найден');
      if (c.body.action === 'delete') { q('DELETE FROM reviews WHERE id = ?').run(id); audit(admin.id, 'review.deleted', id); return { ok: true }; }
      if (typeof c.body.approved !== 'boolean') throw new HttpError(400, 'Отправьте {"approved": true|false} или {"action": "delete"}');
      q('UPDATE reviews SET approved = ? WHERE id = ?').run(c.body.approved ? 1 : 0, id);
      audit(admin.id, c.body.approved ? 'review.approved' : 'review.hidden', id);
      return { ok: true };
    }],
  ];

  return { routes, paramRoutes };
}
