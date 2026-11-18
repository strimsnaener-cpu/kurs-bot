// Instagram API with Instagram Login (Business Login for Instagram). Official Meta endpoints only:
//   www.instagram.com/oauth/authorize       → user approves, we get a code
//   api.instagram.com/oauth/access_token    → code → short-lived token
//   graph.instagram.com/access_token        → long-lived token (60 days), /refresh_access_token to extend
//   graph.instagram.com/<ver>/me/messages   → send; webhooks deliver incoming DMs (signed with the app secret)
// The customer's Instagram password never touches this platform.
import crypto from 'node:crypto';
import { PermanentError } from '../runtime/queue.js';

export const MAX_BYTES = 1000;                 // Meta's limit per text message
const RETRYABLE_CODES = [1, 2, 4, 17, 32, 613]; // temporary / rate-limit errors

// Split on whitespace where possible, never exceeding the byte limit (Cyrillic is 2 bytes per letter).
export function splitBytes(text, max = MAX_BYTES) {
  const parts = []; let rest = text.trim();
  while (Buffer.byteLength(rest) > max) {
    let cut = 0, bytes = 0;
    for (const ch of rest) { const b = Buffer.byteLength(ch); if (bytes + b > max) break; bytes += b; cut += ch.length; }
    const space = rest.lastIndexOf(' ', cut);
    const at = space > cut * 0.6 ? space : cut;
    parts.push(rest.slice(0, at).trim()); rest = rest.slice(at).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export function instagram({ appId, appSecret, oauthBase = 'https://www.instagram.com', apiBase = 'https://api.instagram.com',
  graphBase = 'https://graph.instagram.com', version = 'v26.0', fetchImpl = fetch } = {}) {

  async function req(url, init = {}) {
    let res;
    try { res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) }); }
    catch (e) { throw new Error(`Instagram недоступен: ${e.message}`); }
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.error || j.error_type) {
      const err = typeof j.error === 'object' ? j.error : {};
      const msg = `Instagram: ${err.message || j.error_message || `HTTP ${res.status}`}`;
      const temporary = res.status >= 500 || res.status === 429 || RETRYABLE_CODES.includes(err.code);
      throw Object.assign(temporary ? new Error(msg) : new PermanentError(msg), { code: err.code });
    }
    return j;
  }
  const graph = (path, token, init = {}) => req(`${graphBase}/${version}${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const expiry = s => new Date(Date.now() + (Number(s) || 60 * 86400) * 1000).toISOString();

  return {
    configured: !!(appId && appSecret),

    authorizeUrl(redirectUri, state) {
      const p = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, response_type: 'code', state,
        scope: 'instagram_business_basic,instagram_business_manage_messages' });
      return `${oauthBase}/oauth/authorize?${p}`;
    },

    async exchangeCode(code, redirectUri) {
      const body = new URLSearchParams({ client_id: appId, client_secret: appSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code });
      const j = await req(`${apiBase}/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
      const d = Array.isArray(j.data) ? j.data[0] : j;           // Meta has returned both shapes
      const permissions = Array.isArray(d.permissions) ? d.permissions.join(',') : String(d.permissions || '');
      const long = await req(`${graphBase}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: appSecret, access_token: d.access_token })}`);
      return { token: long.access_token, expiresAt: expiry(long.expires_in), permissions };
    },

    async refresh(token) {
      const j = await req(`${graphBase}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })}`);
      return { token: j.access_token, expiresAt: expiry(j.expires_in) };
    },

    me: token => graph('/me?fields=user_id,username', token),
    subscribe: token => graph('/me/subscribed_apps?subscribed_fields=messages', token, { method: 'POST' }),
    profile: (token, igsid) => graph(`/${encodeURIComponent(igsid)}?fields=name,username`, token).catch(() => null),

    // Returns one Instagram message id per part sent.
    async send(token, recipientId, text) {
      const ids = [];
      for (const part of splitBytes(text)) {
        const j = await graph('/me/messages', token, { method: 'POST', body: JSON.stringify({ recipient: { id: recipientId }, message: { text: part } }) });
        ids.push({ id: j.message_id, text: part });
      }
      return ids;
    },

    verifySignature(raw, header) {
      if (typeof header !== 'string' || !header.startsWith('sha256=') || !raw) return false;
      const a = Buffer.from(header.slice(7)), b = Buffer.from(crypto.createHmac('sha256', appSecret).update(raw).digest('hex'));
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },

    // Meta's deauthorize / data-deletion callbacks send signed_request = base64url(sig).base64url(payload).
    parseSignedRequest(sr) {
      const [sig, payload] = String(sr || '').split('.');
      if (!sig || !payload) return null;
      const want = crypto.createHmac('sha256', appSecret).update(payload).digest(), got = Buffer.from(sig, 'base64url');
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
      try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
    },

    // Text DMs only (photos, reels shares, reactions are ignored for now).
    parse(body) {
      if (body?.object !== 'instagram' || !Array.isArray(body.entry)) return [];
      const out = [];
      for (const e of body.entry) for (const m of e.messaging || []) {
        const msg = m.message;
        if (!msg || typeof msg.text !== 'string' || msg.is_deleted || msg.is_unsupported) continue;
        out.push({ accountId: String(e.id), senderId: String(m.sender?.id), recipientId: String(m.recipient?.id), mid: String(msg.mid), text: msg.text.slice(0, 4000), echo: !!msg.is_echo });
      }
      return out;
    },
  };
}
