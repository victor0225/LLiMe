// Retrieval and the decision layers: pure functions of their inputs. No store, no I/O, no clock.
// Isomorphic: the server and the browser scenes import this module, so it must not import node: modules.
import {
  type AdmittedCase,
  type Candidate,
  type Decision,
  type GraphNode,
  type LearningCase,
  type Meaning,
  MAX_SEARCH_CANDIDATES,
  MATCHING_VERSION,
  MeaningSchema,
  type Outcome,
  type SearchResult,
  SearchResultSchema,
  type Strategy,
  type StrategyGroup,
  type TemplateId,
  validateCase,
} from './domain.js';

// ---------------------------------------------------------------------------------------------
// Thresholds. Uncalibrated demo policy: structural overlap is not a probability of success.

// A best match below this is too weak to learn from, so nothing is admitted.
export const ADMISSION_MIN_SCORE = 0.45;
// Only cases close to the best match are admitted, so one strong partial match cannot pull in
// unrelated situations.
export const ADMISSION_TOP_MARGIN = 0.12;
// An admitted case must also cover most of the query's own structure.
export const ADMISSION_MIN_COVERAGE = 0.6;

// Longer paths are rare in these graphs and dominated by their prefixes.
const PATH_MAX_EDGES = 3;

// Scores shown to screens are rounded to this many decimals; admission always uses the exact values.
const SCORE_DECIMALS = 3;
// Hash precision: nine decimals drop float noise while still telling apart ratios of small path counts.
const HASH_DECIMALS = 9;

// The compact search event must stay small enough for the event store and the live feed.
export const SEARCH_COMPLETED_MAX_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------------------------
// Typed paths.

export interface Path {
  key: string;
  nodeIds: string[];
  edgeIds: string[];
}

// Bounded directed typed paths, not a graph-isomorphism algorithm. Only context-stage nodes and edges
// count, narrowed to the retrieval context when one is given. Ids, text and layout never enter a key.
export function paths(c: LearningCase): Path[] {
  const selectedNodes = c.retrievalContext ? new Set(c.retrievalContext.nodeIds) : null;
  const selectedEdges = c.retrievalContext ? new Set(c.retrievalContext.edgeIds) : null;
  const nodes = new Map(c.nodes.filter((n) => n.stage === 'context' && (!selectedNodes || selectedNodes.has(n.id))).map((n) => [n.id, n]));
  const outgoing = new Map<string, LearningCase['edges']>();
  for (const e of c.edges) {
    if (e.stage !== 'context' || (selectedEdges && !selectedEdges.has(e.id))) continue;
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
  }
  const result: Path[] = [];
  const walk = (id: string, labels: string[], nodeIds: string[], edgeIds: string[]): void => {
    if (edgeIds.length > 0) result.push({ key: JSON.stringify(labels), nodeIds, edgeIds });
    if (edgeIds.length === PATH_MAX_EDGES) return;
    for (const e of outgoing.get(id) ?? []) {
      const target = nodes.get(e.to);
      if (target && !nodeIds.includes(target.id)) walk(target.id, [...labels, e.type, `${target.type}:${target.meaning}`], [...nodeIds, target.id], [...edgeIds, e.id]);
    }
  };
  for (const n of nodes.values()) walk(n.id, [`${n.type}:${n.meaning}`], [n.id], []);
  return result;
}

export interface MatchedPair {
  query: Path;
  candidate: Path;
}

export interface Comparison {
  score: number;
  coverage: number;
  matched: MatchedPair[];
  queryPathCount: number;
  candidatePathCount: number;
}

const groupByKey = (ps: Path[]): Map<string, Path[]> => {
  const groups = new Map<string, Path[]>();
  for (const p of ps) groups.set(p.key, [...(groups.get(p.key) ?? []), p]);
  return groups;
};

