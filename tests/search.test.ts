import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  type Concept,
  type EdgeType,
  type GraphNode,
  type LearningCase,
  MAX_SEARCH_CANDIDATES,
  type NodeType,
  type Outcome,
  SearchResultSchema,
  type Strategy,
  validateCase,
} from '../src/domain.js';
import { buildSearchResult, chooseActivity, compare, paths, rank, rankingHash, rankingHashInput, SEARCH_COMPLETED_MAX_BYTES } from '../src/search.js';

const QUERY_AT = '2026-11-07T12:31:10.468Z';

type NodeSpec = readonly [name: string, type: NodeType, meaning: string];
type EdgeSpec = readonly [from: string, type: EdgeType, to: string];
interface CaseOptions {
  studentId?: string;
  concept?: Concept;
  createdAt?: string;
  strategy?: Strategy;
  outcome?: Outcome;
  // Skip graph validation so a test can build a shape the store would refuse (for example a reversed edge).
  unchecked?: boolean;
}

// Builds a case from local node names so every test states only the structure it cares about.
function makeCase(id: string, nodes: readonly NodeSpec[], edges: readonly EdgeSpec[], options: CaseOptions = {}): LearningCase {
  const sourceId = `${id}:speech`;
  const built: LearningCase = {
    id,
    studentId: options.studentId ?? `student_of_${id}`,
    provenance: 'synthetic',
    createdAt: options.createdAt ?? '2026-10-01T09:00:00.000Z',
    concept: options.concept ?? 'addition_within_20',
    sources: [{ id: sourceId, text: 'I counted the start as one.' }],
    nodes: nodes.map(([name, type, meaning]) => ({ id: `${id}:${name}`, type, meaning, stage: 'context', sourceIds: [sourceId] })),
    edges: edges.map(([from, type, to], index) => ({ id: `${id}:e${index}`, from: `${id}:${from}`, to: `${id}:${to}`, type, stage: 'context' })),
    strategy: options.strategy ?? 'make_ten',
    outcome: options.outcome ?? 'independent',
    retention: 'pending',
  };
  return options.unchecked ? built : validateCase(built);
}

// The film-shaped context graph: attempt, concept, observation, explanation, one hypothesis.
const FILM_NODES = (hypothesis: string): NodeSpec[] => [
  ['attempt', 'Attempt', 'addition'],
  ['concept', 'Concept', 'addition_within_20'],
  ['observation', 'Observation', 'one_move_short'],
  ['explanation', 'Explanation', 'learner_account'],
  ['hypothesis', 'Hypothesis', hypothesis],
];
const FILM_EDGES: EdgeSpec[] = [
  ['attempt', 'TARGETS', 'concept'],
  ['attempt', 'OBSERVED', 'observation'],
  ['observation', 'EXPLAINED_BY', 'explanation'],
  ['explanation', 'SUPPORTS', 'hypothesis'],
];
const filmCase = (id: string, hypothesis = 'count_start', options: CaseOptions = {}) => makeCase(id, FILM_NODES(hypothesis), FILM_EDGES, options);

const query = () => filmCase('query', 'count_start', { studentId: 'student_7', createdAt: QUERY_AT });

