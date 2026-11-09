import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { CaseSchema, ConceptLinkSchema, type ConceptLink, type LearningCase, type SearchResult, validateCase } from '../src/domain.js';
import { buildSearchResult, chooseActivity, rank, rankingHash } from '../src/search.js';
import {
  createProjection,
  hypothesisLabels,
  indexCorpus,
  litEdgeIds,
  liftedCaseIds,
  memoryHighlight,
  project,
  ProjectionGapError,
  ProjectionRejectedError,
  type ProjectionSnapshot,
  type ViewEvent,
  visibleScores,
} from '../web/backend/event-projection.js';
import type { RunEvent } from '../src/events.js';
import { adaptRunEvents, foldViewEvents } from '../web/backend/server-adapter.js';

const readJson = (relative: string): unknown => JSON.parse(readFileSync(new URL(`../data/${relative}`, import.meta.url), 'utf8'));
const seed = CaseSchema.array().parse(readJson('seed/cases.json'));
const conceptLinks = ConceptLinkSchema.array().parse(readJson('seed/concept-links.json'));
const corpusHash = (readJson('seed/manifest.json') as { sha256: string }).sha256;
const filmQuery = validateCase((readJson('captures/backend.capture.json') as { query: unknown }).query);
const corpus = indexCorpus(seed);

const RUN = 'run_graph';
const ranked = rank(filmQuery, seed);
const decision = chooseActivity(filmQuery, ranked, false);
const search: SearchResult = buildSearchResult({ query: filmQuery, corpusHash, ranked, decision, rankingHash: await rankingHash(ranked) });

let nextSequence = 0;
// Events are built the way the adapter emits them: consecutive sequence numbers per run.
const view = <E extends ViewEvent>(event: Omit<E, 'runId' | 'sequence'> & { runId?: string; sequence?: number }): E =>
  ({ runId: RUN, sequence: nextSequence++, ...event }) as E;
const fresh = (): ProjectionSnapshot => {
  nextSequence = 0;
  return createProjection(RUN, corpus);
};
const feed = (snapshot: ProjectionSnapshot, ...events: ViewEvent[]): ProjectionSnapshot => events.reduce(project, snapshot);

const graphEvent = (graph: LearningCase = filmQuery) => view({ type: 'graph.updated', payload: { graph } });
const startedEvent = (queryId = filmQuery.id) =>
  view({ type: 'search.started', payload: { matchingVersion: search.matchingVersion, queryId, candidateCount: search.candidateCount, queryNodeIds: filmQuery.nodes.filter((n) => n.stage === 'context').map((n) => n.id) } });
const completedEvent = (result: SearchResult = search) => view({ type: 'search.completed', payload: result });

const attempt = filmQuery.nodes.find((n) => n.type === 'Attempt');
assert.ok(attempt, 'the film query has an attempt');
const outcomePayload = (overrides: Record<string, unknown> = {}) => {
  const queryId = filmQuery.id;
  const sourceId = `${queryId}:evaluation`;
  return {
    queryId,
    persistedCaseId: `${queryId}:saved`,
    strategy: 'make_ten' as const,
    outcome: 'independent' as const,
    saved: false,
    nodes: [
      { id: `${queryId}:intervention`, type: 'Intervention' as const, meaning: 'make_ten', stage: 'result' as const, sourceIds: [sourceId] },
      { id: `${queryId}:outcome`, type: 'Outcome' as const, meaning: 'independent', stage: 'result' as const, sourceIds: [sourceId] },
    ],
    edges: [
      { id: `${queryId}:intervention-link`, from: attempt.id, to: `${queryId}:intervention`, type: 'FOLLOWED_BY' as const, stage: 'result' as const },
      { id: `${queryId}:outcome-link`, from: `${queryId}:intervention`, to: `${queryId}:outcome`, type: 'EVALUATED_BY' as const, stage: 'result' as const },
    ],
    source: { id: sourceId, text: JSON.stringify({ strategy: 'make_ten', outcome: 'independent' }) },
    ...overrides,
  };
};
const committedEvent = (overrides: Record<string, unknown> = {}) => view({ type: 'outcome.committed', payload: outcomePayload(overrides) });

