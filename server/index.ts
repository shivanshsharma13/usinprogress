import { createApp } from './app.ts';

const port = Number(process.env.PORT ?? 3000);
const production = process.env.NODE_ENV === 'production';

const { app, close } = createApp({
  dbPath: process.env.DATABASE_PATH ?? './data/us-in-progress.db',
  secureCookies: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : false,
  serveStatic: production,
  trustProxy: process.env.TRUST_PROXY === 'true',
});

const server = app.listen(port, () => {
  console.log(`Us in Progress API listening on http://localhost:${port}${production ? '' : ' (dev — open the Vite URL)'}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    close();
    process.exit(0);
  });
}
