// Live check against the real Codex App Server, the real store and the real tool handlers. It calls
// the model, so it is never part of `npm test`; run it with
//   npx tsx --test tests/runtime/codex-smoke.test.ts
// It needs a signed-in Codex, the local database and the provider-capable computer's .env.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { CODEX_CLI_VERSION, createCodexRuntime, createIngestionStarter, type CallTool, type CodexRuntime, type OperationSettlement } from '../../src/codex.js';
import { loadConfig, repoRoot } from '../../src/config.js';
import { loadSeed, type LoadedSeed } from '../../src/dataset.js';
import type { ToolResult } from '../../src/domain.js';
import type { RunEvent } from '../../src/events.js';
import { FILM_SEED } from '../../src/problems.js';
import { createRunId, Store } from '../../src/store.js';
import { getPersonalMemory, publishActivity } from '../../src/tools.js';

const TASK_ID = 'r-task_275295a8be66';
const CAPTURES = join(repoRoot, '.runtime/captures');
const LESSON_DIR = join(repoRoot, 'data/lesson');
const TURN_WAIT_MS = 120_000;

let store: Store;
let seed: LoadedSeed;
let runtime: CodexRuntime;
const createdRuns: string[] = [];
const settlements: { runId: string; settlement: OperationSettlement }[] = [];

// The prepared lesson, accepted only when its bytes match the manifest.
function preparedLesson(): { text: string; sha256: string } {
  const manifest = JSON.parse(readFileSync(join(LESSON_DIR, 'manifest.json'), 'utf8')) as { file: string; sha256: string };
  const bytes = readFileSync(join(LESSON_DIR, manifest.file));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sha256, manifest.sha256, 'the prepared lesson does not match its manifest');
  return { text: bytes.toString('utf8'), sha256 };
}

// The handlers this check exercises are the real ones; a tool whose handler is not merged yet fails
// visibly instead of pretending to work.
const callTool: CallTool = async (context, name, args): Promise<ToolResult> => {
  switch (name) {
    case 'get_personal_memory':
      return getPersonalMemory(store, context, args);
    case 'publish_activity':
      return publishActivity(store, context, args);
    default:
      return { ok: false, tool: name, error: { code: 'VALIDATION_FAILED', message: `${name} is not available in this check`, retryable: false }, contextCommit: null };
  }
};

async function ingestingRun(lessonText: string, contentHash: string): Promise<string> {
  const runId = createRunId(TASK_ID);
  createdRuns.push(runId);
  await store.createRun({ runId, seed: FILM_SEED }, seed);
  await store.beginIngestion(runId, { expectedRevision: 0, lesson: { contentHash, text: lessonText, source: 'local_file', savedAt: new Date().toISOString() } });
  return runId;
}

