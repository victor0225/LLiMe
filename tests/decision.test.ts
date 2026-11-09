import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type Decision, DecisionSchema, type EdgeType, type LearningCase, type Outcome, type Strategy, TEMPLATE_KIND } from '../src/domain.js';
import { ADMISSION_MIN_COVERAGE, ADMISSION_MIN_SCORE, ADMISSION_TOP_MARGIN, ALLOWED_STRATEGIES, chooseActivity, DEFAULT_STRATEGY, type RankedCase, STRATEGY_TEMPLATE } from '../src/search.js';

interface HypothesisSpec {
  meaning: string;
  relation?: Extract<EdgeType, 'SUPPORTS' | 'CONTRADICTS'>;
  // Where the edge starts: the current explanation, an earlier one that a NEXT edge superseded, or the observation.
  from?: 'explanation' | 'prior' | 'observation';
  // Also contradicts the same hypothesis from this node.
  contradictedFrom?: 'explanation' | 'prior' | 'observation';
}

// A query whose only interesting part is its hypotheses.
function queryWith(specs: readonly HypothesisSpec[]): LearningCase {
  const id = 'query';
  const sourceId = `${id}:speech`;
  const node = (name: string, type: LearningCase['nodes'][number]['type'], meaning: string) => ({ id: `${id}:${name}`, type, meaning, stage: 'context' as const, sourceIds: [sourceId] });
  const edge = (index: number, from: string, type: EdgeType, to: string) => ({ id: `${id}:e${index}`, from: `${id}:${from}`, to: `${id}:${to}`, type, stage: 'context' as const });
  const hypotheses = specs.map((spec, index) => ({ spec, name: `hypothesis_${index}` }));
  return {
    id,
    studentId: 'student_7',
    provenance: 'synthetic',
    createdAt: '2026-11-07T12:31:10.468Z',
    concept: 'addition_within_20',
    sources: [{ id: sourceId, text: 'I counted eight, nine, ten.' }],
    nodes: [
      node('attempt', 'Attempt', 'addition'),
      node('observation', 'Observation', 'one_move_short'),
      node('prior', 'Explanation', 'earlier_account'),
      node('explanation', 'Explanation', 'learner_account'),
      ...hypotheses.map(({ spec, name }) => node(name, 'Hypothesis', spec.meaning)),
    ],
    edges: [
      edge(0, 'attempt', 'OBSERVED', 'observation'),
      edge(1, 'observation', 'EXPLAINED_BY', 'prior'),
      edge(2, 'prior', 'NEXT', 'explanation'),
      ...hypotheses.map(({ spec, name }, index) => edge(3 + index, spec.from ?? 'explanation', spec.relation ?? 'SUPPORTS', name)),
      ...hypotheses.flatMap(({ spec, name }, index) => (spec.contradictedFrom ? [edge(100 + index, spec.contradictedFrom, 'CONTRADICTS', name)] : [])),
    ],
    strategy: 'clarify',
    outcome: 'not_assessed',
    retention: 'pending',
  };
}
const single = (meaning: string) => queryWith([{ meaning }]);

function row(id: string, score: number, coverage: number, strategy: Strategy, outcome: Outcome): RankedCase {
  return { id, studentId: `student_of_${id}`, provenance: 'synthetic', score, coverage, matched: [], queryPathCount: 7, candidatePathCount: 7, strategy, outcome };
}

// Rows of one strategy at full similarity, with the given number of results of each outcome.
function evidence(strategy: Strategy, counts: Partial<Record<Outcome, number>>, score = 1, coverage = 1): RankedCase[] {
  return (Object.entries(counts) as [Outcome, number][]).flatMap(([outcome, count]) =>
    Array.from({ length: count }, (_, i) => row(`${strategy}_${outcome}_${i}`, score, coverage, strategy, outcome)),
  );
}

// Rank order is what `rank` produces: score descending, then ID.
const ranked = (...groups: RankedCase[][]): RankedCase[] => groups.flat().sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

// Every decision must satisfy the shared contract; the tests then look at what it says.
function decide(query: LearningCase, rows: RankedCase[], needsClarification = false): Decision {
  return DecisionSchema.parse(chooseActivity(query, rows, needsClarification));
}

const STRONG_MAKE_TEN = () => ranked(evidence('make_ten', { independent: 4 }), evidence('anchor_start', { independent: 1, failed: 2 }));
const NOVEL_REASON = 'A possible new pattern has no recorded history. Ask the child to show their steps.';
const SLIP_ONLY_REASON = /application policy/i;

