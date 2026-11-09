import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Problem } from '../src/domain.js';
import {
  FILM_SEED,
  FIRST_ADDEND_MAX,
  FIRST_ADDEND_MIN,
  problemRefOf,
  SECOND_ADDEND_MAX,
  SECOND_ADDEND_MIN,
  SUM_MAX,
  SUM_MIN,
  selectProblems,
} from '../src/problems.js';

const LESSON_PROBLEMS: Problem[] = [
  { lhs: 7, rhs: 4 },
  { lhs: 7, rhs: 6 },
  { lhs: 6, rhs: 5 },
];

const label = (p: Problem) => `${p.lhs} + ${p.rhs}`;

// The first addend plus part of the second makes ten, and at least one object is left over.
function isMakeTenPair({ lhs, rhs }: Problem): boolean {
  const toTen = 10 - lhs;
  return toTen >= 1 && toTen < rhs;
}

function isValidPair(p: Problem): boolean {
  const sum = p.lhs + p.rhs;
  return (
    p.lhs >= FIRST_ADDEND_MIN &&
    p.lhs <= FIRST_ADDEND_MAX &&
    p.rhs >= SECOND_ADDEND_MIN &&
    p.rhs <= SECOND_ADDEND_MAX &&
    sum >= SUM_MIN &&
    sum <= SUM_MAX &&
    isMakeTenPair(p)
  );
}

const sampledSeeds = (): number[] => [
  ...Array.from({ length: 2000 }, (_, i) => i),
  0xffffffff,
  0xfffffffe,
  0x80000000,
  0x7fffffff,
  FILM_SEED,
];

describe('selectProblems', () => {
  test('the same seed gives the same pair', () => {
    for (const seed of [0, 1, 42, 123456789, 0xffffffff]) {
      assert.deepEqual(selectProblems(seed, LESSON_PROBLEMS), selectProblems(seed, LESSON_PROBLEMS));
    }
  });

  test('different seeds do not all give the same pair', () => {
    const initials = new Set(sampledSeeds().map((seed) => label(selectProblems(seed, LESSON_PROBLEMS).initial)));
    assert.ok(initials.size > 10, `only ${initials.size} distinct initial problems`);
  });

  test('every seed in a sampled range gives a valid pair (first 6–9, second 4–9, sum 11–18, the first addend plus part of the second makes ten with at least one left)', () => {
    for (const seed of sampledSeeds()) {
      const { initial, independent } = selectProblems(seed, LESSON_PROBLEMS);
      assert.ok(isValidPair(initial), `seed ${seed}: invalid initial ${label(initial)}`);
      assert.ok(isValidPair(independent), `seed ${seed}: invalid independent ${label(independent)}`);
    }
  });

  test('the film seed gives 8 + 5 then 9 + 4', () => {
    assert.deepEqual(selectProblems(FILM_SEED, LESSON_PROBLEMS), {
      initial: { lhs: 8, rhs: 5 },
      independent: { lhs: 9, rhs: 4 },
    });
  });

  test('lesson problems 7 + 4, 7 + 6 and 6 + 5 are never selected', () => {
    const stated = new Set(LESSON_PROBLEMS.map(label));
    const seen = new Set<string>();
    for (const seed of sampledSeeds()) {
      const { initial, independent } = selectProblems(seed, LESSON_PROBLEMS);
      seen.add(label(initial));
      seen.add(label(independent));
    }
    for (const problem of stated) assert.ok(!seen.has(problem), `${problem} was selected`);
    assert.ok(seen.size > 10, 'the sample should cover most of the allowed pairs');
  });

  test('a problem stated with its addends swapped is also excluded', () => {
    const swapped: Problem[] = [{ lhs: 5, rhs: 6 }];
    for (const seed of sampledSeeds()) {
      const { initial, independent } = selectProblems(seed, swapped);
      for (const p of [initial, independent]) assert.notEqual(label(p), '6 + 5', `seed ${seed} selected ${label(p)}`);
    }
  });

  test('the independent pair never equals the initial pair and has the same make-ten structure', () => {
    for (const seed of sampledSeeds()) {
      const { initial, independent } = selectProblems(seed, LESSON_PROBLEMS);
      assert.notDeepEqual(independent, initial, `seed ${seed}`);
      assert.ok(isMakeTenPair(initial) && isMakeTenPair(independent), `seed ${seed}`);
    }
  });

  test('a non-uint32 seed is rejected', () => {
    for (const seed of [-1, 1.5, 0x100000000, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(() => selectProblems(seed, LESSON_PROBLEMS), /seed/, `seed ${seed}`);
    }
    assert.throws(() => selectProblems('7' as unknown as number, LESSON_PROBLEMS), /seed/);
  });

  test('an exclusion set that leaves no valid pair fails visibly', () => {
    const everyPair: Problem[] = [];
    for (let lhs = FIRST_ADDEND_MIN; lhs <= FIRST_ADDEND_MAX; lhs += 1) {
      for (let rhs = SECOND_ADDEND_MIN; rhs <= SECOND_ADDEND_MAX; rhs += 1) everyPair.push({ lhs, rhs });
    }
    assert.throws(() => selectProblems(1, everyPair), /no valid problem/i);
  });

  test('an exclusion set that leaves one valid pair fails visibly, because the independent problem needs a second', () => {
    const allButOne: Problem[] = [];
    for (let lhs = FIRST_ADDEND_MIN; lhs <= FIRST_ADDEND_MAX; lhs += 1) {
      for (let rhs = SECOND_ADDEND_MIN; rhs <= SECOND_ADDEND_MAX; rhs += 1) {
        if (!(lhs === 8 && rhs === 5)) allButOne.push({ lhs, rhs });
      }
    }
    assert.throws(() => selectProblems(1, allButOne), /no valid problem/i);
  });

  test('problemRefOf names a problem addition_<lhs>_<rhs>', () => {
    assert.equal(problemRefOf({ lhs: 8, rhs: 5 }), 'addition_8_5');
    assert.equal(problemRefOf({ lhs: 9, rhs: 4 }), 'addition_9_4');
  });

  test('sample seeds and their pairs', (t) => {
    const lines = [0, 1, 2, 3, 7, 42, 99, 1000, 4242, 65535, 123456789, 305419896, 2147483647, 2147483648, 3000000000, 4000000000, 4294967294, 4294967295, 20261109, FILM_SEED].map((seed) => {
      const { initial, independent } = selectProblems(seed, LESSON_PROBLEMS);
      return `seed ${String(seed).padStart(10)}: ${label(initial)} then ${label(independent)}`;
    });
    assert.equal(lines.length, 20);
    t.diagnostic(`\n${lines.join('\n')}`);
  });
});
