import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HOST } from '../src/config.js';
import { loadSeed, type LoadedSeed } from '../src/dataset.js';
import { createRunId, Store } from '../src/store.js';
import { checkPurgeAllowed, PurgeRefused, purgeRun } from '../scripts/reset-live.js';

// Real local Neo4j, in this file's own run namespaces, removed in `after`.
const created: string[] = [];
let store: Store;
let seed: LoadedSeed;
let scratch = '';

const lessonDetected = (n: number) => ({ type: 'lesson.detected' as const, payload: { contentHash: `hash-${n}`, source: 'local_file' as const, bytes: n } });

async function runWithEvents(count: number): Promise<string> {
  const runId = createRunId('test-replay-purge');
  created.push(runId);
  await store.createRun({ runId, seed: 7 }, seed);
  await store.appendEvents(runId, Array.from({ length: count }, (_, i) => lessonDetected(i + 1)));
  return runId;
}

async function listeningPort(): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('No port was assigned');
  return { port: address.port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function freePort(): Promise<number> {
  const probe = await listeningPort();
  await probe.close();
  return probe.port;
}

before(async () => {
  store = await Store.connect();
  seed = loadSeed();
  scratch = mkdtempSync(join(tmpdir(), 'llime-replay-purge-'));
});

after(async () => {
  for (const runId of created) await store.resetRun(runId).catch(() => undefined);
  await store?.close();
  rmSync(scratch, { recursive: true, force: true });
});

describe('demo:purge', () => {
  test('purge refuses a missing or wildcard --run before touching the database', async () => {
    const port = await freePort();
    for (const runId of [undefined, '', '  ', '*', 'test-*', '%', '.*', '../x', 'a b']) {
      await assert.rejects(checkPurgeAllowed(runId, port), PurgeRefused, String(runId));
    }
  });

  test('purge refuses while the port is listening', async () => {
    const listening = await listeningPort();
    try {
      await assert.rejects(checkPurgeAllowed('test-replay-purge-run', listening.port), (error: unknown) => error instanceof PurgeRefused && error.message.includes(`listening on port ${listening.port}`));
    } finally {
      await listening.close();
    }
  });

  test('it deletes exactly one namespace (count 0) and keeps other runs, captures and seed counts', async () => {
    const target = await runWithEvents(3);
    const other = await runWithEvents(2);
    const capture = join(scratch, 'manifest.json');
    writeFileSync(capture, '{"captureId":"capture-kept"}\n');
    const captureHash = createHash('sha256').update(readFileSync(capture)).digest('hex');
    const otherBefore = await store.countNamespace(other);

    const runId = await checkPurgeAllowed(target, await freePort());
    const result = await purgeRun(store, runId);

    assert.equal(result.deleted.run, 1);
    assert.equal(result.deleted.events, 3);
    assert.equal(result.remaining.total, 0);
    assert.deepEqual(await store.countNamespace(target), result.remaining);
    assert.deepEqual(await store.countNamespace(other), otherBefore);
    assert.deepEqual(result.seedAfter, result.seedBefore);
    assert.equal(createHash('sha256').update(readFileSync(capture)).digest('hex'), captureHash);
  });

  test('an unknown run is refused and nothing is deleted', async () => {
    const seedBefore = await store.seedCounts();
    await assert.rejects(purgeRun(store, 'test-replay-purge-unknown'), (error: unknown) => error instanceof PurgeRefused && error.message.startsWith('Unknown run'));
    assert.deepEqual(await store.seedCounts(), seedBefore);
  });
});
