// HTTP layer: auth, accounts, organizations, RBAC, admin, static files.
// Each route handler maps to a Next.js route handler in the port.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as A from './auth.js';
import { marketplace } from './marketplace.js';
import { agentsApi } from './agents-api.js';
import { academy } from './academy.js';
import { ops } from './ops.js';
import { createEngine } from './runtime/engine.js';

const ROLES = ['USER', 'STUDENT', 'SUPPORT', 'ADMIN'];
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const SESSION_MS = 30 * 24 * 3600e3;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://player.vimeo.com https://iframe.mediadelivery.net; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
};

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

const iso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const slugify = s => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';

function str(v, field, min, max) {
  if (typeof v !== 'string') throw new HttpError(400, `Поле «${field}» обязательно`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `${field}: от ${min} до ${max} символов`);
  return s;
}
function email(v) {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (e.length > 254 || !EMAIL_RE.test(e)) throw new HttpError(400, 'Введите корректный email');
  return e;
}
function password(v) {
  if (typeof v !== 'string' || v.length < 10) throw new HttpError(400, 'Пароль должен быть не короче 10 символов');
  if (v.length > 200) throw new HttpError(400, 'Пароль слишком длинный');
  return v;
}

function parseCookies(h = '') {
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createApp({ db, encryptionKey, publicDir, baseUrl = 'http://localhost:3000', isProd = false, mailer, env = {}, fetchImpl = fetch, log = console }) {
  const cipher = A.makeCipher(encryptionKey);
  // Errors from the runtime and the HTTP layer are also kept in system_logs for the admin Logs tab.
  const sysLog = (level, source, message, meta) => {
    try { db.prepare('INSERT INTO system_logs (id, level, source, message, meta) VALUES (?,?,?,?,?)').run(crypto.randomUUID(), level, source, String(message).slice(0, 1000), meta ? JSON.stringify(meta).slice(0, 4000) : null); } catch { /* never let logging break a request */ }
  };
  const runtimeLog = { error: m => { log.error?.(m); sysLog('error', 'runtime', m); } };
  const engine = createEngine({ db, cipher, env, fetchImpl, log: runtimeLog, baseUrl, sendMail: (...a) => sendMail(...a) });
  const COOKIE = isProd ? '__Host-sid' : 'sid';
  const q = sql => db.prepare(sql);
  const publicRoot = path.resolve(publicDir);

  // --- rate limiting (in-memory; Redis-backed in production) ---
  const buckets = new Map();
  const limiter = {
    check(key, max) { const b = buckets.get(key); if (b && b.reset > Date.now() && b.n >= max) throw new HttpError(429, 'Слишком много попыток. Подождите несколько минут и попробуйте снова.'); },
    hit(key, windowMs) { const b = buckets.get(key); if (!b || b.reset <= Date.now()) buckets.set(key, { n: 1, reset: Date.now() + windowMs }); else b.n++; },
    clear(key) { buckets.delete(key); },
  };
  const throttle = (key, max, windowMs) => { limiter.check(key, max); limiter.hit(key, windowMs); };

  const audit = (actorId, action, target = null, meta = null) =>
    q('INSERT INTO audit_log (id, actor_id, action, target, meta) VALUES (?,?,?,?,?)')
      .run(crypto.randomUUID(), actorId, action, target, meta ? JSON.stringify(meta) : null);

  // Dev mailer writes to the outbox table. Production passes a Resend/Postmark mailer.
  const sendMail = mailer || ((to, subject, body) =>
    q('INSERT INTO outbox (id, to_email, subject, body) VALUES (?,?,?,?)').run(crypto.randomUUID(), to, subject, body));

  function issueToken(userId, kind, ttlMs) {
    const t = A.randomToken();
    q('INSERT INTO tokens (hash, user_id, kind, expires_at) VALUES (?,?,?,?)').run(A.sha256(t), userId, kind, iso(ttlMs));
    return t;
  }
  function consumeToken(token, kind) {
    if (typeof token !== 'string' || token.length < 20) throw new HttpError(400, 'Ссылка недействительна или устарела');
    const row = q('SELECT * FROM tokens WHERE hash = ? AND kind = ? AND used_at IS NULL AND expires_at > ?').get(A.sha256(token), kind, iso());
    if (!row) throw new HttpError(400, 'Ссылка недействительна или устарела');
    q('UPDATE tokens SET used_at = ? WHERE hash = ?').run(iso(), row.hash);
    return row.user_id;
  }
  function sendVerification(user) {
    const t = issueToken(user.id, 'verify', 24 * 3600e3);
    sendMail(user.email, 'Подтвердите email', `Здравствуйте, ${user.name}!\n\nПодтвердите email: ${baseUrl}/verify.html?token=${t}\n\nСсылка действует 24 часа.`);
  }

  function startSession(c, userId) {
    const token = A.randomToken();
    q('INSERT INTO sessions (id, user_id, expires_at, ip, user_agent) VALUES (?,?,?,?,?)')
      .run(A.sha256(token), userId, iso(SESSION_MS), c.ip, String(c.req.headers['user-agent'] || '').slice(0, 300));
    c.cookies.push(`${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}${isProd ? '; Secure' : ''}`);
  }
  function sessionUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    return q(`SELECT u.*, s.id AS session_id FROM sessions s JOIN users u ON u.id = s.user_id
              WHERE s.id = ? AND s.expires_at > ? AND u.suspended_at IS NULL`).get(A.sha256(token), iso()) || null;
  }
  const requireUser = c => { if (!c.user) throw new HttpError(401, 'Пожалуйста, войдите'); return c.user; };
  const requireAdmin = c => {
    const u = requireUser(c);
    if (u.role !== 'ADMIN') throw new HttpError(403, 'Доступ запрещён');
    if (!u.totp_enabled) throw new HttpError(403, 'Администраторам нужно сначала включить двухфакторную аутентификацию');
    return u;
  };
  const publicUser = u => ({ id: u.id, email: u.email, name: u.name, role: u.role, emailVerified: !!u.email_verified_at, twoFactorEnabled: !!u.totp_enabled, createdAt: u.created_at });

  function checkTotp(u, code) {
    if (!u.totp_secret_enc) throw new HttpError(400, 'Двухфакторная аутентификация не настроена');
    const step = A.verifyTotp(cipher.decrypt(u.totp_secret_enc), String(code ?? ''));
    if (step === null || step <= (u.totp_last_step ?? -1)) throw new HttpError(401, 'Неверный код двухфакторной аутентификации');
    q('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, u.id);
  }

  const routes = {
    'POST /api/auth/register': async c => {
      throttle(`register:${c.ip}`, 20, 3600e3);
      const e = email(c.body.email), name = str(c.body.name, 'Имя', 1, 80), pw = password(c.body.password);
      if (q('SELECT 1 FROM users WHERE email = ?').get(e)) throw new HttpError(409, 'Аккаунт с таким email уже существует');
      const hash = await A.hashPassword(pw);
      const id = crypto.randomUUID(), orgId = crypto.randomUUID();
      db.exec('BEGIN');
      try {
        q('INSERT INTO users (id, email, name, password_hash) VALUES (?,?,?,?)').run(id, e, name, hash);
        q('INSERT INTO organizations (id, name, slug) VALUES (?,?,?)').run(orgId, `Пространство ${name}`, `${slugify(name)}-${orgId.slice(0, 6)}`);
        q('INSERT INTO memberships (user_id, org_id, role) VALUES (?,?,?)').run(id, orgId, 'OWNER');
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        if (/UNIQUE/.test(err.message)) throw new HttpError(409, 'Аккаунт с таким email уже существует');
        throw err;
      }
      const user = q('SELECT * FROM users WHERE id = ?').get(id);
      sendVerification(user);
      startSession(c, id);
      audit(id, 'user.register', id);
      c.status = 201;
      return { user: publicUser(user) };
    },

    'POST /api/auth/login': async c => {
      const e = typeof c.body.email === 'string' ? c.body.email.trim().toLowerCase() : '';
      const keys = [`login:${c.ip}:${e}`, `login-ip:${c.ip}`];
      limiter.check(keys[0], 10); limiter.check(keys[1], 50);
      const u = q('SELECT * FROM users WHERE email = ?').get(e);
      const ok = await A.verifyPassword(String(c.body.password ?? ''), u?.password_hash || A.DUMMY_HASH);
      const fail = (msg, extra) => { limiter.hit(keys[0], 15 * 60e3); limiter.hit(keys[1], 15 * 60e3); audit(u?.id ?? null, 'auth.login_failed', e); return new HttpError(401, msg, extra); };
      if (!u || !ok) throw fail('Неверный email или пароль');
      if (u.suspended_at) throw new HttpError(403, 'Этот аккаунт заблокирован. Напишите в поддержку, если считаете это ошибкой.');
      if (u.totp_enabled) {
        if (!c.body.code) throw new HttpError(401, 'Введите 6-значный код из приложения-аутентификатора', { needs2fa: true });
        try { checkTotp(u, c.body.code); } catch { throw fail('Неверный код двухфакторной аутентификации', { needs2fa: true }); }
      }
      limiter.clear(keys[0]);
      startSession(c, u.id);
      audit(u.id, 'auth.login', u.id);
      return { user: publicUser(u) };
    },

    'POST /api/auth/logout': async c => {
      if (c.user) q('DELETE FROM sessions WHERE id = ?').run(c.user.session_id);
      c.cookies.push(`${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${isProd ? '; Secure' : ''}`);
      return { ok: true };
    },

    'GET /api/me': async c => {
      const u = requireUser(c);
      const organizations = q(`SELECT o.id, o.name, o.slug, m.role FROM memberships m JOIN organizations o ON o.id = m.org_id
                               WHERE m.user_id = ? ORDER BY o.created_at`).all(u.id);
      return { user: publicUser(u), organizations };
    },

    'POST /api/auth/verify-email': async c => {
      const uid = consumeToken(c.body.token, 'verify');
      q('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(iso(), uid);
      audit(uid, 'user.email_verified', uid);
      return { ok: true };
    },

    'POST /api/auth/resend-verification': async c => {
      const u = requireUser(c);
      if (u.email_verified_at) throw new HttpError(400, 'Ваш email уже подтверждён');
      throttle(`resend:${u.id}`, 3, 3600e3);
      sendVerification(u);
      return { ok: true };
    },

    'POST /api/auth/request-password-reset': async c => {
      throttle(`reset-req:${c.ip}`, 10, 3600e3);
      const e = typeof c.body.email === 'string' ? c.body.email.trim().toLowerCase() : '';
      const u = e && q('SELECT * FROM users WHERE email = ?').get(e);
      if (u) {
        const t = issueToken(u.id, 'reset', 3600e3);
        sendMail(u.email, 'Сброс пароля', `Здравствуйте, ${u.name}!\n\nСбросить пароль: ${baseUrl}/reset.html?token=${t}\n\nСсылка действует 1 час. Если вы не запрашивали сброс, просто проигнорируйте это письмо.`);
        audit(u.id, 'auth.reset_requested', u.id);
      }
      // Same answer either way, so the form can't be used to check which emails have accounts.
      return { ok: true, message: 'Если аккаунт с этим email существует, мы отправили ссылку для сброса.' };
    },

    'POST /api/auth/reset-password': async c => {
      const pw = password(c.body.password);
      const uid = consumeToken(c.body.token, 'reset');
      q('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').run(await A.hashPassword(pw), iso(), uid);
      q('DELETE FROM sessions WHERE user_id = ?').run(uid);                          // log out everywhere
      q("UPDATE tokens SET used_at = ? WHERE user_id = ? AND kind = 'reset' AND used_at IS NULL").run(iso(), uid);
      audit(uid, 'auth.password_reset', uid);
      return { ok: true };
    },

    'POST /api/account/2fa/setup': async c => {
      const u = requireUser(c);
      if (u.totp_enabled) throw new HttpError(400, 'Двухфакторная аутентификация уже включена');
      const secret = A.base32Encode(crypto.randomBytes(20));
      q('UPDATE users SET totp_secret_enc = ?, totp_last_step = NULL WHERE id = ?').run(cipher.encrypt(secret), u.id);
      const label = encodeURIComponent(`NeuralDesk:${u.email}`);
      return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=NeuralDesk&digits=6&period=30` };
    },

    'POST /api/account/2fa/enable': async c => {
      const u = requireUser(c);
      if (u.totp_enabled) throw new HttpError(400, 'Двухфакторная аутентификация уже включена');
      throttle(`2fa:${u.id}`, 10, 15 * 60e3);
      checkTotp(u, c.body.code);
      q('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(u.id);
      audit(u.id, 'auth.2fa_enabled', u.id);
      return { ok: true };
    },

    'POST /api/account/2fa/disable': async c => {
      const u = requireUser(c);
      if (!u.totp_enabled) throw new HttpError(400, 'Двухфакторная аутентификация выключена');
      throttle(`2fa:${u.id}`, 10, 15 * 60e3);
      if (!(await A.verifyPassword(String(c.body.password ?? ''), u.password_hash))) throw new HttpError(401, 'Неверный пароль');
      checkTotp(u, c.body.code);
      q('UPDATE users SET totp_enabled = 0, totp_secret_enc = NULL, totp_last_step = NULL WHERE id = ?').run(u.id);
      audit(u.id, 'auth.2fa_disabled', u.id);
      return { ok: true };
    },

    'GET /api/admin/users': async c => {
      requireAdmin(c);
      const p = new URL(c.req.url, 'http://x').searchParams, text = `%${(p.get('q') || '').trim().toLowerCase().slice(0, 80)}%`;
      const role = ROLES.includes(p.get('role')) ? p.get('role') : null, status = p.get('status');
      const users = q(`SELECT * FROM users WHERE (lower(email) LIKE ? OR lower(name) LIKE ?) AND (? IS NULL OR role = ?)
                       AND (? IS NULL OR (? = 'suspended') = (suspended_at IS NOT NULL)) ORDER BY created_at DESC LIMIT 200`)
        .all(text, text, role, role, status || null, status || null).map(u => ({ ...publicUser(u), suspended: !!u.suspended_at }));
      return { users };
    },

    'GET /api/admin/audit': async c => {
      requireAdmin(c);
      return { entries: q('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100').all() };
    },

    'GET /api/dev/outbox': async () => {
      if (isProd) throw new HttpError(404, 'Не найдено');
      return { emails: q('SELECT * FROM outbox ORDER BY created_at DESC LIMIT 20').all() };
    },
  };

  const paramRoutes = [
    [/^POST \/api\/admin\/users\/([\w-]+)\/role$/, async (c, [id]) => {
      const admin = requireAdmin(c);
      if (id === admin.id) throw new HttpError(400, 'Нельзя изменить собственную роль');
      const role = c.body.role;
      if (!ROLES.includes(role)) throw new HttpError(400, `Роль должна быть одной из: ${ROLES.join(', ')}`);
      const target = q('SELECT * FROM users WHERE id = ?').get(id);
      if (!target) throw new HttpError(404, 'Пользователь не найден');
      q('UPDATE users SET role = ? WHERE id = ?').run(role, id);
      audit(admin.id, 'admin.role_changed', id, { from: target.role, to: role });
      return { user: publicUser({ ...target, role }) };
    }],
  ];

  // Feature modules plug in here (marketplace now; agents runtime, academy, billing later).
  const kit = { db, HttpError, requireUser, requireAdmin, audit, throttle, str, engine, sysLog, publicUser, publicBase: (env.PUBLIC_URL || baseUrl).replace(/\/$/, ''), sendMail: (...a) => sendMail(...a) };
  for (const mod of [marketplace, agentsApi, academy, ops]) {
    const m = mod(kit);
    Object.assign(routes, m.routes);
    paramRoutes.push(...m.paramRoutes);
  }

  // Meta's deauthorize / data-deletion callbacks post form data; everything else must be JSON.
  const FORM_PATHS = new Set(['/api/oauth/instagram/deauthorize', '/api/oauth/instagram/data-deletion']);
  async function readBody(req, pathname) {
    const type = String(req.headers['content-type'] || '');
    const form = type.startsWith('application/x-www-form-urlencoded') && FORM_PATHS.has(pathname);
    if (!type.startsWith('application/json') && !form) throw new HttpError(415, 'Content-Type должен быть application/json');
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 256 * 1024) throw new HttpError(413, 'Слишком большой запрос');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks);
    if (form) return { raw, value: Object.fromEntries(new URLSearchParams(raw.toString('utf8'))) };
    try {
      const v = JSON.parse(raw.toString('utf8') || '{}');
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0;
      return { raw, value: v };
    } catch { throw new HttpError(400, 'Некорректный JSON'); }
  }

  function serveStatic(req, res) {
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { p = '/'; }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.resolve(publicRoot, '.' + path.posix.normalize(p));
    if (!file.startsWith(publicRoot + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      return res.end('Не найдено');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...SECURITY_HEADERS });
    fs.createReadStream(file).pipe(res);
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SECURITY_HEADERS); return res.end(); }
      return serveStatic(req, res);
    }
    const c = { req, res, url, ip: req.socket.remoteAddress || 'unknown', cookies: [], status: 200, body: {} };
    let payload;
    try {
      if (req.method !== 'GET') {
        // CSRF: reject cross-site origins; JSON-only bodies force a CORS preflight for any other site.
        const origin = req.headers.origin;
        if (origin && (() => { try { return new URL(origin).host !== req.headers.host; } catch { return true; } })())
          throw new HttpError(403, 'Межсайтовый запрос заблокирован');
        const b = await readBody(req, url.pathname);
        c.body = b.value; c.rawBody = b.raw;
      }
      c.user = sessionUser(req);
      const key = `${req.method} ${url.pathname}`;
      let fn = routes[key], params = [];
      if (!fn) for (const [re, h] of paramRoutes) { const m = key.match(re); if (m) { fn = h; params = m.slice(1); break; } }
      if (!fn) throw new HttpError(404, 'Не найдено');
      payload = await fn(c, params);
    } catch (err) {
      if (err instanceof HttpError) { c.status = err.status; payload = { error: err.message, ...(err.extra || {}) }; }
      else { log.error?.(err); sysLog('error', 'http', `${req.method} ${url.pathname}: ${err.message}`, { stack: String(err.stack || '').split('\n').slice(0, 6).join('\n') }); c.status = 500; payload = { error: 'Что-то пошло не так' }; }
    }
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS };
    if (c.cookies.length) headers['Set-Cookie'] = c.cookies;
    if (c.redirect && c.status < 400) { res.writeHead(302, { ...headers, Location: c.redirect }); return res.end(); }
    if (typeof c.text === 'string' && c.status < 400) { res.writeHead(c.status, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(c.text); }
    res.writeHead(c.status, headers);
    res.end(JSON.stringify(payload));
  }
  handler.engine = engine;
  return handler;
}
