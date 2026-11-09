import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loadSeed, type LoadedSeed } from '../src/dataset.js';
import type { GetPersonalMemoryOutput, ToolResult } from '../src/domain.js';
import { createRunId, Store } from '../src/store.js';
import { getPersonalMemory, summarizeCases, type ToolContext } from '../src/tools.js';

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
    await store.resetRun(runId);
    assert.equal((await store.countNamespace(runId)).total, 0);
  }
  await store.close();
});

async function contextFor(corpus: LoadedSeed = seed, studentId = 'student_7'): Promise<ToolContext> {
  const runId = createRunId(TASK_ID);
  created.push(runId);
  await store.createRun({ runId, studentId }, corpus);
  return { runId, studentId, corpusHash: corpus.corpusHash, phase: 'INGESTING', revision: 0, cancellationEpoch: 0, threadId: 'thread-1', turnId: 'turn-1' };
}

function memory(result: ToolResult): GetPersonalMemoryOutput {
  assert.ok(result.ok, result.ok ? '' : result.error.message);
  assert.equal(result.tool, 'get_personal_memory');
  return result.data as GetPersonalMemoryOutput;
}

const subtraction = (id: string) => seed.cases.filter((c) => c.studentId === id && c.concept === 'subtraction_within_20');

describe('get_personal_memory', () => {
  test('returns at most 8 cases per concept, newest first with ID tie-break (subtraction: seed_7_0…seed_7_7)', async () => {
    const context = await contextFor();
    const data = memory(await getPersonalMemory(store, context, { conceptIds: ['addition_within_20', 'subtraction_within_20'], includeUnassessed: true }));
    assert.deepEqual(data.cases.map((c) => c.caseId), Array.from({ length: 8 }, (_, i) => `seed_7_${i}`));
    assert.ok(data.cases.every((c) => c.concept === 'subtraction_within_20' && c.retention === 'pending' && c.nodeIds.every((n) => n.startsWith(`${c.caseId}:`))));
    assert.equal(data.studentId, 'student_7');
    assert.equal(data.corpusHash, seed.corpusHash);
  });

  test('summary counts all 18 subtraction cases', async () => {
    const context = await contextFor();
    const data = memory(await getPersonalMemory(store, context, { conceptIds: ['addition_within_20', 'subtraction_within_20'], includeUnassessed: true }));
    const summary = data.summaries.find((s) => s.conceptId === 'subtraction_within_20');
    assert.deepEqual(summary, summarizeCases('subtraction_within_20', 'similar', subtraction('student_7').map((c) => ({ id: c.id, concept: c.concept, strategy: c.strategy, outcome: c.outcome, createdAt: c.createdAt, nodeIds: [] }))));
    assert.equal(summary?.total, 18);
    assert.equal((summary?.independent ?? 0) + (summary?.assisted ?? 0) + (summary?.failed ?? 0) + (summary?.notAssessed ?? 0), 18);
    assert.equal(summary?.link, 'similar');
    assert.ok(data.cases.length <= 8);
  });

  test('addition summary is total 0 and no history is fabricated', async () => {
    const context = await contextFor();
    const data = memory(await getPersonalMemory(store, context, { conceptIds: ['addition_within_20', 'subtraction_within_20'], includeUnassessed: true }));
    assert.deepEqual(data.summaries[0], { conceptId: 'addition_within_20', link: 'today', total: 0, independent: 0, assisted: 0, failed: 0, notAssessed: 0, firstAt: null, lastAt: null });
    assert.ok(!data.cases.some((c) => c.concept === 'addition_within_20'));
    assert.deepEqual(data.unassessedConceptIds, ['addition_within_20']);
  });

  test('the same read gives the same snapshot ID, and excluding unassessed cases keeps the summary whole', async () => {
    const context = await contextFor();
    const input = { conceptIds: ['addition_within_20', 'subtraction_within_20'], includeUnassessed: false };
    const first = memory(await getPersonalMemory(store, context, input));
    const second = memory(await getPersonalMemory(store, context, input));
    assert.equal(first.memorySnapshotId, second.memorySnapshotId);
    assert.ok(first.cases.every((c) => c.outcome !== 'not_assessed'));
    assert.equal(first.summaries.find((s) => s.conceptId === 'subtraction_within_20')?.total, 18);
  });

  test('an unlinked conceptIds[1] is VALIDATION_FAILED', async () => {
    const context = await contextFor();
    for (const conceptIds of [['addition_within_20', 'addition_within_20'], ['subtraction_within_20', 'subtraction_within_20']]) {
      const result = await getPersonalMemory(store, context, { conceptIds, includeUnassessed: true });
      assert.ok(!result.ok);
      assert.equal(result.error.code, 'VALIDATION_FAILED');
      assert.match(result.error.message, /not linked/);
    }
  });

  test('reverse lookup resolves through the parents; parent IDs and cross-range aggregation are rejected', async () => {
    const context = await contextFor();
    const data = memory(await getPersonalMemory(store, context, { conceptIds: ['subtraction_within_20', 'addition_within_20'], includeUnassessed: true }));
    assert.deepEqual(data.summaries.map((s) => [s.conceptId, s.link, s.total]), [['subtraction_within_20', 'today', 18], ['addition_within_20', 'similar', 0]]);
    for (const conceptIds of [['addition'], ['addition_within_20', 'subtraction'], ['addition_within_20', 'subtraction_within_20', 'addition_within_20']]) {
      const result = await getPersonalMemory(store, context, { conceptIds, includeUnassessed: true });
      assert.ok(!result.ok);
      assert.equal(result.error.code, 'INVALID_INPUT');
    }
  });

  test('the bound student, not the model, picks whose memory is read', async () => {
    const context = await contextFor(seed, 'student_6');
    const smuggled = await getPersonalMemory(store, context, { conceptIds: ['subtraction_within_20'], includeUnassessed: true, studentId: 'student_7' });
    assert.ok(!smuggled.ok);
    assert.equal(smuggled.error.code, 'INVALID_INPUT');
    const data = memory(await getPersonalMemory(store, context, { conceptIds: ['subtraction_within_20'], includeUnassessed: true }));
    assert.equal(data.studentId, 'student_6');
    assert.ok(data.cases.every((c) => c.caseId.startsWith('seed_6_')));
  });

  test('live outcomes are not returned: only the run\'s pinned corpus is read', async () => {
    // A corpus that leaves out seed_7_0 stands in for a case that was committed after the run was pinned.
    const pinnedWithoutOne: LoadedSeed = { ...seed, cases: seed.cases.filter((c) => c.id !== 'seed_7_0') };
    const context = await contextFor(pinnedWithoutOne);
    const data = memory(await getPersonalMemory(store, context, { conceptIds: ['addition_within_20', 'subtraction_within_20'], includeUnassessed: true }));
    assert.ok(!data.cases.some((c) => c.caseId === 'seed_7_0'));
    assert.equal(data.summaries[1]?.total, 17);
  });
});
