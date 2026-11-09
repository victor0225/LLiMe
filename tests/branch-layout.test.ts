import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { CaseSchema, type LearningCase } from '../src/domain.js';
import { branchLayout, shapeOf } from '../web/backend/branch-layout.js';

const seed = CaseSchema.array().parse(JSON.parse(readFileSync(new URL('../data/seed/cases.json', import.meta.url), 'utf8')));

// Rename every ID with a prefix and shuffle node and edge storage with a fixed rotation.
function scrambled(c: LearningCase): LearningCase {
  const rename = (id: string) => `renamed_${id}`;
  const rotate = <T>(items: readonly T[], by: number) => [...items.slice(by % Math.max(1, items.length)), ...items.slice(0, by % Math.max(1, items.length))];
  return {
    ...c,
    nodes: rotate(c.nodes, 3).map((n) => ({ ...n, id: rename(n.id) })).reverse(),
    edges: rotate(c.edges, 2).map((e) => ({ ...e, id: rename(e.id), from: rename(e.from), to: rename(e.to) })).reverse(),
  };
}

const richest = [...seed].sort((a, b) => b.nodes.length - a.nodes.length)[0];
assert.ok(richest);

describe('branch layout', () => {
  test('same structure gives the same shape regardless of IDs and stored order', () => {
    const sample = [richest, ...seed.filter((_, i) => i % 11 === 0)];
    assert.ok(sample.length > 50);
    for (const c of sample) {
      assert.deepEqual(shapeOf(branchLayout(scrambled(c), { withResult: true })), shapeOf(branchLayout(c, { withResult: true })), c.id);
    }
  });

  test('different typed structure gives a different shape', () => {
    const shapes = new Map<string, string>();
    const structures = new Map<string, string>();
    for (const c of seed) {
      const layout = branchLayout(c, { withResult: true });
      const typed = JSON.stringify([c.nodes.map((n) => `${n.type}:${n.meaning}`).sort(), c.edges.map((e) => `${e.type}:${c.nodes.find((n) => n.id === e.from)?.type}>${c.nodes.find((n) => n.id === e.to)?.type}`).sort()]);
      shapes.set(c.id, JSON.stringify(shapeOf(layout)));
      structures.set(c.id, typed);
    }
    // Two cases with different node and edge multisets never share a shape.
    const seen = new Map<string, string>();
    for (const [id, shape] of shapes) {
      const prior = seen.get(shape);
      if (prior !== undefined) assert.equal(structures.get(prior), structures.get(id), `${prior} and ${id} share a shape but not a structure`);
      else seen.set(shape, id);
    }
    assert.ok(seen.size > 10);
  });

  test('a changed node meaning changes the shape', () => {
    const changed: LearningCase = { ...richest, nodes: richest.nodes.map((n) => (n.type === 'Hypothesis' ? { ...n, meaning: `${n.meaning}_changed` } : n)) };
    assert.notDeepEqual(shapeOf(branchLayout(changed, { withResult: true })), shapeOf(branchLayout(richest, { withResult: true })));
  });

  test('a context-only layout leaves the result layer out', () => {
    const withResult = seed.find((c) => c.nodes.some((n) => n.stage === 'result'));
    assert.ok(withResult);
    const context = branchLayout(withResult);
    assert.ok(context.nodes.every((p) => p.node.stage === 'context'));
    assert.ok(branchLayout(withResult, { withResult: true }).nodes.length > context.nodes.length);
  });

  test('a graph without an attempt has no layout', () => {
    const layout = branchLayout({ nodes: [], edges: [] });
    assert.deepEqual([layout.width, layout.height, layout.nodes.length], [0, 0, 0]);
  });
});
