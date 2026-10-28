import express from 'express';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type DB } from './db.ts';
import { RealtimeHub } from './realtime.ts';
import { apiRouter } from './routes.ts';
import { errorHandler, notFound } from './http.ts';
import { sameOriginWrites } from './auth.ts';

export interface AppOptions {
  dbPath: string;
  secureCookies?: boolean;
  serveStatic?: boolean;
  trustProxy?: boolean;
}

export function createApp(opts: AppOptions) {
  const db: DB = openDatabase(opts.dbPath);
  const hub = new RealtimeHub();
  const app = express();
  app.disable('x-powered-by');
  if (opts.trustProxy) app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    // Lets the client correct for clock skew when showing a running timer.
    res.setHeader('X-Server-Now', String(Date.now()));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use('/api', express.json({ limit: '100kb' }), sameOriginWrites, (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', apiRouter(db, hub, { secureCookies: Boolean(opts.secureCookies) }));
  app.use('/api', (_req, _res, next) => next(notFound('Unknown API route.')));

  const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
  if (opts.serveStatic && existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
  }

  app.use(errorHandler);

  return {
    app,
    db,
    hub,
    close() {
      hub.close();
      db.close();
    },
  };
}
