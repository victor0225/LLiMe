import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import { loadSeed, type LoadedSeed } from '../src/dataset.js';
import type { Activity, NotificationOutbox } from '../src/domain.js';
import { createRunId, DomainError, Store, type TransitionContext } from '../src/store.js';

// Every run these tests create lives in a namespace of its own and is removed in `after`. The shared
// seed nodes are never deleted, and no test writes a Case.
const TASK_ID = 'd-task_c9edd4ffd032';
const created: string[] = [];

let store: Store;
let seed: LoadedSeed;

before(async () => {
  store = await Store.connect();
  seed = loadSeed();
  await store.seed(seed);
});

after(async () => {
  for (const runId of created) {
    try {
      await store.resetRun(runId);
    } catch (error) {
      if (!(error instanceof DomainError && error.code === 'NOT_FOUND')) throw error;
    }
    assert.equal((await store.countNamespace(runId)).total, 0, `namespace ${runId} is empty`);
  }
  await store.close();
});

async function newRun(): Promise<string> {
  const runId = createRunId(TASK_ID);
  created.push(runId);
  await store.createRun({ runId }, seed);
  return runId;
}

const invitation = (runId: string): Activity => ({
  id: `${runId}_invitation`,
  revision: 1,
  runId,
  kind: 'invitation',
  templateId: 'invitation_addition',
  strategy: null,
  problem: null,
  title: 'A little challenge for you',
  body: 'Want to try?',
  primaryLabel: 'Let’s try',
  secondaryLabel: 'Later',
  activitySpec: null,
  specHash: null,
  helperCount: 0,
  evidenceIds: [],
  decisionSummary: 'test activity',
});

const outboxFor = (runId: string, activityId: string, notificationId: string): NotificationOutbox => ({
  notificationId,
  runId,
  activityId,
  activityRevision: 1,
  transport: 'simulator',
  status: 'pending',
  attemptCount: 0,
  createdAt: '2026-11-09T10:00:00.000Z',
  lastErrorCode: null,
});

const receiptSchema = z.object({ marker: z.string() });

describe('seeding', () => {
  test('seeding twice leaves four Concept nodes, one CONCEPT_LINK {kind:similar} and two SUBCONCEPT_OF edges', async () => {
    await store.seed(seed);
    const first = await store.seedCounts();
    const report = await store.seed(seed);
    const second = await store.seedCounts();
    assert.equal(report.written, 0);
    assert.deepEqual(second, first);
    assert.equal(second.concepts, 4);
    assert.equal(second.conceptLinks, 1);
    assert.equal(second.subconceptEdges, 2);
    assert.equal(second.cases, 781);
    assert.equal(second.students, 120);
    const links = await store.getConceptLinks();
    assert.deepEqual(links.map((l) => [l.from, l.to, l.kind]).sort(), seed.conceptLinks.map((l) => [l.from, l.to, l.kind]).sort());
  });

  test('a case ID with a different hash is rejected before any write', async () => {
    const before = await store.seedCounts();
    const [first, ...rest] = seed.cases;
    assert.ok(first);
    const altered = { ...seed, cases: [{ ...first, createdAt: '2031-01-01T00:00:00.000Z' }, ...rest] };
    await assert.rejects(store.seed(altered), (error) => error instanceof DomainError && error.code === 'CONFLICT' && error.message.includes(first.id));
    assert.deepEqual(await store.seedCounts(), before);
  });
});

