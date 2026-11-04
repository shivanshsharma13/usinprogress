// The push sender's encryption and signing, checked by decrypting as a browser would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { b64url, deriveKeys, encrypt, unb64url, vapidAuth } from '../supabase/functions/push/webpush.ts';

async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, sub: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: b64url(pub), auth: b64url(auth) } };
}

test('push messages decrypt on the receiving browser (RFC 8291)', async () => {
  const { pair, sub } = await browserKeys();
  const body = await encrypt(sub, new TextEncoder().encode('{"title":"Hello 🌱"}'));
  // Header: salt(16) | record size(4) | key id length(1) | sender public key | record
  const salt = body.slice(0, 16);
  assert.equal(new DataView(body.buffer).getUint32(16), 4096);
  assert.equal(body[20], 65);
  const asPublic = body.slice(21, 86);
  const as = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: as }, pair.privateKey, 256));
  const { cek, nonce } = await deriveKeys(secret, unb64url(sub.auth), unb64url(sub.p256dh), asPublic, salt);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, body.slice(86)));
  assert.equal(plain.at(-1), 2, 'last-record delimiter');
  assert.equal(new TextDecoder().decode(plain.slice(0, -1)), '{"title":"Hello 🌱"}');
});

test('the VAPID header is a valid ES256 token for the push service (RFC 8292)', async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const header = await vapidAuth('https://fcm.googleapis.com/fcm/send/abc', { publicKey, privateKey: jwk.d!, subject: 'mailto:test@example.com' }, 1_700_000_000_000);
  const [, token, k] = header.match(/^vapid t=([^,]+), k=(.+)$/)!;
  assert.equal(k, publicKey);
  const [h, c, s] = token.split('.');
  const claims = JSON.parse(new TextDecoder().decode(unb64url(c)));
  assert.deepEqual(claims, { aud: 'https://fcm.googleapis.com', exp: 1_700_000_000 + 12 * 3600, sub: 'mailto:test@example.com' });
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pair.publicKey, unb64url(s), new TextEncoder().encode(`${h}.${c}`));
  assert.ok(ok);
});

test('key derivation matches the worked example in RFC 8291 appendix A', async () => {
  const v = {
    auth: 'BTBZMqHH6r4Tts7J_aSIgg',
    uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
    asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
    salt: 'DGv6ra1nlYgDCS1FRnbzlw',
    body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  };
  const asPub = unb64url(v.asPublic);
  const jwk = { kty: 'EC', crv: 'P-256', d: v.asPrivate, x: b64url(asPub.slice(1, 33)), y: b64url(asPub.slice(33)) };
  const priv = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const ua = await crypto.subtle.importKey('raw', unb64url(v.uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: ua }, priv, 256));
  const { cek, nonce } = await deriveKeys(secret, unb64url(v.auth), unb64url(v.uaPublic), asPub, unb64url(v.salt));
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const text = new TextEncoder().encode('When I grow up, I want to be a watermelon');
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, new Uint8Array([...text, 2])));
  assert.equal(b64url(new Uint8Array([...unb64url(v.salt), 0, 0, 0x10, 0, 65, ...asPub, ...record])), v.body);
});
