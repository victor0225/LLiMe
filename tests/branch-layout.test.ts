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

describe('scene geometry', () => {
  const extents = (n: number) => Array.from({ length: n }, () => ({ w: 60, h: 40 }));

  test('every learner gets one fixed tile and every situation one fixed place inside it', async () => {
    const { fieldLayout, FIELD } = await import('../web/backend/branch-layout.js');
    const groups = Array.from({ length: 117 }, (_, i) => ({ id: `s${i}`, cases: extents(1 + (i % 6)).map((extent, k) => ({ id: `s${i}_${k}`, extent })) }));
    const layout = fieldLayout(groups);
    assert.equal(layout.tiles.length, 117);
    assert.equal(layout.placements.size, groups.reduce((n, g) => n + g.cases.length, 0));
    for (const t of layout.tiles) assert.ok(t.x >= FIELD.x && t.x + t.w <= FIELD.x + FIELD.w + 1 && t.y >= FIELD.y && t.y + t.h <= FIELD.y + FIELD.h + 1, t.learnerId);
    assert.deepEqual(fieldLayout(groups).placements, layout.placements, 'the same counts give the same places');
  });

  test('learners sort by student number, not alphabetically', async () => {
    const { sortLearners } = await import('../web/backend/branch-layout.js');
    assert.deepEqual(sortLearners(['student_10', 'student_2', 'student_1', 'student_2']), ['student_1', 'student_2', 'student_10']);
  });

  test('the personal row shrinks cells for many situations and stays inside its span', async () => {
    const { personalRow, ME } = await import('../web/backend/branch-layout.js');
    const row = personalRow(extents(18));
    assert.equal(row.placements.length, 18);
    assert.ok(row.placements.every((p) => p.x >= ME.row.x && p.x <= ME.row.right));
    assert.ok(row.cell < 36);
  });

  test('the selected zone keeps every case inside its area and groups in the given order', async () => {
    const { zoneLayout, ZONE } = await import('../web/backend/branch-layout.js');
    const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    const zone = zoneLayout([{ strategy: 'make_ten', ids: ids('a', 29) }, { strategy: 'anchor_start', ids: ids('b', 22) }, { strategy: 'repeat_count', ids: ids('c', 8) }], () => ({ w: 60, h: 40 }));
    assert.deepEqual(zone.labels.map((l) => l.strategy), ['make_ten', 'anchor_start', 'repeat_count']);
    assert.equal(zone.placements.size, 59);
    for (const p of zone.placements.values()) assert.ok(p.y >= ZONE.y && p.y <= ZONE.y + ZONE.h + 30 && p.x >= ZONE.x, `${p.x},${p.y}`);
  });
});
