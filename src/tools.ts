// Deterministic tool handlers. The model proposes; these functions validate against stored facts and are
// the only code that changes learning state. This module holds the personal-memory read and the
// invitation publication; the other tools extend it.
import { z } from 'zod';
import { assess, AssessmentError } from './assessment.js';
import { compactSha256, resolveRelatedLeaf } from './dataset.js';
import { type ActivityDraft, activityContextOf, activityIdOf, buildActivity, decisionExceedsLimits, episodeOutcome, explainedAttempt, questionForExplanation } from './engine.js';
import { addResult, appendClarification, contextCase, contextCaseId, GraphProposalError, renameCase } from './graph.js';
import { buildSearchResult, chooseActivity, rank, rankingHash } from './search.js';
import { ActivityValidationError, validateActivity } from './ui/activity-catalog.js';
import {
  type ActivityContext,
  type ActivitySpec,
  AssessAttemptInputSchema,
  AssessAttemptOutputSchema,
  CommitEpisodeInputSchema,
  CommitEpisodeOutputSchema,
  type ContextCommit,
  ContextCommitSchema,
  type Decision,
  type LearningCase,
  RunPhaseSchema,
  type SearchLearningCasesInput,
  SearchLearningCasesInputSchema,
  type SearchResult,
  SearchResultSchema,
  type Strategy,
  SupportActivityContextSchema,
  TEMPLATE_KIND,
  type TemplateId,
  ToolNameSchema,
  validateCase,
} from './domain.js';
import {
  GetPersonalMemoryInputSchema,
  GetPersonalMemoryOutputSchema,
  MAX_MEMORY_CASES_PER_CONCEPT,
  ProblemSchema,
  PublishActivityInputSchema,
  PublishActivityOutputSchema,
  type Activity,
  type Concept,
  type ConceptLink,
  type GetPersonalMemoryOutput,
  type MemoryCase,
  type MemorySummary,
  type Problem,
  type PublishActivityInput,
  type PublishActivityOutput,
  type RunState,
  type ToolName,
  type ToolResult,
} from './domain.js';
import { INVITATION_COPY } from './copy.js';
import type { EventPayload } from './events.js';
import { selectProblems } from './problems.js';
import { DomainError, type Store, type StudentCase, type TransitionContext } from './store.js';

// The only concept `invitation_addition` can announce. A subtraction lesson ends without an invitation.
export const INVITATION_TODAY_CONCEPT = 'addition_within_20' as const satisfies Concept;
const MAX_ERROR_MESSAGE_CHARS = 300;

// What the runtime binds to a tool call. It comes from the actual thread binding, never from model arguments.
export type ToolContext = Pick<RunState, 'studentId' | 'corpusHash' | 'phase' | 'cancellationEpoch'> & {
  runId: string;
  revision: number;
  threadId: string | null;
  turnId: string | null;
};

// ---------------------------------------------------------------------------------------------
// Result plumbing

