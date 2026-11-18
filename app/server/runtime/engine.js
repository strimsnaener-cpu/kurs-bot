// The agent runtime: inbound messages → queue → brain → channel reply, plus handoff, leads, usage,
// Telegram polling, Instagram login and token refresh.
import crypto from 'node:crypto';
import { createQueue, PermanentError } from './queue.js';
import { makeLLM } from './llm.js';
import { pluginFor } from './agents.js';
import { think } from './brain.js';
import { terms, chunk } from './knowledge.js';
import { telegram } from '../channels/telegram.js';
import { instagram } from '../channels/instagram.js';

const HISTORY = 12;
const IG_WINDOW_MS = 24 * 3600e3;          // Meta: replies only within 24 h of the customer's last message
const DAY = 24 * 3600e3;

export function createEngine({ db, cipher, env = {}, fetchImpl = fetch, log = console, sendMail = () => {}, baseUrl = '' }) {
  const q = sql => db.prepare(sql);
  const now = () => new Date().toISOString();
  const tg = telegram({ apiBase: env.TELEGRAM_API_BASE || 'https://api.telegram.org', fetchImpl });
  const ig = instagram({
    appId: env.INSTAGRAM_APP_ID, appSecret: env.INSTAGRAM_APP_SECRET, fetchImpl, version: env.INSTAGRAM_GRAPH_VERSION || 'v26.0',
    oauthBase: env.INSTAGRAM_OAUTH_BASE, apiBase: env.INSTAGRAM_API_BASE, graphBase: env.INSTAGRAM_GRAPH_BASE,
  });
  const llm = makeLLM(env, fetchImpl);
  const publicUrl = (env.PUBLIC_URL || '').replace(/\/$/, '');
  const useWebhooks = publicUrl.startsWith('https://');
  const igRedirect = `${publicUrl}/api/oauth/instagram/callback`;
  const instagramReady = ig.configured && useWebhooks && !!env.INSTAGRAM_VERIFY_TOKEN;
  const queue = createQueue(db, { reply: processReply, notify: processNotify, 'ig-echo': processIgEcho }, { log });

  const installation = id => {
    const i = q('SELECT i.*, a.slug AS agent_slug, a.name AS agent_name FROM installations i JOIN agents a ON a.id = i.agent_id WHERE i.id = ?').get(id);
    return i && { ...i, config: JSON.parse(i.config) };
  };
  const tokenOf = conn => cipher.decrypt(conn.credentials_enc);
  const connFor = (instId, channel) => q('SELECT * FROM channel_connections WHERE installation_id = ? AND channel = ?').get(instId, channel);
  const usage = (instId, kind, n) => n && q('INSERT INTO usage_records (id, installation_id, kind, quantity) VALUES (?,?,?,?)').run(crypto.randomUUID(), instId, kind, n);
  const chunksFor = instId => q(`SELECT c.content, c.terms, k.kind, k.content AS answer FROM knowledge_chunks c JOIN knowledge k ON k.id = c.knowledge_id
                                 WHERE c.installation_id = ?`).all(instId).map(c => ({ ...c, terms: JSON.parse(c.terms) }));

  // ---------- sending (one place for every channel) ----------
  async function deliver(conv, text, author) {
    const conn = connFor(conv.installation_id, conv.channel);
    if (!conn) throw new PermanentError('Этот канал больше не подключён');
    let parts;
    if (conv.channel === 'TELEGRAM') {
      await tg.send(tokenOf(conn), conv.external_chat_id, text);
      parts = [{ id: null, text }];
    } else if (conv.channel === 'INSTAGRAM') {
      const last = q("SELECT created_at FROM messages WHERE conversation_id = ? AND direction = 'IN' ORDER BY created_at DESC LIMIT 1").get(conv.id);
      if (!last || Date.now() - Date.parse(last.created_at) > IG_WINDOW_MS)
        throw new PermanentError('Instagram позволяет отвечать только в течение 24 часов после последнего сообщения клиента');
      parts = await ig.send(tokenOf(conn), conv.external_chat_id, text);
    } else throw new PermanentError(`Unknown channel ${conv.channel}`);
    // Each part is stored with Instagram's message id, so the echo Meta sends back is recognised as ours.
    for (const p of parts) q("INSERT INTO messages (id, conversation_id, direction, author, text, external_id) VALUES (?,?,'OUT',?,?,?) ON CONFLICT (conversation_id, external_id) DO NOTHING")
      .run(crypto.randomUUID(), conv.id, author, p.text, p.id);
    q('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(now(), conv.id);
  }

  // ---------- knowledge ----------
  function addKnowledge(instId, kind, title, content) {
    const id = crypto.randomUUID();
    db.exec('BEGIN');
    try {
      q('INSERT INTO knowledge (id, installation_id, kind, title, content) VALUES (?,?,?,?,?)').run(id, instId, kind, title, content);
      const pieces = kind === 'FAQ' ? [`Q: ${title}\nA: ${content}`] : chunk(`${title}\n\n${content}`);
      for (const p of pieces) q('INSERT INTO knowledge_chunks (id, knowledge_id, installation_id, content, terms) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), id, instId, p, JSON.stringify(terms(p)));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return id;
  }

  // ---------- applying the brain's decisions ----------
  function handoff(inst, conv, reason) {
    if (conv.status === 'handoff') return;
    q("UPDATE conversations SET status = 'handoff', handoff_reason = ? WHERE id = ?").run(reason, conv.id);
    conv.status = 'handoff';
    usage(inst.id, 'handoff', 1);
    queue.enqueue('notify', { installationId: inst.id, conversationId: conv.id, reason });
  }
  function applyActions(inst, conv, actions) {
    for (const a of actions) {
      if (a.type === 'lead') {
        q('INSERT INTO leads (id, installation_id, conversation_id, name, phone, email, note) VALUES (?,?,?,?,?,?,?)')
          .run(crypto.randomUUID(), inst.id, conv.id, a.data.name ?? conv.contact_name ?? null, a.data.phone ?? null, a.data.email ?? null, a.data.note ?? null);
        usage(inst.id, 'lead', 1);
      }
      if (a.type === 'handoff') handoff(inst, conv, a.reason);
    }
  }

  // ---------- inbound: shared ----------
  function storeInbound(inst, channel, chatId, contact, text, externalId) {
    q(`INSERT INTO conversations (id, installation_id, channel, external_chat_id, contact_name, contact_handle) VALUES (?,?,?,?,?,?)
       ON CONFLICT (installation_id, channel, external_chat_id) DO UPDATE SET
         contact_name = COALESCE(excluded.contact_name, contact_name), contact_handle = COALESCE(excluded.contact_handle, contact_handle)`)
      .run(crypto.randomUUID(), inst.id, channel, chatId, contact.name, contact.handle);
    const conv = q('SELECT * FROM conversations WHERE installation_id = ? AND channel = ? AND external_chat_id = ?').get(inst.id, channel, chatId);
    const msgId = crypto.randomUUID();
    const ins = q(`INSERT INTO messages (id, conversation_id, direction, author, text, external_id) VALUES (?,?,'IN','customer',?,?)
                   ON CONFLICT (conversation_id, external_id) DO NOTHING`).run(msgId, conv.id, text, externalId);
    if (!ins.changes) return 'duplicate';
    q('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(now(), conv.id);
    usage(inst.id, 'message_in', 1);
    queue.enqueue('reply', { messageId: msgId });
    return 'queued';
  }

  // ---------- inbound: Telegram ----------
  async function handleTelegramUpdate(conn, update) {
    const m = tg.parse(update);
    if (!m) return 'ignored';
    const inst = installation(conn.installation_id);
    const token = tokenOf(conn);
    // The owner links a manager chat by sending "/manager CODE" to the bot; handoff alerts go there.
    const pair = m.text.match(/^\/manager(?:@\w+)?\s+(\S+)/i);
    if (pair) {
      const h = v => crypto.createHash('sha256').update(v).digest();
      const ok = crypto.timingSafeEqual(h(pair[1].toUpperCase()), h(inst.manager_code));
      if (ok) q('UPDATE installations SET manager_chat_id = ? WHERE id = ?').run(m.chatId, inst.id);
      await tg.send(token, m.chatId, ok ? '✅ Теперь в этот чат будут приходить уведомления, когда клиенту нужен человек. Отвечайте клиентам из кабинета.' : 'Этот код недействителен.').catch(e => log.error?.(e.message));
      return ok ? 'manager-paired' : 'manager-bad-code';
    }
    if (inst.manager_chat_id && m.chatId === inst.manager_chat_id) return 'manager-message';
    return storeInbound(inst, 'TELEGRAM', m.chatId, { name: m.name, handle: m.handle }, m.text, m.messageId);
  }

  // ---------- inbound: Instagram (webhook) ----------
  async function handleInstagramWebhook(body) {
    const results = [];
    for (const ev of ig.parse(body)) {
      const conn = q("SELECT * FROM channel_connections WHERE channel = 'INSTAGRAM' AND external_id = ?").get(ev.accountId);
      if (!conn) { results.push('unknown-account'); continue; }
      const inst = installation(conn.installation_id);
      const customer = ev.echo ? ev.recipientId : ev.senderId;
      if (customer === conn.external_id) { results.push('self'); continue; }
      if (ev.echo) {
        // A message the business sent. Ours are matched by id; check after a short delay so our own send has been saved.
        queue.enqueue('ig-echo', { installationId: inst.id, customer, mid: ev.mid, text: ev.text }, 5000);
        results.push('echo-queued'); continue;
      }
      const known = q("SELECT contact_name FROM conversations WHERE installation_id = ? AND channel = 'INSTAGRAM' AND external_chat_id = ?").get(inst.id, customer);
      let contact = { name: null, handle: null };
      if (!known?.contact_name) {
        const p = await ig.profile(tokenOf(conn), customer);
        if (p) contact = { name: p.name || null, handle: p.username ? `@${p.username}` : null };
      }
      results.push(storeInbound(inst, 'INSTAGRAM', customer, contact, ev.text, ev.mid));
    }
    return results;
  }
  // The owner answered from the Instagram app: record it, and keep the AI quiet in that chat.
  async function processIgEcho({ installationId, customer, mid, text }) {
    const conv = q("SELECT * FROM conversations WHERE installation_id = ? AND channel = 'INSTAGRAM' AND external_chat_id = ?").get(installationId, customer);
    if (!conv || q('SELECT 1 FROM messages WHERE conversation_id = ? AND external_id = ?').get(conv.id, mid)) return;
    q("INSERT INTO messages (id, conversation_id, direction, author, text, external_id) VALUES (?,?,'OUT','human',?,?)").run(crypto.randomUUID(), conv.id, text, mid);
    if (conv.status !== 'handoff') q("UPDATE conversations SET status = 'handoff', handoff_reason = 'Вы ответили в приложении Instagram' WHERE id = ?").run(conv.id);
  }

  // ---------- reply job ----------
  async function processReply({ messageId }) {
    const msg = q('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg) return;
    const conv = q('SELECT * FROM conversations WHERE id = ?').get(msg.conversation_id);
    const inst = installation(conv.installation_id);
    if (!inst.auto_reply || conv.status === 'handoff') return;     // a person is handling it, or auto-reply is off
    // If the customer sent several messages quickly, answer once, after the latest one.
    const latest = q("SELECT id FROM messages WHERE conversation_id = ? AND direction = 'IN' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(conv.id);
    if (latest.id !== msg.id) return;
    const history = q('SELECT author, text FROM messages WHERE conversation_id = ? AND id != ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(conv.id, msg.id, HISTORY).reverse();
    const result = /^\/start\b/.test(msg.text) && conv.channel === 'TELEGRAM'
      ? { reply: inst.config.greeting, actions: [], usage: { in: 0, out: 0 } }
      : await think({ llm, plugin: pluginFor(inst.agent_slug), config: inst.config, chunks: chunksFor(inst.id), history, text: msg.text });
    await deliver(conv, result.reply, 'agent');
    applyActions(inst, conv, result.actions);
    usage(inst.id, 'message_out', 1); usage(inst.id, 'tokens_in', result.usage.in); usage(inst.id, 'tokens_out', result.usage.out);
  }

  // ---------- handoff alerts: Telegram manager chat if paired, otherwise email to the workspace owners ----------
  async function processNotify({ installationId, conversationId, reason }) {
    const inst = installation(installationId);
    const conv = q('SELECT * FROM conversations WHERE id = ?').get(conversationId);
    if (!inst || !conv) return;
    const last = q("SELECT text FROM messages WHERE conversation_id = ? AND direction = 'IN' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(conv.id);
    const who = [conv.contact_name, conv.contact_handle].filter(Boolean).join(' ') || 'Клиент';
    const where = conv.channel === 'INSTAGRAM' ? 'Instagram' : 'Telegram';
    const text = `${who} в ${where} нужен живой человек (${inst.agent_name}).\nПричина: ${reason}\nПоследнее сообщение: "${(last?.text || '').slice(0, 300)}"`;
    const tgConn = connFor(installationId, 'TELEGRAM');
    if (inst.manager_chat_id && tgConn) { await tg.send(tokenOf(tgConn), inst.manager_chat_id, `🔔 ${text}\n\nОткройте кабинет, чтобы ответить.`); return; }
    for (const o of q("SELECT u.email, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.role = 'OWNER'").all(inst.org_id))
      await sendMail(o.email, `Клиенту нужна ваша помощь: ${who}`, `Здравствуйте, ${o.name}!\n\n${text}\n\nОтветить здесь: ${baseUrl}/setup.html?id=${inst.id}#conversations`);
  }

  // ---------- owner actions ----------
  async function sendHuman(conv, text) {
    try { await deliver(conv, text, 'human'); }
    catch (e) { throw new Error(e.message.replace(/^Instagram: /, '')); }
  }
  // Try the agent from the dashboard. Nothing is sent or saved; actions are only reported back.
  async function testChat(instId, history, text) {
    const inst = installation(instId);
    return think({ llm, plugin: pluginFor(inst.agent_slug), config: inst.config, chunks: chunksFor(inst.id), history, text });
  }

  // ---------- Telegram connect ----------
  async function connectTelegram(instId, token) {
    const me = await tg.getMe(token).catch(e => { throw Object.assign(new Error('Telegram не принял этот токен. Скопируйте его ещё раз из @BotFather.'), { status: 400, cause: e }); });
    if (!me.is_bot) throw Object.assign(new Error('Этот токен не принадлежит боту'), { status: 400 });
    const taken = q("SELECT installation_id FROM channel_connections WHERE channel = 'TELEGRAM' AND external_id = ?").get(String(me.id));
    if (taken && taken.installation_id !== instId) throw Object.assign(new Error('Этот бот уже подключён к другому агенту. Сначала отключите его там.'), { status: 409 });
    if (connFor(instId, 'TELEGRAM')) await disconnectTelegram(instId);
    const id = crypto.randomUUID(), secret = crypto.randomBytes(24).toString('hex');
    if (useWebhooks) await tg.setWebhook(token, `${publicUrl}/api/webhooks/telegram/${id}`, secret);
    else await tg.deleteWebhook(token);       // local/dev: we poll instead, so no public URL is needed
    q('INSERT INTO channel_connections (id, installation_id, channel, external_id, display_name, credentials_enc, webhook_secret, mode) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, instId, 'TELEGRAM', String(me.id), `@${me.username}`, cipher.encrypt(token), secret, useWebhooks ? 'webhook' : 'polling');
    return { id, username: me.username, mode: useWebhooks ? 'webhook' : 'polling' };
  }
  async function disconnectTelegram(instId) {
    const conn = connFor(instId, 'TELEGRAM');
    if (!conn) return false;
    await tg.deleteWebhook(tokenOf(conn)).catch(e => log.error?.(`deleteWebhook: ${e.message}`));
    q('DELETE FROM channel_connections WHERE id = ?').run(conn.id);
    return true;
  }
  function verifyTelegramWebhook(connId, secretHeader) {
    const conn = q("SELECT * FROM channel_connections WHERE id = ? AND channel = 'TELEGRAM'").get(connId);
    if (!conn || typeof secretHeader !== 'string') return null;
    const a = Buffer.from(secretHeader), b = Buffer.from(conn.webhook_secret);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? conn : null;
  }

  // ---------- Instagram connect (OAuth) ----------
  function instagramAuthUrl(instId, userId) {
    const state = crypto.randomBytes(24).toString('base64url');
    q('INSERT INTO oauth_states (hash, installation_id, user_id, expires_at) VALUES (?,?,?,?)').run(crypto.createHash('sha256').update(state).digest('hex'), instId, userId, new Date(Date.now() + 15 * 60e3).toISOString());
    return ig.authorizeUrl(igRedirect, state);
  }
  // Returns { installationId } or throws { status, message, installationId? }.
  async function finishInstagramLogin(userId, state, code) {
    const row = typeof state === 'string' && q('SELECT * FROM oauth_states WHERE hash = ?').get(crypto.createHash('sha256').update(state).digest('hex'));
    if (!row || row.used_at || row.expires_at < now()) throw Object.assign(new Error('Ссылка для входа в Instagram устарела. Попробуйте снова.'), { status: 400, installationId: row?.installation_id });
    if (row.user_id !== userId) throw Object.assign(new Error('Войдите в тот же аккаунт, с которого начали.'), { status: 403 });
    q('UPDATE oauth_states SET used_at = ? WHERE hash = ?').run(now(), row.hash);
    const fail = msg => Object.assign(new Error(msg), { status: 400, installationId: row.installation_id });
    if (!code) throw fail('Вход в Instagram отменён.');
    let t, me;
    try { t = await ig.exchangeCode(code, igRedirect); me = await ig.me(t.token); }
    catch (e) { log.error?.(`instagram login: ${e.message}`); throw fail('Instagram не завершил вход. Убедитесь, что это профессиональный аккаунт (Бизнес или Автор), и попробуйте снова.'); }
    if (!/instagram_business_manage_messages/.test(t.permissions || 'instagram_business_manage_messages')) throw fail('Разрешите доступ к сообщениям, когда Instagram спросит, чтобы агент мог отвечать в Direct.');
    const accountId = String(me.user_id || me.id);
    const taken = q("SELECT installation_id FROM channel_connections WHERE channel = 'INSTAGRAM' AND external_id = ?").get(accountId);
    if (taken && taken.installation_id !== row.installation_id) throw fail(`@${me.username} уже подключён к другому агенту. Сначала отключите его там.`);
    try { await ig.subscribe(t.token); } catch (e) { throw fail(`Не удалось включить уведомления о сообщениях для @${me.username}: ${e.message}`); }
    q("DELETE FROM channel_connections WHERE installation_id = ? AND channel = 'INSTAGRAM'").run(row.installation_id);
    q(`INSERT INTO channel_connections (id, installation_id, channel, external_id, display_name, credentials_enc, webhook_secret, mode, token_expires_at, token_refreshed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(), row.installation_id, 'INSTAGRAM', accountId, `@${me.username}`, cipher.encrypt(t.token), '-', 'webhook', t.expiresAt, now());
    return { installationId: row.installation_id, username: me.username };
  }
  function disconnectInstagram(instId) { return q("DELETE FROM channel_connections WHERE installation_id = ? AND channel = 'INSTAGRAM'").run(instId).changes > 0; }

  // Long-lived tokens last 60 days; refresh any that are at least a day old and expire within 20 days.
  async function refreshInstagramTokens() {
    const due = q(`SELECT * FROM channel_connections WHERE channel = 'INSTAGRAM' AND token_expires_at < ? AND COALESCE(token_refreshed_at, created_at) < ?`)
      .all(new Date(Date.now() + 20 * DAY).toISOString(), new Date(Date.now() - DAY).toISOString());
    for (const c of due) {
      try {
        const t = await ig.refresh(tokenOf(c));
        q('UPDATE channel_connections SET credentials_enc = ?, token_expires_at = ?, token_refreshed_at = ?, last_error = NULL WHERE id = ?').run(cipher.encrypt(t.token), t.expiresAt, now(), c.id);
      } catch (e) {
        q('UPDATE channel_connections SET last_error = ? WHERE id = ?').run(`Не удалось продлить вход (${e.message}). Переподключите Instagram до ${c.token_expires_at.slice(0, 10)}.`, c.id);
      }
    }
    return due.length;
  }

  // Meta callbacks: the person removed our app (deauthorize) or asked for their data to be deleted.
  function instagramUserRemoved(igUserId, deleteData) {
    const conns = q("SELECT * FROM channel_connections WHERE channel = 'INSTAGRAM' AND external_id = ?").all(String(igUserId));
    for (const c of conns) { q('DELETE FROM channel_connections WHERE id = ?').run(c.id); q('UPDATE installations SET auto_reply = 0 WHERE id = ?').run(c.installation_id); }
    let deleted = 0;
    if (deleteData) {
      // As a business account: its customer conversations. As a customer: their chats with any business.
      for (const c of conns) deleted += q("DELETE FROM conversations WHERE installation_id = ? AND channel = 'INSTAGRAM'").run(c.installation_id).changes;
      deleted += q("DELETE FROM conversations WHERE channel = 'INSTAGRAM' AND external_chat_id = ?").run(String(igUserId)).changes;
    }
    return { connections: conns.length, conversations: deleted };
  }

  // ---------- Telegram long polling (used when there is no public HTTPS URL, e.g. on your PC) ----------
  const inFlight = new Set();
  async function pollOnce(conn, timeout = 25) {
    try {
      const updates = await tg.getUpdates(tokenOf(conn), conn.poll_offset, timeout);
      for (const u of updates) {
        await handleTelegramUpdate(conn, u).catch(e => log.error?.(`update ${u.update_id}: ${e.message}`));
        q('UPDATE channel_connections SET poll_offset = ?, last_error = NULL WHERE id = ?').run(u.update_id + 1, conn.id);
        conn.poll_offset = u.update_id + 1;
      }
      return updates.length;
    } catch (e) {
      q('UPDATE channel_connections SET last_error = ? WHERE id = ?').run(e.message.slice(0, 300), conn.id);
      throw e;
    }
  }
  let running = false;
  function startBackground() {
    running = true;
    const tick = () => {
      if (!running) return;
      for (const conn of q("SELECT * FROM channel_connections WHERE channel = 'TELEGRAM' AND mode = 'polling'").all()) {
        if (inFlight.has(conn.id)) continue;
        inFlight.add(conn.id);
        pollOnce(conn).catch(() => new Promise(r => setTimeout(r, 5000))).finally(() => inFlight.delete(conn.id));
      }
      setTimeout(tick, 1000);
    };
    tick();
    const refresh = () => { if (running) refreshInstagramTokens().catch(e => log.error?.(e.message)).finally(() => setTimeout(refresh, 6 * 3600e3)); };
    refresh();
  }

  return {
    queue, llmMode: llm ? `AI (${llm.model})` : 'Только FAQ', aiEnabled: !!llm, useWebhooks, instagramReady,
    instagramVerifyToken: env.INSTAGRAM_VERIFY_TOKEN, instagram: ig,
    addKnowledge, handleTelegramUpdate, verifyWebhook: verifyTelegramWebhook, connectTelegram, disconnectTelegram,
    handleInstagramWebhook, instagramAuthUrl, finishInstagramLogin, disconnectInstagram, refreshInstagramTokens, instagramUserRemoved,
    sendHuman, testChat, pollOnce,
    start() { queue.start(); startBackground(); },
    stop() { queue.stop(); running = false; },
  };
}
