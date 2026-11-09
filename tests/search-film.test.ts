import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { CaseSchema, MAX_SEARCH_CANDIDATES, validateCase } from '../src/domain.js';
import { buildSearchResult, chooseActivity, compare, rank, rankingHash, SEARCH_COMPLETED_MAX_BYTES } from '../src/search.js';

// The pinned synthetic corpus and the recorded film query. Read here only; tests never write data.
const readJson = (relative: string): unknown => JSON.parse(readFileSync(new URL(`../data/${relative}`, import.meta.url), 'utf8'));
const seed = CaseSchema.array().parse(readJson('seed/cases.json'));
const capture = readJson('captures/backend.capture.json') as { query: unknown; ranking: { id: string; score: number; coverage: number }[]; decision: { strategy: string; evidenceIds: string[]; reason: string } };
const filmQuery = validateCase(capture.query);
const corpusHash = (readJson('seed/manifest.json') as { sha256: string }).sha256;

const ranked = rank(filmQuery, seed);
const decision = chooseActivity(filmQuery, ranked, false);
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

describe('film query', () => {
  test('film query compares 659 candidates, admits 59 at threshold 0.88 and groups make_ten 23/29, anchor_start 14/22, repeat_count 3/8', async () => {
    const result = buildSearchResult({ query: filmQuery, corpusHash, ranked, decision, rankingHash: await rankingHash(ranked) });
    assert.equal(result.candidateCount, 659);
    assert.equal(ranked[0]?.score, 1);
    assert.equal(result.admitted.length, 59);
    assert.ok(result.admitted.every((a) => a.score >= 0.88));
    assert.deepEqual(result.decision.groups, [
      { strategy: 'make_ten', independent: 23, total: 29 },
      { strategy: 'anchor_start', independent: 14, total: 22 },
      { strategy: 'repeat_count', independent: 3, total: 8 },
    ]);
  });

  test('film path count_start chooses make_ten / make_ten_blocks with basis evidence and 29 evidence IDs', () => {
    assert.deepEqual([decision.strategy, decision.templateId, decision.basis], ['make_ten', 'make_ten_blocks', 'evidence']);
    assert.equal(decision.evidenceIds.length, 29);
    assert.equal(decision.reason, '23/29 comparable historical cases have an independent result; observational evidence, not a treatment effect.');
    assert.deepEqual(decision.evidenceIds, capture.decision.evidenceIds);
  });

  test('the recomputed ranking equals the recorded ranking: same order, score and coverage for all 659 cases', () => {
    assert.equal(capture.ranking.length, ranked.length);
    ranked.forEach((r, i) => {
      assert.equal(r.id, capture.ranking[i]?.id);
      assert.equal(r.score, capture.ranking[i]?.score);
      assert.equal(r.coverage, capture.ranking[i]?.coverage);
    });
  });

  test('the worked example: seed_0_0 scores 1 with coverage 1; seed_0_1 scores 5/17 with coverage 5/11', () => {
    const byId = (id: string) => {
      const found = seed.find((c) => c.id === id);
      assert.ok(found, id);
      return found;
    };
    const identical = compare(filmQuery, byId('seed_0_0'));
    assert.deepEqual([identical.score, identical.coverage], [1, 1]);
    const slip = compare(filmQuery, byId('seed_0_1'));
    assert.deepEqual([slip.score, slip.coverage], [5 / 17, 5 / 11]);
    assert.equal(slip.queryPathCount, 7);
  });

  test('the ranking excludes the demo learner, other concepts and the query itself', () => {
    const byId = new Map(seed.map((c) => [c.id, c]));
    for (const r of ranked) {
      const c = byId.get(r.id);
      assert.ok(c);
      assert.notEqual(c.studentId, filmQuery.studentId);
      assert.equal(c.concept, filmQuery.concept);
      assert.ok(Date.parse(c.createdAt) <= Date.parse(filmQuery.createdAt));
    }
  });

  test('a reordered seed gives the same ranking and rankingHash', async () => {
    const reordered = rank(filmQuery, [...seed].reverse());
    assert.deepEqual(reordered.map((r) => r.id), ranked.map((r) => r.id));
    assert.equal(await rankingHash(reordered), await rankingHash(ranked));
  });

  test('search.completed summary stays under 64 KiB on the film query with at most 20 candidates plus candidateCount, rankingHash, scores, admitted and decision.groups', async (t) => {
    const result = buildSearchResult({ query: filmQuery, corpusHash, ranked, decision, rankingHash: await rankingHash(ranked) });
    const total = bytesOf(result);
    t.diagnostic(`film summary ${total} bytes (decision ${bytesOf(result.decision)}, scores ${bytesOf(result.scores)}, admitted ${bytesOf(result.admitted)}, candidates ${bytesOf(result.candidates)})`);
    assert.ok(total < SEARCH_COMPLETED_MAX_BYTES);
    assert.equal(result.candidates.length, MAX_SEARCH_CANDIDATES);
    assert.equal(result.candidateCount, 659);
    assert.equal(result.scores.length, 659);
    assert.match(result.rankingHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.scores[0], [ranked[0]?.id, 1]);
  });
});
