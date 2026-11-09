import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { parseEnv } from 'node:util';

const script = new URL('../scripts/setup-env.mjs', import.meta.url).pathname;
const sandboxes: string[] = [];
after(() => sandboxes.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// Each sandbox has its own HOME, a git repository holding a copy of the script, and a fake
// `docker` on PATH whose answer the test chooses, so no real credential or database is touched.
function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'setup-env-')));
  sandboxes.push(dir);
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  const bin = join(dir, 'bin');
  [home, join(repo, 'scripts'), bin].forEach((path) => mkdirSync(path, { recursive: true }));
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nprintf "%s" "$FAKE_DOCKER_OUTPUT"\nexit "${FAKE_DOCKER_STATUS:-0}"\n', { mode: 0o755 });
  writeFileSync(join(repo, '.gitignore'), '.env\n.env.*\n');
  copyFileSync(script, join(repo, 'scripts', 'setup-env.mjs'));
  const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: repo, env: { PATH: process.env.PATH, HOME: home } });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');

  const run = (args: string[] = [], options: { cwd?: string; docker?: string; dockerStatus?: number } = {}) => {
    const scriptPath = join(options.cwd ?? repo, 'scripts', 'setup-env.mjs');
    const result = spawnSync(process.execPath, [scriptPath, ...args], {
      cwd: options.cwd ?? repo,
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, FAKE_DOCKER_OUTPUT: options.docker ?? '', FAKE_DOCKER_STATUS: String(options.dockerStatus ?? 0) },
    });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const machineDir = join(home, '.config', 'llime');
  const machineFile = join(machineDir, 'neo4j.env');
  const writeMachineCredential = (password = 'a'.repeat(48)) => {
    mkdirSync(machineDir, { recursive: true, mode: 0o700 });
    writeFileSync(machineFile, `NEO4J_URI=bolt://127.0.0.1:17687\nNEO4J_USER=neo4j\nNEO4J_PASSWORD=${password}\n`, { mode: 0o600 });
    return password;
  };
  const providerFile = join(machineDir, 'provider.env');
  const writeProviderKey = (value: string, fileMode = 0o600) => {
    writeFileSync(providerFile, `OPENAI_API_KEY=${value}\n`, { mode: fileMode });
    chmodSync(providerFile, fileMode);
  };
  return { dir, home, repo, git, run, machineDir, machineFile, writeMachineCredential, providerFile, writeProviderKey, envFile: join(repo, '.env') };
}

const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('init creates a private random machine credential and never prints it (fake docker: no database)', () => {
  const s = sandbox();
  const result = s.run(['--init-machine']);
  assert.equal(result.status, 0, result.output);
  const password = parseEnv(readFileSync(s.machineFile, 'utf8')).NEO4J_PASSWORD ?? '';
  assert.match(password, /^[0-9a-f]{48}$/);
  assert.equal(mode(s.machineDir), '700');
  assert.equal(mode(s.machineFile), '600');
  assert.ok(!result.output.includes(password));
});

test('init leaves an existing machine credential unchanged', () => {
  const s = sandbox();
  s.writeMachineCredential();
  const before = sha256(s.machineFile);
  assert.equal(s.run(['--init-machine']).status, 0);
  assert.equal(sha256(s.machineFile), before);
});

test('init refuses when a llime-local database exists without its credential (fake docker: volume present)', () => {
  const s = sandbox();
  const result = s.run(['--init-machine'], { docker: 'llime-local_graph-data\n' });
  assert.equal(result.status, 1);
  assert.match(result.output, /already exists.*nothing was changed/s);
  assert.ok(!existsSync(join(s.home, '.config')));
});

test('init stops when docker cannot say whether a database exists (fake docker: daemon down)', () => {
  const s = sandbox();
  const result = s.run(['--init-machine'], { dockerStatus: 1 });
  assert.equal(result.status, 1);
  assert.match(result.output, /cannot ask Docker/);
  assert.ok(!existsSync(join(s.home, '.config')));
});

test('setup without a machine credential fails and writes no .env', () => {
  const s = sandbox();
  const result = s.run();
  assert.equal(result.status, 1);
  assert.match(result.output, /--init-machine/);
  assert.ok(!existsSync(s.envFile));
});

test('setup refuses a machine credential readable by other users', () => {
  const s = sandbox();
  s.writeMachineCredential();
  chmodSync(s.machineFile, 0o644);
  assert.equal(s.run().status, 1);
  assert.ok(!existsSync(s.envFile));
});

test('setup adds the DB credential to .env with mode 0600, keeps existing lines and prints no secret', () => {
  const s = sandbox();
  const password = s.writeMachineCredential();
  const existing = '# local notes\nPORT=4101\nOPENAI_API_KEY=sk-existing';
  writeFileSync(s.envFile, existing, { mode: 0o644 });
  const result = s.run();
  assert.equal(result.status, 0, result.output);
  const text = readFileSync(s.envFile, 'utf8');
  assert.ok(text.startsWith(`${existing}\n`));
  assert.deepEqual(parseEnv(text), { PORT: '4101', OPENAI_API_KEY: 'sk-existing', NEO4J_URI: 'bolt://127.0.0.1:17687', NEO4J_USER: 'neo4j', NEO4J_PASSWORD: password });
  assert.equal(mode(s.envFile), '600');
  assert.ok(!result.output.includes(password));
});