describe('runs', () => {
  test('a new run pins corpus IDs and corpusHash', async () => {
    const runId = await newRun();
    const pinned = await store.getPinnedCorpus(runId);
    assert.equal(pinned.corpusHash, seed.manifest.sha256);
    assert.deepEqual(pinned.caseIds, seed.cases.map((c) => c.id).sort());
    const run = await store.getRun(runId);
    assert.equal(run.state.corpusHash, seed.manifest.sha256);
    assert.equal(run.state.phase, 'WAITING');
    assert.equal(run.revision, 0);
    assert.equal(run.seq, 0);
    assert.equal(run.state.studentId, 'student_7');
  });

  test('a supplied seed is stored once and a missing one is generated', async () => {
    const supplied = createRunId(TASK_ID);
    created.push(supplied);
    assert.equal((await store.createRun({ runId: supplied, seed: 28 }, seed)).state.seed, 28);
    const generated = await newRun();
    const value = (await store.getRun(generated)).state.seed;
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 0xffffffff);
    assert.equal((await store.getRun(generated)).state.seed, value);
  });

  test('reset deletes exactly one run namespace and leaves other runs and the seed intact', async () => {
    const doomed = await newRun();
    const kept = await newRun();
    for (const runId of [doomed, kept]) {
      const activity = invitation(runId);
      await store.transition({
        runId,
        commandKey: 'setup',
        body: { runId },
        expectedRevision: 0,
        resultSchema: receiptSchema,
        apply: (context) => ({
          state: { ...context.state, phase: 'INGESTING' },
          events: [],
          activities: [activity],
          outbox: [outboxFor(runId, activity.id, `${runId}_n1`)],
          result: { marker: runId },
        }),
      });
    }
    const seedBefore = await store.seedCounts();
    const keptBefore = await store.countNamespace(kept);
    assert.ok(keptBefore.total > 0);

    const removed = await store.resetRun(doomed);

    assert.equal(removed.run, 1);
    assert.equal(removed.commands, 1);
    assert.equal(removed.activities, 1);
    assert.equal(removed.outbox, 1);
    assert.equal((await store.countNamespace(doomed)).total, 0);
    assert.deepEqual(await store.countNamespace(kept), keptBefore);
    assert.deepEqual(await store.seedCounts(), seedBefore);
    await assert.rejects(store.getRun(doomed), (error) => error instanceof DomainError && error.code === 'NOT_FOUND');
  });

  test('an unknown run is a not-found error', async () => {
    const missing = createRunId(TASK_ID);
    const notFound = (error: unknown) => error instanceof DomainError && error.code === 'NOT_FOUND';
    await assert.rejects(store.getRun(missing), notFound);
    await assert.rejects(store.events(missing), notFound);
    await assert.rejects(store.resetRun(missing), notFound);
    await assert.rejects(
      store.transition({ runId: missing, commandKey: 'x', body: {}, expectedRevision: 0, resultSchema: receiptSchema, apply: (c) => ({ state: c.state, events: [], result: { marker: 'x' } }) }),
      notFound,
    );
  });
});

