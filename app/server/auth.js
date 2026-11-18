// Crypto primitives. Built on node:crypto only.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
// scrypt N=2^15 ≈ OWASP baseline. Swap to Argon2id (package "argon2") when installs are allowed;
// verifyPassword reads the algorithm prefix, so old hashes keep working.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const derived = await scrypt(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), 64, SCRYPT);
  const expected = Buffer.from(hash, 'base64');
  return expected.length === derived.length && crypto.timingSafeEqual(derived, expected);
}

// Used when the email doesn't exist, so login takes the same time either way.
export const DUMMY_HASH = await hashPassword('timing-equalizer-not-a-real-password');

export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

// AES-256-GCM for secrets at rest (TOTP secrets now; Telegram/Meta tokens in Stage 5).
export function makeCipher(keyBase64) {
  const key = Buffer.from(String(keyBase64 || ''), 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 random bytes, base64-encoded');
  return {
    encrypt(plain) {
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join('.');
    },
    decrypt(payload) {
      const [iv, tag, ct] = payload.split('.').map(x => Buffer.from(x, 'base64'));
      const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    },
  };
}

// ---- TOTP (RFC 6238), compatible with Google Authenticator / 1Password / Authy ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const byte of buf) {
    val = (val << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; val &= (1 << bits) - 1; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; val &= (1 << bits) - 1; }
  }
  return Buffer.from(out);
}

function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 15;
  return String((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const totpStep = (t = Date.now()) => Math.floor(t / 30_000);
export const totp = (secret, t = Date.now()) => hotp(base32Decode(secret), totpStep(t));

// Returns the matched time step (for replay protection) or null. Accepts ±1 step of clock drift.
export function verifyTotp(secret, code, t = Date.now()) {
  if (!/^\d{6}$/.test(String(code))) return null;
  const key = base32Decode(secret); const now = totpStep(t);
  for (const step of [now - 1, now, now + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(String(code)))) return step;
  }
  return null;
}
