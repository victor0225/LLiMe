// Shared domain contract: vocabulary, case graphs, tool I/O, activities, records and the run snapshot.
// Isomorphic: imported by the server, the browser and the tests, so it must not import node: modules,
// the database driver or anything that performs I/O.
import { z } from 'zod';

// Bump on every contract change so every lane can tell which shape it was built against.
export const CONTRACT_VERSION = '2.1.0';
export const MATCHING_VERSION = 'typed-path-v1';
export const CATALOG_VERSION = 'llime-math-v1.1';

// ---------------------------------------------------------------------------------------------
// Vocabulary. The known values come from the immutable seed data and do not grow during a run.

export const StrategySchema = z.enum(['anchor_start', 'retry', 'make_ten', 'reverse_direction', 'clarify', 'repeat_count']);
export type Strategy = z.infer<typeof StrategySchema>;

// Known hypothesis meanings. Seed records only ever use these five.
export const MeaningSchema = z.enum(['count_start', 'slip', 'partition_gap', 'direction_error', 'unknown']);
export type Meaning = z.infer<typeof MeaningSchema>;

// A live proposal may also use `novel`: a clear, quoted pattern that none of the known meanings describes.
export const InterpretationMeaningSchema = z.enum([...MeaningSchema.options, 'novel']);
export type InterpretationMeaning = z.infer<typeof InterpretationMeaningSchema>;

export const OutcomeSchema = z.enum(['independent', 'assisted', 'failed', 'not_assessed']);
export type Outcome = z.infer<typeof OutcomeSchema>;

// Retention is never measured in a single session, so it is always pending.
export const RetentionSchema = z.literal('pending');

// Leaf concepts used by cases and tools.
export const ConceptSchema = z.enum(['addition_within_20', 'subtraction_within_20']);
export type Concept = z.infer<typeof ConceptSchema>;

// Curriculum hierarchy IDs: the two leaves plus their parents. Only concept links use the parents;
// a parent ID never reaches the case matcher.
export const CurriculumConceptSchema = z.enum(['addition', 'subtraction', ...ConceptSchema.options]);
export type CurriculumConcept = z.infer<typeof CurriculumConceptSchema>;

export const ConceptLinkKindSchema = z.enum(['prerequisite', 'similar', 'subconcept']);
export type ConceptLinkKind = z.infer<typeof ConceptLinkKindSchema>;

// Fixed curriculum rules loaded from the versioned seed file; the model never invents or changes them.
// `subconcept` is stored as (child)-[:SUBCONCEPT_OF]->(parent); `similar` is stored once and read both ways.
export const ConceptLinkSchema = z.strictObject({
  from: CurriculumConceptSchema,
  to: CurriculumConceptSchema,
  kind: ConceptLinkKindSchema,
  reason: z.string().min(1).max(300),
});
export type ConceptLink = z.infer<typeof ConceptLinkSchema>;
export const ConceptLinksSchema = z.array(ConceptLinkSchema);

// ---------------------------------------------------------------------------------------------
// Case graph: node and edge types, stages and ID rules.

export const NodeTypeSchema = z.enum(['Attempt', 'Concept', 'Observation', 'Explanation', 'Hypothesis', 'Question', 'Retry', 'Intervention', 'Outcome']);
export type NodeType = z.infer<typeof NodeTypeSchema>;
// Result nodes record what was done and what happened; they must never enter similarity features.
export const RESULT_NODE_TYPES = ['Intervention', 'Outcome'] as const satisfies readonly NodeType[];

export const EdgeTypeSchema = z.enum(['TARGETS', 'OBSERVED', 'EXPLAINED_BY', 'SUPPORTS', 'CONTRADICTS', 'ASKED', 'ANSWERED_BY', 'RETRIED_AS', 'NEXT', 'ADDRESSES', 'FOLLOWED_BY', 'EVALUATED_BY']);
export type EdgeType = z.infer<typeof EdgeTypeSchema>;

// Store-level relations between students, cases and shared concepts. They are not case-local edges and
// never take part in typed-path search.
export const MemoryEdgeTypeSchema = z.enum(['HAD', 'INSTANCE_OF', 'SUBCONCEPT_OF', 'CONCEPT_LINK']);
export type MemoryEdgeType = z.infer<typeof MemoryEdgeTypeSchema>;

export const NEO4J_LABELS = ['Case', 'MemoryNode', 'Student', 'Concept', 'Run', 'Event', 'Command', 'Activity', 'VoiceOperation', 'NotificationOutbox'] as const;

export const StageSchema = z.enum(['context', 'result']);
export type Stage = z.infer<typeof StageSchema>;

// Allowed `FromType>ToType` endpoints for every case-local edge type.
export const EDGE_ENDPOINTS: Readonly<Record<EdgeType, readonly string[]>> = {
  TARGETS: ['Attempt>Concept'],
  OBSERVED: ['Attempt>Observation', 'Retry>Observation'],
  EXPLAINED_BY: ['Observation>Explanation'],
  SUPPORTS: ['Explanation>Hypothesis', 'Observation>Hypothesis'],
  CONTRADICTS: ['Explanation>Hypothesis', 'Observation>Hypothesis'],
  ASKED: ['Attempt>Question'],
  ANSWERED_BY: ['Question>Explanation'],
  RETRIED_AS: ['Attempt>Retry'],
  NEXT: ['Explanation>Explanation', 'Retry>Retry'],
  ADDRESSES: ['Intervention>Hypothesis'],
  FOLLOWED_BY: ['Attempt>Intervention', 'Intervention>Intervention'],
  EVALUATED_BY: ['Intervention>Outcome', 'Attempt>Outcome'],
};

