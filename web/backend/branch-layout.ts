// Structural branch layout: a branch's shape is a pure function of its typed structure. Stored IDs,
// stored order and coordinates never matter, and the layout never feeds back into any event or lit set.
import type { GraphEdge, GraphNode, NodeType } from '@core/domain';

export interface LayoutGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

export interface PlacedNode {
  readonly x: number;
  readonly y: number;
  readonly node: GraphNode;
}

export interface BranchLayout {
  readonly nodes: readonly PlacedNode[];
  readonly edges: readonly GraphEdge[];
  readonly pos: ReadonlyMap<string, PlacedNode>;
  // Extent in grid cells.
  readonly width: number;
  readonly height: number;
}

// Siblings are ordered by type first so the same kind of node always sits in the same column.
const SIBLING_ORDER: readonly NodeType[] = ['Observation', 'Explanation', 'Hypothesis', 'Retry', 'Question', 'Concept', 'Intervention', 'Outcome'];

// Four rounds of neighbourhood refinement tell apart siblings whose subtrees differ within three hops,
// which covers every graph the corpus contains.
const REFINEMENT_ROUNDS = 4;

const label = (n: GraphNode) => `${n.type}:${n.meaning}`;
const siblingRank = (type: NodeType) => SIBLING_ORDER.indexOf(type);

// Canonical structural signature per node: colour refinement over typed neighbourhoods, renumbered after
// every round so the result depends on structure only.
function signatures(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): Map<string, string> {
  let signature = new Map(nodes.map((n) => [n.id, label(n)]));
  for (let round = 0; round < REFINEMENT_ROUNDS; round++) {
    const raw = new Map<string, string>(
      nodes.map((n) => {
        const around = edges.flatMap((e) => (e.from === n.id ? [`>${e.type}${signature.get(e.to)}`] : e.to === n.id ? [`<${e.type}${signature.get(e.from)}`] : [])).sort();
        return [n.id, `${signature.get(n.id)}|${around.join()}`];
      }),
    );
    const ranks = [...new Set(raw.values())].sort();
    signature = new Map(nodes.map((n) => [n.id, `${label(n)}#${ranks.indexOf(raw.get(n.id) ?? '')}`]));
  }
  return signature;
}

// y is the breadth-first depth from the Attempt; x is the parent's x plus the sibling index, moved right on
// a collision. `withResult` includes the Intervention and Outcome layer.
export function branchLayout(graph: LayoutGraph, { withResult = false }: { withResult?: boolean } = {}): BranchLayout {
  const nodes = graph.nodes.filter((n) => withResult || n.stage === 'context');
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => (withResult || e.stage === 'context') && ids.has(e.from) && ids.has(e.to));
  const root = nodes.find((n) => n.type === 'Attempt');
  const pos = new Map<string, PlacedNode>();
  if (!root) return { nodes: [], edges: [], pos, width: 0, height: 0 };

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const signature = signatures(nodes, edges);
  const used = new Set(['0,0']);
  pos.set(root.id, { x: 0, y: 0, node: root });
  const queue = [root.id];
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    const parent = id === undefined ? undefined : pos.get(id);
    if (id === undefined || !parent) continue;
    const children = edges
      .filter((e) => e.from === id && !pos.has(e.to))
      .map((e) => byId.get(e.to))
      .filter((n): n is GraphNode => n !== undefined)
      .sort((a, b) => siblingRank(a.type) - siblingRank(b.type) || (signature.get(a.id) ?? '').localeCompare(signature.get(b.id) ?? ''));
    children.forEach((child, index) => {
      if (pos.has(child.id)) return;
      const y = parent.y + 1;
      let x = parent.x + index;
      while (used.has(`${x},${y}`)) x++;
      used.add(`${x},${y}`);
      pos.set(child.id, { x, y, node: child });
      queue.push(child.id);
    });
  }
  const placed = [...pos.values()];
  return {
    nodes: placed,
    edges: edges.filter((e) => pos.has(e.from) && pos.has(e.to)),
    pos,
    width: Math.max(...placed.map((p) => p.x)) + 1,
    height: Math.max(...placed.map((p) => p.y)) + 1,
  };
}

// The shape as plain data with no IDs, so two layouts can be compared structurally.
export function shapeOf(layout: BranchLayout): string[] {
  const at = (id: string) => {
    const p = layout.pos.get(id);
    return p ? `${p.x},${p.y}` : '?';
  };
  return [
    ...layout.nodes.map((p) => `node ${p.node.type}:${p.node.meaning} @${p.x},${p.y}`),
    ...layout.edges.map((e) => `edge ${e.type} ${at(e.from)}->${at(e.to)}`),
  ].sort();
}

