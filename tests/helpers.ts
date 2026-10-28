// Test harness: each simulated person is a separate Supabase client with its own session, driving
// the app's real data layer (web/src/data/backend.ts) against a local Supabase (`npx supabase start`).
import { execSync } from 'node:child_process';
import pg from 'pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createBackend } from '../web/src/data/backend.ts';
import { ApiError } from '../web/src/data/errors.ts';

pg.types.setTypeParser(20, Number); // COUNT(*) and BIGINT timestamps as numbers
pg.types.setTypeParser(1700, Number);

interface Local {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
}

function localSupabase(): Local {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_DB_URL) {
    return { API_URL: process.env.SUPABASE_URL, ANON_KEY: process.env.SUPABASE_ANON_KEY, DB_URL: process.env.SUPABASE_DB_URL };
  }
  return JSON.parse(execSync('npx supabase status -o json', { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
}

const local = localSupabase();

export interface TestServer {
  base: string;
  db: { query(sql: string, params?: unknown[]): Promise<any[]> };
  close(): Promise<void>;
}

/** Direct database access for the few checks that need raw rows (as the database owner). */
export async function startServer(): Promise<TestServer> {
  const client = new pg.Client({ connectionString: local.DB_URL });
  await client.connect();
  return {
    base: local.API_URL,
    db: {
      async query(sql: string, params: unknown[] = []) {
        let i = 0;
        return (await client.query(sql.replace(/\?/g, () => `$${++i}`), params)).rows;
      },
    },
    close: () => client.end(),
  };
}

// POSTs that create something answer 201, like the old HTTP API did.
const CREATES = [/^\/auth\/signup$/, /^\/friends\/requests$/, /^\/rooms$/, /^\/rooms\/[^/]+\/topics$/, /^\/sessions$/, /^\/plans$/, /^\/plans\/[^/]+\/(tasks|sprints)$/, /^\/tasks$/, /^\/encourage$/];

const clients: Client[] = [];

/** Closes every test client's Realtime connection so the test process can exit. */
export async function closeClients() {
  for (const c of clients.splice(0)) {
    await c.sb.removeAllChannels();
    c.sb.realtime.disconnect();
  }
}

/** One person (one browser): their own Supabase session. */
export class Client {
  base: string;
  sb: SupabaseClient;
  private backend;
  constructor(base: string) {
    this.base = base;
    this.sb = createClient(local.API_URL, local.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    this.backend = createBackend(this.sb);
    clients.push(this);
  }

  async req(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<{ status: number; body: any }> {
    try {
      const result = await this.backend.request(method, path, body);
      return { status: method === 'POST' && CREATES.some((r) => r.test(path.split('?')[0])) ? 201 : 200, body: result };
    } catch (e) {
      if (e instanceof ApiError) return { status: e.status, body: { error: { code: e.code, message: e.message, data: e.data } } };
      throw e;
    }
  }

  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  del = (p: string) => this.req('DELETE', p);

  /** Subscribes to Realtime changes this person is allowed to see. */
  async listen(): Promise<{ events: any[]; waitFor(pred: (e: any) => boolean, ms?: number): Promise<any>; stop(): void }> {
    const events: any[] = [];
    const waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];
    const { data } = await this.sb.auth.getSession();
    this.sb.realtime.setAuth(data.session?.access_token ?? null);
    const channel = this.sb.channel(`test-${Math.random()}`);
    for (const table of ['presence', 'activities', 'topic_completions', 'friendships']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
        const e = { table, eventType: payload.eventType, row: payload.new };
        events.push(e);
        for (const w of [...waiters]) if (w.pred(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(e));
      });
    }
    // "SUBSCRIBED" arrives a moment before the database-change feed is live; wait for Realtime's own
    // confirmation ("Subscribed to PostgreSQL") so no change slips through the gap.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Realtime did not connect')), 10_000);
      channel.on('system', {}, (msg: any) => {
        if (msg?.extension === 'postgres_changes' && msg?.status === 'ok') (clearTimeout(t), resolve());
      });
      channel.subscribe();
    });
    return {
      events,
      waitFor(pred, ms = 5000) {
        const found = events.find(pred);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => reject(new Error('Timed out waiting for a realtime event')), ms);
          waiters.push({ pred, resolve: (e) => (clearTimeout(t), resolve(e)) });
        });
      },
      stop: () => void this.sb.removeChannel(channel),
    };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const emailFor = (username: string) => `${username}@example.com`;

export async function signUp(base: string, username: string, profileType: 'engineer' | 'doctor' | 'custom') {
  const c = new Client(base);
  const res = await c.post('/auth/signup', {
    email: emailFor(username),
    username,
    password: 'correct horse battery',
    displayName: username[0].toUpperCase() + username.slice(1),
    profileType,
    timezone: 'UTC',
  });
  if (res.status !== 201) throw new Error('signup failed: ' + JSON.stringify(res.body));
  return { client: c, me: res.body.me };
}