describe('clarify gate', () => {
  test('needsClarification clarifies even with strong evidence', () => {
    const decision = decide(single('count_start'), STRONG_MAKE_TEN(), true);
    assert.equal(decision.strategy, 'clarify');
    assert.equal(decision.basis, 'clarify');
    assert.deepEqual(decision.evidenceIds, []);
  });

  test('count_start or slip only gives clarify_first_number', () => {
    assert.equal(decide(single('count_start'), [], true).templateId, 'clarify_first_number');
    assert.equal(decide(single('slip'), [], true).templateId, 'clarify_first_number');
    assert.equal(decide(queryWith([{ meaning: 'count_start' }, { meaning: 'slip' }]), []).templateId, 'clarify_first_number');
  });

  test('any other clarification gives clarify_show_steps', () => {
    assert.equal(decide(single('partition_gap'), [], true).templateId, 'clarify_show_steps');
    assert.equal(decide(single('direction_error'), [], true).templateId, 'clarify_show_steps');
    assert.equal(decide(queryWith([{ meaning: 'count_start' }, { meaning: 'partition_gap' }]), []).templateId, 'clarify_show_steps');
  });

  test('no active hypothesis clarifies', () => {
    const decision = decide(queryWith([]), STRONG_MAKE_TEN());
    assert.deepEqual([decision.strategy, decision.basis, decision.templateId], ['clarify', 'clarify', 'clarify_show_steps']);
  });

  test('two different active hypotheses clarify', () => {
    const decision = decide(queryWith([{ meaning: 'count_start' }, { meaning: 'partition_gap' }]), STRONG_MAKE_TEN());
    assert.deepEqual([decision.strategy, decision.basis], ['clarify', 'clarify']);
  });

  test('the same meaning written twice is one hypothesis', () => {
    const decision = decide(queryWith([{ meaning: 'count_start' }, { meaning: 'count_start' }]), STRONG_MAKE_TEN());
    assert.equal(decision.basis, 'evidence');
  });

  test('a contradicted hypothesis is not active', () => {
    const contradicted = queryWith([{ meaning: 'count_start', contradictedFrom: 'observation' }]);
    assert.equal(decide(contradicted, STRONG_MAKE_TEN()).basis, 'clarify');
  });

  test('a contradiction from a superseded explanation no longer counts', () => {
    const decision = decide(queryWith([{ meaning: 'count_start', contradictedFrom: 'prior' }]), STRONG_MAKE_TEN());
    assert.equal(decision.basis, 'evidence');
  });

  test('a hypothesis of a superseded explanation is not active', () => {
    const decision = decide(queryWith([{ meaning: 'partition_gap', from: 'prior' }, { meaning: 'count_start' }]), STRONG_MAKE_TEN());
    assert.deepEqual([decision.basis, decision.strategy], ['evidence', 'make_ten']);
  });

  test('a hypothesis supported by the observation is active', () => {
    assert.equal(decide(queryWith([{ meaning: 'count_start', from: 'observation' }]), STRONG_MAKE_TEN()).basis, 'evidence');
  });

  test('unknown clarifies with clarify_show_steps', () => {
    const decision = decide(single('unknown'), STRONG_MAKE_TEN());
    assert.deepEqual([decision.strategy, decision.basis, decision.templateId], ['clarify', 'clarify', 'clarify_show_steps']);
  });

  test('a single active novel gives clarify with the novel reason even when scores pass', () => {
    const decision = decide(single('novel'), STRONG_MAKE_TEN());
    assert.deepEqual([decision.strategy, decision.basis, decision.templateId, decision.reason], ['clarify', 'clarify', 'clarify_show_steps', NOVEL_REASON]);
    assert.deepEqual(decision.evidenceIds, []);
  });

  test('novel plus another supported meaning gives clarify', () => {
    for (const other of ['count_start', 'slip', 'partition_gap', 'unknown']) {
      const decision = decide(queryWith([{ meaning: 'novel' }, { meaning: other }]), STRONG_MAKE_TEN());
      assert.deepEqual([decision.strategy, decision.basis, decision.templateId], ['clarify', 'clarify', 'clarify_show_steps'], other);
    }
  });

  test('a clarification still lists what the admitted cases did, so the screen reads one source', () => {
    const decision = decide(single('novel'), STRONG_MAKE_TEN());
    assert.deepEqual(decision.groups.map((g) => g.strategy), ['make_ten', 'anchor_start']);
  });
});

describe('slip policy', () => {
  test('a single slip gives retry / manipulation_retry with basis policy and no evidence', () => {
    const decision = decide(single('slip'), STRONG_MAKE_TEN());
    assert.deepEqual([decision.strategy, decision.templateId, decision.basis, decision.evidenceIds], ['retry', 'manipulation_retry', 'policy', []]);
    assert.match(decision.reason, SLIP_ONLY_REASON);
  });

  test('a slip gets the retry on an empty corpus too', () => {
    const decision = decide(single('slip'), []);
    assert.deepEqual([decision.strategy, decision.basis], ['retry', 'policy']);
  });
});

