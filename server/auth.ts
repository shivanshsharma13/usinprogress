// Username + password authentication. Passwords are hashed with scrypt (memory-hard, built into
// Node), stored only in auth_credentials, and never returned or logged. Sign-in issues a random
// token kept in an HttpOnly cookie; only its SHA-256 hash is stored.
import { scryptSync, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { get, run, type DB } from './db.ts';
import { HttpError } from './http.ts';

const COOKIE = 'uip_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, N, r, p, saltB64, hashB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

// A fixed hash so unknown usernames take as long to reject as wrong passwords.
const DUMMY_HASH = hashPassword('not-a-real-password');

export function checkCredentials(db: DB, userId: string | undefined, password: string): boolean {
  const row = userId ? get<{ password_hash: string }>(db, 'SELECT password_hash FROM auth_credentials WHERE user_id = ?', userId) : undefined;
  const ok = verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  return Boolean(row) && ok;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function startAuthSession(db: DB, res: Response, userId: string, secure: boolean) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  run(db, 'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha256(token), userId, now, now + SESSION_TTL_MS);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure, maxAge: SESSION_TTL_MS, path: '/' });
}

export function endAuthSession(db: DB, req: Request, res: Response) {
  const token = readCookie(req, COOKIE);
  if (token) run(db, 'DELETE FROM auth_sessions WHERE token_hash = ?', sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function userIdFromRequest(db: DB, req: Request): string | undefined {
  const token = readCookie(req, COOKIE);
  if (!token) return undefined;
  const row = get<{ user_id: string; expires_at: number }>(db, 'SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?', sha256(token));
  if (!row || row.expires_at < Date.now()) return undefined;
  return row.user_id;
}

export function requireAuth(db: DB) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const userId = userIdFromRequest(db, req);
    if (!userId) return next(new HttpError(401, 'UNAUTHENTICATED', 'Please sign in again.'));
    req.userId = userId;
    next();
  };
}

/** Rejects state-changing requests that come from another site (defence in depth on top of SameSite). */
export function sameOriginWrites(req: Request, _res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] ?? req.headers.host;
    try {
      if (new URL(origin).host !== host) return next(new HttpError(403, 'CROSS_SITE', 'Cross-site request blocked.'));
    } catch {
      return next(new HttpError(403, 'CROSS_SITE', 'Cross-site request blocked.'));
    }
  }
  next();
}

/** Small in-memory limiter for sign-in / sign-up attempts. */
export function rateLimit(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = req.ip ?? 'unknown';
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(key, recent);
    if (recent.length > max) return next(new HttpError(429, 'TOO_MANY', 'Too many attempts. Please wait a minute and try again.'));
    next();
  };
}
