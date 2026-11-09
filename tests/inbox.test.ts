import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { LessonRecord, RunPhase } from '../src/domain.js';
import {
  createInboxScanner,
  INBOX_DIR,
  INBOX_FILE_MAX_BYTES,
  INBOX_STABILITY_WINDOW_MS,
  type IngestionStore,
  type InboxOutcome,
  LessonSaveError,
  loadPreparedLesson,
  PREPARED_LESSON_DIR,
  PREPARED_LESSON_MISMATCH,
  PREPARED_LESSON_MISSING,
  readLesson,
  saveTranscript,
} from '../src/inbox.js';

const LESSON_DATA_DIR = fileURLToPath(new URL('../data/lesson/', import.meta.url));
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'llime-inbox-test-'));
  roots.push(root);
  return root;
}

async function rootWithPreparedLesson(): Promise<string> {
  const root = await tempRoot();
  await cp(LESSON_DATA_DIR, join(root, PREPARED_LESSON_DIR), { recursive: true });
  return root;
}

const inboxPath = (root: string, name: string) => join(root, INBOX_DIR, name);

async function writeInboxFile(root: string, name: string, content: string | Buffer): Promise<void> {
  await mkdir(join(root, INBOX_DIR), { recursive: true });
  await writeFile(inboxPath(root, name), content);
}

