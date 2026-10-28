// Postgres data layer.
//
//  * Production: any Postgres via DATABASE_URL — e.g. your Supabase project's connection string.
//  * Development and tests: PGlite, a real Postgres engine running inside Node (no server needed),
//    stored in ./data/pglite (or in memory for tests).
//
// Services call get/all/run/transaction as before. Inside transaction(), every query automatically
// runs on that transaction's connection (tracked with AsyncLocalStorage), and transactions run one at
// a time per server process, so multi-step writes never interleave.
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

type Param = string | number | boolean | null;
type Row = Record<string, any>;
interface Result {
  rows: Row[];
  fields: { name: string; dataTypeID: number }[];
}
interface Executor {
  query(sql: string, params?: unknown[]): Promise<Result>;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
// int8 (COUNT, BIGINT timestamps) and numeric (SUM) come back as strings; the app uses plain numbers.
const NUMERIC_TYPES = new Set([20, 1700]);

export class Database {
  readonly kind: 'postgres' | 'pglite';
  private pool?: pg.Pool;
  private lite?: PGlite;
  private tx = new AsyncLocalStorage<Executor>();
  private queue: Promise<void> = Promise.resolve();

  private constructor(pool: pg.Pool | undefined, lite: PGlite | undefined) {
    this.pool = pool;
    this.lite = lite;
    this.kind = pool ? 'postgres' : 'pglite';
  }

  /** `url` = postgres://… connection string; otherwise a PGlite directory, or undefined for in-memory. */
  static async open(url?: string): Promise<Database> {
    let db: Database;
    if (url && /^postgres(ql)?:\/\//.test(url)) {
      db = new Database(new pg.Pool({ connectionString: url, ssl: sslFor(url), max: 10 }), undefined);
    } else {
      if (url) mkdirSync(url, { recursive: true });
      db = new Database(undefined, new PGlite(url));
    }
    await db.migrate();
    return db;
  }

  /** One at a time per process: PGlite has a single connection, and it keeps writes from interleaving. */
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise((r) => (release = r));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async query(sql: string, params: Param[] = []): Promise<Row[]> {
    let i = 0;
    const text = params.length ? sql.replace(/\?/g, () => `$${++i}`) : sql;
    const inTx = this.tx.getStore();
    const result: Result = inTx
      ? await inTx.query(text, params)
      : this.pool
        ? await this.pool.query(text, params)
        : await this.exclusive(() => this.lite!.query(text, params) as unknown as Promise<Result>);
    const convert = result.fields.filter((f) => NUMERIC_TYPES.has(f.dataTypeID)).map((f) => f.name);
    if (convert.length) for (const row of result.rows) for (const k of convert) if (row[k] !== null) row[k] = Number(row[k]);
    return result.rows;
  }

  /** Runs fn atomically. Nested calls join the outer transaction. */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.tx.getStore()) return fn();
    return this.exclusive(async () => {
      if (this.lite) return this.lite.transaction((t) => this.tx.run(t as Executor, fn));
      const client = await this.pool!.connect();
      try {
        await client.query('BEGIN');
        const result = await this.tx.run(client as Executor, fn);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    });
  }

  private async migrate() {
    await this.query('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)');
    const applied = new Set((await this.query('SELECT name FROM _migrations')).map((r) => r.name));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      await this.transaction(async () => {
        const ex = this.tx.getStore()!;
        // Multi-statement files run as a plain script (no parameters).
        if (this.lite) await (ex as unknown as PGlite).exec(sql);
        else await ex.query(sql);
        await this.query('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)', [file, Date.now()]);
      });
    }
  }

  async close() {
    await this.pool?.end();
    await this.lite?.close();
  }
}

/** Hosted Postgres (e.g. Supabase) needs TLS; local servers usually don't. */
function sslFor(url: string): pg.PoolConfig['ssl'] {
  const host = new URL(url).hostname;
  if (process.env.DATABASE_SSL === 'false' || host === 'localhost' || host === '127.0.0.1') return false;
  // Supabase serves its own certificate chain; pass its CA (Project Settings → Database) to verify it.
  const ca = process.env.DATABASE_SSL_CA ? readFileSync(process.env.DATABASE_SSL_CA, 'utf8') : undefined;
  return ca ? { ca } : { rejectUnauthorized: false };
}

export type DB = Database;

export async function get<T = Row>(db: DB, sql: string, ...params: Param[]): Promise<T | undefined> {
  return (await db.query(sql, params))[0] as T | undefined;
}

export async function all<T = Row>(db: DB, sql: string, ...params: Param[]): Promise<T[]> {
  return (await db.query(sql, params)) as T[];
}

export async function run(db: DB, sql: string, ...params: Param[]): Promise<void> {
  await db.query(sql, params);
}

export function transaction<T>(db: DB, fn: () => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

export const newId = () => randomUUID();

/** Builds "?, ?, ?" for IN clauses (turned into $1, $2, … when the query runs). */
export const placeholders = (n: number) => Array.from({ length: n }, () => '?').join(', ');
