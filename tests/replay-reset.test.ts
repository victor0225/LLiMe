import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HOST, parseConfig } from '../src/config.js';
import { loadSeed } from '../src/dataset.js';
import type { RunPhase } from '../src/domain.js';
import { createEngine } from '../src/engine.js';
import { routePath, SESSION_HEADER } from '../src/routes.js';
import { bootServer, type RunningServer } from '../src/server.js';
import { FILM_SEED } from '../src/problems.js';
import { createRunId, Store } from '../src/store.js';
import { isRunActive, ResetRefused, resetRun } from '../scripts/demo-reset.js';

// Real local Neo4j and the real route handlers; the Codex runtime is a stub (mocked Codex), since
// creating and stopping a run never starts a model turn.
const NONCE = 'replay-reset-suite-nonce';
const created: string[] = [];
let store: Store;
let server: RunningServer;
let origin = '';
let scratch = '';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, HOST, resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No port was assigned');
  return address.port;
}

const stubRuntime = { startTurn: async () => {}, steerTurn: async () => false, interruptTurn: async () => {}, closeVoice: async () => {} };

before(async () => {
  store = await Store.connect();
  const corpus = loadSeed();
  scratch = mkdtempSync(join(tmpdir(), 'llime-replay-reset-'));
  writeFileSync(join(scratch, 'index.html'), '<!doctype html><title>llime</title>');
  const config = parseConfig({ PORT: String(await freePort()) });
  origin = config.appOrigin;
  server = await bootServer(
    {
      store: { getRun: (id) => store.getRun(id), events: (id, after) => store.events(id, after), getNotification: (id) => store.getNotification(id), appendEvents: (id, events) => store.appendEvents(id, events), close: async () => {} },
      createRun: async (input) => {
        const runId = createRunId('test-replay-reset');
        created.push(runId);
        return store.createRun({ runId, ...input }, corpus);
      },
      lessons: { readLesson: async () => assert.fail('reset reads no lesson'), saveTranscript: async () => assert.fail('reset saves no lesson') },
      // Restart recovery reconciles every run in the shared database; this suite boots no real
      // restart, so it must not interrupt a live run another process is working on.
      engine: { ...createEngine({ store, runtime: stubRuntime }), recoverInterrupted: async () => ({ interrupted: [], cleaned: [] }) },
      startInbox: async () => ({ stop: async () => {} }),
      startOutbox: async () => ({ stop: async () => {} }),
    },
    { config, nonce: NONCE, frontend: { kind: 'static', distDir: scratch }, dataset: 'synthetic', signals: new EventEmitter() },
  );
  await server.ready;
});

after(async () => {
  await server?.shutdown();
  for (const runId of created) await store.resetRun(runId).catch(() => undefined);
  await store?.close();
  rmSync(scratch, { recursive: true, force: true });
});

// The operator's supported stop control: the stop_learning command on the run.
async function stopLearning(runId: string): Promise<void> {
  const { revision } = await store.getRun(runId);
  const response = await fetch(`${origin}${routePath('runCommand', { runId })}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: NONCE },
    body: JSON.stringify({ type: 'stop_learning', commandId: randomUUID(), revision }),
  });
  assert.equal(response.status, 200, await response.text());
}

describe('demo:reset (real Neo4j, real routes, stub runtime)', () => {
  test('reset prints a new runId each time; earlier runs keep their events', async () => {
    const operatorRunFile = join(scratch, 'new-each-time', 'operator-run.json');
    const first = await resetRun({ origin, caseName: 'main', seed: 7, operatorRunFile });
    await stopLearning(first.runId);
    const firstEvents = await store.events(first.runId, 0);
    assert.ok(firstEvents.length > 0, 'stopping the first run commits an event');

    const second = await resetRun({ origin, caseName: 'main', seed: 7, operatorRunFile });
    assert.notEqual(second.runId, first.runId);
    assert.equal(second.seed, 7);
    assert.deepEqual(await store.events(first.runId, 0), firstEvents);
    assert.equal((await store.getRun(first.runId)).state.stopped, true);
    assert.equal((await store.getRun(second.runId)).state.phase, 'WAITING');
    await stopLearning(second.runId);
  });

  test('reset is refused while the previous run is active and not stopped', async () => {
    const operatorRunFile = join(scratch, 'refused', 'operator-run.json');
    const active = await resetRun({ origin, caseName: 'main', operatorRunFile });
    const runsBefore = created.length;
    await assert.rejects(resetRun({ origin, caseName: 'contrast', operatorRunFile }), (error: unknown) => error instanceof ResetRefused && error.message.includes(`run ${active.runId} is still active (phase WAITING)`));
    assert.equal(created.length, runsBefore, 'a refused reset creates no run');

    await stopLearning(active.runId);
    const next = await resetRun({ origin, caseName: 'contrast', operatorRunFile });
    assert.notEqual(next.runId, active.runId);
    await stopLearning(next.runId);
  });

  test('the main case without --seed creates its run with the film seed', async () => {
    const operatorRunFile = join(scratch, 'film-seed', 'operator-run.json');
    const run = await resetRun({ origin, caseName: 'main', operatorRunFile });
    assert.equal(run.seed, FILM_SEED);
    assert.equal((await store.getRun(run.runId)).state.seed, FILM_SEED);
    await stopLearning(run.runId);
  });

  test('a purged previous run no longer blocks a reset', async () => {
    const operatorRunFile = join(scratch, 'purged', 'operator-run.json');
    const purged = await resetRun({ origin, caseName: 'main', operatorRunFile });
    await store.resetRun(purged.runId);
    const next = await resetRun({ origin, caseName: 'main', operatorRunFile });
    assert.notEqual(next.runId, purged.runId);
    await stopLearning(next.runId);
  });
});

describe('isRunActive', () => {
  const state = (phase: RunPhase, overrides: { stopped?: boolean; continuationAllowed?: boolean } = {}) => ({ phase, stopped: false, continuationAllowed: false, ...overrides });

  test('a run is active in every phase that still has a way forward', () => {
    for (const phase of ['WAITING', 'INGESTING', 'INVITED', 'INITIAL', 'EXPLAIN', 'PROCESSING', 'CLARIFY', 'PRACTICE', 'VERIFY'] as const) assert.equal(isRunActive(state(phase)), true, phase);
  });

  test('a run in a final phase is not active', () => {
    for (const phase of ['NO_MATCH', 'ALREADY_CORRECT', 'OUT_OF_SCOPE', 'COMPLETE', 'ERROR'] as const) assert.equal(isRunActive(state(phase)), false, phase);
  });

  test('NEEDS_SUPPORT is active only while continuation is allowed', () => {
    assert.equal(isRunActive(state('NEEDS_SUPPORT', { continuationAllowed: true })), true);
    assert.equal(isRunActive(state('NEEDS_SUPPORT', { continuationAllowed: false })), false);
  });

  test('a stopped run is not active in any phase', () => {
    assert.equal(isRunActive(state('PROCESSING', { stopped: true })), false);
  });
});
