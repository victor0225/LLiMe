import type { Meta, StoryObj } from '@storybook/react-vite';
import type { Activity, SearchResult, ToolSuccess } from '@core/domain';
import { type EVENT_PAYLOAD_SCHEMAS, EventSchema, type EventType, type RunEvent } from '@core/events';
import type { z } from 'zod';
import { InspectorPage, InspectorView, type SelectedCall, parseExecutionEvents } from '../web/backend/Inspector';

// Every trace below is a fixture: events built for these stories and parsed by the shared event
// schema. The inspector labels them "Fixture"; none is presented as a run.

export const FIXTURE_RUN_ID = 'run_fixture_01';
const THREAD = 'thr_fixture_01';
const TURN = 'turn_fixture_01';

type Draft = { [T in EventType]: { type: T; payload: z.input<(typeof EVENT_PAYLOAD_SCHEMAS)[T]> } }[EventType];

export function buildTrace(drafts: readonly Draft[], runId = FIXTURE_RUN_ID): RunEvent[] {
  return drafts.map((draft, index) =>
    EventSchema.parse({ runId, seq: index + 1, type: draft.type, payload: draft.payload, at: new Date(Date.UTC(2026, 10, 9, 10, 0, index)).toISOString() }),
  );
}

const ref = (callId: string, over: Partial<{ itemId: string | null; serverRequestId: string | number | null; attempt: number }> = {}) => ({
  threadId: THREAD,
  turnId: TURN,
  callId,
  itemId: `item_${callId}`,
  serverRequestId: 7,
  attempt: 1,
  ...over,
});

const memoryResult = (): ToolSuccess =>
  ({
    ok: true,
    tool: 'get_personal_memory',
    data: {
      memorySnapshotId: 'mem_fixture_01',
      studentId: 'student_7',
      corpusHash: 'corpus_fixture',
      cases: [{ caseId: 'seed_7_0', concept: 'subtraction_within_20', strategy: 'make_ten', outcome: 'assisted', retention: 'pending', nodeIds: ['seed_7_0:attempt'] }],
      summaries: [
        { conceptId: 'addition_within_20', link: 'today', total: 0, independent: 0, assisted: 0, failed: 0, notAssessed: 0, firstAt: null, lastAt: null },
        { conceptId: 'subtraction_within_20', link: 'similar', total: 18, independent: 9, assisted: 5, failed: 2, notAssessed: 2, firstAt: '2026-09-07T09:00:00.000Z', lastAt: '2026-10-30T09:00:00.000Z' },
      ],
      unassessedConceptIds: [],
    },
  });

const invitation = (): Activity =>
  ({
    id: `${FIXTURE_RUN_ID}_invitation`,
    revision: 2,
    runId: FIXTURE_RUN_ID,
    kind: 'invitation',
    templateId: 'invitation_addition',
    strategy: null,
    problem: null,
    title: 'A little challenge for you',
    body: 'We’ve tried this before. Want to explore it some more?',
    primaryLabel: 'Let’s try',
    secondaryLabel: 'Later',
    activitySpec: null,
    specHash: null,
    helperCount: 0,
    evidenceIds: ['seed_7_0'],
    decisionSummary: 'Earlier subtraction needed help (seed_7_0); a short check finds out whether addition does too.',
  });

const search = (basis: 'default' | 'policy' | 'evidence'): SearchResult =>
  ({
    matchingVersion: 'typed-path-v1',
    corpusHash: 'corpus_fixture',
    queryId: 'query_fixture_01',
    candidateCount: 659,
    rankingHash: 'ranking_fixture',
    candidates: [],
    decision: {
      strategy: basis === 'evidence' ? 'make_ten' : 'anchor_start',
      templateId: basis === 'evidence' ? 'make_ten_blocks' : 'anchor_start_number_line',
      basis,
      evidenceIds: basis === 'evidence' ? ['hist_102_0'] : [],
      reason: basis === 'default' ? 'No comparable case was close enough, so the default for this hypothesis applies.' : 'A comparable case reached an independent result.',
      groups: basis === 'evidence' ? [{ strategy: 'make_ten', independent: 3, total: 4 }] : [],
    },
    scores: [],
    admitted: [],
  });

