import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { loadSeed, type LoadedSeed } from '../src/dataset.js';
import { type ActivityContext, type ActivitySpec, type Attempt, CATALOG_VERSION, type Interpretation, type MakeTenAttempt, type Problem, type SearchLearningCasesOutput, TEMPLATE_KIND, type ToolResult } from '../src/domain.js';
import { createEngine, type Engine, type RuntimePort } from '../src/engine.js';
import type { RunEvent } from '../src/events.js';
import { contextCaseId, speechSourceId } from '../src/graph.js';
import { FILM_SEED } from '../src/problems.js';
import { SEARCH_COMPLETED_MAX_BYTES } from '../src/search.js';
import { createRunId, DomainError, type RunRecord, Store } from '../src/store.js';
import { callTool, getPersonalMemory, publishActivity, type ToolContext } from '../src/tools.js';

const TASK_ID = 'task_6890035ba1cd';
const lessonText = readFileSync(new URL('../data/lesson/lesson-transcript.txt', import.meta.url), 'utf8');
const lesson = { contentHash: createHash('sha256').update(lessonText).digest('hex'), text: lessonText, source: 'local_file' as const, savedAt: '2026-11-09T10:00:00.000Z' };
const FILM_EXPLANATION = 'I counted eight, nine, ten, eleven, twelve. That was five numbers.';
const created: string[] = [];
let store: Store;
let seed: LoadedSeed;
let engine: Engine;

const idleRuntime: RuntimePort = { startTurn: async () => {}, steerTurn: async () => false, interruptTurn: async () => {}, closeVoice: async () => {} };

before(async () => {
  store = await Store.connect();
  seed = loadSeed();
  await store.seed(seed);
  engine = createEngine({ store, runtime: idleRuntime });
});

after(async () => {
  for (const runId of created) {
    await store.resetRun(runId);
    assert.equal((await store.countNamespace(runId)).total, 0);
  }
  await store.close();
});

// ---------------------------------------------------------------------------------------------
// Harness

const contextOf = (run: RunRecord): ToolContext => ({ runId: run.id, studentId: run.state.studentId, corpusHash: run.state.corpusHash, phase: run.state.phase, revision: run.revision, cancellationEpoch: run.state.cancellationEpoch, threadId: 'thread-1', turnId: 'turn-1' });