const searched = (): ProjectionSnapshot => feed(fresh(), graphEvent(), startedEvent(), completedEvent());

describe('sequence and scope', () => {
  test('an unknown event type throws', () => {
    const unknown = { runId: RUN, sequence: 0, type: 'activity.published', payload: {} } as unknown as ViewEvent;
    assert.throws(() => project(fresh(), unknown), /Unsupported view event/);
  });

  test('a sequence gap throws and requires a snapshot reload', () => {
    const snapshot = feed(fresh(), graphEvent());
    const skipped = { ...startedEvent(), sequence: snapshot.sequence + 2 };
    assert.throws(() => project(snapshot, skipped), (error) => error instanceof ProjectionGapError && /snapshot/i.test(error.message));
  });

  test('duplicates are ignored', () => {
    const start = fresh();
    const first = graphEvent();
    const snapshot = feed(start, first);
    assert.equal(project(snapshot, first), snapshot);
    assert.equal(project(snapshot, { ...first }), snapshot);
  });

  test('a wrong-run or stale event adds nothing', () => {
    const snapshot = searched();
    const foreign = { ...committedEvent(), runId: 'run_other', sequence: snapshot.sequence + 1 };
    assert.equal(project(snapshot, foreign), snapshot);
    const stale = { ...committedEvent(), sequence: 0 };
    assert.equal(project(snapshot, stale), snapshot);
    assert.equal(snapshot.outcome, null);
  });
});

describe('query graph', () => {
  test('the first graph.updated fixes the query ID', () => {
    const snapshot = feed(fresh(), graphEvent());
    assert.equal(snapshot.queryId, filmQuery.id);
    const other = validateCase(JSON.parse(JSON.stringify(filmQuery).replaceAll(filmQuery.id, 'other_query')));
    assert.throws(() => project(snapshot, view({ type: 'graph.updated', payload: { graph: other } })), ProjectionRejectedError);
  });

  test('a graph with a dangling edge is rejected', () => {
    const [first] = filmQuery.edges;
    assert.ok(first);
    const broken = { ...filmQuery, edges: [{ ...first, to: `${filmQuery.id}:missing` }, ...filmQuery.edges.slice(1)] };
    assert.throws(() => project(fresh(), view({ type: 'graph.updated', payload: { graph: broken } })), ProjectionRejectedError);
  });
});

describe('search results', () => {
  test('results stay hidden before search.completed', () => {
    const beforeSearch = feed(fresh(), graphEvent(), startedEvent());
    assert.equal(beforeSearch.search, null);
    assert.deepEqual(liftedCaseIds(beforeSearch), []);
    assert.equal(litEdgeIds(beforeSearch).size, 0);
    assert.equal(visibleScores(beforeSearch).size, 0);
    assert.equal(beforeSearch.searching, true);
  });

  test('search.completed without search.started is rejected', () => {
    assert.throws(() => feed(fresh(), graphEvent(), completedEvent()), ProjectionRejectedError);
  });

  test('lifted case IDs equal admitted; decision.evidenceIds is a subset', () => {
    const snapshot = searched();
    const lifted = liftedCaseIds(snapshot);
    assert.deepEqual(lifted, search.admitted.map((a) => a.caseId));
    assert.equal(lifted.length, 59);
    const liftedSet = new Set(lifted);
    assert.ok(search.decision.evidenceIds.length > 0);
    assert.ok(search.decision.evidenceIds.every((id) => liftedSet.has(id)));
    assert.equal(visibleScores(snapshot).size, search.candidateCount);
  });

  test('lit edges are exactly admitted[].matchedEdgeIds', () => {
    const lit = litEdgeIds(searched());
    const expected = new Set(search.admitted.flatMap((a) => a.matchedEdgeIds));
    assert.ok(expected.size > 0);
    assert.deepEqual([...lit].sort(), [...expected].sort());
  });

  test('a decision citing a case that was not admitted is rejected', () => {
    const outsider = search.scores.find(([id]) => !search.admitted.some((a) => a.caseId === id));
    assert.ok(outsider);
    const forged = { ...search, decision: { ...search.decision, evidenceIds: [...search.decision.evidenceIds, outsider[0]] } };
    assert.throws(() => feed(fresh(), graphEvent(), startedEvent(), completedEvent(forged)), ProjectionRejectedError);
  });

  test('an admitted case or edge that does not exist is rejected', () => {
    const [firstAdmitted, ...rest] = search.admitted;
    assert.ok(firstAdmitted);
    const unknownCase = { ...search, admitted: [{ ...firstAdmitted, caseId: 'ghost_case' }, ...rest] };
    assert.throws(() => feed(fresh(), graphEvent(), startedEvent(), completedEvent(unknownCase)), ProjectionRejectedError);
    const unknownEdge = { ...search, admitted: [{ ...firstAdmitted, matchedEdgeIds: ['ghost_edge'] }, ...rest] };
    assert.throws(() => feed(fresh(), graphEvent(), startedEvent(), completedEvent(unknownEdge)), ProjectionRejectedError);
  });

  test('group counts that disagree with the admitted list are rejected', () => {
    const [firstGroup, ...rest] = search.decision.groups;
    assert.ok(firstGroup);
    const skewed = { ...search, decision: { ...search.decision, groups: [{ ...firstGroup, total: firstGroup.total + 1 }, ...rest] } };
    assert.throws(() => feed(fresh(), graphEvent(), startedEvent(), completedEvent(skewed)), ProjectionRejectedError);
  });

  test('a search for another query is rejected', () => {
    assert.throws(() => feed(fresh(), graphEvent(), startedEvent('other_query')), ProjectionRejectedError);
  });
});

