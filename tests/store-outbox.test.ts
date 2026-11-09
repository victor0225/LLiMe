import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import { loadSeed, type LoadedSeed } from '../src/dataset.js';
import type { NotificationOutbox } from '../src/domain.js';
import { createRunId, DomainError, Store } from '../src/store.js';

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

const receipt = z.object({ marker: z.string() });
const isDomain = (code: string) => (error: unknown) => error instanceof DomainError && error.code === code;

// A run holding one pending outbox row for its activity, as the invitation commit leaves it.
async function runWithOutbox(suffix = 'n1', activityId?: string): Promise<{ runId: string; row: NotificationOutbox }> {
  const runId = createRunId(TASK_ID);
  created.push(runId);
  await store.createRun({ runId }, seed);
  const row: NotificationOutbox = {
    notificationId: `${runId}_${suffix}`,
    runId,
    activityId: activityId ?? `${runId}_invitation`,
    activityRevision: 1,
    transport: 'simulator',
    status: 'pending',
    attemptCount: 0,
    createdAt: '2026-11-09T10:00:00.000Z',
    lastErrorCode: null,
  };
  await store.transition({ runId, commandKey: 'queue', body: {}, expectedRevision: 0, resultSchema: receipt, apply: (c) => ({ state: c.state, events: [], outbox: [row], result: { marker: 'queued' } }) });
  return { runId, row };
}

describe('notification outbox', () => {
  test('outbox is unique on activityId + activityRevision + transport', async () => {
    const { runId, row } = await runWithOutbox();
    const duplicate = { ...row, notificationId: `${runId}_n2` };
    await assert.rejects(
      store.transition({ runId, commandKey: 'again', body: {}, expectedRevision: 1, resultSchema: receipt, apply: (c) => ({ state: c.state, events: [], outbox: [duplicate], result: { marker: 'x' } }) }),
      isDomain('CONFLICT'),
    );
    assert.equal((await store.countNamespace(runId)).outbox, 1);
    assert.equal((await store.getRun(runId)).revision, 1);
    // A new revision of the same activity is a different row.
    const next = { ...row, notificationId: `${runId}_n3`, activityRevision: 2 };
    await store.transition({ runId, commandKey: 'next', body: {}, expectedRevision: 1, resultSchema: receipt, apply: (c) => ({ state: c.state, events: [], outbox: [next], result: { marker: 'x' } }) });
    assert.equal((await store.countNamespace(runId)).outbox, 2);
  });

  test('claim moves pending to dispatching once and counts the attempt', async () => {
    const { row } = await runWithOutbox();
    const claimed = await store.claimNotification(row.notificationId);
    assert.equal(claimed?.status, 'dispatching');
    assert.equal(claimed?.attemptCount, 1);
    assert.equal(await store.claimNotification(row.notificationId), null);
    assert.equal(await store.claimNotification('missing-notification'), null);
  });

  test('marking sent sets injected and appends notification.sent in one transaction', async () => {
    const { runId, row } = await runWithOutbox();
    await store.claimNotification(row.notificationId);
    const revision = (await store.getRun(runId)).revision;
    await store.markNotificationSent(row.notificationId, { notificationId: row.notificationId, runId, activityId: row.activityId, activityRevision: 1 });
    const stored = await store.getNotification(row.notificationId);
    assert.equal(stored?.status, 'injected');
    assert.equal(stored?.lastErrorCode, null);
    const sent = (await store.events(runId)).filter((e) => e.type === 'notification.sent');
    assert.equal(sent.length, 1);
    assert.equal((await store.getRun(runId)).revision, revision, 'delivery never moves the run revision');
  });

  test('marking sent with another activity leaves the row and the event log untouched', async () => {
    const { runId, row } = await runWithOutbox();
    await store.claimNotification(row.notificationId);
    const eventsBefore = (await store.events(runId)).length;
    await assert.rejects(
      store.markNotificationSent(row.notificationId, { notificationId: row.notificationId, runId, activityId: 'another_activity', activityRevision: 1 }),
      isDomain('VALIDATION_FAILED'),
    );
    assert.equal((await store.getNotification(row.notificationId))?.status, 'dispatching');
    assert.equal((await store.events(runId)).length, eventsBefore);
  });

  test('a row that is not dispatching cannot be marked sent, failed or unknown', async () => {
    const { runId, row } = await runWithOutbox();
    const payload = { notificationId: row.notificationId, runId, activityId: row.activityId, activityRevision: 1 };
    await assert.rejects(store.markNotificationSent(row.notificationId, payload), isDomain('CONFLICT'));
    await assert.rejects(store.markNotificationFailed(row.notificationId, 'SIMCTL_EXIT_1'), isDomain('CONFLICT'));
    await assert.rejects(store.markNotificationUnknown(row.notificationId, 'CRASH'), isDomain('CONFLICT'));
    assert.equal((await store.getNotification(row.notificationId))?.status, 'pending');
  });

  test('failed and unknown record the error code and write no event', async () => {
    const failed = await runWithOutbox('failed');
    await store.claimNotification(failed.row.notificationId);
    await store.markNotificationFailed(failed.row.notificationId, 'SIMCTL_EXIT_1');
    assert.deepEqual(
      [(await store.getNotification(failed.row.notificationId))?.status, (await store.getNotification(failed.row.notificationId))?.lastErrorCode],
      ['failed', 'SIMCTL_EXIT_1'],
    );

    const unknown = await runWithOutbox('unknown');
    await store.claimNotification(unknown.row.notificationId);
    await store.markNotificationUnknown(unknown.row.notificationId, 'CRASH_AFTER_DISPATCH');
    assert.equal((await store.getNotification(unknown.row.notificationId))?.status, 'unknown');
    for (const { runId } of [failed, unknown]) assert.deepEqual(await store.events(runId), []);
  });

  test('pending rows are listed for the backlog scan until they are claimed', async () => {
    const waiting = await runWithOutbox('waiting');
    const taken = await runWithOutbox('taken');
    await store.claimNotification(taken.row.notificationId);
    const pending = await store.listPendingNotifications();
    assert.ok(pending.includes(waiting.row.notificationId));
    assert.ok(!pending.includes(taken.row.notificationId));
    await store.claimNotification(waiting.row.notificationId);
    assert.ok(!(await store.listPendingNotifications()).includes(waiting.row.notificationId));
  });

  test('rows left dispatching are listed for restart recovery', async () => {
    const stuck = await runWithOutbox('stuck');
    const idle = await runWithOutbox('idle');
    await store.claimNotification(stuck.row.notificationId);
    const listed = await store.listDispatchingNotifications();
    assert.ok(listed.includes(stuck.row.notificationId));
    assert.ok(!listed.includes(idle.row.notificationId));
    await store.markNotificationUnknown(stuck.row.notificationId, 'RESTART');
    assert.ok(!(await store.listDispatchingNotifications()).includes(stuck.row.notificationId));
  });
});