async function invitedRun(): Promise<string> {
  const runId = createRunId(TASK_ID);
  created.push(runId);
  await store.createRun({ runId, seed: FILM_SEED }, seed);
  await store.beginIngestion(runId, { expectedRevision: 0, lesson });
  const memory = await getPersonalMemory(store, contextOf(await store.getRun(runId)), { conceptIds: ['addition_within_20', 'subtraction_within_20'], includeUnassessed: true });
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
const makeTen = ({ lhs, rhs }: Problem, answer = lhs + rhs): MakeTenAttempt => ({ placements: Array.from({ length: rhs }, (_, i) => ({ objectId: `t${i}`, to: i < 10 - lhs ? ('ten_frame' as const) : ('remaining' as const) })), answer, hints: 0 });

async function send(runId: string, body: Record<string, unknown>) {
  const run = await store.getRun(runId);
  return engine.command(runId, { commandId: randomUUID(), revision: run.revision, ...body });
}

const tool = async (runId: string, name: string, args: unknown, client: Store = store): Promise<ToolResult> => callTool({ store: client, outbox: null }, contextOf(await store.getRun(runId)), name, args);

const interpretation = (runId: string, revision: number, meaning: Interpretation['meaning'], quote: string, extra: Partial<Interpretation> = {}): Interpretation => ({ meaning, proposedMeaning: null, sourceId: speechSourceId(contextCaseId(runId, revision)), quote, relation: 'SUPPORTS', ...extra });

async function searchArgs(runId: string, items: Interpretation[] | ((revision: number) => Interpretation[]), needsClarification = false) {
  const { state } = await store.getRun(runId);
  return { explanationRevision: state.explanationRevision, interpretations: typeof items === 'function' ? items(state.explanationRevision) : items, needsClarification, retrievalContext: null };
}

async function search(runId: string, meanings: [Interpretation['meaning'], string][], needsClarification = false): Promise<SearchLearningCasesOutput> {
  const result = await tool(runId, 'search_learning_cases', await searchArgs(runId, (revision) => meanings.map(([m, q]) => interpretation(runId, revision, m, q)), needsClarification));
  assert.ok(result.ok && result.tool === 'search_learning_cases', JSON.stringify(result));
  return result.data;
}

function specFor(context: ActivityContext, evidenceIds: string[]): ActivitySpec {
  const base: Omit<ActivitySpec, 'components'> = { catalogVersion: CATALOG_VERSION, activityId: context.activityId, revision: context.revision, phase: context.phase, problemRef: context.problemRef, evidenceIds };
  return context.workspace === 'MakeTenWorkspace'
    ? { ...base, components: [{ id: 'box', type: 'MakeTenWorkspace', props: { first: context.start, second: context.addend, appearance: 'apple', highlightEmptySlots: true, showEquation: true } }] }
    : { ...base, components: [{ id: 'line', type: 'NumberLine', props: { start: context.start, addend: context.addend } }] };
}

async function publishArgs(runId: string, found: SearchLearningCasesOutput, overrides: Record<string, unknown> = {}) {
  const { decision } = found.search;
  const { state } = await store.getRun(runId);
  const context = found.publicationContext.activityContext;
  const evidenceIds = context ? context.evidenceIds.slice(0, 2) : [];
  return {
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
    ...overrides,
  };
}

async function toProcessing(runId: string, text = FILM_EXPLANATION): Promise<void> {
  await send(runId, { type: 'accept' });
  await send(runId, { type: 'attempt', attempt: oneShort((await problemsOf(runId)).initial) });
  await send(runId, { type: 'explain', text });
}

async function toVerify(runId: string): Promise<SearchLearningCasesOutput> {
  await toProcessing(runId);
  const found = await search(runId, [['count_start', 'I counted eight']]);
  const published = await tool(runId, 'publish_activity', await publishArgs(runId, found));
  assert.ok(published.ok, JSON.stringify(published));
  await send(runId, { type: 'practice', attempt: makeTen((await problemsOf(runId)).initial) });
  return found;
}

const eventsOf = (runId: string, after = 0) => store.events(runId, after);
const typesOf = (events: RunEvent[]) => events.map((e) => e.type);

function failedWith(result: ToolResult, code: string, pattern?: RegExp): void {
  assert.ok(!result.ok, `expected ${code}, got ${JSON.stringify(result).slice(0, 200)}`);
  assert.equal(result.error.code, code, result.error.message);
  if (pattern) assert.match(result.error.message, pattern);
}

// Nothing was written: same revision and seq, and no live case for the run.
async function assertUnchanged(runId: string, before: RunRecord): Promise<void> {
  const after = await store.getRun(runId);
  assert.deepEqual([after.revision, after.seq], [before.revision, before.seq]);
  assert.equal((await store.countNamespace(runId)).liveCases, 0);
}

// The store with one method replaced, for injecting a failure into a handler.
function storeWith(overrides: Partial<Pick<Store, 'getPinnedCases'>>): Store {
  return Object.assign(Object.create(store) as Store, overrides);
}

// ---------------------------------------------------------------------------------------------

describe('search_learning_cases', () => {
  test('an invalid proposal (unknown meaning, a novel rule, a non-verbatim quote, a wrong sourceId, a conflict without needsClarification) is VALIDATION_FAILED and writes nothing', async () => {
    const runId = await invitedRun();
    await toProcessing(runId);
    const before = await store.getRun(runId);
    const rev = before.state.explanationRevision;
    const invalid: [string, Interpretation[] | unknown[]][] = [
      ['unknown meaning', [{ ...interpretation(runId, rev, 'count_start', 'I counted eight'), meaning: 'confused' }]],
      ['novel without a name', [interpretation(runId, rev, 'novel', 'I counted eight')]],
      ['two novel patterns', [interpretation(runId, rev, 'novel', 'I counted eight', { proposedMeaning: 'counts_start_twice' }), interpretation(runId, rev, 'novel', 'five numbers', { proposedMeaning: 'counts_numbers_said' })]],
      ['a novel contradiction', [interpretation(runId, rev, 'novel', 'I counted eight', { proposedMeaning: 'counts_start_twice', relation: 'CONTRADICTS' })]],
      ['a non-verbatim quote', [interpretation(runId, rev, 'count_start', 'I counted nine')]],
      ['a wrong sourceId', [interpretation(runId, rev, 'count_start', 'I counted eight', { sourceId: `${contextCaseId(runId, rev)}:actions` })]],
      ['a conflict without needsClarification', [interpretation(runId, rev, 'count_start', 'I counted eight'), interpretation(runId, rev, 'slip', 'five numbers')]],
    ];
    for (const [label, interpretations] of invalid) {
      const result = await tool(runId, 'search_learning_cases', { explanationRevision: rev, interpretations, needsClarification: false, retrievalContext: null });
      assert.ok(!result.ok, label);
      assert.equal(result.error.code, 'VALIDATION_FAILED', `${label}: ${result.error.message}`);
      assert.equal(result.contextCommit, null, label);
    }
    await assertUnchanged(runId, before);
  });

  test('context commit, then search; the same key and body replays the commit and reruns only the search; a different body conflicts', async () => {
    const runId = await invitedRun();
    await toProcessing(runId);
    const before = await store.getRun(runId);
    const args = await searchArgs(runId, (rev) => [interpretation(runId, rev, 'count_start', 'I counted eight')]);
    const first = await tool(runId, 'search_learning_cases', args);
    assert.ok(first.ok && first.tool === 'search_learning_cases');
    assert.deepEqual([first.data.contextCommit.caseId, first.data.contextCommit.replayed], [contextCaseId(runId, 1), false]);
    const written = await eventsOf(runId, before.seq);
    assert.deepEqual(typesOf(written), ['context.committed', 'state.committed', 'search.started', 'search.completed', 'state.committed']);
    assert.equal(written[0]?.seq, first.data.contextCommit.eventSeq);
    assert.deepEqual([first.data.search.decision.strategy, first.data.search.decision.basis], ['make_ten', 'evidence']);
    assert.equal(first.data.publicationContext.expectedRevision, before.revision + 2);
    assert.deepEqual(first.data.publicationContext.activityContext && { ...first.data.publicationContext.activityContext, evidenceIds: first.data.publicationContext.activityContext.evidenceIds.length }, {
      activityId: `${runId}_support_1`,
      revision: before.revision + 3,
      phase: 'support',
      workspace: 'MakeTenWorkspace',
      problemRef: 'addition_8_5',
      start: 8,
      addend: 5,
      evidenceIds: 29,
    });

    const replay = await tool(runId, 'search_learning_cases', args);
    assert.ok(replay.ok && replay.tool === 'search_learning_cases');
    assert.equal(replay.data.contextCommit.replayed, true);
    assert.deepEqual(replay.data.search, first.data.search);
    assert.equal((await store.getRun(runId)).seq, written.at(-1)?.seq);

    const different = await tool(runId, 'search_learning_cases', { ...args, needsClarification: true });
    failedWith(different, 'CONFLICT');
  });

  test('a search failure keeps the context commit, writes no search.completed and returns ok:false with the receipt; a retry reruns only the search', async () => {
    const runId = await invitedRun();
    await toProcessing(runId);
    const before = await store.getRun(runId);
    const args = await searchArgs(runId, (rev) => [interpretation(runId, rev, 'count_start', 'I counted eight')]);
    let reads = 0;
    const broken = storeWith({ getPinnedCases: async () => { reads += 1; throw new DomainError('TOOL_TIMEOUT', 'The database did not answer in time', { retryable: true }); } });
    const failed = await tool(runId, 'search_learning_cases', args, broken);
    failedWith(failed, 'SEARCH_FAILED');
    assert.ok(!failed.ok && failed.contextCommit?.caseId === contextCaseId(runId, 1));
    assert.equal(reads, 2, 'one safe retry on a transient failure');
    assert.deepEqual(typesOf(await eventsOf(runId, before.seq)), ['context.committed', 'state.committed']);
    assert.equal((await store.getRun(runId)).state.search, null);

    const retried = await tool(runId, 'search_learning_cases', args);
    assert.ok(retried.ok && retried.tool === 'search_learning_cases');
    assert.equal(retried.data.contextCommit.replayed, true);
    assert.deepEqual(typesOf(await eventsOf(runId, before.seq)), ['context.committed', 'state.committed', 'search.started', 'search.completed', 'state.committed']);
  });

  test('search.completed stays under 64 KiB', async () => {
    const runId = await invitedRun();
    await toProcessing(runId);
    await search(runId, [['count_start', 'I counted eight']]);
    const completed = (await eventsOf(runId)).find((e) => e.type === 'search.completed');
    assert.ok(completed?.type === 'search.completed');
    assert.equal(completed.payload.candidateCount, 659);
    assert.ok(completed.payload.candidates.length <= 20);
    const bytes = new TextEncoder().encode(JSON.stringify(completed.payload)).length;
    assert.ok(bytes < SEARCH_COMPLETED_MAX_BYTES, `${bytes} bytes`);
  });

  test('a committed live case never enters a new run\'s pinned corpus', async () => {
    const runId = await invitedRun();
    await toProcessing(runId);
    await search(runId, [['count_start', 'I counted eight']]);
    assert.equal((await store.countNamespace(runId)).liveCases, 1);
    const next = createRunId(TASK_ID);
    created.push(next);
    await store.createRun({ runId: next, seed: FILM_SEED }, seed);
    const pinned = await store.getPinnedCorpus(next);
    assert.ok(!pinned.caseIds.includes(contextCaseId(runId, 1)));
    const cases = await store.getPinnedCases(next);
    assert.equal(cases.length, 781);
    assert.ok(cases.every((c) => c.provenance === 'synthetic'));
  });
});

describe('publish_activity (support, retry, clarification)', () => {
  test('publish with another kind or templateId, reverse_direction or repeat_count, evidence outside the decision, or a stale expectedRevision after a correction is VALIDATION_FAILED; an invalid spec returns the validator message; none of them writes anything', async () => {
    const runId = await invitedRun();
    await toProcessing(runId);
    const found = await search(runId, [['count_start', 'I counted eight']]);
    const before = await store.getRun(runId);
    const support = await publishArgs(runId, found);
    const rejected: [string, Record<string, unknown>, RegExp][] = [
      ['another kind', { ...support, kind: 'retry', templateId: 'manipulation_retry', strategy: 'retry', activitySpec: null, evidenceIds: [] }, /Publish exactly the decision/],
      ['another templateId', { ...support, templateId: 'anchor_start_number_line', strategy: 'anchor_start' }, /Publish exactly the decision/],
      ['reverse_direction', { ...support, strategy: 'reverse_direction' }, /no activity template/],
      ['repeat_count', { ...support, strategy: 'repeat_count' }, /no activity template/],
      ['evidence outside the decision', { ...support, evidenceIds: ['seed_7_0'], activitySpec: { ...support.activitySpec, evidenceIds: ['seed_7_0'] } }, /decision evidence/],
      ['a spec with another problem', { ...support, activitySpec: { ...support.activitySpec, components: [{ id: 'box', type: 'MakeTenWorkspace', props: { first: 9, second: 4, appearance: 'apple', highlightEmptySlots: false, showEquation: false } }] } }, /Problem mismatch/],
      ['a spec with the wrong workspace', { ...support, activitySpec: { ...support.activitySpec, components: [{ id: 'line', type: 'NumberLine', props: { start: 8, addend: 5 } }] } }, /Workspace does not match strategy/],
    ];
    for (const [label, args, pattern] of rejected) {
      const result = await tool(runId, 'publish_activity', args);
      assert.ok(!result.ok, label);
      assert.equal(result.error.code, 'VALIDATION_FAILED', `${label}: ${result.error.message}`);
      assert.match(result.error.message, pattern, label);
    }
    const after = await store.getRun(runId);
    assert.deepEqual([after.revision, after.seq, (await store.countNamespace(runId)).activities], [before.revision, before.seq, 2]);

    // A correction supersedes the search; its expected revision is stale.
    await send(runId, { type: 'explain', text: 'Wait, I counted eight first.' });
    failedWith(await tool(runId, 'publish_activity', support), 'VALIDATION_FAILED', /expectedRevision is stale/);
  });

  test('a retry with a spec is VALIDATION_FAILED, and support while a novel pattern is active is VALIDATION_FAILED', async () => {
    const slipRun = await invitedRun();
    await toProcessing(slipRun, 'I missed one tap.');
    const retry = await search(slipRun, [['slip', 'missed one tap']]);
    const anySpec = { catalogVersion: CATALOG_VERSION, activityId: `${slipRun}_retry_1`, revision: 1, phase: 'support', problemRef: 'addition_8_5', evidenceIds: [], components: [{ id: 'line', type: 'NumberLine', props: { start: 8, addend: 5 } }] };
    failedWith(await tool(slipRun, 'publish_activity', await publishArgs(slipRun, retry, { activitySpec: anySpec })), 'VALIDATION_FAILED', /built by the application/);

    const novelRun = await invitedRun();
    await toProcessing(novelRun, 'I count my fingers twice.');
    const novel = await tool(novelRun, 'search_learning_cases', await searchArgs(novelRun, (rev) => [interpretation(novelRun, rev, 'novel', 'count my fingers twice', { proposedMeaning: 'counts_fingers_twice' })]));
    assert.ok(novel.ok && novel.tool === 'search_learning_cases');
    assert.equal(novel.data.search.decision.templateId, 'clarify_show_steps');
    const context = { activityId: `${novelRun}_support_1`, revision: novel.data.publicationContext.expectedRevision + 1, phase: 'support' as const, workspace: 'MakeTenWorkspace' as const, problemRef: 'addition_8_5', start: 8, addend: 5, evidenceIds: [] };
    failedWith(await tool(novelRun, 'publish_activity', await publishArgs(novelRun, novel.data, { kind: 'support', templateId: 'make_ten_blocks', strategy: 'make_ten', activitySpec: specFor(context, []) })), 'VALIDATION_FAILED', /new pattern/);
    // The decision itself publishes, and the run is not left in error.
    assert.ok((await tool(novelRun, 'publish_activity', await publishArgs(novelRun, novel.data))).ok);
    assert.equal((await store.getRun(novelRun)).state.phase, 'CLARIFY');
  });

  test('spec, hash, helper count, activity, event, receipt and revision commit in one transaction', async () => {
    const runId = await invitedRun();
    await toProcessing(runId);
    const found = await search(runId, [['count_start', 'I counted eight']]);
    const before = await store.getRun(runId);
    const args = await publishArgs(runId, found);
    const result = await tool(runId, 'publish_activity', args);
    assert.ok(result.ok && result.tool === 'publish_activity');
    const { activity, newRevision, eventSeq } = result.data;
    assert.deepEqual([activity.kind, activity.templateId, activity.helperCount, activity.revision, newRevision], ['support', 'make_ten_blocks', 2, before.revision + 1, before.revision + 1]);
    assert.deepEqual(activity.activitySpec, args.activitySpec);
    assert.equal(activity.specHash?.length, 64);
    assert.deepEqual(await store.getActivity(runId, activity.id, activity.revision), activity);
    const written = await eventsOf(runId, before.seq);
    assert.deepEqual(typesOf(written), ['activity.published', 'state.committed']);
    assert.equal(written[0]?.seq, eventSeq);
    const { state, revision } = await store.getRun(runId);
    assert.deepEqual([state.phase, state.interventionCount, state.activity?.id, revision], ['PRACTICE', 1, activity.id, newRevision]);
    const replay = await tool(runId, 'publish_activity', args);
    assert.deepEqual(replay, result);
    assert.equal((await store.getRun(runId)).seq, written.at(-1)?.seq);
  });
});

describe('assess_attempt and commit_episode', () => {
  test('assess uses the activity\'s rubric and numbers, not the criterion; a mismatch is rejected; a later call returns the saved assessment', async () => {
    const runId = await invitedRun();
    await toVerify(runId);
    const { independent } = await problemsOf(runId);
    // A make-ten placement for the independent 9 + 4: one in the box, three to the side.
    const { run } = await send(runId, { type: 'verify', attempt: makeTen(independent) });
    const saved = run.state.attempts.at(-1);
    assert.ok(saved?.assessment);
    assert.deepEqual([saved.criterion, saved.assessment.passed, saved.assessment.processCorrect, saved.assessment.hints], ['independent', true, true, 0]);
    const practice = run.state.attempts.find((a) => a.criterion === 'support');
    assert.ok(practice);

    failedWith(await tool(runId, 'assess_attempt', { attemptId: saved.id, criterion: 'support' }), 'VALIDATION_FAILED', /answers a independent activity/);
    failedWith(await tool(runId, 'assess_attempt', { attemptId: `${runId}_attempt_99`, criterion: 'independent' }), 'VALIDATION_FAILED');
    const assessed = await tool(runId, 'assess_attempt', { attemptId: saved.id, criterion: 'independent' });
    assert.ok(assessed.ok && assessed.tool === 'assess_attempt');
    assert.deepEqual(assessed.data, saved.assessment);
    // The practice attempt was graded on 8 + 5 with the support's two helpers counted as help.
    const support = await tool(runId, 'assess_attempt', { attemptId: practice.id, criterion: 'support' });
    assert.ok(support.ok && support.tool === 'assess_attempt');
    assert.deepEqual([support.data.passed, support.data.hints], [true, 2]);
    const again = await tool(runId, 'assess_attempt', { attemptId: saved.id, criterion: 'independent' });
    assert.deepEqual(again, assessed);
  });

  test('commit_episode builds the outcome from stored facts; missing evidence is not_assessed, never failed; a repeat returns the existing result', async () => {
    const commitAfter = async (attempt: MakeTenAttempt) => {
      const runId = await invitedRun();
      await toVerify(runId);
      const { run } = await send(runId, { type: 'verify', attempt });
      const independent = run.state.attempts.at(-1);
      const practice = run.state.attempts.find((a) => a.criterion === 'support');
      assert.ok(independent && practice);
      const args = { independentAttemptId: independent.id, supportAttemptId: practice.id, expectedRevision: run.revision };
      return { runId, args, result: await tool(runId, 'commit_episode', args) };
    };
    const independentProblem = { lhs: 9, rhs: 4 };

    const passed = await commitAfter(makeTen(independentProblem));
    assert.ok(passed.result.ok && passed.result.tool === 'commit_episode');
    assert.deepEqual([passed.result.data.outcome, passed.result.data.strategy, passed.result.data.caseId], ['independent', 'make_ten', `${passed.runId}_outcome`]);
    const done = await store.getRun(passed.runId);
    assert.equal(done.state.phase, 'COMPLETE');
    const outcomes = (await eventsOf(passed.runId)).filter((e) => e.type === 'outcome.committed');
    assert.equal(outcomes.length, 1);
    const repeat = await tool(passed.runId, 'commit_episode', { ...passed.args, expectedRevision: done.revision });
    assert.deepEqual(repeat, passed.result);
    assert.equal((await eventsOf(passed.runId)).filter((e) => e.type === 'outcome.committed').length, 1);

    // The right number with every object left in the tray: the partition was never observed.
    const answerOnly = await commitAfter({ placements: [], answer: 13, hints: 0 });
    assert.ok(answerOnly.result.ok && answerOnly.result.tool === 'commit_episode');
    assert.equal(answerOnly.result.data.outcome, 'not_assessed');
    assert.equal((await store.getRun(answerOnly.runId)).state.phase, 'NEEDS_SUPPORT');

    const hinted = await commitAfter({ ...makeTen(independentProblem), hints: 1 });
    assert.ok(hinted.result.ok && hinted.result.tool === 'commit_episode');
    assert.equal(hinted.result.data.outcome, 'not_assessed');

    const wrong = await commitAfter(makeTen(independentProblem, 12));
    assert.ok(wrong.result.ok && wrong.result.tool === 'commit_episode');
    assert.equal(wrong.result.data.outcome, 'failed');

    // Once the run has left VERIFY, no other attempt can be committed.
    failedWith(await tool(wrong.runId, 'commit_episode', { ...wrong.args, independentAttemptId: `${wrong.runId}_attempt_1`, expectedRevision: (await store.getRun(wrong.runId)).revision }), 'WRONG_PHASE');
  });

  test('outcome.committed is emitted after a second intervention too', async () => {
    const runId = await invitedRun();
    const { initial, independent } = await problemsOf(runId);
    await toProcessing(runId, 'I missed one tap.');
    assert.ok((await tool(runId, 'publish_activity', await publishArgs(runId, await search(runId, [['slip', 'missed one tap']])))).ok);
    await send(runId, { type: 'practice', attempt: oneShort(initial) });
    assert.equal((await store.getRun(runId)).state.phase, 'CLARIFY');
    await send(runId, { type: 'explain', text: 'I counted eight first, then nine.' });
    const second = await search(runId, [['count_start', 'I counted eight first']]);
    assert.equal(second.search.decision.strategy, 'make_ten');
    assert.ok((await tool(runId, 'publish_activity', await publishArgs(runId, second))).ok);
    assert.equal((await store.getRun(runId)).state.interventionCount, 2);
    await send(runId, { type: 'practice', attempt: makeTen(initial) });
    const { run } = await send(runId, { type: 'verify', attempt: makeTen(independent) });
    const practice = run.state.attempts.findLast((a) => a.criterion === 'support' && a.assessment?.passed);
    const committed = await tool(runId, 'commit_episode', { independentAttemptId: run.state.attempts.at(-1)?.id, supportAttemptId: practice?.id, expectedRevision: run.revision });
    assert.ok(committed.ok && committed.tool === 'commit_episode', JSON.stringify(committed));
    const outcome = (await eventsOf(runId)).find((e) => e.type === 'outcome.committed');
    assert.ok(outcome?.type === 'outcome.committed');
    assert.deepEqual(outcome.payload.nodes.map((n) => n.meaning), ['retry', 'make_ten', 'independent']);
    assert.equal(outcome.payload.persistedCaseId, `${runId}_outcome`);
  });

  test('a handler-accepted proposal never becomes a later run error', async () => {
    // Conflicting hypotheses with a clarification request, then the film path, all the way to a commit.
    const runId = await invitedRun();
    await toProcessing(runId);
    const conflicting = await search(runId, [['count_start', 'I counted eight'], ['slip', 'five numbers']], true);
    assert.equal(conflicting.search.decision.basis, 'clarify');
    assert.ok((await tool(runId, 'publish_activity', await publishArgs(runId, conflicting))).ok);
    await send(runId, { type: 'explain', text: 'I counted eight as one.' });
    const accepted = await search(runId, [['count_start', 'I counted eight as one']]);
    assert.ok((await tool(runId, 'publish_activity', await publishArgs(runId, accepted))).ok);
    const { initial, independent } = await problemsOf(runId);
    await send(runId, { type: 'practice', attempt: makeTen(initial) });
    const { run } = await send(runId, { type: 'verify', attempt: makeTen(independent) });
    const practice = run.state.attempts.find((a) => a.criterion === 'support');
    const committed = await tool(runId, 'commit_episode', { independentAttemptId: run.state.attempts.at(-1)?.id, supportAttemptId: practice?.id, expectedRevision: run.revision });
    assert.ok(committed.ok, JSON.stringify(committed));
    const { state } = await store.getRun(runId);
    assert.deepEqual([state.phase, state.error], ['COMPLETE', null]);
    assert.ok((await eventsOf(runId)).every((e) => e.type !== 'operation.failed'));
  });
});
