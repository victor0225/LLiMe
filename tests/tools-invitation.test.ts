import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { INVITATION_COPY } from '../src/copy.js';
import { loadSeed, type LoadedSeed } from '../src/dataset.js';
import type { Concept, GetPersonalMemoryOutput, ToolResult } from '../src/domain.js';
import { FILM_SEED } from '../src/problems.js';
import { createRunId, Store } from '../src/store.js';
import { getPersonalMemory, publishActivity, type ToolContext } from '../src/tools.js';

const TASK_ID = 'd-task_c9edd4ffd032';
const lessonText = readFileSync(new URL('../data/lesson/lesson-transcript.txt', import.meta.url), 'utf8');
const QUOTE = 'The start is a place. A jump is a move.';
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
    await store.resetRun(runId);
    assert.equal((await store.countNamespace(runId)).total, 0);
  }
  await store.close();
});

type Prepared = { context: ToolContext; memory: GetPersonalMemoryOutput; revision: number };

// A run that has saved the prepared lesson and read personal memory, as ingestion leaves it before publishing.
async function prepare(options: { studentId?: string; conceptIds?: Concept[]; seed?: number; client?: Store } = {}): Promise<Prepared> {
  const runId = createRunId(TASK_ID);
  created.push(runId);
  await store.createRun({ runId, studentId: options.studentId ?? 'student_7', seed: options.seed ?? FILM_SEED }, seed);
  await store.beginIngestion(runId, { expectedRevision: 0, lesson: { contentHash: createHash('sha256').update(lessonText).digest('hex'), text: lessonText, source: 'local_file', savedAt: '2026-11-09T10:00:00.000Z' } });
  const context: ToolContext = { runId, studentId: options.studentId ?? 'student_7', corpusHash: seed.corpusHash, phase: 'INGESTING', revision: 1, cancellationEpoch: 0, threadId: 'thread-1', turnId: 'turn-1' };
  const result = await getPersonalMemory(store, context, { conceptIds: options.conceptIds ?? ['addition_within_20', 'subtraction_within_20'], includeUnassessed: true });
  assert.ok(result.ok && result.tool === 'get_personal_memory');
  await store.appendEvents(runId, [{ type: 'tool.completed', payload: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', itemId: null, serverRequestId: null, attempt: 1, name: 'get_personal_memory', result, elapsedMs: 3 } }]);
  return { context, memory: result.data, revision: 1 };
}

const invitationAt = (expectedRevision: number, evidenceIds: string[], overrides: Record<string, unknown> = {}) => ({
  expectedRevision,
  explanationRevision: null,
  kind: 'invitation',
  templateId: 'invitation_addition',
  strategy: null,
  problem: null,
  evidenceIds,
  todayConceptId: 'addition_within_20',
  quotes: [QUOTE],
  decisionSummary: 'Earlier subtraction needed help; a short addition check will show whether addition does too.',
  activitySpec: null,
  ...overrides,
});

const invitation = (prepared: Prepared, overrides: Record<string, unknown> = {}) =>
  invitationAt(prepared.revision, prepared.memory.cases.slice(0, 2).map((c) => c.caseId), overrides);

function failed(result: ToolResult, pattern: RegExp, code = 'VALIDATION_FAILED') {
  assert.ok(!result.ok, 'expected a failure');
  assert.equal(result.error.code, code);
  assert.match(result.error.message, pattern);
}

// Nothing of the invitation exists after a rejected publish.
async function assertNothingPublished(prepared: Prepared) {
  const { runId } = prepared.context;
  const counts = await store.countNamespace(runId);
  assert.equal(counts.activities, 0);
  assert.equal(counts.outbox, 0);
  const run = await store.getRun(runId);
  assert.equal(run.revision, prepared.revision);
  assert.equal(run.state.phase, 'INGESTING');
  assert.equal(run.state.invitation, null);
  assert.ok(!(await store.events(runId)).some((e) => ['activity.published', 'notification.queued', 'memory.retrieved'].includes(e.type)));
}

describe('invitation publish: each eligibility condition alone', () => {
  test('rejects a concept other than addition_within_20', async () => {
    const prepared = await prepare();
    failed(await publishActivity(store, prepared.context, invitation(prepared, { todayConceptId: 'subtraction_within_20' })), /Condition 1: todayConceptId/);
    await assertNothingPublished(prepared);
  });

  test('rejects a quote that is not in the saved transcript', async () => {
    const prepared = await prepare();
    failed(await publishActivity(store, prepared.context, invitation(prepared, { quotes: ['Take away means go forward, right?'] })), /Condition 1: quote .* is not in the saved lesson/);
    await assertNothingPublished(prepared);
  });

  test('rejects an evidence ID that get_personal_memory did not return in this run', async () => {
    const prepared = await prepare();
    // seed_7_8 is a real case of this learner but beyond the eight returned.
    failed(await publishActivity(store, prepared.context, invitation(prepared, { evidenceIds: ['seed_7_8'] })), /Condition 2: seed_7_8 not returned/);
    failed(await publishActivity(store, prepared.context, invitation(prepared, { evidenceIds: ['seed_6_0'] })), /Condition 2: seed_6_0 not returned/);
    await assertNothingPublished(prepared);
  });

  test('a memory read that did not include the linked concept cannot support its evidence', async () => {
    const prepared = await prepare({ conceptIds: ['addition_within_20'] });
    assert.equal(prepared.memory.cases.length, 0);
    failed(await publishActivity(store, prepared.context, invitation(prepared, { evidenceIds: ['seed_7_0'] })), /Condition 2: seed_7_0 not returned/);
  });

  test('rejects a run that is not ingesting', async () => {
    const runId = createRunId(TASK_ID);
    created.push(runId);
    await store.createRun({ runId }, seed);
    const context: ToolContext = { runId, studentId: 'student_7', corpusHash: seed.corpusHash, phase: 'WAITING', revision: 0, cancellationEpoch: 0, threadId: null, turnId: null };
    failed(await publishActivity(store, context, invitationAt(0, ['seed_7_0'])), /WAITING/, 'WRONG_PHASE');
  });

  test('rejects a stale revision', async () => {
    const prepared = await prepare();
    const result = await publishActivity(store, prepared.context, invitation(prepared, { expectedRevision: 0 }));
    failed(result, /revision 1/, 'STALE_REVISION');
    await assertNothingPublished(prepared);
  });

  test('rejects an operation from an older cancellation epoch', async () => {
    const prepared = await prepare();
    failed(await publishActivity(store, { ...prepared.context, cancellationEpoch: 3 }, invitation(prepared)), /superseded/, 'CANCELLED');
  });
});

describe('invitation publish: commit', () => {
  test('independent-only history is eligible', async () => {
    const prepared = await prepare();
    const independent = prepared.memory.cases.filter((c) => c.outcome === 'independent').slice(0, 2).map((c) => c.caseId);
    assert.ok(independent.length > 0);
    const result = await publishActivity(store, prepared.context, invitation(prepared, { evidenceIds: independent, decisionSummary: 'Earlier work was independent; a short check keeps that going.' }));
    assert.ok(result.ok, result.ok ? '' : result.error.message);
  });

  test('mixed evidence gives the linked copy; same-concept-only gives the same-concept copy', async () => {
    const linked = await prepare();
    const linkedResult = await publishActivity(store, linked.context, invitation(linked));
    assert.ok(linkedResult.ok && linkedResult.tool === 'publish_activity');
    assert.equal(linkedResult.data.activity.title, INVITATION_COPY.title);
    assert.equal(linkedResult.data.activity.body, INVITATION_COPY.bodyLinkedConcept);

    // student_0 has addition history of its own, so reading only today's concept returns same-concept cases.
    const same = await prepare({ studentId: 'student_0', conceptIds: ['addition_within_20'] });
    assert.ok(same.memory.cases.length > 0 && same.memory.cases.every((c) => c.concept === 'addition_within_20'));
    const sameResult = await publishActivity(store, same.context, invitation(same));
    assert.ok(sameResult.ok && sameResult.tool === 'publish_activity');
    assert.equal(sameResult.data.activity.body, INVITATION_COPY.bodySameConcept);
  });

  test('activity, both events, receipt and outbox row commit atomically', async () => {
    const prepared = await prepare();
    const { runId } = prepared.context;
    const result = await publishActivity(store, prepared.context, invitation(prepared));
    assert.ok(result.ok && result.tool === 'publish_activity');
    const { activity, newRevision, eventSeq, notificationId } = result.data;

    assert.equal(newRevision, 2);
    assert.equal(activity.id, `${runId}_invitation`);
    assert.equal(activity.revision, 2);
    assert.equal(notificationId, `${runId}_notification_2`);
    assert.deepEqual(await store.getActivity(runId, activity.id, 2), activity);

    const run = await store.getRun(runId);
    assert.equal(run.revision, 2);
    assert.equal(run.state.phase, 'INVITED');
    assert.deepEqual(run.state.invitation, activity);
    // The pair is drawn once from the stored seed and the lesson's own problems: the film seed gives 8 + 5, then 9 + 4.
    assert.deepEqual(run.state.selectedProblems, { initial: { lhs: 8, rhs: 5 }, independent: { lhs: 9, rhs: 4 } });
    assert.deepEqual(run.state.lessonProblems, [{ lhs: 7, rhs: 4 }, { lhs: 7, rhs: 6 }, { lhs: 6, rhs: 5 }]);

    // Everything after the memory read's own tool.completed event belongs to the publish transaction.
    const all = await store.events(runId);
    const events = all.slice(all.findIndex((e) => e.type === 'tool.completed') + 1);
    assert.deepEqual(events.map((e) => e.type), ['memory.retrieved', 'activity.published', 'notification.queued', 'state.committed']);
    assert.equal(events.find((e) => e.type === 'activity.published')?.seq, eventSeq);
    const retrieved = events[0];
    assert.ok(retrieved?.type === 'memory.retrieved');
    assert.deepEqual(retrieved.payload.conceptIds, ['addition_within_20', 'subtraction_within_20']);
    assert.equal(retrieved.payload.links.length, 3);
    assert.equal(retrieved.payload.caseIds.length, 8);

    const outbox = await store.getNotification(notificationId ?? '');
    assert.deepEqual(outbox && [outbox.status, outbox.attemptCount, outbox.activityId, outbox.activityRevision, outbox.transport], ['pending', 0, activity.id, 2, 'simulator']);
    assert.equal((await store.countNamespace(runId)).outbox, 1);
  });

  test('a throw mid-commit writes none of it', async () => {
    const prepared = await prepare();
    const { runId } = prepared.context;
    // A clock that yields an unparseable timestamp makes the outbox row fail after the activity row was written.
    const broken = await Store.connect(undefined, { now: () => Object.assign(new Date(), { toISOString: () => 'not a timestamp' }) });
    try {
      const result = await publishActivity(broken, prepared.context, invitation(prepared));
      assert.ok(!result.ok);
    } finally {
      await broken.close();
    }
    await assertNothingPublished(prepared);
    assert.equal((await store.countNamespace(runId)).commands, 1, 'only the ingestion receipt remains');
  });

  test('a retry returns the stored result and adds nothing; the same key with different content conflicts', async () => {
    const prepared = await prepare();
    const { runId } = prepared.context;
    const first = await publishActivity(store, prepared.context, invitation(prepared));
    assert.ok(first.ok);
    const eventsAfterFirst = (await store.events(runId)).length;

    const retry = await publishActivity(store, prepared.context, invitation(prepared));
    assert.deepEqual(retry, first);
    assert.equal((await store.events(runId)).length, eventsAfterFirst);
    assert.equal((await store.countNamespace(runId)).outbox, 1);

    failed(await publishActivity(store, prepared.context, invitation(prepared, { decisionSummary: 'A different rationale.' })), /different content/, 'CONFLICT');
    assert.equal((await store.countNamespace(runId)).outbox, 1);
  });

  test('a publish that is not an invitation is refused until its handler exists', async () => {
    const prepared = await prepare();
    failed(await publishActivity(store, prepared.context, { ...invitation(prepared), kind: 'retry', templateId: 'manipulation_retry', strategy: 'retry', evidenceIds: [], todayConceptId: null, quotes: null }), /not available yet/);
  });
});
