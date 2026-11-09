import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { type Attempt, CaseSchema, type LearningCase, type Proposal, validateCase } from '../src/domain.js';
import { addResult, appendClarification, contextCase, contextCaseId, GraphProposalError, QUESTION_MEANING, renameCase, speechSourceId } from '../src/graph.js';
import { paths } from '../src/search.js';

const readJson = (relative: string): unknown => JSON.parse(readFileSync(new URL(`../data/${relative}`, import.meta.url), 'utf8'));
const capture = readJson('captures/backend.capture.json') as { query: unknown };
const filmQuery = validateCase(capture.query);
const seed = CaseSchema.array().parse(readJson('seed/cases.json'));

const FILM_EXPLANATION = 'I counted eight, nine, ten, eleven, twelve. That was five numbers.';
const FILM_ATTEMPT: Attempt = { start: 8, moves: [9, 10, 11, 12], answer: 12, hints: 0 };
const AT = '2026-11-09T10:00:00.000Z';

const proposal = (id: string, interpretations: { meaning: Proposal['interpretations'][number]['meaning']; quote: string; relation?: 'SUPPORTS' | 'CONTRADICTS'; proposedMeaning?: string | null }[], needsClarification = false): Proposal => ({
  interpretations: interpretations.map((i) => ({ meaning: i.meaning, proposedMeaning: i.proposedMeaning ?? null, sourceId: speechSourceId(id), quote: i.quote, relation: i.relation ?? 'SUPPORTS' })),
  needsClarification,
});

const filmCase = (id = 'influence_0', createdAt = '2026-11-07T12:31:10.468Z') =>
  contextCase({ id, studentId: 'student_7', createdAt, attempt: FILM_ATTEMPT, explanation: FILM_EXPLANATION, proposal: proposal(id, [{ meaning: 'count_start', quote: 'I counted eight' }]) });

describe('contextCase', () => {
  test('rebuilds the recorded film query byte for byte from the attempt, explanation and proposal', () => {
    assert.deepEqual(filmCase(), filmQuery);
    assert.equal(JSON.stringify(filmCase()), JSON.stringify(filmQuery));
  });

  test('names the context case after the run and explanation revision and quotes come from its speech source', () => {
    assert.equal(contextCaseId('run-1', 3), 'run-1_context_3');
    assert.equal(speechSourceId('run-1_context_3'), 'run-1_context_3:speech');
  });

  test('rejects a quote that is not verbatim in the explanation', () => {
    assert.throws(
      () => contextCase({ id: 'q', studentId: 'student_7', createdAt: AT, attempt: FILM_ATTEMPT, explanation: FILM_EXPLANATION, proposal: proposal('q', [{ meaning: 'count_start', quote: 'I counted nine' }]) }),
      (error: unknown) => error instanceof GraphProposalError && /quote/.test(error.message),
    );
  });

  test('rejects an interpretation that cites another source', () => {
    const wrongSource = { interpretations: [{ meaning: 'count_start' as const, proposedMeaning: null, sourceId: 'q:actions', quote: 'I counted eight', relation: 'SUPPORTS' as const }], needsClarification: false };
    assert.throws(() => contextCase({ id: 'q', studentId: 'student_7', createdAt: AT, attempt: FILM_ATTEMPT, explanation: FILM_EXPLANATION, proposal: wrongSource }), GraphProposalError);
  });

  test('rejects two different supported meanings without needsClarification, and accepts them with it', () => {
    const conflicting = (needsClarification: boolean) =>
      contextCase({ id: 'q', studentId: 'student_7', createdAt: AT, attempt: FILM_ATTEMPT, explanation: FILM_EXPLANATION, proposal: proposal('q', [{ meaning: 'count_start', quote: 'I counted eight' }, { meaning: 'slip', quote: 'five numbers' }], needsClarification) });
    assert.throws(() => conflicting(false), (error: unknown) => error instanceof GraphProposalError && /Conflicting/.test(error.message));
    assert.doesNotThrow(() => conflicting(true));
  });

  test('novel conflicts with another supported meaning but not with unknown', () => {
    const build = (other: 'count_start' | 'unknown') =>
      contextCase({ id: 'q', studentId: 'student_7', createdAt: AT, attempt: FILM_ATTEMPT, explanation: FILM_EXPLANATION, proposal: proposal('q', [{ meaning: 'novel', proposedMeaning: 'counts_fingers_twice', quote: 'five numbers' }, { meaning: other, quote: 'I counted eight' }]) });
    assert.throws(() => build('count_start'), GraphProposalError);
    assert.doesNotThrow(() => build('unknown'));
  });

  test('a novel hypothesis is stored as hypothesis_novel with its proposed name, and the name never enters a path key', () => {
    const c = contextCase({ id: 'q', studentId: 'student_7', createdAt: AT, attempt: FILM_ATTEMPT, explanation: FILM_EXPLANATION, proposal: proposal('q', [{ meaning: 'novel', proposedMeaning: 'counts_fingers_twice', quote: 'five numbers' }]) });
    const novel = c.nodes.find((n) => n.id === 'q:hypothesis_novel');
    assert.deepEqual([novel?.meaning, novel?.proposedMeaning], ['novel', 'counts_fingers_twice']);
    assert.ok(paths(c).every((p) => !p.key.includes('counts_fingers_twice')));
  });

  test('a known meaning never carries a proposedMeaning field', () => {
    assert.ok(filmCase().nodes.every((n) => !('proposedMeaning' in n)));
  });
});

