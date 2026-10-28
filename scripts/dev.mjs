// Runs the API (with --watch) and the Vite dev server together.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

// `--watch` also watches the env file, so only pass it when it exists.
const envFile = existsSync('.env') ? ['--env-file=.env'] : [];

const procs = [
  spawn(process.execPath, ['--watch', ...envFile, '--disable-warning=ExperimentalWarning', 'server/index.ts'], { stdio: 'inherit', env: process.env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit', env: process.env }),
];

const stop = () => {
  for (const p of procs) p.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