async function untilSettled(runId: string): Promise<OperationSettlement> {
  const deadline = Date.now() + TURN_WAIT_MS;
  while (Date.now() < deadline) {
    const found = settlements.find((s) => s.runId === runId);
    if (found) return found.settlement;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The turn of ${runId} did not settle within ${TURN_WAIT_MS} ms`);
}

const toolEvents = (events: RunEvent[]) => events.filter((e) => e.type === 'tool.started' || e.type === 'tool.completed' || e.type === 'tool.failed');

describe('live Codex App Server (real handlers)', () => {
  before(async () => {
    const config = loadConfig();
    store = await Store.connect();
    seed = loadSeed();
    await store.seed(seed);
    runtime = createCodexRuntime({
      store,
      callTool,
      env: process.env,
      config: {
        command: join(repoRoot, 'node_modules/.bin/codex'),
        cwd: join(repoRoot, '.runtime/agent'),
        model: config.model,
        serviceTier: config.serviceTier,
        stderrLogPath: join(repoRoot, `.runtime/logs/${TASK_ID}-codex-smoke.stderr.log`),
      },
    });
  });

  after(async () => {
    await runtime.closeAll();
    for (const runId of createdRuns) {
      await store.resetRun(runId);
      assert.equal((await store.countNamespace(runId)).total, 0, `namespace ${runId} was not emptied`);
    }
    await store.close();
  });

  test('the pinned CLI is the one that runs', () => {
    const out = execFileSync(join(repoRoot, 'node_modules/.bin/codex'), ['--version'], { encoding: 'utf8' });
    assert.match(out, new RegExp(`codex-cli ${CODEX_CLI_VERSION.replaceAll('.', '\\.')}`));
  });

  test('a real lesson causes a get_personal_memory call and then an accepted publish_activity invitation', { timeout: TURN_WAIT_MS + 30_000 }, async () => {
    const lesson = preparedLesson();
    const runId = await ingestingRun(lesson.text, lesson.sha256);
    const startIngestionTurn = createIngestionStarter({
      runtime,
      store,
      settle: async (id, settlement) => void settlements.push({ runId: id, settlement }),
    });
    await startIngestionTurn(runId);
    const settlement = await untilSettled(runId);

    const events = await store.events(runId);
    const run = await store.getRun(runId);
    const tools = toolEvents(events);
    const completed = tools.filter((e) => e.type === 'tool.completed');
    const names = completed.map((e) => (e.type === 'tool.completed' ? e.payload.name : ''));
    assert.ok(names.includes('get_personal_memory'), `no memory call completed; saw ${names.join(', ') || 'none'}; settlement ${JSON.stringify(settlement)}`);
    assert.ok(names.includes('publish_activity'), `no invitation was accepted; saw ${names.join(', ')}; settlement ${JSON.stringify(settlement)}`);
    assert.ok(names.indexOf('get_personal_memory') < names.indexOf('publish_activity'));
    assert.equal(run.state.phase, 'INVITED');
    assert.equal(run.state.invitation?.kind, 'invitation');
    assert.equal(run.state.runtime?.model, loadConfig().model);
    const input = events.find((e) => e.type === 'runtime.input');
    const finished = events.find((e) => e.type === 'runtime.completed');
    assert.ok(input && finished, 'runtime.input and runtime.completed are saved');

    // One chain: every tool event of this turn carries the same thread and turn; calls differ.
    const turnIds = new Set(tools.map((e) => (e.type === 'tool.started' || e.type === 'tool.completed' || e.type === 'tool.failed' ? e.payload.turnId : '')));
    const threadIds = new Set(tools.map((e) => (e.type === 'tool.started' || e.type === 'tool.completed' || e.type === 'tool.failed' ? e.payload.threadId : '')));
    assert.equal(turnIds.size, 1);
    assert.equal(threadIds.size, 1);
    assert.equal(run.state.runtime?.threadId, [...threadIds][0]);

    // Sanitized trace: identifiers and verdicts only, no lesson text, no instructions.
    const trace = events.flatMap((e): Record<string, unknown>[] => {
      switch (e.type) {
        case 'lesson.detected':
          return [{ seq: e.seq, type: e.type, bytes: e.payload.bytes }];
        case 'runtime.boundary':
          return [{ seq: e.seq, type: e.type, enabledMcpTools: e.payload.enabledMcpTools, sandbox: e.payload.sandbox }];
        case 'runtime.input':
          return [{ seq: e.seq, type: e.type, model: e.payload.model, serviceTier: e.payload.serviceTier, phase: e.payload.phase, promptHash: e.payload.promptHash, templateHashes: (e.payload.input as { templateHashes: unknown }).templateHashes }];
        case 'tool.started':
          return [{ seq: e.seq, type: e.type, name: e.payload.name, threadId: e.payload.threadId, turnId: e.payload.turnId, callId: e.payload.callId, serverRequestId: e.payload.serverRequestId, attempt: e.payload.attempt }];
        case 'tool.completed':
          return [{ seq: e.seq, type: e.type, name: e.payload.name, callId: e.payload.callId, ok: e.payload.result.ok, elapsedMs: e.payload.elapsedMs }];
        case 'tool.failed':
          return [{ seq: e.seq, type: e.type, name: e.payload.name, callId: e.payload.callId, code: e.payload.error.code }];
        case 'memory.retrieved':
          return [{ seq: e.seq, type: e.type, caseIds: e.payload.caseIds.length }];
        case 'activity.published':
          return [{ seq: e.seq, type: e.type, activityId: e.payload.activity.id, kind: e.payload.activity.kind, revision: e.payload.activity.revision }];
        case 'runtime.completed':
          return [{ seq: e.seq, type: e.type, threadId: e.payload.threadId, turnId: e.payload.turnId, status: e.payload.status }];
        case 'state.committed':
          return [{ seq: e.seq, type: e.type, phase: e.payload.phase, revision: e.payload.revision }];
        default:
          return [{ seq: e.seq, type: e.type }];
      }
    });
    mkdirSync(CAPTURES, { recursive: true });
    writeFileSync(join(CAPTURES, `${TASK_ID}-live-trace.json`), `${JSON.stringify({ runId, trace }, null, 2)}\n`);
    console.log(JSON.stringify({ runId, settlement, trace }, null, 2));
  });

  test('a controlled interrupt ends the turn as interrupted and publishes nothing', { timeout: TURN_WAIT_MS }, async () => {
    const lesson = preparedLesson();
    const runId = await ingestingRun(lesson.text, lesson.sha256);
    const turnSettled = new Promise<OperationSettlement>((resolve) => {
      void createIngestionStarter({ runtime, store, settle: async (_id, settlement) => void resolve(settlement) })(runId);
    });
    // Interrupt as soon as the runtime accepted the turn, well before the model could answer.
    const deadline = Date.now() + 30_000;
    while (!(await store.events(runId)).some((e) => e.type === 'runtime.input') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    await runtime.interrupt(runId);
    const settlement = await turnSettled;
    const events = await store.events(runId);
    const completed = events.filter((e) => e.type === 'runtime.completed');
    assert.equal(completed.at(-1)?.type === 'runtime.completed' ? completed.at(-1)?.payload.status : null, 'interrupted');
    assert.equal(settlement.status, 'failed');
    assert.equal((await store.getRun(runId)).state.invitation, null);
    assert.ok(!events.some((e) => e.type === 'activity.published'));
  });
});
