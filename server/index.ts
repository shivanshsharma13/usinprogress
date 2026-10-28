import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const production = process.env.NODE_ENV === 'production';

// DATABASE_URL: your Supabase (or any Postgres) connection string. Without it, a local PGlite database
// in ./data/pglite is used, which is handy for development.
const databaseUrl = process.env.DATABASE_URL || './data/pglite';
const { app, close, db } = await createApp({
  databaseUrl,
  secureCookies: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : false,
  serveStatic: production,
  trustProxy: process.env.TRUST_PROXY === 'true',
});

const server = app.listen(port, () => {
  const store = db.kind === 'postgres' ? 'Postgres (DATABASE_URL)' : `local PGlite in ${databaseUrl}`;
  console.log(`Us in Progress API listening on http://localhost:${port} · data: ${store}${production ? '' : ' (dev — open the Vite URL)'}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    server.close();
    await close();
    process.exit(0);
  });
}