describe('committed outcome', () => {
  test('outcome.committed adds its nodes once', () => {
    const before = searched();
    const after = project(before, committedEvent());
    assert.equal(after.graph?.nodes.length, filmQuery.nodes.length + 2);
    assert.equal(after.graph?.edges.length, filmQuery.edges.length + 2);
    assert.deepEqual(after.outcome, { strategy: 'make_ten', outcome: 'independent', saved: false, persistedCaseId: `${filmQuery.id}:saved` });
    assert.equal(after.search, before.search, 'ranking and decision are kept');
    assert.equal(before.graph?.nodes.length, filmQuery.nodes.length, 'the earlier snapshot is not mutated');
    assert.throws(() => project(after, committedEvent()), ProjectionRejectedError);
  });

  test('a mismatched queryId is rejected', () => {
    assert.throws(() => project(searched(), committedEvent({ queryId: 'other_query' })), ProjectionRejectedError);
  });

  test('a broken reference is rejected', () => {
    const payload = outcomePayload();
    const [first, second] = payload.edges;
    assert.ok(first && second);
    const dangling = [first, { ...second, from: `${filmQuery.id}:nowhere` }];
    assert.throws(() => project(searched(), committedEvent({ edges: dangling })), ProjectionRejectedError);
  });

  test('a graph that already has a result is rejected', () => {
    const withResult = feed(fresh(), graphEvent(), startedEvent(), completedEvent(), committedEvent());
    assert.throws(() => project(withResult, graphEvent()), ProjectionRejectedError);
  });

  test('only independent or failed outcomes are committed', () => {
    const nodes = outcomePayload().nodes.map((n) => (n.type === 'Outcome' ? { ...n, meaning: 'assisted' } : n));
    assert.throws(() => project(searched(), committedEvent({ outcome: 'assisted', nodes })), ProjectionRejectedError);
  });
});

describe('failure', () => {
  test('operation.failed keeps the last accepted state', () => {
    const before = searched();
    const after = project(before, view({ type: 'operation.failed', payload: { operationId: 'op_1', code: 'RUNTIME_DISCONNECTED', message: 'The runtime stopped.' } }));
    assert.equal(after.graph, before.graph);
    assert.equal(after.search, before.search);
    assert.deepEqual(liftedCaseIds(after), liftedCaseIds(before));
    assert.equal(after.status, 'error');
    assert.equal(after.failure?.code, 'RUNTIME_DISCONNECTED');
    assert.equal(after.raw?.type, 'operation.failed');
  });
});

