import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type IncomingHttpHeaders, request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { INVITATION_COPY } from '../src/copy.js';
import { HOST, parseConfig } from '../src/config.js';
import { type Activity, type Command, type ErrorCode, MATCHING_VERSION, type NotificationOutbox, type RunState, RunStateSchema } from '../src/domain.js';
import { EventSchema, type EventType, type RunEvent, RunSnapshotSchema } from '../src/events.js';
import { BootstrapSchema, HttpErrorSchema, LessonStatusSchema, LESSON_TEXT_MAX_BYTES, ROUTES, MAX_JSON_BODY_BYTES, routePath, SESSION_HEADER, VoiceSnapshotSchema, type VoiceSnapshot } from '../src/routes.js';
import { bootServer, type BootOptions, type RunningServer, type ServerPorts, SHUTDOWN_DEADLINE_MS } from '../src/server.js';
import type { RunRecord } from '../src/store.js';

// The configured port drives the Host and Origin checks; each test server listens on a free port and
// requests carry the configured Host, as the browser would.
const config = parseConfig({ PORT: '4990', VITE_PORT: '4991', STORYBOOK_PORT: '4992' });
const APP_HOST = `${HOST}:${config.port}`;
const NONCE = 'routes-test-nonce';
const AT = '2026-11-09T02:00:00.000Z';
const RUN = 'run-main';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let dist = '';

// ---------------------------------------------------------------------------------------------
// Builders and stubs. The stubs stand in for the store, engine, inbox, voice and runtime lanes and
// follow their published behavior: lane errors carry a shared code and, for conflicts, a revision.

function laneError(code: ErrorCode, message: string, revision?: number): Error {
  return Object.assign(new Error(message), { code, retryable: false, ...(revision === undefined ? {} : { revision }) });
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return RunStateSchema.parse({
    phase: 'WAITING',
    stopped: false,
    studentId: 'student_7',
    corpusHash: 'corpus-hash',
    matchingVersion: MATCHING_VERSION,
    seed: 7,
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
    ...overrides,
  });
}

function invitation(runId: string, revision: number): Activity {
  return {
    id: `${runId}_invitation`,
    revision,
    runId,
    kind: 'invitation',
    templateId: 'invitation_addition',
    strategy: null,
    problem: null,
    title: INVITATION_COPY.title,
    body: INVITATION_COPY.bodyLinkedConcept,
    primaryLabel: INVITATION_COPY.accept,
    secondaryLabel: INVITATION_COPY.later,
    activitySpec: null,
    specHash: null,
    helperCount: 0,
    evidenceIds: ['seed_7_0'],
    decisionSummary: 'Earlier subtraction needed help, so a short check finds out about addition.',
  };
}

function outboxRow(runId: string, activity: Activity, notificationId = 'notif-1'): NotificationOutbox {
  return { notificationId, runId, activityId: activity.id, activityRevision: activity.revision, transport: 'simulator', status: 'injected', attemptCount: 1, createdAt: AT, lastErrorCode: null };
}

class MemoryRuns {
  readonly runs = new Map<string, { record: RunRecord; events: RunEvent[] }>();
  readonly notifications = new Map<string, NotificationOutbox>();
  constructor(private readonly calls: string[]) {}

  add(id: string, state: RunState = runState()): void {
    this.runs.set(id, { record: { id, revision: 0, seq: 0, state }, events: [] });
  }

  private entry(runId: string) {
    const entry = this.runs.get(runId);
    if (!entry) throw laneError('NOT_FOUND', `Unknown run ${runId}`);
    return entry;
  }

  append(runId: string, events: readonly { type: EventType; payload: unknown }[]): RunEvent[] {
    const entry = this.entry(runId);
    const written = events.map((event, i) => EventSchema.parse({ runId, seq: entry.record.seq + i + 1, type: event.type, payload: event.payload, at: AT }));
    entry.events.push(...written);
    entry.record = { ...entry.record, seq: entry.record.seq + written.length };
    return written;
  }

  // A state transition: one revision, one state.committed event.
  commit(runId: string, state: RunState): RunRecord {
    const entry = this.entry(runId);
    const revision = entry.record.revision + 1;
    entry.record = { ...entry.record, revision, state };
    this.append(runId, [{ type: 'state.committed', payload: { phase: state.phase, revision, caseIds: [] } }]);
    return this.entry(runId).record;
  }

  async getRun(runId: string): Promise<RunRecord> {
    return structuredClone(this.entry(runId).record);
  }

  async events(runId: string, after = 0): Promise<RunEvent[]> {
    return this.entry(runId).events.filter((e) => e.seq > after);
  }