describe('paths', () => {
  test('enumerates every directed prefix of 1 to 3 edges with typed labels', () => {
    const keys = paths(query()).map((p) => JSON.parse(p.key) as string[]);
    assert.equal(keys.length, 7);
    assert.deepEqual(
      keys.find((k) => k.length === 7),
      ['Attempt:addition', 'OBSERVED', 'Observation:one_move_short', 'EXPLAINED_BY', 'Explanation:learner_account', 'SUPPORTS', 'Hypothesis:count_start'],
    );
    assert.deepEqual(new Set(paths(query()).map((p) => p.edgeIds.length)), new Set([1, 2, 3]));
  });

  test('never revisits a node within one path', () => {
    const loop = makeCase('loop', [['a', 'Explanation', 'x'], ['b', 'Explanation', 'y']], [['a', 'NEXT', 'b'], ['b', 'NEXT', 'a']], { unchecked: true });
    for (const p of paths(loop)) assert.equal(new Set(p.nodeIds).size, p.nodeIds.length);
    assert.equal(paths(loop).length, 2);
  });

  test('ignores result-stage nodes and edges', () => {
    const base = query();
    const withResult: LearningCase = {
      ...base,
      nodes: [...base.nodes, { id: 'query:intervention', type: 'Intervention', meaning: 'make_ten', stage: 'result', sourceIds: ['query:speech'] }],
      edges: [...base.edges, { id: 'query:r0', from: 'query:attempt', to: 'query:intervention', type: 'FOLLOWED_BY', stage: 'result' }],
    };
    assert.deepEqual(paths(withResult).map((p) => p.key), paths(base).map((p) => p.key));
  });

  test('narrows to the retrieval context when one is given', () => {
    const base = query();
    const narrowed: LearningCase = { ...base, retrievalContext: { nodeIds: ['query:attempt', 'query:concept'], edgeIds: ['query:e0'] } };
    assert.equal(paths(narrowed).length, 1);
  });

  test('a novel hypothesis keys on its meaning and never on the proposed name', () => {
    const novelA = filmCase('a', 'novel');
    const novelB = filmCase('b', 'novel');
    const named = (c: LearningCase, name: string): LearningCase => ({
      ...c,
      nodes: c.nodes.map((n): GraphNode => (n.type === 'Hypothesis' ? { ...n, proposedMeaning: name } : n)),
    });
    assert.deepEqual(paths(named(novelA, 'skip_by_twos')).map((p) => p.key), paths(named(novelB, 'something_else')).map((p) => p.key));
    assert.ok(paths(novelA).some((p) => p.key.includes('Hypothesis:novel')));
    assert.ok(paths(named(novelA, 'skip_by_twos')).every((p) => !p.key.includes('skip_by_twos')));
  });
});

