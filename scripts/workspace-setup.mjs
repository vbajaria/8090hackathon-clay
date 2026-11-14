import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { waitForDatabase } from './wait-database.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const localDatabaseUrl = 'postgresql://leadwork:leadwork-local-only@localhost:5432/leadwork';
const defaults = { DATABASE_URL: localDatabaseUrl, AUTH_MODE: 'development', APP_ORIGIN: 'http://localhost:3000' };

export function localConfiguration(existing = {}, other = {}, environment = process.env) {
  if ([existing.NODE_ENV, other.NODE_ENV, environment.NODE_ENV].includes('production')) throw new Error('Local setup refuses production mode.');
  const result = { ...defaults };
  for (const key of Object.keys(defaults)) {
    for (const source of [existing, other, environment]) {
      if (source[key] && source[key] !== defaults[key]) throw new Error(`Local setup requires explicit local ${key}; configure deployments separately.`);
    }
  }
  for (const [key, generate, valid] of [
    ['SESSION_SECRET', () => randomBytes(32).toString('hex'), value => Buffer.byteLength(value) >= 32],
    ['CREDENTIAL_ENCRYPTION_KEY', () => randomBytes(32).toString('base64'), value => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32],
  ]) {
    const values = [existing[key], other[key], environment[key]].filter(Boolean);
    if (new Set(values).size > 1) throw new Error(`${key} differs between local configurations; reconcile it manually without rotating stored credentials.`);
    result[key] = values[0] || generate();
    if (!valid(result[key])) throw new Error(`${key} has an invalid length or encoding.`);
  }
  return result;
}

function readEnv(path) {
  try { const text = readFileSync(path, 'utf8'); return { text, values: parseEnv(text) }; }
  catch (error) { if (error.code === 'ENOENT') return { text: '', values: {} }; throw error; }
}
function saveMissing(path, current, values) {
  const additions = Object.entries(values).filter(([key]) => !current.values[key]);
  if (additions.length) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${current.text}${current.text && !current.text.endsWith('\n') ? '\n' : ''}${additions.map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  }
  chmodSync(path, 0o600);
}
function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { cwd: root, stdio: 'inherit', timeout: 120_000, ...options });
  if (result.error || result.status !== 0) throw new Error(`Local setup command failed: ${binary}`);
  return result;
}
function admin(binary, args, options) {
  return process.getuid?.() === 0 ? command(binary, args, options) : command('sudo', ['-n', binary, ...args], options);
}
function postgres(args, options) { return admin('runuser', ['-u', 'postgres', '--', ...args], options); }

export async function setup() {
  const rootPath = resolve(root, '.env');
  const webPath = resolve(root, 'apps/web/.env.local');
  const rootEnv = readEnv(rootPath), webEnv = readEnv(webPath);
  const config = localConfiguration(rootEnv.values, webEnv.values);
  // Validate all settings before touching a database or writing any local secrets.
  let started = false;
  try {
    const status = process.getuid?.() === 0
      ? spawnSync('pg_ctlcluster', ['15', 'main', 'status'], { stdio: 'ignore' })
      : spawnSync('sudo', ['-n', 'pg_ctlcluster', '15', 'main', 'status'], { stdio: 'ignore' });
    if (status.error || ![0, 3].includes(status.status)) throw new Error('Cannot inspect PostgreSQL 15/main; check installation and sudo access.');
    if (status.status === 3) {
      admin('pg_ctlcluster', ['15', 'main', 'start']);
      started = true;
    }
    await waitForDatabase({ url: localDatabaseUrl });
    postgres(['psql', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-c', "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'leadwork') THEN CREATE ROLE leadwork LOGIN PASSWORD 'leadwork-local-only'; END IF; END $$;"]);
    const exists = postgres(['psql', '-v', 'ON_ERROR_STOP=1', '-d', 'postgres', '-Atc', "SELECT 1 FROM pg_database WHERE datname='leadwork'"], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
    if (exists.stdout.trim() !== '1') postgres(['createdb', '--owner=leadwork', 'leadwork']);
    command('pnpm', ['db:migrate'], { env: { ...process.env, ...config } });
    saveMissing(rootPath, rootEnv, config);
    saveMissing(webPath, webEnv, config);
    console.log('Local migrations complete; root and web development environment files preserved.');
  } finally {
    // Never stop an existing server (including a parent task testing against it).
    if (started) admin('pg_ctlcluster', ['15', 'main', 'stop']);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup().catch(() => {
    console.error('Local workspace setup failed; inspect command output. No cloud provisioning was attempted.');
    process.exitCode = 1;
  });
}