  async getNotification(notificationId: string): Promise<NotificationOutbox | null> {
    return this.notifications.get(notificationId) ?? null;
  }

  async appendEvents(runId: string, events: readonly { type: EventType; payload: unknown }[]): Promise<RunEvent[]> {
    this.calls.push(`store.appendEvents:${events.map((e) => e.type).join(',')}`);
    return this.append(runId, events);
  }

  async close(): Promise<void> {
    this.calls.push('store.close');
  }
}

// Commits every accepted command as one transition, with the store's receipt and revision rules.
class StubEngine {
  private readonly receipts = new Map<string, { body: string; record: RunRecord }>();
  private readonly recovered = new Set<string>();
  // A test can hold a command open to observe what happens while it is in progress.
  hold: Promise<void> | null = null;
  conflictWithoutRevision = false;

  constructor(
    private readonly store: MemoryRuns,
    private readonly calls: string[],
  ) {}

  async command(runId: string, command: Command): Promise<{ run: RunRecord; replayed: boolean }> {
    this.calls.push(`engine.command:${command.type}`);
    await this.hold;
    const outcome = await this.transition(runId, command.commandId, command.revision, command);
    this.calls.push(`engine.command:${command.type}:done`);
    return outcome;
  }

  async typedCorrection(runId: string, command: { commandId: string; expectedRunRevision: number }) {
    this.calls.push('engine.typedCorrection');
    return this.transition(runId, command.commandId, command.expectedRunRevision, command);
  }

  async activityRendered(runId: string, command: { commandId: string; expectedRunRevision: number }) {
    this.calls.push('engine.activityRendered');
    return this.transition(runId, command.commandId, command.expectedRunRevision, command);
  }

  private async transition(runId: string, commandId: string, revision: number, body: unknown): Promise<{ run: RunRecord; replayed: boolean }> {
    const run = await this.store.getRun(runId);
    const prior = this.receipts.get(`${runId}:${commandId}`);
    if (prior) {
      if (prior.body !== JSON.stringify(body)) throw laneError('CONFLICT', 'The same command was already committed with different content', this.conflictWithoutRevision ? undefined : run.revision);
      return { run: prior.record, replayed: true };
    }
    if (run.revision !== revision) throw laneError('STALE_REVISION', `The run is at revision ${run.revision}, not ${revision}`, run.revision);
    const record = this.store.commit(runId, run.state);
    this.receipts.set(`${runId}:${commandId}`, { body: JSON.stringify(body), record });
    return { run: record, replayed: false };
  }

  // Interrupted runs move to ERROR exactly once; a stopped run's cleanup is repeated every boot.
  async recoverInterrupted(): Promise<{ interrupted: string[]; cleaned: string[] }> {
    this.calls.push('engine.recoverInterrupted');
    const interrupted: string[] = [];
    const cleaned: string[] = [];
    for (const [id, { record }] of this.store.runs) {
      if (record.state.stopped) {
        this.calls.push(`engine.cleanup:${id}`);
        cleaned.push(id);
      } else if (record.state.phase === 'PROCESSING' && !this.recovered.has(id)) {
        this.store.commit(id, { ...record.state, phase: 'ERROR' });
        this.recovered.add(id);
        interrupted.push(id);
      }
    }
    return { interrupted, cleaned };
  }
}

const VOICE_SNAPSHOT: VoiceSnapshot = { voiceSessionId: 'live-1', status: 'live', activeOperationId: null, explanationRevision: 0, cancellationEpoch: 0, audioGate: 'open' };

type World = { calls: string[]; store: MemoryRuns; engine: StubEngine; signals: EventEmitter; ports: ServerPorts; runtimeClose: () => Promise<void> };