describe('memory and hypothesis', () => {
  const personal = seed.filter((c) => c.studentId === filmQuery.studentId);

  test('memory.retrieved highlights exactly its caseIds and the three concept links', () => {
    assert.equal(conceptLinks.length, 3);
    const caseIds = personal.slice(0, 4).map((c) => c.id);
    const snapshot = feed(
      fresh(),
      view({ type: 'memory.retrieved', payload: { conceptIds: ['addition_within_20'], caseIds, summaries: [], links: conceptLinks } }),
    );
    const highlight = memoryHighlight(snapshot);
    assert.deepEqual(highlight.caseIds, caseIds);
    assert.deepEqual(highlight.links, conceptLinks);
    assert.equal(snapshot.graph, null, 'memory alone adds no graph node');
  });

  test('memory.retrieved naming a case outside the corpus is rejected', () => {
    const links: ConceptLink[] = conceptLinks;
    assert.throws(() => feed(fresh(), view({ type: 'memory.retrieved', payload: { conceptIds: ['addition_within_20'], caseIds: ['ghost_case'], summaries: [], links } })), ProjectionRejectedError);
  });

  test('a novel hypothesis shows "Possible new pattern: <name>" only on this backend surface', async () => {
    const hypothesis = filmQuery.nodes.find((n) => n.type === 'Hypothesis');
    assert.ok(hypothesis);
    const novel = { ...filmQuery, nodes: filmQuery.nodes.map((n) => (n.id === hypothesis.id ? { ...n, meaning: 'novel', proposedMeaning: 'skips_the_zero' } : n)) };
    const snapshot = feed(fresh(), view({ type: 'graph.updated', payload: { graph: validateCase(novel) } }));
    assert.deepEqual(hypothesisLabels(snapshot), [{ nodeId: hypothesis.id, label: 'Possible new pattern: skips_the_zero', isNovel: true }]);
    const childCopy = await import('../src/copy.js');
    assert.equal(JSON.stringify(childCopy).includes('Possible new pattern'), false);
    const known = hypothesisLabels(feed(fresh(), graphEvent()));
    assert.equal(known[0]?.isNovel, false);
    assert.equal(known[0]?.label.includes('Possible new pattern'), false);
  });
});

describe('agent events', () => {
  test('tool and runtime events update the raw line without touching the graph', () => {
    const before = feed(fresh(), graphEvent());
    const after = project(before, view({ type: 'runtime.message', payload: { threadId: 't', turnId: 'u', itemId: 'i', text: 'Recorded once.', partial: false } }));
    assert.equal(after.graph, before.graph);
    assert.equal(after.raw?.type, 'runtime.message');
  });
});

describe('a server run through the adapter', () => {
  test('memory, context.committed, search and outcome project with no rejection: the scene gets the query graph, the search and the outcome', () => {
    const rawEvent = (seq: number, type: RunEvent['type'], payload: unknown): RunEvent => ({ runId: RUN, seq, type, payload, at: '2026-11-09T10:00:00.000Z' }) as RunEvent;
    const events = [
      rawEvent(1, 'memory.retrieved', { conceptIds: ['addition_within_20'], caseIds: [], summaries: [], links: conceptLinks }),
      rawEvent(2, 'context.committed', { caseId: filmQuery.id, explanationRevision: 1, graph: filmQuery }),
      rawEvent(3, 'search.started', { matchingVersion: search.matchingVersion, queryId: filmQuery.id, candidateCount: search.candidateCount, queryNodeIds: filmQuery.nodes.filter((n) => n.stage === 'context').map((n) => n.id) }),
      rawEvent(4, 'search.completed', search),
      rawEvent(5, 'outcome.committed', outcomePayload()),
    ];
    const rejections: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => void rejections.push(args);
    try {
      const snapshot = foldViewEvents(RUN, corpus, adaptRunEvents(events));
      assert.deepEqual(rejections, []);
      assert.equal(snapshot.queryId, filmQuery.id);
      assert.ok(snapshot.graph);
      assert.deepEqual(snapshot.search, search);
      assert.equal(snapshot.outcome?.outcome, 'independent');
    } finally {
      console.error = originalError;
    }
  });
});
