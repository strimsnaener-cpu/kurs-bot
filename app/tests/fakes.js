// Stand-ins for api.telegram.org and api.openai.com, speaking the same HTTP/JSON as the real services.
import http from 'node:http';

export async function startFakes() {
  const bots = new Map();          // token -> { id, username }
  const updates = new Map();       // token -> [update]
  const blocked = new Set();       // chat ids that "blocked the bot"
  const calls = [];                // { token, method, body }
  const aiRequests = [];
  // Instagram
  const igCodes = new Map();       // code -> { igId, username, permissions }
  const igTokens = new Map();      // token -> { igId, username }
  const igProfiles = new Map();    // igsid -> { name, username }
  const igSent = [];               // { token, recipient, text, mid }
  const igCalls = [];
  const IG_SECRET = 'ig-app-secret';
  const igConsent = { code: null, deny: false, redirectTo: null };
  let aiScript = body => ({ content: `AI reply to: ${body.messages.at(-1).content}` });

  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch { /* form-encoded (OAuth) */ }
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

    if (req.url === '/v1/chat/completions') {
      if (req.headers.authorization !== 'Bearer test-key') return send(401, { error: { message: 'bad key' } });
      aiRequests.push(body);
      let m;
      try { m = aiScript(body, aiRequests.length); } catch (e) { return send(500, { error: { message: e.message } }); }
      const message = { role: 'assistant', content: m.content ?? null, ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t, i) => ({ id: `call_${i}`, type: 'function', function: { name: t.name, arguments: JSON.stringify(t.args) } })) } : {}) };
      return send(200, { choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    }

    // ---- Instagram (api.instagram.com + graph.instagram.com) ----
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/oauth/authorize') {          // Instagram's consent page: approve or cancel, then redirect back
      const st = u.searchParams.get('state'), target = igConsent.redirectTo || u.searchParams.get('redirect_uri');
      const qs = igConsent.deny ? `error=access_denied&error_reason=user_denied&state=${st}` : `code=${igConsent.code}&state=${st}`;
      res.writeHead(302, { Location: `${target}?${qs}` }); return res.end();
    }
    if (u.pathname === '/oauth/access_token') {
      const f = Object.fromEntries(new URLSearchParams(raw));
      igCalls.push({ path: u.pathname, body: f });
      const acc = igCodes.get(f.code);
      if (!acc || f.client_secret !== IG_SECRET || f.grant_type !== 'authorization_code') return send(400, { error_type: 'OAuthException', code: 400, error_message: 'Matching code was not found or was already used' });
      igCodes.delete(f.code);
      const short = `short-${acc.igId}-${Date.now()}`; igTokens.set(short, acc);
      return send(200, { data: [{ access_token: short, user_id: Number(acc.igId) + 1, permissions: acc.permissions }] });
    }
    if (u.pathname === '/access_token' || u.pathname === '/refresh_access_token') {
      const t = u.searchParams.get('access_token'); const acc = igTokens.get(t);
      igCalls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams) });
      if (!acc || (u.pathname === '/access_token' && u.searchParams.get('client_secret') !== IG_SECRET)) return send(400, { error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } });
      const long = `long-${acc.igId}-${Math.random().toString(36).slice(2, 8)}`; igTokens.set(long, acc);
      return send(200, { access_token: long, token_type: 'bearer', expires_in: 5184000 });
    }
    const g = u.pathname.match(/^\/v[\d.]+\/(.+)$/);
    if (g) {
      const token = (req.headers.authorization || '').replace(/^Bearer /, ''), acc = igTokens.get(token);
      igCalls.push({ path: u.pathname, token, body });
      if (!acc) return send(400, { error: { message: 'Invalid OAuth access token', type: 'OAuthException', code: 190 } });
      if (g[1] === 'me') return send(200, { id: `app-scoped-${acc.igId}`, user_id: acc.igId, username: acc.username });
      if (g[1] === 'me/subscribed_apps') return send(200, { success: true });
      if (g[1] === 'me/messages') {
        if (Buffer.byteLength(body.message?.text || '') > 1000) return send(400, { error: { message: 'Message text too long', code: 100 } });
        if (body.recipient?.id === 'blocked') return send(400, { error: { message: 'This person isn\'t available right now', code: 551 } });
        const mid = `mid.${igSent.length + 1}`; igSent.push({ token, recipient: body.recipient.id, text: body.message.text, mid });
        return send(200, { recipient_id: body.recipient.id, message_id: mid });
      }
      const prof = igProfiles.get(g[1]);
      return prof ? send(200, { id: g[1], ...prof }) : send(400, { error: { message: 'Unsupported get request', code: 100 } });
    }

    const m = req.url.match(/^\/bot([^/]+)\/(\w+)$/);
    if (!m) return send(404, { ok: false, error_code: 404, description: 'Not Found' });
    const [, token, method] = m;
    calls.push({ token, method, body });
    const bot = bots.get(token);
    if (!bot) return send(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    switch (method) {
      case 'getMe': return send(200, { ok: true, result: { id: bot.id, is_bot: true, first_name: bot.username, username: bot.username } });
      case 'setWebhook': case 'deleteWebhook': return send(200, { ok: true, result: true });
      case 'getUpdates': {
        const list = (updates.get(token) || []).filter(u => u.update_id >= (body.offset || 0));
        return send(200, { ok: true, result: list });
      }
      case 'sendMessage':
        if (blocked.has(String(body.chat_id))) return send(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
        return send(200, { ok: true, result: { message_id: calls.length } });
      default: return send(400, { ok: false, error_code: 400, description: 'unknown method' });
    }
  });
  await new Promise(r => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  let nextUpdate = 1000, nextMsg = 1;
  return {
    base, calls, aiRequests, blocked, igSent, igCalls, igTokens, IG_SECRET, igConsent,
    igAccount(code, igId, username, permissions = 'instagram_business_basic,instagram_business_manage_messages') { igCodes.set(code, { igId: String(igId), username, permissions }); },
    igProfile(igsid, name, username) { igProfiles.set(igsid, { name, username }); },
    // A Meta webhook body for a DM (or an echo of one the business sent).
    igEvent(accountId, from, to, text, { mid = `m_${Math.random().toString(36).slice(2)}`, echo = false } = {}) {
      return { object: 'instagram', entry: [{ id: String(accountId), time: Date.now(), messaging: [{ sender: { id: String(from) }, recipient: { id: String(to) }, timestamp: Date.now(), message: { mid, text, ...(echo ? { is_echo: true } : {}) } }] }] };
    },
    setAi(fn) { aiScript = fn; },
    addBot(token, id, username) { bots.set(token, { id, username }); },
    // Builds a Telegram "message" update like the real API sends.
    update(text, { chatId = 5550001, first = 'Ivan', last = 'Petrenko', username = 'ivanp', type = 'private' } = {}) {
      return { update_id: nextUpdate++, message: { message_id: nextMsg++, date: Math.floor(Date.now() / 1000), text,
        chat: { id: chatId, type }, from: { id: chatId, is_bot: false, first_name: first, last_name: last, username } } };
    },
    queueUpdate(token, u) { if (!updates.has(token)) updates.set(token, []); updates.get(token).push(u); },
    sent(token) { return calls.filter(c => c.token === token && c.method === 'sendMessage').map(c => ({ chat: String(c.body.chat_id), text: c.body.text })); },
    close: () => server.close(),
  };
}
