// Run event envelope, the closed event-type union and the run snapshot. Isomorphic.
// Every event is written in the same transaction as the state change it reports, and `seq` (not the
// clock) orders a run's events.
import { z } from 'zod';
import {
  ActivitySchema,
  CaseSchema,
  ConceptLinkSchema,
  ConceptSchema,
  ContextCommitSchema,
  CorrelationIdsSchema,
  EdgeSchema,
  ErrorBodySchema,
  ErrorCodeSchema,
  IdSchema,
  MATCHING_VERSION,
  MemorySummarySchema,
  NodeSchema,
  OutcomeSchema,
  RunPhaseSchema,
  RunStateSchema,
  SearchResultSchema,
  SourceSchema,
  StrategySchema,
  ToolNameSchema,
  ToolSuccessSchema,
} from './domain.js';

const revisionSchema = z.number().int().min(0);
const nullableId = IdSchema.nullable();

// Output is capped per runtime item; an overflow is shown as partial output and fails the turn.
export const RUNTIME_MESSAGE_MAX_CHARS = 16000;

// Identifies one tool invocation across the runtime and the application. `serverRequestId` is the
// transport request ID exactly as received (string or number), distinct from the runtime callId.
const toolInvocation = {
  threadId: IdSchema,
  turnId: IdSchema,
  callId: IdSchema,
  itemId: nullableId,
  serverRequestId: z.union([z.string(), z.number()]).nullable(),
  // Bounded internal retries are separate attempts of the same call.
  attempt: z.number().int().min(1),
};

export const EVENT_PAYLOAD_SCHEMAS = {
  'state.committed': z.strictObject({
    phase: RunPhaseSchema,
    revision: revisionSchema,
    caseIds: z.array(IdSchema),
  }),
  'lesson.detected': z.strictObject({
    contentHash: z.string(),
    source: z.literal('local_file'),
    bytes: z.number().int().min(1),
  }),
  'memory.retrieved': z.strictObject({
    conceptIds: z.array(ConceptSchema).min(1).max(2),
    caseIds: z.array(IdSchema),
    summaries: z.array(MemorySummarySchema),
    links: z.array(ConceptLinkSchema),
  }),
  'operation.started': z.strictObject({
    operationId: IdSchema,
    phase: z.enum(['ingestion', 'explanation', 'verification']),
    explanationRevision: revisionSchema.nullable(),
    cancellationEpoch: revisionSchema,
  }),
  'graph.updated': z.strictObject({ graph: CaseSchema }),
  // Model-facing restrictions the adapter verified; not a claim of OS-level isolation.
  'runtime.boundary': z.strictObject({
    disabledFeatures: z.array(z.string()),
    webSearch: z.literal('disabled'),
    configuredMcpCount: z.number().int().min(0),
    disabledMcpCount: z.number().int().min(0),
    enabledMcpTools: z.number().int().min(0),
    selectedCapabilityRoots: z.number().int().min(0),
    environments: z.number().int().min(0),
    sandbox: z.literal('read-only'),
    scope: z.string(),
  }),
  // The exact expanded instructions and input submitted for a turn.
  'runtime.input': z.strictObject({
    threadId: IdSchema,
    model: z.string().min(1),
    serviceTier: z.string().min(1).nullable(),
    phase: z.enum(['ingestion', 'explanation', 'verification']),
    promptHash: z.string(),
    instructions: z.string(),
    input: z.unknown(),
  }),
  'runtime.item': z.strictObject({
    threadId: IdSchema,
    turnId: IdSchema,
    id: IdSchema,
    type: z.string().min(1),
    lifecycle: z.enum(['started', 'completed']),
    tool: z.string().nullable(),
  }),
  // name stays a plain string here so an unknown tool request is still recorded before it is rejected.
  'tool.started': z.strictObject({ ...toolInvocation, name: z.string().min(1), arguments: z.unknown() }),
  // Written when the handler's successful result is saved; a failed result is tool.failed.
  'tool.completed': z
    .strictObject({ ...toolInvocation, name: ToolNameSchema, result: ToolSuccessSchema, elapsedMs: z.number().min(0) })
    .refine((p) => p.result.tool === p.name, { message: 'The result belongs to the named tool', path: ['result', 'tool'] }),
  'tool.failed': z.strictObject({ ...toolInvocation, name: z.string().min(1), error: ErrorBodySchema, contextCommit: ContextCommitSchema.nullable(), elapsedMs: z.number().min(0) }),
  'runtime.message': z.strictObject({
    threadId: IdSchema,
    turnId: IdSchema,
    itemId: IdSchema,
    text: z.string().max(RUNTIME_MESSAGE_MAX_CHARS),
    partial: z.boolean(),
  }),
  // status is the runtime's own turn status, recorded as reported.
  'runtime.completed': z.strictObject({ threadId: IdSchema, turnId: IdSchema, status: z.string().min(1) }),
  'search.started': z.strictObject({
    matchingVersion: z.literal(MATCHING_VERSION),
    queryId: IdSchema,
    candidateCount: z.number().int().min(0),
    queryNodeIds: z.array(z.string()),
  }),
  // At most the top candidates in full plus the compact summary; never the full detailed ranking.
  'search.completed': SearchResultSchema,
  'operation.failed': z.strictObject({ operationId: nullableId, code: ErrorCodeSchema, message: z.string().max(300) }),
  // The result layer appended to the context graph: an Intervention and an Outcome, linked from the attempt.
  'outcome.committed': z.strictObject({
    queryId: IdSchema,
    persistedCaseId: IdSchema,
    strategy: StrategySchema,
    outcome: OutcomeSchema,
    saved: z.boolean(),
    nodes: z.array(NodeSchema),
    edges: z.array(EdgeSchema),
    source: SourceSchema,
  }),
  'context.committed': z.strictObject({
    caseId: IdSchema,
    explanationRevision: revisionSchema,
    graph: CaseSchema,
  }),
  'activity.published': z.strictObject({ activity: ActivitySchema }),
  // Transport status only; never a learning-tool card. Failures live on the outbox record.
  'notification.queued': z.strictObject({ notificationId: IdSchema, runId: IdSchema, activityId: IdSchema, activityRevision: revisionSchema }),
  'notification.sent': z.strictObject({ notificationId: IdSchema, runId: IdSchema, activityId: IdSchema, activityRevision: revisionSchema }),
  'notification.opened': z.strictObject({ notificationId: IdSchema, runId: IdSchema, activityId: IdSchema, activityRevision: revisionSchema }),
  // A voice delegation always has both real provider IDs.
  'voice.delegated': z.strictObject({
    ...CorrelationIdsSchema.shape,
    liveSessionId: IdSchema,
    delegationId: IdSchema,
    offsetMs: z.number().int().min(0),
  }),
  // Approved speakable context sent to the Live session after the matching render receipt.
  'voice.commentary': z.strictObject({
    liveSessionId: IdSchema,
    delegationId: nullableId,
    operationId: nullableId,
    activityId: nullableId,
    activityRevision: revisionSchema.nullable(),
    explanationRevision: revisionSchema,
    cancellationEpoch: revisionSchema,
    text: z.string().min(1),
  }),
  'turn.steered': z.strictObject({
    threadId: IdSchema,
    expectedTurnId: IdSchema,
    operationId: IdSchema,
    explanationRevision: revisionSchema,
    cancellationEpoch: revisionSchema,
  }),
  // A newer explanation revision or a stop superseded the operation; its committed history stays.
  'operation.cancelled': z.strictObject({
    operationId: IdSchema,
    reason: z.enum(['superseded', 'stopped']),
    explanationRevision: revisionSchema,
    cancellationEpoch: revisionSchema,
  }),
} as const;

