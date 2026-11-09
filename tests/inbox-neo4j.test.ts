import assert from 'node:assert/strict';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadSeed, type LoadedSeed } from '../src/dataset.js';
import { createInboxScanner, INBOX_STABILITY_WINDOW_MS, loadPreparedLesson, PREPARED_LESSON_DIR, saveTranscript } from '../src/inbox.js';
import { createRunId, Store } from '../src/store.js';

const TASK_ID = 'r-task_b0e8a5c5abb5';
const created: string[] = [];
let store: Store;
let seed: LoadedSeed;
let root: string;

before(async () => {
  store = await Store.connect();
  seed = loadSeed();
  await store.seed(seed);
  root = await mkdtemp(join(tmpdir(), 'llime-inbox-neo4j-'));
  await cp(fileURLToPath(new URL('../data/lesson/', import.meta.url)), join(root, PREPARED_LESSON_DIR), { recursive: true });
});

after(async () => {
  for (const runId of created) {
    await store.resetRun(runId);
    assert.equal((await store.countNamespace(runId)).total, 0);
  }
  await store.close();
  await rm(root, { recursive: true, force: true });
});

test('the prepared transcript saved twice commits one ingestion start and one lesson.detected (real Neo4j, mocked Codex turn)', async () => {
  const runId = createRunId(TASK_ID);
  created.push(runId);
  await store.createRun({ runId }, seed);
  const { prepared } = await loadPreparedLesson({ rootDir: root });
  assert.ok(prepared);

  let nowMs = 0;
  const turnsStarted: string[] = [];
  const scanner = createInboxScanner({
    rootDir: root,
    store,
    startIngestionTurn: async (id) => {
      turnsStarted.push(id);
    },
    now: () => nowMs,
  });
  const settle = async () => {
    await scanner.scanInbox();
    nowMs += INBOX_STABILITY_WINDOW_MS;
    // A file event and the periodic scan both see the stable file.
    await Promise.all([scanner.fileChanged(`${runId}.txt`), scanner.scanInbox()]);
  };

  await saveTranscript(runId, prepared.text, { rootDir: root });
  await settle();
  await saveTranscript(runId, prepared.text, { rootDir: root });
  await settle();

  // A fresh scanner stands in for a restart: the run already left WAITING, so nothing starts again.
  const restarted = createInboxScanner({ rootDir: root, store, startIngestionTurn: async (id) => void turnsStarted.push(id), now: () => nowMs });
  await restarted.scanInbox();
  nowMs += INBOX_STABILITY_WINDOW_MS;
  await restarted.scanInbox();

  assert.deepEqual(turnsStarted, [runId]);
  const run = await store.getRun(runId);
  assert.equal(run.state.phase, 'INGESTING');
  assert.equal(run.state.lesson?.text, prepared.text);
  assert.equal(run.state.lesson?.contentHash, prepared.sha256);

  const events = await store.events(runId);
  assert.deepEqual(
    events.map((e) => e.type),
    ['lesson.detected', 'state.committed'],
  );
  assert.deepEqual(events[0]?.payload, { contentHash: prepared.sha256, source: 'local_file', bytes: Buffer.byteLength(prepared.text) });
  assert.deepEqual(events[1]?.payload, { phase: 'INGESTING', revision: run.revision, caseIds: [] });
});