// ---------------------------------------------------------------------------------------------
// Scene geometry. Pure functions of counts and shapes, in viewBox units of a 1440 x 780 stage. Nothing
// here reads a score, a lit set or a decision, so where a case sits can never depend on how it ranked.

export const STAGE = { width: 1440, height: 780 } as const;
// Spine of the current situation in the left half.
export const SPINE = { x: 128, attempt: 200, step: 115 } as const;
// Result column: x of the empty next-step and outcome slots, and their y.
export const RESULT_X = 510;
export const SLOT = { intervention: SPINE.attempt + SPINE.step, outcome: SPINE.attempt + SPINE.step * 2 + 20 } as const;
// Field of other learners, with the shared concept at its top-left.
export const FIELD = { x: 838, y: 160, w: 578, h: 590, maxScale: 0.42 } as const;
export const HUB = { x: 842, y: 124 } as const;
// This learner's node and the row of earlier situations.
export const ME = { x: 48, y: 72, row: { x: 186, right: 464, y: 54, h: 40 } } as const;
// Selected cases lifted out beside this learner.
export const ZONE = { x: 490, y: 560, w: 314, h: 206, cellW: 31, cellH: 30, maxScale: 0.8, label: 26 } as const;
// One grid cell of a branch in viewBox units, and the x where the winning group joins the empty slot.
export const GLYPH_UNIT = 10;
export const TRUNK_X = 474;
// A learner's tile holds situations in this many columns.
const TILE_COLUMNS = 3;
const TILE_MIN_ROWS = 3;
const ROW_CELL_MAX = 36;
const ROW_MAX_SCALE = 0.6;
const ZONE_FIT_MARGIN = 8;
const TILE_FIT_MARGIN = 3;

export interface Extent {
  readonly w: number;
  readonly h: number;
}
export interface Placement {
  readonly x: number;
  readonly y: number;
  readonly s: number;
}

export const extentOf = (layout: BranchLayout): Extent => ({ w: Math.max(0, layout.width - 1) * GLYPH_UNIT, h: Math.max(0, layout.height - 1) * GLYPH_UNIT });

const fit = (extent: Extent, w: number, h: number, max: number) => Math.min(max, (w - TILE_FIT_MARGIN) / Math.max(1, extent.w), (h - TILE_FIT_MARGIN) / Math.max(1, extent.h));

export interface LearnerGroup {
  readonly id: string;
  readonly cases: readonly { readonly id: string; readonly extent: Extent }[];
}

export interface Tile {
  readonly learnerId: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  // Where the learner's Student node sits and where its drop line leaves the bus.
  readonly studentX: number;
  readonly studentY: number;
  readonly dropX: number;
}

export interface FieldLayout {
  readonly tiles: readonly Tile[];
  readonly placements: ReadonlyMap<string, Placement & { readonly fromX: number; readonly fromY: number }>;
  // The bus: hub down to a rail, one drop per column, one stub per learner.
  readonly busPaths: readonly string[];
}

const numericCollator = new Intl.Collator(undefined, { numeric: true });

// Learners in student-number order, each with their situations oldest first (the caller sorts).
export const sortLearners = (ids: Iterable<string>): string[] => [...new Set(ids)].sort(numericCollator.compare);

