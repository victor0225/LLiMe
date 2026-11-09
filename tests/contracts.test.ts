import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { z } from 'zod';
import { ACTIVITY_COPY, INVITATION_COPY, LESSON_NOTES_COPY, NOTIFICATION_COPY, problemQuestion, SPOKEN_COPY, STUDENT_COPY } from '../src/copy.js';
import {
  type Activity,
  ActivitySchema,
  ActivitySpecSchema,
  type ActivitySpec,
  AssessAttemptInputSchema,
  AssessAttemptOutputSchema,
  CaseSchema,
  COMMAND_PHASES,
  CommandSchema,
  CommitEpisodeInputSchema,
  CommitEpisodeOutputSchema,
  type ConceptLink,
  type ContextCommit,
  CONTRACT_VERSION,
  ConceptLinkSchema,
  ConceptLinksSchema,
  CorrelationIdsSchema,
  GetPersonalMemoryInputSchema,
  type GetPersonalMemoryOutput,
  GetPersonalMemoryOutputSchema,
  type LearningCase,
  NotificationOutboxSchema,
  NotificationPayloadSchema,
  PHASE_TRANSITIONS,
  PhaseResultSchema,
  PublishActivityInputSchema,
  type PublishActivityInput,
  PublishActivityOutputSchema,
  RunPhaseSchema,
  RunSelectionSchema,
  type RunState,
  SearchLearningCasesInputSchema,
  type SearchLearningCasesInput,
  SearchLearningCasesOutputSchema,
  type SupportActivityContext,
  SupportActivityContextSchema,
  DecisionSchema,
  type SearchResult,
  TEMPLATE_KIND,
  TemplateIdSchema,
  TOOL_SCHEMAS,
  ToolCallSchema,
  ToolNameSchema,
  ToolResultSchema,
  type ToolSuccess,
  validateCase,
  VoiceOperationSchema,
} from '../src/domain.js';
import { EVENT_PAYLOAD_SCHEMAS, EVENT_TYPES, EventSchema, type EventType, RunSnapshotSchema } from '../src/events.js';
import {
  ERROR_HTTP_STATUS,
  EventsQuerySchema,
  HttpErrorSchema,
  LESSON_TEXT_MAX_BYTES,
  ROUTES,
  type RouteName,
  routePath,
  VoiceCommandSchema,
} from '../src/routes.js';

function accepts(schema: z.ZodType, value: unknown) {
  const result = schema.safeParse(value);
  assert.ok(result.success, result.success ? '' : JSON.stringify(result.error.issues));
}

function rejects(schema: z.ZodType, value: unknown) {
  assert.equal(schema.safeParse(value).success, false, `expected rejection of ${JSON.stringify(value)?.slice(0, 200)}`);
}

// ---------------------------------------------------------------------------------------------
// Builders for the film-seed path: 8 + 5 on the number line, count_start, then make_ten, then 9 + 4.

const RUN_ID = 'f3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const COMMAND_ID = '9a8b7c6d-5e4f-4321-8fed-cba987654321';
const AT = '2026-11-09T01:30:00.000Z';
const CORPUS_HASH = '22541eed813af88b09f8c30e26d49a6c21144cc968643311dc8fe8cad96f1bbe';
const CONTEXT_ID = `${RUN_ID}_context_1`;

function filmCase(id = CONTEXT_ID): LearningCase {
  return {
    id,
    studentId: 'student_7',
    provenance: 'live_demo',
    createdAt: AT,
    concept: 'addition_within_20',
    sources: [
      { id: `${id}:actions`, text: '{"start":8,"moves":[9,10,11,12],"answer":12,"hints":0}' },
      { id: `${id}:speech`, text: 'I counted eight, nine, ten, eleven, twelve. That was five numbers.' },
    ],
    nodes: [
      { id: `${id}:attempt`, type: 'Attempt', meaning: 'addition', stage: 'context', sourceIds: [`${id}:actions`] },
      { id: `${id}:concept`, type: 'Concept', meaning: 'addition_within_20', stage: 'context', sourceIds: [`${id}:actions`] },
      { id: `${id}:observation`, type: 'Observation', meaning: 'one_move_short', stage: 'context', sourceIds: [`${id}:actions`] },
      { id: `${id}:explanation`, type: 'Explanation', meaning: 'learner_account', stage: 'context', sourceIds: [`${id}:speech`] },
      { id: `${id}:hypothesis_count_start`, type: 'Hypothesis', meaning: 'count_start', stage: 'context', sourceIds: [`${id}:speech`] },
    ],
    edges: [
      { id: `${id}:e0`, from: `${id}:attempt`, to: `${id}:concept`, type: 'TARGETS', stage: 'context' },
      { id: `${id}:e1`, from: `${id}:attempt`, to: `${id}:observation`, type: 'OBSERVED', stage: 'context' },
      { id: `${id}:e2`, from: `${id}:observation`, to: `${id}:explanation`, type: 'EXPLAINED_BY', stage: 'context' },
      { id: `${id}:e3`, from: `${id}:explanation`, to: `${id}:hypothesis_count_start`, type: 'SUPPORTS', stage: 'context' },
    ],
    strategy: 'clarify',
    outcome: 'not_assessed',
    retention: 'pending',
  };
}

function supportSpec(): ActivitySpec {
  return {
    catalogVersion: 'primer-math-v1.1',
    activityId: `${RUN_ID}_support_1`,
    revision: 8,
    phase: 'support',
    problemRef: 'addition_8_5',
    evidenceIds: ['hist_102_0'],
    components: [{ id: 'box', type: 'MakeTenWorkspace', props: { first: 8, second: 5, appearance: 'apple', highlightEmptySlots: true, showEquation: true } }],
  };
}

const independentSpec = (): ActivitySpec => ({
  ...supportSpec(),
  activityId: `${RUN_ID}_independent`,
  revision: 10,
  phase: 'independent',
  problemRef: 'addition_9_4',
  evidenceIds: [],
  components: [{ id: 'box', type: 'MakeTenWorkspace', props: { first: 9, second: 4, appearance: 'apple', highlightEmptySlots: false, showEquation: false } }],
});

const lineSpec = (): ActivitySpec => ({
  ...supportSpec(),
  components: [
    { id: 'line', type: 'NumberLine', props: { start: 8, addend: 5 } },
    { id: 'marker', type: 'StartMarker', props: { targetId: 'line', value: 8 } },
    { id: 'counter', type: 'JumpCounter', props: { targetId: 'line' } },
  ],
});

const independentLineSpec = (): ActivitySpec => ({ ...independentSpec(), components: [{ id: 'line', type: 'NumberLine', props: { start: 9, addend: 4 } }] });

function invitationActivity(): Activity {
  return {
    id: `${RUN_ID}_invitation`,
    revision: 2,
    runId: RUN_ID,
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
    evidenceIds: ['sub_7_0', 'seed_7_0'],
    decisionSummary: 'Earlier subtraction needed help (sub_7_0, seed_7_0). New addition may also need support, so a short check finds out.',
  };
}