function makeWorld(): World {
  const calls: string[] = [];
  const store = new MemoryRuns(calls);
  const engine = new StubEngine(store, calls);
  const world: World = {
    calls,
    store,
    engine,
    signals: new EventEmitter(),
    runtimeClose: async () => {
      calls.push('runtime.close');
    },
    ports: {
      store,
      createRun: async (input) => {
        calls.push('store.createRun');
        const id = `run-${store.runs.size + 1}`;
        store.add(id, runState({ seed: input.seed ?? 42 }));
        return store.getRun(id);
      },
      engine,
      lessons: {
        readLesson: async (runId) => {
          calls.push(`lessons.readLesson:${runId}`);
          return { inboxFile: `.runtime/inbox/${runId}.txt`, saved: false, contentHash: null, prepared: null };
        },
        saveTranscript: async (runId, text) => {
          calls.push(`lessons.saveTranscript:${runId}:${text.length}`);
          return { saved: true, contentHash: `sha256-of-${text.length}` };
        },
      },
      voice: {
        routes: {
          createVoiceSession: async ({ params, body }) => {
            calls.push(`voice.createSession:${params.runId}:${body.commandId}`);
            return { voiceSessionId: 'live-1', sdpAnswer: 'v=0 answer', status: 'live' };
          },
          voiceSnapshot: async ({ params }) => {
            calls.push(`voice.snapshot:${params.runId}`);
            if (!store.runs.has(params.runId)) throw laneError('NOT_FOUND', `Unknown run ${params.runId}`);
            return VOICE_SNAPSHOT;
          },
          voiceCommand: async ({ body }) => {
            calls.push(`voice.command:${body.type}`);
            if (body.type === 'typed_correction') throw laneError('STALE_REVISION', 'The run moved on');
            return { ...VOICE_SNAPSHOT, audioGate: body.type === 'audio_gate_closed' ? 'closed' : 'open' };
          },
        },
        closeAll: async () => void calls.push('voice.closeAll'),
      },
      runtime: {
        interruptActiveTurns: async () => {
          calls.push('runtime.interruptActiveTurns');
        },
        close: () => world.runtimeClose(),
      },
      startInbox: async () => {
        calls.push('inbox.start');
        return { stop: async () => void calls.push('inbox.stop') };
      },
      startOutbox: async () => {
        calls.push('outbox.start');
        return { stop: async () => void calls.push('outbox.stop') };
      },
    },
  };
  store.add(RUN);
  return world;
}

async function boot(world: World, options: Partial<BootOptions> = {}): Promise<RunningServer> {
  const running = await bootServer(world.ports, { config, nonce: NONCE, frontend: { kind: 'static', distDir: dist }, dataset: 'synthetic test corpus', listenPort: 0, signals: world.signals, ...options });
  await running.ready;
  return running;
}

