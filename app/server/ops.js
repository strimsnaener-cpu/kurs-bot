// Platform operations: user management, announcements, support tickets, revenue and agent performance, logs.
import crypto from 'node:crypto';

const DAY = 24 * 3600e3;
const CATEGORIES = ['GENERAL', 'BILLING', 'TECHNICAL', 'CUSTOM'];   // ACADEMY is legacy: old tickets keep it, new ones can't pick it
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

export function ops({ db, HttpError, requireUser, requireAdmin, audit, throttle, str, sendMail, publicBase, publicUser }) {
  const q = sql => db.prepare(sql);
  const admins = () => q("SELECT email, name FROM users WHERE role IN ('ADMIN','SUPPORT') AND suspended_at IS NULL").all();
  const requireStaff = c => {   // support staff can answer tickets; everything else stays admin-only
    const u = requireUser(c);
    if (u.role !== 'SUPPORT') return requireAdmin(c);
    if (!u.totp_enabled) throw new HttpError(403, 'Сотрудникам поддержки нужно сначала включить двухфакторную аутентификацию');
    return u;
  };

  // ---------- audiences ----------
  const isCustomer = id => !!q("SELECT 1 FROM orders WHERE user_id = ? AND product_type = 'AGENT' AND status = 'PAID'").get(id);
  const inAudience = (u, aud) => aud === 'ALL' || u.role === 'ADMIN' || (aud === 'CUSTOMERS' && isCustomer(u.id));
  const audienceUsers = aud => q('SELECT id, email, name, role FROM users WHERE suspended_at IS NULL').all().filter(u => inAudience(u, aud));

  // ---------- tickets ----------
  const ticketOut = (t, msgs) => ({
    id: t.id, number: t.number, subject: t.subject, category: t.category, status: t.status, name: t.name, email: t.email,
    createdAt: t.created_at, updatedAt: t.updated_at,
    ...(msgs ? { messages: msgs.map(m => ({ fromStaff: !!m.from_staff, body: m.body, createdAt: m.created_at, author: m.from_staff ? (m.author_name ? `${m.author_name.split(/\s+/)[0]} (поддержка)` : 'Поддержка') : t.name })) } : {}),
  });
  const messagesOf = id => q('SELECT m.*, u.name AS author_name FROM ticket_messages m LEFT JOIN users u ON u.id = m.author_user_id WHERE m.ticket_id = ? ORDER BY m.created_at, m.rowid').all(id);
  // A ticket opens for its owner (logged in) or for anyone holding the private link token.
  function ticketFor(c, id, token) {
    const t = q('SELECT * FROM tickets WHERE id = ?').get(id);
    if (!t) throw new HttpError(404, 'Обращение не найдено');
    const ownsIt = c.user && t.user_id === c.user.id;
    const tokenOk = typeof token === 'string' && token.length > 20 && crypto.timingSafeEqual(Buffer.from(sha(token)), Buffer.from(t.access_hash));
    if (!ownsIt && !tokenOk) throw new HttpError(404, 'Обращение не найдено');
    return t;
  }
  const ticketLink = (t, token) => `${publicBase}/support.html?ticket=${t.id}${token ? `&t=${token}` : ''}`;

  const routes = {
    // ---------- announcements ----------
    'GET /api/announcements': async c => {
      const u = requireUser(c);
      const rows = q(`SELECT a.* FROM announcements a WHERE a.starts_at <= ? AND (a.ends_at IS NULL OR a.ends_at > ?)
                      AND NOT EXISTS (SELECT 1 FROM announcement_dismissals d WHERE d.announcement_id = a.id AND d.user_id = ?) ORDER BY a.level DESC, a.starts_at DESC`).all(iso(), iso(), u.id);
      return { announcements: rows.filter(a => inAudience(u, a.audience)).map(a => ({ id: a.id, title: a.title, body: a.body, level: a.level, startsAt: a.starts_at })) };
    },
    'GET /api/admin/announcements': async c => {
      requireAdmin(c);
      return { announcements: q(`SELECT a.*, (SELECT COUNT(*) FROM announcement_dismissals WHERE announcement_id = a.id) AS dismissed FROM announcements a ORDER BY a.created_at DESC LIMIT 100`).all()
        .map(a => ({ id: a.id, title: a.title, body: a.body, audience: a.audience, level: a.level, startsAt: a.starts_at, endsAt: a.ends_at, emailedAt: a.emailed_at, dismissed: a.dismissed,
          active: a.starts_at <= iso() && (!a.ends_at || a.ends_at > iso()), reach: audienceUsers(a.audience).length })) };
    },
    'POST /api/admin/announcements': async c => {
      const admin = requireAdmin(c);
      const a = announcementInput(c.body);
      const id = crypto.randomUUID();
      q('INSERT INTO announcements (id, title, body, audience, level, starts_at, ends_at, created_by) VALUES (?,?,?,?,?,?,?,?)').run(id, a.title, a.body, a.audience, a.level, a.starts_at, a.ends_at, admin.id);
      let emailed = 0;
      if (c.body.email === true) {
        throttle(`blast:${admin.id}`, 5, DAY);
        for (const u of audienceUsers(a.audience)) { await sendMail(u.email, a.title, `Hi ${u.name},\n\n${a.body}\n\n— NeuralDesk\n${publicBase}/dashboard.html`); emailed++; }
        q('UPDATE announcements SET emailed_at = ? WHERE id = ?').run(iso(), id);
      }
      audit(admin.id, 'announcement.created', id, { audience: a.audience, emailed });
      c.status = 201;
      return { id, emailed };
    },

    // ---------- support ----------
    'POST /api/support/tickets': async c => {
      throttle(`ticket:${c.ip}`, 5, 3600e3);
      const u = c.user;
      const name = u ? u.name : str(c.body.name, 'Имя', 1, 80);
      const email = u ? u.email : String(c.body.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Введите корректный email');
      const category = CATEGORIES.includes(c.body.category) ? c.body.category : 'GENERAL';
      const subject = str(c.body.subject, 'Тема обращения', 3, 140), message = str(c.body.message, 'Сообщение', 10, 5000);
      if (typeof c.body.website === 'string' && c.body.website) return { ok: true };   // honeypot: bots fill hidden fields
      const id = crypto.randomUUID(), token = crypto.randomBytes(24).toString('base64url');
      const number = q('SELECT COALESCE(MAX(number), 1000) + 1 AS n FROM tickets').get().n;
      q('INSERT INTO tickets (id, number, user_id, name, email, subject, category, access_hash) VALUES (?,?,?,?,?,?,?,?)').run(id, number, u?.id || null, name, email, subject, category, sha(token));
      q('INSERT INTO ticket_messages (id, ticket_id, author_user_id, body) VALUES (?,?,?,?)').run(crypto.randomUUID(), id, u?.id || null, message);
      const t = q('SELECT * FROM tickets WHERE id = ?').get(id);
      await sendMail(email, `Мы получили ваше сообщение (№${number})`, `Здравствуйте, ${name}!\n\nСпасибо, что написали. Мы ответим как можно скорее.\n\nВаше обращение: «${subject}»\nСледить за ним: ${ticketLink(t, u ? null : token)}`);
      for (const a of admins()) await sendMail(a.email, `Новое обращение №${number}: ${subject}`, `${name} <${email}> (${category}):\n\n${message}\n\nОтветить: ${publicBase}/admin.html#support`);
      c.status = 201;
      return { id, number, ...(u ? {} : { token }) };
    },
    'GET /api/support/tickets': async c => {
      const u = requireUser(c);
      return { tickets: q('SELECT * FROM tickets WHERE user_id = ? ORDER BY updated_at DESC').all(u.id).map(t => ticketOut(t)) };
    },
    'GET /api/admin/support': async c => {
      requireStaff(c);
      const status = new URL(c.req.url, 'http://x').searchParams.get('status');
      const rows = status ? q('SELECT * FROM tickets WHERE status = ? ORDER BY updated_at DESC LIMIT 200').all(status) : q("SELECT * FROM tickets ORDER BY (status = 'OPEN') DESC, updated_at DESC LIMIT 200").all();
      return { tickets: rows.map(t => ({ ...ticketOut(t), last: messagesOf(t.id).at(-1)?.body.slice(0, 160) })),
        counts: Object.fromEntries(q('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all().map(r => [r.status, r.n])) };
    },

    // ---------- insights ----------
    'GET /api/admin/insights': async c => {
      requireAdmin(c);
      const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 11 + i); return d.toISOString().slice(0, 7); });
      const paid = q("SELECT substr(paid_at, 1, 7) AS m, product_type AS type, currency, SUM(amount) AS total, COUNT(*) AS n FROM orders WHERE status = 'PAID' AND paid_at >= ? GROUP BY m, type, currency").all(`${months[0]}-01`);
      const currencies = [...new Set(paid.map(r => r.currency))];
      const main = currencies.sort((a, b) => paid.filter(r => r.currency === b).length - paid.filter(r => r.currency === a).length)[0] || 'USD';
      const users = q('SELECT substr(created_at, 1, 7) AS m, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY m').all(`${months[0]}-01`);
      return {
        currency: main, months,
        agents: months.map(m => paid.filter(r => r.m === m && r.type === 'AGENT' && r.currency === main).reduce((s, r) => s + r.total, 0)),
        otherCurrencies: currencies.filter(x => x !== main),
        newUsers: months.map(m => users.find(r => r.m === m)?.n || 0),
        topAgents: q(`SELECT a.name, COUNT(*) AS orders, SUM(o.amount) AS total, o.currency FROM orders o JOIN agents a ON a.id = o.agent_id WHERE o.status = 'PAID' GROUP BY a.id, o.currency ORDER BY total DESC LIMIT 5`).all(),
        refunds: q("SELECT COUNT(*) AS n, COALESCE(SUM(amount), 0) AS total FROM orders WHERE status = 'REFUNDED'").get(),
        openTickets: q("SELECT COUNT(*) AS n FROM tickets WHERE status = 'OPEN'").get().n,
      };
    },
    'GET /api/admin/agents/performance': async c => {
      requireAdmin(c);
      const since = iso(-7 * DAY);
      const sum = (id, kinds) => q(`SELECT COALESCE(SUM(quantity), 0) AS n FROM usage_records WHERE installation_id = ? AND created_at >= ? AND kind IN (${kinds.map(() => '?').join(',')})`).get(id, since, ...kinds).n;
      const rows = q(`SELECT i.*, a.name AS agent_name, o.name AS org_name,
                      (SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = i.org_id AND m.role = 'OWNER' LIMIT 1) AS owner,
                      (SELECT MAX(last_message_at) FROM conversations WHERE installation_id = i.id) AS last_message
                      FROM installations i JOIN agents a ON a.id = i.agent_id JOIN organizations o ON o.id = i.org_id ORDER BY last_message DESC NULLS LAST, i.created_at DESC`).all();
      return { installations: rows.map(r => {
        const conns = q('SELECT channel, display_name, last_error FROM channel_connections WHERE installation_id = ?').all(r.id);
        const incoming = sum(r.id, ['message_in']), replies = sum(r.id, ['message_out']), handoffs = sum(r.id, ['handoff']);
        return { id: r.id, agent: r.agent_name, workspace: r.org_name, owner: r.owner, live: !!r.auto_reply, lastMessageAt: r.last_message,
          channels: conns.map(x => `${x.channel === 'TELEGRAM' ? 'Telegram' : 'Instagram'} ${x.display_name}`), errors: conns.filter(x => x.last_error).map(x => x.last_error),
          incoming, replies, handoffs, leads: sum(r.id, ['lead']), tokens: sum(r.id, ['tokens_in', 'tokens_out']),
          handoffRate: incoming ? Math.round(handoffs / incoming * 100) : 0,
          failedJobs: q("SELECT COUNT(*) AS n FROM jobs j WHERE status = 'failed' AND updated_at >= ? AND kind = 'reply' AND json_extract(payload, '$.messageId') IN (SELECT m.id FROM messages m JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.installation_id = ?)").get(since, r.id).n };
      }) };
    },

    // ---------- logs ----------
    'GET /api/admin/logs/audit': async c => {
      requireAdmin(c);
      const p = new URL(c.req.url, 'http://x').searchParams;
      const action = (p.get('action') || '').slice(0, 60), actor = (p.get('actor') || '').trim().toLowerCase().slice(0, 120), before = p.get('before') || '9999';
      const rows = q(`SELECT l.*, u.email AS actor_email FROM audit_log l LEFT JOIN users u ON u.id = l.actor_id
                      WHERE l.created_at < ? AND (? = '' OR l.action LIKE ?) AND (? = '' OR lower(u.email) LIKE ?) ORDER BY l.created_at DESC LIMIT 101`)
        .all(before, action, `${action}%`, actor, `%${actor}%`);
      return { entries: rows.slice(0, 100).map(r => ({ at: r.created_at, action: r.action, actor: r.actor_email || (r.actor_id ? 'удалённый пользователь' : 'system'), target: r.target, meta: r.meta ? JSON.parse(r.meta) : null })),
        next: rows.length > 100 ? rows[99].created_at : null };
    },
    'GET /api/admin/logs/system': async c => {
      requireAdmin(c);
      const level = new URL(c.req.url, 'http://x').searchParams.get('level');
      return { entries: q(`SELECT * FROM system_logs WHERE (? IS NULL OR level = ?) ORDER BY created_at DESC LIMIT 200`).all(level, level)
        .map(r => ({ at: r.created_at, level: r.level, source: r.source, message: r.message, meta: r.meta ? JSON.parse(r.meta) : null })) };
    },
  };

  function announcementInput(b) {
    const starts = b.startsAt ? Date.parse(b.startsAt) : Date.now(), ends = b.endsAt ? Date.parse(b.endsAt) : null;
    if (!Number.isFinite(starts) || (b.endsAt && !Number.isFinite(ends))) throw new HttpError(400, 'Проверьте даты');
    if (ends && ends <= starts) throw new HttpError(400, 'Дата окончания должна быть позже начала');
    return { title: str(b.title, 'Название', 3, 120), body: str(b.body, 'Сообщение', 3, 2000),
      audience: ['ALL', 'CUSTOMERS'].includes(b.audience) ? b.audience : 'ALL', level: b.level === 'IMPORTANT' ? 'IMPORTANT' : 'INFO',
      starts_at: new Date(starts).toISOString(), ends_at: ends ? new Date(ends).toISOString() : null };
  }

  const ID = '([\\w-]+)';
  const R = (m, p) => new RegExp(`^${m} ${p.replace(/:id/g, ID)}$`);
  const paramRoutes = [
    // ---------- users ----------
    [R('GET', '/api/admin/users/:id'), async (c, [id]) => {
      requireAdmin(c);
      const u = q('SELECT * FROM users WHERE id = ?').get(id);
      if (!u) throw new HttpError(404, 'Пользователь не найден');
      const orgs = q('SELECT o.id, o.name, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ?').all(id);
      return {
        user: { ...publicUser(u), suspended: !!u.suspended_at, suspendedAt: u.suspended_at, suspendReason: u.suspend_reason },
        workspaces: orgs,
        orders: q('SELECT o.id, o.status, o.product_type AS type, o.plan_name AS plan, o.interval, o.amount, o.currency, o.created_at AS createdAt, COALESCE(a.name, o.plan_name) AS product FROM orders o LEFT JOIN agents a ON a.id = o.agent_id WHERE o.user_id = ? ORDER BY o.created_at DESC').all(id),
        agents: q(`SELECT i.id, i.name, i.auto_reply AS live, (SELECT GROUP_CONCAT(display_name, ', ') FROM channel_connections WHERE installation_id = i.id) AS channels
                   FROM installations i JOIN memberships m ON m.org_id = i.org_id WHERE m.user_id = ?`).all(id).map(x => ({ ...x, live: !!x.live })),
        tickets: q('SELECT * FROM tickets WHERE user_id = ? OR email = ? ORDER BY updated_at DESC').all(id, u.email).map(t => ticketOut(t)),
        sessions: q('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').get(id, iso()).n,
        activity: q('SELECT action, target, created_at AS at FROM audit_log WHERE actor_id = ? ORDER BY created_at DESC LIMIT 15').all(id),
      };
    }],
    [R('POST', '/api/admin/users/:id/suspend'), async (c, [id]) => {
      const admin = requireAdmin(c);
      if (id === admin.id) throw new HttpError(400, 'Нельзя заблокировать самого себя');
      const u = q('SELECT * FROM users WHERE id = ?').get(id);
      if (!u) throw new HttpError(404, 'Пользователь не найден');
      if (c.body.suspended === true) {
        const reason = str(c.body.reason, 'Причина', 3, 300);
        db.exec('BEGIN');
        try {
          q('UPDATE users SET suspended_at = ?, suspend_reason = ? WHERE id = ?').run(iso(), reason, id);
          q('DELETE FROM sessions WHERE user_id = ?').run(id);                                         // logged out everywhere
          if (c.body.pauseAgents !== false)                                                          // stop their bots replying
            q("UPDATE installations SET auto_reply = 0 WHERE org_id IN (SELECT org_id FROM memberships WHERE user_id = ? AND role = 'OWNER')").run(id);
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        audit(admin.id, 'admin.user_suspended', id, { reason, pauseAgents: c.body.pauseAgents !== false });
      } else {
        q('UPDATE users SET suspended_at = NULL, suspend_reason = NULL WHERE id = ?').run(id);
        audit(admin.id, 'admin.user_restored', id);
      }
      return { ok: true };
    }],
    [R('POST', '/api/admin/users/:id/logout'), async (c, [id]) => {
      const admin = requireAdmin(c);
      const n = q('DELETE FROM sessions WHERE user_id = ?').run(id).changes;
      audit(admin.id, 'admin.user_logged_out', id, { sessions: n });
      return { sessions: n };
    }],

    // ---------- announcements ----------
    [R('POST', '/api/announcements/:id/dismiss'), async (c, [id]) => {
      const u = requireUser(c);
      q('INSERT INTO announcement_dismissals (user_id, announcement_id) SELECT ?, id FROM announcements WHERE id = ? ON CONFLICT DO NOTHING').run(u.id, id);
      return { ok: true };
    }],
    [R('POST', '/api/admin/announcements/:id'), async (c, [id]) => {
      const admin = requireAdmin(c);
      const a = announcementInput(c.body);
      if (!q('UPDATE announcements SET title = ?, body = ?, audience = ?, level = ?, starts_at = ?, ends_at = ? WHERE id = ?').run(a.title, a.body, a.audience, a.level, a.starts_at, a.ends_at, id).changes) throw new HttpError(404, 'Объявление не найдено');
      audit(admin.id, 'announcement.updated', id);
      return { ok: true };
    }],
    [R('POST', '/api/admin/announcements/:id/end'), async (c, [id]) => {
      const admin = requireAdmin(c);
      q('UPDATE announcements SET ends_at = ? WHERE id = ?').run(iso(), id);
      audit(admin.id, 'announcement.ended', id);
      return { ok: true };
    }],

    // ---------- support: customer ----------
    [R('GET', '/api/support/tickets/:id'), async (c, [id]) => {
      const t = ticketFor(c, id, new URL(c.req.url, 'http://x').searchParams.get('t'));
      return { ticket: ticketOut(t, messagesOf(t.id)) };
    }],
    [R('POST', '/api/support/tickets/:id/reply'), async (c, [id]) => {
      const t = ticketFor(c, id, c.body.t);
      throttle(`ticket-reply:${t.id}`, 30, DAY);
      const body = str(c.body.body, 'Сообщение', 1, 5000);
      q('INSERT INTO ticket_messages (id, ticket_id, author_user_id, body) VALUES (?,?,?,?)').run(crypto.randomUUID(), t.id, c.user?.id || null, body);
      q("UPDATE tickets SET status = 'OPEN', updated_at = ? WHERE id = ?").run(iso(), t.id);
      for (const a of admins()) await sendMail(a.email, `Ответ в обращении №${t.number}: ${t.subject}`, `${t.name} пишет:\n\n${body}\n\n${publicBase}/admin.html#support`);
      return { ok: true };
    }],
    [R('POST', '/api/support/tickets/:id/close'), async (c, [id]) => {
      const t = ticketFor(c, id, c.body.t);
      q("UPDATE tickets SET status = 'CLOSED', updated_at = ? WHERE id = ?").run(iso(), t.id);
      return { ok: true };
    }],

    // ---------- support: staff ----------
    [R('GET', '/api/admin/support/:id'), async (c, [id]) => {
      requireStaff(c);
      const t = q('SELECT * FROM tickets WHERE id = ?').get(id);
      if (!t) throw new HttpError(404, 'Обращение не найдено');
      const u = t.user_id && q('SELECT id, name, email, role FROM users WHERE id = ?').get(t.user_id);
      return { ticket: ticketOut(t, messagesOf(t.id)), account: u || null };
    }],
    [R('POST', '/api/admin/support/:id/reply'), async (c, [id]) => {
      const staff = requireStaff(c);
      const t = q('SELECT * FROM tickets WHERE id = ?').get(id);
      if (!t) throw new HttpError(404, 'Обращение не найдено');
      const body = str(c.body.body, 'Ответ', 1, 5000);
      const status = c.body.close ? 'CLOSED' : 'PENDING';
      q('INSERT INTO ticket_messages (id, ticket_id, author_user_id, from_staff, body) VALUES (?,?,?,1,?)').run(crypto.randomUUID(), t.id, staff.id, body);
      // Guests get a fresh private link (we only store its hash, so the old one can't be re-sent).
      let token = null;
      if (!t.user_id) { token = crypto.randomBytes(24).toString('base64url'); q('UPDATE tickets SET access_hash = ? WHERE id = ?').run(sha(token), t.id); }
      q('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, iso(), t.id);
      await sendMail(t.email, `Re: ${t.subject} (№${t.number})`, `Здравствуйте, ${t.name}!\n\n${body}\n\n— Поддержка NeuralDesk\n\nОтветить или посмотреть всю переписку: ${ticketLink(t, token)}`);
      audit(staff.id, 'support.replied', t.id, { status });
      return { ok: true, status };
    }],
    [R('POST', '/api/admin/support/:id/status'), async (c, [id]) => {
      const staff = requireStaff(c);
      if (!['OPEN', 'PENDING', 'CLOSED'].includes(c.body.status)) throw new HttpError(400, 'Статус должен быть OPEN, PENDING или CLOSED');
      if (!q('UPDATE tickets SET status = ?, updated_at = ? WHERE id = ?').run(c.body.status, iso(), id).changes) throw new HttpError(404, 'Обращение не найдено');
      audit(staff.id, 'support.status', id, { status: c.body.status });
      return { ok: true };
    }],
  ];
  return { routes, paramRoutes };
}
