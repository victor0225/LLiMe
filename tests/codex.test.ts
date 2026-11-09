import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { createCodexRuntime, createServerRuntimePort, RuntimeFailure, type CallTool, type CodexRuntime } from '../src/codex.js';
import { TOOL_SCHEMAS, ToolNameSchema, type ToolName, type ToolResult } from '../src/domain.js';
import type { ToolContext } from '../src/tools.js';
import {
  defaultAnswers,
  dynamicToolItem,
  failureResult,
  FakeAppServer,
  FakeRunStore,
  finalJson,
  HOLD,
  ManualClock,
  MODEL,
  okResult,
  RUN_ID,
  runState,
  THREAD_ID,
  TIER_ID,
  turnFor,
  until,
} from './codex-fake.js';

const TURN_ID = 'turn_1';
const FIVE_TOOLS = ToolNameSchema.options;

type Handlers = Partial<Record<ToolName, (context: ToolContext, args: unknown) => Promise<ToolResult>>>;

type Setup = { runtime: CodexRuntime; server: FakeAppServer; store: FakeRunStore; clock: ManualClock; calls: { tool: ToolName; context: ToolContext; args: unknown }[] };

function setup(options: { script?: FakeAppServer['script']; handlers?: Handlers; store?: FakeRunStore; env?: NodeJS.ProcessEnv; serviceTier?: string | undefined; model?: string } = {}): Setup {
  const server = new FakeAppServer(options.script ?? FakeAppServer.turnStartsWith(TURN_ID));
  const store = options.store ?? new FakeRunStore();
  const clock = new ManualClock();
  const calls: Setup['calls'] = [];
  const callTool: CallTool = async (context, tool, args) => {
    const handler = options.handlers?.[tool];
    if (handler) return handler(context, args);
    calls.push({ tool, context, args });
    return okResult(tool);
  };
  const runtime = createCodexRuntime({
    store,
    callTool,
    spawnChild: server.spawn,
    clock,
    env: options.env ?? { PATH: '/usr/bin', HOME: '/home/tester' },
    config: { command: '/repo/node_modules/.bin/codex', cwd: '/repo/.runtime/agent', model: options.model ?? MODEL, serviceTier: 'serviceTier' in options ? options.serviceTier : TIER_ID },
  });
  return { runtime, server, store, clock, calls };
}

const lessonInput = { lessonInput: 'Today we add 8 and 5.' };
const ingestion = (input: object = lessonInput) => ({ runId: RUN_ID, phase: 'ingestion' as const, input });

async function startedTurn(s: Setup) {
  const turn = await s.runtime.startTurn(ingestion());
  await until(() => s.server.count('turn/start') === 1, 'turn/start');
  return turn;
}

const callParams = (callId: string, tool: string, args: object = {}) => ({ threadId: THREAD_ID, turnId: TURN_ID, callId, namespace: null, tool, arguments: args });
const toolReplyText = (text: string) => JSON.parse(text) as { ok: boolean; tool: string; error?: { code: string } };

describe('child process', () => {
  test('child env lacks OPENAI_API_KEY and NEO4J_PASSWORD; spawn uses an argument array, no shell (mocked Codex)', async () => {
    const s = setup({ env: { PATH: '/usr/bin', HOME: '/home/tester', OPENAI_API_KEY: 'sk-secret', NEO4J_PASSWORD: 'db-secret', NEO4J_USER: 'neo4j', CODEX_HOME: '/home/tester/.codex' } });
    await s.runtime.startTurn(ingestion());
    const [spawn] = s.server.spawns;
    assert.ok(spawn);
    assert.ok(Array.isArray(spawn.args));
    assert.equal(spawn.command, '/repo/node_modules/.bin/codex');
    assert.equal(spawn.args[0], 'app-server');
    assert.ok(spawn.args.every((arg) => typeof arg === 'string'));
    assert.equal(spawn.options.shell, undefined);
    assert.equal(spawn.options.cwd, '/repo/.runtime/agent');
    assert.deepEqual(Object.keys(spawn.options.env).filter((k) => ['OPENAI_API_KEY', 'NEO4J_PASSWORD', 'NEO4J_USER'].includes(k)), []);
    assert.equal(spawn.options.env.HOME, '/home/tester');
    assert.equal(spawn.options.env.CODEX_HOME, '/home/tester/.codex');
    assert.ok(!JSON.stringify(spawn).includes('sk-secret'));
  });

  test('no thread/start before initialize succeeds and initialized is sent (mocked Codex)', async () => {
    const answers = defaultAnswers();
    const s = setup({ script: (request, server) => (request.method === 'initialize' ? HOLD : FakeAppServer.turnStartsWith(TURN_ID, answers)(request, server)) });
    const started = s.runtime.startTurn(ingestion());
    await until(() => s.server.count('initialize') === 1, 'initialize');
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(s.server.methods(), ['initialize']);
    const init = s.server.last('initialize').params as { capabilities: { experimentalApi: boolean } };
    assert.equal(init.capabilities.experimentalApi, true);
    s.server.answer('initialize', defaultAnswers()({ method: 'initialize', params: {} }, s.server));
    await started;
    const order = s.server.methods();
    assert.equal(order.indexOf('initialize'), 0);
    assert.equal(order[1], 'initialized');
    assert.ok(order.indexOf('thread/start') > order.indexOf('initialized'));
  });
});

