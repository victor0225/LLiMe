// The run engine: every learning phase change, its guards and its after-commit effects. The policy at
// the top is pure. The handlers below commit each change, with its events and receipt, as one
// transaction, and only after that commit tell the runtime what to do next.
import { z } from 'zod';
import { assess, AssessmentError, type AssessmentResult } from './assessment.js';
import { ACTIVITY_COPY, STUDENT_COPY } from './copy.js';
import { compactSha256 } from './dataset.js';
import {
  type Activity,
  type ActivityContext,
  type ActivitySpec,
  type AnyAttempt,
  type Attempt,
  AttemptSchema,
  CATALOG_VERSION,
  type Command,
  CommandSchema,
  type Criterion,
  type Decision,
  type ErrorCode,
  type ExplanationRecord,
  ExplanationRecordSchema,
  ExplanationTextSchema,
  IdSchema,
  type MakeTenAttempt,
  type Outcome,
  MakeTenAttemptSchema,
  type Problem,
  type RunPhase,
  type RunState,
  type RuntimePhase,
  type SavedAttempt,
  TEMPLATE_KIND,
  type TemplateId,
  type Workspace,
} from './domain.js';
import type { EventPayload } from './events.js';
import { type AskedQuestion, QUESTION_MEANING } from './graph.js';
import { problemRefOf } from './problems.js';
import { ActivityRenderedCommandSchema, VoiceCommandSchema } from './routes.js';
import { DomainError, type Mutation, type NewEvent, type RunRecord, RunRecordSchema, type Store, type TransitionContext, type VoiceOperationChange } from './store.js';
import { ActivityValidationError, countHelpers, validateActivity } from './ui/activity-catalog.js';

// ---------------------------------------------------------------------------------------------
// Limits

// A child is asked at most this many clarifying questions about one attempt. The next unclear answer
// pauses the run instead of growing the case graph past its source limits.
export const MAX_CLARIFICATION_ROUNDS = 3;
// At most two teaching activities per run, so a child who is still stuck is handed to an adult rather
// than drilled.
export const MAX_INTERVENTIONS = 2;
// Shown on a run whose step a restart cut off; committed work stays visible.
export const RESTART_MESSAGE = 'The server restarted before this step finished. Saved work is preserved; start a new run.';

// ---------------------------------------------------------------------------------------------
// Pure policy

const MAKE_TEN_TEMPLATES: readonly TemplateId[] = ['make_ten_blocks', 'independent_make_ten'];

// The one wrong trace the explanation path interprets: start at a, then a+1 … a+b-1, answer a+b-1.
export function isOneMoveShort(attempt: Attempt, { lhs, rhs }: Problem): boolean {
  return attempt.start === lhs && attempt.moves.length === rhs - 1 && attempt.moves.every((position, i) => position === lhs + i + 1) && attempt.answer === lhs + rhs - 1;
}

export type InitialRoute = Extract<RunPhase, 'ALREADY_CORRECT' | 'EXPLAIN' | 'OUT_OF_SCOPE'>;

// A correct first try ends the run without teaching; the supported wrong trace asks for an explanation;
// anything else is saved but not interpreted.
export function routeInitialAttempt(attempt: Attempt, problem: Problem, assessment: AssessmentResult): InitialRoute {
  if (assessment.passed) return 'ALREADY_CORRECT';
  return isOneMoveShort(attempt, problem) ? 'EXPLAIN' : 'OUT_OF_SCOPE';
}

// The number line only moves one step at a time and never below zero, so any other jump was not observed.
export function isPossibleNumberLineTrace({ start, moves }: Attempt): boolean {
  if (start < 0) return false;
  let position = start;
  for (const next of moves) {
    if (next < 0 || Math.abs(next - position) !== 1) return false;
    position = next;
  }
  return true;
}

// Only the second addend's objects (t0 … t<rhs-1>) can move; the first addend's sit fixed in the box.
export function isPossibleMakeTenAttempt({ placements }: MakeTenAttempt, { rhs }: Problem): boolean {
  return placements.every(({ objectId }) => {
    const index = /^t(0|[1-9][0-9]*)$/.exec(objectId)?.[1];
    return index !== undefined && Number(index) < rhs;
  });
}

export type GradedSubmission = { attempt: AnyAttempt; problem: Problem; assessment: AssessmentResult };

// Grades a submitted attempt with the activity's own rubric and numbers. A trace the controls could not
// have produced, or one the rubric cannot grade, is rejected and never stored with a made-up assessment.
export function gradeSubmission(raw: AnyAttempt, activity: Activity, criterion: Criterion): GradedSubmission {
  const problem = activity.problem;
  if (problem === null) throw new DomainError('VALIDATION_FAILED', `Activity ${activity.id} has no problem to answer`);
  const attempt = MAKE_TEN_TEMPLATES.includes(activity.templateId) ? MakeTenAttemptSchema.safeParse(raw) : AttemptSchema.safeParse(raw);
  if (!attempt.success) throw new DomainError('VALIDATION_FAILED', `The attempt does not fit the ${activity.templateId} activity`);
  const possible = 'placements' in attempt.data ? isPossibleMakeTenAttempt(attempt.data, problem) : isPossibleNumberLineTrace(attempt.data);
  if (!possible) throw new DomainError('VALIDATION_FAILED', 'This trace cannot come from the activity controls');
  try {
    return { attempt: attempt.data, problem, assessment: assess(attempt.data, activity, criterion) };
  } catch (error) {
    if (error instanceof AssessmentError) throw new DomainError('VALIDATION_FAILED', error.message);
    throw error;
  }
}

