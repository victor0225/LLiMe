import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Activity, Attempt, MakeTenAttempt, MakeTenZone, Problem, TemplateId } from '../src/domain.js';
import { TEMPLATE_KIND } from '../src/domain.js';
import { assess } from '../src/assessment.js';

function activityFor(templateId: TemplateId, problem: Problem | null, helperCount = 0): Activity {
  return {
    id: 'run1_activity',
    revision: 1,
    runId: 'run1',
    kind: TEMPLATE_KIND[templateId],
    templateId,
    strategy: null,
    problem,
    title: 'title',
    body: 'body',
    primaryLabel: 'Check my answer',
    secondaryLabel: null,
    activitySpec: null,
    specHash: null,
    helperCount,
    evidenceIds: [],
    decisionSummary: '',
  };
}

const numberLineAttempt = (lhs: number, rhs: number, overrides: Partial<Attempt> = {}): Attempt => ({
  start: lhs,
  moves: Array.from({ length: rhs }, (_, i) => lhs + i + 1),
  answer: lhs + rhs,
  hints: 0,
  ...overrides,
});

// Objects start in the tray as t0…t<rhs-1>; each placement moves one of them.
function makeTenAttempt(lhs: number, rhs: number, overrides: Partial<MakeTenAttempt> = {}): MakeTenAttempt {
  const toTen = 10 - lhs;
  const zone = (i: number): MakeTenZone => (i < toTen ? 'ten_frame' : 'remaining');
  return {
    placements: Array.from({ length: rhs }, (_, i) => ({ objectId: `t${i}`, to: zone(i) })),
    answer: lhs + rhs,
    hints: 0,
    ...overrides,
  };
}

const initialLine = (p: Problem) => activityFor('initial_number_line', p);
const supportLine = (p: Problem, helperCount = 0) => activityFor('anchor_start_number_line', p, helperCount);
const independentLine = (p: Problem) => activityFor('independent_number_line', p);
const supportTen = (p: Problem, helperCount = 0) => activityFor('make_ten_blocks', p, helperCount);
const independentTen = (p: Problem) => activityFor('independent_make_ten', p);

const FILM_INITIAL: Problem = { lhs: 8, rhs: 5 };
const FILM_INDEPENDENT: Problem = { lhs: 9, rhs: 4 };

describe('assess number line', () => {
  test("grades against the activity's own numbers, not 8 + 5 (for example 6 + 6)", () => {
    const problem = { lhs: 6, rhs: 6 };
    const result = assess(numberLineAttempt(6, 6), initialLine(problem), 'initial');
    assert.deepEqual(result, { passed: true, processCorrect: true, answerCorrect: true, hints: 0, retention: 'pending' });

    const fixedEightPlusFive = assess(numberLineAttempt(8, 5), initialLine(problem), 'initial');
    assert.equal(fixedEightPlusFive.processCorrect, false);
    assert.equal(fixedEightPlusFive.answerCorrect, false);
    assert.equal(fixedEightPlusFive.passed, false);
  });

  test('start a, then exactly b consecutive moves to a + b, with answer a + b, is process-correct', () => {
    const result = assess(numberLineAttempt(8, 5), initialLine(FILM_INITIAL), 'initial');
    assert.equal(result.processCorrect, true);
    assert.equal(result.answerCorrect, true);
    assert.equal(result.passed, true);
  });

  test('a wrong start, a skipped number, a missing or an extra move is not process-correct', () => {
    const activity = initialLine(FILM_INITIAL);
    const cases: Attempt[] = [
      numberLineAttempt(8, 5, { start: 7 }),
      numberLineAttempt(8, 5, { moves: [9, 10, 12, 13] }),
      numberLineAttempt(8, 5, { moves: [9, 10, 11, 12] }),
      numberLineAttempt(8, 5, { moves: [9, 10, 11, 12, 13, 14] }),
      numberLineAttempt(8, 5, { moves: [9, 8, 9, 10, 11] }),
    ];
    for (const attempt of cases) assert.equal(assess(attempt, activity, 'initial').processCorrect, false, JSON.stringify(attempt));
  });

  test('the four-move 8 + 5 attempt that answers 12 is not passed', () => {
    const result = assess(numberLineAttempt(8, 4), initialLine(FILM_INITIAL), 'initial');
    assert.deepEqual(result, { passed: false, processCorrect: false, answerCorrect: false, hints: 0, retention: 'pending' });
  });

  test('a correct answer without a valid trace is answerCorrect but not passed', () => {
    const result = assess({ start: 8, moves: [], answer: 13, hints: 0 }, initialLine(FILM_INITIAL), 'initial');
    assert.equal(result.answerCorrect, true);
    assert.equal(result.processCorrect, false);
    assert.equal(result.passed, false);
  });

  test('a valid trace with a wrong answer is processCorrect but not passed', () => {
    const result = assess(numberLineAttempt(8, 5, { answer: 12 }), initialLine(FILM_INITIAL), 'initial');
    assert.equal(result.processCorrect, true);
    assert.equal(result.answerCorrect, false);
    assert.equal(result.passed, false);
  });
});

