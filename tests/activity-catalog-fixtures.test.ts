import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { z } from 'zod';
import { deriveActivityFixturesSource, deriveFixtures, FIXTURES_PATH, PREPARED_LESSON_PROBLEMS, SEED_CASES_PATH } from '../scripts/derive-activity-fixtures.js';
import { ActivityContextSchema, ActivitySpecSchema, CaseSchema, type Problem } from '../src/domain.js';
import { FILM_SEED, problemRefOf, selectProblems } from '../src/problems.js';
import { validateActivity } from '../src/ui/activity-catalog.js';
import { makeTenIndependent, makeTenSupport, numberLineIndependent, numberLineSupport } from '../src/ui/activity-fixtures.js';

const seedCases = z.array(CaseSchema).parse(JSON.parse(readFileSync(SEED_CASES_PATH, 'utf8')));
const fixtures = { makeTenSupport, makeTenIndependent, numberLineSupport, numberLineIndependent };

describe('derived activity fixtures', () => {
  test('the four derived fixtures parse through the shared schema and validate against their contexts', () => {
    for (const [name, { context, spec }] of Object.entries(fixtures)) {
      assert.deepEqual(ActivityContextSchema.parse(context), context, `${name} context`);
      assert.deepEqual(ActivitySpecSchema.parse(spec), spec, `${name} spec`);
      assert.deepEqual(validateActivity(spec, context), spec, `${name} validates`);
    }
  });

  test('the fixture operands are the film seed pair and every support fixture cites a real seed case', () => {
    const { initial, independent } = selectProblems(FILM_SEED, PREPARED_LESSON_PROBLEMS);
    for (const { context } of [makeTenSupport, numberLineSupport]) {
      assert.equal(context.problemRef, problemRefOf(initial));
      assert.equal(context.evidenceIds.length, 1);
      assert.ok(seedCases.some((c) => c.id === context.evidenceIds[0]));
    }
    for (const { context } of [makeTenIndependent, numberLineIndependent]) {
      assert.equal(context.problemRef, problemRefOf(independent));
      assert.deepEqual(context.evidenceIds, []);
    }
    assert.equal(makeTenSupport.context.workspace, 'MakeTenWorkspace');
    assert.equal(numberLineSupport.context.workspace, 'NumberLine');
  });

  test('the committed fixtures file equals the derive script’s output', () => {
    assert.equal(readFileSync(FIXTURES_PATH, 'utf8'), deriveActivityFixturesSource());
  });

  test('the lesson problems the script excludes are the ones the prepared lesson states', () => {
    const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    const transcript = readFileSync(new URL('../data/lesson/lesson-transcript.txt', import.meta.url), 'utf8').toLowerCase();
    for (const { lhs, rhs } of PREPARED_LESSON_PROBLEMS) {
      assert.ok(transcript.includes(`${ones[lhs]} plus ${ones[rhs]}`), `the lesson states ${lhs} + ${rhs}`);
    }
  });
});

describe('operands across seeds', () => {
  const seeds = [0, 1, 7, 42, 99, 1234, FILM_SEED, 0xffffffff];
  const otherProblem = (current: Problem, seed: number): Problem => {
    for (let offset = 1; offset < 100; offset += 1) {
      const candidate = selectProblems((seed + offset) >>> 0, PREPARED_LESSON_PROBLEMS).initial;
      if (candidate.lhs !== current.lhs && candidate.rhs !== current.rhs) return candidate;
    }
    throw new Error('No different problem found');
  };

  test('rejects operands that differ from the run’s selected pair, checked across several valid seeds', () => {
    for (const seed of seeds) {
      const set = deriveFixtures(seedCases, seed, PREPARED_LESSON_PROBLEMS);
      for (const { context, spec } of Object.values(set)) {
        assert.deepEqual(validateActivity(spec, context), spec, `seed ${seed} accepts its own pair`);
      }

      const { initial } = selectProblems(seed, PREPARED_LESSON_PROBLEMS);
      const other = otherProblem(initial, seed);
      const { context: makeTenContext, spec: makeTenSpec } = set.makeTenSupport;
      const wrongMakeTen = { ...makeTenSpec, components: [{ id: 'box', type: 'MakeTenWorkspace', props: { first: other.lhs, second: other.rhs, appearance: 'apple', highlightEmptySlots: true, showEquation: true } }] };
      assert.throws(() => validateActivity(wrongMakeTen, makeTenContext), /Problem mismatch/, `seed ${seed} make-ten`);

      const { context: lineContext, spec: lineSpec } = set.numberLineSupport;
      const wrongLine = { ...lineSpec, components: [{ id: 'line', type: 'NumberLine', props: { start: other.lhs, addend: other.rhs } }] };
      assert.throws(() => validateActivity(wrongLine, lineContext), /Problem mismatch/, `seed ${seed} number line`);
    }
  });
});