describe('tool registration and dispatch', () => {
  test('registers exactly the five tools with schemas generated from the core (mocked Codex)', async () => {
    const s = setup();
    await s.runtime.startTurn(ingestion());
    const params = s.server.last('thread/start').params as { dynamicTools: { type: string; name: string; inputSchema: unknown; deferLoading: boolean }[]; ephemeral: boolean; approvalPolicy: string; sandbox: string; environments: unknown[]; model: string; serviceTier: string; allowProviderModelFallback: boolean };
    assert.deepEqual(params.dynamicTools.map((t) => t.name), [...FIVE_TOOLS]);
    for (const tool of params.dynamicTools) {
      assert.equal(tool.type, 'function');
      assert.equal(tool.deferLoading, false);
      assert.deepEqual(tool.inputSchema, z.toJSONSchema(TOOL_SCHEMAS[tool.name as ToolName].input, { io: 'input' }));
    }
    assert.equal(params.ephemeral, true);
    assert.equal(params.approvalPolicy, 'never');
    assert.equal(params.sandbox, 'read-only');
    assert.deepEqual(params.environments, []);
    assert.equal(params.allowProviderModelFallback, false);
    assert.equal(params.model, MODEL);
    assert.equal(params.serviceTier, TIER_ID);
  });

  test('item/tool/call is answered with the same request ID and the canonical ToolResult; success follows handler ok, not learner correctness (mocked Codex)', async () => {
    const s = setup({
      handlers: {
        get_personal_memory: async () => failureResult('get_personal_memory', { code: 'VALIDATION_FAILED', message: 'conceptIds[1] is not linked', retryable: false }),
      },
    });
    await startedTurn(s);
    // assess_attempt returns passed:false (an educational failure): still ok:true, success:true.
    const assess = await s.server.request('item/tool/call', callParams('call_a', 'assess_attempt', { attemptId: 'attempt_1', criterion: 'initial' }), 'rpc-77');
    assert.equal(assess.id, 'rpc-77');
    const assessResult = assess.result as { success: boolean; contentItems: { type: string; text: string }[] };
    assert.equal(assessResult.success, true);
    assert.equal(assessResult.contentItems.length, 1);
    assert.equal(assessResult.contentItems[0]?.type, 'inputText');
    assert.deepEqual(toolReplyText(assessResult.contentItems[0]?.text ?? ''), okResult('assess_attempt'));
    const memory = await s.server.request('item/tool/call', callParams('call_b', 'get_personal_memory', { conceptIds: ['addition_within_20'], includeUnassessed: true }), 99);
    assert.equal(memory.id, 99);
    const memoryResult = memory.result as { success: boolean; contentItems: { text: string }[] };
    assert.equal(memoryResult.success, false);
    assert.equal(toolReplyText(memoryResult.contentItems[0]?.text ?? '').error?.code, 'VALIDATION_FAILED');
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0]?.context.threadId, THREAD_ID);
    assert.equal(s.calls[0]?.context.turnId, TURN_ID);
    assert.equal(s.calls[0]?.context.runId, RUN_ID);
    assert.equal(s.calls[0]?.context.studentId, 'student_7');
  });

  test('a repeated callId runs the handler once (mocked Codex)', async () => {
    const s = setup();
    await startedTurn(s);
    const args = { attemptId: 'attempt_1', criterion: 'initial' };
    const first = await s.server.request('item/tool/call', callParams('call_dup', 'assess_attempt', args), 'rpc-1');
    const second = await s.server.request('item/tool/call', callParams('call_dup', 'assess_attempt', args), 'rpc-2');
    assert.equal(s.calls.length, 1);
    assert.equal(second.id, 'rpc-2');
    assert.deepEqual(second.result, first.result);
    assert.equal(s.store.ofType('tool.started').length, 1);
    assert.equal(s.store.ofType('tool.completed').length, 1);
  });

  test('an unknown tool gets UNKNOWN_TOOL and the turn is interrupted (mocked Codex)', async () => {
    const s = setup();
    const turn = await startedTurn(s);
    const reply = await s.server.request('item/tool/call', callParams('call_x', 'exec_shell', { cmd: 'ls' }), 'rpc-9');
    assert.equal(reply.id, 'rpc-9');
    const result = reply.result as { success: boolean; contentItems: { text: string }[] };
    assert.equal(result.success, false);
    assert.equal(toolReplyText(result.contentItems[0]?.text ?? '').error?.code, 'UNKNOWN_TOOL');
    assert.equal(s.calls.length, 0);
    const done = await turn.done;
    assert.equal(done.status, 'interrupted');
    assert.equal(done.error?.code, 'UNKNOWN_TOOL');
    assert.deepEqual(s.server.last('turn/interrupt').params, { threadId: THREAD_ID, turnId: TURN_ID });
    const failed = s.store.ofType('tool.failed');
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.payload.error.code, 'UNKNOWN_TOOL');
    assert.equal(failed[0]?.payload.name, 'exec_shell');
  });

  test('approval requests get cancel and interrupt (mocked Codex)', async () => {
    const cases: { method: string; expectResult?: unknown; expectError?: number }[] = [
      { method: 'item/commandExecution/requestApproval', expectResult: { decision: 'cancel' } },
      { method: 'item/fileChange/requestApproval', expectResult: { decision: 'cancel' } },
      { method: 'item/permissions/requestApproval', expectResult: { permissions: {}, scope: 'turn' } },
      { method: 'mcpServer/elicitation/request', expectError: -32601 },
    ];
    for (const entry of cases) {
      const s = setup();
      const turn = await startedTurn(s);
      const reply = await s.server.request(entry.method, { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'item_x' }, 'rpc-approve');
      assert.equal(reply.id, 'rpc-approve');
      if (entry.expectResult) assert.deepEqual(reply.result, entry.expectResult, entry.method);
      if (entry.expectError) {
        assert.equal(reply.error?.code, entry.expectError, entry.method);
        assert.equal(reply.error?.message, 'Unsupported llime server request');
      }
      const done = await turn.done;
      assert.equal(done.status, 'interrupted', entry.method);
      assert.equal(done.error?.code, 'UNKNOWN_TOOL', entry.method);
      assert.equal(s.server.count('turn/interrupt'), 1, entry.method);
    }
  });
});

