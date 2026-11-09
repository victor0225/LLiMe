import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { loadSeed, type LoadedSeed } from '../src/dataset.js';
import type { ActivityContext, ActivitySpec, Attempt, Interpretation, MakeTenAttempt, Problem, RunPhase, SearchLearningCasesOutput, ToolResult } from '../src/domain.js';
import { CATALOG_VERSION, TEMPLATE_KIND } from '../src/domain.js';
import { createEngine, type Engine, RESTART_MESSAGE, type RuntimePort, type TurnRequest } from '../src/engine.js';
import type { RunEvent } from '../src/events.js';
import { contextCaseId, speechSourceId } from '../src/graph.js';
import { FILM_SEED } from '../src/problems.js';
import { createRunId, DomainError, type RunRecord, Store } from '../src/store.js';
import { callTool, getPersonalMemory, publishActivity, type ToolContext } from '../src/tools.js';

const TASK_ID = 'task_6890035ba1cd';
const lessonText = readFileSync(new URL('../data/lesson/lesson-transcript.txt', import.meta.url), 'utf8');
const lesson = { contentHash: createHash('sha256').update(lessonText).digest('hex'), text: lessonText, source: 'local_file' as const, savedAt: '2026-11-09T10:00:00.000Z' };
const FILM_EXPLANATION = 'I counted eight, nine, ten, eleven, twelve. That was five numbers.';
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

// ---------------------------------------------------------------------------------------------
// Harness: a stub runtime, a run that reached the invitation through the real handlers, and shorthands.

type RuntimeCall = { method: keyof RuntimePort; request?: TurnRequest; runId?: string };

function stubRuntime(onStart: (request: TurnRequest) => Promise<void> = async () => {}) {
  const calls: RuntimeCall[] = [];
  const runtime: RuntimePort = {
    startTurn: async (request) => {
      calls.push({ method: 'startTurn', request });
      await onStart(request);
    },
    steerTurn: async (request) => {
      calls.push({ method: 'steerTurn', request });
      return false;
    },
    interruptTurn: async (runId) => void calls.push({ method: 'interruptTurn', runId }),
    closeVoice: async (runId) => void calls.push({ method: 'closeVoice', runId }),
  };
  return { runtime, calls };
}

const contextOf = (run: RunRecord): ToolContext => ({ runId: run.id, studentId: run.state.studentId, corpusHash: run.state.corpusHash, phase: run.state.phase, revision: run.revision, cancellationEpoch: run.state.cancellationEpoch, threadId: 'thread-1', turnId: 'turn-1' });

// A run that saved the prepared lesson, read memory and published its invitation, as ingestion leaves it.
async function invitedRun(options: { seed?: number; corpus?: LoadedSeed; prefix?: string } = {}): Promise<string> {
  const runId = createRunId(options.prefix ?? TASK_ID);
  created.push(runId);
  await store.createRun({ runId, seed: options.seed ?? FILM_SEED }, options.corpus ?? seed);
  await store.beginIngestion(runId, { expectedRevision: 0, lesson });
  const context = contextOf(await store.getRun(runId));
  const memory = await getPersonalMemory(store, context, { conceptIds: ['addition_within_20', 'subtraction_within_20'], includeUnassessed: true });
  assert.ok(memory.ok && memory.tool === 'get_personal_memory');
  await store.appendEvents(runId, [{ type: 'tool.completed', payload: { threadId: 'thread-1', turnId: 'turn-1', callId: 'call-1', itemId: null, serverRequestId: null, attempt: 1, name: 'get_personal_memory', result: memory, elapsedMs: 1 } }]);
  const published = await publishActivity(store, contextOf(await store.getRun(runId)), {
    expectedRevision: 1,
    explanationRevision: null,
    kind: 'invitation',
    templateId: 'invitation_addition',
    strategy: null,
    problem: null,
    evidenceIds: memory.data.cases.slice(0, 2).map((c) => c.caseId),
    todayConceptId: 'addition_within_20',
    quotes: ['The start is a place. A jump is a move.'],
    decisionSummary: 'Earlier subtraction needed help; a short addition check will show whether addition does too.',
    activitySpec: null,
  });
  assert.ok(published.ok, JSON.stringify(published));
  return runId;
}

