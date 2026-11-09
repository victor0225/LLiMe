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
