// Web Push, written against the standard Web Crypto API so it runs the same in Supabase's edge runtime
// (Deno) and in Node for the tests. Encrypts a message for one browser subscription (RFC 8291, aes128gcm)
// and signs the request with the app's VAPID key (RFC 8292). No third-party packages.

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string; // browser's public key, base64url
  auth: string; // browser's auth secret, base64url
}

export interface VapidKeys {
  publicKey: string; // uncompressed P-256 point, base64url (65 bytes)
  privateKey: string; // the private scalar "d", base64url (32 bytes)
  subject: string; // a mailto: or https: contact for the push service
}

type Bytes = Uint8Array<ArrayBuffer>;
const enc = new TextEncoder();

export function b64url(bytes: Bytes): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64url(text: string): Bytes {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** The content-encryption key and nonce shared by sender and browser (RFC 8291 §3.4, RFC 8188 §2.2). */
export async function deriveKeys(ecdhSecret: Bytes, authSecret: Bytes, uaPublic: Bytes, asPublic: Bytes, salt: Bytes) {
  const prkKey = await hmac(authSecret, ecdhSecret);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode('Content-Encoding: aes128gcm\0\x01'))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode('Content-Encoding: nonce\0\x01'))).slice(0, 12);
  return { cek, nonce };
}

/** Encrypts one message for a subscription. Returns the request body (header + single record). */
export async function encrypt(sub: PushSubscriptionKeys, plaintext: Bytes): Promise<Bytes> {
  const uaPublic = unb64url(sub.p256dh);
  const authSecret = unb64url(sub.auth);
  const ua = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const as = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, as.privateKey, 256));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { cek, nonce } = await deriveKeys(ecdhSecret, authSecret, uaPublic, asPublic, salt);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 0x10, 0]); // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, record);
}

/** The Authorization header value for one push service (RFC 8292). */
export async function vapidAuth(endpoint: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  const pub = unb64url(keys.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64url(pub.slice(1, 33)), y: b64url(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: keys.subject })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

/** Sends one notification. Returns the push service's HTTP status (404/410 mean the subscription is gone). */
export async function sendPush(sub: PushSubscriptionKeys, message: unknown, keys: VapidKeys, ttlSeconds = 6 * 3600): Promise<number> {
  const body = await encrypt(sub, enc.encode(JSON.stringify(message)));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuth(sub.endpoint, keys),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttlSeconds),
      Urgency: 'normal',
    },
    body,
  });
  await res.body?.cancel();
  return res.status;
}