const problemsOf = async (runId: string) => {
  const pair = (await store.getRun(runId)).state.selectedProblems;
  assert.ok(pair);
  return pair;
};
const oneShort = ({ lhs, rhs }: Problem): Attempt => ({ start: lhs, moves: Array.from({ length: rhs - 1 }, (_, i) => lhs + i + 1), answer: lhs + rhs - 1, hints: 0 });
const correctLine = ({ lhs, rhs }: Problem): Attempt => ({ start: lhs, moves: Array.from({ length: rhs }, (_, i) => lhs + i + 1), answer: lhs + rhs, hints: 0 });
const makeTen = ({ lhs, rhs }: Problem, answer = lhs + rhs): MakeTenAttempt => ({ placements: Array.from({ length: rhs }, (_, i) => ({ objectId: `t${i}`, to: i < 10 - lhs ? ('ten_frame' as const) : ('remaining' as const) })), answer, hints: 0 });

async function send(engine: Engine, runId: string, body: Record<string, unknown>) {
  const run = await store.getRun(runId);
  return engine.command(runId, { commandId: randomUUID(), revision: run.revision, ...body });
}

const tool = async (runId: string, name: string, args: unknown, context?: ToolContext): Promise<ToolResult> => callTool({ store, outbox: null }, context ?? contextOf(await store.getRun(runId)), name, args);

const interpretation = (runId: string, revision: number, meaning: Interpretation['meaning'], quote: string): Interpretation => ({ meaning, proposedMeaning: null, sourceId: speechSourceId(contextCaseId(runId, revision)), quote, relation: 'SUPPORTS' });

async function search(runId: string, meanings: [Interpretation['meaning'], string][], needsClarification = false): Promise<SearchLearningCasesOutput> {
  const { state } = await store.getRun(runId);
  const result = await tool(runId, 'search_learning_cases', { explanationRevision: state.explanationRevision, interpretations: meanings.map(([m, q]) => interpretation(runId, state.explanationRevision, m, q)), needsClarification, retrievalContext: null });
  assert.ok(result.ok && result.tool === 'search_learning_cases', JSON.stringify(result));
  return result.data;
}

function specFor(context: ActivityContext, evidenceIds: string[]): ActivitySpec {
  const base: Omit<ActivitySpec, 'components'> = { catalogVersion: CATALOG_VERSION, activityId: context.activityId, revision: context.revision, phase: context.phase, problemRef: context.problemRef, evidenceIds };
  return context.workspace === 'MakeTenWorkspace'
    ? { ...base, components: [{ id: 'box', type: 'MakeTenWorkspace', props: { first: context.start, second: context.addend, appearance: 'apple', highlightEmptySlots: true, showEquation: true } }] }
    : { ...base, components: [{ id: 'line', type: 'NumberLine', props: { start: context.start, addend: context.addend } }, { id: 'marker', type: 'StartMarker', props: { targetId: 'line', value: context.start } }] };
}

// Publishes exactly what the search decided, as a compliant model would.
async function publishDecision(runId: string, found: SearchLearningCasesOutput): Promise<ToolResult> {
  const { decision } = found.search;
  const { state } = await store.getRun(runId);
  const context = found.publicationContext.activityContext;
  const evidenceIds = context ? context.evidenceIds.slice(0, 2) : [];
  return tool(runId, 'publish_activity', {
    expectedRevision: found.publicationContext.expectedRevision,
    explanationRevision: state.explanationRevision,
    kind: TEMPLATE_KIND[decision.templateId],
    templateId: decision.templateId,
    strategy: decision.strategy,
    problem: null,
    evidenceIds,
    todayConceptId: null,
    quotes: null,
    decisionSummary: decision.reason.slice(0, 300),
    activitySpec: context ? specFor(context, evidenceIds) : null,
  });
}

async function toExplain(engine: Engine, runId: string): Promise<void> {
  await send(engine, runId, { type: 'accept' });
  await send(engine, runId, { type: 'attempt', attempt: oneShort((await problemsOf(runId)).initial) });
}