// Multiset overlap of labelled paths, each weighted by its edge count:
//   score    = sum w*min(q,c) / sum w*max(q,c)    (symmetric: how alike the two cases are)
//   coverage = sum w*min(q,c) / sum w*q           (how much of the query the candidate explains)
// An empty denominator gives 0. The i-th query path of a key pairs with the i-th candidate path.
function comparePaths(queryPaths: Path[], candidatePaths: Path[]): Comparison {
  const qm = groupByKey(queryPaths);
  const cm = groupByKey(candidatePaths);
  let intersection = 0;
  let union = 0;
  let total = 0;
  const matched: MatchedPair[] = [];
  for (const key of new Set([...qm.keys(), ...cm.keys()])) {
    const a = qm.get(key) ?? [];
    const b = cm.get(key) ?? [];
    const weight = (a[0] ?? b[0])?.edgeIds.length ?? 0;
    const count = Math.min(a.length, b.length);
    intersection += count * weight;
    union += Math.max(a.length, b.length) * weight;
    total += a.length * weight;
    for (let i = 0; i < count; i++) {
      const q = a[i];
      const c = b[i];
      if (q && c) matched.push({ query: q, candidate: c });
    }
  }
  return {
    score: union ? intersection / union : 0,
    coverage: total ? intersection / total : 0,
    matched,
    queryPathCount: queryPaths.length,
    candidatePathCount: candidatePaths.length,
  };
}

export function compare(query: LearningCase, candidate: LearningCase): Comparison {
  return comparePaths(paths(query), paths(candidate));
}

// ---------------------------------------------------------------------------------------------
// Ranking.

export interface RankedCase extends Comparison {
  id: string;
  studentId: string;
  provenance: LearningCase['provenance'];
  strategy: Strategy;
  outcome: Outcome;
}

