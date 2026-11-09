import {
  type Activity,
  type ActivityKind,
  type Assessment,
  AttemptSchema,
  type Criterion,
  HintsSchema,
  MakeTenAttemptSchema,
  type Problem,
  TEMPLATE_KIND,
  type TemplateId,
} from './domain.js';

// What the grader returns; the caller adds the stored attempt's ID to make an `Assessment`.
export type AssessmentResult = Omit<Assessment, 'attemptId'>;

export class AssessmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssessmentError';
  }
}

type Rubric = 'number_line' | 'make_ten';

// The rubric follows the activity's template, never the model's or the client's claim. Templates
// that carry no attempt (invitation, clarification, completion) are absent.
const RUBRIC_BY_TEMPLATE: Partial<Record<TemplateId, Rubric>> = {
  initial_number_line: 'number_line',
  anchor_start_number_line: 'number_line',
  manipulation_retry: 'number_line',
  independent_number_line: 'number_line',
  make_ten_blocks: 'make_ten',
  independent_make_ten: 'make_ten',
};

// A retry is graded in the practice phase, so it uses the support criterion.
const CRITERION_BY_KIND: Partial<Record<ActivityKind, Criterion>> = {
  initial: 'initial',
  support: 'support',
  retry: 'support',
  independent: 'independent',
};

// Support may pass with help; initial and independent evidence must be hint-free.
const requiresNoHints = (criterion: Criterion): boolean => criterion !== 'support';

function gradedProblem(activity: Activity): Problem {
  if (activity.problem === null) throw new AssessmentError(`Activity ${activity.id} has no problem to grade against`);
  return activity.problem;
}

function expectedCriterion(activity: Activity): Criterion {
  if (TEMPLATE_KIND[activity.templateId] !== activity.kind) {
    throw new AssessmentError(`Activity ${activity.id} has kind ${activity.kind}, which its template ${activity.templateId} does not produce`);
  }
  const expected = CRITERION_BY_KIND[activity.kind];
  if (expected === undefined) throw new AssessmentError(`Activity ${activity.id} (${activity.templateId}) is not gradable`);
  return expected;
}

// Start at the first addend, then exactly `rhs` moves, each one more than the last position.
function numberLineProcessIsCorrect(attempt: { start: number; moves: readonly number[] }, { lhs, rhs }: Problem): boolean {
  return attempt.start === lhs && attempt.moves.length === rhs && attempt.moves.every((position, i) => position === lhs + i + 1);
}

// Fixed objects are f0…f<lhs-1> and never move; the movable ones are t0…t<rhs-1>.
function makeTenProcessIsCorrect(placements: readonly { objectId: string; to: 'tray' | 'ten_frame' | 'remaining' }[], { lhs, rhs }: Problem): boolean {
  const toTen = 10 - lhs;
  if (toTen < 1 || toTen >= rhs) {
    throw new AssessmentError(`Problem ${lhs} + ${rhs} has no make-ten split to grade against`);
  }
  const finalZone = new Map<string, 'tray' | 'ten_frame' | 'remaining'>();
  for (let i = 0; i < rhs; i += 1) finalZone.set(`t${i}`, 'tray');
  for (const { objectId, to } of placements) {
    if (!finalZone.has(objectId)) return false;
    finalZone.set(objectId, to);
  }
  const zones = [...finalZone.values()];
  const count = (zone: string) => zones.filter((z) => z === zone).length;
  return count('ten_frame') === toTen && count('remaining') === rhs - toTen && count('tray') === 0;
}

function gradeAttempt(attempt: unknown, activity: Activity, problem: Problem): { processCorrect: boolean; answer: number; recordedHints: number } {
  const rubric = RUBRIC_BY_TEMPLATE[activity.templateId];
  if (rubric === undefined) throw new AssessmentError(`Activity ${activity.id} (${activity.templateId}) is not gradable`);
  if (rubric === 'number_line') {
    const parsed = AttemptSchema.safeParse(attempt);
    if (!parsed.success) throw new AssessmentError(`Not a number-line attempt: ${parsed.error.message}`);
    return { processCorrect: numberLineProcessIsCorrect(parsed.data, problem), answer: parsed.data.answer, recordedHints: parsed.data.hints };
  }
  const parsed = MakeTenAttemptSchema.safeParse(attempt);
  if (!parsed.success) throw new AssessmentError(`Not a make-ten attempt: ${parsed.error.message}`);
  return { processCorrect: makeTenProcessIsCorrect(parsed.data.placements, problem), answer: parsed.data.answer, recordedHints: parsed.data.hints };
}

// Help exposure is what the accepted activity showed plus what the child asked for, so a client
// that reports zero hints cannot hide a helper the activity displayed.
function helpExposure(activity: Activity, recordedHints: number): number {
  const total = activity.helperCount + recordedHints;
  return HintsSchema.maxValue === null ? total : Math.min(total, HintsSchema.maxValue);
}

// Grades one submitted attempt against the activity's own numbers, its template's rubric and its
// help exposure. `criterion` is what the caller believes it is grading; the activity decides, and
// a disagreement is rejected rather than graded under the wrong rule.
export function assess(attempt: unknown, activity: Activity, criterion: Criterion): AssessmentResult {
  const expected = expectedCriterion(activity);
  if (criterion !== expected) {
    throw new AssessmentError(`Criterion ${criterion} does not match activity ${activity.id}, which is graded as ${expected}`);
  }
  const problem = gradedProblem(activity);
  const { processCorrect, answer, recordedHints } = gradeAttempt(attempt, activity, problem);
  const answerCorrect = answer === problem.lhs + problem.rhs;
  const hints = helpExposure(activity, recordedHints);
  const passed = processCorrect && answerCorrect && (!requiresNoHints(criterion) || hints === 0);
  return { passed, processCorrect, answerCorrect, hints, retention: 'pending' };
}
