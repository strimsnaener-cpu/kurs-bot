// Telegram Bot API adapter (official HTTP API, bot token from @BotFather; no personal account access).
import { PermanentError } from '../runtime/queue.js';

export const TOKEN_RE = /^\d{5,15}:[A-Za-z0-9_-]{30,60}$/;

export function telegram({ apiBase = 'https://api.telegram.org', fetchImpl = fetch } = {}) {
  async function call(token, method, body = {}, timeoutMs = 15_000) {
    let res;
    try {
      res = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) { throw new Error(`Telegram недоступен: ${e.message}`); }
    const j = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!j.ok) {
      const msg = `Telegram ${method}: ${j.description || 'error'}`;
      // 400/401/403/404 won't succeed on retry (bad token, bot blocked, chat gone). 429/5xx will.
      throw [400, 401, 403, 404].includes(j.error_code) ? new PermanentError(msg) : new Error(msg);
    }
    return j.result;
  }
  return {
    getMe: token => call(token, 'getMe'),
    setWebhook: (token, url, secret) => call(token, 'setWebhook', { url, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true }),
    deleteWebhook: token => call(token, 'deleteWebhook', { drop_pending_updates: false }),
    getUpdates: (token, offset, timeout = 25) => call(token, 'getUpdates', { offset, timeout, allowed_updates: ['message'] }, (timeout + 10) * 1000),
    async send(token, chatId, text) {
      for (let i = 0; i < text.length; i += 4000) await call(token, 'sendMessage', { chat_id: chatId, text: text.slice(i, i + 4000) });
    },
    // Private text messages only; groups, stickers, photos etc. are ignored for now.
    parse(update) {
      const m = update?.message;
      if (!m || typeof m.text !== 'string' || m.chat?.type !== 'private') return null;
      return {
        chatId: String(m.chat.id), messageId: String(m.message_id), text: m.text.slice(0, 4000),
        name: [m.from?.first_name, m.from?.last_name].filter(Boolean).join(' ') || null,
        handle: m.from?.username ? `@${m.from.username}` : null,
      };
    },
  };
}