// Candidates are other learners' cases on the same concept recorded no later than the query. Strategy
// and outcome are carried along for the decision only; they never enter the similarity.
export function rank(query: LearningCase, cases: readonly LearningCase[]): RankedCase[] {
  validateCase(query);
  const queryPaths = paths(query);
  const queryTime = Date.parse(query.createdAt);
  return cases
    .filter((c) => c.id !== query.id && c.studentId !== query.studentId && c.concept === query.concept && Date.parse(c.createdAt) <= queryTime)
    .map((c) => ({ id: c.id, studentId: c.studentId, provenance: c.provenance, ...comparePaths(queryPaths, paths(c)), strategy: c.strategy, outcome: c.outcome }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

// The canonical text a ranking is hashed from: the ranked case IDs in order with their exact similarity
// and coverage. Node and edge IDs, strategy and outcome are left out, so renaming graph parts or changing
// only a result cannot change it.
export function rankingHashInput(ranked: readonly RankedCase[]): string {
  const rows = ranked.map((r) => `${r.id}\t${r.score.toFixed(HASH_DECIMALS)}\t${r.coverage.toFixed(HASH_DECIMALS)}`);
  return [MATCHING_VERSION, ...rows].join('\n');
}

// SHA-256 over the canonical text, as lowercase hex. Uses the platform Web Crypto so this module stays
// free of Node-only imports; it is asynchronous because Web Crypto is.
export async function rankingHash(ranked: readonly RankedCase[]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(rankingHashInput(ranked)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------------
// Admission.

type AssessedOutcome = AdmittedCase['outcome'];
export type AdmittedRow = RankedCase & { outcome: AssessedOutcome };

const isAssessed = (row: RankedCase): row is AdmittedRow => row.outcome !== 'not_assessed';

// Applied once, here; screens read the result and never recompute it. Rows without an assessed outcome
// carry no evidence and cannot be shown with a result, so they are not admitted.
export function admit(ranked: readonly RankedCase[]): AdmittedRow[] {
  const top = ranked[0]?.score ?? 0;
  if (top < ADMISSION_MIN_SCORE) return [];
  const floor = Math.max(ADMISSION_MIN_SCORE, top - ADMISSION_TOP_MARGIN);
  return ranked.filter((r): r is AdmittedRow => r.score >= floor && r.coverage >= ADMISSION_MIN_COVERAGE && isAssessed(r));
}

interface StrategyTally {
  strategy: Strategy;
  independent: number;
  total: number;
  ids: string[];
}

// Smoothed independent rate: a strategy seen once is not trusted as much as one seen many times.
const smoothedRate = (t: StrategyTally): number => (t.independent + 1) / (t.total + 2);

// Best first; ties go to the strategy name so the choice never depends on input order.
const byRate = (a: StrategyTally, b: StrategyTally): number => smoothedRate(b) - smoothedRate(a) || a.strategy.localeCompare(b.strategy);

// Failed and assisted results count as attempts without an independent success.
function tally(admitted: readonly AdmittedRow[]): StrategyTally[] {
  const byStrategy = new Map<Strategy, StrategyTally>();
  for (const row of admitted) {
    const t = byStrategy.get(row.strategy) ?? { strategy: row.strategy, independent: 0, total: 0, ids: [] };
    t.total++;
    t.independent += Number(row.outcome === 'independent');
    t.ids.push(row.id);
    byStrategy.set(row.strategy, t);
  }
  return [...byStrategy.values()].sort(byRate);
}

// ---------------------------------------------------------------------------------------------
// Decision layers: clarify gate, slip policy, evidence, default. The seed is evidence, not policy, so a
// thin or missing corpus must never leave the child with only clarifications.

// Strategies the evidence layer may choose for each hypothesis. A strategy without a template is never
// listed, so it can appear in the groups but cannot be chosen. Edit only when adding a template.
export const ALLOWED_STRATEGIES: Readonly<Record<Meaning, readonly Strategy[]>> = {
  count_start: ['make_ten', 'anchor_start'],
  partition_gap: ['make_ten'],
  // A slip is handled by policy and the others have no template to teach with.
  slip: [],
  direction_error: [],
  unknown: [],
};

// What to offer when the evidence layer finds nothing usable. Null means there is nothing to offer yet.
export const DEFAULT_STRATEGY: Readonly<Record<Meaning, Strategy | null>> = {
  count_start: 'anchor_start',
  partition_gap: 'make_ten',
  slip: null,
  direction_error: null,
  unknown: null,
};

// The activity template that carries each strategy. Null: no template exists, so it is never published.
export const STRATEGY_TEMPLATE: Readonly<Record<Strategy, TemplateId | null>> = {
  anchor_start: 'anchor_start_number_line',
  make_ten: 'make_ten_blocks',
  retry: 'manipulation_retry',
  reverse_direction: null,
  repeat_count: null,
  clarify: null,
};

// A first-number question separates a miscounted start from a slip; any other doubt asks for the steps.
const FIRST_NUMBER_MEANINGS: readonly string[] = ['count_start', 'slip'];

const REASON = {
  clarifyFirstNumber: 'The explanation is incomplete or conflicting. Ask what was counted first.',
  clarifyShowSteps: 'The explanation is incomplete or conflicting. Ask the child to show their steps.',
  novel: 'A possible new pattern has no recorded history. Ask the child to show their steps.',
  noRecordedHelp: 'No recorded help applies to this pattern yet. Ask the child to show their steps.',
  slipPolicy: 'Application policy, not learned from other children: a slip needs a fair second try, not teaching.',
} as const;

const defaultReason = (meaning: Meaning): string => `No comparable recorded case supports an allowed strategy; using the default for ${meaning}.`;
const evidenceReason = (t: StrategyTally): string => `${t.independent}/${t.total} comparable historical cases have an independent result; observational evidence, not a treatment effect.`;

// Meanings of the hypotheses that count: supported by a node that no later explanation or retry replaced
// (no outgoing NEXT edge) and not contradicted by such a node. Deduplicated by meaning, in node order.
function activeMeanings(query: LearningCase): string[] {
  const isCurrent = (id: string): boolean => !query.edges.some((e) => e.from === id && e.type === 'NEXT');
  const isActive = (h: GraphNode): boolean =>
    query.edges.some((e) => e.to === h.id && e.type === 'SUPPORTS' && isCurrent(e.from)) &&
    !query.edges.some((e) => e.to === h.id && e.type === 'CONTRADICTS' && isCurrent(e.from));
  return [...new Set(query.nodes.filter((n) => n.type === 'Hypothesis' && isActive(n)).map((n) => n.meaning))];
}

// Only strategies with a template reach here (the allowed table and the defaults list no other), so a
// missing template is a broken table, not a state to fall back from.
function templateFor(strategy: Strategy): TemplateId {
  const templateId = STRATEGY_TEMPLATE[strategy];
  if (!templateId) throw new Error(`Strategy ${strategy} has no activity template`);
  return templateId;
}

// Groups cover every admitted strategy for display, the chosen one first.
function groupsOf(tallies: readonly StrategyTally[], chosen: Strategy | null): StrategyGroup[] {
  const groups = tallies.map(({ strategy, independent, total }) => ({ strategy, independent, total }));
  return [...groups.filter((g) => g.strategy === chosen), ...groups.filter((g) => g.strategy !== chosen)];
}

// Decides the next activity from the query's hypotheses and the ranked history, in four ordered layers.
// Admission and groups describe the ranking and are the same whichever layer decides.
export function chooseActivity(query: LearningCase, ranked: readonly RankedCase[], needsClarification: boolean): Decision {
  const meanings = activeMeanings(query);
  const tallies = tally(admit(ranked));
  const clarify = (templateId: TemplateId, reason: string): Decision => ({ strategy: 'clarify', templateId, basis: 'clarify', evidenceIds: [], reason, groups: groupsOf(tallies, null) });

  // 1. Clarify gate. A lone novel pattern has no history to learn from, whatever the scores say.
  const [only] = meanings;
  if (meanings.length === 1 && only === 'novel') return clarify('clarify_show_steps', REASON.novel);
  const known = MeaningSchema.safeParse(only);
  if (needsClarification || meanings.length !== 1 || !known.success || known.data === 'unknown') {
    const firstNumber = meanings.length > 0 && meanings.every((m) => FIRST_NUMBER_MEANINGS.includes(m));
    return firstNumber ? clarify('clarify_first_number', REASON.clarifyFirstNumber) : clarify('clarify_show_steps', REASON.clarifyShowSteps);
  }
  const meaning = known.data;

  // 2. Slip policy.
  if (meaning === 'slip') return { strategy: 'retry', templateId: templateFor('retry'), basis: 'policy', evidenceIds: [], reason: REASON.slipPolicy, groups: groupsOf(tallies, null) };

  // 3. Evidence: only strategies allowed for this hypothesis compete, and the leader needs a success.
  const allowed = tallies.filter((t) => ALLOWED_STRATEGIES[meaning].includes(t.strategy));
  const leader = allowed[0];
  if (leader && leader.independent > 0) {
    return { strategy: leader.strategy, templateId: templateFor(leader.strategy), basis: 'evidence', evidenceIds: leader.ids, reason: evidenceReason(leader), groups: groupsOf(tallies, leader.strategy) };
  }

  // 4. Default.
  const fallback = DEFAULT_STRATEGY[meaning];
  if (fallback) return { strategy: fallback, templateId: templateFor(fallback), basis: 'default', evidenceIds: [], reason: defaultReason(meaning), groups: groupsOf(tallies, null) };
  return clarify('clarify_show_steps', REASON.noRecordedHelp);
}

// ---------------------------------------------------------------------------------------------
// The compact search summary carried by the search-completed event and read by the backend scene.

const roundScore = (value: number): number => {
  const factor = 10 ** SCORE_DECIMALS;
  return Math.round(value * factor) / factor;
};

const unique = (ids: string[]): string[] => [...new Set(ids)];

export interface SearchSummaryInput {
  query: LearningCase;
  corpusHash: string;
  ranked: readonly RankedCase[];
  decision: Decision;
  rankingHash: string;
}

// Builds the event payload: the top candidates in full, plus `scores` (every ranked case), `admitted` and
// `decision.groups` so screens never recompute admission. Throws if the payload would exceed its cap.
export function buildSearchResult({ query, corpusHash, ranked, decision: chosen, rankingHash: hash }: SearchSummaryInput): SearchResult {
  const candidates: Candidate[] = ranked.slice(0, MAX_SEARCH_CANDIDATES).map((r) => ({
    id: r.id,
    studentId: r.studentId,
    score: roundScore(r.score),
    coverage: roundScore(r.coverage),
    strategy: r.strategy,
    outcome: r.outcome,
    matchedQueryNodeIds: unique(r.matched.flatMap((m) => m.query.nodeIds)),
    matchedCandidateNodeIds: unique(r.matched.flatMap((m) => m.candidate.nodeIds)),
  }));
  const admitted: AdmittedCase[] = admit(ranked).map((r) => ({
    caseId: r.id,
    score: roundScore(r.score),
    coverage: roundScore(r.coverage),
    strategy: r.strategy,
    outcome: r.outcome,
    matchedEdgeIds: unique(r.matched.flatMap((m) => m.candidate.edgeIds)),
  }));
  const result = SearchResultSchema.parse({
    matchingVersion: MATCHING_VERSION,
    corpusHash,
    queryId: query.id,
    candidateCount: ranked.length,
    rankingHash: hash,
    candidates,
    decision: chosen,
    scores: ranked.map((r) => [r.id, roundScore(r.score)]),
    admitted,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
  if (bytes > SEARCH_COMPLETED_MAX_BYTES) throw new Error(`Search summary of ${bytes} bytes exceeds the ${SEARCH_COMPLETED_MAX_BYTES} byte cap`);
  return result;
}