function supportActivity(): Activity {
  const copy = ACTIVITY_COPY.make_ten_blocks({ lhs: 8, rhs: 5 });
  return {
    id: `${RUN_ID}_support_1`,
    revision: 8,
    runId: RUN_ID,
    kind: 'support',
    templateId: 'make_ten_blocks',
    strategy: 'make_ten',
    problem: { lhs: 8, rhs: 5 },
    ...copy,
    activitySpec: supportSpec(),
    specHash: 'b5d4c3a2',
    helperCount: 2,
    evidenceIds: ['hist_102_0'],
    decisionSummary: 'Comparable cases most often reached an independent result with make_ten.',
  };
}

function filmSearch(): SearchResult {
  return {
    matchingVersion: 'typed-path-v1',
    corpusHash: CORPUS_HASH,
    queryId: CONTEXT_ID,
    candidateCount: 659,
    rankingHash: 'a1b2c3',
    candidates: [
      {
        id: 'hist_102_0',
        studentId: 'student_102',
        score: 1,
        coverage: 1,
        strategy: 'make_ten',
        outcome: 'independent',
        matchedQueryNodeIds: [`${CONTEXT_ID}:attempt`],
        matchedCandidateNodeIds: ['hist_102_0:attempt'],
      },
    ],
    decision: {
      strategy: 'make_ten',
      templateId: 'make_ten_blocks',
      basis: 'evidence',
      evidenceIds: ['hist_102_0'],
      reason: '23/29 comparable historical cases have an independent result; observational evidence, not a treatment effect.',
      groups: [
        { strategy: 'make_ten', independent: 23, total: 29 },
        { strategy: 'anchor_start', independent: 14, total: 22 },
        { strategy: 'repeat_count', independent: 3, total: 8 },
      ],
    },
    scores: [['hist_102_0', 1], ['seed_0_1', 0.294]],
    admitted: [{ caseId: 'hist_102_0', score: 1, coverage: 1, strategy: 'make_ten', outcome: 'independent', matchedEdgeIds: ['hist_102_0:e0'] }],
  };
}

const contextCommit = (): ContextCommit => ({ caseId: CONTEXT_ID, explanationRevision: 1, eventSeq: 14, nodeIds: [`${CONTEXT_ID}:attempt`], edgeIds: [`${CONTEXT_ID}:e0`], replayed: false });

const supportContext = (): SupportActivityContext => ({
  activityId: `${RUN_ID}_support_1`,
  revision: 8,
  phase: 'support',
  workspace: 'MakeTenWorkspace',
  problemRef: 'addition_8_5',
  start: 8,
  addend: 5,
  evidenceIds: ['hist_102_0'],
});

function searchInput(): SearchLearningCasesInput {
  return {
    explanationRevision: 1,
    interpretations: [{ meaning: 'count_start', proposedMeaning: null, sourceId: `${CONTEXT_ID}:speech`, quote: 'I counted eight, nine, ten, eleven, twelve.', relation: 'SUPPORTS' }],
    needsClarification: false,
    retrievalContext: null,
  };
}

function invitationInput(): PublishActivityInput {
  return {
    expectedRevision: 1,
    explanationRevision: null,
    kind: 'invitation',
    templateId: 'invitation_addition',
    strategy: null,
    problem: null,
    evidenceIds: ['sub_7_0', 'seed_7_0'],
    todayConceptId: 'addition_within_20',
    quotes: ['Today we put two groups together.'],
    decisionSummary: 'Earlier subtraction needed help; new addition may also need support, so a short check finds out.',
    activitySpec: null,
  };
}

function supportInput(): PublishActivityInput {
  return {
    expectedRevision: 7,
    explanationRevision: 1,
    kind: 'support',
    templateId: 'make_ten_blocks',
    strategy: 'make_ten',
    problem: { lhs: 8, rhs: 5 },
    evidenceIds: ['hist_102_0'],
    todayConceptId: null,
    quotes: null,
    decisionSummary: 'Comparable cases most often reached an independent result with make_ten.',
    activitySpec: supportSpec(),
  };
}

const plainInput = (kind: 'retry' | 'clarification', templateId: 'manipulation_retry' | 'clarify_first_number'): PublishActivityInput => ({
  ...supportInput(),
  kind,
  templateId,
  strategy: kind === 'retry' ? 'retry' : 'clarify',
  evidenceIds: [],
  activitySpec: null,
});

const memoryOutput = (): GetPersonalMemoryOutput => ({
  memorySnapshotId: `${RUN_ID}_memory_1`,
  studentId: 'student_7',
  corpusHash: CORPUS_HASH,
  cases: [{ caseId: 'seed_7_0', concept: 'subtraction_within_20', strategy: 'make_ten', outcome: 'assisted', retention: 'pending', nodeIds: ['seed_7_0:attempt'] }],
  summaries: [
    { conceptId: 'addition_within_20', link: 'today', total: 0, independent: 0, assisted: 0, failed: 0, notAssessed: 0, firstAt: null, lastAt: null },
    { conceptId: 'subtraction_within_20', link: 'similar', total: 18, independent: 9, assisted: 5, failed: 2, notAssessed: 2, firstAt: '2026-09-07T09:00:00.000Z', lastAt: '2026-10-30T09:00:00.000Z' },
  ],
  unassessedConceptIds: [],
});

const assessment = () => ({ attemptId: `${RUN_ID}_initial`, passed: false, processCorrect: false, answerCorrect: false, hints: 0, retention: 'pending' });

const searchSuccess = (): ToolSuccess => ({ ok: true, tool: 'search_learning_cases', data: { contextCommit: contextCommit(), search: filmSearch(), publicationContext: { expectedRevision: 7, activityContext: supportContext() } } });

const commitOutput = () => ({ caseId: `${RUN_ID}_outcome`, strategy: 'make_ten', outcome: 'independent', retention: 'pending', newRevision: 12, eventSeq: 31 });

const CONCEPT_LINKS: ConceptLink[] = [
  { from: 'subtraction', to: 'addition', kind: 'similar', reason: 'related arithmetic concepts: taking away and putting together' },
  { from: 'subtraction_within_20', to: 'subtraction', kind: 'subconcept', reason: 'subtraction within 20 is a scope of subtraction' },
  { from: 'addition_within_20', to: 'addition', kind: 'subconcept', reason: 'addition within 20 is a scope of addition' },
];

const toolRef = { threadId: 'thr_1', turnId: 'turn_1', callId: 'call_1', itemId: 'item_1', serverRequestId: 7, attempt: 1 };