describe('evidence layer', () => {
  test('picks the best smoothed independent rate and cites the winning rows in rank order', () => {
    const decision = decide(single('count_start'), STRONG_MAKE_TEN());
    assert.deepEqual([decision.strategy, decision.templateId, decision.basis], ['make_ten', 'make_ten_blocks', 'evidence']);
    assert.deepEqual(decision.evidenceIds, [0, 1, 2, 3].map((i) => `make_ten_independent_${i}`));
    assert.equal(decision.reason, '4/4 comparable historical cases have an independent result; observational evidence, not a treatment effect.');
  });

  test('groups cover every admitted strategy, the chosen one first', () => {
    const decision = decide(single('count_start'), ranked(evidence('anchor_start', { independent: 1, failed: 2 }), evidence('make_ten', { independent: 4 }), evidence('repeat_count', { independent: 1, failed: 5 })));
    assert.deepEqual(decision.groups, [
      { strategy: 'make_ten', independent: 4, total: 4 },
      { strategy: 'anchor_start', independent: 1, total: 3 },
      { strategy: 'repeat_count', independent: 1, total: 6 },
    ]);
  });

  test('the chosen strategy leads the groups even when another has more cases', () => {
    const decision = decide(single('count_start'), ranked(evidence('anchor_start', { independent: 9, failed: 9 }), evidence('make_ten', { independent: 2 })));
    assert.equal(decision.groups[0]?.strategy, 'make_ten');
  });

  test('ties between strategies go to the strategy name in ascending order', () => {
    const decision = decide(single('count_start'), ranked(evidence('make_ten', { independent: 1, failed: 1 }), evidence('anchor_start', { independent: 1, failed: 1 })));
    assert.equal(decision.strategy, 'anchor_start');
  });

  test('assisted and failed results count as attempts', () => {
    // make_ten 2 of 4 scores 3/6; anchor_start 1 of 1 scores 2/3. Ignoring the assisted rows would flip the choice.
    const decision = decide(single('count_start'), ranked(evidence('make_ten', { independent: 2, assisted: 2 }), evidence('anchor_start', { independent: 1 })));
    assert.equal(decision.strategy, 'anchor_start');
  });

  test('not_assessed rows are skipped: not counted, not cited, not grouped', () => {
    const decision = decide(single('count_start'), ranked(evidence('make_ten', { independent: 1, not_assessed: 5 }), evidence('anchor_start', { independent: 1, failed: 1 })));
    assert.equal(decision.strategy, 'make_ten');
    assert.deepEqual(decision.evidenceIds, ['make_ten_independent_0']);
    assert.deepEqual(decision.groups.find((g) => g.strategy === 'make_ten'), { strategy: 'make_ten', independent: 1, total: 1 });
  });

  test('only rows near the top score with enough coverage are admitted', () => {
    const rows = ranked(
      evidence('make_ten', { independent: 2 }, 0.9, 1),
      evidence('anchor_start', { independent: 5 }, 0.7, 1),
      evidence('repeat_count', { independent: 5 }, 0.9, 0.5),
    );
    const decision = decide(single('count_start'), rows);
    assert.deepEqual(decision.groups, [{ strategy: 'make_ten', independent: 2, total: 2 }]);
  });

  test('the admission floor holds for a low top score', () => {
    const rows = ranked(evidence('make_ten', { independent: 1 }, 0.5, 1), evidence('anchor_start', { independent: 3 }, 0.46, 1), evidence('repeat_count', { independent: 3 }, 0.44, 1));
    const decision = decide(single('count_start'), rows);
    assert.deepEqual(decision.groups.map((g) => g.strategy).sort(), ['anchor_start', 'make_ten']);
  });

  test('partition_gap takes make_ten and never a disallowed strategy', () => {
    const decision = decide(single('partition_gap'), ranked(evidence('make_ten', { independent: 2 }), evidence('anchor_start', { independent: 9 })));
    assert.deepEqual([decision.strategy, decision.templateId, decision.basis], ['make_ten', 'make_ten_blocks', 'evidence']);
  });

  test('a disallowed winner (repeat_count) is never chosen but stays in groups', () => {
    const decision = decide(single('count_start'), ranked(evidence('repeat_count', { independent: 8 }), evidence('make_ten', { independent: 1, failed: 1 })));
    assert.equal(decision.strategy, 'make_ten');
    assert.ok(decision.groups.some((g) => g.strategy === 'repeat_count' && g.independent === 8 && g.total === 8));
    assert.deepEqual(decision.evidenceIds, ['make_ten_failed_0', 'make_ten_independent_0']);
  });
});

