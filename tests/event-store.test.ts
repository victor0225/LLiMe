import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MATCHING_VERSION } from '../src/domain.js';
import { type RunEvent, type RunSnapshot, RunSnapshotSchema } from '../src/events.js';
import { routePath, SESSION_HEADER } from '../src/routes.js';
import { createEventStore, RunRequestError, type Schedule } from '../web/lib/event-store.js';

const RUN_ID = 'run-1';
const AT = '2026-11-09T10:00:00.000Z';
const COMMAND_IDS = ['6f1c1f43-2a52-4d6b-9a8e-6f8f7c0d9b11', '0b7a4e1c-3d2f-4c8e-9a6b-5e4d3c2b1a09'] as const;
const RUN_PATH = routePath('getRun', { runId: RUN_ID });
const EVENTS_PATH = routePath('runEvents', { runId: RUN_ID });
const COMMANDS_PATH = routePath('runCommand', { runId: RUN_ID });

const lessonEvent = (seq: number): RunEvent => ({ runId: RUN_ID, seq, type: 'lesson.detected', payload: { contentHash: `h${seq}`, source: 'local_file', bytes: 10 }, at: AT });
const committedEvent = (seq: number, revision: number): RunEvent => ({ runId: RUN_ID, seq, type: 'state.committed', payload: { phase: 'WAITING', revision, caseIds: [] }, at: AT });