describe('compare', () => {
  test('an identical context scores 1 with coverage 1', () => {
    const result = compare(query(), filmCase('seed_0_0'));
    assert.equal(result.score, 1);
    assert.equal(result.coverage, 1);
    assert.equal(result.queryPathCount, 7);
    assert.equal(result.matched.length, 7);
  });

  test('a slip hypothesis shares 4 path keys: score 5/17, coverage 5/11', () => {
    const result = compare(query(), filmCase('seed_0_1', 'slip'));
    assert.equal(result.score, 5 / 17);
    assert.equal(result.coverage, 5 / 11);
  });

  test('a different hypothesis meaning changes path keys', () => {
    const keys = (c: LearningCase) => new Set(paths(c).map((p) => p.key));
    const countStart = keys(query());
    const slip = keys(filmCase('other', 'slip'));
    const shared = [...countStart].filter((k) => slip.has(k));
    assert.equal(shared.length, 4);
    assert.equal(countStart.size, 7);
  });

  test('same labels with a different edge change the score', () => {
    // Same five nodes, but the hypothesis hangs off the observation instead of the explanation.
    const rewired = makeCase('rewired', FILM_NODES('count_start'), [
      ['attempt', 'TARGETS', 'concept'],
      ['attempt', 'OBSERVED', 'observation'],
      ['observation', 'EXPLAINED_BY', 'explanation'],
      ['observation', 'SUPPORTS', 'hypothesis'],
    ]);
    const result = compare(query(), rewired);
    assert.ok(result.score < 1);
    assert.ok(result.coverage < 1);
  });

  test('same labels with the opposite direction change the score', () => {
    const reversed = makeCase('reversed', FILM_NODES('count_start'), [
      ['attempt', 'TARGETS', 'concept'],
      ['attempt', 'OBSERVED', 'observation'],
      ['observation', 'EXPLAINED_BY', 'explanation'],
      ['hypothesis', 'SUPPORTS', 'explanation'],
    ], { unchecked: true });
    assert.ok(compare(query(), reversed).score < 1);
  });

  test('replacing SUPPORTS with CONTRADICTS changes the score', () => {
    const contradicted = makeCase('contradicted', FILM_NODES('count_start'), [
      ['attempt', 'TARGETS', 'concept'],
      ['attempt', 'OBSERVED', 'observation'],
      ['observation', 'EXPLAINED_BY', 'explanation'],
      ['explanation', 'CONTRADICTS', 'hypothesis'],
    ]);
    assert.ok(compare(query(), contradicted).score < 1);
  });

  test('repeated occurrences of one labelled path count separately', () => {
    const twoObservations = makeCase('twice', [['attempt', 'Attempt', 'addition'], ['first', 'Observation', 'x'], ['second', 'Observation', 'x']], [
      ['attempt', 'OBSERVED', 'first'],
      ['attempt', 'OBSERVED', 'second'],
    ]);
    const oneObservation = makeCase('once', [['attempt', 'Attempt', 'addition'], ['first', 'Observation', 'x']], [['attempt', 'OBSERVED', 'first']]);
    const result = compare(twoObservations, oneObservation);
    assert.equal(result.score, 1 / 2);
    assert.equal(result.coverage, 1 / 2);
  });

  test('two contexts with no path in common score 0, and an empty query scores 0', () => {
    const lone = makeCase('lone', [['attempt', 'Attempt', 'addition']], []);
    assert.deepEqual([compare(lone, query()).score, compare(lone, query()).coverage], [0, 0]);
    assert.deepEqual([compare(query(), lone).score, compare(query(), lone).coverage], [0, 0]);
  });

  test('changing only outcome or strategy leaves similarity unchanged', () => {
    const base = compare(query(), filmCase('c1', 'count_start', { strategy: 'make_ten', outcome: 'independent' }));
    const changed = compare(query(), filmCase('c1', 'count_start', { strategy: 'repeat_count', outcome: 'failed' }));
    assert.equal(changed.score, base.score);
    assert.equal(changed.coverage, base.coverage);
    assert.deepEqual(changed.matched, base.matched);
  });

  test('every matched pair resolves to real edges with the same type and direction', () => {
    const q = makeCase('q', [
      ['attempt', 'Attempt', 'addition'],
      ['concept', 'Concept', 'addition_within_20'],
      ['first', 'Observation', 'one_move_short'],
      ['second', 'Observation', 'one_move_short'],
      ['explanation', 'Explanation', 'learner_account'],
      ['hypothesis', 'Hypothesis', 'count_start'],
    ], [
      ['attempt', 'TARGETS', 'concept'],
      ['attempt', 'OBSERVED', 'first'],
      ['attempt', 'OBSERVED', 'second'],
      ['first', 'EXPLAINED_BY', 'explanation'],
      ['explanation', 'SUPPORTS', 'hypothesis'],
    ]);
    const candidate = filmCase('candidate');
    const result = compare(q, candidate);
    assert.ok(result.matched.length > 0);
    const check = (owner: LearningCase, path: { nodeIds: string[]; edgeIds: string[] }, label: string[]) => {
      assert.equal(path.edgeIds.length, path.nodeIds.length - 1);
      path.edgeIds.forEach((edgeId, index) => {
        const edge = owner.edges.find((e) => e.id === edgeId);
        assert.ok(edge, `edge ${edgeId} exists in ${owner.id}`);
        assert.equal(edge.from, path.nodeIds[index]);
        assert.equal(edge.to, path.nodeIds[index + 1]);
        assert.equal(edge.type, label[index * 2 + 1]);
      });
    };
    for (const pair of result.matched) {
      assert.equal(pair.query.key, pair.candidate.key);
      const label = JSON.parse(pair.query.key) as string[];
      check(q, pair.query, label);
      check(candidate, pair.candidate, label);
    }
  });
});

