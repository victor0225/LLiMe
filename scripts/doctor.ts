// Checks that this computer and worktree can run llime. Each line names a check, its result and, on a
// problem, the command that fixes it. Secret values are never printed, only whether they are set.
// Exits 1 when a required check fails; warnings (for example no provider key on a computer without
// one) do not fail.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import neo4j from 'neo4j-driver';
import { z } from 'zod';
import { type Config, HOST, loadConfig, repoRoot } from '../src/config.js';
import { loadSeed } from '../src/dataset.js';
import { loadPreparedLesson } from '../src/inbox.js';

const MIN_NODE_MAJOR = 22;
// Long enough for a healthy local service to answer, short enough that a stopped one fails fast.
const DB_CONNECT_TIMEOUT_MS = 3000;
const SIMULATOR_RUNTIME = 'iOS 26.5';

type Result = { status: 'pass' | 'warn' | 'fail'; detail: string };
const pass = (detail: string): Result => ({ status: 'pass', detail });
const warn = (detail: string): Result => ({ status: 'warn', detail });
const fail = (detail: string): Result => ({ status: 'fail', detail });

// Child tools never need the worktree's credentials.
const childEnv = () => {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.NEO4J_PASSWORD;
  return env;
};
const execFileAsync = promisify(execFile);
// No shell: the program and its arguments are passed as given.
const run = async (file: string, args: string[]) => (await execFileAsync(file, args, { env: childEnv(), cwd: repoRoot, timeout: 15_000 })).stdout.trim();

function checkNode(): Result {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= MIN_NODE_MAJOR ? pass(`v${process.versions.node}`) : fail(`v${process.versions.node}; install Node ${MIN_NODE_MAJOR} or newer`);
}

async function checkNpm(): Promise<Result> {
  return pass(await run('npm', ['--version']));
}

function checkEnvFile(): Result {
  const file = join(repoRoot, '.env');
  if (!existsSync(file)) return fail('.env is missing; run npm run setup:env');
  const mode = statSync(file).mode & 0o777;
  return mode === 0o600 ? pass('.env present, mode 600') : fail(`.env has mode ${mode.toString(8)}; run chmod 600 .env`);
}

function checkCredentials(config: Config): Result {
  const missing = Object.entries({ NEO4J_URI: config.neo4j.uri, NEO4J_USER: config.neo4j.user, NEO4J_PASSWORD: config.neo4j.password }).filter(([, value]) => !value);
  return missing.length === 0 ? pass('NEO4J_URI, NEO4J_USER and NEO4J_PASSWORD are set') : fail(`${missing.map(([name]) => name).join(', ')} not set; run npm run setup:env`);
}

const ComposeServiceSchema = z.object({ Service: z.string(), State: z.string(), Health: z.string().optional() });

async function checkComposeService(): Promise<Result> {
  let output: string;
  try {
    output = await run('docker', ['compose', '-p', 'llime-local', 'ps', '--format', 'json']);
  } catch {
    return fail('Docker is not reachable; start Docker or OrbStack, then run npm run db:up');
  }
  // Compose prints one JSON object per line (older versions print one array).
  const services = output.split('\n').filter(Boolean).flatMap((line) => [JSON.parse(line)].flat()).map((s) => ComposeServiceSchema.parse(s));
  const graph = services.find((s) => s.Service === 'graph');
  if (!graph) return fail('the llime-local graph service is not running; run npm run db:up');
  return graph.Health === 'healthy' ? pass('llime-local graph service is healthy') : fail(`llime-local graph service is ${graph.Health ?? graph.State}; run npm run db:up`);
}

async function checkDatabase(config: Config): Promise<Result> {
  if (!config.neo4j.password) return fail('skipped: NEO4J_PASSWORD not set');
  const driver = neo4j.driver(config.neo4j.uri, neo4j.auth.basic(config.neo4j.user, config.neo4j.password), { connectionTimeout: DB_CONNECT_TIMEOUT_MS });
  const session = driver.session();
  try {
    // An auto-commit query is not retried, so a stopped service fails within the connect timeout.
    await session.run('RETURN 1');
    return pass(`${config.neo4j.uri} answers RETURN 1 with this worktree's credential`);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown error';
    return fail(`${config.neo4j.uri} refused the query (${code}); run npm run db:up and npm run setup:env`);
  } finally {
    await session.close();
    await driver.close();
  }
}