function waitingRun({ seq, revision = seq, events = [] }: { seq: number; revision?: number; events?: RunEvent[] }): RunSnapshot {
  return RunSnapshotSchema.parse({
    phase: 'WAITING',
    stopped: false,
    studentId: 'student_7',
    corpusHash: 'corpus',
    matchingVersion: MATCHING_VERSION,
    seed: 1,
    lessonProblems: null,
    selectedProblems: null,
    explanationRevision: 0,
    cancellationEpoch: 0,
    clarificationRounds: 0,
    interventionCount: 0,
    continuationAllowed: false,
    runtime: null,
    lesson: null,
    invitation: null,
    activity: null,
    attempts: [],
    explanation: null,
    graph: null,
    search: null,
    error: null,
    createdAt: AT,
    id: RUN_ID,
    revision,
    seq,
    execution: { throughSeq: seq, events },
  });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bootstrap = (nonce: string) => json(200, { nonce, voice: 'missing_key', inputMode: 'typed', runtime: 'Codex App Server', database: 'Neo4j', dataset: 'synthetic' });
const accept = (commandId: string) => (run: RunSnapshot) => ({ type: 'accept' as const, commandId, revision: run.revision });

type Call = { method: string; url: string; session: string | null; body: unknown };

// A scripted server: each test answers requests in order and the calls are recorded.
function fakeServer(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchFake: typeof fetch = async (input, init) => {
    const call = { method: init?.method ?? 'GET', url: String(input), session: new Headers(init?.headers).get(SESSION_HEADER), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return answer(call);
  };
  return { calls, fetch: fetchFake, urls: () => calls.map((c) => c.url) };
}

// Runs scheduled polls only when the test asks, so no test waits on a real timer.
function manualClock() {
  const tasks: Array<() => Promise<void>> = [];
  const schedule: Schedule = (task) => {
    tasks.push(task);
    return () => tasks.splice(tasks.indexOf(task), 1);
  };
  return {
    schedule,
    pending: () => tasks.length,
    next: async () => {
      const task = tasks.shift();
      assert.ok(task, 'a poll is scheduled');
      await task();
    },
  };
}

describe('event feed', () => {
  test('loads the run snapshot before polling the events after its seq', async () => {
    const server = fakeServer((call) => (call.url === RUN_PATH ? json(200, waitingRun({ seq: 3, events: [lessonEvent(2)] })) : json(200, [lessonEvent(4)])));
    const clock = manualClock();
    const store = createEventStore(RUN_ID, { fetch: server.fetch, schedule: clock.schedule });
    store.start();
    await clock.next();
    assert.deepEqual(server.urls(), [RUN_PATH, `${EVENTS_PATH}?after=3`]);
    const view = store.getSnapshot();
    assert.equal(view.run?.seq, 3);
    assert.deepEqual(view.events.map((e) => e.seq), [2, 4]);
    assert.equal(view.lastSeq, 4);
    assert.equal(view.status, 'live');
  });

  test('appends events that continue the feed and drops ones already applied', async () => {
    const polls = [[lessonEvent(2), lessonEvent(3)], [lessonEvent(3), lessonEvent(4)]];
    const server = fakeServer((call) => (call.url === RUN_PATH ? json(200, waitingRun({ seq: 1 })) : json(200, polls.shift() ?? [])));
    const clock = manualClock();
    const store = createEventStore(RUN_ID, { fetch: server.fetch, schedule: clock.schedule });
    store.start();
    await clock.next();
    await clock.next();
    assert.deepEqual(store.getSnapshot().events.map((e) => e.seq), [2, 3, 4]);
    assert.equal(server.urls().at(-1), `${EVENTS_PATH}?after=3`);
  });

  test('a missing event reloads the snapshot instead of showing a broken history', async () => {
    const runs = [waitingRun({ seq: 1 }), waitingRun({ seq: 5, events: [lessonEvent(5)] })];
    const server = fakeServer((call) => (call.url === RUN_PATH ? json(200, runs.shift()) : json(200, call.url.endsWith('after=1') ? [lessonEvent(3)] : [])));
    const clock = manualClock();
    const store = createEventStore(RUN_ID, { fetch: server.fetch, schedule: clock.schedule });
    store.start();
    await clock.next();
    assert.deepEqual(store.getSnapshot().events, []);
    await clock.next();
    assert.deepEqual(server.urls().slice(2), [RUN_PATH, `${EVENTS_PATH}?after=5`]);
    assert.deepEqual(store.getSnapshot().events.map((e) => e.seq), [5]);
    assert.equal(store.getSnapshot().lastSeq, 5);
  });

  test('an unreachable server shows reconnecting and reloads the snapshot once polling recovers', async () => {
    const outcomes: Array<'ok' | '503' | 'offline'> = ['ok', '503', 'offline', 'ok'];
    const server = fakeServer((call) => {
      if (call.url === RUN_PATH) return json(200, waitingRun({ seq: 1 }));
      const outcome = outcomes.shift();
      if (outcome === 'offline') throw new TypeError('fetch failed');
      return outcome === '503' ? json(503, { code: 'RUNTIME_DISCONNECTED', message: 'Not ready', retryable: true }) : json(200, []);
    });
    const clock = manualClock();
    const store = createEventStore(RUN_ID, { fetch: server.fetch, schedule: clock.schedule });
    store.start();
    await clock.next();
    await clock.next();
    assert.equal(store.getSnapshot().status, 'reconnecting');
    await clock.next();
    assert.equal(store.getSnapshot().status, 'reconnecting');
    await clock.next();
    assert.equal(store.getSnapshot().status, 'live');
    assert.deepEqual(server.urls().slice(-2), [RUN_PATH, `${EVENTS_PATH}?after=1`]);
  });

  test('an unknown run fails visibly and stops polling', async () => {
    const server = fakeServer(() => json(404, { code: 'NOT_FOUND', message: 'Run not found', retryable: false }));
    const clock = manualClock();
    const store = createEventStore(RUN_ID, { fetch: server.fetch, schedule: clock.schedule });
    store.start();
    await clock.next();
    assert.equal(store.getSnapshot().status, 'failed');
    assert.match(store.getSnapshot().error ?? '', /404/);
    assert.equal(clock.pending(), 0);
  });

  test('a committed state change refreshes the run so the next command sees its revision', async () => {
    const runs = [waitingRun({ seq: 1 }), waitingRun({ seq: 2, revision: 2 })];
    const server = fakeServer((call) => (call.url === RUN_PATH ? json(200, runs.shift()) : json(200, call.url.endsWith('after=1') ? [committedEvent(2, 2)] : [])));
    const clock = manualClock();
    const store = createEventStore(RUN_ID, { fetch: server.fetch, schedule: clock.schedule });
    store.start();
    await clock.next();
    assert.equal(store.getSnapshot().run?.revision, 2);
    assert.deepEqual(store.getSnapshot().events.map((e) => e.seq), [2]);
  });
});

describe('run commands', () => {
  test('sends one mutation at a time and builds each from the run the previous one returned', async () => {
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    const server = fakeServer(async (call) => {
      if (call.url === routePath('bootstrap')) return bootstrap('n1');
      if (call.url === RUN_PATH) return json(200, waitingRun({ seq: 1 }));
      const revision = (call.body as { revision: number }).revision;
      if (revision === 1) await firstHeld;
      return json(200, waitingRun({ seq: revision + 1 }));
    });
    const store = createEventStore(RUN_ID, { fetch: server.fetch, schedule: manualClock().schedule });
    const first = store.sendRunCommand('runCommand', accept(COMMAND_IDS[0]));
    const second = store.sendRunCommand('runCommand', accept(COMMAND_IDS[1]));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(server.calls.filter((c) => c.method === 'POST').length, 1);
    releaseFirst();
    await Promise.all([first, second]);
    const posts = server.calls.filter((c) => c.method === 'POST');
    assert.deepEqual(posts.map((c) => c.body), [accept(COMMAND_IDS[0])(waitingRun({ seq: 1 })), accept(COMMAND_IDS[1])(waitingRun({ seq: 2 }))]);
    assert.equal(store.getSnapshot().run?.revision, 3);
  });

  test('sends the session nonce from bootstrap and reloads it once after a 403', async () => {
    const nonces = ['stale', 'fresh'];
    const server = fakeServer((call) => {
      if (call.url === routePath('bootstrap')) return bootstrap(nonces.shift() ?? 'none');
      if (call.url === RUN_PATH) return json(200, waitingRun({ seq: 1 }));
      return call.session === 'fresh' ? json(200, waitingRun({ seq: 2 })) : json(403, { code: 'INVALID_INPUT', message: 'Invalid session or origin', retryable: false });
    });
    const store = createEventStore(RUN_ID, { fetch: server.fetch, schedule: manualClock().schedule });
    await store.sendRunCommand('runCommand', accept(COMMAND_IDS[0]));
    const posts = server.calls.filter((c) => c.method === 'POST');
    assert.deepEqual(posts.map((c) => c.session), ['stale', 'fresh']);
    assert.deepEqual(posts[0]?.body, posts[1]?.body);
  });

  test('a 409 reloads the run and rejects without replaying the command', async () => {
    const runs = [waitingRun({ seq: 1 }), waitingRun({ seq: 6, revision: 5 })];
    const server = fakeServer((call) => {
      if (call.url === routePath('bootstrap')) return bootstrap('n1');
      if (call.url === RUN_PATH) return json(200, runs.shift());
      return json(409, { code: 'STALE_REVISION', message: 'The run moved on', retryable: true, revision: 5 });
    });
    const store = createEventStore(RUN_ID, { fetch: server.fetch, schedule: manualClock().schedule });
    await assert.rejects(store.sendRunCommand('runCommand', accept(COMMAND_IDS[0])), (error: unknown) => error instanceof RunRequestError && error.status === 409 && error.body?.code === 'STALE_REVISION');
    assert.equal(server.calls.filter((c) => c.method === 'POST').length, 1);
    assert.equal(store.getSnapshot().run?.revision, 5);
  });

  test('a voice answer without run state reloads the run before the next mutation', async () => {
    const runs = [waitingRun({ seq: 1 }), waitingRun({ seq: 2, revision: 2 })];
    const server = fakeServer((call) => {
      if (call.url === routePath('bootstrap')) return bootstrap('n1');
      if (call.url === RUN_PATH) return json(200, runs.shift());
      return json(201, { voiceSessionId: 'voice-1', sdpAnswer: 'v=0 answer', status: 'connecting' });
    });
    const store = createEventStore(RUN_ID, { fetch: server.fetch, schedule: manualClock().schedule });
    const answer = await store.sendRunCommand('createVoiceSession', (run) => ({ commandId: COMMAND_IDS[0], expectedRevision: run.revision, sdpOffer: 'v=0 offer' }));
    assert.equal(answer?.voiceSessionId, 'voice-1');
    assert.equal(store.getSnapshot().run?.revision, 2);
  });

  test('drops a queued action whose target changed, without a request', async () => {
    const server = fakeServer((call) => (call.url === RUN_PATH ? json(200, waitingRun({ seq: 1 })) : bootstrap('n1')));
    const store = createEventStore(RUN_ID, { fetch: server.fetch, schedule: manualClock().schedule });
    assert.equal(await store.sendRunCommand('runCommand', () => null), null);
    assert.equal(server.calls.filter((c) => c.method === 'POST').length, 0);
  });

  test('rejects a body that breaks the route schema before sending it', async () => {
    const server = fakeServer((call) => (call.url === RUN_PATH ? json(200, waitingRun({ seq: 1 })) : bootstrap('n1')));
    const store = createEventStore(RUN_ID, { fetch: server.fetch, schedule: manualClock().schedule });
    await assert.rejects(store.sendRunCommand('runCommand', accept('not-a-uuid')));
    assert.equal(server.calls.filter((c) => c.method === 'POST').length, 0);
  });
});
