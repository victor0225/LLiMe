// Outbox dispatcher: turns one committed NotificationOutbox row into exactly one simulated push to the
// run's configured iPad Simulator. It runs only after the activity commit that wrote the row, and it can
// fail without touching the activity: its store port has no activity operation to call.
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { NOTIFICATION_COPY } from './copy.js';
import { NotificationOutboxSchema, NotificationPayloadSchema } from './domain.js';
import { EVENT_PAYLOAD_SCHEMAS, type EventPayload } from './events.js';

export const DEFAULT_BUNDLE_ID = 'com.llime.demo';

// A push to a booted simulator answers in well under a second. Past this the outcome is unknowable
// (the OS may still have shown it), so the row is marked unknown rather than failed.
const SIMCTL_TIMEOUT_MS = 15_000;
const STDERR_CAPTURE_MAX_CHARS = 4_000;

// `simctl get_app_container` exits with the POSIX "no such file" code when the bundle is not installed.
// Other non-zero exits (a shut-down device, for one) say nothing about the app and keep their own code.
const APP_CONTAINER_MISSING_EXIT_CODE = 2;

// The only variables a child needs to find Xcode. Everything else, provider keys included, stays out.
const CHILD_ENV_ALLOWLIST = ['PATH', 'HOME', 'USER', 'TMPDIR', 'LANG', 'DEVELOPER_DIR'] as const;

export const NOTIFY_ERROR_CODES = {
  rowInvalid: 'OUTBOX_ROW_INVALID',
  payloadInvalid: 'PAYLOAD_INVALID',
  appNotInstalled: 'APP_NOT_INSTALLED',
  preflightInterrupted: 'PREFLIGHT_INTERRUPTED',
  notStarted: 'SIMCTL_NOT_STARTED',
  interrupted: 'DISPATCH_INTERRUPTED',
  receiptFailed: 'RECEIPT_WRITE_FAILED',
  simctlExit: (exitCode: number) => `SIMCTL_EXIT_${exitCode}`,
} as const;

// The destination is always an explicit device UDID: "booted" is ambiguous when more than one
// simulator runs, and another worker's device must never receive this run's notification.
const NotifyConfigSchema = z.strictObject({
  deviceUdid: z.guid(),
  bundleId: z.string().regex(/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/).default(DEFAULT_BUNDLE_ID),
});
export type NotifyConfig = z.infer<typeof NotifyConfigSchema>;

export function parseNotifyConfig(input: unknown): NotifyConfig {
  return NotifyConfigSchema.parse(input);
}

// The store functions the dispatcher consumes. `claimNotification` atomically moves a pending row to
// dispatching and adds one to attemptCount, returning null for any row that is not pending. Its result
// crossed a storage boundary, so it is typed `unknown` and validated here. `markNotificationSent`
// records the injected status and the notification.sent event in one transaction.
export interface NotifyStore {
  claimNotification(notificationId: string): Promise<unknown>;
  markNotificationSent(notificationId: string, event: EventPayload<'notification.sent'>): Promise<void>;
  markNotificationFailed(notificationId: string, lastErrorCode: string): Promise<void>;
  markNotificationUnknown(notificationId: string, lastErrorCode: string): Promise<void>;
  listDispatchingNotifications(): Promise<string[]>;
}

export type SimctlResult =
  | { kind: 'exited'; exitCode: number; stderr: string }
  | { kind: 'not_started'; reason: string }
  | { kind: 'interrupted'; reason: 'timeout' | 'signal' };

export type SimctlRunner = (command: string, args: readonly string[], stdin: string) => Promise<SimctlResult>;

export interface NotifyDeps {
  store: NotifyStore;
  runSimctl: SimctlRunner;
  config: NotifyConfig;
}

// `injected` means the simulator accepted the push, not that the OS displayed it or the child opened it.
export type DispatchResult =
  | { outcome: 'injected' }
  | { outcome: 'skipped'; reason: 'not_pending' }
  | { outcome: 'refused'; code: string }
  | { outcome: 'failed'; code: string }
  | { outcome: 'unknown'; code: string };

export async function dispatchNotification(notificationId: string, deps: NotifyDeps): Promise<DispatchResult> {
  const { store, runSimctl, config } = deps;
  const claimed = await store.claimNotification(notificationId);
  if (claimed === null) return { outcome: 'skipped', reason: 'not_pending' };

  const row = NotificationOutboxSchema.safeParse(claimed);
  const isClaimedRow = row.success && row.data.notificationId === notificationId && row.data.status === 'dispatching';
  if (!isClaimedRow) return refuse(store, notificationId, NOTIFY_ERROR_CODES.rowInvalid);

  const payload = NotificationPayloadSchema.safeParse({
    aps: { alert: { title: NOTIFICATION_COPY.title, body: NOTIFICATION_COPY.body }, sound: 'default' },
    notificationId: row.data.notificationId,
    runId: row.data.runId,
    activityId: row.data.activityId,
    activityRevision: row.data.activityRevision,
  });
  if (!payload.success) return refuse(store, notificationId, NOTIFY_ERROR_CODES.payloadInvalid);

  // `simctl push` exits 0 even when the bundle is not installed, so exit 0 alone cannot be trusted
  // to mean the app exists. Nothing has been pushed yet, so a preflight failure is a plain failure.
  const preflightFailure = await findPreflightFailure(runSimctl, config);
  if (preflightFailure !== null) return settleFailed(store, notificationId, preflightFailure);

  let result: SimctlResult;
  try {
    result = await runSimctl('xcrun', ['simctl', 'push', config.deviceUdid, config.bundleId, '-'], JSON.stringify(payload.data));
  } catch {
    // The runner failing says nothing about whether the OS received the push.
    return settleUnknown(store, notificationId, NOTIFY_ERROR_CODES.interrupted);
  }

  switch (result.kind) {
    case 'exited':
      return result.exitCode === 0 ? recordSent(store, row.data) : settleFailed(store, notificationId, NOTIFY_ERROR_CODES.simctlExit(result.exitCode));
    case 'not_started':
      return settleFailed(store, notificationId, NOTIFY_ERROR_CODES.notStarted);
    case 'interrupted':
      return settleUnknown(store, notificationId, NOTIFY_ERROR_CODES.interrupted);
    default:
      return assertNever(result);
  }
}

