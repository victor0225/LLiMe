// Deterministic tool handlers. The model proposes; these functions validate against stored facts and are
// the only code that changes learning state. This module holds the personal-memory read and the
// invitation publication; the other tools extend it.
import { z } from 'zod';
import { compactSha256, resolveRelatedLeaf } from './dataset.js';
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
import { DomainError, type Store, type StudentCase } from './store.js';

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

export async function publishActivity(store: Store, context: ToolContext, rawInput: unknown): Promise<ToolResult> {
  return runTool('publish_activity', async () => {
    const input = parseInput(PublishActivityInputSchema, rawInput);
    if (input.kind !== 'invitation') throw new DomainError('VALIDATION_FAILED', `Publishing a ${input.kind} activity is not available yet`);
    return { ok: true, tool: 'publish_activity', data: await publishInvitation(store, context, input) };
  });
}