// The film path up to the published make-ten support.
async function toPractice(engine: Engine, runId: string): Promise<void> {
  await toExplain(engine, runId);
  await send(engine, runId, { type: 'explain', text: FILM_EXPLANATION });
  const published = await publishDecision(runId, await search(runId, [['count_start', 'I counted eight']]));
  assert.ok(published.ok, JSON.stringify(published));
}

async function toVerify(engine: Engine, runId: string): Promise<void> {
  await toPractice(engine, runId);
  await send(engine, runId, { type: 'practice', attempt: makeTen((await problemsOf(runId)).initial) });
}

const eventsOf = (runId: string, after = 0) => store.events(runId, after);
const ofType = (events: RunEvent[], type: RunEvent['type']) => events.filter((e) => e.type === type);
const phaseOf = async (runId: string): Promise<RunPhase> => (await store.getRun(runId)).state.phase;

async function rejects(work: Promise<unknown>, code: string): Promise<DomainError> {
  try {
    await work;
  } catch (error) {
    assert.ok(error instanceof DomainError, String(error));
    assert.equal(error.code, code, error.message);
    return error;
  }
  assert.fail(`expected ${code}`);
}

// Sends a command and checks it changed nothing: same revision, same events.
async function rejectedWithoutEffect(engine: Engine, runId: string, body: Record<string, unknown>, code = 'WRONG_PHASE'): Promise<DomainError> {
  const before = await store.getRun(runId);
  const error = await rejects(send(engine, runId, body), code);
  const after = await store.getRun(runId);
  assert.deepEqual([after.revision, after.seq], [before.revision, before.seq], `${String(body.type)} in ${before.state.phase} must have no effect`);
  return error;
}

const COMMANDS = (problem: Problem): Record<string, Record<string, unknown>> => ({
  accept: { type: 'accept' },
  attempt: { type: 'attempt', attempt: oneShort(problem) },
  explain: { type: 'explain', text: FILM_EXPLANATION },
  practice: { type: 'practice', attempt: makeTen(problem) },
  verify: { type: 'verify', attempt: makeTen(problem) },
});

// ---------------------------------------------------------------------------------------------