describe('invariance', () => {
  // Renames every local ID, reorders the arrays and adds layout and text noise that must not matter.
  // The query must still pass case validation, so layout fields are added only where `withNoise` is set.
  function perturb(c: LearningCase, withNoise = true): LearningCase {
    const rename = (id: string) => `${c.id}:renamed_${id.slice(c.id.length + 1)}`;
    const nodes = c.nodes.map((n) => Object.assign({}, n, { id: rename(n.id) }, withNoise ? { x: 41, y: -7, color: '#abc' } : {})).reverse();
    const edges = c.edges.map((e) => ({ ...e, id: `${c.id}:r_${e.id.slice(c.id.length + 1)}`, from: rename(e.from), to: rename(e.to) })).reverse();
    return { ...c, nodes, edges, sources: c.sources.map((s) => ({ ...s, text: 'completely different words' })) };
  }

  test('renamed IDs, reordered arrays and changed coordinates leave score and coverage unchanged', () => {
    const candidates = [filmCase('c1'), filmCase('c2', 'slip')];
    for (const candidate of candidates) {
      const before = compare(query(), candidate);
      const after = compare(perturb(query()), perturb(candidate));
      assert.equal(after.score, before.score);
      assert.equal(after.coverage, before.coverage);
      const matchedKeys = (r: typeof before) => r.matched.map((m) => m.query.key).sort();
      assert.deepEqual(matchedKeys(after), matchedKeys(before));
    }
  });

  test('path keys carry no ID, coordinate, colour or source text', () => {
    for (const p of paths(perturb(query()))) {
      assert.ok(!p.key.includes('renamed'));
      assert.ok(!p.key.includes('#abc'));
      assert.ok(!p.key.includes('different words'));
    }
  });

  test('the ranking and its hash survive a reordered corpus and perturbed graphs', async () => {
    const corpus = ['c1', 'c2', 'c3', 'c4'].map((id, i) => filmCase(id, i % 2 === 0 ? 'count_start' : 'slip'));
    const before = rank(query(), corpus);
    const after = rank(perturb(query(), false), [...corpus].reverse().map((c) => perturb(c)));
    assert.deepEqual(after.map((r) => [r.id, r.score, r.coverage]), before.map((r) => [r.id, r.score, r.coverage]));
    assert.equal(await rankingHash(after), await rankingHash(before));
  });
});

describe('rank', () => {
  const corpus = () => [
    filmCase('same_learner', 'count_start', { studentId: 'student_7' }),
    filmCase('other_concept', 'count_start', { concept: 'subtraction_within_20' }),
    filmCase('future', 'count_start', { createdAt: '2026-11-07T12:31:10.469Z' }),
    filmCase('eligible', 'count_start'),
  ];

  test('same learner, other concept and future cases are excluded', () => {
    assert.deepEqual(rank(query(), corpus()).map((r) => r.id), ['eligible']);
  });

  test('the query itself is excluded', () => {
    assert.deepEqual(rank(query(), [{ ...query(), studentId: 'student_other' }]).map((r) => r.id), []);
  });

  test('a case recorded at the same instant is kept, whatever the fraction spelling', () => {
    const sameInstant = filmCase('same_instant', 'count_start', { createdAt: '2026-11-07T12:31:10.468Z' });
    const shorter = filmCase('shorter_spelling', 'count_start', { createdAt: '2026-11-07T12:31:10.468000Z' });
    const query0 = { ...query(), createdAt: '2026-11-07T12:31:10Z' };
    const noFraction = filmCase('whole_second', 'count_start', { createdAt: '2026-11-07T12:31:10.000Z' });
    assert.deepEqual(rank(query(), [sameInstant, shorter]).map((r) => r.id), ['same_instant', 'shorter_spelling']);
    assert.deepEqual(rank(query0, [noFraction]).map((r) => r.id), ['whole_second']);
  });

  test('ties sort by case ID', () => {
    const tied = ['c_b', 'c_c', 'c_a'].map((id) => filmCase(id));
    assert.deepEqual(rank(query(), tied).map((r) => r.id), ['c_a', 'c_b', 'c_c']);
  });

  test('a higher score sorts first whatever the ID', () => {
    const ranked = rank(query(), [filmCase('a_slip', 'slip'), filmCase('z_match', 'count_start')]);
    assert.deepEqual(ranked.map((r) => r.id), ['z_match', 'a_slip']);
  });

  test('each row carries the case metadata the decision reads', () => {
    const [row] = rank(query(), [filmCase('c1', 'count_start', { strategy: 'anchor_start', outcome: 'assisted' })]);
    assert.ok(row);
    assert.equal(row.studentId, 'student_of_c1');
    assert.equal(row.provenance, 'synthetic');
    assert.equal(row.strategy, 'anchor_start');
    assert.equal(row.outcome, 'assisted');
    assert.equal(row.candidatePathCount, 7);
  });

  test('an invalid query is rejected before anything is ranked', () => {
    const leaking: LearningCase = {
      ...query(),
      nodes: [...query().nodes, { id: 'query:outcome', type: 'Outcome', meaning: 'independent', stage: 'context', sourceIds: ['query:speech'] }],
    };
    assert.throws(() => rank(leaking, [filmCase('c1')]), /Outcome leakage/);
  });
});