async function withServer(check: (server: RunningServer, world: World) => Promise<void>, world = makeWorld()) {
  const running = await boot(world);
  try {
    await check(running, world);
  } finally {
    await running.shutdown();
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP client: node:http, because fetch refuses to set the Host header.

type Reply = { status: number; headers: IncomingHttpHeaders; text: string };
const replies: Reply[] = [];

function send(server: RunningServer, { method = 'GET', path, headers = {}, body }: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port: server.port, method, path, agent: false, headers: { host: APP_HOST, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        const reply = { status: res.statusCode ?? 0, headers: res.headers, text };
        replies.push(reply);
        resolve(reply);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const authorized = { [SESSION_HEADER]: NONCE, origin: config.appOrigin, 'content-type': 'application/json' };
const post = (server: RunningServer, path: string, body: unknown, headers: Record<string, string> = {}) => send(server, { method: 'POST', path, body: JSON.stringify(body), headers: { ...authorized, ...headers } });
const json = (reply: Reply): unknown => JSON.parse(reply.text);
const errorOf = (reply: Reply) => HttpErrorSchema.parse(json(reply));
const eventsAfter = (server: RunningServer, runId: string, after: string) => send(server, { path: `${routePath('runEvents', { runId })}?after=${after}` });
const eventsOf = (reply: Reply) => ROUTES.runEvents.response.parse(json(reply));
const seqsOf = (reply: Reply) => eventsOf(reply).map((e) => e.seq);
const accept = (n: number, revision: number): Command => ({ type: 'accept', commandId: uuid(n), revision });

before(() => {
  dist = mkdtempSync(join(tmpdir(), 'llime-routes-'));
  for (const dir of ['assets', 'data/seed', '.runtime/inbox', 'captures']) mkdirSync(join(dist, dir), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>llime</title>');
  writeFileSync(join(dist, 'assets', 'app-1.js'), 'export {};');
  // Private files that must stay unreachable even if they ever ended up inside the build.
  writeFileSync(join(dist, '.env'), 'NEO4J_PASSWORD=never');
  writeFileSync(join(dist, 'data', 'seed', 'cases.json'), '[]');
  writeFileSync(join(dist, 'data', 'leak.js'), 'export {};');
  writeFileSync(join(dist, '.runtime', 'inbox', 'run.txt'), 'lesson');
  writeFileSync(join(dist, '.runtime', 'leak.js'), 'export {};');
  writeFileSync(join(dist, 'captures', 'leak.js'), 'export {};');
});

after(() => {
  rmSync(dist, { recursive: true, force: true });
  for (const reply of replies) assert.equal(Object.keys(reply.headers).filter((h) => h.startsWith('access-control-')).length, 0, 'no response ever carries a CORS header');
});

// ---------------------------------------------------------------------------------------------

describe('status codes', () => {
  test('unknown run is 404 on snapshot, events and commands (stub engine)', async () => {
    await withServer(async (server) => {
      const replies404 = [
        await send(server, { path: routePath('getRun', { runId: 'missing' }) }),
        await eventsAfter(server, 'missing', '0'),
        await post(server, routePath('runCommand', { runId: 'missing' }), accept(1, 0)),
      ];
      assert.deepEqual(replies404.map((r) => [r.status, errorOf(r).code]), Array(3).fill([404, 'NOT_FOUND']));
    });
  });

  test('stale revision, and the same commandId with a different body, are 409 with the current revision (stub engine)', async () => {
    await withServer(async (server) => {
      const path = routePath('runCommand', { runId: RUN });
      const stale = await post(server, path, accept(1, 5));
      assert.equal(stale.status, 409);
      assert.deepEqual([errorOf(stale).code, errorOf(stale).revision], ['STALE_REVISION', 0]);

      assert.equal((await post(server, path, accept(2, 0))).status, 200);
      const changed = await post(server, path, { type: 'stop_learning', commandId: uuid(2), revision: 0 });
      assert.equal(changed.status, 409);
      assert.deepEqual([errorOf(changed).code, errorOf(changed).revision], ['CONFLICT', 1]);

      const replay = await post(server, path, accept(2, 0));
      assert.equal(replay.status, 200);
      assert.equal(RunSnapshotSchema.parse(json(replay)).revision, 1);
    });
  });

  test('a 409 from a lane that leaves out the revision still carries the current run revision (stub engine)', async () => {
    const world = makeWorld();
    world.engine.conflictWithoutRevision = true;
    await withServer(async (server) => {
      const path = routePath('runCommand', { runId: RUN });
      await post(server, path, accept(3, 0));
      const changed = await post(server, path, { type: 'stop_learning', commandId: uuid(3), revision: 0 });
      assert.deepEqual([changed.status, errorOf(changed).revision], [409, 1]);
    }, world);
  });

  test('a wrong Host is 403; a POST with no nonce or a stale nonce is 403; a foreign Origin is 403; no Access-Control-* header is ever sent', async () => {
    await withServer(async (server, world) => {
      const path = routePath('runCommand', { runId: RUN });
      const refused = [
        await send(server, { path: routePath('bootstrap'), headers: { host: `localhost:${config.port}` } }),
        await send(server, { path: '/', headers: { host: `evil.example:${config.port}` } }),
        await send(server, { path: routePath('getRun', { runId: RUN }), headers: { host: `${HOST}:${config.port + 1}` } }),
        await send(server, { method: 'POST', path, body: JSON.stringify(accept(4, 0)), headers: { origin: config.appOrigin } }),
        await post(server, path, accept(4, 0), { [SESSION_HEADER]: 'nonce-from-an-earlier-server-process' }),
        await post(server, path, accept(4, 0), { origin: 'http://evil.example' }),
        await post(server, path, accept(4, 0), { origin: 'null' }),
        await post(server, path, accept(4, 0), { origin: `http://localhost:${config.port}` }),
      ];
      assert.deepEqual(refused.map((r) => [r.status, errorOf(r).code]), Array(refused.length).fill([403, 'FORBIDDEN']));
      const preflight = await send(server, { method: 'OPTIONS', path, headers: { origin: 'http://evil.example', 'access-control-request-method': 'POST' } });
      assert.notEqual(preflight.status, 204);
      assert.equal(world.calls.filter((c) => c.startsWith('engine.command')).length, 0);
    });
  });

  test('the configured Vite and Storybook origins may POST; the nonce is accepted only as a header and never logged', async () => {
    const logged: string[] = [];
    const originals = { log: console.log, error: console.error, warn: console.warn };
    for (const name of ['log', 'error', 'warn'] as const) console[name] = (...args: unknown[]) => logged.push(args.map(String).join(' '));
    try {
      await withServer(async (server) => {
        const path = routePath('runCommand', { runId: RUN });
        assert.equal((await post(server, path, accept(5, 0), { origin: `http://${HOST}:${config.vitePort}` })).status, 200);
        assert.equal((await post(server, path, accept(6, 1), { origin: `http://${HOST}:${config.storybookPort}` })).status, 200);
        assert.equal((await post(server, path, accept(7, 2))).status, 200, 'a request without an Origin header, such as an operator script, needs only the nonce');
        const inUrl = await send(server, { method: 'POST', path: `${path}?${SESSION_HEADER}=${NONCE}`, body: JSON.stringify(accept(8, 3)), headers: { origin: config.appOrigin } });
        assert.equal(inUrl.status, 403);
        const bootstrap = json(await send(server, { path: routePath('bootstrap') }));
        assert.equal(BootstrapSchema.parse(bootstrap).nonce, NONCE);
        assert.deepEqual([Reflect.get(Object(bootstrap), 'mode'), Reflect.get(Object(bootstrap), 'captureId')], ['live', null], 'the reply names live mode itself, not by schema default');
      });
    } finally {
      Object.assign(console, originals);
    }
    assert.ok(logged.every((line) => !line.includes(NONCE)), 'the session nonce never reaches a log');
  });

  test('65,537-byte JSON is 413; a 16,385-byte lesson is 413', async () => {
    await withServer(async (server, world) => {
      const command = JSON.stringify(accept(9, 0));
      const oversized = command.slice(0, -1) + ',"pad":"' + 'x'.repeat(MAX_JSON_BODY_BYTES + 1 - command.length - 9) + '"}';
      assert.equal(Buffer.byteLength(oversized), MAX_JSON_BODY_BYTES + 1);
      const tooLarge = await send(server, { method: 'POST', path: routePath('runCommand', { runId: RUN }), body: oversized, headers: authorized });
      assert.deepEqual([tooLarge.status, errorOf(tooLarge).code], [413, 'PAYLOAD_TOO_LARGE']);

      const lesson = routePath('saveLesson', { runId: RUN });
      const atLimit = await post(server, lesson, { text: 'a'.repeat(LESSON_TEXT_MAX_BYTES) });
      assert.equal(atLimit.status, 202);
      for (const text of ['a'.repeat(LESSON_TEXT_MAX_BYTES + 1), 'é'.repeat(LESSON_TEXT_MAX_BYTES / 2 + 1)]) {
        const reply = await post(server, lesson, { text });
        assert.deepEqual([reply.status, errorOf(reply).code], [413, 'PAYLOAD_TOO_LARGE'], `${text.length} characters`);
      }
      assert.equal(world.calls.filter((c) => c.startsWith('lessons.saveTranscript')).length, 1, 'only the lesson within the limit is saved');
      assert.equal(world.calls.filter((c) => c.startsWith('engine.command')).length, 0);
    });
  });

  test('after=-1, 1.5 and abc are 400', async () => {
    await withServer(async (server) => {
      for (const after of ['-1', '1.5', 'abc', '', '01']) {
        const reply = await eventsAfter(server, RUN, after);
        assert.deepEqual([reply.status, errorOf(reply).code], [400, 'INVALID_INPUT'], `after=${after}`);
      }
      assert.equal((await send(server, { path: routePath('runEvents', { runId: RUN }) })).status, 400, 'a missing cursor');
    });
  });
});

describe('polling', () => {
  test('events?after=N returns seq > N in order; the same cursor twice returns the same events; resuming after N loses nothing (BUILD19, stub store)', async () => {
    await withServer(async (server, world) => {
      for (let i = 0; i < 5; i += 1) world.store.commit(RUN, runState());
      const first = await eventsAfter(server, RUN, '0');
      assert.deepEqual(seqsOf(first), [1, 2, 3, 4, 5]);
      const fromTwo = await eventsAfter(server, RUN, '2');
      assert.deepEqual(seqsOf(fromTwo), [3, 4, 5]);
      assert.equal((await eventsAfter(server, RUN, '2')).text, fromTwo.text, 'the same cursor returns the same events');

      // Polling stops at seq 5 while the run keeps committing; resuming from 5 returns exactly what was missed.
      world.store.append(RUN, [{ type: 'lesson.detected', payload: { contentHash: 'h1', source: 'local_file', bytes: 12 } }]);
      world.store.commit(RUN, runState({ phase: 'INGESTING' }));
      const resumed = await eventsAfter(server, RUN, '5');
      assert.deepEqual(seqsOf(resumed), [6, 7]);
      assert.deepEqual([...eventsOf(first), ...eventsOf(resumed)], eventsOf(await eventsAfter(server, RUN, '0')));
      assert.deepEqual(json(await eventsAfter(server, RUN, '99')), []);
    });
  });

  test('the snapshot is the state plus id, revision, seq and every saved event through seq (stub store)', async () => {
    await withServer(async (server, world) => {
      world.store.commit(RUN, runState({ phase: 'INGESTING' }));
      world.store.append(RUN, [{ type: 'lesson.detected', payload: { contentHash: 'h1', source: 'local_file', bytes: 12 } }]);
      const snapshot = RunSnapshotSchema.parse(json(await send(server, { path: routePath('getRun', { runId: RUN }) })));
      assert.deepEqual([snapshot.id, snapshot.revision, snapshot.seq, snapshot.phase], [RUN, 1, 2, 'INGESTING']);
      assert.equal(snapshot.execution.throughSeq, snapshot.seq);
      assert.deepEqual(snapshot.execution.events.map((e) => e.type), ['state.committed', 'lesson.detected']);
    });
  });

  test('a command answers with the snapshot at its receipt, so a replay never carries later events (stub engine)', async () => {
    await withServer(async (server, world) => {
      const path = routePath('runCommand', { runId: RUN });
      const first = RunSnapshotSchema.parse(json(await post(server, path, accept(10, 0))));
      assert.deepEqual([first.revision, first.seq, first.execution.throughSeq], [1, 1, 1]);
      world.store.append(RUN, [{ type: 'lesson.detected', payload: { contentHash: 'h2', source: 'local_file', bytes: 3 } }]);
      const replay = RunSnapshotSchema.parse(json(await post(server, path, accept(10, 0))));
      assert.deepEqual([replay.seq, replay.execution.throughSeq, replay.execution.events.length], [1, 1, 1]);
    });
  });

  test('a new run answers 201 with its snapshot and the seed it was given (stub engine)', async () => {
    await withServer(async (server) => {
      const reply = await post(server, routePath('createRun'), { seed: 4294967295 });
      assert.equal(reply.status, 201);
      const snapshot = RunSnapshotSchema.parse(json(reply));
      assert.deepEqual([snapshot.seed, snapshot.revision, snapshot.seq, snapshot.execution.events.length], [4294967295, 0, 0, 0]);
      assert.equal((await post(server, routePath('createRun'), { seed: 4294967296 })).status, 400);
    });
  });
});

describe('lesson', () => {
  test('POST lesson calls only saveTranscript and returns 202 {saved:true, contentHash}; nothing reaches the engine or runtime (BUILD28, stub inbox)', async () => {
    await withServer(async (server, world) => {
      const before = world.calls.length;
      const reply = await post(server, routePath('saveLesson', { runId: RUN }), { text: 'Today we put things together.' });
      assert.equal(reply.status, 202);
      assert.deepEqual(json(reply), { saved: true, contentHash: 'sha256-of-29' });
      assert.deepEqual(world.calls.slice(before), [`lessons.saveTranscript:${RUN}:29`]);
    });
  });

  test('GET lesson returns the inbox status, and both lesson routes are 404 for an unknown run (stub inbox)', async () => {
    await withServer(async (server, world) => {
      const status = await send(server, { path: routePath('getLesson', { runId: RUN }) });
      assert.deepEqual([status.status, LessonStatusSchema.parse(json(status)).saved], [200, false]);
      assert.equal((await send(server, { path: routePath('getLesson', { runId: 'missing' }) })).status, 404);
      assert.equal((await post(server, routePath('saveLesson', { runId: 'missing' }), { text: 'x' })).status, 404);
      assert.equal(world.calls.filter((c) => c.includes('missing')).length, 0, 'an unknown run never reaches the inbox');
    });
  });
});

describe('voice routes', () => {
  test('voice commands reach the bound voice handlers behind the session guard, and a conflict from them carries the run revision (stub voice)', async () => {
    await withServer(async (server, world) => {
      const path = routePath('voiceCommand', { runId: RUN });
      const closed = await post(server, path, { type: 'audio_gate_closed', commandId: uuid(22), expectedRunRevision: 0, voiceSessionId: 'live-1' });
      assert.equal(VoiceSnapshotSchema.parse(json(closed)).audioGate, 'closed');
      const stale = await post(server, path, { type: 'typed_correction', commandId: uuid(23), expectedRunRevision: 0, voiceSessionId: null, text: 'I counted the eight.' });
      assert.deepEqual([stale.status, errorOf(stale).code, errorOf(stale).revision], [409, 'STALE_REVISION', 0]);
      const noNonce = await send(server, { method: 'POST', path, body: JSON.stringify({ type: 'close_voice', commandId: uuid(24), expectedRunRevision: 0, voiceSessionId: 'live-1' }) });
      assert.equal(noNonce.status, 403);
      assert.deepEqual(world.calls.filter((c) => c.startsWith('voice.command')), ['voice.command:audio_gate_closed', 'voice.command:typed_correction']);
    });
  });

  test('voice session creation and the voice snapshot are answered by voice, and are 404 for an unknown run (stub voice)', async () => {
    await withServer(async (server) => {
      const created = await post(server, routePath('createVoiceSession', { runId: RUN }), { commandId: uuid(24), expectedRevision: 0, sdpOffer: 'v=0 offer' });
      assert.deepEqual([created.status, ROUTES.createVoiceSession.response.parse(json(created)).voiceSessionId], [201, 'live-1']);
      assert.equal(VoiceSnapshotSchema.parse(json(await send(server, { path: routePath('voiceSnapshot', { runId: RUN }) }))).status, 'live');
      assert.equal((await send(server, { path: routePath('voiceSnapshot', { runId: 'missing' }) })).status, 404);
    });
  });
});

describe('notification opened', () => {
  function invitedWorld() {
    const world = makeWorld();
    const offer = invitation(RUN, 2);
    world.store.commit(RUN, runState({ phase: 'INVITED', invitation: offer }));
    world.store.notifications.set('notif-1', outboxRow(RUN, offer));
    return { world, offer };
  }
  const tap = (server: RunningServer, offer: Activity, n: number, notificationId = 'notif-1') =>
    post(server, routePath('notificationOpened', { runId: RUN, notificationId }), { commandId: uuid(n), activityId: offer.id, activityRevision: offer.revision });

  test('a tap on the current activity records notification.opened once, however often it repeats (stub store)', async () => {
    const { world, offer } = invitedWorld();
    await withServer(async (server) => {
      const first = await tap(server, offer, 30);
      assert.equal(first.status, 200);
      const snapshot = RunSnapshotSchema.parse(json(first));
      assert.equal(snapshot.execution.events.at(-1)?.type, 'notification.opened');
      assert.equal(snapshot.revision, 1, 'opening is not consent: the run does not move');
      const again = RunSnapshotSchema.parse(json(await tap(server, offer, 31)));
      assert.equal(again.seq, snapshot.seq);
      assert.equal(world.calls.filter((c) => c === 'store.appendEvents:notification.opened').length, 1);
    }, world);
  });

  test('a tap naming another activity or a superseded one is 409 with the current revision; an unknown notification is 404 (stub store)', async () => {
    const { world, offer } = invitedWorld();
    const old = invitation(RUN, 1);
    world.store.notifications.set('notif-old', outboxRow(RUN, old, 'notif-old'));
    await withServer(async (server) => {
      const mismatch = await tap(server, { ...offer, revision: 9 }, 32);
      const superseded = await tap(server, old, 33, 'notif-old');
      for (const reply of [mismatch, superseded]) assert.deepEqual([reply.status, errorOf(reply).revision], [409, 1]);
      assert.equal((await tap(server, offer, 34, 'notif-missing')).status, 404);
      assert.equal(world.calls.filter((c) => c.startsWith('store.appendEvents')).length, 0);
    }, world);
  });
});

describe('static files', () => {
  test('only allowlisted dist files are served, with the CSP header; /.env, /.runtime/… and /data/… are 404', async () => {
    await withServer(async (server) => {
      for (const path of ['/', '/assets/app-1.js', '/lesson-notes']) {
        const reply = await send(server, { path });
        assert.equal(reply.status, 200, path);
        assert.match(String(reply.headers['content-security-policy']), /default-src 'self'.*object-src 'none'/, path);
      }
      const head = await send(server, { method: 'HEAD', path: '/' });
      assert.deepEqual([head.status, head.text], [200, '']);
      for (const path of ['/.env', '/.runtime', '/.runtime/inbox/run.txt', '/.runtime/leak.js', '/data', '/data/seed', '/data/seed/cases.json', '/data/leak.js', '/captures/leak.js', '/%2e%2e/package.json']) {
        assert.equal((await send(server, { path })).status, 404, path);
      }
    });
  });
});

describe('lanes not yet bound', () => {
  test('without the engine, voice and Codex modules their routes answer NOT_READY, while runs, events and lessons work (stub store, stub inbox)', async () => {
    const world = makeWorld();
    world.ports = { ...world.ports, engine: undefined, voice: undefined, runtime: undefined };
    await withServer(async (server) => {
      const created = await post(server, routePath('createRun'), { seed: 8 });
      assert.equal(created.status, 201);
      const runId = RunSnapshotSchema.parse(json(created)).id;
      assert.equal((await send(server, { path: routePath('getRun', { runId }) })).status, 200);
      assert.equal((await eventsAfter(server, runId, '0')).status, 200);
      assert.equal((await post(server, routePath('saveLesson', { runId }), { text: 'Today we add.' })).status, 202);
      const unbound = [
        await post(server, routePath('runCommand', { runId }), accept(60, 0)),
        await post(server, routePath('createVoiceSession', { runId }), { commandId: uuid(61), expectedRevision: 0, sdpOffer: 'v=0 offer' }),
        await send(server, { path: routePath('voiceSnapshot', { runId }) }),
        await post(server, routePath('voiceCommand', { runId }), { type: 'close_voice', commandId: uuid(62), expectedRunRevision: 0, voiceSessionId: 'live-1' }),
      ];
      assert.deepEqual(unbound.map((r) => [r.status, errorOf(r).code]), Array(4).fill([503, 'NOT_READY']));
    }, world);
  });
});

describe('lifecycle', () => {
  test('boot runs recoverInterrupted before the first writable request; a second boot changes nothing (stub engine)', async () => {
    const world = makeWorld();
    world.store.add('run-interrupted', runState({ phase: 'PROCESSING' }));
    world.store.add('run-stopped', runState({ phase: 'PRACTICE', stopped: true }));
    let finishRecovery = () => {};
    const recovery = new Promise<void>((resolve) => (finishRecovery = resolve));
    const recover = world.engine.recoverInterrupted.bind(world.engine);
    world.engine.recoverInterrupted = async () => {
      await recovery;
      return recover();
    };

    const running = await bootServer(world.ports, { config, nonce: NONCE, frontend: { kind: 'static', distDir: dist }, dataset: 'synthetic test corpus', listenPort: 0, signals: world.signals });
    try {
      const early = await post(running, routePath('runCommand', { runId: RUN }), accept(40, 0));
      assert.deepEqual([early.status, errorOf(early).code, errorOf(early).retryable], [503, 'NOT_READY', true]);
      finishRecovery();
      await running.ready;
      assert.equal((await post(running, routePath('runCommand', { runId: RUN }), accept(41, 0))).status, 200);
    } finally {
      await running.shutdown();
    }
    assert.deepEqual(world.calls.slice(0, 5), [
      'engine.recoverInterrupted',
      'engine.cleanup:run-stopped',
      'inbox.start',
      'outbox.start',
      'engine.command:accept',
    ]);
    assert.equal((await world.store.getRun('run-interrupted')).state.phase, 'ERROR');

    const afterFirstBoot = JSON.stringify([...world.store.runs]);
    const callsBefore = world.calls.length;
    const second = await boot(world);
    await second.shutdown();
    assert.equal(JSON.stringify([...world.store.runs]), afterFirstBoot, 'a second boot commits nothing');
    const secondBootCalls = world.calls.slice(callsBefore);
    assert.ok(secondBootCalls.includes('engine.cleanup:run-stopped'), 'resource cleanup is retried');
    assert.equal(secondBootCalls.filter((c) => c.startsWith('engine.command')).length, 0, 'no learning or model work is restarted');
  });

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`${signal} closes the server, driver and runtime within 5 s (stub runtime)`, async () => {
      const world = makeWorld();
      const running = await boot(world);
      const started = performance.now();
      world.signals.emit(signal);
      const report = await running.stopped;
      assert.deepEqual([report.forced, report.failures], [false, []]);
      assert.ok(performance.now() - started < SHUTDOWN_DEADLINE_MS);
      const order = ['inbox.stop', 'outbox.stop', 'voice.closeAll', 'runtime.interruptActiveTurns', 'store.close', 'runtime.close'].map((c) => world.calls.indexOf(c));
      assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > (order[i - 1] ?? -1))), `shutdown order: ${world.calls.join(', ')}`);
      await assert.rejects(
        new Promise<void>((resolve, reject) => connect(running.port, HOST).once('connect', resolve).once('error', reject)),
        { code: 'ECONNREFUSED' },
      );
    });
  }

  test('shutdown lets a request in progress commit before it closes the driver (stub engine)', async () => {
    const world = makeWorld();
    let release = () => {};
    world.engine.hold = new Promise<void>((resolve) => (release = resolve));
    const running = await boot(world);
    const pending = post(running, routePath('runCommand', { runId: RUN }), accept(50, 0));
    while (!world.calls.includes('engine.command:accept')) await new Promise((resolve) => setImmediate(resolve));
    const stopped = running.shutdown();
    release();
    assert.equal((await pending).status, 200);
    await stopped;
    assert.ok(world.calls.indexOf('engine.command:accept:done') < world.calls.indexOf('store.close'));
  });

  test('shutdown stops waiting at its deadline when a resource hangs, and says so (stub runtime)', async () => {
    const world = makeWorld();
    world.runtimeClose = () => new Promise<void>(() => {});
    const running = await boot(world, { shutdownDeadlineMs: 50 });
    const report = await running.shutdown();
    assert.equal(report.forced, true);
    assert.ok(report.elapsedMs < 1000);
  });
});
