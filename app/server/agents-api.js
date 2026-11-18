// HTTP routes for installed agents: setup, Telegram, knowledge, conversations, leads, stats, test chat, webhooks.
import crypto from 'node:crypto';
import { defaultConfig, validateConfig, LANGUAGES, TONES, RUNTIME_CHANNELS } from './runtime/agents.js';
import { TOKEN_RE } from './channels/telegram.js';

export function agentsApi({ db, HttpError, requireUser, requireAdmin, audit, throttle, str, engine, publicBase }) {
  const q = sql => db.prepare(sql);
  const J = s => JSON.parse(s || '[]');

  // Every customer route goes through this: the installation must belong to one of the user's workspaces.
  function own(c, id) {
    const u = requireUser(c);
    const i = q(`SELECT i.*, a.slug AS agent_slug, a.name AS agent_name, a.icon AS agent_icon, a.platforms AS agent_platforms
                 FROM installations i JOIN agents a ON a.id = i.agent_id JOIN memberships m ON m.org_id = i.org_id
                 WHERE i.id = ? AND m.user_id = ?`).get(id, u.id);
    if (!i) throw new HttpError(404, 'Агент не найден');
    return { u, i: { ...i, config: JSON.parse(i.config) } };
  }
  function ownConv(c, id) {
    const conv = q('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!conv) throw new HttpError(404, 'Диалог не найден');
    return { ...own(c, conv.installation_id), conv };
  }
  const connOut = x => ({ channel: x.channel, name: x.display_name, mode: x.mode, lastError: x.last_error, connectedAt: x.created_at, tokenExpiresAt: x.token_expires_at || null });
  const summary = i => ({
    id: i.id, name: i.name, autoReply: !!i.auto_reply, createdAt: i.created_at,
    agent: { name: i.agent_name, slug: i.agent_slug, icon: i.agent_icon, platforms: J(i.agent_platforms) },
    connections: q('SELECT * FROM channel_connections WHERE installation_id = ?').all(i.id).map(connOut),
    openHandoffs: q("SELECT COUNT(*) AS n FROM conversations WHERE installation_id = ? AND status = 'handoff'").get(i.id).n,
  });
  const day = 24 * 3600e3;

  const routes = {
    'GET /api/installations': async c => {
      const u = requireUser(c);
      const rows = q(`SELECT i.*, a.slug AS agent_slug, a.name AS agent_name, a.icon AS agent_icon, a.platforms AS agent_platforms
                      FROM installations i JOIN agents a ON a.id = i.agent_id JOIN memberships m ON m.org_id = i.org_id
                      WHERE m.user_id = ? ORDER BY i.created_at`).all(u.id);
      return { installations: rows.map(summary) };
    },
    'POST /api/installations': async c => {
      const u = requireUser(c);
      const o = typeof c.body.orderId === 'string' && q(`SELECT o.*, a.name AS agent_name FROM orders o JOIN agents a ON a.id = o.agent_id
                                 JOIN memberships m ON m.org_id = o.org_id WHERE o.id = ? AND m.user_id = ?`).get(c.body.orderId, u.id);
      if (!o) throw new HttpError(404, 'Заказ не найден');
      if (o.status !== 'PAID') throw new HttpError(402, 'Этот заказ ещё не оплачен');
      const existing = q('SELECT id FROM installations WHERE order_id = ?').get(o.id);
      if (existing) return { id: existing.id };
      const org = q('SELECT name FROM organizations WHERE id = ?').get(o.org_id);
      const id = crypto.randomUUID();
      const code = crypto.randomBytes(5).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, 'X').slice(0, 6);
      q('INSERT INTO installations (id, org_id, agent_id, order_id, name, config, manager_code) VALUES (?,?,?,?,?,?,?)')
        .run(id, o.org_id, o.agent_id, o.id, o.agent_name, JSON.stringify(defaultConfig(org.name)), code);
      audit(u.id, 'installation.created', id, { orderId: o.id });
      c.status = 201;
      return { id };
    },

    // Telegram calls this. Authenticated by the secret we gave Telegram in setWebhook.
    // (Matched in paramRoutes below.)
  };

  const P = (re, fn) => [re, fn];
  const ID = '([\\w-]+)';
  const paramRoutes = [
    P(new RegExp(`^POST /api/webhooks/telegram/${ID}$`), async (c, [connId]) => {
      const conn = engine.verifyWebhook(connId, c.req.headers['x-telegram-bot-api-secret-token']);
      if (!conn) throw new HttpError(403, 'Доступ запрещён');
      await engine.handleTelegramUpdate(conn, c.body);
      return { ok: true };
    }),

    P(new RegExp(`^GET /api/installations/${ID}$`), async (c, [id]) => {
      const { i } = own(c, id);
      return {
        installation: { ...summary(i), config: i.config, managerCode: i.manager_code, managerConnected: !!i.manager_chat_id },
        options: {
          languages: LANGUAGES, tones: TONES, aiMode: engine.llmMode, aiEnabled: engine.aiEnabled, webhooks: engine.useWebhooks, instagramReady: engine.instagramReady,
          channels: J(i.agent_platforms).filter(p => RUNTIME_CHANNELS.includes(p)),
        },
      };
    }),
    P(new RegExp(`^POST /api/installations/${ID}/config$`), async (c, [id]) => {
      const { u } = own(c, id);
      const config = validateConfig(c.body.config, HttpError);
      q('UPDATE installations SET config = ? WHERE id = ?').run(JSON.stringify(config), id);
      audit(u.id, 'installation.configured', id);
      return { config };
    }),
    P(new RegExp(`^POST /api/installations/${ID}/auto-reply$`), async (c, [id]) => {
      const { u, i } = own(c, id);
      const on = c.body.enabled === true;
      if (on && !q('SELECT 1 FROM channel_connections WHERE installation_id = ?').get(id)) throw new HttpError(400, 'Сначала подключите канал');
      q('UPDATE installations SET auto_reply = ? WHERE id = ?').run(on ? 1 : 0, id);
      audit(u.id, on ? 'installation.auto_reply_on' : 'installation.auto_reply_off', i.id);
      return { autoReply: on };
    }),
    P(new RegExp(`^POST /api/installations/${ID}/telegram$`), async (c, [id]) => {
      const { u, i } = own(c, id);
      if (!J(i.agent_platforms).includes('TELEGRAM')) throw new HttpError(400, 'Этот агент не работает в Telegram');
      throttle(`tg-connect:${u.id}`, 10, 3600e3);
      const token = typeof c.body.token === 'string' ? c.body.token.trim() : '';
      if (!TOKEN_RE.test(token)) throw new HttpError(400, 'Это не похоже на токен бота. Он выглядит как 123456789:AAH... и выдаётся в @BotFather.');
      try {
        const r = await engine.connectTelegram(id, token);
        audit(u.id, 'channel.connected', id, { channel: 'TELEGRAM', bot: r.username });
        return { connected: true, username: r.username, mode: r.mode };
      } catch (e) {
        throw new HttpError(e.status || 502, e.status ? e.message : `Couldn't reach Telegram: ${e.message}`);
      }
    }),
    P(new RegExp(`^POST /api/installations/${ID}/telegram/disconnect$`), async (c, [id]) => {
      const { u } = own(c, id);
      await engine.disconnectTelegram(id);
      q('UPDATE installations SET auto_reply = 0 WHERE id = ?').run(id);
      audit(u.id, 'channel.disconnected', id, { channel: 'TELEGRAM' });
      return { ok: true };
    }),
    P(new RegExp(`^POST /api/installations/${ID}/test$`), async (c, [id]) => {
      const { u } = own(c, id);
      throttle(`test:${u.id}`, 60, 3600e3);
      const text = str(c.body.text, 'Сообщение', 1, 2000);
      const history = Array.isArray(c.body.history) ? c.body.history.slice(-12).filter(m => ['customer', 'agent'].includes(m?.author) && typeof m.text === 'string').map(m => ({ author: m.author, text: m.text.slice(0, 2000) })) : [];
      try {
        const r = await engine.testChat(id, history, text);
        return { reply: r.reply, actions: r.actions, mode: r.mode };
      } catch (e) { throw new HttpError(502, e.message); }
    }),


    // ---------- Instagram ----------
    P(new RegExp(`^GET /api/installations/${ID}/instagram/connect$`), async (c, [id]) => {
      const { u, i } = own(c, id);
      if (!J(i.agent_platforms).includes('INSTAGRAM')) throw new HttpError(400, 'Этот агент не работает в Instagram');
      if (!engine.instagramReady) throw new HttpError(503, 'Instagram пока не включён на этой платформе');
      throttle(`ig-connect:${u.id}`, 20, 3600e3);
      return { url: engine.instagramAuthUrl(id, u.id) };
    }),
    P(/^GET \/api\/oauth\/instagram\/callback$/, async c => {
      const p = c.url.searchParams;
      if (!c.user) { c.redirect = '/login.html?next=dashboard.html'; return {}; }
      try {
        const r = await engine.finishInstagramLogin(c.user.id, p.get('state'), p.get('error') ? null : p.get('code'));
        audit(c.user.id, 'channel.connected', r.installationId, { channel: 'INSTAGRAM', account: r.username });
        c.redirect = `/setup.html?id=${encodeURIComponent(r.installationId)}&ig=connected#connect`;
      } catch (e) {
        c.redirect = e.installationId ? `/setup.html?id=${encodeURIComponent(e.installationId)}&ig=error&msg=${encodeURIComponent(e.message)}#connect` : `/dashboard.html`;
      }
      return {};
    }),
    P(new RegExp(`^POST /api/installations/${ID}/instagram/disconnect$`), async (c, [id]) => {
      const { u } = own(c, id);
      engine.disconnectInstagram(id);
      if (!q('SELECT 1 FROM channel_connections WHERE installation_id = ?').get(id)) q('UPDATE installations SET auto_reply = 0 WHERE id = ?').run(id);
      audit(u.id, 'channel.disconnected', id, { channel: 'INSTAGRAM' });
      return { ok: true };
    }),
    // Meta checks the webhook once when you add it in the App Dashboard.
    P(/^GET \/api\/webhooks\/instagram$/, async c => {
      const p = c.url.searchParams, want = engine.instagramVerifyToken || '';
      const got = p.get('hub.verify_token') || '';
      const same = want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
      if (p.get('hub.mode') !== 'subscribe' || !same) throw new HttpError(403, 'Доступ запрещён');
      c.text = p.get('hub.challenge') || '';
      return {};
    }),
    P(/^POST \/api\/webhooks\/instagram$/, async c => {
      if (!engine.instagram.configured || !engine.instagram.verifySignature(c.rawBody, c.req.headers['x-hub-signature-256'])) throw new HttpError(403, 'Неверная подпись');
      await engine.handleInstagramWebhook(c.body);
      return { ok: true };
    }),
    P(/^POST \/api\/oauth\/instagram\/deauthorize$/, async c => {
      const data = engine.instagram.configured && engine.instagram.parseSignedRequest(c.body.signed_request);
      if (!data?.user_id) throw new HttpError(400, 'Некорректный signed_request');
      const r = engine.instagramUserRemoved(data.user_id, false);
      audit(null, 'instagram.deauthorized', String(data.user_id), r);
      return { ok: true };
    }),
    P(/^POST \/api\/oauth\/instagram\/data-deletion$/, async c => {
      const data = engine.instagram.configured && engine.instagram.parseSignedRequest(c.body.signed_request);
      if (!data?.user_id) throw new HttpError(400, 'Некорректный signed_request');
      const r = engine.instagramUserRemoved(data.user_id, true);
      const code = crypto.randomBytes(8).toString('hex').toUpperCase();
      q('INSERT INTO deletion_requests (code, external_user_id) VALUES (?,?)').run(code, String(data.user_id));
      audit(null, 'instagram.data_deleted', String(data.user_id), r);
      return { url: `${publicBase}/deletion.html?code=${code}`, confirmation_code: code };
    }),
    P(/^GET \/api\/deletion\/([A-F0-9]{16})$/, async (c, [code]) => {
      const r = q('SELECT created_at FROM deletion_requests WHERE code = ?').get(code);
      if (!r) throw new HttpError(404, 'Неизвестный код подтверждения');
      return { status: 'completed', requestedAt: r.created_at };
    }),

    // knowledge
    P(new RegExp(`^GET /api/installations/${ID}/knowledge$`), async (c, [id]) => {
      own(c, id);
      return { items: q('SELECT id, kind, title, content, created_at AS createdAt FROM knowledge WHERE installation_id = ? ORDER BY kind DESC, created_at').all(id) };
    }),
    P(new RegExp(`^POST /api/installations/${ID}/knowledge$`), async (c, [id]) => {
      const { u } = own(c, id);
      const kind = c.body.kind;
      if (!['FAQ', 'DOC'].includes(kind)) throw new HttpError(400, 'Тип должен быть FAQ или DOC');
      if (q('SELECT COUNT(*) AS n FROM knowledge WHERE installation_id = ?').get(id).n >= 500) throw new HttpError(400, 'Достигнут лимит базы знаний (500 записей)');
      const title = str(c.body.title, kind === 'FAQ' ? 'Question' : 'Название', 2, 300);
      const content = str(c.body.content, kind === 'FAQ' ? 'Answer' : 'Text', 2, kind === 'FAQ' ? 2000 : 50000);
      const kid = engine.addKnowledge(id, kind, title, content);
      audit(u.id, 'knowledge.added', id, { kind });
      c.status = 201;
      return { id: kid };
    }),
    P(new RegExp(`^POST /api/knowledge/${ID}/delete$`), async (c, [kid]) => {
      const k = q('SELECT * FROM knowledge WHERE id = ?').get(kid);
      if (!k) throw new HttpError(404, 'Не найдено');
      own(c, k.installation_id);
      q('DELETE FROM knowledge WHERE id = ?').run(kid);
      return { ok: true };
    }),

    // conversations
    P(new RegExp(`^GET /api/installations/${ID}/conversations$`), async (c, [id]) => {
      own(c, id);
      const rows = q(`SELECT cv.*, (SELECT text FROM messages WHERE conversation_id = cv.id ORDER BY created_at DESC, rowid DESC LIMIT 1) AS last_text,
                      (SELECT COUNT(*) FROM messages WHERE conversation_id = cv.id) AS n
                      FROM conversations cv WHERE installation_id = ? ORDER BY (status = 'handoff') DESC, last_message_at DESC LIMIT 200`).all(id);
      return { conversations: rows.map(r => ({ id: r.id, channel: r.channel, name: r.contact_name, handle: r.contact_handle, status: r.status,
        handoffReason: r.handoff_reason, lastText: r.last_text, lastMessageAt: r.last_message_at, messages: r.n })) };
    }),
    P(new RegExp(`^GET /api/conversations/${ID}$`), async (c, [id]) => {
      const { conv } = ownConv(c, id);
      return {
        conversation: { id: conv.id, name: conv.contact_name, handle: conv.contact_handle, status: conv.status, handoffReason: conv.handoff_reason, channel: conv.channel },
        messages: q('SELECT direction, author, text, created_at AS createdAt FROM messages WHERE conversation_id = ? ORDER BY created_at, rowid').all(id),
      };
    }),
    P(new RegExp(`^POST /api/conversations/${ID}/reply$`), async (c, [id]) => {
      const { u, conv } = ownConv(c, id);
      const text = str(c.body.text, 'Сообщение', 1, 4000);
      try { await engine.sendHuman(conv, text); } catch (e) { throw new HttpError(502, `Not sent: ${e.message}`); }
      audit(u.id, 'conversation.human_reply', id);
      return { ok: true };
    }),
    P(new RegExp(`^POST /api/conversations/${ID}/resolve$`), async (c, [id]) => {
      const { u } = ownConv(c, id);
      q("UPDATE conversations SET status = 'open', handoff_reason = NULL WHERE id = ?").run(id);
      audit(u.id, 'conversation.returned_to_ai', id);
      return { ok: true };
    }),

    P(new RegExp(`^GET /api/installations/${ID}/leads$`), async (c, [id]) => {
      own(c, id);
      return { leads: q(`SELECT l.id, l.name, l.phone, l.email, l.note, l.created_at AS createdAt, l.conversation_id AS conversationId, cv.contact_handle AS handle
                         FROM leads l LEFT JOIN conversations cv ON cv.id = l.conversation_id WHERE l.installation_id = ? ORDER BY l.created_at DESC LIMIT 500`).all(id) };
    }),
    P(new RegExp(`^GET /api/installations/${ID}/stats$`), async (c, [id]) => {
      own(c, id);
      const since = new Date(Date.now() - 6 * day); since.setUTCHours(0, 0, 0, 0);
      const rows = q(`SELECT substr(created_at, 1, 10) AS d, kind, SUM(quantity) AS n FROM usage_records WHERE installation_id = ? AND created_at >= ? GROUP BY d, kind`).all(id, since.toISOString());
      const days = Array.from({ length: 7 }, (_, k) => new Date(since.getTime() + k * day).toISOString().slice(0, 10));
      const series = kind => days.map(d => rows.find(r => r.d === d && r.kind === kind)?.n || 0);
      const total = kind => q('SELECT COALESCE(SUM(quantity), 0) AS n FROM usage_records WHERE installation_id = ? AND kind = ?').get(id, kind).n;
      return {
        days, incoming: series('message_in'), replies: series('message_out'),
        totals: { incoming: total('message_in'), replies: total('message_out'), leads: total('lead'), handoffs: total('handoff'), tokens: total('tokens_in') + total('tokens_out'),
          conversations: q('SELECT COUNT(*) AS n FROM conversations WHERE installation_id = ?').get(id).n },
      };
    }),

    // admin monitoring
    P(/^GET \/api\/admin\/runtime$/, async c => {
      requireAdmin(c);
      const since = new Date(Date.now() - day).toISOString();
      return {
        aiMode: engine.llmMode,
        installations: q('SELECT COUNT(*) AS n FROM installations').get().n,
        live: q('SELECT COUNT(*) AS n FROM installations WHERE auto_reply = 1').get().n,
        messages24h: q("SELECT COALESCE(SUM(quantity), 0) AS n FROM usage_records WHERE kind IN ('message_in', 'message_out') AND created_at >= ?").get(since).n,
        tokens24h: q("SELECT COALESCE(SUM(quantity), 0) AS n FROM usage_records WHERE kind IN ('tokens_in', 'tokens_out') AND created_at >= ?").get(since).n,
        queued: q("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get().n,
        failedJobs: q("SELECT id, kind, attempts, last_error AS error, updated_at AS at FROM jobs WHERE status = 'failed' ORDER BY updated_at DESC LIMIT 20").all(),
        channelErrors: q("SELECT display_name AS bot, last_error AS error FROM channel_connections WHERE last_error IS NOT NULL").all(),
      };
    }),
  ];
  return { routes, paramRoutes };
}
