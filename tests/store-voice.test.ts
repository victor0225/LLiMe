import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { loadSeed, type LoadedSeed } from '../src/dataset.js';
import type { VoiceOperation } from '../src/domain.js';
import { createRunId, DomainError, Store } from '../src/store.js';

const TASK_ID = 'd-task_c9edd4ffd032';
const created: string[] = [];
const isDomain = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;
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
      // A test that already reset its run leaves nothing to remove.
      if (!isDomain('NOT_FOUND')(error)) throw error;
    }
    assert.equal((await store.countNamespace(runId)).total, 0);
  }
  await store.close();
});

async function newRun(): Promise<string> {
  const runId = createRunId(TASK_ID);
  created.push(runId);
  await store.createRun({ runId }, seed);
  return runId;
}

const operation = (runId: string, suffix: string, overrides: Partial<VoiceOperation> = {}): VoiceOperation => ({
  runId,
  liveSessionId: 'live-1',
  delegationId: `delegation-${suffix}`,
  operationId: `${runId}-op-${suffix}`,
  explanationRevision: 1,
  cancellationEpoch: 0,
  threadId: 'thread-1',
  turnId: 'turn-1',
  status: 'started',
  ...overrides,
});

describe('voice operations', () => {
  test('insert stores the row and a repeat returns the stored one', async () => {
    const runId = await newRun();
    const op = operation(runId, 'a');
    assert.deepEqual(await store.insertVoiceOperation(op), op);
    assert.deepEqual(await store.getVoiceOperation(op.operationId), op);
    assert.deepEqual(await store.insertVoiceOperation(op), op);
    assert.equal((await store.countNamespace(runId)).voiceOperations, 1);
  });

  test('a repeat insert keeps the status the operation has reached', async () => {
    const runId = await newRun();
    const op = operation(runId, 'a');
    await store.insertVoiceOperation(op);
    await store.updateVoiceOperationStatus(op.operationId, 'steered', 'started');
    assert.equal((await store.insertVoiceOperation(op)).status, 'steered');
  });

  test('null correlation IDs are kept as null, never invented', async () => {
    const runId = await newRun();
    const op = operation(runId, 'typed', { liveSessionId: null, delegationId: null, threadId: null, turnId: null });
    assert.deepEqual(await store.insertVoiceOperation(op), op);
    assert.deepEqual(await store.getVoiceOperation(op.operationId), op);
  });

  test('the same operation ID with different correlation conflicts', async () => {
    const runId = await newRun();
    const op = operation(runId, 'a');
    await store.insertVoiceOperation(op);
    await assert.rejects(store.insertVoiceOperation({ ...op, explanationRevision: 2 }), isDomain('CONFLICT'));
    await assert.rejects(store.insertVoiceOperation({ ...op, cancellationEpoch: 1 }), isDomain('CONFLICT'));
    assert.deepEqual(await store.getVoiceOperation(op.operationId), op);
  });

  test('an operation for an unknown run is refused and a delegation needs a Live session', async () => {
    const missing = createRunId(TASK_ID);
    await assert.rejects(store.insertVoiceOperation(operation(missing, 'a')), isDomain('NOT_FOUND'));
    const runId = await newRun();
    await assert.rejects(store.insertVoiceOperation(operation(runId, 'b', { liveSessionId: null })));
  });

  test('a guarded status change succeeds only from the expected status', async () => {
    const runId = await newRun();
    const op = operation(runId, 'a');
    await store.insertVoiceOperation(op);
    const steered = await store.updateVoiceOperationStatus(op.operationId, 'steered', 'started');
    assert.equal(steered.status, 'steered');
    await assert.rejects(store.updateVoiceOperationStatus(op.operationId, 'completed', 'started'), isDomain('CONFLICT'));
    assert.equal((await store.getVoiceOperation(op.operationId))?.status, 'steered');
    assert.equal((await store.updateVoiceOperationStatus(op.operationId, 'completed', 'steered')).status, 'completed');
  });

  test('a settled operation cannot change again', async () => {
    const runId = await newRun();
    for (const settled of ['completed', 'cancelled', 'failed'] as const) {
      const op = operation(runId, settled);
      await store.insertVoiceOperation(op);
      await store.updateVoiceOperationStatus(op.operationId, settled, 'started');
      await assert.rejects(store.updateVoiceOperationStatus(op.operationId, 'started', settled), isDomain('CONFLICT'));
    }
  });

  test('a status change does not move the run revision or write events', async () => {
    const runId = await newRun();
    const op = operation(runId, 'a');
    await store.insertVoiceOperation(op);
    await store.updateVoiceOperationStatus(op.operationId, 'cancelled', 'started');
    const run = await store.getRun(runId);
    assert.equal(run.revision, 0);
    assert.equal(run.seq, 0);
  });

  test('an unknown operation is not found', async () => {
    assert.equal(await store.getVoiceOperation(`${createRunId(TASK_ID)}-missing`), null);
    await assert.rejects(store.updateVoiceOperationStatus(`${createRunId(TASK_ID)}-missing`, 'steered', 'started'), isDomain('NOT_FOUND'));
  });

  test('listing returns only that run\'s operations in a stable order', async () => {
    const [first, second] = [await newRun(), await newRun()];
    for (const suffix of ['b', 'a', 'c']) await store.insertVoiceOperation(operation(first, suffix));
    await store.insertVoiceOperation(operation(second, 'a'));
    const listed = await store.listVoiceOperations(first);
    assert.deepEqual(listed.map((o) => o.operationId), ['a', 'b', 'c'].map((s) => `${first}-op-${s}`));
    assert.ok(listed.every((o) => o.runId === first));
    assert.deepEqual(await store.listVoiceOperations(createRunId(TASK_ID)), []);
  });

  test('reset removes the run\'s operations and only those', async () => {
    const [doomed, kept] = [await newRun(), await newRun()];
    await store.insertVoiceOperation(operation(doomed, 'a'));
    await store.insertVoiceOperation(operation(kept, 'a'));
    await store.resetRun(doomed);
    assert.equal(await store.getVoiceOperation(`${doomed}-op-a`), null);
    assert.equal((await store.listVoiceOperations(kept)).length, 1);
  });
});