export type PracticeNext = { phase: 'VERIFY' } | { phase: 'CLARIFY' } | { phase: 'NEEDS_SUPPORT'; continuationAllowed: boolean };

type Counts = Pick<RunState, 'clarificationRounds' | 'interventionCount'>;

// After a practice attempt. A pass (help allowed) moves on to the independent check. A failed retry asks
// which number was counted first while both limits allow. A failed support activity may be explained
// once more, but only when the trace is the one-move-short kind the explanation path can interpret.
export function nextAfterPractice(counts: Counts, activity: Activity, attempt: AnyAttempt, assessment: AssessmentResult): PracticeNext {
  if (assessment.passed) return { phase: 'VERIFY' };
  const interventionsLeft = counts.interventionCount < MAX_INTERVENTIONS;
  if (activity.kind === 'retry') {
    return interventionsLeft && counts.clarificationRounds < MAX_CLARIFICATION_ROUNDS ? { phase: 'CLARIFY' } : { phase: 'NEEDS_SUPPORT', continuationAllowed: false };
  }
  const numberLine = AttemptSchema.safeParse(attempt);
  const explainable = numberLine.success && activity.problem !== null && isOneMoveShort(numberLine.data, activity.problem);
  return { phase: 'NEEDS_SUPPORT', continuationAllowed: interventionsLeft && explainable };
}

// Whether a decision would go past a limit: one more question after the last allowed round, or a third
// teaching activity.
export function decisionExceedsLimits(counts: Counts, decision: Pick<Decision, 'basis'>): boolean {
  return decision.basis === 'clarify' ? counts.clarificationRounds >= MAX_CLARIFICATION_ROUNDS : counts.interventionCount >= MAX_INTERVENTIONS;
}

// The saved outcome of an independent check. Only a hint-free pass with the observed process is
// independent. A right number without that evidence is not assessed, never failed; a wrong answer failed.
export function episodeOutcome(assessment: Pick<AssessmentResult, 'passed' | 'answerCorrect'>): Outcome {
  if (assessment.passed) return 'independent';
  return assessment.answerCorrect ? 'not_assessed' : 'failed';
}

export type ExplainMode = 'first' | 'clarification' | 'continuation' | 'correction';

const hasAttemptFor = (state: RunState, activity: Activity) => state.attempts.some((a) => a.activityId === activity.id && a.activityRevision === activity.revision);

// What an explanation means in the current phase, or null when the phase takes none. A correction is
// only possible while the work it supersedes has produced no submitted evidence.
export function explainModeOf(state: RunState): ExplainMode | null {
  if (state.stopped) return null;
  switch (state.phase) {
    case 'EXPLAIN':
      return 'first';
    case 'CLARIFY':
      return 'clarification';
    case 'NEEDS_SUPPORT':
      return state.continuationAllowed ? 'continuation' : null;
    case 'PROCESSING':
      return 'correction';
    case 'PRACTICE':
      return state.activity !== null && !hasAttemptFor(state, state.activity) ? 'correction' : null;
    default:
      return null;
  }
}

const isClarifyTemplate = (id: TemplateId): id is 'clarify_first_number' | 'clarify_show_steps' => id === 'clarify_first_number' || id === 'clarify_show_steps';

// The question the current explanation answers, read from the activity the child was looking at when
// they answered: a clarification, or the failed support activity on a continuation. A correction or the
// first explanation answers no new question.
export function questionForExplanation(state: RunState): AskedQuestion | null {
  const activity = state.activity;
  if (activity === null || activity.problem === null) return null;
  if (activity.kind === 'clarification' && isClarifyTemplate(activity.templateId)) {
    return { text: ACTIVITY_COPY[activity.templateId](activity.problem).title, meaning: QUESTION_MEANING[activity.templateId] };
  }
  const supportAttempt = activity.kind === 'support' ? state.attempts.findLast((a) => a.activityId === activity.id) : undefined;
  if (supportAttempt) return { text: STUDENT_COPY.howDidYouGet(supportAttempt.attempt.answer), meaning: QUESTION_MEANING.continuation };
  return null;
}