export type EventType = keyof typeof EVENT_PAYLOAD_SCHEMAS;
export const EVENT_TYPES = Object.keys(EVENT_PAYLOAD_SCHEMAS) as EventType[];
export const EventTypeSchema = z.enum(EVENT_TYPES as [EventType, ...EventType[]]);

const envelope = <T extends EventType>(type: T) =>
  z.strictObject({
    runId: IdSchema,
    seq: z.number().int().min(1),
    type: z.literal(type),
    payload: EVENT_PAYLOAD_SCHEMAS[type],
    at: z.iso.datetime(),
  });

export const EventSchema = z.discriminatedUnion('type', [
  envelope('state.committed'),
  envelope('lesson.detected'),
  envelope('memory.retrieved'),
  envelope('operation.started'),
  envelope('graph.updated'),
  envelope('runtime.boundary'),
  envelope('runtime.input'),
  envelope('runtime.item'),
  envelope('tool.started'),
  envelope('tool.completed'),
  envelope('tool.failed'),
  envelope('runtime.message'),
  envelope('runtime.completed'),
  envelope('search.started'),
  envelope('search.completed'),
  envelope('operation.failed'),
  envelope('outcome.committed'),
  envelope('context.committed'),
  envelope('activity.published'),
  envelope('notification.queued'),
  envelope('notification.sent'),
  envelope('notification.opened'),
  envelope('voice.delegated'),
  envelope('voice.commentary'),
  envelope('turn.steered'),
  envelope('operation.cancelled'),
]);
export type RunEvent = z.infer<typeof EventSchema>;
export type RunEventOf<T extends EventType> = Extract<RunEvent, { type: T }>;
export type EventPayload<T extends EventType> = z.infer<(typeof EVENT_PAYLOAD_SCHEMAS)[T]>;

// Saved execution events in seq order through throughSeq, read from the same store snapshot as the run.
export const ExecutionSnapshotSchema = z.strictObject({
  throughSeq: z.number().int().min(0),
  events: z.array(EventSchema),
}).refine((x) => x.events.every((e, i) => e.seq <= x.throughSeq && (i === 0 || e.seq > (x.events[i - 1]?.seq ?? 0))), {
  message: 'Execution events are ordered and end at throughSeq',
});
export type ExecutionSnapshot = z.infer<typeof ExecutionSnapshotSchema>;

export const RunSnapshotSchema = RunStateSchema.safeExtend({
  id: IdSchema,
  revision: revisionSchema,
  seq: z.number().int().min(0),
  execution: ExecutionSnapshotSchema,
}).refine((s) => s.execution.throughSeq === s.seq, { message: 'The execution projection ends at the snapshot seq', path: ['execution', 'throughSeq'] });
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
