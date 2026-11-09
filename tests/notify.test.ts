import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type NotificationOutbox, NotificationOutboxSchema, NotificationPayloadSchema, NOTIFICATION_PAYLOAD_MAX_BYTES } from '../src/domain.js';
import { NOTIFICATION_COPY } from '../src/copy.js';
import type { EventPayload } from '../src/events.js';
import {
  DEFAULT_BUNDLE_ID,
  dispatchNotification,
  type NotifyConfig,
  type NotifyStore,
  parseNotifyConfig,
  recoverInterruptedNotifications,
  runCommand,
  type SimctlResult,
  type SimctlRunner,
} from '../src/notify.js';

const UDID = '7D23BEA3-2B8D-45CE-BC81-D372D1A794EA';
const config: NotifyConfig = parseNotifyConfig({ deviceUdid: UDID });

function outboxRow(overrides: Partial<NotificationOutbox> = {}): NotificationOutbox {
  return NotificationOutboxSchema.parse({
    notificationId: 'ntf_1',
    runId: 'run_1',
    activityId: 'act_1',
    activityRevision: 3,
    transport: 'simulator',
    status: 'pending',
    attemptCount: 0,
    createdAt: '2026-11-09T10:00:00.000Z',
    lastErrorCode: null,
    ...overrides,
  });
}

// An in-memory stand-in for the store functions the dispatcher consumes. `claimNotification` is a
// synchronous check-and-set, like the transaction it stands for, so two concurrent runs cannot both win.
function memoryStore(rows: NotificationOutbox[], options: { failSentReceipt?: boolean } = {}) {
  const byId = new Map(rows.map((row) => [row.notificationId, { ...row }]));
  const sentEvents: EventPayload<'notification.sent'>[] = [];
  const calls: string[] = [];
  const get = (id: string) => {
    const row = byId.get(id);
    assert.ok(row, `no outbox row ${id}`);
    return row;
  };
  const store: NotifyStore = {
    async claimNotification(id) {
      calls.push('claim');
      const row = byId.get(id);
      if (!row || row.status !== 'pending') return null;
      row.status = 'dispatching';
      row.attemptCount += 1;
      return { ...row };
    },
    async markNotificationSent(id, event) {
      calls.push('markSent');
      if (options.failSentReceipt) throw new Error('store unavailable');
      Object.assign(get(id), { status: 'injected', lastErrorCode: null });
      sentEvents.push(event);
    },
    async markNotificationFailed(id, lastErrorCode) {
      calls.push('markFailed');
      Object.assign(get(id), { status: 'failed', lastErrorCode });
    },
    async markNotificationUnknown(id, lastErrorCode) {
      calls.push('markUnknown');
      Object.assign(get(id), { status: 'unknown', lastErrorCode });
    },
    async listDispatchingNotifications() {
      return [...byId.values()].filter((row) => row.status === 'dispatching').map((row) => row.notificationId);
    },
  };
  return { store, row: get, sentEvents, calls };
}

function stubSimctl(result: SimctlResult | (() => Promise<SimctlResult>) = { kind: 'exited', exitCode: 0, stderr: '' }) {
  const invocations: { command: string; args: readonly string[]; stdin: string }[] = [];
  const run: SimctlRunner = async (command, args, stdin) => {
    invocations.push({ command, args, stdin });
    return typeof result === 'function' ? result() : result;
  };
  return { run, invocations };
}