describe('events', () => {
  test('tool.completed is written only after the handler saved its result (mocked Codex)', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const s = setup({
      handlers: {
        get_personal_memory: async () => {
          await gate;
          return okResult('get_personal_memory');
        },
      },
    });
    await startedTurn(s);
    const reply = s.server.request('item/tool/call', callParams('call_m', 'get_personal_memory', { conceptIds: ['subtraction_within_20'], includeUnassessed: true }), 'rpc-m');
    s.server.notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1, item: dynamicToolItem('call_m', 'get_personal_memory', 'completed') });
    await until(() => s.store.ofType('tool.started').length === 1, 'tool.started');
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    // The runtime's own completion arrived first, but nothing is recorded as completed yet.
    assert.equal(s.store.ofType('tool.completed').length, 0);
    assert.deepEqual(s.store.ofType('runtime.item').filter((e) => e.payload.lifecycle === 'completed'), []);
    release();
    await reply;
    await until(() => s.store.ofType('runtime.item').some((e) => e.payload.lifecycle === 'completed'), 'item completed event');
    const types = s.store.types();
    assert.ok(types.indexOf('tool.started') < types.indexOf('tool.completed'));
    assert.ok(types.indexOf('tool.completed') < types.lastIndexOf('runtime.item'));
    const started = s.store.ofType('tool.started')[0]?.payload;
    assert.deepEqual({ threadId: started?.threadId, turnId: started?.turnId, callId: started?.callId, itemId: started?.itemId, serverRequestId: started?.serverRequestId, name: started?.name }, { threadId: THREAD_ID, turnId: TURN_ID, callId: 'call_m', itemId: 'call_m', serverRequestId: 'rpc-m', name: 'get_personal_memory' });
  });

  test('reasoning items and deltas never become events (mocked Codex)', async () => {
    const s = setup();
    await startedTurn(s);
    const secret = 'PRIVATE-CHAIN-OF-THOUGHT';
    s.server.notify('item/started', { threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1, item: { type: 'reasoning', id: 'r1', summary: [secret], content: [secret] } });
    s.server.notify('item/reasoning/textDelta', { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'r1', delta: secret, contentIndex: 0 });
    s.server.notify('item/reasoning/summaryTextDelta', { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'r1', delta: secret, summaryIndex: 0 });
    s.server.notify('item/reasoning/summaryPartAdded', { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'r1', summaryIndex: 1 });
    s.server.notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 2, item: { type: 'reasoning', id: 'r1', summary: [secret], content: [secret] } });
    s.server.notify('item/started', { threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 3, item: { type: 'agentMessage', id: 'm1', text: '', phase: null } });
    await until(() => s.store.ofType('runtime.item').length === 1, 'the agent message item');
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(s.store.ofType('runtime.item').map((e) => e.payload.type), ['agentMessage']);
    assert.ok(!JSON.stringify(s.store.events).includes(secret));
  });

  test('output over 16,000 characters is partial and fails (mocked Codex)', async () => {
    const s = setup();
    const turn = await startedTurn(s);
    s.server.notify('item/started', { threadId: THREAD_ID, turnId: TURN_ID, startedAtMs: 1, item: { type: 'agentMessage', id: 'm1', text: '', phase: null } });
    s.server.notify('item/agentMessage/delta', { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'm1', delta: 'a'.repeat(8_000) });
    s.server.notify('item/agentMessage/delta', { threadId: THREAD_ID, turnId: TURN_ID, itemId: 'm1', delta: 'b'.repeat(8_001) });
    const done = await turn.done;
    assert.equal(done.status, 'interrupted');
    assert.equal(done.error?.code, 'VALIDATION_FAILED');
    const messages = s.store.ofType('runtime.message');
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.payload.partial, true);
    assert.equal(messages[0]?.payload.text.length, 16_000);
    assert.equal(s.server.count('turn/interrupt'), 1);
    assert.equal(s.store.ofType('operation.failed')[0]?.payload.code, 'VALIDATION_FAILED');
  });

  test('output of exactly 16,000 characters completes normally (mocked Codex)', async () => {
    const s = setup();
    const turn = await startedTurn(s);
    const text = 'x'.repeat(16_000);
    s.server.notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 1, item: { type: 'agentMessage', id: 'm1', text, phase: null } });
    s.server.notify('item/completed', { threadId: THREAD_ID, turnId: TURN_ID, completedAtMs: 2, item: { type: 'agentMessage', id: 'm2', text: finalJson(), phase: 'final_answer' } });
    s.server.notify('turn/completed', { threadId: THREAD_ID, turn: turnFor(TURN_ID, 'completed') });
    const done = await turn.done;
    assert.equal(done.status, 'completed');
    assert.equal(done.final?.status, 'completed');
    assert.deepEqual(s.store.ofType('runtime.message').map((e) => e.payload.partial), [false, false]);
    assert.equal(s.server.count('turn/interrupt'), 0);
  });

  test('expanded instructions over 24 KiB are rejected before turn/start (mocked Codex)', async () => {
    const s = setup();
    await assert.rejects(
      s.runtime.startTurn(ingestion({ lessonInput: 'é'.repeat(13_000) })),
      (error: unknown) => error instanceof RuntimeFailure && error.body.code === 'PAYLOAD_TOO_LARGE',
    );
    assert.equal(s.server.count('turn/start'), 0);
    assert.equal(s.store.ofType('runtime.input').length, 0);
  });
});

