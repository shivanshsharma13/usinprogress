import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';

export interface TestServer {
  base: string;
  db: Awaited<ReturnType<typeof createApp>>['db'];
  close(): Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  // In-memory PGlite by default; set TEST_DATABASE_URL to run the same tests against a real (empty) Postgres.
  const { app, db, close } = await createApp({ databaseUrl: process.env.TEST_DATABASE_URL });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    db,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => void close().then(resolve));
      }),
  };
}

/** A tiny client with its own cookie jar — one per simulated person / browser. */
export class Client {
  base: string;
  cookie = '';
  constructor(base: string) {
    this.base = base;
  }

  async req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(this.base + '/api' + path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }

  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  del = (p: string) => this.req('DELETE', p);

  /** Opens the realtime stream and collects events. */
  async listen(): Promise<{ events: any[]; waitFor(pred: (e: any) => boolean, ms?: number): Promise<any>; stop(): void }> {
    const ctrl = new AbortController();
    const res = await fetch(this.base + '/api/events', { headers: { cookie: this.cookie }, signal: ctrl.signal });
    const events: any[] = [];
    const waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];
    (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const type = /^event: (.*)$/m.exec(chunk)?.[1];
            const data = /^data: (.*)$/m.exec(chunk)?.[1];
            if (type === 'invalidate' && data) {
              const e = JSON.parse(data);
              events.push(e);
              for (const w of [...waiters]) if (w.pred(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(e));
            }
          }
        }
      } catch {}
    })();
    return {
      events,
      waitFor(pred, ms = 2000) {
        const found = events.find(pred);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('Timed out waiting for realtime event')), ms);
          waiters.push({ pred, resolve: (e) => (clearTimeout(t), resolve(e)) });
        });
      },
      stop: () => ctrl.abort(),
    };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function signUp(base: string, username: string, profileType: 'engineer' | 'doctor' | 'custom') {
  const c = new Client(base);
  const res = await c.post('/auth/signup', { username, password: 'correct horse battery', displayName: username[0].toUpperCase() + username.slice(1), profileType, timezone: 'UTC' });
  if (res.status !== 201) throw new Error('signup failed: ' + JSON.stringify(res.body));
  return { client: c, me: res.body.me };
}
