import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HOST, parseConfig } from '../src/config.js';
import { loadSeed, type LoadedSeed } from '../src/dataset.js';
import { type RunEvent, RunSnapshotSchema } from '../src/events.js';
import { ROUTES, routePath } from '../src/routes.js';
import { bootServer, type RunningServer, type ServerPorts } from '../src/server.js';
import { createRunId, Store } from '../src/store.js';

// Real local Neo4j; the routes read persisted runs and events. Modules this suite does not exercise
// are bound to stand-ins that fail loudly if a route reaches them.
const config = parseConfig({ PORT: '4980', VITE_PORT: '4981', STORYBOOK_PORT: '4982' });
const created: string[] = [];
let store: Store;
let seed: LoadedSeed;
let dist = '';

const unexpected = (name: string) => async (): Promise<never> => {
  throw new Error(`${name} must not be called by this suite`);
};

function portsFor(runStore: ServerPorts['store']): ServerPorts {
  return {
    store: runStore,
    engine: {
      createRun: unexpected('engine.createRun'),
      command: unexpected('engine.command'),
      voiceCommand: unexpected('engine.voiceCommand'),
      recoverInterrupted: async () => ({ cleanupRunIds: [] }),
      settle: async () => {},
    },
    lessons: { readLesson: unexpected('lessons.readLesson'), saveTranscript: unexpected('lessons.saveTranscript') },
    voice: { createSession: unexpected('voice.createSession'), snapshot: unexpected('voice.snapshot'), command: unexpected('voice.command'), closeRun: async () => {} },
    runtime: { interruptRun: async () => {}, interruptActiveTurns: async () => {}, close: async () => {} },
    startInbox: async () => ({ stop: async () => {} }),
    startOutbox: async () => ({ stop: async () => {} }),
  };
}

// The store stays open across tests, so shutdown leaves it to the suite.
const keepOpen = (runStore: ServerPorts['store']): ServerPorts['store'] => ({ ...bindStore(runStore), close: async () => {} });
function bindStore(runStore: ServerPorts['store']): ServerPorts['store'] {
  return {
    getRun: (runId) => runStore.getRun(runId),
    events: (runId, after) => runStore.events(runId, after),
    getNotification: (id) => runStore.getNotification(id),
    appendEvents: (runId, events) => runStore.appendEvents(runId, events),
    close: () => runStore.close(),
  };
}

async function boot(runStore: ServerPorts['store']): Promise<RunningServer> {
  const running = await bootServer(portsFor(keepOpen(runStore)), { config, nonce: 'neo4j-suite-nonce', frontend: { kind: 'static', distDir: dist }, dataset: 'synthetic', listenPort: 0, signals: new EventEmitter() });
  await running.ready;
  return running;
}

function get(server: RunningServer, path: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port: server.port, path, agent: false, headers: { host: `${HOST}:${config.port}` } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const seqsOf = (body: unknown) => ROUTES.runEvents.response.parse(body).map((e) => e.seq);
const lessonDetected = (n: number) => ({ type: 'lesson.detected' as const, payload: { contentHash: `hash-${n}`, source: 'local_file' as const, bytes: n } });

async function runWithEvents(count: number): Promise<string> {
  const runId = createRunId('test-server-neo4j');
  created.push(runId);
  await store.createRun({ runId, seed: 7 }, seed);
  await store.appendEvents(runId, Array.from({ length: count }, (_, i) => lessonDetected(i + 1)));
  return runId;
}

before(async () => {
  store = await Store.connect();
  seed = loadSeed();
  await store.seed(seed);
  dist = mkdtempSync(join(tmpdir(), 'llime-neo4j-routes-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>llime</title>');
});

after(async () => {
  for (const runId of created) {
    await store.resetRun(runId);
    assert.equal((await store.countNamespace(runId)).total, 0);
  }
  await store.close();
  rmSync(dist, { recursive: true, force: true });
});

describe('snapshot and polling on the real store', () => {
  test('snapshot throughSeq equals seq and excludes events appended during the read (real Neo4j)', async () => {
    const runId = await runWithEvents(3);
    // Another writer commits an event right after the run row was read and before its events are.
    const racing = bindStore(store);
    let appended: RunEvent[] = [];
    racing.getRun = async (id) => {
      const record = await store.getRun(id);
      appended = await store.appendEvents(id, [lessonDetected(4)]);
      return record;
    };
    const server = await boot(racing);
    try {
      const reply = await get(server, routePath('getRun', { runId }));
      assert.equal(reply.status, 200);
      const snapshot = RunSnapshotSchema.parse(reply.body);
      assert.deepEqual([snapshot.seq, snapshot.execution.throughSeq], [3, 3]);
      assert.deepEqual(snapshot.execution.events.map((e) => e.seq), [1, 2, 3]);
      assert.deepEqual(appended.map((e) => e.seq), [4], 'the racing event was committed');
      const later = await get(server, `${routePath('runEvents', { runId })}?after=${snapshot.seq}`);
      assert.deepEqual(seqsOf(later.body), [4], 'polling from the snapshot seq returns the excluded event');
    } finally {
      await server.shutdown();
    }
  });

  test('events?after=N reads persisted events in seq order, and a repeated cursor returns the same events (real Neo4j)', async () => {
    const runId = await runWithEvents(4);
    const server = await boot(store);
    try {
      const all = await get(server, `${routePath('runEvents', { runId })}?after=0`);
      assert.deepEqual(seqsOf(all.body), [1, 2, 3, 4]);
      const fromTwo = await get(server, `${routePath('runEvents', { runId })}?after=2`);
      assert.deepEqual(seqsOf(fromTwo.body), [3, 4]);
      assert.deepEqual((await get(server, `${routePath('runEvents', { runId })}?after=2`)).body, fromTwo.body);
      const snapshot = RunSnapshotSchema.parse((await get(server, routePath('getRun', { runId }))).body);
      assert.deepEqual([snapshot.seq, snapshot.execution.throughSeq, snapshot.execution.events.length], [4, 4, 4]);
      assert.equal((await get(server, routePath('getRun', { runId: createRunId('test-server-neo4j-missing') }))).status, 404);
    } finally {
      await server.shutdown();
    }
  });
});
