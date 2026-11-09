#!/usr/bin/env node
// Prepares local credentials without ever displaying them.
//   --init-machine  first setup of a computer only: create the shared Neo4j credential once.
//   (default)       copy that credential, and the provider key from the main checkout, into this
//                   worktree's .env, adding only what is missing.
// Secrets move by file reads and writes only: never through arguments, output or logs.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const COMPOSE_PROJECT = 'llime-local';
const DB_KEYS = ['NEO4J_URI', 'NEO4J_USER', 'NEO4J_PASSWORD'];
const PROVIDER_KEY = 'OPENAI_API_KEY';
// Values are written as bare KEY=value lines, which read back unchanged only without quotes,
// whitespace or comment markers.
const PLAIN_VALUE = /^[^\s'"`#\\]+$/;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const machineDir = join(homedir(), '.config', 'llime');
const machineFile = join(machineDir, 'neo4j.env');
const worktreeEnv = join(root, '.env');

function fail(message) {
  console.error(`setup-env: ${message}`);
  process.exit(1);
}

function hasKey(env, key) {
  return Object.hasOwn(env, key);
}

function requirePrivate(path, mode) {
  const actual = statSync(path).mode & 0o777;
  if (actual & 0o077) fail(`${path} is accessible to other users (mode ${actual.toString(8)}). Run: chmod ${mode.toString(8)} "${path}"`);
}

function readMachineCredential() {
  if (!existsSync(machineFile)) {
    fail(`no machine DB credential at ${machineFile}. On a new computer run "node scripts/setup-env.mjs --init-machine" once, then rerun this.`);
  }
  requirePrivate(machineDir, 0o700);
  requirePrivate(machineFile, 0o600);
  const values = parseEnv(readFileSync(machineFile, 'utf8'));
  const missing = DB_KEYS.filter((key) => !values[key]);
  if (missing.length) fail(`${machineFile} lacks ${missing.join(', ')}. Nothing was changed.`);
  return Object.fromEntries(DB_KEYS.map((key) => [key, values[key]]));
}

// A database created earlier holds a password this script cannot recover, so its presence must be
// known for sure: if Docker cannot answer, stop instead of assuming there is none.
function llimeDatabaseExists() {
  const filter = `label=com.docker.compose.project=${COMPOSE_PROJECT}`;
  const docker = (args) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    return (docker(['volume', 'ls', '-q', '--filter', filter]) + docker(['ps', '-a', '-q', '--filter', filter])).trim() !== '';
  } catch (error) {
    fail(`cannot ask Docker whether a ${COMPOSE_PROJECT} database exists (${String(error.message).split('\n')[0]}). Start Docker and retry. Nothing was changed.`);
  }
}

function initMachine() {
  if (existsSync(machineFile)) {
    readMachineCredential();
    console.log(`Machine DB credential already exists at ${machineFile}; left unchanged.`);
    return;
  }
  if (llimeDatabaseExists()) {
    fail(`a ${COMPOSE_PROJECT} Neo4j volume or container already exists, but ${machineFile} is missing. Its password cannot be recovered or replaced here, so nothing was changed. Restore the original credential file to continue.`);
  }
  mkdirSync(machineDir, { recursive: true, mode: 0o700 });
  chmodSync(machineDir, 0o700);
  const password = randomBytes(24).toString('hex');
  writeFileSync(machineFile, `NEO4J_URI=bolt://127.0.0.1:17687\nNEO4J_USER=neo4j\nNEO4J_PASSWORD=${password}\n`, { mode: 0o600, flag: 'wx' });
  chmodSync(machineFile, 0o600);
  console.log(`Created the machine DB credential at ${machineFile} (not displayed).`);
}

function requireIgnoredEnv() {
  try {
    execFileSync('git', ['check-ignore', '-q', '.env'], { cwd: root, stdio: 'ignore' });
  } catch {
    fail(`.env is not ignored by git in ${root}; refusing to write secrets into it.`);
  }
}

// Only the main checkout of this repository on this computer holds the provider key.
function providerKeyFromMainCheckout() {
  const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
  const main = worktrees.match(/^worktree (.+)$/m)?.[1];
  if (!main || !existsSync(main) || realpathSync(main) === realpathSync(root)) return undefined;
  const mainEnv = join(main, '.env');
  if (!existsSync(mainEnv)) return undefined;
  return parseEnv(readFileSync(mainEnv, 'utf8'))[PROVIDER_KEY] || undefined;
}

function setupWorktree() {
  const credential = readMachineCredential();
  requireIgnoredEnv();
  const text = existsSync(worktreeEnv) ? readFileSync(worktreeEnv, 'utf8') : '';
  const existing = parseEnv(text);
  const conflicts = DB_KEYS.filter((key) => hasKey(existing, key) && existing[key] !== credential[key]);
  if (conflicts.length) {
    fail(`${worktreeEnv} sets ${conflicts.join(', ')} differently from the machine credential. Nothing was changed; delete those lines if they are stale, then rerun.`);
  }
  const additions = DB_KEYS.filter((key) => !hasKey(existing, key)).map((key) => [key, credential[key]]);
  if (!hasKey(existing, PROVIDER_KEY)) {
    const providerKey = providerKeyFromMainCheckout();
    if (providerKey) additions.push([PROVIDER_KEY, providerKey]);
  }
  const unsafe = additions.filter(([, value]) => !PLAIN_VALUE.test(value)).map(([key]) => key);
  if (unsafe.length) fail(`${unsafe.join(', ')} cannot be written as a plain value. Nothing was changed.`);

  if (additions.length) {
    const prefix = text && !text.endsWith('\n') ? `${text}\n` : text;
    const temporary = `${worktreeEnv}.${process.pid}.tmp`;
    writeFileSync(temporary, prefix + additions.map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, worktreeEnv);
  }
  if (existsSync(worktreeEnv)) chmodSync(worktreeEnv, 0o600);

  const added = additions.map(([key]) => key);
  console.log(added.length ? `Added to .env: ${added.join(', ')}.` : '.env already had the DB credential; nothing added.');
  if (!hasKey(existing, PROVIDER_KEY) && !added.includes(PROVIDER_KEY)) {
    console.log(`${PROVIDER_KEY} is not set: the main checkout has none on this computer (voice needs it).`);
  }
  console.log('Local environment ready (credential not displayed).');
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--init-machine') initMachine();
else if (args.length === 0) setupWorktree();
else fail('usage: node scripts/setup-env.mjs [--init-machine]');