function checkProviderKey(config: Config): Result {
  return config.openaiApiKey ? pass('OPENAI_API_KEY is set') : warn('OPENAI_API_KEY is not set; voice and live checks run only on a computer with a key');
}

async function checkCodex(): Promise<Result> {
  const pinned = z.object({ dependencies: z.record(z.string(), z.string()) }).parse(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))).dependencies['@openai/codex'];
  try {
    const version = await run(join(repoRoot, 'node_modules', '.bin', 'codex'), ['--version']);
    return version === `codex-cli ${pinned}` ? pass(`${version} (pinned ${pinned})`) : fail(`${version}, but the pin is ${pinned}; run npm ci`);
  } catch {
    return fail(`the pinned Codex CLI ${pinned} is not installed; run npm ci`);
  }
}

// Login output can name the account, so only the exit status is used.
async function checkCodexLogin(config: Config): Promise<Result> {
  try {
    await run(join(repoRoot, 'node_modules', '.bin', 'codex'), ['login', 'status']);
    return pass('logged in');
  } catch {
    const detail = 'not logged in; run node_modules/.bin/codex login';
    return config.openaiApiKey ? fail(detail) : warn(`${detail} (needed only for live runs)`);
  }
}

function checkSeed(): Result {
  try {
    const seed = loadSeed();
    return pass(`seed v${seed.manifest.version}, ${seed.cases.length} cases; case and concept-link hashes match the manifest`);
  } catch (error) {
    return fail(`${error instanceof Error ? error.message : String(error)}; restore data/seed from git`);
  }
}

async function checkLesson(): Promise<Result> {
  const lesson = await loadPreparedLesson({ rootDir: repoRoot });
  return lesson.prepared ? pass('prepared lesson matches its manifest') : fail(`${lesson.problem}; restore data/lesson from git`);
}

function portState(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, HOST, () => probe.close(() => resolve(true)));
  });
}

async function checkPorts(config: Config): Promise<Result> {
  const ports = { PORT: config.port, VITE_PORT: config.vitePort, STORYBOOK_PORT: config.storybookPort };
  const busy = [];
  for (const [name, port] of Object.entries(ports)) if (!(await portState(port))) busy.push(`${name} ${port}`);
  const list = Object.entries(ports).map(([name, port]) => `${name} ${port}`).join(', ');
  return busy.length === 0 ? pass(`${list} free`) : warn(`${busy.join(', ')} in use; fine if it is this worktree's own server, otherwise see lsof -nP -iTCP:<port> -sTCP:LISTEN`);
}

const SimulatorRuntimesSchema = z.object({ runtimes: z.array(z.object({ name: z.string(), isAvailable: z.boolean() })) });

async function checkSimulator(): Promise<Result> {
  try {
    const { runtimes } = SimulatorRuntimesSchema.parse(JSON.parse(await run('xcrun', ['simctl', 'list', 'runtimes', '-j'])));
    return runtimes.some((r) => r.name === SIMULATOR_RUNTIME && r.isAvailable) ? pass(`${SIMULATOR_RUNTIME} runtime installed`) : warn(`${SIMULATOR_RUNTIME} runtime not installed; needed only for iPad Simulator work`);
  } catch {
    return warn('Xcode command line tools not available; needed only for iPad Simulator work');
  }
}

async function main() {
  const results: Array<[string, Result]> = [['node', checkNode()], ['npm', await checkNpm()], ['env file', checkEnvFile()]];
  let config: Config | null = null;
  try {
    config = loadConfig();
    results.push(['config', pass(`app origin ${config.appOrigin}`)]);
  } catch (error) {
    results.push(['config', fail(error instanceof Error ? error.message : String(error))]);
  }
  if (config) {
    results.push(['db credential', checkCredentials(config)], ['db service', await checkComposeService()], ['db query', await checkDatabase(config)], ['provider key', checkProviderKey(config)]);
    results.push(['codex', await checkCodex()], ['codex login', await checkCodexLogin(config)], ['ports', await checkPorts(config)]);
  }
  results.push(['seed data', checkSeed()], ['lesson data', await checkLesson()], ['simulator', await checkSimulator()]);

  for (const [name, { status, detail }] of results) console.log(`${status.toUpperCase().padEnd(4)}  ${name.padEnd(13)} ${detail}`);
  const failed = results.filter(([, r]) => r.status === 'fail').length;
  const warned = results.filter(([, r]) => r.status === 'warn').length;
  console.log(`\n${results.length - failed - warned} passed, ${warned} warnings, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

await main();