describe('turns and model', () => {
  test('turn/steer carries expectedTurnId; a no-active-turn failure starts a new turn in the same thread and writes turn.steered only for a real steer (mocked Codex)', async () => {
    const turnIds = ['turn_1', 'turn_2', 'turn_3'];
    const s = setup({
      script: (request, server) => {
        if (request.method === 'turn/start') {
          const id = turnIds.shift() ?? 'turn_x';
          queueMicrotask(() => server.notify('turn/started', { threadId: THREAD_ID, turn: turnFor(id, 'inProgress') }));
          return { turn: turnFor(id, 'inProgress') };
        }
        if (request.method === 'turn/steer') return request.params.expectedTurnId === 'turn_1' && server.steerOk ? { turnId: 'turn_1' } : new Error('no active turn to steer');
        return defaultAnswers()(request, server);
      },
    });
    s.server.steerOk = true;
    const first = await s.runtime.startTurn(ingestion());
    await until(() => s.server.count('turn/start') === 1, 'first turn');
    const steered = await s.runtime.steer({ runId: RUN_ID, phase: 'explanation', input: { text: 'a correction' }, explanationRevision: 2 });
    assert.equal(steered.mode, 'steered');
    const steer = s.server.last('turn/steer').params as { threadId: string; expectedTurnId: string; input: unknown[] };
    assert.equal(steer.threadId, THREAD_ID);
    assert.equal(steer.expectedTurnId, 'turn_1');
    assert.equal(steer.input.length, 1);
    const events = s.store.ofType('turn.steered');
    assert.equal(events.length, 1);
    assert.equal(events[0]?.payload.expectedTurnId, 'turn_1');
    assert.equal(events[0]?.payload.explanationRevision, 2);
    assert.equal(s.server.count('turn/start'), 1);

    // The turn completes; a later steer has no active turn and starts a new one in the same thread.
    s.server.notify('turn/completed', { threadId: THREAD_ID, turn: turnFor('turn_1', 'completed') });
    await first.done;
    const fallback = await s.runtime.steer({ runId: RUN_ID, phase: 'explanation', input: { text: 'again' }, explanationRevision: 3 });
    assert.equal(fallback.mode, 'new_turn');
    assert.equal(s.server.count('turn/steer'), 1, 'no steer is sent without an active turn');
    assert.equal((s.server.last('turn/start').params as { threadId: string }).threadId, THREAD_ID);
    assert.equal(s.server.count('thread/start'), 1);
    assert.equal(s.store.ofType('turn.steered').length, 1);

    // The server says the turn is gone although the client thought it was active: new turn, no turn.steered.
    s.server.steerOk = false;
    const raced = await s.runtime.steer({ runId: RUN_ID, phase: 'explanation', input: { text: 'race' }, explanationRevision: 4 });
    assert.equal(raced.mode, 'new_turn');
    assert.equal(s.server.count('turn/steer'), 2);
    assert.equal(s.store.ofType('turn.steered').length, 1);
    assert.equal(s.server.count('thread/start'), 1);
  });

  test('at 90 s the turn is interrupted and committed effects stay (mocked Codex)', async () => {
    const s = setup();
    const turn = await startedTurn(s);
    await s.server.request('item/tool/call', callParams('call_c', 'assess_attempt', { attemptId: 'attempt_1', criterion: 'initial' }));
    const committedBefore = s.store.ofType('tool.completed').length;
    assert.equal(committedBefore, 1);
    s.clock.advance(89_999);
    assert.equal(s.server.count('turn/interrupt'), 0);
    s.clock.advance(1);
    const done = await turn.done;
    assert.equal(s.server.count('turn/interrupt'), 1);
    assert.equal(done.status, 'interrupted');
    assert.equal(done.error?.code, 'MODEL_TIMEOUT');
    assert.equal(s.store.ofType('tool.completed').length, committedBefore);
    assert.equal(s.store.ofType('runtime.completed').at(-1)?.payload.status, 'interrupted');
    assert.equal(s.store.ofType('operation.failed').at(-1)?.payload.code, 'MODEL_TIMEOUT');
  });

  test('model and service tier are frozen per run; an unavailable pair fails with no fallback (mocked Codex)', async () => {
    // The catalog does not list the tier: no thread, no fallback to another tier or model.
    const noTier = setup({ serviceTier: 'flex' });
    await assert.rejects(noTier.runtime.startTurn(ingestion()), (e: unknown) => e instanceof RuntimeFailure && e.body.code === 'RUNTIME_DISCONNECTED');
    assert.equal(noTier.server.count('thread/start'), 0);
    assert.equal(noTier.server.child.killed, true);

    const noModel = setup({ model: 'gpt-6.1-sol' });
    await assert.rejects(noModel.runtime.startTurn(ingestion()), (e: unknown) => e instanceof RuntimeFailure && e.body.code === 'RUNTIME_DISCONNECTED');
    assert.equal(noModel.server.count('thread/start'), 0);

    // The run already froze another model: refused before any child work.
    const frozen = setup({ store: new FakeRunStore(runState({ runtime: { model: 'gpt-6.1-sol', serviceTier: TIER_ID, threadId: null } })) });
    await assert.rejects(frozen.runtime.startTurn(ingestion()), (e: unknown) => e instanceof RuntimeFailure && /frozen/i.test(e.body.message));
    assert.equal(frozen.server.spawns.length, 0);

    // The thread comes back on a different model than requested: the run fails rather than continuing.
    const swapped = setup({ script: FakeAppServer.turnStartsWith(TURN_ID, defaultAnswers({ 'thread/start': { thread: { id: THREAD_ID, sessionId: 's', ephemeral: true }, model: 'gpt-6.1-sol', modelProvider: 'openai', serviceTier: TIER_ID, sandbox: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' } })) });
    await assert.rejects(swapped.runtime.startTurn(ingestion()), (e: unknown) => e instanceof RuntimeFailure && e.body.code === 'RUNTIME_DISCONNECTED');
    assert.equal(swapped.server.count('turn/start'), 0);

    // The accepted pair is recorded on the run exactly as passed.
    const ok = setup();
    await ok.runtime.startTurn(ingestion());
    assert.deepEqual(ok.store.state.runtime, { model: MODEL, serviceTier: TIER_ID, threadId: THREAD_ID });
  });

  test('a signed-out account fails with AUTH_REQUIRED before any thread (mocked Codex)', async () => {
    const s = setup({ script: FakeAppServer.turnStartsWith(TURN_ID, defaultAnswers({ 'account/read': { account: null, requiresOpenaiAuth: true, workspaceRouting: null } })) });
    await assert.rejects(s.runtime.startTurn(ingestion()), (e: unknown) => e instanceof RuntimeFailure && e.body.code === 'AUTH_REQUIRED');
    assert.equal(s.server.count('thread/start'), 0);
  });

  test('a tool call after the run was stopped is refused with CANCELLED and the handler never runs (mocked Codex)', async () => {
    const s = setup();
    await startedTurn(s);
    s.store.state = runState({ stopped: true, cancellationEpoch: 1 });
    const reply = await s.server.request('item/tool/call', callParams('call_s', 'assess_attempt', { attemptId: 'attempt_1', criterion: 'initial' }));
    const text = (reply.result as { contentItems: { text: string }[] }).contentItems[0]?.text ?? '';
    assert.equal(toolReplyText(text).error?.code, 'CANCELLED');
    assert.equal(s.calls.length, 0);
    assert.equal(s.store.ofType('tool.failed')[0]?.payload.error.code, 'CANCELLED');
  });

  test('a read tool that times out is retried once and recorded as attempt 2 (mocked Codex)', async () => {
    let attempts = 0;
    const s = setup({
      handlers: {
        get_personal_memory: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('transient read failure');
          return okResult('get_personal_memory');
        },
      },
    });
    await startedTurn(s);
    const reply = await s.server.request('item/tool/call', callParams('call_r', 'get_personal_memory', { conceptIds: ['subtraction_within_20'], includeUnassessed: true }));
    assert.equal((reply.result as { success: boolean }).success, true);
    assert.equal(attempts, 2);
    assert.deepEqual(s.store.ofType('tool.started').map((e) => e.payload.attempt), [1, 2]);
    assert.equal(s.store.ofType('tool.completed')[0]?.payload.attempt, 2);
  });

  test('stopping the server interrupts every active turn and keeps what was committed (mocked Codex)', async () => {
    const s = setup();
    const turn = await startedTurn(s);
    await s.server.request('item/tool/call', callParams('call_k', 'assess_attempt', { attemptId: 'attempt_1', criterion: 'initial' }));
    await createServerRuntimePort(s.runtime).interruptActiveTurns();
    const done = await turn.done;
    assert.equal(done.status, 'interrupted');
    assert.equal(done.error?.code, 'CANCELLED');
    assert.equal(s.store.ofType('tool.completed').length, 1);
  });

  test('closing a run ends stdin and escalates only if the child does not exit (mocked Codex)', async () => {
    const s = setup();
    await s.runtime.startTurn(ingestion());
    const closing = s.runtime.close(RUN_ID);
    s.server.child.exitCleanly();
    await closing;
    assert.deepEqual(s.server.child.signals, []);
    const stuck = setup();
    await stuck.runtime.startTurn(ingestion());
    const closingStuck = stuck.runtime.close(RUN_ID);
    await until(() => stuck.server.child.stdin.writableEnded, 'stdin closed');
    stuck.clock.advance(5_000);
    await closingStuck;
    assert.deepEqual(stuck.server.child.signals, ['SIGTERM']);
  });
});