// One tile per learner on a grid sized to the field; every situation gets a fixed sub-cell in its tile.
export function fieldLayout(groups: readonly LearnerGroup[]): FieldLayout {
  const cols = Math.max(1, Math.ceil(Math.sqrt((groups.length * FIELD.w) / FIELD.h)));
  const rows = Math.max(1, Math.ceil(groups.length / cols));
  const cellW = FIELD.w / cols;
  const cellH = FIELD.h / rows;
  const widest = Math.max(1, ...groups.map((g) => g.cases.length));
  const subRows = Math.max(TILE_MIN_ROWS, Math.ceil(widest / TILE_COLUMNS));
  const tileRect = (i: number) => ({ x: FIELD.x + (i % cols) * cellW + 6, y: FIELD.y + Math.floor(i / cols) * cellH + 2, w: cellW - 8, h: cellH - 4 });
  const innerOf = (t: ReturnType<typeof tileRect>) => ({ x: t.x + 9, y: t.y + 3, w: t.w - 11, h: t.h - 5 });
  const first = innerOf(tileRect(0));
  const subW = first.w / TILE_COLUMNS;
  const subH = first.h / subRows;
  const dropX = (column: number) => FIELD.x + column * cellW + 2;
  const lastColumn = Math.min(cols, groups.length) - 1;
  const railY = FIELD.y - 12;

  const tiles: Tile[] = [];
  const placements = new Map<string, Placement & { fromX: number; fromY: number }>();
  const busPaths = [`M${HUB.x} ${HUB.y} V ${railY} H ${dropX(lastColumn)}`];
  for (let column = 0; column <= lastColumn; column++) {
    const bottom = tileRect(column + (Math.ceil((groups.length - column) / cols) - 1) * cols).y + 7;
    busPaths.push(`M${dropX(column)} ${railY} V ${bottom}`);
  }
  groups.forEach((group, i) => {
    const t = tileRect(i);
    const inner = innerOf(t);
    const studentX = t.x + 4;
    const studentY = t.y + 7;
    tiles.push({ learnerId: group.id, ...t, studentX, studentY, dropX: dropX(i % cols) });
    busPaths.push(`M${dropX(i % cols)} ${studentY} H ${studentX}`);
    group.cases.forEach((c, k) => {
      const s = fit(c.extent, subW, subH, FIELD.maxScale);
      placements.set(c.id, {
        x: inner.x + (k % TILE_COLUMNS) * subW + (subW - c.extent.w * s) / 2,
        y: inner.y + Math.floor(k / TILE_COLUMNS) * subH + (subH - c.extent.h * s) / 2,
        s,
        fromX: studentX,
        fromY: studentY,
      });
    });
  });
  return { tiles, placements, busPaths };
}

export interface RowLayout {
  readonly placements: readonly Placement[];
  // Cell width, and where the "+1 NEW" label starts after the last situation.
  readonly cell: number;
  readonly endX: number;
  readonly busPath: string;
}

// This learner's earlier situations in a single row hanging off the Student node.
export function personalRow(extents: readonly Extent[]): RowLayout {
  const { row } = ME;
  const cell = Math.min(ROW_CELL_MAX, (row.right - row.x) / Math.max(1, extents.length));
  const placements = extents.map((extent, k) => {
    const s = fit(extent, cell, row.h, ROW_MAX_SCALE);
    return { x: row.x + k * cell + (cell - extent.w * s) / 2, y: row.y, s };
  });
  const rail = row.y - 8;
  const last = placements.at(-1)?.x ?? row.x;
  const busPath = `M${ME.x} ${ME.y} V ${rail} H ${last}${placements.map((p) => ` M${p.x} ${rail} V ${p.y}`).join('')}`;
  return { placements, cell, endX: row.x + extents.length * cell + 6, busPath };
}

export interface ZoneGroup {
  readonly strategy: string;
  readonly ids: readonly string[];
}

export interface ZoneLayout {
  readonly placements: ReadonlyMap<string, Placement>;
  readonly labels: readonly { readonly strategy: string; readonly y: number; readonly top: number; readonly bottom: number }[];
}

// Selected cases in groups, one labelled block per group. The glyph scale is the smallest that fits every
// case; when many are selected the rows shrink (labels keep their size).
export function zoneLayout(groups: readonly ZoneGroup[], extentFor: (id: string) => Extent): ZoneLayout {
  const ids = groups.flatMap((g) => g.ids);
  const scale = Math.min(ZONE.maxScale, ...ids.map((id) => {
    const e = extentFor(id);
    return Math.min((ZONE.cellW - ZONE_FIT_MARGIN) / Math.max(1, e.w), (ZONE.cellH - ZONE_FIT_MARGIN) / Math.max(1, e.h));
  }));
  const perRow = Math.floor(ZONE.w / ZONE.cellW);
  const rowsHeight = groups.reduce((h, g) => h + Math.ceil(g.ids.length / perRow) * ZONE.cellH, 0);
  const k = Math.min(1, rowsHeight ? (ZONE.h - ZONE.label * (groups.length + 1)) / rowsHeight : 1);
  const placements = new Map<string, Placement>();
  const labels: { strategy: string; y: number; top: number; bottom: number }[] = [];
  let y = ZONE.y + 10;
  for (const group of groups) {
    const top = y;
    labels.push({ strategy: group.strategy, y: y + 20, top, bottom: 0 });
    y += ZONE.label;
    group.ids.forEach((id, i) => placements.set(id, { x: ZONE.x + (i % perRow) * ZONE.cellW * k, y: y + Math.floor(i / perRow) * ZONE.cellH * k, s: scale * k }));
    y += Math.ceil(group.ids.length / perRow) * ZONE.cellH * k + 2;
    const entry = labels[labels.length - 1];
    if (entry) labels[labels.length - 1] = { ...entry, bottom: y };
  }
  return { placements, labels };
}