async function findPreflightFailure(runSimctl: SimctlRunner, config: NotifyConfig): Promise<string | null> {
  let result: SimctlResult;
  try {
    result = await runSimctl('xcrun', ['simctl', 'get_app_container', config.deviceUdid, config.bundleId], '');
  } catch {
    return NOTIFY_ERROR_CODES.preflightInterrupted;
  }
  switch (result.kind) {
    case 'exited':
      if (result.exitCode === 0) return null;
      return result.exitCode === APP_CONTAINER_MISSING_EXIT_CODE ? NOTIFY_ERROR_CODES.appNotInstalled : NOTIFY_ERROR_CODES.simctlExit(result.exitCode);
    case 'not_started':
      return NOTIFY_ERROR_CODES.notStarted;
    case 'interrupted':
      return NOTIFY_ERROR_CODES.preflightInterrupted;
    default:
      return assertNever(result);
  }
}

// After a restart, a row still dispatching belongs to a process that died between the push and its
// receipt. Whether the OS showed it is unknowable, so it becomes unknown; only a deliberate retry resends.
export async function recoverInterruptedNotifications(store: NotifyStore): Promise<string[]> {
  const interruptedIds = await store.listDispatchingNotifications();
  for (const id of interruptedIds) await store.markNotificationUnknown(id, NOTIFY_ERROR_CODES.interrupted);
  return interruptedIds;
}

async function recordSent(store: NotifyStore, row: z.infer<typeof NotificationOutboxSchema>): Promise<DispatchResult> {
  const event = EVENT_PAYLOAD_SCHEMAS['notification.sent'].parse({
    notificationId: row.notificationId,
    runId: row.runId,
    activityId: row.activityId,
    activityRevision: row.activityRevision,
  });
  try {
    await store.markNotificationSent(row.notificationId, event);
  } catch {
    // The push already left. Leaving the row dispatching would hide that, and a retry would send twice.
    return settleUnknown(store, row.notificationId, NOTIFY_ERROR_CODES.receiptFailed);
  }
  return { outcome: 'injected' };
}

async function refuse(store: NotifyStore, notificationId: string, code: string): Promise<DispatchResult> {
  await store.markNotificationFailed(notificationId, code);
  return { outcome: 'refused', code };
}

async function settleFailed(store: NotifyStore, notificationId: string, code: string): Promise<DispatchResult> {
  await store.markNotificationFailed(notificationId, code);
  return { outcome: 'failed', code };
}

async function settleUnknown(store: NotifyStore, notificationId: string, code: string): Promise<DispatchResult> {
  await store.markNotificationUnknown(notificationId, code);
  return { outcome: 'unknown', code };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled simctl result: ${JSON.stringify(value)}`);
}

export interface RunCommandOptions {
  timeoutMs: number;
}

// Runs a program with an argument array and no shell, so nothing in an argument or the payload is
// interpreted. The payload goes in on stdin.
export function runCommand(command: string, args: readonly string[], stdin: string, options: RunCommandOptions): Promise<SimctlResult> {
  return new Promise((resolve) => {
    const env = Object.fromEntries(CHILD_ENV_ALLOWLIST.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])));
    const child = spawn(command, [...args], { shell: false, stdio: ['pipe', 'ignore', 'pipe'], env });
    let stderr = '';
    let isTimedOut = false;
    let isSettled = false;
    const settle = (result: SimctlResult) => {
      if (isSettled) return;
      isSettled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      isTimedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(0, STDERR_CAPTURE_MAX_CHARS);
    });
    // A child that exits before reading stdin closes the pipe; its exit status is the real answer.
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => settle({ kind: 'not_started', reason: error.message }));
    child.on('close', (exitCode) => {
      if (isTimedOut) return settle({ kind: 'interrupted', reason: 'timeout' });
      if (exitCode === null) return settle({ kind: 'interrupted', reason: 'signal' });
      settle({ kind: 'exited', exitCode, stderr });
    });
    child.stdin.end(stdin);
  });
}

export const defaultSimctlRunner: SimctlRunner = (command, args, stdin) => runCommand(command, args, stdin, { timeoutMs: SIMCTL_TIMEOUT_MS });
