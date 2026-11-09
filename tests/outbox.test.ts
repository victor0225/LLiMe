import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type NotificationOutbox, NotificationOutboxSchema } from '../src/domain.js';
import type { EventPayload } from '../src/events.js';
import { NOTIFY_ERROR_CODES, type OutboxOutcome, type OutboxStore, parseNotifyConfig, type SimctlRunner, startOutboxLoop } from '../src/notify.js';

const config = parseNotifyConfig({ deviceUdid: '7D23BEA3-2B8D-45CE-BC81-D372D1A794EA' });

function outboxRow(overrides: Partial<NotificationOutbox> = {}): NotificationOutbox {
  return NotificationOutboxSchema.parse({
    notificationId: 'ntf_1',
    runId: 'run_1',
    activityId: 'act_1',
    activityRevision: 2,
    transport: 'simulator',
    status: 'pending',
    attemptCount: 0,
    createdAt: '2026-11-09T10:00:00.000Z',
    lastErrorCode: null,
    ...overrides,
  });
}

// An in-memory stand-in for the outbox rows and the run they belong to. `claimNotification` is a
// synchronous check-and-set, like the transaction it stands for, so two loops cannot both win a row.
function memoryOutbox(rows: NotificationOutbox[]) {
  const byId = new Map(rows.map((row) => [row.notificationId, { ...row }]));
  const run = { revision: 7, activity: { id: 'act_1', revision: 2, templateId: 'invitation_addition' } };
  const sentEvents: EventPayload<'notification.sent'>[] = [];
  const settle = (id: string, status: 'failed' | 'unknown', lastErrorCode: string) => {
    const row = byId.get(id);
    if (!row || row.status !== 'dispatching') throw new Error(`Notification ${id} is not being dispatched`);
    Object.assign(row, { status, lastErrorCode });
  };
  const store: OutboxStore = {
    async getNotification(id) {
      const row = byId.get(id);
      return row ? { ...row } : null;
    },
    async listPendingNotifications() {
      return [...byId.values()].filter((row) => row.status === 'pending').map((row) => row.notificationId);
    },
    async listDispatchingNotifications() {
      return [...byId.values()].filter((row) => row.status === 'dispatching').map((row) => row.notificationId);
    },
    async claimNotification(id) {
      const row = byId.get(id);
      if (!row || row.status !== 'pending') return null;
      Object.assign(row, { status: 'dispatching', attemptCount: row.attemptCount + 1 });
      return { ...row };
    },
    async markNotificationSent(id, event) {
      const row = byId.get(id);
      if (!row || row.status !== 'dispatching') throw new Error(`Notification ${id} is not being dispatched`);
      Object.assign(row, { status: 'injected', lastErrorCode: null });
      sentEvents.push(event);
    },
    async markNotificationFailed(id, code) {
      settle(id, 'failed', code);
    },
    async markNotificationUnknown(id, code) {
      settle(id, 'unknown', code);
    },
  };
  const commit = (row: NotificationOutbox) => byId.set(row.notificationId, { ...row });
  return { store, run, sentEvents, commit, row: (id: string) => byId.get(id) };
}

// Stands in for `xcrun simctl`, which needs a booted Simulator: the app container is always present and
// each push exits with the next code given, 0 when none is left.
function stubSimctl(pushExitCodes: number[] = []) {
  const pushes: string[] = [];
  const runSimctl: SimctlRunner = async (_command, args, stdin) => {
    if (args[1] === 'get_app_container') return { kind: 'exited', exitCode: 0, stderr: '' };
    pushes.push(JSON.parse(stdin).notificationId);
    return { kind: 'exited', exitCode: pushExitCodes.shift() ?? 0, stderr: '' };
  };
  return { runSimctl, pushes };
}

const ownsEveryRun = async () => true;