const lesson: Draft = { type: 'lesson.detected', payload: { contentHash: '0ccc0c36', source: 'local_file', bytes: 2293 } };
const boundary: Draft = {
  type: 'runtime.boundary',
  payload: { disabledFeatures: ['shell_tool'], webSearch: 'disabled', configuredMcpCount: 1, disabledMcpCount: 1, enabledMcpTools: 0, selectedCapabilityRoots: 0, environments: 0, sandbox: 'read-only', scope: 'verified model-facing feature flags' },
};
const task: Draft = {
  type: 'runtime.input',
  payload: { threadId: THREAD, model: 'gpt-6.1-terra', serviceTier: null, phase: 'ingestion', promptHash: 'prompt_fixture', instructions: 'PHASE: ingestion. Read the lesson, read memory, publish one invitation.', input: { lessonBytes: 2293 } },
};
const item = (id: string, type: string, lifecycle: 'started' | 'completed', tool: string | null = null): Draft => ({ type: 'runtime.item', payload: { threadId: THREAD, turnId: TURN, id, type, lifecycle, tool } });
const message = (itemId: string, text: string, partial = false): Draft => ({ type: 'runtime.message', payload: { threadId: THREAD, turnId: TURN, itemId, text, partial } });
const completed = (status = 'completed'): Draft => ({ type: 'runtime.completed', payload: { threadId: THREAD, turnId: TURN, status } });

// Memory read acknowledged by the runtime; the invitation saved but its acknowledgement not yet seen.
const memoryAndPublishDrafts = (): Draft[] => [
  lesson,
  boundary,
  task,
  item('item_call_memory', 'dynamicToolCall', 'started', 'get_personal_memory'),
  { type: 'tool.started', payload: { ...ref('call_memory'), name: 'get_personal_memory', arguments: { conceptIds: ['addition_within_20', 'subtraction_within_20'], includeUnassessed: true } } },
  { type: 'tool.completed', payload: { ...ref('call_memory'), name: 'get_personal_memory', result: memoryResult(), elapsedMs: 42 } },
  item('item_call_memory', 'dynamicToolCall', 'completed', 'get_personal_memory'),
  { type: 'tool.started', payload: { ...ref('call_publish', { serverRequestId: 8 }), name: 'publish_activity', arguments: { kind: 'invitation', templateId: 'invitation_addition', evidenceIds: ['seed_7_0'] } } },
  {
    type: 'tool.completed',
    payload: {
      ...ref('call_publish', { serverRequestId: 8 }),
      name: 'publish_activity',
      result: { ok: true, tool: 'publish_activity', data: { activity: invitation(), newRevision: 2, eventSeq: 9, notificationId: null } },
      elapsedMs: 77,
    },
  },
  { type: 'activity.published', payload: { activity: invitation() } },
];

function record(call: SelectedCall) {
  (window as unknown as { __handoff?: SelectedCall }).__handoff = call;
}

type ViewProps = Parameters<typeof InspectorView>[0];
const baseProps = (events: readonly RunEvent[], over: Partial<ViewProps> = {}): ViewProps => ({
  runId: FIXTURE_RUN_ID,
  studentId: 'student_7',
  runtimeName: 'Codex App Server (fixture)',
  source: 'fixture',
  feedStatus: 'live',
  lastSeq: events.at(-1)?.seq ?? 0,
  events,
  onViewEvidence: record,
  ...over,
});

const meta = {
  title: 'Backend/Codex Execution Inspector',
  component: InspectorView,
  parameters: { layout: 'fullscreen' },
  excludeStories: /^(FIXTURE_RUN_ID|buildTrace)$/,
} satisfies Meta<typeof InspectorView>;
export default meta;
type Story = StoryObj<typeof meta>;

const story = (props: ViewProps): Story => ({ args: props });

export const MemoryAndPublish = story(baseProps(buildTrace(memoryAndPublishDrafts())));

export const NoEvents = story(baseProps([], { feedStatus: 'loading' }));

export const WaitingForResult = story(
  baseProps(buildTrace([task, { type: 'tool.started', payload: { ...ref('call_search'), name: 'search_learning_cases', arguments: { explanationRevision: 1, needsClarification: false } } }])),
);

export const FailedAndRetried = story(
  baseProps(
    buildTrace([
      task,
      { type: 'tool.started', payload: { ...ref('call_publish'), name: 'publish_activity', arguments: { kind: 'support', templateId: 'make_ten_blocks' } } },
      { type: 'tool.failed', payload: { ...ref('call_publish'), name: 'publish_activity', error: { code: 'VALIDATION_FAILED', message: 'The template is not allowed for this decision.', retryable: true }, contextCommit: null, elapsedMs: 12 } },
      { type: 'operation.started', payload: { operationId: 'op_retry', phase: 'explanation', explanationRevision: 1, cancellationEpoch: 0 } },
      { type: 'tool.started', payload: { ...ref('call_publish', { attempt: 2 }), name: 'publish_activity', arguments: { kind: 'support', templateId: 'anchor_start_number_line' } } },
      {
        type: 'tool.completed',
        payload: {
          ...ref('call_publish', { attempt: 2 }),
          name: 'publish_activity',
          result: { ok: true, tool: 'publish_activity', data: { activity: invitation(), newRevision: 3, eventSeq: 12, notificationId: null } },
          elapsedMs: 31,
        },
      },
    ]),
  ),
);