function testClock() {
  let nowMs = 1_000_000;
  return {
    now: () => nowMs,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

type StubRun = { revision: number; phase: RunPhase; stopped: boolean };

// An in-memory stand-in for the store's ingestion transition. Like the real transaction it replays a
// receipt for the same content key, rejects a stale revision and refuses any run that is not WAITING.
function stubIngestionStore(runs: Record<string, StubRun>, options: { failBeginTimes?: number } = {}) {
  const state = new Map(Object.entries(runs).map(([id, run]) => [id, { ...run }]));
  const receipts = new Set<string>();
  const committed: { runId: string; lesson: LessonRecord }[] = [];
  const log: string[] = [];
  let failuresLeft = options.failBeginTimes ?? 0;
  const domainError = (code: string, message: string) => Object.assign(new Error(message), { code });
  const store: IngestionStore = {
    async getRun(runId) {
      const run = state.get(runId);
      if (!run) throw domainError('NOT_FOUND', `Run ${runId} not found`);
      return { revision: run.revision, state: { phase: run.phase, stopped: run.stopped } };
    },
    async beginIngestion(runId, input) {
      log.push(`begin:${runId}`);
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error('Neo4j unavailable');
      }
      const run = state.get(runId);
      if (!run) throw domainError('NOT_FOUND', `Run ${runId} not found`);
      const key = `${runId}:${input.lesson.contentHash}`;
      if (receipts.has(key)) return { replayed: true };
      if (run.revision !== input.expectedRevision) throw domainError('STALE_REVISION', 'stale');
      if (run.phase !== 'WAITING' || run.stopped) throw domainError('WRONG_PHASE', 'not waiting');
      run.phase = 'INGESTING';
      run.revision += 1;
      receipts.add(key);
      committed.push({ runId, lesson: input.lesson });
      log.push(`committed:${runId}`);
      return { replayed: false };
    },
  };
  return { store, committed, log, state };
}

function stubTurn(log: string[] = []) {
  const started: string[] = [];
  const startIngestionTurn = async (runId: string) => {
    log.push(`turn:${runId}`);
    started.push(runId);
  };
  return { started, startIngestionTurn };
}

const RUN_A = '3f1c9b6e-2d4a-4c1e-9a0b-7e5d1c2b3a40';
const RUN_B = '8a2d4f60-1b3c-4e5d-8f70-9a1b2c3d4e50';
const waiting = (): StubRun => ({ revision: 0, phase: 'WAITING', stopped: false });

async function scannerFor(root: string, runs: Record<string, StubRun>, options: { failBeginTimes?: number } = {}) {
  const clock = testClock();
  const ingestion = stubIngestionStore(runs, options);
  const turn = stubTurn(ingestion.log);
  const scanner = createInboxScanner({ rootDir: root, store: ingestion.store, startIngestionTurn: turn.startIngestionTurn, now: clock.now });
  // Two checks a full stability window apart: the earliest a complete file can be accepted.
  const settle = async (): Promise<InboxOutcome[]> => {
    const first = await scanner.scanInbox();
    clock.advance(INBOX_STABILITY_WINDOW_MS);
    return [...first, ...(await scanner.scanInbox())];
  };
  return { scanner, clock, ingestion, turn, settle };
}

describe('saving a lesson transcript', () => {
  test('saveTranscript writes through a temp file and rename; a reader never sees a partial file; 16,385 bytes is rejected', async () => {
    const root = await tempRoot();
    const finalPath = inboxPath(root, `${RUN_A}.txt`);

    await saveTranscript(RUN_A, 'First lesson text.', { rootDir: root });
    const before = await stat(finalPath);
    const earlyReader = await open(finalPath, 'r');
    try {
      const largest = 'a'.repeat(INBOX_FILE_MAX_BYTES);
      const saved = await saveTranscript(RUN_A, largest, { rootDir: root });

      // A rename swaps in a new file; an in-place rewrite would keep the inode and expose a partial file.
      const afterSave = await stat(finalPath);
      assert.notEqual(afterSave.ino, before.ino);
      assert.equal((await earlyReader.readFile()).toString('utf8'), 'First lesson text.');
      assert.equal(await readFile(finalPath, 'utf8'), largest);
      assert.equal(saved.contentHash, sha256(largest));
      assert.deepEqual(await readdir(join(root, INBOX_DIR)), [`${RUN_A}.txt`]);
    } finally {
      await earlyReader.close();
    }

    const tooLarge = 'a'.repeat(INBOX_FILE_MAX_BYTES + 1);
    await assert.rejects(saveTranscript(RUN_A, tooLarge, { rootDir: root }), (error) => error instanceof LessonSaveError && error.code === 'PAYLOAD_TOO_LARGE');
    // Multi-byte characters count as bytes, not characters: 5,462 three-byte characters are 16,386 bytes.
    await assert.rejects(saveTranscript(RUN_A, '가'.repeat(5_462), { rootDir: root }), (error) => error instanceof LessonSaveError && error.code === 'PAYLOAD_TOO_LARGE');
    await assert.rejects(saveTranscript(RUN_A, '   \n', { rootDir: root }), (error) => error instanceof LessonSaveError && error.code === 'INVALID_INPUT');
    await assert.rejects(saveTranscript('../escape', 'text', { rootDir: root }), (error) => error instanceof LessonSaveError && error.code === 'INVALID_INPUT');
    assert.equal((await readFile(finalPath, 'utf8')).length, INBOX_FILE_MAX_BYTES);
    assert.deepEqual(await readdir(join(root, INBOX_DIR)), [`${RUN_A}.txt`]);
  });

  test('the prepared transcript saved unchanged hashes to data/lesson/manifest.json', async () => {
    const root = await rootWithPreparedLesson();
    const manifest: { sha256: string; bytes: number } = JSON.parse(await readFile(join(LESSON_DATA_DIR, 'manifest.json'), 'utf8'));
    const { prepared, problem } = await loadPreparedLesson({ rootDir: root });
    assert.equal(problem, null);
    assert.ok(prepared);
    assert.equal(prepared.sha256, manifest.sha256);

    const unsaved = await readLesson(RUN_A, { rootDir: root, prepared });
    assert.deepEqual(unsaved, { inboxFile: inboxPath(root, `${RUN_A}.txt`), saved: false, contentHash: null, prepared });

    const saved = await saveTranscript(RUN_A, prepared.text, { rootDir: root });
    assert.equal(saved.contentHash, manifest.sha256);
    assert.equal((await stat(inboxPath(root, `${RUN_A}.txt`))).size, manifest.bytes);
    assert.deepEqual(await readLesson(RUN_A, { rootDir: root, prepared }), { inboxFile: inboxPath(root, `${RUN_A}.txt`), saved: true, contentHash: manifest.sha256, prepared });
  });

  test('an edited or missing prepared transcript is not offered', async () => {
    const root = await rootWithPreparedLesson();
    const transcript = join(root, PREPARED_LESSON_DIR, 'lesson-transcript.txt');
    const original = await readFile(transcript, 'utf8');

    await writeFile(transcript, `${original} edited`);
    assert.deepEqual(await loadPreparedLesson({ rootDir: root }), { prepared: null, problem: PREPARED_LESSON_MISMATCH });
    await rm(transcript);
    assert.deepEqual(await loadPreparedLesson({ rootDir: root }), { prepared: null, problem: PREPARED_LESSON_MISSING });
  });
});

describe('inbox watcher (stubbed store transition and turn)', () => {
  test('a file is accepted only after two unchanged checks a full stability window apart', async () => {
    const root = await tempRoot();
    const { scanner, clock, turn } = await scannerFor(root, { [RUN_A]: waiting() });
    await writeInboxFile(root, `${RUN_A}.txt`, 'Today we made ten.');

    await scanner.scanInbox();
    clock.advance(INBOX_STABILITY_WINDOW_MS - 1);
    await scanner.scanInbox();
    assert.deepEqual(turn.started, []);

    clock.advance(1);
    await scanner.scanInbox();
    assert.deepEqual(turn.started, [RUN_A]);
  });

  test('a growing file, a temp name, a non-.txt file and invalid UTF-8 never start ingestion', async () => {
    const root = await tempRoot();
    const { scanner, clock, ingestion, turn } = await scannerFor(root, { [RUN_A]: waiting(), [RUN_B]: waiting() });
    await writeInboxFile(root, `.${RUN_A}.0b1e.tmp`, 'A temporary save.');
    await writeInboxFile(root, `${RUN_A}.md`, 'Not a transcript.');
    await writeInboxFile(root, `${RUN_B}.txt`, Buffer.from([0x54, 0x6f, 0xff, 0xfe, 0x64]));

    // Each check sees the file a little longer than the check before, a full window later.
    const outcomes: InboxOutcome[] = [];
    const growing = await open(inboxPath(root, `${RUN_A}.txt`), 'w');
    try {
      for (const chunk of ['Today ', 'we ', 'made ', 'ten.']) {
        await growing.write(chunk);
        clock.advance(INBOX_STABILITY_WINDOW_MS);
        outcomes.push(...(await scanner.scanInbox()));
      }
    } finally {
      await growing.close();
    }
    assert.deepEqual(outcomes, [{ kind: 'rejected', fileName: `${RUN_B}.txt`, reason: 'invalid_utf8' }]);
    assert.equal(ingestion.committed.length, 0);
    assert.equal(turn.started.length, 0);

    // Once it stops growing, the same file is complete and starts exactly one ingestion.
    clock.advance(INBOX_STABILITY_WINDOW_MS);
    await scanner.scanInbox();
    assert.deepEqual(turn.started, [RUN_A]);
    assert.equal(ingestion.committed[0]?.lesson.text, 'Today we made ten.');
    assert.equal(ingestion.state.get(RUN_B)?.phase, 'WAITING');
  });

  test('a file over the byte limit or empty never starts ingestion', async () => {
    const root = await tempRoot();
    const { ingestion, settle } = await scannerFor(root, { [RUN_A]: waiting(), [RUN_B]: waiting() });
    await writeInboxFile(root, `${RUN_A}.txt`, 'a'.repeat(INBOX_FILE_MAX_BYTES + 1));
    await writeInboxFile(root, `${RUN_B}.txt`, ' \n\t');

    const outcomes = await settle();
    assert.deepEqual(new Set(outcomes), new Set([
      { kind: 'rejected', fileName: `${RUN_A}.txt`, reason: 'too_large' },
      { kind: 'rejected', fileName: `${RUN_B}.txt`, reason: 'empty' },
    ]));
    assert.deepEqual(ingestion.committed, []);
  });

  test('an unreadable file is reported and does not hold up other runs', async () => {
    const root = await tempRoot();
    const { ingestion, turn, settle } = await scannerFor(root, { [RUN_A]: waiting(), [RUN_B]: waiting() });
    await saveTranscript(RUN_A, 'Nobody may read this.', { rootDir: root });
    await chmod(inboxPath(root, `${RUN_A}.txt`), 0o000);
    await saveTranscript(RUN_B, 'Today we made ten.', { rootDir: root });

    const outcomes = await settle();
    assert.deepEqual(outcomes, [
      { kind: 'rejected', fileName: `${RUN_A}.txt`, reason: 'unreadable' },
      { kind: 'ingestion_started', runId: RUN_B, contentHash: sha256('Today we made ten.') },
    ]);
    assert.deepEqual(turn.started, [RUN_B]);
    assert.equal(ingestion.state.get(RUN_A)?.phase, 'WAITING');
  });

  test('the same content twice for one run starts one turn', async () => {
    const root = await tempRoot();
    const { ingestion, turn, settle } = await scannerFor(root, { [RUN_A]: waiting() });

    await saveTranscript(RUN_A, 'Today we made ten.', { rootDir: root });
    await settle();
    await saveTranscript(RUN_A, 'Today we made ten.', { rootDir: root });
    const second = await settle();

    assert.deepEqual(turn.started, [RUN_A]);
    assert.equal(ingestion.committed.length, 1);
    assert.deepEqual(second, [{ kind: 'ignored', fileName: `${RUN_A}.txt`, reason: 'duplicate' }]);
  });

  test('a file event and a scan of the same file start one turn', async () => {
    const root = await tempRoot();
    const { scanner, clock, ingestion, turn } = await scannerFor(root, { [RUN_A]: waiting() });
    await saveTranscript(RUN_A, 'Today we made ten.', { rootDir: root });

    await scanner.fileChanged(`${RUN_A}.txt`);
    clock.advance(INBOX_STABILITY_WINDOW_MS);
    const [fromEvent, fromScan] = await Promise.all([scanner.fileChanged(`${RUN_A}.txt`), scanner.scanInbox()]);

    assert.deepEqual([...fromEvent, ...fromScan], [{ kind: 'ingestion_started', runId: RUN_A, contentHash: sha256('Today we made ten.') }]);
    assert.deepEqual(turn.started, [RUN_A]);
    assert.deepEqual(ingestion.log.filter((entry) => entry.startsWith('begin:')), [`begin:${RUN_A}`]);
  });

  test('a file saved while the server was down starts one turn on the restart scan', async () => {
    const root = await tempRoot();
    await saveTranscript(RUN_A, 'Saved while the server was down.', { rootDir: root });

    const restarted = await scannerFor(root, { [RUN_A]: waiting() });
    const outcomes = await restarted.settle();
    assert.deepEqual(outcomes, [{ kind: 'ingestion_started', runId: RUN_A, contentHash: sha256('Saved while the server was down.') }]);
    assert.deepEqual(restarted.turn.started, [RUN_A]);

    // A crash after the transition committed leaves the run INGESTING; the next restart starts nothing.
    const afterCrash = await scannerFor(root, { [RUN_A]: { revision: 1, phase: 'INGESTING', stopped: false } });
    await afterCrash.settle();
    assert.deepEqual(afterCrash.turn.started, []);
    assert.deepEqual(afterCrash.ingestion.log, []);
  });

  test('an unknown run, or a run not in WAITING, is ignored', async () => {
    const root = await tempRoot();
    const RUN_STOPPED = 'c4d5e6f7-0a1b-4c2d-9e3f-4a5b6c7d8e90';
    const { ingestion, turn, settle } = await scannerFor(root, {
      [RUN_B]: { revision: 4, phase: 'INVITED', stopped: false },
      [RUN_STOPPED]: { revision: 1, phase: 'WAITING', stopped: true },
    });
    await saveTranscript(RUN_A, 'No such run.', { rootDir: root });
    await saveTranscript(RUN_B, 'Already invited.', { rootDir: root });
    await saveTranscript(RUN_STOPPED, 'Stopped before the lesson.', { rootDir: root });

    const outcomes = await settle();
    assert.deepEqual(new Set(outcomes), new Set([
      { kind: 'ignored', fileName: `${RUN_A}.txt`, reason: 'unknown_run' },
      { kind: 'ignored', fileName: `${RUN_B}.txt`, reason: 'not_waiting' },
      { kind: 'ignored', fileName: `${RUN_STOPPED}.txt`, reason: 'not_waiting' },
    ]));
    assert.deepEqual(ingestion.committed, []);
    assert.deepEqual(turn.started, []);
  });

  test('a run that leaves WAITING between the read and the transition starts no turn', async () => {
    const root = await tempRoot();
    const { scanner, clock, ingestion, turn } = await scannerFor(root, { [RUN_A]: waiting() });
    await saveTranscript(RUN_A, 'Today we made ten.', { rootDir: root });
    await scanner.scanInbox();
    clock.advance(INBOX_STABILITY_WINDOW_MS);

    // Another writer commits first: the transition finds the run INGESTING and changes nothing.
    const run = ingestion.state.get(RUN_A);
    assert.ok(run);
    const realGetRun = ingestion.store.getRun;
    ingestion.store.getRun = async (runId) => {
      const read = await realGetRun(runId);
      run.phase = 'INGESTING';
      return read;
    };
    const outcomes = await scanner.scanInbox();

    assert.deepEqual(outcomes, [{ kind: 'ignored', fileName: `${RUN_A}.txt`, reason: 'not_waiting' }]);
    assert.deepEqual(turn.started, []);
  });

  test('the turn starts only after the transition commits; a failed transition starts none', async () => {
    const root = await tempRoot();
    const { scanner, clock, ingestion, turn } = await scannerFor(root, { [RUN_A]: waiting() }, { failBeginTimes: 1 });
    await saveTranscript(RUN_A, 'Today we made ten.', { rootDir: root });
    await scanner.scanInbox();
    clock.advance(INBOX_STABILITY_WINDOW_MS);

    const failed = await scanner.scanInbox();
    assert.deepEqual(failed, [{ kind: 'deferred', fileName: `${RUN_A}.txt`, reason: 'Neo4j unavailable' }]);
    assert.deepEqual(turn.started, []);
    assert.equal(ingestion.state.get(RUN_A)?.phase, 'WAITING');

    // Nothing committed, so the next scan may try again; this time the commit lands before the turn.
    await scanner.scanInbox();
    assert.deepEqual(ingestion.log, [`begin:${RUN_A}`, `begin:${RUN_A}`, `committed:${RUN_A}`, `turn:${RUN_A}`]);
  });

  test('a replayed transition receipt starts no second turn', async () => {
    const root = await tempRoot();
    const { scanner, clock, ingestion, turn } = await scannerFor(root, { [RUN_A]: waiting() });
    await saveTranscript(RUN_A, 'Today we made ten.', { rootDir: root });
    // An earlier caller already committed this content; the store answers with its receipt.
    ingestion.store.beginIngestion = async () => ({ replayed: true });
    await scanner.scanInbox();
    clock.advance(INBOX_STABILITY_WINDOW_MS);

    const outcomes = await scanner.scanInbox();
    assert.deepEqual(outcomes, [{ kind: 'ignored', fileName: `${RUN_A}.txt`, reason: 'already_started' }]);
    assert.deepEqual(turn.started, []);
  });
});