describe('default layer', () => {
  test('empty corpus: count_start gives anchor_start with basis default', () => {
    const decision = decide(single('count_start'), []);
    assert.deepEqual([decision.strategy, decision.templateId, decision.basis, decision.evidenceIds, decision.groups], ['anchor_start', 'anchor_start_number_line', 'default', [], []]);
  });

  test('empty corpus: partition_gap gives make_ten with basis default', () => {
    const decision = decide(single('partition_gap'), []);
    assert.deepEqual([decision.strategy, decision.templateId, decision.basis, decision.evidenceIds], ['make_ten', 'make_ten_blocks', 'default', []]);
  });

  test('empty corpus: direction_error clarifies with clarify_show_steps', () => {
    const decision = decide(single('direction_error'), []);
    assert.deepEqual([decision.strategy, decision.templateId, decision.basis, decision.evidenceIds], ['clarify', 'clarify_show_steps', 'clarify', []]);
  });

  test('direction_error clarifies even when its own history is strong', () => {
    const decision = decide(single('direction_error'), ranked(evidence('reverse_direction', { independent: 9 })));
    assert.deepEqual([decision.strategy, decision.basis], ['clarify', 'clarify']);
  });

  test('a low top score falls to the default and shows no admitted groups', () => {
    const decision = decide(single('count_start'), ranked(evidence('make_ten', { independent: 5 }, 0.44, 1)));
    assert.deepEqual([decision.strategy, decision.basis, decision.evidenceIds, decision.groups], ['anchor_start', 'default', [], []]);
  });

  test('only failures fall to the default but stay visible in groups', () => {
    const decision = decide(single('count_start'), ranked(evidence('make_ten', { failed: 3, assisted: 1 })));
    assert.deepEqual([decision.strategy, decision.basis, decision.evidenceIds], ['anchor_start', 'default', []]);
    assert.deepEqual(decision.groups, [{ strategy: 'make_ten', independent: 0, total: 4 }]);
  });

  test('only not_assessed rows fall to the default', () => {
    const decision = decide(single('partition_gap'), ranked(evidence('make_ten', { not_assessed: 6 })));
    assert.deepEqual([decision.strategy, decision.basis, decision.groups], ['make_ten', 'default', []]);
  });

  test('only a disallowed strategy with evidence falls to the default', () => {
    const decision = decide(single('count_start'), ranked(evidence('repeat_count', { independent: 8 })));
    assert.deepEqual([decision.strategy, decision.basis, decision.evidenceIds], ['anchor_start', 'default', []]);
  });

  test('the best allowed strategy without an independent success falls to the default', () => {
    // make_ten 0 of 1 scores 1/3 and beats anchor_start 1 of 10 at 2/12, so the leading allowed strategy has no success.
    const decision = decide(single('count_start'), ranked(evidence('make_ten', { failed: 1 }), evidence('anchor_start', { independent: 1, failed: 9 })));
    assert.deepEqual([decision.strategy, decision.basis], ['anchor_start', 'default']);
  });
});

describe('decision tables', () => {
  test('the admission thresholds are the named demo policy', () => {
    assert.deepEqual([ADMISSION_MIN_SCORE, ADMISSION_TOP_MARGIN, ADMISSION_MIN_COVERAGE], [0.45, 0.12, 0.6]);
  });

  test('the allowed table and the defaults follow the decision layers', () => {
    assert.deepEqual(ALLOWED_STRATEGIES, { count_start: ['make_ten', 'anchor_start'], partition_gap: ['make_ten'], slip: [], direction_error: [], unknown: [] });
    assert.deepEqual(DEFAULT_STRATEGY, { count_start: 'anchor_start', partition_gap: 'make_ten', slip: null, direction_error: null, unknown: null });
  });

  test('a strategy without a template is never allowed anywhere', () => {
    for (const allowed of Object.values(ALLOWED_STRATEGIES)) for (const strategy of allowed) assert.notEqual(STRATEGY_TEMPLATE[strategy], null);
    assert.equal(STRATEGY_TEMPLATE.repeat_count, null);
    assert.equal(STRATEGY_TEMPLATE.reverse_direction, null);
  });

  test('every template the decision can pick belongs to the activity kind it publishes', () => {
    const picks = [decide(single('count_start'), STRONG_MAKE_TEN()), decide(single('slip'), []), decide(single('count_start'), []), decide(single('unknown'), [])];
    assert.deepEqual(picks.map((d) => TEMPLATE_KIND[d.templateId]), ['support', 'retry', 'support', 'clarification']);
  });
});