export const SteeredAndCancelled = story(
  baseProps(
    buildTrace([
      { type: 'operation.started', payload: { operationId: 'op_first', phase: 'explanation', explanationRevision: 1, cancellationEpoch: 0 } },
      task,
      { type: 'tool.started', payload: { ...ref('call_search'), name: 'search_learning_cases', arguments: { explanationRevision: 1 } } },
      { type: 'turn.steered', payload: { threadId: THREAD, expectedTurnId: TURN, operationId: 'op_first', explanationRevision: 2, cancellationEpoch: 0 } },
      { type: 'operation.cancelled', payload: { operationId: 'op_first', reason: 'superseded', explanationRevision: 2, cancellationEpoch: 1 } },
    ]),
  ),
);

export const MissingIds = story(
  baseProps(
    buildTrace([
      { type: 'tool.started', payload: { ...ref('call_memory', { itemId: null, serverRequestId: null }), name: 'get_personal_memory', arguments: { conceptIds: ['addition_within_20'], includeUnassessed: false } } },
      { type: 'tool.completed', payload: { ...ref('call_memory', { itemId: null, serverRequestId: null }), name: 'get_personal_memory', result: memoryResult(), elapsedMs: 5 } },
    ]),
    { runId: null, studentId: null, runtimeName: null },
  ),
);

export const TransportRequestId = story(
  baseProps(
    buildTrace([
      { type: 'tool.started', payload: { ...ref('call_memory', { serverRequestId: 'rpc-request-91' }), name: 'get_personal_memory', arguments: { conceptIds: ['addition_within_20'], includeUnassessed: false } } },
    ]),
  ),
);

// Unreadable events, reasoning items and secret-looking fields, as the browser might receive them.
const unsafeRaw: unknown[] = [
  ...buildTrace([
    { type: 'runtime.input', payload: { threadId: THREAD, model: 'gpt-6.1-terra', serviceTier: null, phase: 'ingestion', promptHash: 'p', instructions: 'Read /Users/sunho/LLiMe/lesson.txt with Authorization: Bearer abcdefgh12345678', input: {} } },
    item('item_reasoning', 'reasoning', 'started'),
    {
      type: 'tool.started',
      payload: {
        ...ref('call_memory'),
        name: 'get_personal_memory',
        arguments: { apiKey: 'sk-live-abcdefghijklmnop1234', authorization: 'Bearer abcdefgh12345678', path: '/Users/sunho/LLiMe/data/seed.json', reasoning: 'hidden thought text', email: 'child@example.com' },
      },
    },
  ]),
  { runId: FIXTURE_RUN_ID, seq: 4, type: 'reasoning.delta', payload: { text: 'secret chain of thought' }, at: '2026-11-09T10:00:03.000Z' },
];
const unsafe = parseExecutionEvents(unsafeRaw);
export const UnsafePayloads = story(baseProps(unsafe.events, { rejectedCount: unsafe.rejectedCount }));

export const OutputOverLimit = story(
  baseProps(buildTrace([task, message('item_out', 'a'.repeat(9000), true), message('item_out', 'b'.repeat(9000), true), { type: 'operation.failed', payload: { operationId: null, code: 'VALIDATION_FAILED', message: 'Output limit exceeded.' } }])),
);

export const NotificationTransport = story(
  baseProps(
    buildTrace([
      { type: 'notification.queued', payload: { notificationId: 'note_1', runId: FIXTURE_RUN_ID, activityId: 'act_1', activityRevision: 2 } },
      { type: 'notification.sent', payload: { notificationId: 'note_1', runId: FIXTURE_RUN_ID, activityId: 'act_1', activityRevision: 2 } },
    ]),
  ),
);

export const DefaultDecision = story(baseProps(buildTrace([{ type: 'search.completed', payload: search('default') }])));

export const EvidenceDecision = story(baseProps(buildTrace([{ type: 'search.completed', payload: search('evidence') }])));

export const FinalFailure = story(
  baseProps(
    buildTrace([
      task,
      { type: 'tool.started', payload: { ...ref('call_search'), name: 'search_learning_cases', arguments: {} } },
      { type: 'tool.failed', payload: { ...ref('call_search'), name: 'search_learning_cases', error: { code: 'SEARCH_FAILED', message: 'The search could not finish.', retryable: false }, contextCommit: null, elapsedMs: 8 } },
      { type: 'operation.failed', payload: { operationId: 'op_1', code: 'SEARCH_FAILED', message: 'The search could not finish.' } },
    ]),
    {
      onStartNewRun: () => {
        (window as unknown as { __newRun?: number }).__newRun = ((window as unknown as { __newRun?: number }).__newRun ?? 0) + 1;
      },
    },
  ),
);

// Reads the live polling routes of the running app; the browser tests answer them.
export const LiveRoute: StoryObj = {
  render: () => (
    <InspectorPage
      runId="run_live_01"
      onViewEvidence={record}
      onNewRun={(runId) => {
        (window as unknown as { __newRunId?: string }).__newRunId = runId;
      }}
    />
  ),
};
