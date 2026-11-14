import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, symlinkSync, chmodSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { localConfiguration, localDatabaseUrl } from '../scripts/workspace-setup.mjs';
import { waitForDatabase } from '../scripts/wait-database.mjs';

const environment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !['NODE_ENV', 'DATABASE_URL', 'AUTH_MODE', 'APP_ORIGIN', 'SESSION_SECRET', 'CREDENTIAL_ENCRYPTION_KEY'].includes(key)));

test('local settings are explicit and generated keys are valid and stable', () => {
  const first = localConfiguration({}, {}, {});
  assert.equal(first.DATABASE_URL, localDatabaseUrl);
  assert.equal(first.AUTH_MODE, 'development');
  assert.equal(first.APP_ORIGIN, 'http://localhost:3000');
  assert.equal(Buffer.from(first.SESSION_SECRET, 'hex').length, 32);
  assert.equal(Buffer.from(first.CREDENTIAL_ENCRYPTION_KEY, 'base64').length, 32);
  assert.deepEqual(localConfiguration(first, first, {}), first);
});

test('production, nonlocal settings, conflicting keys and invalid keys are refused', () => {
  for (const bad of [{ NODE_ENV: 'production' }, { AUTH_MODE: 'supabase' }, { APP_ORIGIN: 'https://example.com' }, { DATABASE_URL: 'postgresql://external.invalid/production' }, { SESSION_SECRET: 'short' }, { CREDENTIAL_ENCRYPTION_KEY: 'not-base64' }]) {
    assert.throws(() => localConfiguration(bad, {}, {}));
    assert.throws(() => localConfiguration({}, bad, {}));
    assert.throws(() => localConfiguration({}, {}, bad));
  }
  assert.throws(() => localConfiguration({ SESSION_SECRET: 'a'.repeat(64) }, { SESSION_SECRET: 'b'.repeat(64) }, {}), /differs/);
});

test('readiness is finite, validates configuration, and can recover after initial failure', async () => {
  let calls = 0;
  await waitForDatabase({ url: localDatabaseUrl, probe: () => ++calls === 2, sleep: async () => {} });
  assert.equal(calls, 2);
  await assert.rejects(waitForDatabase({ url: localDatabaseUrl, timeoutMs: 5, probe: () => false, sleep: async () => {} }), /timed out/);
  await assert.rejects(waitForDatabase({ url: localDatabaseUrl, timeoutMs: 300001 }), /Database wait/);
  await assert.rejects(waitForDatabase({ url: 'https://example.com' }), /PostgreSQL/);
  await assert.rejects(waitForDatabase(), /DATABASE_URL/);
});

