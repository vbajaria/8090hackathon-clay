import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function waitForDatabase({ url, timeoutMs = 60_000, probe, sleep } = {}) {
  if (!url) throw new Error('DATABASE_URL is required; run local workspace setup first.');
  const database = new URL(url);
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300_000) throw new Error('Database wait must be between 1 and 300000 milliseconds.');
  const args = ['-h', database.hostname, '-p', database.port || '5432', '-d', decodeURIComponent(database.pathname.slice(1)), '-t', '1'];
  const check = probe ?? (() => {
    const result = spawnSync('pg_isready', args, { stdio: 'ignore', timeout: 2000 });
    if (result.error) throw new Error('pg_isready could not run; install PostgreSQL client 15.');
    return result.status === 0;
  });
  const pause = sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;
  do {
    if (check()) return;
    await pause(Math.min(500, Math.max(0, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error('PostgreSQL readiness timed out; inspect the postgres terminal.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let local = {};
    try { local = parseEnv(readFileSync(new URL('../.env', import.meta.url), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await waitForDatabase({ url: process.env.DATABASE_URL || local.DATABASE_URL, timeoutMs: Number(process.env.WAIT_DATABASE_TIMEOUT_MS || 60_000) });
    console.log('PostgreSQL is ready.');
  } catch (error) {
    // Never print the connection URL or a native error containing credentials.
    console.error(error.message.startsWith('PostgreSQL') || error.message.startsWith('DATABASE_URL') || error.message.startsWith('Database wait') || error.message.startsWith('pg_isready') ? error.message : 'Database readiness configuration is invalid.');
    process.exitCode = 1;
  }
}