describe('dispatchNotification', () => {
  test('a row that is not pending is never sent (stubbed simctl)', async () => {
    for (const status of ['dispatching', 'injected', 'failed', 'unknown'] as const) {
      const { store, row } = memoryStore([outboxRow({ status, attemptCount: 1 })]);
      const simctl = stubSimctl();
      const result = await dispatchNotification('ntf_1', { store, runSimctl: simctl.run, config });
      assert.deepEqual(result, { outcome: 'skipped', reason: 'not_pending' }, status);
      assert.equal(simctl.invocations.length, 0, status);
      assert.equal(row('ntf_1').status, status);
    }
  });

  test('an unknown outbox row is skipped without a subprocess (stubbed simctl)', async () => {
    const { store } = memoryStore([]);
    const simctl = stubSimctl();
    const result = await dispatchNotification('ntf_missing', { store, runSimctl: simctl.run, config });
    assert.deepEqual(result, { outcome: 'skipped', reason: 'not_pending' });
    assert.equal(simctl.invocations.length, 0);
  });

  test('a duplicate dispatcher run for the same row sends one notification (stubbed simctl)', async () => {
    const { store, sentEvents, row } = memoryStore([outboxRow()]);
    const simctl = stubSimctl();
    const deps = { store, runSimctl: simctl.run, config };

    const concurrent = await Promise.all([dispatchNotification('ntf_1', deps), dispatchNotification('ntf_1', deps)]);
    const later = await dispatchNotification('ntf_1', deps);

    assert.deepEqual(concurrent.map((r) => r.outcome).sort(), ['injected', 'skipped']);
    assert.equal(later.outcome, 'skipped');
    assert.equal(simctl.invocations.length, 1);
    assert.equal(sentEvents.length, 1);
    assert.equal(row('ntf_1').attemptCount, 1);
  });

  test('simctl gets an argument array with the explicit UDID and the payload on stdin; never a shell, never "booted" (stubbed simctl)', async () => {
    const { store } = memoryStore([outboxRow()]);
    const simctl = stubSimctl();
    await dispatchNotification('ntf_1', { store, runSimctl: simctl.run, config });

    assert.equal(simctl.invocations.length, 1);
    const [{ command, args, stdin }] = simctl.invocations;
    assert.equal(command, 'xcrun');
    assert.deepEqual(args, ['simctl', 'push', UDID, DEFAULT_BUNDLE_ID, '-']);
    assert.equal(DEFAULT_BUNDLE_ID, 'com.llime.demo');
    assert.ok(!args.includes('booted'));
    assert.ok(!args.some((arg) => /\s/.test(arg) && arg.includes('simctl push')), 'no joined command string');
    assert.doesNotThrow(() => NotificationPayloadSchema.parse(JSON.parse(stdin)));
  });

  test('the payload holds only title, body, default sound and the opaque notificationId/runId/activityId/activityRevision, and stays ≤4096 UTF-8 bytes (stubbed simctl)', async () => {
    const long = '활'.repeat(180);
    const { store } = memoryStore([outboxRow({ notificationId: long, runId: long, activityId: long, activityRevision: 2_147_483_647 })]);
    const simctl = stubSimctl();
    await dispatchNotification(long, { store, runSimctl: simctl.run, config });

    const [{ stdin }] = simctl.invocations;
    assert.deepEqual(JSON.parse(stdin), {
      aps: { alert: { title: NOTIFICATION_COPY.title, body: NOTIFICATION_COPY.body }, sound: 'default' },
      notificationId: long,
      runId: long,
      activityId: long,
      activityRevision: 2_147_483_647,
    });
    assert.ok(new TextEncoder().encode(stdin).length <= NOTIFICATION_PAYLOAD_MAX_BYTES);
  });

  test('exit 0 marks sent and records notification.sent in the same store call (stubbed simctl)', async () => {
    const { store, row, sentEvents, calls } = memoryStore([outboxRow()]);
    const result = await dispatchNotification('ntf_1', { store, runSimctl: stubSimctl().run, config });

    assert.deepEqual(result, { outcome: 'injected' });
    assert.deepEqual(calls, ['claim', 'markSent']);
    assert.equal(row('ntf_1').status, 'injected');
    assert.deepEqual(sentEvents, [{ notificationId: 'ntf_1', runId: 'run_1', activityId: 'act_1', activityRevision: 3 }]);
  });

  test('non-zero exit marks failed with lastErrorCode and writes no event (stubbed simctl)', async () => {
    const { store, row, sentEvents, calls } = memoryStore([outboxRow()]);
    const simctl = stubSimctl({ kind: 'exited', exitCode: 164, stderr: 'An error was encountered processing the command' });
    const result = await dispatchNotification('ntf_1', { store, runSimctl: simctl.run, config });

    assert.deepEqual(result, { outcome: 'failed', code: 'SIMCTL_EXIT_164' });
    assert.deepEqual(calls, ['claim', 'markFailed']);
    assert.equal(row('ntf_1').status, 'failed');
    assert.equal(row('ntf_1').lastErrorCode, 'SIMCTL_EXIT_164');
    assert.equal(sentEvents.length, 0);
  });

  test('a subprocess that never started marks failed, not unknown (stubbed simctl)', async () => {
    const { store, row } = memoryStore([outboxRow()]);
    const simctl = stubSimctl({ kind: 'not_started', reason: 'spawn ENOENT' });
    const result = await dispatchNotification('ntf_1', { store, runSimctl: simctl.run, config });

    assert.deepEqual(result, { outcome: 'failed', code: 'SIMCTL_NOT_STARTED' });
    assert.equal(row('ntf_1').status, 'failed');
  });

  test('a crash between dispatch and receipt leaves the row unknown, and the next run does not resend it (stubbed simctl)', async () => {
    const interrupted = [
      stubSimctl({ kind: 'interrupted', reason: 'timeout' }),
      stubSimctl(async () => {
        throw new Error('dispatcher crashed');
      }),
    ];
    for (const simctl of interrupted) {
      const { store, row, sentEvents } = memoryStore([outboxRow()]);
      const deps = { store, runSimctl: simctl.run, config };
      const first = await dispatchNotification('ntf_1', deps);
      const second = await dispatchNotification('ntf_1', deps);

      assert.deepEqual(first, { outcome: 'unknown', code: 'DISPATCH_INTERRUPTED' });
      assert.equal(second.outcome, 'skipped');
      assert.equal(row('ntf_1').status, 'unknown');
      assert.equal(simctl.invocations.length, 1);
      assert.equal(sentEvents.length, 0);
    }
  });

  test('a row left dispatching by a dead process becomes unknown on recovery and is not resent (stubbed simctl)', async () => {
    const { store, row } = memoryStore([outboxRow({ status: 'dispatching', attemptCount: 1 }), outboxRow({ notificationId: 'ntf_2', status: 'injected', attemptCount: 1 })]);
    const simctl = stubSimctl();

    await recoverInterruptedNotifications(store);
    const result = await dispatchNotification('ntf_1', { store, runSimctl: simctl.run, config });

    assert.equal(row('ntf_1').status, 'unknown');
    assert.equal(row('ntf_1').lastErrorCode, 'DISPATCH_INTERRUPTED');
    assert.equal(row('ntf_2').status, 'injected');
    assert.equal(result.outcome, 'skipped');
    assert.equal(simctl.invocations.length, 0);
  });

  test('a receipt write that fails after exit 0 leaves the row unknown, never resent (stubbed simctl)', async () => {
    const { store, row, sentEvents } = memoryStore([outboxRow()], { failSentReceipt: true });
    const simctl = stubSimctl();
    const deps = { store, runSimctl: simctl.run, config };

    const first = await dispatchNotification('ntf_1', deps);
    const second = await dispatchNotification('ntf_1', deps);

    assert.deepEqual(first, { outcome: 'unknown', code: 'RECEIPT_WRITE_FAILED' });
    assert.equal(second.outcome, 'skipped');
    assert.equal(row('ntf_1').status, 'unknown');
    assert.equal(simctl.invocations.length, 1);
    assert.equal(sentEvents.length, 0);
  });

  test('a dispatch failure never touches the activity (stubbed simctl)', async () => {
    const activity = Object.freeze({ activityId: 'act_1', revision: 3, kind: 'invitation', status: 'published' });
    const before = structuredClone(activity);
    const failures: SimctlResult[] = [
      { kind: 'exited', exitCode: 1, stderr: 'boom' },
      { kind: 'not_started', reason: 'spawn ENOENT' },
      { kind: 'interrupted', reason: 'signal' },
    ];
    for (const failure of failures) {
      const { store } = memoryStore([outboxRow()]);
      const result = await dispatchNotification('ntf_1', { store, runSimctl: stubSimctl(failure).run, config });
      assert.notEqual(result.outcome, 'injected');
      assert.deepEqual(activity, before);
    }
    // The store port the dispatcher receives has no activity operation to call.
    const { store } = memoryStore([outboxRow()]);
    assert.deepEqual(Object.keys(store).sort(), ['claimNotification', 'listDispatchingNotifications', 'markNotificationFailed', 'markNotificationSent', 'markNotificationUnknown']);
  });

  test('an invalid outbox row is refused before any subprocess starts (stubbed simctl)', async () => {
    const valid = outboxRow({ status: 'dispatching', attemptCount: 1 });
    const invalidRows: unknown[] = [
      { ...valid, transport: 'apns' },
      { ...valid, activityRevision: -1 },
      { ...valid, runId: '' },
      { ...valid, status: 'pending' },
      { ...valid, notificationId: 'ntf_other' },
      { ...valid, extra: 'field' },
      'not an object',
    ];
    for (const invalid of invalidRows) {
      const store = memoryStore([outboxRow()]);
      store.store.claimNotification = async () => invalid;
      const simctl = stubSimctl();
      const result = await dispatchNotification('ntf_1', { store: store.store, runSimctl: simctl.run, config });

      assert.deepEqual(result, { outcome: 'refused', code: 'OUTBOX_ROW_INVALID' }, JSON.stringify(invalid));
      assert.equal(simctl.invocations.length, 0);
      assert.equal(store.sentEvents.length, 0);
    }
  });
});