describe('rankingHash', () => {
  test('is a 64-character SHA-256 hex digest of the ranked IDs and similarity facts', async () => {
    const ranked = rank(query(), [filmCase('c1'), filmCase('c2', 'slip')]);
    assert.match(await rankingHash(ranked), /^[0-9a-f]{64}$/);
  });

  test('changes when the ranking order or any score changes', async () => {
    const one = rank(query(), [filmCase('c1'), filmCase('c2', 'slip')]);
    const swapped = rank(query(), [filmCase('c1', 'slip'), filmCase('c2')]);
    assert.notEqual(await rankingHash(one), await rankingHash(swapped));
    assert.notEqual(rankingHashInput(one), rankingHashInput(swapped));
  });

  test('ignores strategy and outcome, which are not part of similarity', async () => {
    const a = rank(query(), [filmCase('c1', 'count_start', { outcome: 'independent' })]);
    const b = rank(query(), [filmCase('c1', 'count_start', { outcome: 'failed', strategy: 'repeat_count' })]);
    assert.equal(await rankingHash(a), await rankingHash(b));
  });
});

describe('search result summary', () => {
  const CORPUS_HASH = 'c0ffee';
  const OUTCOMES: Outcome[] = ['independent', 'assisted', 'failed', 'not_assessed'];

  // A mixed corpus: close matches with every outcome, and weaker slip-shaped cases.
  function corpus(size: number): LearningCase[] {
    return Array.from({ length: size }, (_, i) =>
      filmCase(`case_${String(i).padStart(4, '0')}`, i % 3 === 0 ? 'slip' : 'count_start', { strategy: i % 2 === 0 ? 'make_ten' : 'anchor_start', outcome: OUTCOMES[i % OUTCOMES.length] }),
    );
  }

  // A realistic shape: a few close matches among many distant ones, as in the pinned corpus.
  function mostlyDistant(size: number, close: number): LearningCase[] {
    return corpus(size).map((c, i) => (i < close ? c : filmCase(c.id, 'slip', { strategy: c.strategy, outcome: c.outcome })));
  }

  async function summarize(cases: LearningCase[]) {
    const q = query();
    const ranked = rank(q, cases);
    return { ranked, result: buildSearchResult({ query: q, corpusHash: CORPUS_HASH, ranked, decision: chooseActivity(q, ranked, false), rankingHash: await rankingHash(ranked) }) };
  }

  test('carries the identity, the candidate count and the hash, and satisfies the shared schema', async () => {
    const { ranked, result } = await summarize(corpus(30));
    assert.doesNotThrow(() => SearchResultSchema.parse(result));
    assert.equal(result.matchingVersion, 'typed-path-v1');
    assert.equal(result.corpusHash, CORPUS_HASH);
    assert.equal(result.queryId, 'query');
    assert.equal(result.candidateCount, ranked.length);
    assert.equal(result.rankingHash, await rankingHash(ranked));
  });

  test('lists at most the top 20 candidates in rank order, with matched node IDs from both sides', async () => {
    const { ranked, result } = await summarize(corpus(30));
    assert.equal(result.candidates.length, MAX_SEARCH_CANDIDATES);
    assert.deepEqual(result.candidates.map((c) => c.id), ranked.slice(0, MAX_SEARCH_CANDIDATES).map((r) => r.id));
    const [first] = result.candidates;
    assert.ok(first);
    assert.ok(first.matchedQueryNodeIds.every((id) => id.startsWith('query:')));
    assert.ok(first.matchedCandidateNodeIds.every((id) => id.startsWith(`${first.id}:`)));
  });

  test('scores holds every ranked case in rank order, rounded to 3 decimals', async () => {
    const { ranked, result } = await summarize(corpus(30));
    assert.deepEqual(result.scores.map(([id]) => id), ranked.map((r) => r.id));
    assert.deepEqual(result.scores.map(([, score]) => score), ranked.map((r) => Math.round(r.score * 1000) / 1000));
    assert.ok(result.scores.some(([, score]) => score === 0.294));
  });

  test('admitted lists the admitted assessed cases with their candidate edge IDs', async () => {
    const cases = corpus(30);
    const { result } = await summarize(cases);
    assert.ok(result.admitted.length > 0);
    for (const admitted of result.admitted) {
      const source = cases.find((c) => c.id === admitted.caseId);
      assert.ok(source);
      assert.equal(admitted.score, 1);
      assert.notEqual(admitted.outcome, 'not_assessed' as string);
      assert.ok(admitted.matchedEdgeIds.length > 0);
      assert.ok(admitted.matchedEdgeIds.every((edgeId) => source.edges.some((e) => e.id === edgeId)));
      assert.equal(new Set(admitted.matchedEdgeIds).size, admitted.matchedEdgeIds.length);
    }
    // 20 count_start cases, a quarter of them not assessed; the slip cases score 5/17 and are not admitted.
    const countStart = cases.filter((_, i) => i % 3 !== 0);
    assert.equal(result.admitted.length, countStart.filter((c) => c.outcome !== 'not_assessed').length);
  });

  test('admitted and groups agree with the decision the same call made', async () => {
    const { result } = await summarize(corpus(30));
    const tally = new Map<string, number>();
    for (const a of result.admitted) tally.set(a.strategy, (tally.get(a.strategy) ?? 0) + 1);
    for (const group of result.decision.groups) assert.equal(group.total, tally.get(group.strategy));
    assert.equal(result.decision.groups.length, tally.size);
  });

  test('an empty ranking still builds a valid summary', async () => {
    const { result } = await summarize([]);
    assert.deepEqual([result.candidateCount, result.candidates, result.scores, result.admitted], [0, [], [], []]);
    assert.equal(result.decision.basis, 'default');
  });

  test('stays under the payload cap with a full-size corpus: at most 20 candidates plus the compact summary', async () => {
    const { result } = await summarize(mostlyDistant(700, 60));
    const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
    assert.ok(bytes < SEARCH_COMPLETED_MAX_BYTES, `${bytes} bytes`);
    assert.equal(result.candidates.length, MAX_SEARCH_CANDIDATES);
    assert.equal(result.scores.length, result.candidateCount);
  });

  test('refuses to build a summary over the payload cap instead of emitting an oversize event', async () => {
    await assert.rejects(summarize(mostlyDistant(5000, 60)), /exceeds/);
  });
});