const SAMPLE_PAYLOADS: { readonly [T in EventType]: z.input<(typeof EVENT_PAYLOAD_SCHEMAS)[T]> } = {
  'state.committed': { phase: 'INVITED', revision: 2, caseIds: [] },
  'lesson.detected': { contentHash: '0ccc0c36', source: 'local_file', bytes: 2293 },
  'memory.retrieved': { conceptIds: ['addition_within_20', 'subtraction_within_20'], caseIds: ['seed_7_0'], summaries: memoryOutput().summaries, links: CONCEPT_LINKS },
  'operation.started': { operationId: 'op_1', phase: 'explanation', explanationRevision: 1, cancellationEpoch: 0 },
  'graph.updated': { graph: filmCase() },
  'runtime.boundary': { disabledFeatures: ['shell_tool'], webSearch: 'disabled', configuredMcpCount: 1, disabledMcpCount: 1, enabledMcpTools: 0, selectedCapabilityRoots: 0, environments: 0, sandbox: 'read-only', scope: 'verified model-facing feature flags and inherited MCP inventory' },
  'runtime.input': { threadId: 'thr_1', model: 'gpt-6.1-terra', serviceTier: 'priority', phase: 'explanation', promptHash: 'p1', instructions: 'PHASE: explanation.', input: { revision: 7 } },
  'runtime.item': { threadId: 'thr_1', turnId: 'turn_1', id: 'item_1', type: 'dynamicToolCall', lifecycle: 'started', tool: 'search_learning_cases' },
  'tool.started': { ...toolRef, name: 'search_learning_cases', arguments: searchInput() },
  'tool.completed': { ...toolRef, name: 'search_learning_cases', result: searchSuccess(), elapsedMs: 21 },
  'tool.failed': { ...toolRef, name: 'record_learning_evidence', error: { code: 'UNKNOWN_TOOL', message: 'Tool not allowed', retryable: false }, contextCommit: null, elapsedMs: 1 },
  'runtime.message': { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_2', text: 'Published the ten-box activity.', partial: false },
  'runtime.completed': { threadId: 'thr_1', turnId: 'turn_1', status: 'completed' },
  'search.started': { matchingVersion: 'typed-path-v1', queryId: CONTEXT_ID, candidateCount: 659, queryNodeIds: [`${CONTEXT_ID}:attempt`] },
  'search.completed': filmSearch(),
  'operation.failed': { operationId: 'op_1', code: 'MODEL_TIMEOUT', message: 'The model turn timed out after 90 seconds.' },
  'outcome.committed': {
    queryId: CONTEXT_ID,
    persistedCaseId: `${RUN_ID}_outcome`,
    strategy: 'make_ten',
    outcome: 'independent',
    saved: true,
    nodes: [
      { id: `${CONTEXT_ID}:intervention`, type: 'Intervention', meaning: 'make_ten', stage: 'result', sourceIds: [`${CONTEXT_ID}:evaluation`] },
      { id: `${CONTEXT_ID}:outcome`, type: 'Outcome', meaning: 'independent', stage: 'result', sourceIds: [`${CONTEXT_ID}:evaluation`] },
    ],
    edges: [
      { id: `${CONTEXT_ID}:intervention-link`, from: `${CONTEXT_ID}:attempt`, to: `${CONTEXT_ID}:intervention`, type: 'FOLLOWED_BY', stage: 'result' },
      { id: `${CONTEXT_ID}:outcome-link`, from: `${CONTEXT_ID}:intervention`, to: `${CONTEXT_ID}:outcome`, type: 'EVALUATED_BY', stage: 'result' },
    ],
    source: { id: `${CONTEXT_ID}:evaluation`, text: '{"strategy":"make_ten","outcome":"independent"}' },
  },
  'context.committed': { caseId: CONTEXT_ID, explanationRevision: 1, graph: filmCase() },
  'activity.published': { activity: supportActivity() },
  'notification.queued': { notificationId: 'notif_1', runId: RUN_ID, activityId: `${RUN_ID}_invitation`, activityRevision: 2 },
  'notification.sent': { notificationId: 'notif_1', runId: RUN_ID, activityId: `${RUN_ID}_invitation`, activityRevision: 2 },
  'notification.opened': { notificationId: 'notif_1', runId: RUN_ID, activityId: `${RUN_ID}_invitation`, activityRevision: 2 },
  'voice.delegated': { runId: RUN_ID, liveSessionId: 'live_1', delegationId: 'del_1', operationId: 'op_1', explanationRevision: 1, cancellationEpoch: 0, threadId: 'thr_1', turnId: null, offsetMs: 5200 },
  'voice.commentary': { liveSessionId: 'live_1', delegationId: 'del_1', operationId: 'op_1', activityId: `${RUN_ID}_support_1`, activityRevision: 8, explanationRevision: 1, cancellationEpoch: 0, text: SPOKEN_COPY.makeTenIntroduction },
  'turn.steered': { threadId: 'thr_1', expectedTurnId: 'turn_1', operationId: 'op_2', explanationRevision: 2, cancellationEpoch: 1 },
  'operation.cancelled': { operationId: 'op_1', reason: 'superseded', explanationRevision: 2, cancellationEpoch: 1 },
};

const sampleEvent = <T extends EventType>(type: T, seq = 1) => ({ runId: RUN_ID, seq, type, payload: SAMPLE_PAYLOADS[type], at: AT });

function invitedState(): RunState {
  return {
    phase: 'INVITED',
    stopped: false,
    studentId: 'student_7',
    corpusHash: CORPUS_HASH,
    matchingVersion: 'typed-path-v1',
    seed: 20261109,
    lessonProblems: [{ lhs: 7, rhs: 4 }, { lhs: 7, rhs: 6 }, { lhs: 6, rhs: 5 }],
    selectedProblems: { initial: { lhs: 8, rhs: 5 }, independent: { lhs: 9, rhs: 4 } },
    explanationRevision: 0,
    cancellationEpoch: 0,
    clarificationRounds: 0,
    interventionCount: 0,
    continuationAllowed: false,
    runtime: { model: 'gpt-6.1-terra', serviceTier: 'priority', threadId: 'thr_1' },
    lesson: { contentHash: '0ccc0c36', text: '# Lesson\n[00:00] Ms. Ortiz: Today we put two groups together.', source: 'local_file', savedAt: AT },
    invitation: invitationActivity(),
    activity: invitationActivity(),
    attempts: [],
    explanation: null,
    graph: null,
    search: null,
    error: null,
    createdAt: AT,
  };
}

function snapshot() {
  const events = [sampleEvent('state.committed', 1), sampleEvent('activity.published', 2)];
  return { ...invitedState(), id: RUN_ID, revision: 2, seq: 2, execution: { throughSeq: 2, events } };
}

// ---------------------------------------------------------------------------------------------

test('the contract version is 2.1.0', () => {
  assert.equal(CONTRACT_VERSION, '2.1.0');
});

describe('ConceptLink', () => {
  test('accepts the three seeded curriculum links', () => accepts(ConceptLinksSchema, CONCEPT_LINKS));
  test('rejects an unknown kind', () => rejects(ConceptLinkSchema, { ...CONCEPT_LINKS[0], kind: 'causes' }));
  test('rejects an ID outside the curriculum', () => rejects(ConceptLinkSchema, { ...CONCEPT_LINKS[0], from: 'multiplication' }));
  test('rejects an empty reason', () => rejects(ConceptLinkSchema, { ...CONCEPT_LINKS[0], reason: '' }));
  test('rejects extra fields', () => rejects(ConceptLinkSchema, { ...CONCEPT_LINKS[0], weight: 1 }));
});

describe('case graph', () => {
  test('accepts the film context graph', () => assert.equal(validateCase(filmCase()).id, CONTEXT_ID));
  test('accepts a novel hypothesis that carries its proposed name', () => {
    const c = filmCase();
    c.nodes[4] = { id: `${CONTEXT_ID}:hypothesis_novel`, type: 'Hypothesis', meaning: 'novel', stage: 'context', sourceIds: [`${CONTEXT_ID}:speech`], proposedMeaning: 'counts_fingers_twice' };
    c.edges[3] = { ...c.edges[3]!, to: `${CONTEXT_ID}:hypothesis_novel` };
    assert.equal(validateCase(c).nodes[4]?.proposedMeaning, 'counts_fingers_twice');
  });
  test('keeps parsed key order so case hashes are stable', () => {
    const reordered = Object.fromEntries(Object.entries(filmCase()).reverse());
    assert.equal(JSON.stringify(CaseSchema.parse(reordered)), JSON.stringify(filmCase()));
  });
  test('rejects a node outside its case', () => {
    const c = filmCase();
    c.nodes[0] = { ...c.nodes[0]!, id: 'other:attempt' };
    assert.throws(() => validateCase(c), /Unscoped node or missing source/);
  });
  test('rejects a result node in the context stage', () => {
    const c = filmCase();
    c.nodes.push({ id: `${CONTEXT_ID}:outcome`, type: 'Outcome', meaning: 'independent', stage: 'context', sourceIds: [`${CONTEXT_ID}:actions`] });
    assert.throws(() => validateCase(c), /Outcome leakage/);
  });
  test('rejects an edge between disallowed node types', () => {
    const c = filmCase();
    c.edges[0] = { ...c.edges[0]!, to: `${CONTEXT_ID}:hypothesis_count_start` };
    assert.throws(() => validateCase(c), /Invalid graph relation/);
  });
  test('rejects a proposed name on a known hypothesis', () => {
    const c = filmCase();
    c.nodes[4] = { ...c.nodes[4]!, proposedMeaning: 'counts_twice' };
    assert.throws(() => validateCase(c), /Unexpected proposed meaning/);
  });
  test('rejects a parent concept on a case', () => rejects(CaseSchema, { ...filmCase(), concept: 'addition' }));
});

describe('tool get_personal_memory', () => {
  test('accepts today and a linked concept', () => accepts(GetPersonalMemoryInputSchema, { conceptIds: ['addition_within_20', 'subtraction_within_20'], includeUnassessed: true }));
  test('rejects a parent concept ID', () => rejects(GetPersonalMemoryInputSchema, { conceptIds: ['addition'], includeUnassessed: true }));
  test('rejects no concepts or more than two', () => {
    rejects(GetPersonalMemoryInputSchema, { conceptIds: [], includeUnassessed: true });
    rejects(GetPersonalMemoryInputSchema, { conceptIds: ['addition_within_20', 'subtraction_within_20', 'addition_within_20'], includeUnassessed: true });
  });
  test('accepts empty addition history next to subtraction history', () => accepts(GetPersonalMemoryOutputSchema, memoryOutput()));
  test('rejects more than 16 cases', () => rejects(GetPersonalMemoryOutputSchema, { ...memoryOutput(), cases: Array.from({ length: 17 }, () => memoryOutput().cases[0]) }));
  test('rejects a result without summaries', () => rejects(GetPersonalMemoryOutputSchema, { ...memoryOutput(), summaries: [] }));
});

describe('tool search_learning_cases', () => {
  test('accepts the film proposal', () => accepts(SearchLearningCasesInputSchema, searchInput()));
  test('accepts a known meaning without proposedMeaning', () => {
    const input = searchInput();
    const { proposedMeaning: _omitted, ...withoutName } = input.interpretations[0]!;
    accepts(SearchLearningCasesInputSchema, { ...input, interpretations: [withoutName] });
  });
  test('accepts one supporting novel interpretation with a snake_case name', () => {
    const input = searchInput();
    accepts(SearchLearningCasesInputSchema, { ...input, interpretations: [{ ...input.interpretations[0]!, meaning: 'novel', proposedMeaning: 'counts_fingers_twice' }] });
  });
  const novel = { meaning: 'novel', proposedMeaning: 'counts_fingers_twice', sourceId: `${CONTEXT_ID}:speech`, quote: 'I counted eight', relation: 'SUPPORTS' };
  const withInterpretations = (interpretations: unknown[]) => ({ ...searchInput(), interpretations });
  test('rejects novel without a name', () => rejects(SearchLearningCasesInputSchema, withInterpretations([{ ...novel, proposedMeaning: null }])));
  test('rejects a novel name that is a known meaning', () => rejects(SearchLearningCasesInputSchema, withInterpretations([{ ...novel, proposedMeaning: 'slip' }])));
  test('rejects a novel name that is not snake_case', () => rejects(SearchLearningCasesInputSchema, withInterpretations([{ ...novel, proposedMeaning: 'Counts Twice' }])));
  test('rejects a contradicting novel interpretation', () => rejects(SearchLearningCasesInputSchema, withInterpretations([{ ...novel, relation: 'CONTRADICTS' }])));
  test('rejects two novel interpretations', () => rejects(SearchLearningCasesInputSchema, withInterpretations([novel, { ...novel, proposedMeaning: 'skips_ten' }])));
  test('rejects a name on a known meaning', () => rejects(SearchLearningCasesInputSchema, withInterpretations([{ ...novel, meaning: 'count_start' }])));
  test('rejects more than four interpretations', () => rejects(SearchLearningCasesInputSchema, withInterpretations(Array.from({ length: 5 }, () => searchInput().interpretations[0]))));
  test('rejects a missing retrievalContext', () => {
    const { retrievalContext: _missing, ...input } = searchInput();
    rejects(SearchLearningCasesInputSchema, input);
  });
  const output = () => ({ contextCommit: contextCommit(), search: filmSearch(), publicationContext: { expectedRevision: 7, activityContext: supportContext() } });
  test('accepts the film search result with its support context', () => accepts(SearchLearningCasesOutputSchema, output()));
  test('accepts a clarification result without activity context', () => {
    const search = { ...filmSearch(), decision: { strategy: 'clarify', templateId: 'clarify_show_steps', basis: 'clarify', evidenceIds: [], reason: 'A possible new pattern has no recorded history. Ask the child to show their steps.', groups: [] } };
    accepts(SearchLearningCasesOutputSchema, { ...output(), search, publicationContext: { expectedRevision: 7, activityContext: null } });
  });
  test('rejects more than 20 detailed candidates', () => rejects(SearchLearningCasesOutputSchema, { ...output(), search: { ...filmSearch(), candidates: Array.from({ length: 21 }, () => filmSearch().candidates[0]) } }));
  test('rejects an evidence decision without evidence', () => rejects(DecisionSchema, { ...filmSearch().decision, evidenceIds: [] }));
  test('rejects a support context for the independent phase', () => rejects(SupportActivityContextSchema, { ...supportContext(), phase: 'independent' }));
  test('rejects evidence on a default decision', () => rejects(SearchLearningCasesOutputSchema, { ...output(), search: { ...filmSearch(), decision: { ...filmSearch().decision, basis: 'default' } } }));
  test('rejects an unassessed admitted case', () => rejects(SearchLearningCasesOutputSchema, { ...output(), search: { ...filmSearch(), admitted: [{ ...filmSearch().admitted[0], outcome: 'not_assessed' }] } }));
  test('rejects a group with more successes than cases', () => rejects(SearchLearningCasesOutputSchema, { ...output(), search: { ...filmSearch(), decision: { ...filmSearch().decision, groups: [{ strategy: 'make_ten', independent: 30, total: 29 }] } } }));
  test('rejects another matching version', () => rejects(SearchLearningCasesOutputSchema, { ...output(), search: { ...filmSearch(), matchingVersion: 'feature-score-v1' } }));
});

describe('tool publish_activity', () => {
  test('accepts an invitation', () => accepts(PublishActivityInputSchema, invitationInput()));
  test('accepts make-ten support with its spec', () => accepts(PublishActivityInputSchema, supportInput()));
  test('accepts a plain retry and a clarification', () => {
    accepts(PublishActivityInputSchema, plainInput('retry', 'manipulation_retry'));
    accepts(PublishActivityInputSchema, plainInput('clarification', 'clarify_first_number'));
  });
  test('rejects an invitation without quotes, concept or evidence', () => {
    rejects(PublishActivityInputSchema, { ...invitationInput(), quotes: null });
    rejects(PublishActivityInputSchema, { ...invitationInput(), quotes: [] });
    rejects(PublishActivityInputSchema, { ...invitationInput(), todayConceptId: null });
    rejects(PublishActivityInputSchema, { ...invitationInput(), evidenceIds: [] });
  });
  test('rejects more than three quotes or five evidence IDs', () => {
    rejects(PublishActivityInputSchema, { ...invitationInput(), quotes: ['a', 'b', 'c', 'd'] });
    rejects(PublishActivityInputSchema, { ...invitationInput(), evidenceIds: ['a', 'b', 'c', 'd', 'e', 'f'] });
  });
  test('rejects support without a spec and a retry with one', () => {
    rejects(PublishActivityInputSchema, { ...supportInput(), activitySpec: null });
    rejects(PublishActivityInputSchema, { ...plainInput('retry', 'manipulation_retry'), activitySpec: supportSpec() });
  });
  test('rejects invitation-only fields on other kinds', () => {
    rejects(PublishActivityInputSchema, { ...plainInput('clarification', 'clarify_first_number'), todayConceptId: 'addition_within_20' });
    rejects(PublishActivityInputSchema, { ...supportInput(), quotes: ['x'] });
  });
  test('rejects a decision summary over 300 characters', () => rejects(PublishActivityInputSchema, { ...supportInput(), decisionSummary: 'x'.repeat(301) }));
  test('accepts the committed result', () => accepts(PublishActivityOutputSchema, { activity: invitationActivity(), newRevision: 2, eventSeq: 9, notificationId: 'notif_1' }));
  test('rejects an activity with three helpers', () => rejects(PublishActivityOutputSchema, { activity: { ...supportActivity(), helperCount: 3 }, newRevision: 8, eventSeq: 20, notificationId: null }));
  test('rejects an activity without its secondary label field', () => {
    const { secondaryLabel: _missing, ...activity } = invitationActivity();
    rejects(ActivitySchema, activity);
  });
});

describe('tool assess_attempt', () => {
  test('accepts each criterion', () => {
    for (const criterion of ['initial', 'support', 'independent']) accepts(AssessAttemptInputSchema, { attemptId: `${RUN_ID}_initial`, criterion });
  });
  test('rejects an unknown criterion', () => rejects(AssessAttemptInputSchema, { attemptId: `${RUN_ID}_initial`, criterion: 'final' }));
  test('accepts an educational failure as a result', () => accepts(AssessAttemptOutputSchema, assessment()));
  test('rejects more than 20 hints and a non-pending retention', () => {
    rejects(AssessAttemptOutputSchema, { ...assessment(), hints: 21 });
    rejects(AssessAttemptOutputSchema, { ...assessment(), retention: 'retained' });
  });
});

describe('tool commit_episode', () => {
  test('accepts a commit with and without a support attempt', () => {
    accepts(CommitEpisodeInputSchema, { independentAttemptId: `${RUN_ID}_independent`, supportAttemptId: `${RUN_ID}_support`, expectedRevision: 11 });
    accepts(CommitEpisodeInputSchema, { independentAttemptId: `${RUN_ID}_independent`, supportAttemptId: null, expectedRevision: 11 });
  });
  test('rejects a missing support attempt field', () => rejects(CommitEpisodeInputSchema, { independentAttemptId: `${RUN_ID}_independent`, expectedRevision: 11 }));
  test('rejects a model-supplied outcome', () => rejects(CommitEpisodeInputSchema, { independentAttemptId: `${RUN_ID}_independent`, supportAttemptId: null, expectedRevision: 11, outcome: 'independent' }));
  test('accepts the committed episode', () => accepts(CommitEpisodeOutputSchema, commitOutput()));
  test('rejects an outcome outside the vocabulary', () => rejects(CommitEpisodeOutputSchema, { ...commitOutput(), outcome: 'passed' }));
});

describe('tool calls and results', () => {
  test('every tool has input and output schemas', () => assert.deepEqual(Object.keys(TOOL_SCHEMAS).sort(), [...ToolNameSchema.options].sort()));
  test('accepts a call by name with its arguments', () => accepts(ToolCallSchema, { name: 'search_learning_cases', arguments: searchInput() }));
  test('rejects a tool outside the five', () => rejects(ToolCallSchema, { name: 'record_learning_evidence', arguments: {} }));
  test('rejects arguments for the wrong tool', () => rejects(ToolCallSchema, { name: 'assess_attempt', arguments: searchInput() }));
  test('accepts a success for every tool', () => {
    accepts(ToolResultSchema, { ok: true, tool: 'get_personal_memory', data: memoryOutput() });
    accepts(ToolResultSchema, { ok: true, tool: 'search_learning_cases', data: { contextCommit: contextCommit(), search: filmSearch(), publicationContext: { expectedRevision: 7, activityContext: supportContext() } } });
    accepts(ToolResultSchema, { ok: true, tool: 'publish_activity', data: { activity: supportActivity(), newRevision: 8, eventSeq: 20, notificationId: null } });
    accepts(ToolResultSchema, { ok: true, tool: 'assess_attempt', data: assessment() });
    accepts(ToolResultSchema, { ok: true, tool: 'commit_episode', data: commitOutput() });
  });
  test('accepts a search failure that keeps its context commit', () => accepts(ToolResultSchema, { ok: false, tool: 'search_learning_cases', error: { code: 'SEARCH_FAILED', message: 'Search failed', retryable: true }, contextCommit: contextCommit() }));
  test('rejects data that belongs to another tool', () => rejects(ToolResultSchema, { ok: true, tool: 'commit_episode', data: assessment() }));
  test('rejects a failure without its contextCommit field', () => rejects(ToolResultSchema, { ok: false, tool: 'assess_attempt', error: { code: 'NOT_FOUND', message: 'Unknown attempt', retryable: false } }));
  test('accepts the final phase result and rejects extra fields', () => {
    const result = { phase: 'explanation', status: 'completed', activityId: `${RUN_ID}_support_1`, caseId: null, evidenceIds: ['hist_102_0'], summary: 'Published the make-ten support.' };
    accepts(PhaseResultSchema, result);
    rejects(PhaseResultSchema, { ...result, reasoning: 'hidden' });
  });
});

describe('activity spec primer-math-v1.1', () => {
  test('accepts the four film fixtures', () => {
    for (const spec of [supportSpec(), independentSpec(), lineSpec(), independentLineSpec()]) accepts(ActivitySpecSchema, spec);
  });
  test('accepts every allowed appearance', () => {
    for (const appearance of ['apple', 'dot', 'pear']) {
      const spec = supportSpec();
      accepts(ActivitySpecSchema, { ...spec, components: [{ ...spec.components[0], props: { first: 8, second: 5, appearance, highlightEmptySlots: false, showEquation: false } }] });
    }
  });
  test('rejects an older catalog version', () => rejects(ActivitySpecSchema, { ...supportSpec(), catalogVersion: 'primer-math-v1' }));
  test('rejects unknown components, props and root fields', () => {
    rejects(ActivitySpecSchema, { ...supportSpec(), components: [{ id: 'html', type: 'Html', props: {} }] });
    rejects(ActivitySpecSchema, { ...lineSpec(), components: [{ id: 'line', type: 'NumberLine', props: { start: 8, addend: 5, label: 'Count!' } }] });
    rejects(ActivitySpecSchema, { ...supportSpec(), title: 'Fill the box' });
  });
  test('rejects more than three components', () => rejects(ActivitySpecSchema, { ...lineSpec(), components: [...lineSpec().components, { id: 'extra', type: 'JumpCounter', props: { targetId: 'line' } }] }));
  test('rejects an unsupported appearance and an out-of-range operand', () => {
    rejects(ActivitySpecSchema, { ...supportSpec(), components: [{ id: 'box', type: 'MakeTenWorkspace', props: { first: 8, second: 5, appearance: 'banana', highlightEmptySlots: true, showEquation: true } }] });
    rejects(ActivitySpecSchema, { ...supportSpec(), components: [{ id: 'box', type: 'MakeTenWorkspace', props: { first: 8, second: 1, appearance: 'apple', highlightEmptySlots: true, showEquation: true } }] });
  });
  test('rejects identifiers that are not plain IDs', () => rejects(ActivitySpecSchema, { ...supportSpec(), evidenceIds: ['<script>'] }));
  test('rejects more than five evidence IDs', () => rejects(ActivitySpecSchema, { ...supportSpec(), evidenceIds: ['a', 'b', 'c', 'd', 'e', 'f'] }));
});

describe('events', () => {
  test('there is one sample payload for every event type', () => assert.deepEqual(Object.keys(SAMPLE_PAYLOADS).sort(), [...EVENT_TYPES].sort()));
  test('the event union has exactly 26 types', () => assert.equal(EVENT_TYPES.length, 26));
  for (const type of EVENT_TYPES) {
    test(`accepts ${type}`, () => accepts(EventSchema, sampleEvent(type)));
    test(`rejects ${type} with an unexpected payload field`, () => rejects(EventSchema, { ...sampleEvent(type), payload: { ...SAMPLE_PAYLOADS[type], unexpected: true } }));
  }
  for (const type of EVENT_TYPES) {
    test(`rejects ${type} without its first required field`, () => {
      const [firstKey] = Object.keys(SAMPLE_PAYLOADS[type]);
      const payload: Record<string, unknown> = { ...SAMPLE_PAYLOADS[type] };
      delete payload[firstKey ?? ''];
      rejects(EventSchema, { ...sampleEvent(type), payload });
    });
  }
  test('rejects an unknown event type', () => rejects(EventSchema, { ...sampleEvent('state.committed'), type: 'search.progress' }));
  test('rejects seq 0 and a missing timestamp', () => {
    rejects(EventSchema, sampleEvent('state.committed', 0));
    const { at: _missing, ...event } = sampleEvent('state.committed');
    rejects(EventSchema, event);
  });
  test('rejects search.completed with more than 20 detailed candidates', () => rejects(EventSchema, { ...sampleEvent('search.completed'), payload: { ...filmSearch(), candidates: Array.from({ length: 21 }, () => filmSearch().candidates[0]) } }));
  test('rejects tool.completed carrying a failure or another tool\'s result', () => {
    rejects(EventSchema, { ...sampleEvent('tool.completed'), payload: { ...SAMPLE_PAYLOADS['tool.completed'], result: { ok: false, tool: 'search_learning_cases', error: { code: 'SEARCH_FAILED', message: 'Search failed', retryable: true }, contextCommit: null } } });
    rejects(EventSchema, { ...sampleEvent('tool.completed'), payload: { ...SAMPLE_PAYLOADS['tool.completed'], name: 'assess_attempt' } });
  });
  test('rejects voice.delegated without a real Live session', () => rejects(EventSchema, { ...sampleEvent('voice.delegated'), payload: { ...SAMPLE_PAYLOADS['voice.delegated'], liveSessionId: null } }));
});

describe('records', () => {
  const ids = { runId: RUN_ID, liveSessionId: null, delegationId: null, operationId: 'op_1', explanationRevision: 0, cancellationEpoch: 0, threadId: 'thr_1', turnId: null };
  test('accepts typed-only correlation without a Live session', () => accepts(CorrelationIdsSchema, ids));
  test('rejects a delegation without a Live session', () => rejects(CorrelationIdsSchema, { ...ids, delegationId: 'del_1' }));
  test('accepts a voice operation and rejects an unknown status', () => {
    accepts(VoiceOperationSchema, { ...ids, liveSessionId: 'live_1', delegationId: 'del_1', status: 'steered' });
    rejects(VoiceOperationSchema, { ...ids, status: 'paused' });
  });
  const outbox = { notificationId: 'notif_1', runId: RUN_ID, activityId: `${RUN_ID}_invitation`, activityRevision: 2, transport: 'simulator', status: 'pending', attemptCount: 0, createdAt: AT, lastErrorCode: null };
  test('accepts a pending simulator outbox row', () => accepts(NotificationOutboxSchema, outbox));
  test('rejects an APNs transport', () => rejects(NotificationOutboxSchema, { ...outbox, transport: 'apns' }));
  const push = { aps: { alert: { title: NOTIFICATION_COPY.title, body: NOTIFICATION_COPY.body }, sound: 'default' }, notificationId: 'notif_1', runId: RUN_ID, activityId: `${RUN_ID}_invitation`, activityRevision: 2 };
  test('accepts the opaque simulator push payload', () => accepts(NotificationPayloadSchema, push));
  test('rejects learning content or an oversized push payload', () => {
    rejects(NotificationPayloadSchema, { ...push, transcript: 'Today we put two groups together.' });
    rejects(NotificationPayloadSchema, { ...push, notificationId: 'n'.repeat(180), runId: 'r'.repeat(180), activityId: 'a'.repeat(180), aps: { ...push.aps, alert: { title: 't'.repeat(2000), body: 'b'.repeat(2000) } } });
  });
  test('keeps lesson problems and the selected pair together', () => {
    accepts(RunSelectionSchema, { seed: 0, lessonProblems: null, selectedProblems: null });
    rejects(RunSelectionSchema, { seed: 0, lessonProblems: null, selectedProblems: { initial: { lhs: 8, rhs: 5 }, independent: { lhs: 9, rhs: 4 } } });
    rejects(RunSelectionSchema, { seed: 2 ** 32, lessonProblems: null, selectedProblems: null });
  });
});

describe('run phases and commands', () => {
  test('every phase has a transition entry and terminal phases have none', () => {
    assert.deepEqual(Object.keys(PHASE_TRANSITIONS).sort(), [...RunPhaseSchema.options].sort());
    for (const phase of ['NO_MATCH', 'ALREADY_CORRECT', 'OUT_OF_SCOPE', 'COMPLETE', 'ERROR'] as const) assert.deepEqual(PHASE_TRANSITIONS[phase], []);
  });
  test('the film path follows allowed transitions', () => {
    const path = ['WAITING', 'INGESTING', 'INVITED', 'INITIAL', 'EXPLAIN', 'PROCESSING', 'PRACTICE', 'VERIFY', 'COMPLETE'] as const;
    for (let i = 1; i < path.length; i++) assert.ok(PHASE_TRANSITIONS[path[i - 1]!].includes(path[i]!), `${path[i - 1]} -> ${path[i]}`);
  });
  test('every phase that accepts a learning command can move on', () => {
    for (const [type, phases] of Object.entries(COMMAND_PHASES)) {
      if (type === 'stop_learning') continue;
      for (const phase of phases) assert.ok(PHASE_TRANSITIONS[phase].length > 0, `${type} in ${phase} has no transition`);
    }
  });
  test('only explain corrects work in progress', () => {
    assert.ok(COMMAND_PHASES.explain.includes('PROCESSING'));
    assert.ok(!COMMAND_PHASES.practice.includes('PROCESSING'));
  });
  test('every template maps to one activity kind', () => assert.deepEqual(Object.keys(TEMPLATE_KIND).sort(), [...TemplateIdSchema.options].sort()));
  const base = { commandId: COMMAND_ID, revision: 3 };
  test('accepts every learning command', () => {
    for (const command of [
      { ...base, type: 'accept' },
      { ...base, type: 'attempt', attempt: { start: 8, moves: [9, 10, 11, 12], answer: 12, hints: 0 } },
      { ...base, type: 'explain', text: 'I counted eight, nine, ten, eleven, twelve.' },
      { ...base, type: 'practice', attempt: { placements: [{ objectId: 't0', to: 'ten_frame' }, { objectId: 't1', to: 'ten_frame' }], answer: 13, hints: 2 } },
      { ...base, type: 'verify', attempt: { start: 9, moves: [10, 11, 12, 13], answer: 13, hints: 0 } },
      { ...base, type: 'stop_learning' },
    ]) accepts(CommandSchema, command);
  });
  test('rejects blank or overlong explanations', () => {
    rejects(CommandSchema, { ...base, type: 'explain', text: '   ' });
    rejects(CommandSchema, { ...base, type: 'explain', text: 'x'.repeat(601) });
  });
  test('rejects a make-ten attempt as the initial number-line attempt', () => rejects(CommandSchema, { ...base, type: 'attempt', attempt: { placements: [], answer: 13, hints: 0 } }));
  test('rejects unknown commands, bad IDs and extra fields', () => {
    rejects(CommandSchema, { ...base, type: 'retry_tool' });
    rejects(CommandSchema, { ...base, commandId: 'not-a-uuid', type: 'accept' });
    rejects(CommandSchema, { ...base, type: 'accept', attemptId: 'x' });
  });
});

describe('routes', () => {
  const requests: { readonly [R in RouteName]: { ok: unknown; bad: unknown } | null } = {
    bootstrap: null,
    createRun: { ok: { seed: 20261109 }, bad: { seed: -1 } },
    getRun: null,
    runEvents: null,
    runCommand: { ok: { commandId: COMMAND_ID, revision: 2, type: 'accept' }, bad: { commandId: COMMAND_ID, revision: -1, type: 'accept' } },
    getLesson: null,
    saveLesson: { ok: { text: '[00:00] Ms. Ortiz: Today we put two groups together.' }, bad: { text: 'é'.repeat(LESSON_TEXT_MAX_BYTES / 2 + 1) } },
    createVoiceSession: { ok: { commandId: COMMAND_ID, expectedRevision: 9, sdpOffer: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1' }, bad: { commandId: COMMAND_ID, expectedRevision: 9, sdpOffer: 'hello' } },
    voiceSnapshot: null,
    notificationOpened: { ok: { commandId: COMMAND_ID, activityId: `${RUN_ID}_invitation`, activityRevision: 2 }, bad: { commandId: COMMAND_ID, activityId: `${RUN_ID}_invitation`, activityRevision: 2, url: 'https://example.com' } },
    voiceCommand: { ok: { type: 'activity_rendered', commandId: COMMAND_ID, voiceSessionId: null, expectedRunRevision: 8, activityId: `${RUN_ID}_support_1`, activityRevision: 8, specHash: 'b5d4c3a2' }, bad: { type: 'activity_rendered', commandId: COMMAND_ID, voiceSessionId: null, expectedRunRevision: 8, activityId: `${RUN_ID}_support_1`, activityRevision: 8 } },
  };
  const voiceSnapshot = { voiceSessionId: 'live_1', status: 'live', activeOperationId: null, explanationRevision: 1, cancellationEpoch: 0, audioGate: 'open' };
  const responses: { readonly [R in RouteName]: { ok: unknown; bad: unknown } } = {
    bootstrap: { ok: { nonce: 'n0nce', voice: 'missing_key', inputMode: 'typed', runtime: 'Codex App Server', database: 'Neo4j', dataset: 'synthetic v7' }, bad: { nonce: 'n0nce', voice: 'ready', inputMode: 'typed', runtime: 'Codex App Server', database: 'Neo4j', dataset: 'synthetic v7' } },
    createRun: { ok: snapshot(), bad: { ...snapshot(), seq: 3 } },
    getRun: { ok: snapshot(), bad: { ...snapshot(), phase: 'CANCELLED' } },
    runEvents: { ok: [sampleEvent('state.committed', 3), sampleEvent('search.completed', 4)], bad: [{ ...sampleEvent('state.committed', 3), type: 'state.changed' }] },
    runCommand: { ok: snapshot(), bad: { ...snapshot(), stopped: undefined } },
    notificationOpened: { ok: snapshot(), bad: { ...snapshot(), execution: { throughSeq: 2, events: [sampleEvent('state.committed', 1), { ...sampleEvent('activity.published', 2), runId: 'another-run' }] } } },
    getLesson: { ok: { inboxFile: `/tmp/inbox/${RUN_ID}.txt`, saved: true, contentHash: '0ccc0c36', prepared: null }, bad: { inboxFile: `/tmp/inbox/${RUN_ID}.txt`, saved: true, contentHash: null, prepared: null } },
    saveLesson: { ok: { saved: true, contentHash: '0ccc0c36' }, bad: { saved: false, contentHash: '0ccc0c36' } },
    createVoiceSession: { ok: { voiceSessionId: 'live_1', sdpAnswer: 'v=0\r\n', status: 'live' }, bad: { voiceSessionId: 'live_1', sdpAnswer: 'v=0\r\n', status: 'live', apiKey: 'leaked' } },
    voiceSnapshot: { ok: voiceSnapshot, bad: { ...voiceSnapshot, audioGate: 'muted' } },
    voiceCommand: { ok: voiceSnapshot, bad: { voiceSessionId: 'live_1' } },
  };
  for (const name of Object.keys(ROUTES) as RouteName[]) {
    const route = ROUTES[name];
    const request = requests[name];
    test(`${route.method} ${route.path} validates its request`, () => {
      if (request === null) return assert.equal(route.request, null);
      assert.ok(route.request);
      accepts(route.request, request.ok);
      rejects(route.request, request.bad);
    });
    test(`${route.method} ${route.path} validates its response`, () => {
      accepts(route.response, responses[name].ok);
      rejects(route.response, responses[name].bad);
    });
  }
  test('polling cursors are non-negative safe integers', () => {
    assert.equal(EventsQuerySchema.parse({ after: '12' }).after, 12);
    for (const after of ['', '-1', '1.5', '012', 'abc', '9007199254740992']) rejects(EventsQuerySchema, { after });
  });
  test('accepts every voice command and rejects closing without a session', () => {
    const base = { commandId: COMMAND_ID, expectedRunRevision: 8 };
    accepts(VoiceCommandSchema, { ...base, type: 'close_voice', voiceSessionId: 'live_1' });
    accepts(VoiceCommandSchema, { ...base, type: 'audio_gate_closed', voiceSessionId: 'live_1' });
    accepts(VoiceCommandSchema, { ...base, type: 'typed_correction', voiceSessionId: null, text: 'I missed one tap.' });
    rejects(VoiceCommandSchema, { ...base, type: 'close_voice', voiceSessionId: null });
    rejects(VoiceCommandSchema, { ...base, type: 'typed_correction', voiceSessionId: null, text: '' });
  });
  test('unknown runs are 404, conflicts and stale revisions 409, impossible traces 422', () => {
    assert.equal(ERROR_HTTP_STATUS.NOT_FOUND, 404);
    assert.equal(ERROR_HTTP_STATUS.CONFLICT, 409);
    assert.equal(ERROR_HTTP_STATUS.STALE_REVISION, 409);
    assert.equal(ERROR_HTTP_STATUS.WRONG_PHASE, 409);
    assert.equal(ERROR_HTTP_STATUS.VALIDATION_FAILED, 422);
    for (const name of ['getRun', 'runCommand'] as const) assert.ok((ROUTES[name].errors as readonly number[]).includes(404));
    for (const status of [409, 422]) assert.ok((ROUTES.runCommand.errors as readonly number[]).includes(status));
  });
  test('a 409 body carries the current revision', () => {
    accepts(HttpErrorSchema, { code: 'STALE_REVISION', message: 'Stale revision', retryable: false, revision: 4 });
    rejects(HttpErrorSchema, { code: 'STALE_REVISION', message: 'Stale revision', retryable: false });
    accepts(HttpErrorSchema, { code: 'NOT_FOUND', message: 'Run not found', retryable: false });
  });
  test('builds concrete paths with an encoded run ID', () => {
    assert.equal(routePath('runEvents', { runId: RUN_ID }), `/api/runs/${RUN_ID}/events`);
    assert.equal(routePath('createRun'), '/api/runs');
    assert.throws(() => routePath('getRun'), /needs a runId/);
    assert.equal(routePath('notificationOpened', { runId: RUN_ID, notificationId: 'notif 1' }), `/api/runs/${RUN_ID}/notifications/notif%201/opened`);
    assert.throws(() => routePath('notificationOpened', { runId: RUN_ID }), /needs a notificationId/);
  });
});

describe('copy', () => {
  test('the invitation copy is exact', () => {
    assert.equal(INVITATION_COPY.title, 'A little challenge for you');
    assert.equal(INVITATION_COPY.bodyLinkedConcept, 'Remember taking things away in subtraction? Today, let’s put things together with addition. Want to try?');
    assert.equal(INVITATION_COPY.bodySameConcept, 'We’ve tried this before. Want to explore it some more?');
  });
  test('activity copy uses the activity numbers', () => {
    assert.equal(ACTIVITY_COPY.initial_number_line({ lhs: 8, rhs: 5 }).title, 'Show 8 + 5 on the number line.');
    assert.equal(ACTIVITY_COPY.anchor_start_number_line({ lhs: 6, rhs: 7 }).title, '6 is the starting point. Count once each time you move.');
    assert.equal(ACTIVITY_COPY.independent_number_line({ lhs: 9, rhs: 4 }).body, 'Show 9 + 4. Mark where you start, then show your moves.');
    assert.equal(STUDENT_COPY.howDidYouGet(12), 'How did you get 12?');
    assert.equal(problemQuestion({ lhs: 9, rhs: 4 }), '9 + 4 = ?');
  });
  test('every non-invitation template has copy that fits an activity', () => {
    for (const template of TemplateIdSchema.options) {
      if (template === 'invitation_addition') continue;
      const copy = ACTIVITY_COPY[template]({ lhs: 19, rhs: 10 });
      accepts(ActivitySchema, { ...supportActivity(), templateId: template, kind: TEMPLATE_KIND[template], ...copy });
    }
  });
  test('the recording clock counts minutes and seconds', () => {
    assert.equal(LESSON_NOTES_COPY.recordingStatus(65), 'Recording 01:05');
    assert.equal(LESSON_NOTES_COPY.stoppedStatus(125), 'Stopped · 02:05');
  });
  test('the notification names no learning detail', () => assert.equal(NOTIFICATION_COPY.body, 'A quick challenge from today\'s lesson?'));
});