// Parses what the model sent. Only this parse reports INVALID_INPUT: a schema failure anywhere else is a
// fault in stored data or in the handler and must surface as an error, not as the model's mistake.
function parseInput<S extends z.ZodType>(schema: S, raw: unknown): z.output<S> {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  throw new DomainError('INVALID_INPUT', parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
}

function failure(tool: ToolName, error: unknown): ToolResult | null {
  if (error instanceof DomainError) {
    return {
      ok: false,
      tool,
      error: { code: error.code, message: error.message.slice(0, MAX_ERROR_MESSAGE_CHARS), retryable: error.retryable, ...(error.revision === undefined ? {} : { revision: error.revision }) },
      contextCommit: null,
    };
  }
  return null;
}

// A validation or domain failure becomes a visible result; any other error is infrastructure and is rethrown.
async function runTool(tool: ToolName, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (error) {
    const result = failure(tool, error);
    if (result) return result;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// T1: get_personal_memory

// Counts every case of a concept, not only the ones returned, so early difficulty never hides later
// success. An empty history yields zeros and null dates: no recorded experience, never inability.
export function summarizeCases(concept: Concept, link: MemorySummary['link'], cases: readonly StudentCase[]): MemorySummary {
  const count = (outcome: StudentCase['outcome']) => cases.filter((c) => c.outcome === outcome).length;
  const dates = cases.map((c) => c.createdAt).sort();
  return {
    conceptId: concept,
    link,
    total: cases.length,
    independent: count('independent'),
    assisted: count('assisted'),
    failed: count('failed'),
    notAssessed: count('not_assessed'),
    firstAt: dates[0] ?? null,
    lastAt: dates[dates.length - 1] ?? null,
  };
}

// `cases` arrive newest first with ID tie-break; unassessed records are kept only when asked for.
export function selectReturnedCases(cases: readonly StudentCase[], includeUnassessed: boolean): MemoryCase[] {
  return cases
    .filter((c) => includeUnassessed || c.outcome !== 'not_assessed')
    .slice(0, MAX_MEMORY_CASES_PER_CONCEPT)
    .map((c) => ({ caseId: c.id, concept: c.concept, strategy: c.strategy, outcome: c.outcome, retention: 'pending' as const, nodeIds: c.nodeIds }));
}

export async function getPersonalMemory(store: Store, context: ToolContext, rawInput: unknown): Promise<ToolResult> {
  return runTool('get_personal_memory', async () => {
    const input = parseInput(GetPersonalMemoryInputSchema, rawInput);
    const links = await store.getConceptLinks();
    const [today, other] = input.conceptIds;
    if (today === undefined) throw new DomainError('INVALID_INPUT', 'conceptIds needs today\'s concept');
    const related = resolveRelatedLeaf(today, links);
    if (other !== undefined && (related === null || related.leaf !== other)) {
      throw new DomainError('VALIDATION_FAILED', `conceptIds[1] ${other} is not linked to ${today}`);
    }
    const lookups: { concept: Concept; link: MemorySummary['link'] }[] = [{ concept: today, link: 'today' }];
    if (other !== undefined && related !== null) lookups.push({ concept: other, link: related.link });

    const cases: MemoryCase[] = [];
    const summaries: MemorySummary[] = [];
    for (const { concept, link } of lookups) {
      const all = await store.listStudentCases(context.runId, context.studentId, concept);
      summaries.push(summarizeCases(concept, link, all));
      cases.push(...selectReturnedCases(all, input.includeUnassessed));
    }
    const data: GetPersonalMemoryOutput = GetPersonalMemoryOutputSchema.parse({
      memorySnapshotId: `mem_${compactSha256({ runId: context.runId, corpusHash: context.corpusHash, studentId: context.studentId, conceptIds: input.conceptIds, includeUnassessed: input.includeUnassessed, caseIds: cases.map((c) => c.caseId) }).slice(0, 16)}`,
      studentId: context.studentId,
      corpusHash: context.corpusHash,
      cases,
      summaries,
      unassessedConceptIds: summaries.filter((s) => s.total - s.notAssessed === 0).map((s) => s.conceptId),
    });
    return { ok: true, tool: 'get_personal_memory', data };
  });
}

// The `memory.retrieved` payload from every memory read of a run, so an inspector shows the returned
// cases, their summaries and the curriculum links without a second read. Null when nothing was read.
export function memoryRetrievedPayload(results: readonly GetPersonalMemoryOutput[], links: readonly ConceptLink[]): EventPayload<'memory.retrieved'> | null {
  if (results.length === 0) return null;
  const latestSummary = new Map<Concept, MemorySummary>();
  const caseIds: string[] = [];
  for (const result of results) {
    for (const summary of result.summaries) latestSummary.set(summary.conceptId, summary);
    for (const c of result.cases) if (!caseIds.includes(c.caseId)) caseIds.push(c.caseId);
  }
  const summaries = [...latestSummary.values()];
  return { conceptIds: summaries.map((s) => s.conceptId), caseIds, summaries, links: [...links] };
}

// ---------------------------------------------------------------------------------------------
// T3 (invitation only): publish_activity

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const NUMBER_PATTERN = `\\d{1,2}|${NUMBER_WORDS.join('|')}`;
const STATED_SUM = new RegExp(`\\b(${NUMBER_PATTERN})\\s*(?:\\+|plus)\\s*(${NUMBER_PATTERN})\\b`, 'gi');

const toNumber = (token: string) => (/^\d+$/.test(token) ? Number(token) : NUMBER_WORDS.indexOf(token.toLowerCase()));

// Additions the lesson itself states, as digits ("7 + 4") or words ("Seven plus four"). The run never
// practices these, so the child meets new problems rather than ones just shown.
export function extractLessonProblems(lessonText: string): Problem[] {
  const found: Problem[] = [];
  for (const match of lessonText.matchAll(STATED_SUM)) {
    const parsed = ProblemSchema.safeParse({ lhs: toNumber(match[1] ?? ''), rhs: toNumber(match[2] ?? '') });
    if (parsed.success && !found.some((p) => p.lhs === parsed.data.lhs && p.rhs === parsed.data.rhs)) found.push(parsed.data);
  }
  return found;
}

export type InvitationCheck = { failures: string[]; usesLinkedConcept: boolean };

type InvitationFacts = {
  input: Pick<PublishActivityInput, 'todayConceptId' | 'quotes' | 'evidenceIds'>;
  lessonText: string;
  // Cases returned by this run's personal-memory reads, by case ID.
  returnedCases: ReadonlyMap<string, MemoryCase>;
  links: readonly ConceptLink[];
};

const clip = (text: string) => (text.length > 40 ? `${text.slice(0, 40)}…` : text);

// The three eligibility conditions, evaluated together so one correction can fix every problem. Any
// outcome is eligible: prior failure or assistance is not required.
export function checkInvitation({ input, lessonText, returnedCases, links }: InvitationFacts): InvitationCheck {
  const failures: string[] = [];
  if (input.todayConceptId !== INVITATION_TODAY_CONCEPT) failures.push(`Condition 1: todayConceptId must be ${INVITATION_TODAY_CONCEPT}`);
  for (const quote of input.quotes ?? []) {
    if (!lessonText.includes(quote)) failures.push(`Condition 1: quote "${clip(quote)}" is not in the saved lesson`);
  }
  if (new Set(input.evidenceIds).size !== input.evidenceIds.length) failures.push('Condition 2: evidenceIds must be distinct');
  const unreturned = input.evidenceIds.filter((id) => !returnedCases.has(id));
  if (unreturned.length > 0) failures.push(`Condition 2: ${unreturned.join(', ')} not returned by get_personal_memory in this run`);

  const today = input.todayConceptId ?? INVITATION_TODAY_CONCEPT;
  const linked = resolveRelatedLeaf(today, links)?.leaf;
  const eligibleConcepts = new Set<Concept>(linked === undefined ? [today] : [today, linked]);
  const misplaced = input.evidenceIds.filter((id) => {
    const concept = returnedCases.get(id)?.concept;
    return concept !== undefined && !eligibleConcepts.has(concept);
  });
  if (misplaced.length > 0) failures.push(`Condition 3: ${misplaced.join(', ')} is on a concept that is neither ${today} nor linked to it`);

  const usesLinkedConcept = input.evidenceIds.some((id) => {
    const concept = returnedCases.get(id)?.concept;
    return concept !== undefined && concept !== today;
  });
  return { failures, usesLinkedConcept };
}

// Public copy is chosen here, never by the model: the linked wording only when subtraction evidence was
// actually retrieved.
export function invitationCopy(usesLinkedConcept: boolean): Pick<Activity, 'title' | 'body' | 'primaryLabel' | 'secondaryLabel'> {
  return {
    title: INVITATION_COPY.title,
    body: usesLinkedConcept ? INVITATION_COPY.bodyLinkedConcept : INVITATION_COPY.bodySameConcept,
    primaryLabel: INVITATION_COPY.accept,
    secondaryLabel: INVITATION_COPY.later,
  };
}

const failedCondition = (failures: readonly string[]) => failures.join('; ');

// Validates the invitation against the saved lesson and this run's memory reads, then commits the
// activity, its events, the receipt, the outbox row and the revision bump as one transaction.
async function publishInvitation(store: Store, context: ToolContext, input: PublishActivityInput): Promise<PublishActivityOutput> {
  const { result } = await store.transition({
    runId: context.runId,
    commandKey: `publish_activity:${input.expectedRevision}`,
    body: input,
    expectedRevision: input.expectedRevision,
    resultSchema: PublishActivityOutputSchema,
    apply: async (current) => {
      const { state } = current;
      if (state.stopped || state.phase !== 'INGESTING') throw new DomainError('WRONG_PHASE', `An invitation cannot be published in ${state.phase}`, { revision: current.revision });
      if (state.cancellationEpoch !== context.cancellationEpoch) throw new DomainError('CANCELLED', 'This operation was superseded by a newer one', { revision: current.revision });
      if (input.templateId !== 'invitation_addition' || input.strategy !== null || input.problem !== null || input.explanationRevision !== null) {
        throw new DomainError('VALIDATION_FAILED', 'An invitation uses template invitation_addition with no strategy, problem or explanation revision');
      }
      if (state.lesson === null) throw new DomainError('VALIDATION_FAILED', 'Condition 1: there is no saved lesson to quote');

      const memoryEvents = await current.eventsOfType('tool.completed');
      const memoryResults = memoryEvents.flatMap((e) => (e.payload.result.tool === 'get_personal_memory' ? [e.payload.result.data] : []));
      const returnedCases = new Map(memoryResults.flatMap((r) => r.cases).map((c) => [c.caseId, c]));
      const links = await store.getConceptLinks();
      const check = checkInvitation({ input, lessonText: state.lesson.text, returnedCases, links });
      if (check.failures.length > 0) throw new DomainError('VALIDATION_FAILED', failedCondition(check.failures));

      const lessonProblems = state.lessonProblems ?? extractLessonProblems(state.lesson.text);
      // The pair is drawn once, before the invitation is published, and never redrawn.
      const selectedProblems = state.selectedProblems ?? selectProblems(state.seed, lessonProblems);

      const revision = current.revision + 1;
      const activity: Activity = {
        id: `${context.runId}_invitation`,
        revision,
        runId: context.runId,
        kind: 'invitation',
        templateId: 'invitation_addition',
        strategy: null,
        problem: null,
        ...invitationCopy(check.usesLinkedConcept),
        activitySpec: null,
        specHash: null,
        helperCount: 0,
        evidenceIds: input.evidenceIds,
        decisionSummary: input.decisionSummary,
      };
      const notificationId = `${context.runId}_notification_${revision}`;
      const memory = memoryRetrievedPayload(memoryResults, links);
      return {
        state: { ...state, phase: 'INVITED', lessonProblems, selectedProblems, invitation: activity, activity },
        events: [
          ...(memory ? [{ type: 'memory.retrieved' as const, payload: memory }] : []),
          { type: 'activity.published' as const, payload: { activity } },
          { type: 'notification.queued' as const, payload: { notificationId, runId: context.runId, activityId: activity.id, activityRevision: revision } },
        ],
        activities: [activity],
        outbox: [{ notificationId, runId: context.runId, activityId: activity.id, activityRevision: revision, transport: 'simulator', status: 'pending', attemptCount: 0, createdAt: current.now, lastErrorCode: null }],
        result: (written) => ({ activity, newRevision: revision, eventSeq: written.find((e) => e.type === 'activity.published')?.seq ?? current.seq + 1, notificationId }),
      };
    },
  });
  return result;
}

// For support, retry and clarification, a spec where the kind allows none (or none where it needs one) is
// unsupported teaching the model must correct, so it is a validation failure rather than invalid input.
// Null when the request is not one of those kinds or parses cleanly.
function parseTeachingRequest(raw: unknown): PublishActivityInput | null {
  const kind = z.object({ kind: z.enum(['support', 'retry', 'clarification']) }).safeParse(raw);
  if (!kind.success) return null;
  const parsed = PublishActivityInputSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const specIssues = parsed.error.issues.filter((i) => i.path[0] === 'activitySpec' && i.code === 'custom');
  if (specIssues.length === 0 || specIssues.length !== parsed.error.issues.length) return null;
  throw new DomainError('VALIDATION_FAILED', `${specIssues.map((i) => i.message).join('; ')}: a ${kind.data.kind} activity is built by the application`);
}

// Wakes the notification dispatcher after a commit that wrote an outbox row; its own backstop timer
// covers a missed kick.
export type OutboxKick = { kick(): void };

export async function publishActivity(store: Store, context: ToolContext, rawInput: unknown, outbox: OutboxKick | null = null): Promise<ToolResult> {
  return runTool('publish_activity', async () => {
    const input = parseTeachingRequest(rawInput) ?? parseInput(PublishActivityInputSchema, rawInput);
    if (input.kind !== 'invitation') return { ok: true, tool: 'publish_activity', data: await publishTeachingActivity(store, context, input) };
    const data = await publishInvitation(store, context, input);
    outbox?.kick();
    return { ok: true, tool: 'publish_activity', data };
  });
}

// ---------------------------------------------------------------------------------------------
// Shared guards for the explanation and verification tools

// A result for a stopped run, an older cancellation epoch or a superseded explanation is a stale model
// result: it may be kept as trace evidence but never changes learning state.
function assertCurrent(state: RunState, context: ToolContext, revision: number, explanationRevision: number | null = null): void {
  if (state.stopped || state.cancellationEpoch !== context.cancellationEpoch || (explanationRevision !== null && explanationRevision !== state.explanationRevision)) {
    throw new DomainError('CANCELLED', 'Stale model result', { revision });
  }
}

const asValidationFailure = (error: unknown): unknown =>
  error instanceof GraphProposalError || error instanceof ActivityValidationError || (error instanceof Error && !(error instanceof DomainError) && !(error instanceof z.ZodError))
    ? new DomainError('VALIDATION_FAILED', error.message.slice(0, MAX_ERROR_MESSAGE_CHARS))
    : error;

// ---------------------------------------------------------------------------------------------
// T2: search_learning_cases. Commits the context graph, then searches; the two results stay separate so
// a failed search keeps the committed context.

const SEARCH_ATTEMPTS = 2;

// The context graph of the current explanation, joined to earlier rounds when there are any.
function buildQuery(state: RunState, runId: string, input: SearchLearningCasesInput, createdAt: string): LearningCase {
  const attempt = explainedAttempt(state);
  if (state.explanation === null || attempt === null) throw new DomainError('WRONG_PHASE', 'There is no explanation to interpret');
  const id = contextCaseId(runId, input.explanationRevision);
  const current = contextCase({ id, studentId: state.studentId, createdAt, attempt, explanation: state.explanation.text, proposal: { interpretations: input.interpretations, needsClarification: input.needsClarification } });
  const joined = state.graph && state.graph.id !== id ? appendClarification(current, state.graph, questionForExplanation(state)) : current;
  return input.retrievalContext ? validateCase({ ...joined, retrievalContext: input.retrievalContext }) : joined;
}

async function commitContext(store: Store, context: ToolContext, input: SearchLearningCasesInput): Promise<ContextCommit> {
  const { revision } = await store.getRun(context.runId);
  const { result, replayed } = await store.transition({
    runId: context.runId,
    commandKey: `search_learning_cases:${input.explanationRevision}`,
    body: input,
    expectedRevision: revision,
    resultSchema: ContextCommitSchema,
    apply: (current) => {
      const { state } = current;
      assertCurrent(state, context, current.revision, input.explanationRevision);
      if (state.phase !== 'PROCESSING') throw new DomainError('WRONG_PHASE', `Context cannot be committed in ${state.phase}`, { revision: current.revision });
      let graph: LearningCase;
      try {
        graph = buildQuery(state, context.runId, input, current.now);
      } catch (error) {
        throw asValidationFailure(error);
      }
      return {
        state: { ...state, graph, search: null },
        events: [{ type: 'context.committed', payload: { caseId: graph.id, explanationRevision: input.explanationRevision, graph } }],
        cases: [graph],
        result: (written) => ({
          caseId: graph.id,
          explanationRevision: input.explanationRevision,
          eventSeq: written.find((e) => e.type === 'context.committed')?.seq ?? current.seq + 1,
          nodeIds: graph.nodes.map((n) => n.id),
          edgeIds: graph.edges.map((e) => e.id),
          replayed: false,
        }),
      };
    },
  });
  return { ...result, replayed };
}

async function rankAgainstCorpus(store: Store, runId: string, query: LearningCase, needsClarification: boolean): Promise<SearchResult> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= SEARCH_ATTEMPTS; attempt += 1) {
    try {
      const ranked = rank(query, await store.getPinnedCases(runId));
      const decision = chooseActivity(query, ranked, needsClarification);
      return buildSearchResult({ query, corpusHash: (await store.getPinnedCorpus(runId)).corpusHash, ranked, decision, rankingHash: await rankingHash(ranked) });
    } catch (error) {
      lastError = error;
      // Only a transient store failure is worth one more try; an oversized or invalid result is final.
      if (!(error instanceof DomainError && error.retryable)) break;
    }
  }
  throw lastError;
}

const SearchCompletionSchema = z.strictObject({ search: SearchResultSchema, expectedRevision: z.number().int().min(0), phase: RunPhaseSchema });

// Saves the search with its events and applies the run limits: a question past the last clarification
// round, or a third teaching activity, pauses the run in NEEDS_SUPPORT instead.
async function commitSearch(store: Store, context: ToolContext, input: SearchLearningCasesInput, commit: ContextCommit): Promise<z.infer<typeof SearchCompletionSchema>> {
  const run = await store.getRun(context.runId);
  assertCurrent(run.state, context, run.revision, input.explanationRevision);
  const query = run.state.graph;
  if (query === null || query.id !== commit.caseId) throw new DomainError('CANCELLED', 'Stale model result', { revision: run.revision });
  const search = run.state.search?.queryId === query.id ? run.state.search : await rankAgainstCorpus(store, context.runId, query, input.needsClarification);
  const { result } = await store.transition({
    runId: context.runId,
    commandKey: `search_completed:${input.explanationRevision}`,
    body: { caseId: commit.caseId },
    expectedRevision: run.revision,
    resultSchema: SearchCompletionSchema,
    apply: (current) => {
      const { state } = current;
      assertCurrent(state, context, current.revision, input.explanationRevision);
      if (state.phase !== 'PROCESSING' || state.graph?.id !== query.id) throw new DomainError('CANCELLED', 'Stale model result', { revision: current.revision });
      const paused = decisionExceedsLimits(state, search.decision);
      const queryNodeIds = query.retrievalContext?.nodeIds ?? query.nodes.filter((n) => n.stage === 'context').map((n) => n.id);
      const next: RunState = paused ? { ...state, search, phase: 'NEEDS_SUPPORT', continuationAllowed: false } : { ...state, search };
      return {
        state: next,
        events: [
          { type: 'search.started', payload: { matchingVersion: search.matchingVersion, queryId: search.queryId, candidateCount: search.candidateCount, queryNodeIds } },
          { type: 'search.completed', payload: search },
        ],
        result: { search, expectedRevision: current.revision + 1, phase: next.phase },
      };
    },
  });
  return result;
}

const SUPPORT_TEMPLATES = ['make_ten_blocks', 'anchor_start_number_line'] as const satisfies readonly TemplateId[];

// The support activity the decision allows, as the record publish_activity would store, so its
// validation context is derived exactly as it will be at publication.
function plannedSupport(runId: string, state: RunState, decision: Decision, expectedRevision: number): { draft: ActivityDraft; context: ActivityContext } | null {
  const problem = state.selectedProblems?.initial;
  const templateId = SUPPORT_TEMPLATES.find((t) => t === decision.templateId);
  if (!problem || templateId === undefined) return null;
  const draft: ActivityDraft = { runId, id: activityIdOf.support(runId, state.explanationRevision), revision: expectedRevision + 1, templateId, strategy: decision.strategy, problem, spec: null, evidenceIds: [], decisionSummary: '' };
  // The context offers every decision evidence ID; the published activity cites the few the composer chose.
  return { draft, context: { ...activityContextOf(buildActivity(draft)), evidenceIds: decision.evidenceIds } };
}

function supportContext(runId: string, state: RunState, decision: Decision, expectedRevision: number): ActivityContext | null {
  return plannedSupport(runId, state, decision, expectedRevision)?.context ?? null;
}

// A proposal that breaks an interpretation rule (unknown meaning, novel naming, relation) is a validation
// failure the model can correct; any other malformed field is invalid input.
function parseProposal(raw: unknown): SearchLearningCasesInput {
  const parsed = SearchLearningCasesInputSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const proposalIssues = parsed.error.issues.filter((i) => i.path[0] === 'interpretations');
  if (proposalIssues.length === 0) return parseInput(SearchLearningCasesInputSchema, raw);
  throw new DomainError('VALIDATION_FAILED', proposalIssues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ').slice(0, MAX_ERROR_MESSAGE_CHARS));
}

export async function searchLearningCases(store: Store, context: ToolContext, rawInput: unknown): Promise<ToolResult> {
  return runTool('search_learning_cases', async () => {
    const input = parseProposal(rawInput);
    const contextCommit = await commitContext(store, context, input);
    let completed: z.infer<typeof SearchCompletionSchema>;
    try {
      completed = await commitSearch(store, context, input, contextCommit);
    } catch (error) {
      if (error instanceof DomainError && error.code === 'CANCELLED') throw error;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_MESSAGE_CHARS);
      return { ok: false, tool: 'search_learning_cases', error: { code: 'SEARCH_FAILED', message, retryable: true }, contextCommit };
    }
    const { state } = await store.getRun(context.runId);
    const activityContext = completed.phase === 'PROCESSING' ? supportContext(context.runId, state, completed.search.decision, completed.expectedRevision) : null;
    return {
      ok: true,
      tool: 'search_learning_cases',
      data: { contextCommit, search: completed.search, publicationContext: { expectedRevision: completed.expectedRevision, activityContext: activityContext && SupportActivityContextSchema.parse(activityContext) } },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// T3 (support, retry, clarification): publish exactly the same-run decision

const NO_TEMPLATE_STRATEGIES: readonly Strategy[] = ['reverse_direction', 'repeat_count'];
const MAX_PUBLISHED_EVIDENCE = 5;

// Whether the newest round's only active pattern is a possible new one; such a pattern is always clarified.
const hasActiveNovel = (state: RunState): boolean => state.search?.decision.reason.startsWith('A possible new pattern') === true || (state.graph?.nodes.some((n) => n.meaning === 'novel' && (state.graph?.retrievalContext?.nodeIds.includes(n.id) ?? true)) ?? false);

function checkAgainstDecision(input: PublishActivityInput, decision: Decision, state: RunState): void {
  const fail = (message: string) => {
    throw new DomainError('VALIDATION_FAILED', message);
  };
  if (input.strategy !== null && NO_TEMPLATE_STRATEGIES.includes(input.strategy)) fail(`Strategy ${input.strategy} has no activity template; publish the decision's ${decision.templateId}`);
  if (input.kind === 'support' && hasActiveNovel(state)) fail('A possible new pattern is clarified, never taught: publish clarify_show_steps');
  if (input.kind !== TEMPLATE_KIND[decision.templateId] || input.templateId !== decision.templateId) {
    fail(`Publish exactly the decision: kind ${TEMPLATE_KIND[decision.templateId]}, templateId ${decision.templateId}`);
  }
  if (input.strategy !== decision.strategy && !(input.strategy === null && input.kind !== 'support')) fail(`Strategy must be ${decision.strategy}`);
  const problem = state.selectedProblems?.initial;
  if (input.problem !== null && (problem === undefined || input.problem.lhs !== problem.lhs || input.problem.rhs !== problem.rhs)) fail('The problem is chosen by the application; it differs from this run\'s problem');
  const allowed = new Set(decision.evidenceIds);
  if (new Set(input.evidenceIds).size !== input.evidenceIds.length || input.evidenceIds.some((id) => !allowed.has(id))) fail('evidenceIds must be distinct IDs from the decision evidence');
  if (decision.basis === 'evidence' && input.kind === 'support' && (input.evidenceIds.length < 1 || input.evidenceIds.length > MAX_PUBLISHED_EVIDENCE)) fail('Evidence-based support cites 1 to 5 decision evidence IDs');
}

// Checks the generated spec against the context rebuilt from stored state and returns the activity to store.
function supportActivity(context: ToolContext, state: RunState, input: PublishActivityInput, decision: Decision, revision: number): Activity {
  const planned = plannedSupport(context.runId, state, decision, revision - 1);
  if (planned === null || input.activitySpec === null) throw new DomainError('VALIDATION_FAILED', 'Support needs a supported decision and an activitySpec');
  let spec: ActivitySpec;
  try {
    spec = validateActivity(input.activitySpec, planned.context);
  } catch (error) {
    throw asValidationFailure(error);
  }
  const sameEvidence = spec.evidenceIds.length === input.evidenceIds.length && spec.evidenceIds.every((id) => input.evidenceIds.includes(id));
  if (!sameEvidence) throw new DomainError('VALIDATION_FAILED', 'activitySpec.evidenceIds and evidenceIds must name the same cases');
  return buildActivity({ ...planned.draft, revision, spec, evidenceIds: input.evidenceIds, decisionSummary: input.decisionSummary });
}

function appActivity(context: ToolContext, state: RunState, input: PublishActivityInput, decision: Decision, revision: number): Activity {
  const problem = state.selectedProblems?.initial;
  if (!problem) throw new DomainError('WRONG_PHASE', 'The run has no problem yet');
  const isRetry = input.kind === 'retry';
  const templateId = decision.templateId === 'manipulation_retry' || decision.templateId === 'clarify_first_number' || decision.templateId === 'clarify_show_steps' ? decision.templateId : null;
  if (templateId === null) throw new DomainError('VALIDATION_FAILED', `Template ${decision.templateId} is not built by the application`);
  const id = isRetry ? activityIdOf.retry(context.runId, state.explanationRevision) : activityIdOf.clarification(context.runId, state.explanationRevision);
  return buildActivity({ runId: context.runId, id, revision, templateId, strategy: decision.strategy, problem, spec: null, evidenceIds: [], decisionSummary: input.decisionSummary });
}

async function publishTeachingActivity(store: Store, context: ToolContext, input: PublishActivityInput): Promise<PublishActivityOutput> {
  try {
    const { result } = await store.transition({
      runId: context.runId,
      commandKey: `publish_activity:${input.expectedRevision}`,
      body: input,
      expectedRevision: input.expectedRevision,
      resultSchema: PublishActivityOutputSchema,
      apply: (current) => {
        const { state } = current;
        assertCurrent(state, context, current.revision);
        if (state.phase !== 'PROCESSING') throw new DomainError('WRONG_PHASE', `A ${input.kind} activity cannot be published in ${state.phase}`, { revision: current.revision });
        if (input.explanationRevision !== state.explanationRevision) throw new DomainError('VALIDATION_FAILED', `explanationRevision must be ${state.explanationRevision}`);
        const decision = state.search?.queryId === contextCaseId(context.runId, state.explanationRevision) ? state.search.decision : null;
        if (decision === null) throw new DomainError('VALIDATION_FAILED', 'Call search_learning_cases for this explanation before publishing');
        checkAgainstDecision(input, decision, state);
        const revision = current.revision + 1;
        const activity = input.kind === 'support' ? supportActivity(context, state, input, decision, revision) : appActivity(context, state, input, decision, revision);
        const teaching = activity.kind === 'support' || activity.kind === 'retry';
        const next: RunState = teaching
          ? { ...state, phase: 'PRACTICE', activity, interventionCount: state.interventionCount + 1 }
          : { ...state, phase: 'CLARIFY', activity, clarificationRounds: state.clarificationRounds + 1 };
        return {
          state: next,
          events: [{ type: 'activity.published', payload: { activity } }],
          activities: [activity],
          result: (written) => ({ activity, newRevision: revision, eventSeq: written.find((e) => e.type === 'activity.published')?.seq ?? current.seq + 1, notificationId: null }),
        };
      },
    });
    return result;
  } catch (error) {
    // A revision that moved under the model (a correction or stop) is a stale request, not a conflict to retry.
    if (error instanceof DomainError && error.code === 'STALE_REVISION') throw new DomainError('VALIDATION_FAILED', `expectedRevision is stale: ${error.message}; search again for the current explanation`, { revision: error.revision });
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// T4: assess_attempt. The command handler graded the attempt at submission with the activity's own
// rubric; this returns that saved assessment and rejects a criterion that disagrees with the activity.

export async function assessAttempt(store: Store, context: ToolContext, rawInput: unknown): Promise<ToolResult> {
  return runTool('assess_attempt', async () => {
    const input = parseInput(AssessAttemptInputSchema, rawInput);
    const run = await store.getRun(context.runId);
    assertCurrent(run.state, context, run.revision);
    const saved = run.state.attempts.find((a) => a.id === input.attemptId);
    if (!saved) throw new DomainError('VALIDATION_FAILED', `Attempt ${input.attemptId} is not part of this run`);
    if (saved.criterion !== input.criterion) throw new DomainError('VALIDATION_FAILED', `Attempt ${saved.id} answers a ${saved.criterion} activity, not ${input.criterion}`);
    const activity = await store.getActivity(context.runId, saved.activityId, saved.activityRevision);
    if (!activity) throw new DomainError('VALIDATION_FAILED', `Activity ${saved.activityId} is not part of this run`);
    let assessment = saved.assessment;
    if (assessment === null) {
      try {
        assessment = { attemptId: saved.id, ...assess(saved.attempt, activity, saved.criterion) };
      } catch (error) {
        if (error instanceof AssessmentError) throw new DomainError('VALIDATION_FAILED', error.message);
        throw error;
      }
    }
    return { ok: true, tool: 'assess_attempt', data: AssessAttemptOutputSchema.parse(assessment) };
  });
}

// ---------------------------------------------------------------------------------------------
// T5: commit_episode. The outcome is built from stored attempts and assessments, never from the model.

const OUTCOME_CASE_SUFFIX = '_outcome';

// Strategies of the teaching activities the child actually worked on, in order.
async function practicedStrategies(current: TransitionContext): Promise<Strategy[]> {
  const published = new Map((await current.eventsOfType('activity.published')).map((e) => [`${e.payload.activity.id}|${e.payload.activity.revision}`, e.payload.activity]));
  const strategies: Strategy[] = [];
  const seen = new Set<string>();
  for (const attempt of current.state.attempts.filter((a) => a.criterion === 'support')) {
    const key = `${attempt.activityId}|${attempt.activityRevision}`;
    const strategy = published.get(key)?.strategy;
    if (!seen.has(key) && strategy) strategies.push(strategy);
    seen.add(key);
  }
  return strategies;
}

export async function commitEpisode(store: Store, context: ToolContext, rawInput: unknown): Promise<ToolResult> {
  return runTool('commit_episode', async () => {
    const input = parseInput(CommitEpisodeInputSchema, rawInput);
    const { result } = await store.transition({
      runId: context.runId,
      commandKey: `commit_episode:${input.independentAttemptId}`,
      // The receipt is keyed by the attempts; a repeat with a newer revision still returns it.
      body: { independentAttemptId: input.independentAttemptId, supportAttemptId: input.supportAttemptId },
      expectedRevision: input.expectedRevision,
      resultSchema: CommitEpisodeOutputSchema,
      apply: async (current) => {
        const { state } = current;
        assertCurrent(state, context, current.revision);
        if (state.phase !== 'VERIFY') throw new DomainError('WRONG_PHASE', `An episode cannot be committed in ${state.phase}`, { revision: current.revision });
        const independent = state.attempts.find((a) => a.id === input.independentAttemptId);
        if (!independent || independent.criterion !== 'independent' || independent.activityId !== state.activity?.id) throw new DomainError('VALIDATION_FAILED', `Attempt ${input.independentAttemptId} is not this run's independent check`);
        if (independent.assessment === null) throw new DomainError('VALIDATION_FAILED', `Attempt ${independent.id} has no saved assessment`);
        const support = state.attempts.findLast((a) => a.criterion === 'support' && a.assessment?.passed === true);
        if ((support?.id ?? null) !== input.supportAttemptId) throw new DomainError('VALIDATION_FAILED', `supportAttemptId must be ${support?.id ?? 'null'}, the practice attempt that passed`);
        const [first, ...rest] = await practicedStrategies(current);
        if (state.graph === null || first === undefined) throw new DomainError('VALIDATION_FAILED', 'The run has no accepted activity chain to commit');
        const outcome = episodeOutcome(independent.assessment);
        const evaluation = JSON.stringify({ independentAttemptId: independent.id, supportAttemptId: input.supportAttemptId, assessment: independent.assessment });
        const renamed = renameCase(state.graph, `${context.runId}${OUTCOME_CASE_SUFFIX}`);
        const episode = addResult({ ...renamed, createdAt: current.now }, { strategies: [first, ...rest], outcome, evaluation });
        const source = episode.sources.find((s) => s.id === `${episode.id}:evaluation`);
        if (!source) throw new Error('The result layer has no evaluation source');
        const revision = current.revision + 1;
        return {
          state: { ...state, phase: outcome === 'independent' ? 'COMPLETE' : 'NEEDS_SUPPORT', continuationAllowed: false, graph: episode },
          events: [
            {
              type: 'outcome.committed',
              payload: { queryId: state.graph.id, persistedCaseId: episode.id, strategy: episode.strategy, outcome, saved: true, nodes: episode.nodes.filter((n) => n.stage === 'result'), edges: episode.edges.filter((e) => e.stage === 'result'), source },
            },
          ],
          cases: [episode],
          result: (written) => ({ caseId: episode.id, strategy: episode.strategy, outcome, retention: 'pending' as const, newRevision: revision, eventSeq: written.find((e) => e.type === 'outcome.committed')?.seq ?? current.seq + 1 }),
        };
      },
    });
    return { ok: true, tool: 'commit_episode', data: result };
  });
}

// ---------------------------------------------------------------------------------------------
// Dispatch: the one entry the runtime adapter calls for a model tool request.

export type ToolDeps = { store: Store; outbox: OutboxKick | null };

export async function callTool({ store, outbox }: ToolDeps, context: ToolContext, name: string, args: unknown): Promise<ToolResult> {
  const tool = ToolNameSchema.safeParse(name);
  if (!tool.success) throw new DomainError('UNKNOWN_TOOL', `Unknown tool ${name.slice(0, 80)}`);
  switch (tool.data) {
    case 'get_personal_memory':
      return getPersonalMemory(store, context, args);
    case 'search_learning_cases':
      return searchLearningCases(store, context, args);
    case 'publish_activity':
      return publishActivity(store, context, args, outbox);
    case 'assess_attempt':
      return assessAttempt(store, context, args);
    case 'commit_episode':
      return commitEpisode(store, context, args);
  }
}