export const IdSchema = z.string().min(1).max(180);

// Activity specs carry only plain identifiers so model output can never smuggle markup or URLs.
export const IdentifierSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);

export const SourceSchema = z.strictObject({ id: z.string(), text: z.string().max(2000) });
export type Source = z.infer<typeof SourceSchema>;

// Key order matters: case hashes are taken over JSON.stringify of the parsed value, and parsing rebuilds
// objects in schema key order. `proposedMeaning` stays last and optional so seed hashes do not change.
export const NodeSchema = z.strictObject({
  id: z.string().min(1).max(160),
  type: NodeTypeSchema,
  meaning: z.string().max(100),
  stage: StageSchema,
  sourceIds: z.array(z.string()).max(20),
  proposedMeaning: z.string().max(40).optional(),
});
export type GraphNode = z.infer<typeof NodeSchema>;

export const EdgeSchema = z.strictObject({
  id: z.string().min(1),
  from: z.string(),
  to: z.string(),
  type: EdgeTypeSchema,
  stage: StageSchema,
});
export type GraphEdge = z.infer<typeof EdgeSchema>;

export const RetrievalContextSchema = z.strictObject({
  nodeIds: z.array(z.string()).min(1),
  edgeIds: z.array(z.string()).min(1),
});
export type RetrievalContext = z.infer<typeof RetrievalContextSchema>;

export const CaseSchema = z.strictObject({
  id: z.string(),
  studentId: z.string(),
  provenance: z.enum(['synthetic', 'live_demo']),
  createdAt: z.iso.datetime(),
  concept: ConceptSchema,
  sources: z.array(SourceSchema).max(30),
  nodes: z.array(NodeSchema).max(100),
  edges: z.array(EdgeSchema).max(200),
  strategy: StrategySchema,
  outcome: OutcomeSchema,
  retention: RetentionSchema,
  retrievalContext: RetrievalContextSchema.optional(),
});
export type LearningCase = z.infer<typeof CaseSchema>;

// Parses a case and enforces the graph rules the schema alone cannot express. Throws on the first
// violation so a broken graph is never stored or searched.
export function validateCase(input: unknown): LearningCase {
  const c = CaseSchema.parse(input);
  const nodes = new Map(c.nodes.map((n) => [n.id, n]));
  if (nodes.size !== c.nodes.length || new Set(c.edges.map((e) => e.id)).size !== c.edges.length) throw new Error('Duplicate graph ID');
  const sourceIds = new Set(c.sources.map((s) => s.id));
  if (sourceIds.size !== c.sources.length) throw new Error('Duplicate source ID');
  for (const n of c.nodes) {
    // Every node belongs to its case and is grounded in at least one of that case's sources.
    if (!n.id.startsWith(`${c.id}:`) || n.sourceIds.length === 0 || n.sourceIds.some((id) => !sourceIds.has(id))) throw new Error('Unscoped node or missing source');
    if (isResultNodeType(n.type) && n.stage !== 'result') throw new Error('Outcome leakage');
    // The model-proposed name only ever labels a novel hypothesis.
    if (n.proposedMeaning !== undefined && !(n.type === 'Hypothesis' && n.meaning === 'novel')) throw new Error('Unexpected proposed meaning');
  }
  for (const e of c.edges) {
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to || !EDGE_ENDPOINTS[e.type].includes(`${from.type}>${to.type}`)) throw new Error('Invalid graph relation');
    if (e.stage === 'context' && (from.stage === 'result' || to.stage === 'result')) throw new Error('Outcome leakage');
  }
  if (c.retrievalContext) {
    const selected = new Set(c.retrievalContext.nodeIds);
    const badNode = c.retrievalContext.nodeIds.some((id) => nodes.get(id)?.stage !== 'context');
    const badEdge = c.retrievalContext.edgeIds.some((id) => !c.edges.some((e) => e.id === id && e.stage === 'context' && selected.has(e.from) && selected.has(e.to)));
    if (badNode || badEdge) throw new Error('Invalid retrieval context');
  }
  return c;
}

function isResultNodeType(type: NodeType): boolean {
  return (RESULT_NODE_TYPES as readonly NodeType[]).includes(type);
}

// ---------------------------------------------------------------------------------------------
// Graph proposal: the model's reading of the child's explanation. Quotes are checked against the
// stored source by the handler; the structural rules below are checked here.

export const PROPOSED_MEANING_PATTERN = /^[a-z][a-z0-9_]{2,39}$/;
export const MAX_INTERPRETATIONS = 4;