function fixture(t, running) {
  const dir = mkdtempSync(join(tmpdir(), 'leadwork-setup-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'apps/web'), { recursive: true });
  mkdirSync(join(dir, 'bin'));
  for (const name of ['workspace-setup.mjs', 'wait-database.mjs']) copyFileSync(new URL(`../scripts/${name}`, import.meta.url), join(dir, 'scripts', name));
  writeFileSync(join(dir, 'state'), running ? 'running' : 'stopped');
  // All database/system commands are mocked in an isolated temporary directory.
  const mock = join(dir, 'bin', 'mock.mjs');
  writeFileSync(mock, `#!${process.execPath}\nimport {readFileSync,writeFileSync,appendFileSync} from 'node:fs';\nimport {basename,join} from 'node:path';\nconst name=basename(process.argv[1]);\nconst args=process.argv.slice(2);\nconst root=process.env.MOCK_ROOT;\nappendFileSync(join(root,'calls'),name+(name==='pg_ctlcluster'?' '+args[2]:'')+'\\n');\nif(name==='sudo'){const {spawnSync}=await import('node:child_process');const child=spawnSync(args[1],args.slice(2),{stdio:'inherit'});process.exit(child.status??1);}\nif(name==='pg_ctlcluster'){if(args[2]==='status')process.exit(readFileSync(join(root,'state'),'utf8')==='running'?0:3);writeFileSync(join(root,'state'),args[2]==='start'?'running':'stopped');}\nif(name==='runuser' && args.includes('-Atc'))process.stdout.write(process.env.MOCK_DB_EXISTS==='false'?'':'1\\n');\nif(name==='pnpm' && process.env.MOCK_MIGRATION_FAIL==='true')process.exit(1);\n`);
  chmodSync(mock, 0o755);
  for (const name of ['pg_ctlcluster', 'pg_isready', 'runuser', 'pnpm', 'sudo']) symlinkSync(mock, join(dir, 'bin', name));
  const run = (extra = {}) => spawnSync(process.execPath, ['scripts/workspace-setup.mjs'], {
    cwd: dir, encoding: 'utf8', timeout: 5000,
    env: { ...environment(), PATH: `${join(dir, 'bin')}:${process.env.PATH}`, MOCK_ROOT: dir, ...extra },
  });
  return { dir, run, calls: () => readFileSync(join(dir, 'calls'), 'utf8'), state: () => readFileSync(join(dir, 'state'), 'utf8') };
}

test('existing cluster stays running, local files are private, and repeated setup preserves keys', t => {
  const f = fixture(t, true);
  assert.equal(f.run().status, 0);
  const root = parseEnv(readFileSync(join(f.dir, '.env'), 'utf8'));
  assert.deepEqual(parseEnv(readFileSync(join(f.dir, 'apps/web/.env.local'), 'utf8')), root);
  assert.equal(statSync(join(f.dir, '.env')).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.dir, 'apps/web/.env.local')).mode & 0o777, 0o600);
  writeFileSync(join(f.dir, '.env'), readFileSync(join(f.dir, '.env'), 'utf8') + 'CUSTOM_FLAG=keep\n');
  assert.equal(f.run().status, 0);
  assert.equal(parseEnv(readFileSync(join(f.dir, '.env'), 'utf8')).SESSION_SECRET, root.SESSION_SECRET);
  assert.equal(parseEnv(readFileSync(join(f.dir, '.env'), 'utf8')).CUSTOM_FLAG, 'keep');
  assert.equal(f.state(), 'running');
  assert.doesNotMatch(f.calls(), /pg_ctlcluster (start|stop)/);
  assert.match(f.calls(), /pnpm/);
});

test('setup stops only a cluster it started, including after migration failure', t => {
  for (const fail of [false, true]) {
    const f = fixture(t, false);
    assert.equal(f.run({ MOCK_MIGRATION_FAIL: String(fail), MOCK_DB_EXISTS: 'false' }).status, fail ? 1 : 0);
    assert.equal(f.state(), 'stopped');
    assert.match(f.calls(), /pg_ctlcluster start/);
    assert.match(f.calls(), /pg_ctlcluster stop/);
  }
});

test('migration failure does not stop an existing cluster', t => {
  const f = fixture(t, true);
  assert.equal(f.run({ MOCK_MIGRATION_FAIL: 'true' }).status, 1);
  assert.equal(f.state(), 'running');
  assert.doesNotMatch(f.calls(), /pg_ctlcluster stop/);
});

test('unsafe setup refuses configuration before any system commands', t => {
  const f = fixture(t, true);
  const result = f.run({ NODE_ENV: 'production' });
  assert.equal(result.status, 1);
  assert.equal(f.state(), 'running');
  assert.throws(() => f.calls(), { code: 'ENOENT' });
});

test('environment uses only the workspace schema fields and ordered process roles', () => {
  const config = JSON.parse(readFileSync(new URL('./environment.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(config).sort(), ['build', 'install', 'name', 'start', 'terminals']);
  assert.deepEqual(Object.keys(config.build), ['dockerfile']);
  assert.deepEqual(config.terminals.map(terminal => terminal.name), ['postgres', 'web', 'worker']);
  for (const terminal of config.terminals) assert.deepEqual(Object.keys(terminal).sort(), ['command', 'name']);
  assert.match(config.install, /--frozen-lockfile/);
  assert.match(config.start, /workspace-setup\.mjs/);
  assert.match(config.terminals[1].command, /wait-database\.mjs && pnpm dev/);
  assert.match(config.terminals[2].command, /wait-database\.mjs && pnpm worker/);
});
