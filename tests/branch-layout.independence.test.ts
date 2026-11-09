import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { CaseSchema, validateCase } from '../src/domain.js';
import { buildSearchResult, chooseActivity, rank, rankingHash } from '../src/search.js';
import { branchLayout } from '../web/backend/branch-layout.js';
import { createProjection, indexCorpus, liftedCaseIds, litEdgeIds, project, type ProjectionSnapshot, type ViewEvent, visibleScores } from '../web/backend/event-projection.js';

const readJson = (relative: string): unknown => JSON.parse(readFileSync(new URL(`../data/${relative}`, import.meta.url), 'utf8'));
const seed = CaseSchema.array().parse(readJson('seed/cases.json'));
const corpusHash = (readJson('seed/manifest.json') as { sha256: string }).sha256;
const query = validateCase((readJson('captures/backend.capture.json') as { query: unknown }).query);
const ranked = rank(query, seed);
const search = buildSearchResult({ query, corpusHash, ranked, decision: chooseActivity(query, ranked, false), rankingHash: await rankingHash(ranked) });

const events: ViewEvent[] = [
  { runId: 'r', sequence: 0, type: 'graph.updated', payload: { graph: query } },
  { runId: 'r', sequence: 1, type: 'search.started', payload: { matchingVersion: search.matchingVersion, queryId: query.id, candidateCount: search.candidateCount, queryNodeIds: query.nodes.map((n) => n.id) } },
  { runId: 'r', sequence: 2, type: 'search.completed', payload: search },
];
const snapshot: ProjectionSnapshot = events.reduce(project, createProjection('r', indexCorpus(seed)));

// Collects every key in a value, to prove no coordinate field ever enters projected state.
const keysOf = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) for (const item of value) keysOf(item, found);
  else if (value && typeof value === 'object' && !(value instanceof Set) && !(value instanceof Map)) for (const [key, inner] of Object.entries(value)) (found.add(key), keysOf(inner, found));
  return found;
};

describe('layout independence', () => {
  test('layout positions never enter any event, command or lit-ID set', () => {
    const litBefore = [...litEdgeIds(snapshot)].sort();
    const liftedBefore = liftedCaseIds(snapshot);
    const scoresBefore = [...visibleScores(snapshot)];

    // Lay out every admitted case, then wreck every coordinate: nothing the projection exposes may move.
    const layouts = search.admitted.map((a) => branchLayout(seed.find((c) => c.id === a.caseId) ?? query, { withResult: true }));
    assert.ok(layouts.length === 59);
    for (const layout of layouts) for (const placed of layout.nodes) Object.assign(placed, { x: placed.x * 97 + 13, y: -placed.y });

    assert.deepEqual([...litEdgeIds(snapshot)].sort(), litBefore);
    assert.deepEqual(liftedCaseIds(snapshot), liftedBefore);
    assert.deepEqual([...visibleScores(snapshot)], scoresBefore);
    const forbidden = ['x', 'y', 'pos', 'position', 'positions', 'layout'];
    for (const key of keysOf(snapshot)) assert.ok(!forbidden.includes(key), `projected state has a coordinate key: ${key}`);
    for (const key of keysOf(events)) assert.ok(!forbidden.includes(key), `an event has a coordinate key: ${key}`);
  });

  test('lit edges and lifted cases are the same for a reordered corpus and a reordered graph', () => {
    const reordered = [...seed].reverse();
    const again = events.reduce(project, createProjection('r', indexCorpus(reordered)));
    assert.deepEqual([...litEdgeIds(again)].sort(), [...litEdgeIds(snapshot)].sort());
    assert.deepEqual(liftedCaseIds(again), liftedCaseIds(snapshot));
  });
});