export const InterpretationSchema = z.strictObject({
  meaning: InterpretationMeaningSchema,
  proposedMeaning: z.string().regex(PROPOSED_MEANING_PATTERN).nullish(),
  sourceId: z.string(),
  quote: z.string().min(1).max(600),
  relation: z.enum(['SUPPORTS', 'CONTRADICTS']),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;

const InterpretationsSchema = z.array(InterpretationSchema).max(MAX_INTERPRETATIONS).superRefine((items, ctx) => {
  items.forEach((item, index) => {
    const named = item.proposedMeaning !== undefined && item.proposedMeaning !== null;
    if (item.meaning === 'novel' && !named) ctx.addIssue({ code: 'custom', path: [index, 'proposedMeaning'], message: 'A novel interpretation needs a proposedMeaning' });
    if (item.meaning !== 'novel' && named) ctx.addIssue({ code: 'custom', path: [index, 'proposedMeaning'], message: 'Only a novel interpretation may carry a proposedMeaning' });
    // A model-chosen name must never shadow the known vocabulary.
    if (named && MeaningSchema.safeParse(item.proposedMeaning).success) ctx.addIssue({ code: 'custom', path: [index, 'proposedMeaning'], message: 'proposedMeaning must not be a known meaning' });
    if (item.meaning === 'novel' && item.relation !== 'SUPPORTS') ctx.addIssue({ code: 'custom', path: [index, 'relation'], message: 'A novel interpretation can only SUPPORT' });
  });
  if (items.filter((item) => item.meaning === 'novel').length > 1) ctx.addIssue({ code: 'custom', message: 'At most one novel interpretation per proposal' });
});

export const ProposalSchema = z.strictObject({
  interpretations: InterpretationsSchema,
  needsClarification: z.boolean(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

// ---------------------------------------------------------------------------------------------
// Problems, attempts and assessment.

export const ProblemSchema = z.strictObject({
  lhs: z.number().int().min(0).max(19),
  rhs: z.number().int().min(1).max(10),
});
export type Problem = z.infer<typeof ProblemSchema>;

// Problem seeds are unsigned 32-bit integers so a run's pair is reproducible from the stored seed.
export const SeedSchema = z.number().int().min(0).max(0xffffffff);

// Help exposure recorded with an attempt; capped so a client cannot submit an unbounded count.
export const HintsSchema = z.number().int().min(0).max(20);

// A submitted number-line attempt. `moves` lists the visited positions in action order.
export const AttemptSchema = z.strictObject({
  start: z.number().int(),
  moves: z.array(z.number().int()).max(20),
  answer: z.number().int(),
  hints: HintsSchema,
});
export type Attempt = z.infer<typeof AttemptSchema>;

export const MakeTenZoneSchema = z.enum(['tray', 'ten_frame', 'remaining']);
export type MakeTenZone = z.infer<typeof MakeTenZoneSchema>;

// A submitted make-ten attempt. Each object's final position is its last placement; objects never
// moved stay in the tray.
export const MakeTenAttemptSchema = z.strictObject({
  placements: z.array(z.strictObject({ objectId: IdentifierSchema, to: MakeTenZoneSchema })).max(40),
  answer: z.number().int(),
  hints: HintsSchema,
});
export type MakeTenAttempt = z.infer<typeof MakeTenAttemptSchema>;

export const AnyAttemptSchema = z.union([AttemptSchema, MakeTenAttemptSchema]);
export type AnyAttempt = z.infer<typeof AnyAttemptSchema>;

export const CriterionSchema = z.enum(['initial', 'support', 'independent']);
export type Criterion = z.infer<typeof CriterionSchema>;

// Support passes on correct process and answer even with help; initial and independent also need zero hints.
export const AssessmentSchema = z.strictObject({
  attemptId: IdSchema,
  passed: z.boolean(),
  processCorrect: z.boolean(),
  answerCorrect: z.boolean(),
  hints: HintsSchema,
  retention: RetentionSchema,
});
export type Assessment = z.infer<typeof AssessmentSchema>;

// ---------------------------------------------------------------------------------------------
// Generated activity spec, catalog llime-math-v1.1. Structure only: it never carries child-facing text.

export const WorkspaceSchema = z.enum(['NumberLine', 'MakeTenWorkspace']);
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const AppearanceSchema = z.enum(['apple', 'dot', 'pear']);
export type Appearance = z.infer<typeof AppearanceSchema>;

// The number line is drawn from 0 to 20, so a problem must end inside it.
export const NUMBER_LINE_MIN = 0;
export const NUMBER_LINE_MAX = 20;

export const NumberLinePropsSchema = z.strictObject({
  start: z.number().int().min(0).max(19),
  addend: z.number().int().min(1).max(10),
});
export const StartMarkerPropsSchema = z.strictObject({ targetId: IdentifierSchema, value: z.number().int().min(0).max(19) });
export const JumpCounterPropsSchema = z.strictObject({ targetId: IdentifierSchema });
export const MakeTenWorkspacePropsSchema = z.strictObject({
  first: z.number().int().min(1).max(9),
  second: z.number().int().min(2).max(9),
  appearance: AppearanceSchema,
  highlightEmptySlots: z.boolean(),
  showEquation: z.boolean(),
});

export const ActivityComponentSchema = z.discriminatedUnion('type', [
  z.strictObject({ id: IdentifierSchema, type: z.literal('MakeTenWorkspace'), props: MakeTenWorkspacePropsSchema }),
  z.strictObject({ id: IdentifierSchema, type: z.literal('NumberLine'), props: NumberLinePropsSchema }),
  z.strictObject({ id: IdentifierSchema, type: z.literal('StartMarker'), props: StartMarkerPropsSchema }),
  z.strictObject({ id: IdentifierSchema, type: z.literal('JumpCounter'), props: JumpCounterPropsSchema }),
]);
export type ActivityComponent = z.infer<typeof ActivityComponentSchema>;

export const ActivityPhaseSchema = z.enum(['support', 'independent']);

export const ActivitySpecSchema = z.strictObject({
  catalogVersion: z.literal(CATALOG_VERSION),
  activityId: IdentifierSchema,
  revision: z.number().int().min(0),
  phase: ActivityPhaseSchema,
  problemRef: IdentifierSchema,
  evidenceIds: z.array(IdentifierSchema).max(5),
  components: z.array(ActivityComponentSchema).min(1).max(3),
});
export type ActivitySpec = z.infer<typeof ActivitySpecSchema>;

// Server-built validation context for a generated spec, derived only from stored run state.
export const ActivityContextSchema = z.strictObject({
  activityId: IdentifierSchema,
  revision: z.number().int().min(0),
  phase: ActivityPhaseSchema,
  workspace: WorkspaceSchema,
  problemRef: IdentifierSchema,
  start: z.number().int().min(0).max(19),
  addend: z.number().int().min(1).max(10),
  evidenceIds: z.array(IdentifierSchema),
});
export type ActivityContext = z.infer<typeof ActivityContextSchema>;

// The context returned to the model after search for a support activity; revision is expectedRevision + 1.
export const SupportActivityContextSchema = ActivityContextSchema.extend({ phase: z.literal('support') });
export type SupportActivityContext = z.infer<typeof SupportActivityContextSchema>;

// ---------------------------------------------------------------------------------------------
// Activities: handler-built, versioned records. Every child-facing word comes from the server copy tables.

export const ActivityKindSchema = z.enum(['invitation', 'initial', 'support', 'retry', 'clarification', 'independent', 'completion']);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

export const TemplateIdSchema = z.enum([
  'invitation_addition',
  'initial_number_line',
  'anchor_start_number_line',
  'make_ten_blocks',
  'manipulation_retry',
  'clarify_first_number',
  'clarify_show_steps',
  'independent_number_line',
  'independent_make_ten',
  'completion',
]);
export type TemplateId = z.infer<typeof TemplateIdSchema>;

// Each template belongs to exactly one activity kind, so a decision's template fixes the kind to publish.
export const TEMPLATE_KIND: Readonly<Record<TemplateId, ActivityKind>> = {
  invitation_addition: 'invitation',
  initial_number_line: 'initial',
  anchor_start_number_line: 'support',
  make_ten_blocks: 'support',
  manipulation_retry: 'retry',
  clarify_first_number: 'clarification',
  clarify_show_steps: 'clarification',
  independent_number_line: 'independent',
  independent_make_ten: 'independent',
  completion: 'completion',
};

export const DECISION_SUMMARY_MAX = 300;

export const ActivitySchema = z.strictObject({
  id: IdSchema,
  revision: z.number().int().min(0),
  runId: IdSchema,
  kind: ActivityKindSchema,
  templateId: TemplateIdSchema,
  strategy: StrategySchema.nullable(),
  problem: ProblemSchema.nullable(),
  title: z.string().max(300),
  body: z.string().max(300),
  primaryLabel: z.string().max(300),
  secondaryLabel: z.string().max(300).nullable(),
  activitySpec: ActivitySpecSchema.nullable(),
  specHash: z.string().nullable(),
  helperCount: z.number().int().min(0).max(2),
  evidenceIds: z.array(IdSchema).max(5),
  decisionSummary: z.string().max(DECISION_SUMMARY_MAX),
});
export type Activity = z.infer<typeof ActivitySchema>;

// ---------------------------------------------------------------------------------------------
// Decision layers and search results.

export const DecisionBasisSchema = z.enum(['clarify', 'policy', 'evidence', 'default']);
export type DecisionBasis = z.infer<typeof DecisionBasisSchema>;

export const StrategyGroupSchema = z.strictObject({
  strategy: StrategySchema,
  independent: z.number().int().min(0),
  total: z.number().int().min(1),
}).refine((g) => g.independent <= g.total, { message: 'independent cannot exceed total' });
export type StrategyGroup = z.infer<typeof StrategyGroupSchema>;

export const DecisionSchema = z.strictObject({
  strategy: StrategySchema,
  templateId: TemplateIdSchema,
  basis: DecisionBasisSchema,
  evidenceIds: z.array(z.string()),
  reason: z.string().max(300),
  groups: z.array(StrategyGroupSchema),
}).refine((d) => (d.basis === 'evidence') === (d.evidenceIds.length > 0), { message: 'An evidence decision cites evidence and no other decision does', path: ['evidenceIds'] });
export type Decision = z.infer<typeof DecisionSchema>;

// The detailed candidate list is capped so the search event stays small; `scores` carries the full ranking compactly.
export const MAX_SEARCH_CANDIDATES = 20;

const ScoreSchema = z.number().min(0).max(1);

export const CandidateSchema = z.strictObject({
  id: z.string(),
  studentId: z.string(),
  score: ScoreSchema,
  coverage: ScoreSchema,
  strategy: StrategySchema,
  outcome: OutcomeSchema,
  matchedQueryNodeIds: z.array(z.string()),
  matchedCandidateNodeIds: z.array(z.string()),
});
export type Candidate = z.infer<typeof CandidateSchema>;

export const AdmittedCaseSchema = z.strictObject({
  caseId: z.string(),
  score: ScoreSchema,
  coverage: ScoreSchema,
  strategy: StrategySchema,
  outcome: z.enum(['independent', 'assisted', 'failed']),
  matchedEdgeIds: z.array(z.string()),
});
export type AdmittedCase = z.infer<typeof AdmittedCaseSchema>;

export const SearchResultSchema = z.strictObject({
  matchingVersion: z.literal(MATCHING_VERSION),
  corpusHash: z.string(),
  queryId: z.string(),
  candidateCount: z.number().int().min(0),
  rankingHash: z.string(),
  candidates: z.array(CandidateSchema).max(MAX_SEARCH_CANDIDATES),
  decision: DecisionSchema,
  // Every ranked candidate as [caseId, score rounded to 3 decimals], in rank order.
  scores: z.array(z.tuple([z.string(), ScoreSchema])),
  // Admission is computed once by the search; screens show this list and never recompute it.
  admitted: z.array(AdmittedCaseSchema),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const ContextCommitSchema = z.strictObject({
  caseId: z.string(),
  explanationRevision: z.number().int().min(0),
  eventSeq: z.number().int().min(1),
  nodeIds: z.array(z.string()),
  edgeIds: z.array(z.string()),
  replayed: z.boolean(),
});
export type ContextCommit = z.infer<typeof ContextCommitSchema>;

// ---------------------------------------------------------------------------------------------
// Errors.

export const ErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'WRONG_PHASE',
  'STALE_REVISION',
  'NOT_FOUND',
  'CONFLICT',
  'VALIDATION_FAILED',
  'SEARCH_FAILED',
  'TOOL_TIMEOUT',
  'MODEL_TIMEOUT',
  'RUNTIME_DISCONNECTED',
  'AUTH_REQUIRED',
  'UNKNOWN_TOOL',
  'CANCELLED',
  'PAYLOAD_TOO_LARGE',
  // A refused Host, Origin or session nonce.
  'FORBIDDEN',
  // A server fault; the body names only an error ID that matches the server log entry.
  'INTERNAL',
  // The route's handler or the store is not ready yet; retry after the server finishes starting.
  'NOT_READY',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorBodySchema = z.strictObject({
  code: ErrorCodeSchema,
  message: z.string().max(300),
  retryable: z.boolean(),
  // The current run revision, so a client can refresh before retrying a conflicting command.
  revision: z.number().int().min(0).optional(),
  // Correlates a server fault with its log entry. Letters, digits, '_' and '-' only, so a stack
  // trace or a file path can never travel to the browser in its place.
  errorId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

// ---------------------------------------------------------------------------------------------
// The five product tools.

export const ToolNameSchema = z.enum(['get_personal_memory', 'search_learning_cases', 'publish_activity', 'assess_attempt', 'commit_episode']);
export type ToolName = z.infer<typeof ToolNameSchema>;

export const MAX_MEMORY_CASES_PER_CONCEPT = 8;

// get_personal_memory: conceptIds[0] is today's concept; conceptIds[1], if present, must be linked to it.
export const GetPersonalMemoryInputSchema = z.strictObject({
  conceptIds: z.array(ConceptSchema).min(1).max(2),
  includeUnassessed: z.boolean(),
});
export type GetPersonalMemoryInput = z.infer<typeof GetPersonalMemoryInputSchema>;

export const MemoryCaseSchema = z.strictObject({
  caseId: IdSchema,
  concept: ConceptSchema,
  strategy: StrategySchema,
  outcome: OutcomeSchema,
  retention: RetentionSchema,
  nodeIds: z.array(IdSchema),
});
export type MemoryCase = z.infer<typeof MemoryCaseSchema>;

// Computed over all of a concept's cases, not only the ones returned, so an early difficulty never hides
// later success. Empty history means no recorded experience, never inability.
export const MemorySummarySchema = z.strictObject({
  conceptId: ConceptSchema,
  link: z.enum(['today', 'prerequisite', 'similar']),
  total: z.number().int().min(0),
  independent: z.number().int().min(0),
  assisted: z.number().int().min(0),
  failed: z.number().int().min(0),
  notAssessed: z.number().int().min(0),
  firstAt: z.string().nullable(),
  lastAt: z.string().nullable(),
});
export type MemorySummary = z.infer<typeof MemorySummarySchema>;

export const GetPersonalMemoryOutputSchema = z.strictObject({
  memorySnapshotId: IdSchema,
  studentId: IdSchema,
  corpusHash: z.string(),
  cases: z.array(MemoryCaseSchema).max(2 * MAX_MEMORY_CASES_PER_CONCEPT),
  summaries: z.array(MemorySummarySchema).min(1).max(2),
  unassessedConceptIds: z.array(ConceptSchema),
});
export type GetPersonalMemoryOutput = z.infer<typeof GetPersonalMemoryOutputSchema>;

// search_learning_cases writes the context graph, then searches. Idempotent on (runId, explanationRevision).
export const SearchLearningCasesInputSchema = z.strictObject({
  explanationRevision: z.number().int().min(0),
  interpretations: InterpretationsSchema,
  needsClarification: z.boolean(),
  retrievalContext: RetrievalContextSchema.nullable(),
});
export type SearchLearningCasesInput = z.infer<typeof SearchLearningCasesInputSchema>;

export const PublicationContextSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  activityContext: SupportActivityContextSchema.nullable(),
});
export type PublicationContext = z.infer<typeof PublicationContextSchema>;

export const SearchLearningCasesOutputSchema = z.strictObject({
  contextCommit: ContextCommitSchema,
  search: SearchResultSchema,
  publicationContext: PublicationContextSchema,
});
export type SearchLearningCasesOutput = z.infer<typeof SearchLearningCasesOutputSchema>;

// publish_activity: the handler accepts only the kind and template of the same-run decision.
export const PublishKindSchema = z.enum(['invitation', 'support', 'retry', 'clarification']);
export type PublishKind = z.infer<typeof PublishKindSchema>;

export const PublishActivityInputSchema = z.strictObject({
  expectedRevision: z.number().int().min(0),
  explanationRevision: z.number().int().min(0).nullable(),
  kind: PublishKindSchema,
  templateId: TemplateIdSchema,
  strategy: StrategySchema.nullable(),
  problem: ProblemSchema.nullable(),
  evidenceIds: z.array(IdSchema).max(5),
  todayConceptId: ConceptSchema.nullable(),
  // Invitation only: exact substrings of the whole saved lesson, used as internal source references.
  quotes: z.array(z.string().min(1)).max(3).nullable(),
  decisionSummary: z.string().max(DECISION_SUMMARY_MAX),
  activitySpec: ActivitySpecSchema.nullable(),
}).superRefine((input, ctx) => {
  if (input.kind === 'invitation') {
    if (input.evidenceIds.length < 1) ctx.addIssue({ code: 'custom', path: ['evidenceIds'], message: 'An invitation cites 1 to 5 memory cases' });
    if (input.todayConceptId === null) ctx.addIssue({ code: 'custom', path: ['todayConceptId'], message: 'An invitation names today\'s concept' });
    if (input.quotes === null || input.quotes.length < 1) ctx.addIssue({ code: 'custom', path: ['quotes'], message: 'An invitation quotes 1 to 3 lesson passages' });
  } else {
    if (input.todayConceptId !== null) ctx.addIssue({ code: 'custom', path: ['todayConceptId'], message: 'Only an invitation names today\'s concept' });
    if (input.quotes !== null) ctx.addIssue({ code: 'custom', path: ['quotes'], message: 'Only an invitation carries lesson quotes' });
  }
  // Support is the only generated activity; the application builds every other kind itself.
  if (input.kind === 'support' && input.activitySpec === null) ctx.addIssue({ code: 'custom', path: ['activitySpec'], message: 'Support needs an activitySpec' });
  if (input.kind !== 'support' && input.activitySpec !== null) ctx.addIssue({ code: 'custom', path: ['activitySpec'], message: 'Only support carries an activitySpec' });
});
export type PublishActivityInput = z.infer<typeof PublishActivityInputSchema>;

export const PublishActivityOutputSchema = z.strictObject({
  activity: ActivitySchema,
  newRevision: z.number().int().min(0),
  eventSeq: z.number().int().min(1),
  notificationId: IdSchema.nullable(),
});
export type PublishActivityOutput = z.infer<typeof PublishActivityOutputSchema>;

// assess_attempt: the rubric comes from the stored activity, never from the model's criterion.
export const AssessAttemptInputSchema = z.strictObject({ attemptId: IdSchema, criterion: CriterionSchema });
export type AssessAttemptInput = z.infer<typeof AssessAttemptInputSchema>;
export const AssessAttemptOutputSchema = AssessmentSchema;
export type AssessAttemptOutput = z.infer<typeof AssessAttemptOutputSchema>;

// commit_episode: the outcome is built from stored assessments; the model cannot supply it.
export const CommitEpisodeInputSchema = z.strictObject({
  independentAttemptId: IdSchema,
  supportAttemptId: IdSchema.nullable(),
  expectedRevision: z.number().int().min(0),
});
export type CommitEpisodeInput = z.infer<typeof CommitEpisodeInputSchema>;

export const CommitEpisodeOutputSchema = z.strictObject({
  caseId: z.string(),
  strategy: StrategySchema,
  outcome: OutcomeSchema,
  retention: RetentionSchema,
  newRevision: z.number().int().min(0),
  eventSeq: z.number().int().min(1),
});
export type CommitEpisodeOutput = z.infer<typeof CommitEpisodeOutputSchema>;

export const TOOL_SCHEMAS = {
  get_personal_memory: { input: GetPersonalMemoryInputSchema, output: GetPersonalMemoryOutputSchema },
  search_learning_cases: { input: SearchLearningCasesInputSchema, output: SearchLearningCasesOutputSchema },
  publish_activity: { input: PublishActivityInputSchema, output: PublishActivityOutputSchema },
  assess_attempt: { input: AssessAttemptInputSchema, output: AssessAttemptOutputSchema },
  commit_episode: { input: CommitEpisodeInputSchema, output: CommitEpisodeOutputSchema },
} as const satisfies Record<ToolName, { input: z.ZodType; output: z.ZodType }>;

export const ToolCallSchema = z.discriminatedUnion('name', [
  z.strictObject({ name: z.literal('get_personal_memory'), arguments: GetPersonalMemoryInputSchema }),
  z.strictObject({ name: z.literal('search_learning_cases'), arguments: SearchLearningCasesInputSchema }),
  z.strictObject({ name: z.literal('publish_activity'), arguments: PublishActivityInputSchema }),
  z.strictObject({ name: z.literal('assess_attempt'), arguments: AssessAttemptInputSchema }),
  z.strictObject({ name: z.literal('commit_episode'), arguments: CommitEpisodeInputSchema }),
]);
export type ToolCall = z.infer<typeof ToolCallSchema>;

// ok:true means the handler ran; an educational failure (passed:false) is still ok:true.
// ok:false means execution or validation failed. contextCommit is set when the context write
// succeeded but the search after it did not.
export const ToolFailureSchema = z.strictObject({
  ok: z.literal(false),
  tool: ToolNameSchema,
  error: ErrorBodySchema,
  contextCommit: ContextCommitSchema.nullable(),
});

export const ToolSuccessSchema = z.discriminatedUnion('tool', [
  z.strictObject({ ok: z.literal(true), tool: z.literal('get_personal_memory'), data: GetPersonalMemoryOutputSchema }),
  z.strictObject({ ok: z.literal(true), tool: z.literal('search_learning_cases'), data: SearchLearningCasesOutputSchema }),
  z.strictObject({ ok: z.literal(true), tool: z.literal('publish_activity'), data: PublishActivityOutputSchema }),
  z.strictObject({ ok: z.literal(true), tool: z.literal('assess_attempt'), data: AssessAttemptOutputSchema }),
  z.strictObject({ ok: z.literal(true), tool: z.literal('commit_episode'), data: CommitEpisodeOutputSchema }),
]);
export type ToolSuccess = z.infer<typeof ToolSuccessSchema>;

export const ToolResultSchema = z.union([ToolSuccessSchema, ToolFailureSchema]);
export type ToolResult = z.infer<typeof ToolResultSchema>;

// The three kinds of agent turn in a run.
export const RuntimePhaseSchema = z.enum(['ingestion', 'explanation', 'verification']);
export type RuntimePhase = z.infer<typeof RuntimePhaseSchema>;

// Final response schema for every agent turn. It is displayed after validation but never substitutes
// for a committed tool effect.
export const PhaseResultSchema = z.strictObject({
  phase: RuntimePhaseSchema,
  status: z.enum(['completed', 'blocked']),
  activityId: z.string().nullable(),
  caseId: z.string().nullable(),
  evidenceIds: z.array(z.string()),
  summary: z.string().max(300),
});
export type PhaseResult = z.infer<typeof PhaseResultSchema>;

// ---------------------------------------------------------------------------------------------
// Run phases and learning commands.

export const RunPhaseSchema = z.enum([
  'WAITING',
  'INGESTING',
  'INVITED',
  'NO_MATCH',
  'INITIAL',
  'ALREADY_CORRECT',
  'EXPLAIN',
  'OUT_OF_SCOPE',
  'PROCESSING',
  'CLARIFY',
  'PRACTICE',
  'VERIFY',
  'NEEDS_SUPPORT',
  'COMPLETE',
  'ERROR',
]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

// Allowed phase changes. The engine adds the guards (revision, epoch, stopped, caps); a phase not listed
// as a target is never reachable from that source. NEEDS_SUPPORT is terminal when continuation is not allowed.
export const PHASE_TRANSITIONS: Readonly<Record<RunPhase, readonly RunPhase[]>> = {
  WAITING: ['INGESTING'],
  INGESTING: ['INVITED', 'NO_MATCH', 'ERROR'],
  INVITED: ['INITIAL'],
  NO_MATCH: [],
  INITIAL: ['ALREADY_CORRECT', 'EXPLAIN', 'OUT_OF_SCOPE'],
  ALREADY_CORRECT: [],
  EXPLAIN: ['PROCESSING'],
  OUT_OF_SCOPE: [],
  // PROCESSING -> PROCESSING is a newer explanation revision; -> NEEDS_SUPPORT is the clarification cap.
  PROCESSING: ['PROCESSING', 'CLARIFY', 'PRACTICE', 'NEEDS_SUPPORT', 'ERROR'],
  CLARIFY: ['PROCESSING'],
  // PRACTICE -> PROCESSING is a correction before the practice attempt is submitted.
  PRACTICE: ['PROCESSING', 'VERIFY', 'CLARIFY', 'NEEDS_SUPPORT'],
  VERIFY: ['COMPLETE', 'NEEDS_SUPPORT', 'ERROR'],
  // With continuation allowed, the child's next explanation is processed directly, once.
  NEEDS_SUPPORT: ['EXPLAIN', 'PROCESSING'],
  COMPLETE: [],
  ERROR: [],
};

export const EXPLANATION_MAX_CHARS = 600;
export const ExplanationTextSchema = z.string().trim().min(1).max(EXPLANATION_MAX_CHARS);

const commandBase = { commandId: z.uuid(), revision: z.number().int().min(0) };

export const CommandSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...commandBase, type: z.literal('accept') }),
  z.strictObject({ ...commandBase, type: z.literal('attempt'), attempt: AttemptSchema }),
  z.strictObject({ ...commandBase, type: z.literal('practice'), attempt: AnyAttemptSchema }),
  z.strictObject({ ...commandBase, type: z.literal('verify'), attempt: AnyAttemptSchema }),
  z.strictObject({ ...commandBase, type: z.literal('explain'), text: ExplanationTextSchema }),
  z.strictObject({ ...commandBase, type: z.literal('stop_learning') }),
]);
export type Command = z.infer<typeof CommandSchema>;
export type CommandType = Command['type'];

// Phases in which each command may be accepted. `explain` in PROCESSING or PRACTICE is a correction
// (PRACTICE only before the practice attempt is submitted); in NEEDS_SUPPORT only when continuation is
// allowed. A stopped run rejects every learning command.
export const COMMAND_PHASES: Readonly<Record<CommandType, readonly RunPhase[]>> = {
  accept: ['INVITED'],
  attempt: ['INITIAL'],
  explain: ['EXPLAIN', 'CLARIFY', 'NEEDS_SUPPORT', 'PROCESSING', 'PRACTICE'],
  practice: ['PRACTICE'],
  verify: ['VERIFY'],
  stop_learning: ['WAITING', 'INGESTING', 'INVITED', 'INITIAL', 'EXPLAIN', 'PROCESSING', 'CLARIFY', 'PRACTICE', 'VERIFY', 'NEEDS_SUPPORT'],
};

export const RunCreateInputSchema = z.strictObject({ seed: SeedSchema.optional() });
export type RunCreateInput = z.infer<typeof RunCreateInputSchema>;

// Both null until the lesson's problems are validated; then persisted together, once, and never redrawn.
const selectionIsConsistent = (s: { lessonProblems: unknown; selectedProblems: unknown }) => (s.lessonProblems === null) === (s.selectedProblems === null);
const selectionIssue = { message: 'lessonProblems and selectedProblems are persisted together' };

export const RunSelectionSchema = z.strictObject({
  seed: SeedSchema,
  lessonProblems: z.array(ProblemSchema).nullable(),
  selectedProblems: z.strictObject({ initial: ProblemSchema, independent: ProblemSchema }).nullable(),
}).refine(selectionIsConsistent, selectionIssue);
export type RunSelection = z.infer<typeof RunSelectionSchema>;

// ---------------------------------------------------------------------------------------------
// Correlation, voice operations and notification records.

const nullableId = IdSchema.nullable();

const correlationShape = {
  runId: IdSchema,
  // Null for ingestion and typed-only work without a Live session; never a fabricated ID.
  liveSessionId: nullableId,
  delegationId: nullableId,
  operationId: IdSchema,
  explanationRevision: z.number().int().min(0),
  cancellationEpoch: z.number().int().min(0),
  threadId: nullableId,
  turnId: nullableId,
};

export const CORRELATION_ID_KEYS = Object.keys(correlationShape) as (keyof typeof correlationShape)[];

const delegationNeedsSession = (ids: { liveSessionId: string | null; delegationId: string | null }) => ids.liveSessionId !== null || ids.delegationId === null;
const delegationNeedsSessionIssue = { message: 'A delegation requires a Live session', path: ['delegationId'] };

export const CorrelationIdsSchema = z.strictObject(correlationShape).refine(delegationNeedsSession, delegationNeedsSessionIssue);
export type CorrelationIds = z.infer<typeof CorrelationIdsSchema>;

export const VoiceOperationStatusSchema = z.enum(['started', 'steered', 'completed', 'cancelled', 'failed']);
export const VoiceOperationSchema = z.strictObject({ ...correlationShape, status: VoiceOperationStatusSchema }).refine(delegationNeedsSession, delegationNeedsSessionIssue);
export type VoiceOperation = z.infer<typeof VoiceOperationSchema>;

export const NotificationStatusSchema = z.enum(['pending', 'dispatching', 'injected', 'failed', 'unknown']);
export type NotificationStatus = z.infer<typeof NotificationStatusSchema>;

// Written in the same transaction as the activity it announces; unique on activityId + activityRevision + transport.
export const NotificationOutboxSchema = z.strictObject({
  notificationId: IdSchema,
  runId: IdSchema,
  activityId: IdSchema,
  activityRevision: z.number().int().min(0),
  transport: z.literal('simulator'),
  status: NotificationStatusSchema,
  attemptCount: z.number().int().min(0),
  createdAt: z.iso.datetime(),
  lastErrorCode: z.string().nullable(),
});
export type NotificationOutbox = z.infer<typeof NotificationOutboxSchema>;

// The simulated push payload. Opaque identifiers only: never transcript text, a child's explanation,
// a diagnosis, historical cases or credentials. The simulator rejects payloads over 4096 bytes.
export const NOTIFICATION_PAYLOAD_MAX_BYTES = 4096;
export const NotificationPayloadSchema = z.strictObject({
  aps: z.strictObject({
    alert: z.strictObject({ title: z.string().min(1), body: z.string().min(1) }),
    sound: z.literal('default'),
  }),
  notificationId: IdSchema,
  runId: IdSchema,
  activityId: IdSchema,
  activityRevision: z.number().int().min(0),
}).refine((p) => new TextEncoder().encode(JSON.stringify(p)).length <= NOTIFICATION_PAYLOAD_MAX_BYTES, { message: 'Notification payload exceeds 4096 bytes' });
export type NotificationPayload = z.infer<typeof NotificationPayloadSchema>;

// ---------------------------------------------------------------------------------------------
// Run snapshot pieces.

// The saved lesson the run ingests; invitation quotes are checked against this exact text.
export const LessonRecordSchema = z.strictObject({
  contentHash: z.string(),
  text: z.string(),
  source: z.literal('local_file'),
  savedAt: z.iso.datetime(),
});
export type LessonRecord = z.infer<typeof LessonRecordSchema>;

export const ExplanationRecordSchema = z.strictObject({
  revision: z.number().int().min(0),
  text: ExplanationTextSchema,
  inputMode: z.enum(['voice', 'typed']),
  at: z.iso.datetime(),
});
export type ExplanationRecord = z.infer<typeof ExplanationRecordSchema>;

// Submitted attempts are immutable; the assessment is null until the deterministic evaluator ran.
export const SavedAttemptSchema = z.strictObject({
  id: IdSchema,
  activityId: IdSchema,
  activityRevision: z.number().int().min(0),
  criterion: CriterionSchema,
  attempt: AnyAttemptSchema,
  assessment: AssessmentSchema.nullable(),
  at: z.iso.datetime(),
});
export type SavedAttempt = z.infer<typeof SavedAttemptSchema>;

// serviceTier is recorded exactly as passed to the runtime (null when none was requested).
export const RuntimeChoiceSchema = z.strictObject({
  model: z.string().min(1),
  serviceTier: z.string().min(1).nullable(),
  threadId: IdSchema.nullable(),
});
export type RuntimeChoice = z.infer<typeof RuntimeChoiceSchema>;

// Authoritative run state. The snapshot route adds id, revision, seq and the execution projection.
export const RunStateSchema = z.strictObject({
  phase: RunPhaseSchema,
  stopped: z.boolean(),
  studentId: IdSchema,
  corpusHash: z.string(),
  matchingVersion: z.literal(MATCHING_VERSION),
  ...RunSelectionSchema.shape,
  explanationRevision: z.number().int().min(0),
  cancellationEpoch: z.number().int().min(0),
  clarificationRounds: z.number().int().min(0),
  interventionCount: z.number().int().min(0),
  continuationAllowed: z.boolean(),
  // The model and service tier are chosen once per run and never silently changed.
  runtime: RuntimeChoiceSchema.nullable(),
  lesson: LessonRecordSchema.nullable(),
  invitation: ActivitySchema.nullable(),
  activity: ActivitySchema.nullable(),
  attempts: z.array(SavedAttemptSchema),
  explanation: ExplanationRecordSchema.nullable(),
  graph: CaseSchema.nullable(),
  search: SearchResultSchema.nullable(),
  error: ErrorBodySchema.nullable(),
  createdAt: z.iso.datetime(),
}).refine(selectionIsConsistent, selectionIssue);
export type RunState = z.infer<typeof RunStateSchema>;