describe('outbox loop (stubbed simctl)', () => {
  test('rows of runs this server does not own are never recovered, claimed or sent', async () => {
    const outbox = memoryOutbox([
      outboxRow({ notificationId: 'ntf_theirs_waiting', runId: 'run_other_worktree' }),
      outboxRow({ notificationId: 'ntf_theirs_dispatching', runId: 'run_other_worktree', activityId: 'act_9', status: 'dispatching', attemptCount: 1 }),
      outboxRow({ notificationId: 'ntf_ours', runId: 'run_ours', activityId: 'act_2' }),
    ]);
    const simctl = stubSimctl();
    const ownsRun = async (runId: string) => runId === 'run_ours';

    const loop = await startOutboxLoop({ store: outbox.store, runSimctl: simctl.runSimctl, config, ownsRun, scanIntervalMs: null });
    await loop.kick();
    await loop.stop();

    assert.deepEqual(simctl.pushes, ['ntf_ours']);
    assert.deepEqual(outbox.row('ntf_theirs_waiting'), outboxRow({ notificationId: 'ntf_theirs_waiting', runId: 'run_other_worktree' }));
    assert.equal(outbox.row('ntf_theirs_dispatching')?.status, 'dispatching');
  });

  test('a committed pending row is dispatched once, even with two loops running', async () => {
    const outbox = memoryOutbox([]);
    const simctl = stubSimctl();
    const loops = await Promise.all([1, 2].map(() => startOutboxLoop({ store: outbox.store, runSimctl: simctl.runSimctl, config, ownsRun: ownsEveryRun, scanIntervalMs: null })));

    outbox.commit(outboxRow());
    await Promise.all(loops.flatMap((loop) => [loop.kick(), loop.kick()]));
    await Promise.all(loops.map((loop) => loop.stop()));

    assert.deepEqual(simctl.pushes, ['ntf_1']);
    assert.deepEqual(outbox.row('ntf_1'), outboxRow({ status: 'injected', attemptCount: 1 }));
    assert.deepEqual(outbox.sentEvents, [{ notificationId: 'ntf_1', runId: 'run_1', activityId: 'act_1', activityRevision: 2 }]);
  });

  test('a row still dispatching at startup becomes unknown and is not resent', async () => {
    const outbox = memoryOutbox([
      outboxRow({ notificationId: 'ntf_interrupted', status: 'dispatching', attemptCount: 1 }),
      outboxRow({ notificationId: 'ntf_waiting', activityId: 'act_2' }),
    ]);
    const simctl = stubSimctl();
    const outcomes: OutboxOutcome[] = [];

    const loop = await startOutboxLoop({ store: outbox.store, runSimctl: simctl.runSimctl, config, ownsRun: ownsEveryRun, scanIntervalMs: null, onOutcome: (o) => outcomes.push(o) });
    await loop.kick();
    await loop.kick();
    await loop.stop();

    assert.deepEqual(outbox.row('ntf_interrupted'), outboxRow({ notificationId: 'ntf_interrupted', status: 'unknown', attemptCount: 1, lastErrorCode: NOTIFY_ERROR_CODES.interrupted }));
    // A row committed before the restart but never claimed is still sent, once.
    assert.deepEqual(simctl.pushes, ['ntf_waiting']);
    assert.deepEqual(outcomes, [
      { kind: 'recovered', notificationIds: ['ntf_interrupted'] },
      { kind: 'dispatched', notificationId: 'ntf_waiting', result: { outcome: 'injected' } },
    ]);
  });

  test('a dispatch failure leaves the activity unchanged', async () => {
    const outbox = memoryOutbox([outboxRow({ notificationId: 'ntf_fails' }), outboxRow({ notificationId: 'ntf_next', activityId: 'act_2' })]);
    const activityBefore = structuredClone(outbox.run);
    const simctl = stubSimctl([64]);

    const loop = await startOutboxLoop({ store: outbox.store, runSimctl: simctl.runSimctl, config, ownsRun: ownsEveryRun, scanIntervalMs: null });
    await loop.kick();
    await loop.stop();

    assert.deepEqual(outbox.row('ntf_fails'), outboxRow({ notificationId: 'ntf_fails', status: 'failed', attemptCount: 1, lastErrorCode: NOTIFY_ERROR_CODES.simctlExit(64) }));
    assert.deepEqual(outbox.run, activityBefore);
    // The failure is the row's record only; the loop goes on to the next row.
    assert.equal(outbox.row('ntf_next')?.status, 'injected');
    assert.deepEqual(outbox.sentEvents.map((e) => e.notificationId), ['ntf_next']);
  });

  test('a store failure while dispatching is reported and the loop keeps draining', async () => {
    const outbox = memoryOutbox([outboxRow({ notificationId: 'ntf_a' }), outboxRow({ notificationId: 'ntf_b', activityId: 'act_2' })]);
    const realClaim = outbox.store.claimNotification;
    outbox.store.claimNotification = async (id) => {
      if (id === 'ntf_a') throw new Error('Neo4j unavailable');
      return realClaim(id);
    };
    const simctl = stubSimctl();
    const outcomes: OutboxOutcome[] = [];

    const loop = await startOutboxLoop({ store: outbox.store, runSimctl: simctl.runSimctl, config, ownsRun: ownsEveryRun, scanIntervalMs: null, onOutcome: (o) => outcomes.push(o) });
    await loop.kick();
    await loop.stop();

    // The startup drain fails on ntf_a and still sends ntf_b; nothing was claimed, so the kick's drain
    // tries ntf_a again and the row stays pending for the next one.
    assert.deepEqual(outcomes, [
      { kind: 'dispatch_error', notificationId: 'ntf_a', reason: 'Neo4j unavailable' },
      { kind: 'dispatched', notificationId: 'ntf_b', result: { outcome: 'injected' } },
      { kind: 'dispatch_error', notificationId: 'ntf_a', reason: 'Neo4j unavailable' },
    ]);
    assert.equal(outbox.row('ntf_a')?.status, 'pending');
    assert.deepEqual(simctl.pushes, ['ntf_b']);
  });

  test('a stopped loop dispatches nothing more', async () => {
    const outbox = memoryOutbox([]);
    const simctl = stubSimctl();
    const loop = await startOutboxLoop({ store: outbox.store, runSimctl: simctl.runSimctl, config, ownsRun: ownsEveryRun, scanIntervalMs: null });
    await loop.stop();

    outbox.commit(outboxRow());
    await loop.kick();
    assert.deepEqual(simctl.pushes, []);
    assert.equal(outbox.row('ntf_1')?.status, 'pending');
  });
});