describe('assess make ten', () => {
  test('10 - first objects end in ten_frame, the rest in remaining, none in the tray', () => {
    const film = assess(makeTenAttempt(8, 5), supportTen(FILM_INITIAL), 'support');
    assert.deepEqual(film, { passed: true, processCorrect: true, answerCorrect: true, hints: 0, retention: 'pending' });

    const independent = assess(makeTenAttempt(9, 4), independentTen(FILM_INDEPENDENT), 'independent');
    assert.equal(independent.passed, true);

    const other = assess(makeTenAttempt(7, 8), supportTen({ lhs: 7, rhs: 8 }), 'support');
    assert.equal(other.passed, true);
  });

  test('the final position of an object is its last placement, so an undo is honored', () => {
    const base = makeTenAttempt(8, 5);
    const withUndo = {
      ...base,
      placements: [{ objectId: 't0', to: 'remaining' as const }, { objectId: 't0', to: 'tray' as const }, ...base.placements],
    };
    assert.equal(assess(withUndo, supportTen(FILM_INITIAL), 'support').processCorrect, true);
  });

  test('a correct answer with a wrong final placement is not passed', () => {
    const wrongSplit = makeTenAttempt(8, 5, {
      placements: [
        { objectId: 't0', to: 'ten_frame' },
        { objectId: 't1', to: 'remaining' },
        { objectId: 't2', to: 'remaining' },
        { objectId: 't3', to: 'remaining' },
        { objectId: 't4', to: 'remaining' },
      ],
    });
    const result = assess(wrongSplit, supportTen(FILM_INITIAL), 'support');
    assert.equal(result.answerCorrect, true);
    assert.equal(result.processCorrect, false);
    assert.equal(result.passed, false);

    const answerOnly = assess({ placements: [], answer: 13, hints: 0 }, independentTen(FILM_INDEPENDENT), 'independent');
    assert.equal(answerOnly.answerCorrect, true);
    assert.equal(answerOnly.processCorrect, false);
    assert.equal(answerOnly.passed, false);
  });

  test('an object left in the tray fails the process', () => {
    const attempt = makeTenAttempt(8, 5, { placements: makeTenAttempt(8, 5).placements.slice(0, 4) });
    assert.equal(assess(attempt, supportTen(FILM_INITIAL), 'support').processCorrect, false);
  });

  test('unknown object IDs or more than ten objects in the frame fail the process', () => {
    const base = makeTenAttempt(8, 5);
    const unknownId = { ...base, placements: [...base.placements.slice(0, 4), { objectId: 'x9', to: 'remaining' as const }] };
    assert.equal(assess(unknownId, supportTen(FILM_INITIAL), 'support').processCorrect, false);

    const fixedObject = { ...base, placements: [{ objectId: 'f0', to: 'remaining' as const }, ...base.placements] };
    assert.equal(assess(fixedObject, supportTen(FILM_INITIAL), 'support').processCorrect, false);

    const crowdedFrame = {
      ...base,
      placements: Array.from({ length: 11 }, (_, i) => ({ objectId: `t${i}`, to: 'ten_frame' as const })),
    };
    const crowded = assess(crowdedFrame, supportTen(FILM_INITIAL), 'support');
    assert.equal(crowded.processCorrect, false);
    assert.equal(crowded.passed, false);

    const tooManyForFrame = {
      ...base,
      placements: Array.from({ length: 5 }, (_, i) => ({ objectId: `t${i}`, to: 'ten_frame' as const })),
    };
    assert.equal(assess(tooManyForFrame, supportTen(FILM_INITIAL), 'support').processCorrect, false);
  });
});