test('setup run twice leaves .env byte-identical', () => {
  const s = sandbox();
  s.writeMachineCredential();
  assert.equal(s.run().status, 0);
  const before = sha256(s.envFile);
  assert.equal(s.run().status, 0);
  assert.equal(sha256(s.envFile), before);
});

test('setup fails on a conflicting worktree DB value and leaves .env byte-identical', () => {
  const s = sandbox();
  s.writeMachineCredential();
  writeFileSync(s.envFile, 'NEO4J_PASSWORD=stale-value\nPORT=4101\n', { mode: 0o600 });
  const before = sha256(s.envFile);
  const result = s.run();
  assert.equal(result.status, 1);
  assert.match(result.output, /NEO4J_PASSWORD/);
  assert.ok(!result.output.includes('stale-value'));
  assert.equal(sha256(s.envFile), before);
});

test('setup refuses to write secrets into a .env that git does not ignore', () => {
  const s = sandbox();
  s.writeMachineCredential();
  writeFileSync(join(s.repo, '.gitignore'), '');
  assert.equal(s.run().status, 1);
  assert.ok(!existsSync(s.envFile));
});

test('setup in a linked worktree copies only the provider key from the main checkout', () => {
  const s = sandbox();
  s.writeMachineCredential();
  writeFileSync(s.envFile, 'OPENAI_API_KEY=sk-main-checkout\nOTHER_SECRET=main-only\n', { mode: 0o600 });
  const linked = join(s.dir, 'linked');
  s.git('worktree', 'add', '-q', '--detach', linked);
  const result = s.run([], { cwd: linked });
  assert.equal(result.status, 0, result.output);
  const env = parseEnv(readFileSync(join(linked, '.env'), 'utf8'));
  assert.equal(env.OPENAI_API_KEY, 'sk-main-checkout');
  assert.equal(env.OTHER_SECRET, undefined);
  assert.ok(!result.output.includes('sk-main-checkout'));
});

test('setup in a linked worktree keeps its own provider key', () => {
  const s = sandbox();
  s.writeMachineCredential();
  writeFileSync(s.envFile, 'OPENAI_API_KEY=sk-main-checkout\n', { mode: 0o600 });
  const linked = join(s.dir, 'linked');
  s.git('worktree', 'add', '-q', '--detach', linked);
  writeFileSync(join(linked, '.env'), 'OPENAI_API_KEY=sk-own\n', { mode: 0o600 });
  assert.equal(s.run([], { cwd: linked }).status, 0);
  assert.equal(parseEnv(readFileSync(join(linked, '.env'), 'utf8')).OPENAI_API_KEY, 'sk-own');
});

test('setup in a fresh single clone takes the provider key from the machine provider file without printing it', () => {
  const s = sandbox();
  s.writeMachineCredential();
  s.writeProviderKey('sk-fake-machine-key');
  const result = s.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(parseEnv(readFileSync(s.envFile, 'utf8')).OPENAI_API_KEY, 'sk-fake-machine-key');
  assert.equal(mode(s.envFile), '600');
  assert.ok(!result.output.includes('sk-fake-machine-key'));
});

test('setup prefers the main checkout provider key over the machine provider file', () => {
  const s = sandbox();
  s.writeMachineCredential();
  s.writeProviderKey('sk-fake-machine-key');
  writeFileSync(s.envFile, 'OPENAI_API_KEY=sk-main-checkout\n', { mode: 0o600 });
  const linked = join(s.dir, 'linked');
  s.git('worktree', 'add', '-q', '--detach', linked);
  const result = s.run([], { cwd: linked });
  assert.equal(result.status, 0, result.output);
  assert.equal(parseEnv(readFileSync(join(linked, '.env'), 'utf8')).OPENAI_API_KEY, 'sk-main-checkout');
  assert.ok(!result.output.includes('sk-main-checkout'));
  assert.ok(!result.output.includes('sk-fake-machine-key'));
});

test('setup keeps a worktree provider key even when the machine provider file has another', () => {
  const s = sandbox();
  s.writeMachineCredential();
  s.writeProviderKey('sk-fake-machine-key');
  writeFileSync(s.envFile, 'OPENAI_API_KEY=sk-own\n', { mode: 0o600 });
  const result = s.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(parseEnv(readFileSync(s.envFile, 'utf8')).OPENAI_API_KEY, 'sk-own');
  assert.ok(!result.output.includes('sk-fake-machine-key'));
});

test('setup without any provider key source succeeds without the key and names both sources', () => {
  const s = sandbox();
  s.writeMachineCredential();
  const result = s.run();
  assert.equal(result.status, 0, result.output);
  assert.equal(parseEnv(readFileSync(s.envFile, 'utf8')).OPENAI_API_KEY, undefined);
  assert.match(result.output, /OPENAI_API_KEY is not set/);
  assert.match(result.output, /main checkout/);
  assert.ok(result.output.includes(s.providerFile));
});

test('setup refuses a machine provider file readable by other users, writes nothing and prints no key', () => {
  const s = sandbox();
  s.writeMachineCredential();
  s.writeProviderKey('sk-fake-machine-key', 0o644);
  const result = s.run();
  assert.equal(result.status, 1);
  assert.ok(result.output.includes(s.providerFile));
  assert.match(result.output, /accessible to other users/);
  assert.ok(!existsSync(s.envFile));
  assert.ok(!result.output.includes('sk-fake-machine-key'));
});