describe('appendClarification', () => {
  const prior = filmCase('run_context_1', AT);
  const answer = "I started on eight and counted it.";
  const current = contextCase({ id: 'run_context_2', studentId: 'student_7', createdAt: AT, attempt: FILM_ATTEMPT, explanation: answer, proposal: proposal('run_context_2', [{ meaning: 'count_start', quote: 'counted it' }]) });
  const merged = appendClarification(current, prior, { text: 'Which number did you count first?', meaning: QUESTION_MEANING.clarify_first_number });

  test('keeps the earlier explanation as prior_ nodes linked to the new one by NEXT, behind the question that was asked', () => {
    const ids = merged.nodes.map((n) => n.id);
    assert.ok(ids.includes('run_context_2:prior_explanation'));
    assert.ok(ids.includes('run_context_2:prior_hypothesis_count_start'));
    assert.ok(ids.includes('run_context_2:question'));
    assert.equal(merged.nodes.find((n) => n.id === 'run_context_2:question')?.meaning, 'what_counted_first');
    const next = merged.edges.find((e) => e.type === 'NEXT');
    assert.deepEqual([next?.from, next?.to], ['run_context_2:prior_explanation', 'run_context_2:explanation']);
    assert.ok(merged.sources.some((s) => s.id === 'run_context_2:prior_speech' && s.text === FILM_EXPLANATION));
    assert.ok(merged.sources.some((s) => s.id === 'run_context_2:question_source' && s.text === 'Which number did you count first?'));
  });

  test('searches only the newest round, so the copied history never changes the match', () => {
    assert.ok(merged.retrievalContext);
    assert.deepEqual(new Set(merged.retrievalContext.nodeIds), new Set(current.nodes.map((n) => n.id)));
    assert.deepEqual(paths(merged).map((p) => p.key).sort(), paths(current).map((p) => p.key).sort());
  });

  test('three clarification rounds plus a continuation still fit the case source and node limits', () => {
    let graph: LearningCase = filmCase('r_context_1', AT);
    for (let revision = 2; revision <= 8; revision += 1) {
      const id = `r_context_${revision}`;
      const next = contextCase({ id, studentId: 'student_7', createdAt: AT, attempt: FILM_ATTEMPT, explanation: 'I guessed', proposal: proposal(id, [{ meaning: 'unknown', quote: 'guessed' }]) });
      graph = appendClarification(next, graph, { text: 'Can you show me how you got your answer?', meaning: QUESTION_MEANING.clarify_show_steps });
    }
    assert.doesNotThrow(() => validateCase(graph));
  });
});

describe('addResult and renameCase', () => {
  test('appends the seed-shaped result layer: Intervention, Outcome and an evaluation source, all at the result stage', () => {
    const result = addResult(renameCase(filmCase('run_context_1', AT), 'run_outcome'), { strategies: ['make_ten'], outcome: 'independent', evaluation: '{"outcome":"independent"}' });
    assert.equal(result.id, 'run_outcome');
    assert.deepEqual([result.strategy, result.outcome, result.retention], ['make_ten', 'independent', 'pending']);
    const resultNodes = result.nodes.filter((n) => n.stage === 'result').map((n) => `${n.id} ${n.type}:${n.meaning}`);
    assert.deepEqual(resultNodes, ['run_outcome:intervention Intervention:make_ten', 'run_outcome:outcome Outcome:independent']);
    const resultEdges = result.edges.filter((e) => e.stage === 'result').map((e) => `${e.id} ${e.type}`);
    assert.deepEqual(resultEdges, ['run_outcome:intervention-link FOLLOWED_BY', 'run_outcome:outcome-link EVALUATED_BY']);
    assert.ok(result.nodes.every((n) => n.id.startsWith('run_outcome:')));
    assert.deepEqual(paths(result), paths(renameCase(filmCase('run_context_1', AT), 'run_outcome')));
  });

  test('a second intervention follows the first, and the outcome evaluates the last one', () => {
    const result = addResult(renameCase(filmCase('run_context_1', AT), 'run_outcome'), { strategies: ['retry', 'anchor_start'], outcome: 'failed', evaluation: '{}' });
    assert.equal(result.strategy, 'anchor_start');
    const edges = result.edges.filter((e) => e.stage === 'result').map((e) => `${e.from.split(':')[1]}-${e.type}->${e.to.split(':')[1]}`);
    assert.deepEqual(edges, ['attempt-FOLLOWED_BY->intervention', 'intervention-FOLLOWED_BY->intervention_2', 'intervention_2-EVALUATED_BY->outcome']);
  });

  test('the seed result layer has the same node and edge IDs, so a live outcome looks like a stored one', () => {
    const seeded = seed.find((c) => c.nodes.some((n) => n.type === 'Intervention'));
    assert.ok(seeded);
    const suffixes = (c: LearningCase) => c.edges.filter((e) => e.stage === 'result').map((e) => e.id.slice(c.id.length));
    assert.deepEqual(suffixes(seeded), [':intervention-link', ':outcome-link']);
  });
});