// The observed trace an explanation describes: the latest one-move-short number-line attempt.
export function explainedAttempt(state: RunState): Attempt | null {
  const problem = state.selectedProblems?.initial;
  if (!problem) return null;
  for (const saved of [...state.attempts].reverse()) {
    const parsed = AttemptSchema.safeParse(saved.attempt);
    if ((saved.criterion === 'initial' || saved.criterion === 'support') && parsed.success && isOneMoveShort(parsed.data, problem)) return parsed.data;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Application-built activities. Every child-facing word comes from the copy tables.

export const activityIdOf = {
  initial: (runId: string) => `${runId}_initial`,
  support: (runId: string, explanationRevision: number) => `${runId}_support_${explanationRevision}`,
  retry: (runId: string, explanationRevision: number) => `${runId}_retry_${explanationRevision}`,
  clarification: (runId: string, explanationRevision: number) => `${runId}_clarification_${explanationRevision}`,
  independent: (runId: string) => `${runId}_independent`,
} as const;

export type ActivityDraft = {
  runId: string;
  id: string;
  revision: number;
  templateId: Exclude<TemplateId, 'invitation_addition'>;
  strategy: Activity['strategy'];
  problem: Problem;
  spec: ActivitySpec | null;
  evidenceIds: string[];
  decisionSummary: string;
};

// Builds the stored record; the spec's hash and helper count are computed here, never taken from a client.
export function buildActivity(draft: ActivityDraft): Activity {
  return {
    id: draft.id,
    revision: draft.revision,
    runId: draft.runId,
    kind: TEMPLATE_KIND[draft.templateId],
    templateId: draft.templateId,
    strategy: draft.strategy,
    problem: draft.problem,
    ...ACTIVITY_COPY[draft.templateId](draft.problem),
    activitySpec: draft.spec,
    specHash: draft.spec ? compactSha256(draft.spec) : null,
    helperCount: draft.spec ? countHelpers(draft.spec) : 0,
    evidenceIds: draft.evidenceIds,
    decisionSummary: draft.decisionSummary,
  };
}

const WORKSPACE_OF_TEMPLATE: Partial<Record<TemplateId, Workspace>> = {
  anchor_start_number_line: 'NumberLine',
  independent_number_line: 'NumberLine',
  make_ten_blocks: 'MakeTenWorkspace',
  independent_make_ten: 'MakeTenWorkspace',
};

// The validation context a generated spec must match, derived only from the stored activity.
// TODO: replace with activityContextOf from the activity catalog once that export lands on integration;
// this local version exists only until then.
export function activityContextOf(activity: Activity): ActivityContext {
  const workspace = WORKSPACE_OF_TEMPLATE[activity.templateId];
  const phase = activity.kind === 'support' || activity.kind === 'independent' ? activity.kind : null;
  if (workspace === undefined || phase === null || activity.problem === null) throw new ActivityValidationError(`Activity ${activity.id} has no generated workspace`);
  return { activityId: activity.id, revision: activity.revision, phase, workspace, problemRef: problemRefOf(activity.problem), start: activity.problem.lhs, addend: activity.problem.rhs, evidenceIds: activity.evidenceIds };
}

// The independent check follows the support's representation and has no helpers at all.
function independentDraft(runId: string, revision: number, support: Activity, problem: Problem): ActivityDraft {
  const makeTen = support.templateId === 'make_ten_blocks';
  const workspace = support.activitySpec?.components.find((c) => c.type === 'MakeTenWorkspace');
  const appearance = workspace?.type === 'MakeTenWorkspace' ? workspace.props.appearance : 'apple';
  const id = activityIdOf.independent(runId);
  const spec: ActivitySpec = {
    catalogVersion: CATALOG_VERSION,
    activityId: id,
    revision,
    phase: 'independent',
    problemRef: problemRefOf(problem),
    evidenceIds: [],
    components: makeTen
      ? [{ id: 'box', type: 'MakeTenWorkspace', props: { first: problem.lhs, second: problem.rhs, appearance, highlightEmptySlots: false, showEquation: false } }]
      : [{ id: 'line', type: 'NumberLine', props: { start: problem.lhs, addend: problem.rhs } }],
  };
  const draft: ActivityDraft = { runId, id, revision, templateId: makeTen ? 'independent_make_ten' : 'independent_number_line', strategy: support.strategy, problem, spec, evidenceIds: [], decisionSummary: '' };
  validateActivity(spec, activityContextOf(buildActivity({ ...draft, spec: null })));
  return draft;
}

// ---------------------------------------------------------------------------------------------
// Runtime port: what the engine asks of the agent runtime and voice after a commit.

export type ExplanationTurnInput = {
  explanationRevision: number;
  // The only source an interpretation may quote.
  sourceId: string;
  explanation: string;
  inputMode: ExplanationRecord['inputMode'];
  problem: Problem;
  attempt: Attempt;
  question: string | null;
};

export type VerificationTurnInput = {
  independentAttemptId: string;
  supportAttemptId: string | null;
  activityId: string;
  expectedRevision: number;
};

export type TurnRequest = { runId: string; operationId: string; cancellationEpoch: number } & (
  | { phase: 'explanation'; input: ExplanationTurnInput }
  | { phase: 'verification'; input: VerificationTurnInput }
);

export type RuntimePort = {
  // A new turn in the run's thread.
  startTurn(request: TurnRequest): Promise<void>;
  // Appends to the active turn; false when no turn is active, and the engine then starts one.
  steerTurn(request: TurnRequest): Promise<boolean>;
  interruptTurn(runId: string): Promise<void>;
  closeVoice(runId: string): Promise<void>;
};

type Effect = { kind: 'start' | 'steer_or_start'; request: TurnRequest } | { kind: 'stop_cleanup' };

// ---------------------------------------------------------------------------------------------
// Inputs

export const ExplanationProvenanceSchema = z
  .strictObject({
    inputMode: ExplanationRecordSchema.shape.inputMode,
    liveSessionId: IdSchema.nullable(),
    delegationId: IdSchema.nullable(),
  })
  .refine((p) => p.delegationId === null || p.liveSessionId !== null, { message: 'A delegation requires a Live session', path: ['liveSessionId'] })
  .refine((p) => p.inputMode === 'typed' || p.delegationId !== null, { message: 'A spoken explanation arrives through a delegation', path: ['delegationId'] });
export type ExplanationProvenance = z.infer<typeof ExplanationProvenanceSchema>;

export const ExplanationInputSchema = z.strictObject({
  commandId: z.uuid(),
  revision: z.number().int().min(0),
  text: ExplanationTextSchema,
  provenance: ExplanationProvenanceSchema,
  // The voice operation this explanation starts; defaults to the command ID.
  operationId: IdSchema.optional(),
});
export type ExplanationInput = z.infer<typeof ExplanationInputSchema>;

const TYPED: ExplanationProvenance = { inputMode: 'typed', liveSessionId: null, delegationId: null };

export const OperationSettlementSchema = z.strictObject({
  operationId: IdSchema,
  phase: z.enum(['ingestion', 'explanation', 'verification']),
  cancellationEpoch: z.number().int().min(0),
  // blocked: the model declined; failed: the turn errored, timed out or was interrupted.
  status: z.enum(['completed', 'blocked', 'failed']),
  code: z.enum(['MODEL_TIMEOUT', 'RUNTIME_DISCONNECTED', 'AUTH_REQUIRED', 'UNKNOWN_TOOL', 'VALIDATION_FAILED']).optional(),
  message: z.string().max(300).optional(),
});
export type OperationSettlement = z.infer<typeof OperationSettlementSchema>;

export type CommandOutcome = { run: RunRecord; replayed: boolean };

const parseOrReject = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new DomainError('INVALID_INPUT', parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ').slice(0, 300));
};

const wrongPhase = (ctx: TransitionContext, action: string) =>
  new DomainError('WRONG_PHASE', ctx.state.stopped ? `The run is stopped; ${action} is not accepted` : `${action} is not accepted in ${ctx.state.phase}`, { revision: ctx.revision });

// The latest operation that nothing cancelled or failed yet.
async function latestOpenOperation(ctx: TransitionContext): Promise<EventPayload<'operation.started'> | null> {
  const started = await ctx.eventsOfType('operation.started');
  const closed = new Set([...(await ctx.eventsOfType('operation.cancelled')).map((e) => e.payload.operationId), ...(await ctx.eventsOfType('operation.failed')).map((e) => e.payload.operationId)]);
  const last = started[started.length - 1]?.payload;
  return last && !closed.has(last.operationId) ? last : null;
}

const cancelOperation = (op: EventPayload<'operation.started'>, reason: 'superseded' | 'stopped'): { event: NewEvent; change: VoiceOperationChange } => ({
  event: { type: 'operation.cancelled', payload: { operationId: op.operationId, reason, explanationRevision: op.explanationRevision ?? 0, cancellationEpoch: op.cancellationEpoch } },
  change: { kind: 'status', operationId: op.operationId, status: 'cancelled', expected: ['started', 'steered'], onMismatch: 'skip' },
});

// An independent attempt was submitted and its episode is not saved yet.
const awaitsEpisode = (state: RunState) => state.phase === 'VERIFY' && state.activity !== null && hasAttemptFor(state, state.activity);

// Whether the step this phase is waiting on still lacks its required committed effect.
function requiredEffectPending(state: RunState): boolean {
  return state.phase === 'INGESTING' || state.phase === 'PROCESSING' || awaitsEpisode(state);
}

class AlreadyRendered extends Error {}

type Plan = Omit<Mutation<RunRecord>, 'result'> & { effects?: Effect[] };

// ---------------------------------------------------------------------------------------------
// Engine

export type EngineDeps = { store: Store; runtime: RuntimePort };

export function createEngine({ store, runtime }: EngineDeps) {
  // Commits one planned change and returns the run as committed. Effects are released only for a fresh
  // commit, never for a replayed receipt.
  async function commit(runId: string, commandKey: string, body: unknown, expectedRevision: number, plan: (ctx: TransitionContext) => Plan | Promise<Plan>) {
    let effects: Effect[] = [];
    const { result, replayed } = await store.transition({
      runId,
      commandKey,
      body,
      expectedRevision,
      resultSchema: RunRecordSchema,
      apply: async (ctx) => {
        const { effects: planned = [], ...mutation } = await plan(ctx);
        effects = planned;
        return { ...mutation, result: (written) => ({ id: runId, revision: ctx.revision + 1, seq: ctx.seq + written.length, state: mutation.state }) };
      },
    });
    return { run: result, replayed, effects: replayed ? [] : effects };
  }

  async function release(runId: string, effects: readonly Effect[]): Promise<void> {
    for (const effect of effects) {
      try {
        if (effect.kind === 'stop_cleanup') {
          await runtime.interruptTurn(runId);
          await runtime.closeVoice(runId);
        } else if (effect.kind === 'start' || !(await runtime.steerTurn(effect.request))) {
          await runtime.startTurn(effect.request);
        }
      } catch (error) {
        const message = (error instanceof Error ? error.message : String(error)).slice(0, 300);
        if (effect.kind === 'stop_cleanup') {
          await store.appendEvents(runId, [{ type: 'operation.failed', payload: { operationId: null, code: 'RUNTIME_DISCONNECTED', message } }]);
        } else {
          const { request } = effect;
          await settleOperation(runId, { operationId: request.operationId, phase: request.phase, cancellationEpoch: request.cancellationEpoch, status: 'failed', code: 'RUNTIME_DISCONNECTED', message });
        }
      }
    }
  }

  async function commitAndRelease(runId: string, commandKey: string, body: unknown, expectedRevision: number, plan: (ctx: TransitionContext) => Plan | Promise<Plan>): Promise<CommandOutcome> {
    const { run, replayed, effects } = await commit(runId, commandKey, body, expectedRevision, plan);
    await release(runId, effects);
    return { run, replayed };
  }

  // -------------------------------------------------------------------------------------------
  // Learning commands

  function planAccept(runId: string, ctx: TransitionContext): Plan {
    const { state } = ctx;
    const problem = state.selectedProblems?.initial;
    if (state.stopped || state.phase !== 'INVITED' || !problem) throw wrongPhase(ctx, 'accept');
    const activity = buildActivity({ runId, id: activityIdOf.initial(runId), revision: ctx.revision + 1, templateId: 'initial_number_line', strategy: null, problem, spec: null, evidenceIds: [], decisionSummary: '' });
    return { state: { ...state, phase: 'INITIAL', activity }, events: [{ type: 'activity.published', payload: { activity } }], activities: [activity] };
  }

  function saveAttempt(runId: string, ctx: TransitionContext, activity: Activity, criterion: Criterion, graded: GradedSubmission): SavedAttempt {
    const id = `${runId}_attempt_${ctx.state.attempts.length + 1}`;
    return { id, activityId: activity.id, activityRevision: activity.revision, criterion, attempt: graded.attempt, assessment: { attemptId: id, ...graded.assessment }, at: ctx.now };
  }

  function currentActivity(ctx: TransitionContext, action: string, phase: RunPhase, kinds: readonly Activity['kind'][]): Activity {
    const { state } = ctx;
    const activity = state.activity;
    if (state.stopped || state.phase !== phase || activity === null || !kinds.includes(activity.kind)) throw wrongPhase(ctx, action);
    if (hasAttemptFor(state, activity)) throw new DomainError('CONFLICT', `Activity ${activity.id} was already submitted`, { revision: ctx.revision });
    return activity;
  }

  function planInitialAttempt(runId: string, ctx: TransitionContext, attempt: Attempt): Plan {
    const activity = currentActivity(ctx, 'attempt', 'INITIAL', ['initial']);
    const graded = gradeSubmission(attempt, activity, 'initial');
    const saved = saveAttempt(runId, ctx, activity, 'initial', graded);
    const phase = routeInitialAttempt(AttemptSchema.parse(graded.attempt), graded.problem, graded.assessment);
    return { state: { ...ctx.state, phase, attempts: [...ctx.state.attempts, saved] }, events: [] };
  }

  function planPractice(runId: string, ctx: TransitionContext, attempt: AnyAttempt): Plan {
    const { state } = ctx;
    const activity = currentActivity(ctx, 'practice', 'PRACTICE', ['support', 'retry']);
    const graded = gradeSubmission(attempt, activity, 'support');
    const saved = saveAttempt(runId, ctx, activity, 'support', graded);
    const attempts = [...state.attempts, saved];
    const next = nextAfterPractice(state, activity, graded.attempt, graded.assessment);
    const revision = ctx.revision + 1;
    if (next.phase === 'VERIFY') {
      const independent = state.selectedProblems?.independent;
      if (!independent) throw wrongPhase(ctx, 'practice');
      const published = buildActivity(independentDraft(runId, revision, activity, independent));
      return { state: { ...state, phase: 'VERIFY', attempts, activity: published }, events: [{ type: 'activity.published', payload: { activity: published } }], activities: [published] };
    }
    if (next.phase === 'CLARIFY') {
      // A failed retry is application policy: ask which number was counted first, on the same problem.
      const problem = activity.problem ?? state.selectedProblems?.initial;
      if (!problem) throw wrongPhase(ctx, 'practice');
      const published = buildActivity({ runId, id: activityIdOf.clarification(runId, state.explanationRevision), revision, templateId: 'clarify_first_number', strategy: 'clarify', problem, spec: null, evidenceIds: [], decisionSummary: '' });
      return {
        state: { ...state, phase: 'CLARIFY', attempts, activity: published, clarificationRounds: state.clarificationRounds + 1 },
        events: [{ type: 'activity.published', payload: { activity: published } }],
        activities: [published],
      };
    }
    return { state: { ...state, phase: 'NEEDS_SUPPORT', attempts, continuationAllowed: next.continuationAllowed }, events: [] };
  }

  function planVerify(runId: string, ctx: TransitionContext, attempt: AnyAttempt, gate: { activityId: string; revision: number; closed: boolean }): Plan {
    const { state } = ctx;
    const activity = currentActivity(ctx, 'verify', 'VERIFY', ['independent']);
    if (gate.activityId !== activity.id || gate.revision !== activity.revision) throw new DomainError('CONFLICT', 'The independent activity changed while the attempt was sent', { revision: ctx.revision });
    if (!gate.closed) throw new DomainError('WRONG_PHASE', 'Voice must be off before the independent check counts', { revision: ctx.revision });
    const graded = gradeSubmission(attempt, activity, 'independent');
    const saved = saveAttempt(runId, ctx, activity, 'independent', graded);
    const operationId = `${runId}_verify_${saved.id}`;
    const supportAttempt = state.attempts.findLast((a) => a.criterion === 'support' && a.assessment?.passed === true);
    const request: TurnRequest = {
      runId,
      operationId,
      cancellationEpoch: state.cancellationEpoch,
      phase: 'verification',
      input: { independentAttemptId: saved.id, supportAttemptId: supportAttempt?.id ?? null, activityId: activity.id, expectedRevision: ctx.revision + 1 },
    };
    return {
      state: { ...state, attempts: [...state.attempts, saved] },
      events: [{ type: 'operation.started', payload: { operationId, phase: 'verification', explanationRevision: state.explanationRevision, cancellationEpoch: state.cancellationEpoch } }],
      voiceOperations: [{ kind: 'insert', operation: { runId, liveSessionId: null, delegationId: null, operationId, explanationRevision: state.explanationRevision, cancellationEpoch: state.cancellationEpoch, threadId: state.runtime?.threadId ?? null, turnId: null, status: 'started' } }],
      effects: [{ kind: 'start', request }],
    };
  }

  async function planStop(ctx: TransitionContext): Promise<Plan> {
    const { state } = ctx;
    if (state.stopped || !COMMAND_STOPPABLE.includes(state.phase)) throw wrongPhase(ctx, 'stop_learning');
    const open = requiredEffectPending(state) ? await latestOpenOperation(ctx) : null;
    const cancelled = open ? cancelOperation(open, 'stopped') : null;
    return {
      state: { ...state, stopped: true, cancellationEpoch: state.cancellationEpoch + 1 },
      events: cancelled ? [cancelled.event] : [],
      voiceOperations: cancelled ? [cancelled.change] : [],
      effects: [{ kind: 'stop_cleanup' }],
    };
  }

  async function planExplain(runId: string, ctx: TransitionContext, input: ExplanationInput): Promise<Plan> {
    const { state } = ctx;
    const mode = explainModeOf(state);
    const problem = state.selectedProblems?.initial;
    if (mode === null || !problem) throw wrongPhase(ctx, 'explain');
    const correction = mode === 'correction';
    const explanationRevision = state.explanationRevision + 1;
    const cancellationEpoch = state.cancellationEpoch + (correction ? 1 : 0);
    const operationId = input.operationId ?? input.commandId;
    const superseded = correction ? await latestOpenOperation(ctx) : null;
    const cancelled = superseded ? cancelOperation(superseded, 'superseded') : null;
    const attempt = explainedAttempt(state);
    if (!attempt) throw wrongPhase(ctx, 'explain');
    const next: RunState = {
      ...state,
      phase: 'PROCESSING',
      explanationRevision,
      cancellationEpoch,
      explanation: { revision: explanationRevision, text: input.text, inputMode: input.provenance.inputMode, at: ctx.now },
      // A correction supersedes the activity on screen; any other explanation answers it.
      activity: correction ? null : state.activity,
      continuationAllowed: false,
      // A continuation explains a new attempt, which gets its own clarification rounds.
      clarificationRounds: mode === 'continuation' ? 0 : state.clarificationRounds,
      error: null,
    };
    const question = questionForExplanation(next);
    const request: TurnRequest = {
      runId,
      operationId,
      cancellationEpoch,
      phase: 'explanation',
      input: { explanationRevision, sourceId: `${runId}_context_${explanationRevision}:speech`, explanation: input.text, inputMode: input.provenance.inputMode, problem, attempt, question: question?.text ?? null },
    };
    return {
      state: next,
      events: [
        ...(cancelled ? [cancelled.event] : []),
        { type: 'operation.started', payload: { operationId, phase: 'explanation', explanationRevision, cancellationEpoch } },
      ],
      voiceOperations: [
        ...(cancelled ? [cancelled.change] : []),
        {
          kind: 'insert',
          operation: { runId, liveSessionId: input.provenance.liveSessionId, delegationId: input.provenance.delegationId, operationId, explanationRevision, cancellationEpoch, threadId: state.runtime?.threadId ?? null, turnId: null, status: 'started' },
        },
      ],
      effects: [{ kind: correction ? 'steer_or_start' : 'start', request }],
    };
  }

  // A typed or spoken explanation of the current attempt, or a correction of one still being processed.
  async function explain(runId: string, raw: unknown): Promise<CommandOutcome> {
    const input = parseOrReject(ExplanationInputSchema, raw);
    return commitAndRelease(runId, `command:${input.commandId}`, input, input.revision, (ctx) => planExplain(runId, ctx, input));
  }

  async function command(runId: string, raw: unknown): Promise<CommandOutcome> {
    const cmd: Command = parseOrReject(CommandSchema, raw);
    const key = `command:${cmd.commandId}`;
    switch (cmd.type) {
      case 'accept':
        return commitAndRelease(runId, key, cmd, cmd.revision, (ctx) => planAccept(runId, ctx));
      case 'attempt':
        return commitAndRelease(runId, key, cmd, cmd.revision, (ctx) => planInitialAttempt(runId, ctx, cmd.attempt));
      case 'explain':
        return explain(runId, { commandId: cmd.commandId, revision: cmd.revision, text: cmd.text, provenance: TYPED });
      case 'practice':
        return commitAndRelease(runId, key, cmd, cmd.revision, (ctx) => planPractice(runId, ctx, cmd.attempt));
      case 'verify': {
        // The audio gate is a record written outside transitions; it is read first and checked inside.
        const { state } = await store.getRun(runId);
        const activity = state.activity;
        const gate = activity ? { activityId: activity.id, revision: activity.revision, closed: await store.audioGateClosed(runId, activity.id, activity.revision) } : { activityId: '', revision: -1, closed: false };
        return commitAndRelease(runId, key, cmd, cmd.revision, (ctx) => planVerify(runId, ctx, cmd.attempt, gate));
      }
      case 'stop_learning':
        return commitAndRelease(runId, key, cmd, cmd.revision, (ctx) => planStop(ctx));
    }
  }

  // -------------------------------------------------------------------------------------------
  // Voice commands that change run state

  async function typedCorrection(runId: string, raw: unknown): Promise<CommandOutcome> {
    const cmd = parseOrReject(VoiceCommandSchema, raw);
    if (cmd.type !== 'typed_correction') throw new DomainError('INVALID_INPUT', `${cmd.type} is not a typed correction`);
    return explain(runId, { commandId: cmd.commandId, revision: cmd.expectedRunRevision, text: cmd.text, provenance: TYPED });
  }

  // Confirms the current activity's controls mounted. It never grades or advances learning, and a repeat
  // for an acknowledged activity writes nothing.
  async function activityRendered(runId: string, raw: unknown): Promise<CommandOutcome> {
    const cmd = parseOrReject(ActivityRenderedCommandSchema, raw);
    try {
      return await commitAndRelease(runId, `command:${cmd.commandId}`, cmd, cmd.expectedRunRevision, async (ctx) => {
        const { state } = ctx;
        const activity = state.activity;
        if (state.stopped) throw wrongPhase(ctx, 'activity_rendered');
        if (activity === null || activity.id !== cmd.activityId || activity.revision !== cmd.activityRevision || activity.specHash !== cmd.specHash) {
          throw new DomainError('CONFLICT', 'The render receipt does not match the current activity', { revision: ctx.revision });
        }
        if (await ctx.isActivityRendered(activity.id, activity.revision)) throw new AlreadyRendered();
        return { state, events: [], renderedActivities: [{ activityId: activity.id, revision: activity.revision }] };
      });
    } catch (error) {
      if (error instanceof AlreadyRendered) return { run: await store.getRun(runId), replayed: true };
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Runtime results

  // Called when an agent turn ends. A turn that ended without its step's required effect moves the run to
  // ERROR (ingestion without an offer ends in NO_MATCH). A result for a superseded or stopped run changes
  // nothing: it is a stale model result.
  async function settleOperation(runId: string, raw: unknown): Promise<CommandOutcome & { changed: boolean }> {
    const settlement = parseOrReject(OperationSettlementSchema, raw);
    const run = await store.getRun(runId);
    const stale = run.state.stopped || run.state.cancellationEpoch !== settlement.cancellationEpoch;
    const pending = !stale && requiredEffectPending(run.state) && phaseOfRuntime(run.state.phase) === settlement.phase;
    if (!pending) {
      await settleVoiceOperation(settlement);
      return { run, replayed: false, changed: false };
    }
    const noOffer = settlement.phase === 'ingestion' && settlement.status !== 'failed';
    const code: ErrorCode = settlement.code ?? (settlement.status === 'failed' ? 'RUNTIME_DISCONNECTED' : 'VALIDATION_FAILED');
    const message = settlement.message ?? (settlement.status === 'failed' ? 'The agent turn failed before this step finished.' : 'The agent turn ended without the required result.');
    const outcome = await commitAndRelease(runId, `settle:${settlement.operationId}`, settlement, run.revision, async (ctx) => {
      const { state } = ctx;
      const open = await latestOpenOperation(ctx);
      if (state.stopped || state.cancellationEpoch !== settlement.cancellationEpoch || !requiredEffectPending(state) || (open !== null && open.operationId !== settlement.operationId)) {
        throw new DomainError('CANCELLED', 'Stale model result', { revision: ctx.revision });
      }
      const status = settlement.status === 'failed' ? 'failed' : 'completed';
      const change: VoiceOperationChange = { kind: 'status', operationId: settlement.operationId, status, expected: ['started', 'steered'], onMismatch: 'skip' };
      if (noOffer) return { state: { ...state, phase: 'NO_MATCH' }, events: [], voiceOperations: [change] };
      return {
        state: { ...state, phase: 'ERROR', error: { code, message, retryable: false } },
        events: [{ type: 'operation.failed', payload: { operationId: settlement.operationId, code, message } }],
        voiceOperations: [change],
      };
    });
    return { ...outcome, changed: !outcome.replayed };
  }

  async function settleVoiceOperation(settlement: OperationSettlement): Promise<void> {
    const op = await store.getVoiceOperation(settlement.operationId);
    if (op === null || (op.status !== 'started' && op.status !== 'steered')) return;
    await store.updateVoiceOperationStatus(settlement.operationId, settlement.status === 'failed' ? 'failed' : 'completed', op.status);
  }

  // -------------------------------------------------------------------------------------------
  // Restart

  // Reconciles runs a restart cut off. A step without its required committed effect is marked
  // interrupted and the run moves to ERROR; committed work and an untouched independent check stay as
  // they are; a stopped run keeps its phase and only has its runtime and voice cleaned up. Each recovery
  // is keyed by its operation, so running this again changes nothing.
  async function recoverInterrupted(options: { runIdPrefix?: string } = {}): Promise<{ interrupted: string[]; cleaned: string[] }> {
    const interrupted: string[] = [];
    const cleaned: string[] = [];
    for (const run of await store.listRecoverableRuns(options.runIdPrefix ?? null)) {
      if (run.state.stopped) {
        await closeOpenVoiceOperations(run.id);
        await release(run.id, [{ kind: 'stop_cleanup' }]);
        cleaned.push(run.id);
        continue;
      }
      if (!requiredEffectPending(run.state)) continue;
      const started = (await store.events(run.id)).filter((e) => e.type === 'operation.started');
      const operationId = started[started.length - 1]?.payload.operationId ?? null;
      const key = `recovery:${operationId ?? `${run.state.phase}_${run.revision}`}`;
      try {
        const { replayed } = await commit(run.id, key, { operationId, phase: run.state.phase }, run.revision, async (ctx) => {
          const { state } = ctx;
          if (state.stopped || !requiredEffectPending(state)) throw wrongPhase(ctx, 'recovery');
          const open = await latestOpenOperation(ctx);
          return {
            state: { ...state, phase: 'ERROR', cancellationEpoch: state.cancellationEpoch + 1, error: { code: 'RUNTIME_DISCONNECTED', message: RESTART_MESSAGE, retryable: false } },
            events: [{ type: 'operation.failed', payload: { operationId: open?.operationId ?? null, code: 'RUNTIME_DISCONNECTED', message: RESTART_MESSAGE } }],
            voiceOperations: open ? [{ kind: 'status', operationId: open.operationId, status: 'failed', expected: ['started', 'steered'], onMismatch: 'skip' }] : [],
          };
        });
        if (!replayed) interrupted.push(run.id);
      } catch (error) {
        // Another process moved the run on in the meantime; there is nothing left to recover.
        if (error instanceof DomainError && (error.code === 'STALE_REVISION' || error.code === 'WRONG_PHASE')) continue;
        throw error;
      }
    }
    return { interrupted, cleaned };
  }

  async function closeOpenVoiceOperations(runId: string): Promise<void> {
    for (const op of await store.listVoiceOperations(runId)) {
      if (op.status === 'started' || op.status === 'steered') await store.updateVoiceOperationStatus(op.operationId, 'cancelled', op.status);
    }
  }

  return { command, explain, typedCorrection, activityRendered, settleOperation, recoverInterrupted };
}

export type Engine = ReturnType<typeof createEngine>;

// Phases in which stop_learning is accepted: every phase that is not already final.
const COMMAND_STOPPABLE: readonly RunPhase[] = ['WAITING', 'INGESTING', 'INVITED', 'INITIAL', 'EXPLAIN', 'PROCESSING', 'CLARIFY', 'PRACTICE', 'VERIFY', 'NEEDS_SUPPORT'];

function phaseOfRuntime(phase: RunPhase): RuntimePhase | null {
  if (phase === 'INGESTING') return 'ingestion';
  if (phase === 'PROCESSING') return 'explanation';
  if (phase === 'VERIFY') return 'verification';
  return null;
}
