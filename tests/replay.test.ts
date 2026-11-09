import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import { HOST, parseConfig, repoRoot } from '../src/config.js';
import { loadSeed } from '../src/dataset.js';
import { readLesson } from '../src/inbox.js';
import { BootstrapSchema, ROUTES, type RouteName, routePath, SESSION_HEADER } from '../src/routes.js';
import { bootServer } from '../src/server.js';
import { createRunId, Store } from '../src/store.js';
import { type Capture, exportCapture, loadCapture } from '../scripts/export-capture.js';

// Real local Neo4j and the real routes produce the capture; the server is then shut down and the
// replay runs as its own process, without database or provider settings in its environment.
const NONCE = 'replay-suite-nonce';
const created: string[] = [];
let store: Store;
let scratch = '';
let capturesDir = '';
let capture: Capture;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, HOST, resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No port was assigned');
  return address.port;
}

before(async () => {
  store = await Store.connect();
  const corpus = loadSeed();
  scratch = mkdtempSync(join(tmpdir(), 'llime-replay-'));
  capturesDir = join(scratch, 'captures');
  writeFileSync(join(scratch, 'index.html'), '<!doctype html><title>llime</title>');
  const config = parseConfig({ PORT: String(await freePort()) });
  const live = await bootServer(
    {
      store: { getRun: (id) => store.getRun(id), events: (id, after) => store.events(id, after), getNotification: (id) => store.getNotification(id), appendEvents: (id, events) => store.appendEvents(id, events), close: async () => {} },
      createRun: async () => assert.fail('this suite creates runs in the store'),
      lessons: { readLesson: (id) => readLesson(id, { rootDir: scratch, prepared: null }), saveTranscript: async () => assert.fail('this suite saves no lesson') },
      startInbox: async () => ({ stop: async () => {} }),
      startOutbox: async () => ({ stop: async () => {} }),
    },
    { config, nonce: NONCE, frontend: { kind: 'static', distDir: scratch }, dataset: 'synthetic', signals: new EventEmitter() },
  );
  await live.ready;
  const runId = createRunId('test-replay');
  created.push(runId);
  await store.createRun({ runId, seed: 7 }, corpus);
  await store.appendEvents(runId, [1, 2, 3].map((n) => ({ type: 'lesson.detected' as const, payload: { contentHash: `hash-${n}`, source: 'local_file' as const, bytes: n } })));
  const { captureId } = await exportCapture({ origin: config.appOrigin, runId, capturesDir });
  await live.shutdown();
  capture = await loadCapture(captureId, capturesDir);
});

after(async () => {
  for (const id of created) await store.resetRun(id).catch(() => undefined);
  await store?.close();
  rmSync(scratch, { recursive: true, force: true });
});

type ReplayProcess = { pid: number; origin: string; stop(): Promise<void> };