describe('assess help exposure', () => {
  test("help exposure counts the activity's stored helper count plus recorded help and is never lowered by a client hints: 0", () => {
    const twoHelpers = assess(numberLineAttempt(8, 5, { hints: 0 }), supportLine(FILM_INITIAL, 2), 'support');
    assert.equal(twoHelpers.hints, 2);

    const oneHelperPlusOneHint = assess(makeTenAttempt(8, 5, { hints: 1 }), supportTen(FILM_INITIAL, 1), 'support');
    assert.equal(oneHelperPlusOneHint.hints, 2);

    const clientOnly = assess(numberLineAttempt(8, 5, { hints: 3 }), supportLine(FILM_INITIAL, 0), 'support');
    assert.equal(clientOnly.hints, 3);
  });

  test('help exposure stays within the assessment hint cap', () => {
    const result = assess(numberLineAttempt(8, 5, { hints: 20 }), supportLine(FILM_INITIAL, 2), 'support');
    assert.equal(result.hints, 20);
  });

  test('support passed = processCorrect && answerCorrect even with helpers, and keeps the hint count', () => {
    const withHelpers = assess(makeTenAttempt(8, 5), supportTen(FILM_INITIAL, 2), 'support');
    assert.equal(withHelpers.passed, true);
    assert.equal(withHelpers.hints, 2);

    const wrongProcess = assess(numberLineAttempt(8, 5, { moves: [9, 10] }), supportLine(FILM_INITIAL, 2), 'support');
    assert.equal(wrongProcess.passed, false);
    assert.equal(wrongProcess.hints, 2);
  });

  test('a retry is graded as support and passes with a valid trace', () => {
    const retry = activityFor('manipulation_retry', FILM_INITIAL);
    assert.equal(assess(numberLineAttempt(8, 5), retry, 'support').passed, true);
  });

  test('initial and independent passed additionally require zero hints', () => {
    const hintedInitial = assess(numberLineAttempt(8, 5, { hints: 1 }), initialLine(FILM_INITIAL), 'initial');
    assert.equal(hintedInitial.processCorrect, true);
    assert.equal(hintedInitial.answerCorrect, true);
    assert.equal(hintedInitial.passed, false);
    assert.equal(hintedInitial.hints, 1);

    const hintedIndependent = assess(makeTenAttempt(9, 4, { hints: 1 }), independentTen(FILM_INDEPENDENT), 'independent');
    assert.equal(hintedIndependent.passed, false);

    const independentLineHinted = assess(numberLineAttempt(9, 4, { hints: 2 }), independentLine(FILM_INDEPENDENT), 'independent');
    assert.equal(independentLineHinted.passed, false);

    const clean = assess(numberLineAttempt(9, 4), independentLine(FILM_INDEPENDENT), 'independent');
    assert.equal(clean.passed, true);
  });

  test('an independent activity that still carries a stored helper cannot pass', () => {
    const helped: Activity = { ...independentTen(FILM_INDEPENDENT), helperCount: 1 };
    const result = assess(makeTenAttempt(9, 4), helped, 'independent');
    assert.equal(result.processCorrect, true);
    assert.equal(result.passed, false);
    assert.equal(result.hints, 1);
  });
});

describe('assess criterion and retention', () => {
  test('the criterion comes from the activity; a mismatched criterion is rejected', () => {
    const attempt = numberLineAttempt(8, 5);
    assert.throws(() => assess(attempt, initialLine(FILM_INITIAL), 'independent'), /criterion/i);
    assert.throws(() => assess(attempt, initialLine(FILM_INITIAL), 'support'), /criterion/i);
    assert.throws(() => assess(attempt, supportLine(FILM_INITIAL), 'initial'), /criterion/i);
    assert.throws(() => assess(attempt, independentLine(FILM_INDEPENDENT), 'support'), /criterion/i);
    assert.throws(() => assess(makeTenAttempt(8, 5), supportTen(FILM_INITIAL), 'independent'), /criterion/i);
  });

  test('invitation, clarification and completion activities are not gradable', () => {
    const attempt = numberLineAttempt(8, 5);
    for (const templateId of ['invitation_addition', 'clarify_first_number', 'clarify_show_steps', 'completion'] as const) {
      assert.throws(() => assess(attempt, activityFor(templateId, FILM_INITIAL), 'initial'), /gradable/, templateId);
    }
  });

  test('an activity without a problem is rejected', () => {
    assert.throws(() => assess(numberLineAttempt(8, 5), activityFor('initial_number_line', null), 'initial'), /problem/);
  });

  test('an attempt of the wrong kind for the rubric is rejected', () => {
    assert.throws(() => assess(makeTenAttempt(8, 5), initialLine(FILM_INITIAL), 'initial'));
    assert.throws(() => assess(numberLineAttempt(8, 5), supportTen(FILM_INITIAL), 'support'));
    assert.throws(() => assess({ start: 8 }, initialLine(FILM_INITIAL), 'initial'));
    assert.throws(() => assess(null, initialLine(FILM_INITIAL), 'initial'));
  });

  test('a make-ten activity whose numbers have no ten-split is rejected', () => {
    assert.throws(() => assess(makeTenAttempt(9, 1), supportTen({ lhs: 9, rhs: 1 }), 'support'), /make-ten/);
    assert.throws(() => assess({ placements: [], answer: 15, hints: 0 }, supportTen({ lhs: 12, rhs: 3 }), 'support'), /make-ten/);
  });

  test('retention is always pending', () => {
    const results = [
      assess(numberLineAttempt(8, 5), initialLine(FILM_INITIAL), 'initial'),
      assess(numberLineAttempt(8, 4), initialLine(FILM_INITIAL), 'initial'),
      assess(makeTenAttempt(8, 5), supportTen(FILM_INITIAL, 2), 'support'),
      assess(makeTenAttempt(9, 4), independentTen(FILM_INDEPENDENT), 'independent'),
    ];
    for (const result of results) assert.equal(result.retention, 'pending');
  });
});

describe('assess examples', () => {
  test('number-line example output', (t) => {
    const result = assess(numberLineAttempt(8, 5), initialLine(FILM_INITIAL), 'initial');
    t.diagnostic(`number line 8 + 5, start 8, moves [9,10,11,12,13], answer 13, hints 0 -> ${JSON.stringify(result)}`);
  });

  test('make-ten example output', (t) => {
    const result = assess(makeTenAttempt(9, 4), independentTen(FILM_INDEPENDENT), 'independent');
    t.diagnostic(`make ten 9 + 4, placements t0 -> ten_frame, t1..t3 -> remaining, answer 13, hints 0 -> ${JSON.stringify(result)}`);
  });
});