describe('run engine (stub runtime)', () => {
  test('every allowed CONTRACTS §7 transition commits state, event and receipt once; every other phase/command pair is a 409 with no effect (stub runtime)', async () => {
    const { runtime } = stubRuntime();
    const engine = createEngine({ store, runtime });
    const runId = await invitedRun();
    const { initial, independent } = await problemsOf(runId);
    const commands = COMMANDS(initial);

    // Explain is also allowed in PROCESSING and PRACTICE (as a correction), so it is not rejected there.
    const allowedIn: Record<string, string[]> = { INVITED: ['accept'], INITIAL: ['attempt'], EXPLAIN: ['explain'], PROCESSING: ['explain'], PRACTICE: ['practice', 'explain'], VERIFY: ['verify'], COMPLETE: [] };
    const rejectOthers = async () => {
      const phase = await phaseOf(runId);
      for (const [name, body] of Object.entries(commands)) {
        if (!(allowedIn[phase] ?? []).includes(name)) await rejectedWithoutEffect(engine, runId, body);
      }
    };
    const commitsOnce = async (body: Record<string, unknown>, expected: RunPhase) => {
      const before = await store.getRun(runId);
      const input = { commandId: randomUUID(), revision: before.revision, ...body };
      const first = await engine.command(runId, input);
      assert.equal(first.run.state.phase, expected);
      assert.equal(first.run.revision, before.revision + 1);
      const written = await eventsOf(runId, before.seq);
      assert.equal(ofType(written, 'state.committed').length, 1);
      const replay = await engine.command(runId, input);
      assert.equal(replay.replayed, true);
      assert.deepEqual(replay.run, first.run);
      assert.equal((await store.getRun(runId)).seq, first.run.seq);
    };

    await rejectOthers();
    await commitsOnce(commands.accept ?? {}, 'INITIAL');
    await rejectOthers();
    await commitsOnce(commands.attempt ?? {}, 'EXPLAIN');
    await rejectOthers();
    await commitsOnce(commands.explain ?? {}, 'PROCESSING');
    await rejectOthers();
    assert.ok((await publishDecision(runId, await search(runId, [['count_start', 'I counted eight']]))).ok);
    assert.equal(await phaseOf(runId), 'PRACTICE');
    await rejectOthers();
    await commitsOnce(commands.practice ?? {}, 'VERIFY');
    await rejectOthers();
    await commitsOnce({ type: 'verify', attempt: makeTen(independent) }, 'VERIFY');
    // The verify command saved the attempt; the episode commit is what finishes the run.
    await rejectedWithoutEffect(engine, runId, { type: 'verify', attempt: makeTen(independent) }, 'CONFLICT');
  });

  test('unknown run is 404; stale revision is 409 with the current revision; same commandId and body returns the receipt; a different body is 409 (stub runtime)', async () => {
    const engine = createEngine({ store, runtime: stubRuntime().runtime });
    await rejects(engine.command(`${TASK_ID}-missing`, { commandId: randomUUID(), revision: 0, type: 'accept' }), 'NOT_FOUND');
    const runId = await invitedRun();
    const current = await store.getRun(runId);
    const stale = await rejects(engine.command(runId, { commandId: randomUUID(), revision: current.revision - 1, type: 'accept' }), 'STALE_REVISION');
    assert.equal(stale.revision, current.revision);
    const commandId = randomUUID();
    const first = await engine.command(runId, { commandId, revision: current.revision, type: 'accept' });
    const again = await engine.command(runId, { commandId, revision: current.revision, type: 'accept' });
    assert.deepEqual([again.replayed, again.run], [true, first.run]);
    const conflict = await rejects(engine.command(runId, { commandId, revision: current.revision, type: 'stop_learning' }), 'CONFLICT');
    assert.equal(conflict.revision, first.run.revision);
  });

  test('initial attempt routes to ALREADY_CORRECT, EXPLAIN or OUT_OF_SCOPE from the stored pair (two seeds) (stub runtime)', async () => {
    const engine = createEngine({ store, runtime: stubRuntime().runtime });
    for (const problemSeed of [FILM_SEED, 7]) {
      const routes: [(p: Problem) => Attempt, RunPhase][] = [
        [correctLine, 'ALREADY_CORRECT'],
        [oneShort, 'EXPLAIN'],
        [({ lhs }) => ({ start: lhs, moves: [lhs + 1, lhs + 2], answer: lhs + 2, hints: 0 }), 'OUT_OF_SCOPE'],
      ];
      for (const [attemptFor, expected] of routes) {
        const runId = await invitedRun({ seed: problemSeed });
        await send(engine, runId, { type: 'accept' });
        const { initial } = await problemsOf(runId);
        const { run } = await send(engine, runId, { type: 'attempt', attempt: attemptFor(initial) });
        assert.equal(run.state.phase, expected, `seed ${problemSeed}, ${initial.lhs} + ${initial.rhs}`);
        assert.equal(run.state.attempts.length, 1);
        assert.equal(run.state.attempts[0]?.assessment?.passed, expected === 'ALREADY_CORRECT');
        assert.equal(run.state.explanation, null);
      }
    }
  });

  test('an impossible trace is 422 (stub runtime)', async () => {
    const engine = createEngine({ store, runtime: stubRuntime().runtime });
    const runId = await invitedRun();
    await send(engine, runId, { type: 'accept' });
    const { initial } = await problemsOf(runId);
    await rejectedWithoutEffect(engine, runId, { type: 'attempt', attempt: { start: initial.lhs, moves: [initial.lhs + 3], answer: initial.lhs + 3, hints: 0 } }, 'VALIDATION_FAILED');
  });

  test('the explanation is saved before the runtime port is called, and the port is called only after commit (stub runtime)', async () => {
    const seen: { phase: RunPhase; text: string | undefined; operationStarted: boolean }[] = [];
    const { runtime, calls } = stubRuntime(async (request) => {
      const run = await store.getRun(request.runId);
      const events = await eventsOf(request.runId);
      seen.push({ phase: run.state.phase, text: run.state.explanation?.text, operationStarted: ofType(events, 'operation.started').some((e) => e.type === 'operation.started' && e.payload.operationId === request.operationId) });
    });
    const engine = createEngine({ store, runtime });
    const runId = await invitedRun();
    await toExplain(engine, runId);
    assert.equal(calls.length, 0);
    await send(engine, runId, { type: 'explain', text: FILM_EXPLANATION });
    assert.deepEqual(seen, [{ phase: 'PROCESSING', text: FILM_EXPLANATION, operationStarted: true }]);
    const request = calls[0]?.request;
    assert.ok(request?.phase === 'explanation');
    assert.equal(request.input.sourceId, speechSourceId(contextCaseId(runId, 1)));
    assert.deepEqual(request.input.attempt, oneShort((await problemsOf(runId)).initial));
  });

  test('a rejected command never reaches the runtime port (stub runtime)', async () => {
    const { runtime, calls } = stubRuntime();
    const engine = createEngine({ store, runtime });
    const runId = await invitedRun();
    await rejectedWithoutEffect(engine, runId, { type: 'explain', text: FILM_EXPLANATION });
    assert.equal(calls.length, 0);
  });

  test('the 4th unclear round ends in NEEDS_SUPPORT with no commit_episode (stub runtime)', async () => {
    const engine = createEngine({ store, runtime: stubRuntime().runtime });
    const runId = await invitedRun();
    await toExplain(engine, runId);
    for (let round = 1; round <= 3; round += 1) {
      await send(engine, runId, { type: 'explain', text: 'I just counted.' });
      const found = await search(runId, [['unknown', 'just counted']], true);
      assert.equal(found.search.decision.templateId, 'clarify_show_steps');
      assert.ok((await publishDecision(runId, found)).ok);
      const { state } = await store.getRun(runId);
      assert.deepEqual([state.phase, state.clarificationRounds], ['CLARIFY', round]);
    }
    await send(engine, runId, { type: 'explain', text: 'I just counted.' });
    const found = await search(runId, [['unknown', 'just counted']], true);
    assert.equal(found.publicationContext.activityContext, null);
    const { state } = await store.getRun(runId);
    assert.deepEqual([state.phase, state.continuationAllowed, state.clarificationRounds], ['NEEDS_SUPPORT', false, 3]);
    const late = await publishDecision(runId, found);
    assert.ok(!late.ok && late.error.code === 'WRONG_PHASE');
    assert.equal(ofType(await eventsOf(runId), 'outcome.committed').length, 0);
    assert.equal((await store.countNamespace(runId)).liveCases, 4);
    await rejectedWithoutEffect(engine, runId, { type: 'explain', text: 'I just counted.' });
  });

  test('a failed retry publishes clarify_first_number while limits allow, else NEEDS_SUPPORT (stub runtime)', async () => {
    const engine = createEngine({ store, runtime: stubRuntime().runtime });
    const runId = await invitedRun();
    const { initial } = await problemsOf(runId);
    await toExplain(engine, runId);
    await send(engine, runId, { type: 'explain', text: 'I missed one tap.' });
    const first = await search(runId, [['slip', 'missed one tap']]);
    assert.deepEqual([first.search.decision.strategy, first.search.decision.basis], ['retry', 'policy']);
    assert.ok((await publishDecision(runId, first)).ok);
    const failed = await send(engine, runId, { type: 'practice', attempt: oneShort(initial) });
    assert.deepEqual([failed.run.state.phase, failed.run.state.activity?.templateId, failed.run.state.clarificationRounds], ['CLARIFY', 'clarify_first_number', 1]);
    assert.equal(ofType(await eventsOf(runId), 'activity.published').at(-1)?.type, 'activity.published');

    await send(engine, runId, { type: 'explain', text: 'I missed one tap again.' });
    assert.ok((await publishDecision(runId, await search(runId, [['slip', 'missed one tap']]))).ok);
    assert.equal((await store.getRun(runId)).state.interventionCount, 2);
    const exhausted = await send(engine, runId, { type: 'practice', attempt: oneShort(initial) });
    assert.deepEqual([exhausted.run.state.phase, exhausted.run.state.continuationAllowed], ['NEEDS_SUPPORT', false]);
  });

  test('a failed support continues once; a second failure is terminal (stub runtime)', async () => {
    const engine = createEngine({ store, runtime: stubRuntime().runtime });
    // Only the learner's own history is pinned, so no other learner's evidence exists and count_start
    // takes its default, the number-line support whose failed trace can be explained again.
    const ownHistory: LoadedSeed = { ...seed, cases: seed.cases.filter((c) => c.studentId === 'student_7') };
    const runId = await invitedRun({ corpus: ownHistory });
    const { initial } = await problemsOf(runId);
    await toExplain(engine, runId);
    await send(engine, runId, { type: 'explain', text: FILM_EXPLANATION });
    const found = await search(runId, [['count_start', 'I counted eight']]);
    assert.deepEqual([found.search.decision.strategy, found.search.decision.basis], ['anchor_start', 'default']);
    assert.ok((await publishDecision(runId, found)).ok);
    const once = await send(engine, runId, { type: 'practice', attempt: oneShort(initial) });
    assert.deepEqual([once.run.state.phase, once.run.state.continuationAllowed], ['NEEDS_SUPPORT', true]);

    await send(engine, runId, { type: 'explain', text: 'I counted eight again.' });
    assert.ok((await publishDecision(runId, await search(runId, [['count_start', 'I counted eight']]))).ok);
    const twice = await send(engine, runId, { type: 'practice', attempt: oneShort(initial) });
    assert.deepEqual([twice.run.state.phase, twice.run.state.continuationAllowed, twice.run.state.interventionCount], ['NEEDS_SUPPORT', false, 2]);
    await rejectedWithoutEffect(engine, runId, { type: 'explain', text: 'I counted eight.' });
  });

  test('a practice pass with hints enters VERIFY with hints kept; the independent activity has no helpers (stub runtime)', async () => {
    const engine = createEngine({ store, runtime: stubRuntime().runtime });
    const runId = await invitedRun();
    await toPractice(engine, runId);
    const support = (await store.getRun(runId)).state.activity;
    assert.ok(support && support.helperCount === 2);
    const { run } = await send(engine, runId, { type: 'practice', attempt: { ...makeTen((await problemsOf(runId)).initial), hints: 1 } });
    assert.equal(run.state.phase, 'VERIFY');
    assert.deepEqual([run.state.attempts.at(-1)?.assessment?.passed, run.state.attempts.at(-1)?.assessment?.hints], [true, 3]);
    const independent = run.state.activity;
    assert.ok(independent);
    assert.deepEqual([independent.kind, independent.templateId, independent.helperCount], ['independent', 'independent_make_ten', 0]);
    assert.deepEqual(independent.problem, (await problemsOf(runId)).independent);
    assert.deepEqual(independent.activitySpec?.components.map((c) => c.props), [{ first: 9, second: 4, appearance: 'apple', highlightEmptySlots: false, showEquation: false }]);
  });

  test('a correction in PROCESSING or PRACTICE before submit bumps explanationRevision, cancellationEpoch and revision, emits operation.cancelled and state.committed and clears the activity; after submit, in VERIFY, terminal or stopped it is a 409 (stub runtime)', async () => {
    const { runtime, calls } = stubRuntime();
    const engine = createEngine({ store, runtime });
    const correctIn = async (runId: string) => {
      const before = await store.getRun(runId);
      const { run } = await send(engine, runId, { type: 'explain', text: 'Wait, I counted eight first.' });
      assert.deepEqual(
        [run.state.phase, run.state.explanationRevision, run.state.cancellationEpoch, run.revision, run.state.activity],
        ['PROCESSING', before.state.explanationRevision + 1, before.state.cancellationEpoch + 1, before.revision + 1, null],
      );
      const types = (await eventsOf(runId, before.seq)).map((e) => e.type);
      assert.deepEqual(types, ['operation.cancelled', 'operation.started', 'state.committed']);
      assert.deepEqual(calls.slice(-2).map((c) => c.method), ['steerTurn', 'startTurn']);
    };
    const processing = await invitedRun();
    await toExplain(engine, processing);
    await send(engine, processing, { type: 'explain', text: FILM_EXPLANATION });
    await correctIn(processing);

    const practice = await invitedRun();
    await toPractice(engine, practice);
    await correctIn(practice);

    const verify = await invitedRun();
    await toVerify(engine, verify);
    await rejectedWithoutEffect(engine, verify, { type: 'explain', text: 'Wait.' });

    const terminal = await invitedRun();
    await send(engine, terminal, { type: 'accept' });
    await send(engine, terminal, { type: 'attempt', attempt: correctLine((await problemsOf(terminal)).initial) });
    await rejectedWithoutEffect(engine, terminal, { type: 'explain', text: 'Wait.' });

    const stopped = await invitedRun();
    await toPractice(engine, stopped);
    await send(engine, stopped, { type: 'stop_learning' });
    await rejectedWithoutEffect(engine, stopped, { type: 'explain', text: 'Wait.' });
  });

  test('a late submit for a superseded activity is a 409; a model result with an old epoch commits nothing (stub runtime)', async () => {
    const engine = createEngine({ store, runtime: stubRuntime().runtime });
    const runId = await invitedRun();
    await toPractice(engine, runId);
    const superseded = await store.getRun(runId);
    await send(engine, runId, { type: 'explain', text: 'Wait, I counted eight first.' });
    const late = await rejects(engine.command(runId, { commandId: randomUUID(), revision: superseded.revision, type: 'practice', attempt: makeTen((await problemsOf(runId)).initial) }), 'STALE_REVISION');
    assert.equal(late.revision, superseded.revision + 1);

    const current = await store.getRun(runId);
    const oldEpoch = { ...contextOf(current), cancellationEpoch: superseded.state.cancellationEpoch };
    const result = await tool(runId, 'search_learning_cases', { explanationRevision: current.state.explanationRevision, interpretations: [interpretation(runId, current.state.explanationRevision, 'count_start', 'counted eight')], needsClarification: false, retrievalContext: null }, oldEpoch);
    assert.ok(!result.ok && result.error.code === 'CANCELLED' && /Stale model result/.test(result.error.message));
    const after = await store.getRun(runId);
    assert.deepEqual([after.revision, after.seq], [current.revision, current.seq]);
  });

  test('stop_learning sets stopped, bumps epoch and revision, keeps the phase; the same command returns its receipt with no second bump; later learning commands are rejected (stub runtime)', async () => {
    const { runtime, calls } = stubRuntime();
    const engine = createEngine({ store, runtime });
    const runId = await invitedRun();
    await toExplain(engine, runId);
    await send(engine, runId, { type: 'explain', text: FILM_EXPLANATION });
    const before = await store.getRun(runId);
    const stop = { commandId: randomUUID(), revision: before.revision, type: 'stop_learning' };
    const { run } = await engine.command(runId, stop);
    assert.deepEqual([run.state.stopped, run.state.phase, run.state.cancellationEpoch, run.revision], [true, 'PROCESSING', before.state.cancellationEpoch + 1, before.revision + 1]);
    assert.deepEqual((await eventsOf(runId, before.seq)).map((e) => e.type), ['operation.cancelled', 'state.committed']);
    assert.deepEqual(calls.slice(-2).map((c) => c.method), ['interruptTurn', 'closeVoice']);
    const replay = await engine.command(runId, stop);
    assert.deepEqual([replay.replayed, replay.run.revision, replay.run.state.cancellationEpoch], [true, run.revision, run.state.cancellationEpoch]);
    assert.equal((await store.getRun(runId)).seq, run.seq);
    await rejectedWithoutEffect(engine, runId, { type: 'explain', text: 'More.' });
    await rejectedWithoutEffect(engine, runId, { type: 'stop_learning' });
    // A tool result that arrives after the stop is a stale model result and commits nothing.
    const late = await tool(runId, 'search_learning_cases', { explanationRevision: run.state.explanationRevision, interpretations: [interpretation(runId, run.state.explanationRevision, 'count_start', 'I counted eight')], needsClarification: false, retrievalContext: null }, { ...contextOf(run), cancellationEpoch: before.state.cancellationEpoch });
    assert.ok(!late.ok && late.error.code === 'CANCELLED');
    assert.equal((await store.getRun(runId)).seq, run.seq);
  });

  test('activity_rendered with matching IDs and hash commits once; a mismatch is a 409; a repeat writes no second receipt (stub runtime)', async () => {
    const engine = createEngine({ store, runtime: stubRuntime().runtime });
    const runId = await invitedRun();
    await toPractice(engine, runId);
    const before = await store.getRun(runId);
    const activity = before.state.activity;
    assert.ok(activity?.specHash);
    const receipt = (commandId: string, revision: number, specHash: string | null) => ({ type: 'activity_rendered', commandId, voiceSessionId: null, expectedRunRevision: revision, activityId: activity.id, activityRevision: activity.revision, specHash });

    await rejects(engine.activityRendered(runId, receipt(randomUUID(), before.revision, 'not-the-hash')), 'CONFLICT');
    const first = receipt(randomUUID(), before.revision, activity.specHash);
    const committed = await engine.activityRendered(runId, first);
    assert.deepEqual([committed.replayed, committed.run.revision, committed.run.state.phase], [false, before.revision + 1, 'PRACTICE']);
    assert.deepEqual((await eventsOf(runId, before.seq)).map((e) => e.type), ['state.committed']);
    const commands = (await store.countNamespace(runId)).commands;

    const again = await engine.activityRendered(runId, receipt(randomUUID(), committed.run.revision, activity.specHash));
    const replay = await engine.activityRendered(runId, first);
    assert.deepEqual([again.replayed, replay.replayed], [true, true]);
    const after = await store.getRun(runId);
    assert.deepEqual([after.revision, after.seq, (await store.countNamespace(runId)).commands], [committed.run.revision, committed.run.seq, commands]);
  });

  test('recoverInterrupted moves INGESTING, PROCESSING and a submitted VERIFY without their required effect to ERROR with the restart copy, keeps untouched VERIFY and stopped runs, and a second run changes nothing (stub runtime)', async () => {
    const { runtime, calls } = stubRuntime();
    const engine = createEngine({ store, runtime });
    const prefix = `${TASK_ID}-recovery-${randomUUID().slice(0, 8)}`;

    const ingesting = createRunId(prefix);
    created.push(ingesting);
    await store.createRun({ runId: ingesting, seed: FILM_SEED }, seed);
    await store.beginIngestion(ingesting, { expectedRevision: 0, lesson });
    const processing = await invitedRun({ prefix });
    await toExplain(engine, processing);
    await send(engine, processing, { type: 'explain', text: FILM_EXPLANATION });
    const untouched = await invitedRun({ prefix });
    await toVerify(engine, untouched);
    const submitted = await invitedRun({ prefix });
    await toVerify(engine, submitted);
    await send(engine, submitted, { type: 'verify', attempt: makeTen((await problemsOf(submitted)).independent) });
    const stopped = await invitedRun({ prefix });
    await toExplain(engine, stopped);
    await send(engine, stopped, { type: 'explain', text: FILM_EXPLANATION });
    await send(engine, stopped, { type: 'stop_learning' });

    const first = await engine.recoverInterrupted({ runIdPrefix: prefix });
    assert.deepEqual(new Set(first.interrupted), new Set([ingesting, processing, submitted]));
    assert.deepEqual(first.cleaned, [stopped]);
    for (const runId of [ingesting, processing, submitted]) {
      const { state } = await store.getRun(runId);
      assert.deepEqual([state.phase, state.error?.message], ['ERROR', RESTART_MESSAGE]);
    }
    assert.equal(await phaseOf(untouched), 'VERIFY');
    const stoppedRun = await store.getRun(stopped);
    assert.deepEqual([stoppedRun.state.phase, stoppedRun.state.stopped], ['PROCESSING', true]);
    assert.ok(calls.some((c) => c.method === 'interruptTurn' && c.runId === stopped));

    const snapshot = async () => Promise.all([ingesting, processing, untouched, submitted, stopped].map(async (id) => (await store.getRun(id)).seq));
    const before = await snapshot();
    const second = await engine.recoverInterrupted({ runIdPrefix: prefix });
    assert.deepEqual(second.interrupted, []);
    assert.deepEqual(await snapshot(), before);
  });
});