// Starts the replay in a child process whose environment holds no database or provider setting.
async function startReplayProcess(port: number): Promise<ReplayProcess> {
  // .mts: the scratch directory has no package.json, so the entry must declare itself an ES module.
  const entry = join(scratch, 'replay-entry.mts');
  writeFileSync(
    entry,
    `import { startReplay } from ${JSON.stringify(pathToFileURL(join(repoRoot, 'scripts/demo-replay.ts')).href)};
const [captureId, port, capturesDir, distDir] = process.argv.slice(2);
const replay = await startReplay({ captureId, port: Number(port), capturesDir, distDir });
console.log('READY ' + replay.url);
process.once('SIGTERM', () => void replay.close().then(() => process.exit(0)));
`,
  );
  const child = spawn(process.execPath, ['--import', 'tsx', entry, capture.manifest.captureId, String(port), capturesDir, scratch], {
    cwd: repoRoot,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise<string>((resolve, reject) => {
    lines.once('line', resolve);
    child.once('exit', (code) => reject(new Error(`The replay process exited with ${code} before it was ready`)));
  });
  assert.match(await ready, /^READY http:\/\/127\.0\.0\.1:\d+\/$/);
  return {
    pid: child.pid ?? assert.fail('the replay process has no PID'),
    origin: `http://${HOST}:${port}`,
    stop: async () => {
      child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit');
    },
  };
}

async function getJson(origin: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${origin}${path}`);
  return { status: response.status, body: await response.json() };
}

const POST_BODIES: Partial<Record<RouteName, unknown>> = {
  createRun: {},
  runCommand: { type: 'stop_learning', commandId: randomUUID(), revision: 0 },
  saveLesson: { text: 'A lesson' },
};

// Every POST route of the shared route table, with a valid body where one is easy to form.
async function postEverything(origin: string, runId: string, nonce: string): Promise<{ name: RouteName; status: number; message: string }[]> {
  const names = Object.keys(ROUTES).filter((name): name is RouteName => Object.hasOwn(ROUTES, name)).filter((name) => ROUTES[name].method === 'POST');
  return Promise.all(
    names.map(async (name) => {
      const response = await fetch(`${origin}${routePath(name, { runId, notificationId: 'n-1' })}`, { method: 'POST', headers: { 'content-type': 'application/json', [SESSION_HEADER]: nonce }, body: JSON.stringify(POST_BODIES[name] ?? {}) });
      const body = z.object({ message: z.string().optional() }).parse(await response.json());
      return { name, status: response.status, message: body.message ?? '' };
    }),
  );
}

// TCP sockets the process holds, from lsof; the replay should hold only loopback HTTP sockets.
function tcpSockets(pid: number): string[] {
  try {
    return execFileSync('lsof', ['-nP', '-a', '-p', String(pid), '-iTCP'], { encoding: 'utf8' }).trim().split('\n').slice(1);
  } catch {
    return [];
  }
}

// Command lines of the process's children. The TypeScript loader keeps one esbuild helper; anything
// else, such as a codex app-server, would be a runtime the replay must never start.
function childCommands(pid: number): string[] {
  try {
    const children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    return children.map((child) => execFileSync('ps', ['-o', 'command=', '-p', child], { encoding: 'utf8' }).trim());
  } catch {
    return [];
  }
}

const captureHashes = () => Object.fromEntries(readdirSync(capture.dir).map((f) => [f, createHash('sha256').update(readFileSync(join(capture.dir, f))).digest('hex')]));

describe('demo:replay', () => {
  test('replay answers snapshot and events from the capture; every POST is rejected; it opens no DB, Codex or voice connection; replaying twice changes nothing', async () => {
    const runId = capture.manifest.runId;
    const hashesBefore = captureHashes();
    const dbBefore = { namespace: await store.countNamespace(runId), seed: await store.seedCounts() };
    const answers: unknown[] = [];

    for (let pass = 0; pass < 2; pass += 1) {
      const replay = await startReplayProcess(await freePort());
      try {
        const bootstrap = BootstrapSchema.parse((await getJson(replay.origin, routePath('bootstrap'))).body);
        assert.equal(bootstrap.mode, 'replay');
        assert.equal(bootstrap.captureId, capture.manifest.captureId);
        const run = await getJson(replay.origin, routePath('getRun', { runId }));
        assert.equal(run.status, 200);
        assert.deepEqual(run.body, JSON.parse(JSON.stringify(capture.snapshot)));
        const all = await getJson(replay.origin, `${routePath('runEvents', { runId })}?after=0`);
        assert.deepEqual(all.body, JSON.parse(JSON.stringify(capture.events)));
        const later = await getJson(replay.origin, `${routePath('runEvents', { runId })}?after=2`);
        assert.deepEqual(ROUTES.runEvents.response.parse(later.body).map((e) => e.seq), [3]);
        assert.equal((await getJson(replay.origin, routePath('getRun', { runId: 'test-replay-other' }))).status, 404);
        assert.equal((await fetch(`${replay.origin}/`)).status, 200);

        for (const post of await postEverything(replay.origin, runId, bootstrap.nonce)) {
          assert.ok(post.status >= 400 && post.status < 500, `${post.name} answered ${post.status}`);
          if (post.name in POST_BODIES) assert.deepEqual([post.status, post.message], [403, 'This is a read-only replay; it accepts no commands'], post.name);
        }
        const unsigned = await fetch(`${replay.origin}${routePath('createRun')}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(unsigned.status, 403);

        const sockets = tcpSockets(replay.pid);
        assert.ok(sockets.length > 0, 'lsof lists the replay listener');
        assert.deepEqual(sockets.filter((s) => s.includes(':17687') || s.includes(':17474')), [], 'no Neo4j connection');
        assert.deepEqual(sockets.filter((s) => s.split(/\s+/).some((field) => /^\d+\.\d+\.\d+\.\d+:\d+/.test(field) && !field.split('->').every((a) => a.startsWith('127.0.0.1:')))), [], 'no connection off loopback (no provider or voice session)');
        assert.deepEqual(childCommands(replay.pid).filter((command) => !/\/esbuild --service/.test(command)), [], 'no Codex or other child process');
        answers.push([bootstrap.captureId, run.body, all.body]);
      } finally {
        await replay.stop();
      }
    }

    assert.deepEqual(answers[1], answers[0]);
    assert.deepEqual(captureHashes(), hashesBefore);
    assert.deepEqual({ namespace: await store.countNamespace(runId), seed: await store.seedCounts() }, dbBefore);
  });

  test('a capture whose file no longer matches its manifest hash is refused', async () => {
    const copy = join(capturesDir, 'capture-tampered');
    execFileSync('cp', ['-R', capture.dir, copy]);
    const manifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8'));
    writeFileSync(join(copy, 'manifest.json'), JSON.stringify({ ...manifest, captureId: 'capture-tampered' }));
    writeFileSync(join(copy, 'events.json'), '[]\n');
    await assert.rejects(loadCapture('capture-tampered', capturesDir), /events\.json in capture capture-tampered does not match its manifest hash/);
  });

  test('replay refuses a port that is already listening', async () => {
    const { startReplay } = await import('../scripts/demo-replay.js');
    const busy = createServer();
    await new Promise<void>((resolve) => busy.listen(0, HOST, resolve));
    const address = busy.address();
    assert.ok(address !== null && typeof address !== 'string');
    try {
      await assert.rejects(startReplay({ captureId: capture.manifest.captureId, port: address.port, capturesDir, distDir: scratch }), /already in use/);
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  });
});