describe('transitions', () => {
  test('state, events and command receipt commit together; a throw rolls all back', async () => {
    const runId = await newRun();
    const activity = invitation(runId);
    await assert.rejects(
      store.transition({
        runId,
        commandKey: 'doomed',
        body: { n: 1 },
        expectedRevision: 0,
        resultSchema: receiptSchema,
        apply: (context) => ({
          state: { ...context.state, phase: 'INGESTING' },
          events: [{ type: 'lesson.detected', payload: { contentHash: 'abc', source: 'local_file', bytes: 3 } }],
          activities: [activity],
          outbox: [outboxFor(runId, activity.id, `${runId}_n1`)],
          // Runs after every row and event above has been written inside the transaction.
          result: () => {
            throw new Error('boom');
          },
        }),
      }),
      /boom/,
    );
    const run = await store.getRun(runId);
    assert.equal(run.revision, 0);
    assert.equal(run.seq, 0);
    assert.equal(run.state.phase, 'WAITING');
    assert.deepEqual(await store.events(runId), []);
    const counts = await store.countNamespace(runId);
    assert.equal(counts.events + counts.commands + counts.activities + counts.outbox, 0);

    // The same action commits once the failure is gone: nothing was left half-written.
    const { result } = await store.transition({
      runId,
      commandKey: 'doomed',
      body: { n: 1 },
      expectedRevision: 0,
      resultSchema: receiptSchema,
      apply: (context) => ({
        state: { ...context.state, phase: 'INGESTING' },
        events: [{ type: 'lesson.detected', payload: { contentHash: 'abc', source: 'local_file', bytes: 3 } }],
        result: { marker: 'ok' },
      }),
    });
    assert.equal(result.marker, 'ok');
    const events = await store.events(runId);
    assert.deepEqual(events.map((e) => [e.seq, e.type]), [[1, 'lesson.detected'], [2, 'state.committed']]);
    assert.equal((await store.getRun(runId)).revision, 1);
  });

  test('lesson.detected is written inside the transition that starts ingestion', async () => {
    const runId = await newRun();
    const lesson = { contentHash: 'f'.repeat(64), text: 'Seven plus four.', source: 'local_file' as const, savedAt: '2026-11-09T10:00:00.000Z' };
    const first = await store.beginIngestion(runId, { expectedRevision: 0, lesson });
    assert.deepEqual(first, { revision: 1, eventSeq: 1, replayed: false });
    const run = await store.getRun(runId);
    assert.equal(run.state.phase, 'INGESTING');
    assert.equal(run.state.lesson?.text, lesson.text);
    assert.deepEqual((await store.events(runId)).map((e) => e.type), ['lesson.detected', 'state.committed']);
    // A retry with the same content returns the receipt and adds nothing.
    assert.deepEqual(await store.beginIngestion(runId, { expectedRevision: 0, lesson }), { ...first, replayed: true });
    assert.equal((await store.events(runId)).length, 2);
    // A different lesson from the wrong phase is refused.
    await assert.rejects(store.beginIngestion(runId, { expectedRevision: 1, lesson: { ...lesson, contentHash: 'e'.repeat(64) } }), (error) => error instanceof DomainError && error.code === 'WRONG_PHASE');
  });

  test('same commandId and body returns the stored receipt; a different body conflicts', async () => {
    const runId = await newRun();
    const request = (body: unknown) => ({
      runId,
      commandKey: 'once',
      body,
      expectedRevision: 0,
      resultSchema: receiptSchema,
      apply: (context: TransitionContext) => ({ state: { ...context.state, phase: 'INGESTING' as const }, events: [], result: { marker: 'first' } }),
    });
    const first = await store.transition(request({ a: 1 }));
    assert.equal(first.replayed, false);
    const again = await store.transition({ ...request({ a: 1 }), apply: (c) => ({ state: c.state, events: [], result: { marker: 'second' } }) });
    assert.equal(again.replayed, true);
    assert.deepEqual(again.result, { marker: 'first' });
    assert.equal((await store.getRun(runId)).revision, 1);
    await assert.rejects(store.transition(request({ a: 2 })), (error) => error instanceof DomainError && error.code === 'CONFLICT');
  });

  test('a stale revision is rejected', async () => {
    const runId = await newRun();
    await assert.rejects(
      store.transition({ runId, commandKey: 'stale', body: {}, expectedRevision: 5, resultSchema: receiptSchema, apply: (c) => ({ state: c.state, events: [], result: { marker: 'x' } }) }),
      (error) => error instanceof DomainError && error.code === 'STALE_REVISION' && error.revision === 0,
    );
    assert.equal((await store.getRun(runId)).revision, 0);
  });

  test('an event whose payload breaks its schema cannot be saved', async () => {
    const runId = await newRun();
    await assert.rejects(
      store.transition({
        runId,
        commandKey: 'bad-event',
        body: {},
        expectedRevision: 0,
        resultSchema: receiptSchema,
        apply: (c) => ({ state: c.state, events: [{ type: 'lesson.detected', payload: { contentHash: 'x', source: 'local_file', bytes: 0 } }], result: { marker: 'x' } }),
      }),
    );
    assert.deepEqual(await store.events(runId), []);
  });

  test('appendEvents adds tool events without moving the revision', async () => {
    const runId = await newRun();
    const written = await store.appendEvents(runId, [{ type: 'lesson.detected', payload: { contentHash: 'abc', source: 'local_file', bytes: 3 } }]);
    assert.deepEqual(written.map((e) => e.seq), [1]);
    const run = await store.getRun(runId);
    assert.equal(run.revision, 0);
    assert.equal(run.seq, 1);
  });

  test('older activity revisions stay readable', async () => {
    const runId = await newRun();
    const first = invitation(runId);
    const second = { ...invitation(runId), revision: 2, id: `${runId}_second` };
    for (const [i, activity] of [first, second].entries()) {
      await store.transition({ runId, commandKey: `a${i}`, body: i, expectedRevision: i, resultSchema: receiptSchema, apply: (c) => ({ state: c.state, events: [], activities: [activity], result: { marker: 'x' } }) });
    }
    assert.deepEqual(await store.getActivity(runId, first.id, 1), first);
    assert.deepEqual(await store.getActivity(runId, second.id, 2), second);
    assert.equal(await store.getActivity(runId, first.id, 9), null);
  });
});
