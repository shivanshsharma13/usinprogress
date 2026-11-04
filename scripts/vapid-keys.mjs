// Makes the key pair for phone notifications (README → Phone notifications). Prints only the public key;
// both keys are written to the file you name (keep it out of git; .env.* files already are).
import { writeFileSync, existsSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('Usage: node scripts/vapid-keys.mjs .env.push');
if (existsSync(file)) throw new Error(`${file} already exists — keep the keys you have, or delete it first.`);
const b64url = (b) => Buffer.from(b).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicKey = b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
const { d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
const secret = b64url(crypto.getRandomValues(new Uint8Array(32)));
writeFileSync(file, `VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${d}\nPUSH_WEBHOOK_SECRET=${secret}\n`, { mode: 0o600 });
console.log(`Public key (for the VITE_VAPID_PUBLIC_KEY variable): ${publicKey}\nPrivate key and webhook secret saved to ${file}.`);