describe('parseNotifyConfig', () => {
  test('rejects the booted destination and a malformed UDID before any dispatch (stubbed simctl)', () => {
    for (const deviceUdid of ['booted', '', 'iPad Pro', '7D23BEA3-2B8D-45CE-BC81', `${UDID} ; reboot`]) {
      assert.throws(() => parseNotifyConfig({ deviceUdid }), Error, deviceUdid);
    }
    assert.throws(() => parseNotifyConfig({ deviceUdid: UDID, bundleId: 'not a bundle' }));
    assert.deepEqual(parseNotifyConfig({ deviceUdid: UDID }), { deviceUdid: UDID, bundleId: 'com.llime.demo' });
  });
});

describe('runCommand', () => {
  const node = process.execPath;
  const checker = [
    '-e',
    `let d='';process.stdin.on('data',(c)=>{d+=c}).on('end',()=>{
      const literalArg=process.argv[1]===';touch /tmp/llime-injected';
      process.exit(d==='payload'&&literalArg&&process.env.OPENAI_API_KEY===undefined?0:3)})`,
    ';touch /tmp/llime-injected',
  ];

  test('passes arguments literally with no shell, writes stdin and strips credentials from the environment', async () => {
    process.env.OPENAI_API_KEY = 'must-not-reach-the-child';
    try {
      const result = await runCommand(node, checker, 'payload', { timeoutMs: 10_000 });
      assert.deepEqual(result, { kind: 'exited', exitCode: 0, stderr: '' });
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  test('reports a non-zero exit with its stderr', async () => {
    const result = await runCommand(node, ['-e', 'process.stderr.write("no such app");process.exit(7)'], '', { timeoutMs: 10_000 });
    assert.deepEqual(result, { kind: 'exited', exitCode: 7, stderr: 'no such app' });
  });

  test('reports a command that cannot start as not_started', async () => {
    const result = await runCommand('/nonexistent/llime-binary', [], '', { timeoutMs: 10_000 });
    assert.equal(result.kind, 'not_started');
  });

  test('kills a command that outlives its timeout and reports it interrupted', async () => {
    const result = await runCommand(node, ['-e', 'setTimeout(()=>{},60000)'], '', { timeoutMs: 200 });
    assert.deepEqual(result, { kind: 'interrupted', reason: 'timeout' });
  });
});
