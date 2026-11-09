import { type Problem, SeedSchema } from './domain.js';

// Bounds of a selectable addition problem. A first addend of 6 to 9 and a second addend of 4 to 9
// with a sum of 11 to 18 means the sum always crosses ten, so a make-ten split always leaves objects
// over. Change a bound only together with the validity test over sampled seeds.
export const FIRST_ADDEND_MIN = 6;
export const FIRST_ADDEND_MAX = 9;
export const SECOND_ADDEND_MIN = 4;
export const SECOND_ADDEND_MAX = 9;
export const SUM_MIN = 11;
export const SUM_MAX = 18;

// The recording locks its run to this seed so the child sees 8 + 5 and then 9 + 4. It is a plain
// uint32 found by search over the selection rule below, for a lesson that states 7 + 4, 7 + 6 and
// 6 + 5 (the prepared lesson). A lesson stating other problems can shift the pair. Changing the
// pair order or the PRNG invalidates it; the film-seed test fails first.
export const FILM_SEED = 28;

export type ProblemPair = { initial: Problem; independent: Problem };

// Identifier of a problem inside activity specs and contexts, for example `addition_8_5`.
export const problemRefOf = ({ lhs, rhs }: Problem): string => `addition_${lhs}_${rhs}`;

export class ProblemSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProblemSelectionError';
  }
}

// Commutative twins are one problem: a lesson that states 5 + 6 also rules out 6 + 5.
const problemKey = ({ lhs, rhs }: Problem): string => `${Math.min(lhs, rhs)}+${Math.max(lhs, rhs)}`;

// The first addend plus part of the second makes ten and at least one object is left over.
function leavesObjectsAfterTen({ lhs, rhs }: Problem): boolean {
  return rhs > 10 - lhs;
}

function allowedProblems(lessonProblems: readonly Problem[]): Problem[] {
  const stated = new Set(lessonProblems.map(problemKey));
  const allowed: Problem[] = [];
  for (let lhs = FIRST_ADDEND_MIN; lhs <= FIRST_ADDEND_MAX; lhs += 1) {
    for (let rhs = SECOND_ADDEND_MIN; rhs <= SECOND_ADDEND_MAX; rhs += 1) {
      const problem = { lhs, rhs };
      const sum = lhs + rhs;
      if (sum < SUM_MIN || sum > SUM_MAX || !leavesObjectsAfterTen(problem)) continue;
      if (!stated.has(problemKey(problem))) allowed.push(problem);
    }
  }
  return allowed;
}

// Small seeded generator (mulberry32) so a stored seed reproduces the pair in any runtime.
function seededUnit(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// The only place that picks the numbers of a run. The independent problem is a different allowed
// pair, so it has the same make-ten structure as the initial one by construction. Lesson problems
// are never selected.
export function selectProblems(seed: number, lessonProblems: readonly Problem[]): ProblemPair {
  if (!SeedSchema.safeParse(seed).success) throw new ProblemSelectionError('The problem seed must be an unsigned 32-bit integer');
  const allowed = allowedProblems(lessonProblems);
  if (allowed.length < 2) {
    throw new ProblemSelectionError(`No valid problem pair is left: ${allowed.length} allowed problem(s) after the lesson exclusions, 2 needed`);
  }
  const unit = seededUnit(seed);
  const initialIndex = Math.floor(unit() * allowed.length);
  const initial = allowed[initialIndex];
  const rest = allowed.filter((_, index) => index !== initialIndex);
  const independent = rest[Math.floor(unit() * rest.length)];
  if (initial === undefined || independent === undefined) throw new ProblemSelectionError('Problem selection drew outside the allowed set');
  return { initial, independent };
}
