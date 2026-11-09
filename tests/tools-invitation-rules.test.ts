import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { INVITATION_COPY } from '../src/copy.js';
import { loadSeed } from '../src/dataset.js';
import type { Concept, ConceptLink, MemoryCase } from '../src/domain.js';
import { FILM_SEED, selectProblems } from '../src/problems.js';
import { checkInvitation, extractLessonProblems, invitationCopy, INVITATION_TODAY_CONCEPT } from '../src/tools.js';

const links = loadSeed().conceptLinks;
const lessonText = readFileSync(new URL('../data/lesson/lesson-transcript.txt', import.meta.url), 'utf8');
const QUOTE = 'The start is a place. A jump is a move.';

const memoryCase = (caseId: string, concept: MemoryCase['concept'], outcome: MemoryCase['outcome'] = 'failed'): MemoryCase => ({ caseId, concept, strategy: 'anchor_start', outcome, retention: 'pending', nodeIds: [`${caseId}:attempt`] });
const returned = (...cases: MemoryCase[]) => new Map(cases.map((c) => [c.caseId, c]));
type Input = { todayConceptId: Concept | null; quotes: string[]; evidenceIds: string[] };
const valid: Input = { todayConceptId: INVITATION_TODAY_CONCEPT, quotes: [QUOTE], evidenceIds: ['sub_1'] };
const history = returned(memoryCase('sub_1', 'subtraction_within_20'), memoryCase('add_1', 'addition_within_20', 'independent'));

const check = (overrides: Partial<Input> = {}, options: { cases?: ReturnType<typeof returned>; links?: readonly ConceptLink[]; text?: string } = {}) =>
  checkInvitation({
    input: { ...valid, ...overrides },
    lessonText: options.text ?? lessonText,
    returnedCases: options.cases ?? history,
    links: options.links ?? links,
  });

describe('invitation eligibility', () => {
  test('the demo history passes all three conditions', () => {
    assert.deepEqual(check().failures, []);
  });

  test('a concept other than addition_within_20 fails condition 1 alone', () => {
    const result = check({ todayConceptId: 'subtraction_within_20' });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0] ?? '', /Condition 1: todayConceptId/);
  });

  test('a quote that is not in the saved lesson fails condition 1 alone', () => {
    const result = check({ quotes: ['Take away means go forward, right?'] });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0] ?? '', /Condition 1: quote .* is not in the saved lesson/);
  });

  test('every quote must occur, not just one', () => {
    assert.equal(check({ quotes: [QUOTE, 'a line nobody said'] }).failures.length, 1);
  });

  test('an evidence ID this run never read fails condition 2 alone', () => {
    const result = check({ evidenceIds: ['sub_1', 'sub_99'] });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0] ?? '', /Condition 2: sub_99 not returned by get_personal_memory in this run/);
  });

  test('evidence on an unlinked concept fails condition 3 alone', () => {
    const withoutSimilar = links.filter((l) => l.kind !== 'similar');
    const result = check({}, { links: withoutSimilar });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0] ?? '', /Condition 3: sub_1 is on a concept that is neither addition_within_20 nor linked to it/);
  });

  test('independent-only history is eligible', () => {
    assert.deepEqual(check({ evidenceIds: ['add_1'] }).failures, []);
    const onlyIndependent = returned(memoryCase('sub_2', 'subtraction_within_20', 'independent'));
    assert.deepEqual(check({ evidenceIds: ['sub_2'] }, { cases: onlyIndependent }).failures, []);
  });

  test('not assessed evidence is eligible too', () => {
    const cases = returned(memoryCase('sub_3', 'subtraction_within_20', 'not_assessed'));
    assert.deepEqual(check({ evidenceIds: ['sub_3'] }, { cases }).failures, []);
  });

  test('all failing conditions are named in one message so one correction fixes them', () => {
    const result = check({ todayConceptId: 'subtraction_within_20', quotes: ['nobody said this'], evidenceIds: ['missing'] });
    assert.equal(result.failures.length, 3);
  });

  test('duplicate evidence IDs are rejected', () => {
    assert.match(check({ evidenceIds: ['sub_1', 'sub_1'] }).failures.join(), /distinct/);
  });
});

describe('invitation copy', () => {
  test('mixed evidence gives the linked copy; same-concept-only gives the same-concept copy', () => {
    assert.equal(check({ evidenceIds: ['sub_1', 'add_1'] }).usesLinkedConcept, true);
    assert.equal(check({ evidenceIds: ['add_1'] }).usesLinkedConcept, false);
    assert.equal(invitationCopy(true).body, INVITATION_COPY.bodyLinkedConcept);
    assert.equal(invitationCopy(false).body, INVITATION_COPY.bodySameConcept);
    assert.equal(invitationCopy(true).title, INVITATION_COPY.title);
  });
});

describe('lesson problems', () => {
  test('finds the additions the prepared lesson states, in words', () => {
    assert.deepEqual(extractLessonProblems(lessonText), [
      { lhs: 7, rhs: 4 },
      { lhs: 7, rhs: 6 },
      { lhs: 6, rhs: 5 },
    ]);
  });

  test('finds digits and ignores repeats and other text', () => {
    assert.deepEqual(extractLessonProblems('Try 8 + 5, then 8 + 5 again. Plus we need ten.'), [{ lhs: 8, rhs: 5 }]);
    assert.deepEqual(extractLessonProblems('No sums here.'), []);
  });

  test('the film seed with the prepared lesson draws 8 + 5 then 9 + 4', () => {
    assert.deepEqual(selectProblems(FILM_SEED, extractLessonProblems(lessonText)), { initial: { lhs: 8, rhs: 5 }, independent: { lhs: 9, rhs: 4 } });
  });
});
