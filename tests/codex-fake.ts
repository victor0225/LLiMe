// Test doubles for the Codex runtime adapter: a scripted stdio App Server, an in-memory run store
// that validates every event against the shared schemas, and a manual clock. No model is contacted.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ConceptLink, ErrorBody, RunState, ToolName, ToolResult } from '../src/domain.js';
import { RunStateSchema } from '../src/domain.js';
import { EventSchema, type RunEvent } from '../src/events.js';
import type { ChildProcessLike, Clock, RuntimeStore, SpawnOptions } from '../src/codex.js';
import type { NewEvent, TransitionRequest } from '../src/store.js';
import { DomainError } from '../src/store.js';

export const RUN_ID = 'run_codex_test';
export const THREAD_ID = 'thread_1';
export const MODEL = 'gpt-6.1-terra';
export const TIER_ID = 'priority';

type Json = Record<string, unknown>;
export type Received = { id?: string | number; method: string; params: Json };

export class ManualClock implements Clock {
  private current = 1_000_000;
  private timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  now = () => this.current;
  setTimer = (fn: () => void, ms: number) => {
    const timer = { at: this.current + ms, fn, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  // Runs every timer that falls due, in time order, as the clock moves.
  advance(ms: number) {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers.filter((t) => !t.cancelled && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.current = due.at;
      due.cancelled = true;
      due.fn();
    }
    this.current = target;
  }
}

export async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (condition()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export type Script = (request: Received, server: FakeAppServer) => unknown;
export type ServerReply = { id: string | number; result?: Json; error?: { code: number; message: string } };

// Default answers for the preflight and thread calls. A test overrides single methods.
export function defaultAnswers(overrides: Record<string, unknown> = {}): Script {
  const catalog = {
    data: [{ id: MODEL, serviceTiers: [{ id: TIER_ID, name: 'Fast' }], supportedReasoningEfforts: [{ reasoningEffort: 'low' }], defaultReasoningEffort: 'low', hidden: false, isDefault: false, defaultServiceTier: null }],
    nextCursor: null,
  };
  const table: Record<string, unknown> = {
    initialize: { userAgent: 'llime/0.166.0 (test)', codexHome: '/tmp/home', platformFamily: 'unix', platformOs: 'macos' },
    'account/read': { account: { type: 'chatgpt', email: null, planType: 'plus', workspaceName: null }, requiresOpenaiAuth: true, workspaceRouting: null },
    'config/read': { config: { mcp_servers: {} } },
    'mcpServerStatus/list': { data: [], nextCursor: null },
    'model/list': catalog,
    'thread/start': { thread: { id: THREAD_ID, sessionId: 'session_1', ephemeral: true }, model: MODEL, modelProvider: 'openai', serviceTier: TIER_ID, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' },
    ...overrides,
  };
  return (request) => table[request.method];
}

class FakeChild extends EventEmitter implements ChildProcessLike {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  signals: string[] = [];
  killed = false;
  kill(signal?: NodeJS.Signals): boolean {
    this.signals.push(signal ?? 'SIGTERM');
    this.killed = true;
    this.stdout.end();
    this.emit('exit', null, signal ?? 'SIGTERM');
    return true;
  }
  exitCleanly() {
    this.stdout.end();
    this.emit('exit', 0, null);
  }
}

// Speaks the newline-delimited protocol. It answers each client request through `script`; a request
// whose script result is `HOLD` stays unanswered until `answer` is called.
export const HOLD = Symbol('hold');

export class FakeAppServer {
  readonly child = new FakeChild();
  readonly received: Received[] = [];
  readonly spawns: { command: string; args: readonly string[]; options: SpawnOptions }[] = [];
  readonly replies: ServerReply[] = [];
  // Whether a scripted `turn/steer` should find an active turn.
  steerOk = false;
  private nextRequestId = 1;
  private readonly held = new Map<string, string | number>();
  private readonly serverRequestWaiters = new Map<string | number, (reply: ServerReply) => void>();

  constructor(public script: Script = defaultAnswers()) {
    let buffer = '';
    this.child.stdin.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        this.onLine(line);
      }
    });
  }

  spawn = (command: string, args: readonly string[], options: SpawnOptions): ChildProcessLike => {
    this.spawns.push({ command, args, options });
    return this.child;
  };

  private onLine(line: string) {
    const message = JSON.parse(line) as Json;
    const method = message.method;
    const id = message.id;
    if (typeof method !== 'string') {
      // A response to a request this fake made to the client.
      if (typeof id === 'string' || typeof id === 'number') {
        const reply: ServerReply = { id, ...(message.error ? { error: message.error as ServerReply['error'] } : { result: message.result as Json }) };
        this.replies.push(reply);
        this.serverRequestWaiters.get(id)?.(reply);
      }
      return;
    }
    const received: Received = { ...(typeof id === 'string' || typeof id === 'number' ? { id } : {}), method, params: (message.params ?? {}) as Json };
    this.received.push(received);
    if (received.id === undefined) return;
    const answer = this.script(received, this);
    if (answer === HOLD) {
      this.held.set(received.method, received.id);
      return;
    }
    if (answer instanceof Error) {
      this.write({ id: received.id, error: { code: -32000, message: answer.message } });
      return;
    }
    this.write({ id: received.id, result: answer ?? {} });
  }

  write(message: object) {
    this.child.stdout.write(`${JSON.stringify(message)}\n`);
  }

  // Answers a request that the script held back.
  answer(method: string, result: unknown) {
    const id = this.held.get(method);
    if (id === undefined) throw new Error(`No held ${method} request`);
    this.held.delete(method);
    this.write({ id, result });
  }

  notify(method: string, params: Json) {
    this.write({ method, params });
  }

  // Sends a request to the client and resolves with its reply.
  request(method: string, params: Json, id: string | number = `srv-${this.nextRequestId++}`): Promise<ServerReply> {
    const reply = new Promise<ServerReply>((resolve) => this.serverRequestWaiters.set(id, resolve));
    this.write({ id, method, params });
    return reply;
  }

  count(method: string): number {
    return this.received.filter((r) => r.method === method).length;
  }

  last(method: string): Received {
    const found = [...this.received].reverse().find((r) => r.method === method);
    if (!found) throw new Error(`No ${method} request was sent`);
    return found;
  }

  methods(): string[] {
    return this.received.map((r) => r.method);
  }

  // The usual happy start of a turn: `turn/start` is answered with this turn ID and a turn/started note.
  static turnStartsWith(turnId: string, base: Script = defaultAnswers()): Script {
    return (request, server) => {
      if (request.method === 'turn/start') {
        queueMicrotask(() => server.notify('turn/started', { threadId: THREAD_ID, turn: turnFor(turnId, 'inProgress') }));
        return { turn: turnFor(turnId, 'inProgress') };
      }
      if (request.method === 'turn/interrupt') {
        queueMicrotask(() => server.notify('turn/completed', { threadId: THREAD_ID, turn: turnFor(turnId, 'interrupted') }));
        return {};
      }
      return base(request, server);
    };
  }
}

export function turnFor(id: string, status: 'inProgress' | 'completed' | 'interrupted' | 'failed') {
  return { id, rootTurnId: null, items: [], itemsView: 'notLoaded', status, error: null, startedAt: null, completedAt: null, durationMs: null };
}

export function dynamicToolItem(callId: string, tool: string, status: 'inProgress' | 'completed' | 'failed' = 'inProgress') {
  return { type: 'dynamicToolCall', id: callId, namespace: null, tool, arguments: {}, status, contentItems: null, success: null };
}

export const finalJson = (overrides: Json = {}) =>
  JSON.stringify({ phase: 'ingestion', status: 'completed', activityId: null, caseId: null, evidenceIds: [], summary: 'done', ...overrides });

// ---------------------------------------------------------------------------------------------
// An in-memory store with the three operations the adapter uses. Events pass through EventSchema, so
// an event the real store would refuse is refused here too.

export function runState(overrides: Partial<RunState> = {}): RunState {
  return RunStateSchema.parse({
    phase: 'INGESTING',
    stopped: false,
    studentId: 'student_7',
    corpusHash: 'corpus-hash',
    matchingVersion: 'typed-path-v1',
    seed: 1,
    lessonProblems: null,
    selectedProblems: null,
    explanationRevision: 0,
    cancellationEpoch: 0,
    clarificationRounds: 0,
    interventionCount: 0,
    continuationAllowed: false,
    runtime: null,
    lesson: { contentHash: 'lesson-hash', text: 'Today we add 8 and 5.', source: 'local_file', savedAt: '2026-11-09T10:00:00.000Z' },
    invitation: null,
    activity: null,
    attempts: [],
    explanation: null,
    graph: null,
    search: null,
    error: null,
    createdAt: '2026-11-09T10:00:00.000Z',
    ...overrides,
  });
}

export class FakeRunStore implements RuntimeStore {
  state: RunState;
  revision = 3;
  events: RunEvent[] = [];
  transitions: string[] = [];
  voiceChanges: unknown[] = [];
  constructor(state: RunState = runState(), readonly runId = RUN_ID) {
    this.state = state;
  }
  async getRun(runId: string) {
    if (runId !== this.runId) throw new DomainError('NOT_FOUND', 'unknown run');
    return { id: runId, revision: this.revision, seq: this.events.length, state: this.state };
  }
  async getConceptLinks(): Promise<ConceptLink[]> {
    return [{ from: 'subtraction_within_20', to: 'addition_within_20', kind: 'similar', reason: 'Both operate within 20' }];
  }
  async appendEvents(runId: string, events: readonly NewEvent[]) {
    const written = events.map((event, i) => EventSchema.parse({ runId, seq: this.events.length + i + 1, type: event.type, payload: event.payload, at: '2026-11-09T10:00:01.000Z' }));
    this.events.push(...written);
    return written;
  }
  async transition<R>(request: TransitionRequest<R>): Promise<{ result: R; replayed: boolean }> {
    this.transitions.push(request.commandKey);
    const mutation = await request.apply({ state: this.state, revision: this.revision, seq: this.events.length, now: '2026-11-09T10:00:02.000Z', eventsOfType: async () => [], isActivityRendered: async () => false });
    this.state = RunStateSchema.parse(mutation.state);
    this.voiceChanges.push(...(mutation.voiceOperations ?? []));
    this.revision += 1;
    await this.appendEvents(request.runId, [...mutation.events, { type: 'state.committed', payload: { phase: this.state.phase, revision: this.revision, caseIds: [] } }]);
    const result = typeof mutation.result === 'function' ? (mutation.result as (events: RunEvent[]) => R)(this.events) : mutation.result;
    return { result, replayed: false };
  }
  ofType<T extends RunEvent['type']>(type: T): Extract<RunEvent, { type: T }>[] {
    return this.events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

// ---------------------------------------------------------------------------------------------
// Tool handlers

export function okResult(tool: ToolName): ToolResult {
  switch (tool) {
    case 'assess_attempt':
      return { ok: true, tool, data: { attemptId: 'attempt_1', passed: false, processCorrect: false, answerCorrect: true, hints: 0, retention: 'pending' } };
    case 'get_personal_memory':
      return {
        ok: true,
        tool,
        data: {
          memorySnapshotId: 'mem_1',
          studentId: 'student_7',
          corpusHash: 'corpus-hash',
          cases: [{ caseId: 'hist_sub_1', concept: 'subtraction_within_20', strategy: 'retry', outcome: 'failed', retention: 'pending', nodeIds: ['hist_sub_1:attempt'] }],
          summaries: [{ conceptId: 'subtraction_within_20', link: 'today', total: 1, independent: 0, assisted: 0, failed: 1, notAssessed: 0, firstAt: '2026-10-01T10:00:00.000Z', lastAt: '2026-10-01T10:00:00.000Z' }],
          unassessedConceptIds: [],
        },
      };
    default:
      throw new Error(`okResult has no example for ${tool}`);
  }
}

export function failureResult(tool: ToolName, error: ErrorBody): ToolResult {
  return { ok: false, tool, error, contextCommit: null };
}
