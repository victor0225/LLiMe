// Event projection for the Learning memory scene: a pure reducer from ordered, run-scoped view events to
// the facts the scene draws. No React, no clock, no network. The server adapter decides which run events
// reach the reducer; this module decides whether each one is acceptable.
//
// Two rules shape everything here. The scene shows what the search module decided (`admitted`,
// `decision.groups`, `scores`) and never recomputes it, and the query graph grows only through events the
// server committed, so a rejected or foreign event leaves the snapshot exactly as it was.
import type { ConceptLink, Decision, ErrorCode, GraphEdge, GraphNode, LearningCase, Outcome, SearchResult, Strategy } from '@core/domain';
import { validateCase } from '@core/domain';
import type { EventPayload, EventType } from '@core/events';
import { hypothesisText } from './learning-copy.js';

// The events this view consumes. Every other run event is dropped by the adapter before it gets here.
export const PROJECTED_EVENT_TYPES = [
  'memory.retrieved',
  'runtime.input',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'runtime.message',
  'runtime.completed',
  'graph.updated',
  'search.started',
  'search.completed',
  'operation.failed',
  'outcome.committed',
] as const satisfies readonly EventType[];
export type ProjectedEventType = (typeof PROJECTED_EVENT_TYPES)[number];

export type ViewEvent = {
  [T in ProjectedEventType]: {
    readonly runId: string;
    // Consecutive from 0 for the events this view receives; the adapter renumbers them.
    readonly sequence: number;
    readonly type: T;
    readonly payload: EventPayload<T>;
    // Real time since the run's input reached the agent, when it is known.
    readonly elapsedMs?: number;
  };
}[ProjectedEventType];

// A view that missed an event cannot trust anything after it: it must reload a snapshot.
export class ProjectionGapError extends Error {
  constructor(expected: number, received: number) {
    super(`Event gap: expected sequence ${expected} but received ${received}. Reload the snapshot.`);
  }
}

// The event was well formed but cannot be applied to the current state (foreign query, broken reference,
// second result). The snapshot is unchanged; `advancePast` moves the cursor over it.
export class ProjectionRejectedError extends Error {}

// Case and edge IDs of the pinned corpus. The projection checks search results against it so a result
// naming something that does not exist is refused instead of drawn.
export interface CorpusIndex {
  readonly caseIds: ReadonlySet<string>;
  readonly edgeIdsByCase: ReadonlyMap<string, ReadonlySet<string>>;
}

export function indexCorpus(cases: readonly LearningCase[]): CorpusIndex {
  return {
    caseIds: new Set(cases.map((c) => c.id)),
    edgeIdsByCase: new Map(cases.map((c) => [c.id, new Set(c.edges.map((e) => e.id))])),
  };
}

export interface MemoryRetrieval {
  readonly caseIds: readonly string[];
  readonly links: readonly ConceptLink[];
  readonly conceptIds: readonly string[];
}

export interface CommittedOutcome {
  readonly strategy: Strategy;
  readonly outcome: Extract<Outcome, 'independent' | 'failed'>;
  readonly saved: boolean;
  readonly persistedCaseId: string;
}

export interface OperationFailure {
  readonly code: ErrorCode;
  readonly message: string;
}

// What the footer needs to say about agent activity, without keeping whole payloads alive.
export interface AgentEventSummary {
  readonly type: 'runtime.input' | 'tool.started' | 'tool.completed' | 'tool.failed' | 'runtime.message' | 'runtime.completed';
  readonly label: string;
  readonly elapsedMs?: number;
}

export interface ProjectionSnapshot {
  readonly runId: string;
  // Sequence of the last applied event; -1 before the first.
  readonly sequence: number;
  readonly corpus: CorpusIndex | null;
  // Fixed by the first graph.updated; later graphs must match.
  readonly queryId: string | null;
  readonly graph: LearningCase | null;
  readonly memory: MemoryRetrieval | null;
  readonly search: SearchResult | null;
  readonly searching: boolean;
  readonly outcome: CommittedOutcome | null;
  readonly status: 'active' | 'complete' | 'error';
  readonly failure: OperationFailure | null;
  readonly agentEvents: readonly AgentEventSummary[];
  // The last event worth showing as the raw footer line. runtime.completed never replaces it.
  readonly raw: ViewEvent | null;
}

export function createProjection(runId: string, corpus: CorpusIndex | null = null): ProjectionSnapshot {
  return { runId, sequence: -1, corpus, queryId: null, graph: null, memory: null, search: null, searching: false, outcome: null, status: 'active', failure: null, agentEvents: [], raw: null };
}

const reject = (message: string): never => {
  throw new ProjectionRejectedError(message);
};

const hasResult = (graph: LearningCase) => graph.nodes.some((n) => n.stage === 'result');

function checkGraph(graph: LearningCase, current: ProjectionSnapshot): void {
  try {
    validateCase(graph);
  } catch (error) {
    reject(`Invalid graph update: ${error instanceof Error ? error.message : 'rejected'}`);
  }
  if (current.queryId !== null && graph.id !== current.queryId) reject(`Graph ${graph.id} is not the fixed query ${current.queryId}`);
  if (current.graph && hasResult(current.graph)) reject('The query already has a committed result');
}

function checkSearch(result: SearchResult, current: ProjectionSnapshot): void {
  if (!current.searching) reject('Search completion without start');
  if (result.queryId !== current.queryId) reject('The search belongs to another query');
  const scored = new Set(result.scores.map(([id]) => id));
  if (scored.size !== result.scores.length) reject('Duplicate case in scores');
  if (result.scores.length !== result.candidateCount) reject('scores do not cover candidateCount');
  const corpus = current.corpus;
  if (corpus && result.scores.some(([id]) => !corpus.caseIds.has(id))) reject('Search names a case that does not exist');
  if (result.candidates.some((c) => !scored.has(c.id))) reject('A candidate is missing from scores');
  const admittedIds = new Set(result.admitted.map((a) => a.caseId));
  if (admittedIds.size !== result.admitted.length || result.admitted.some((a) => !scored.has(a.caseId))) reject('Admitted cases must be scored cases');
  for (const admitted of result.admitted) {
    const edges = corpus?.edgeIdsByCase.get(admitted.caseId);
    if (corpus && admitted.matchedEdgeIds.some((id) => !edges?.has(id))) reject('A matched edge does not exist on its case');
  }
  if (result.decision.evidenceIds.some((id) => !admittedIds.has(id))) reject('Decision evidence must be admitted cases');
  // The groups are a tally of the admitted list, so any disagreement means one of them is wrong.
  const groupTotal = result.decision.groups.reduce((sum, g) => sum + g.total, 0);
  if (groupTotal !== result.admitted.length) reject('Group counts do not add up to the admitted cases');
  for (const group of result.decision.groups) {
    const members = result.admitted.filter((a) => a.strategy === group.strategy);
    if (members.length !== group.total || members.filter((a) => a.outcome === 'independent').length !== group.independent) reject('Group counts disagree with the admitted cases');
  }
}

function checkOutcome(payload: EventPayload<'outcome.committed'>, current: ProjectionSnapshot): CommittedOutcome {
  const graph = current.graph;
  if (!graph || payload.queryId !== current.queryId) reject('The outcome belongs to another query');
  if (!graph) return reject('There is no query graph to extend');
  if (hasResult(graph)) reject('The query already has a committed result');
  const prefix = `${payload.queryId}:`;
  const intervention = payload.nodes.find((n) => n.type === 'Intervention');
  const result = payload.nodes.find((n) => n.type === 'Outcome');
  if (payload.nodes.length !== 2 || !intervention || !result) return reject('An outcome commits one intervention and one outcome');
  if (payload.outcome !== 'independent' && payload.outcome !== 'failed') return reject('Only an independent check or a failed one is committed');
  if (intervention.meaning !== payload.strategy || result.meaning !== payload.outcome) reject('Result nodes disagree with the committed values');
  if (!payload.source.id.startsWith(prefix)) reject('The result source is not scoped to the query');
  if (payload.nodes.some((n) => !n.id.startsWith(prefix) || n.stage !== 'result' || !n.sourceIds.includes(payload.source.id))) reject('Result nodes must be scoped result nodes grounded in the source');
  const attempt = graph.nodes.find((n) => n.type === 'Attempt');
  const links = (from: string, to: string, type: GraphEdge['type']) => payload.edges.some((e) => e.from === from && e.to === to && e.type === type && e.stage === 'result' && e.id.startsWith(prefix));
  if (!attempt || payload.edges.length !== 2 || !links(attempt.id, intervention.id, 'FOLLOWED_BY') || !links(intervention.id, result.id, 'EVALUATED_BY')) reject('Result edges must run attempt, intervention, outcome');
  return { strategy: payload.strategy, outcome: payload.outcome, saved: payload.saved, persistedCaseId: payload.persistedCaseId };
}

const agentSummary = (event: ViewEvent): AgentEventSummary | null => {
  const elapsed = event.elapsedMs === undefined ? {} : { elapsedMs: event.elapsedMs };
  switch (event.type) {
    case 'runtime.input':
      return { type: event.type, label: event.payload.model, ...elapsed };
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
      return { type: event.type, label: event.payload.name, ...elapsed };
    case 'runtime.message':
      return { type: event.type, label: event.payload.text, ...elapsed };
    case 'runtime.completed':
      return { type: event.type, label: event.payload.status, ...elapsed };
    default:
      return null;
  }
};

const isProjected = (type: string): type is ProjectedEventType => (PROJECTED_EVENT_TYPES as readonly string[]).includes(type);

function apply(current: ProjectionSnapshot, event: ViewEvent): ProjectionSnapshot {
  switch (event.type) {
    case 'memory.retrieved': {
      const { caseIds, links, conceptIds } = event.payload;
      const corpus = current.corpus;
      if (corpus && caseIds.some((id) => !corpus.caseIds.has(id))) reject('Retrieved memory names a case that does not exist');
      return { ...current, memory: { caseIds, links, conceptIds } };
    }
    case 'graph.updated': {
      checkGraph(event.payload.graph, current);
      // A rebuilt graph invalidates any earlier search, so a result never outlives the graph it matched.
      return { ...current, queryId: event.payload.graph.id, graph: event.payload.graph, search: null, searching: false, status: 'active', failure: null };
    }
    case 'search.started': {
      if (!current.graph || event.payload.queryId !== current.queryId) reject('The search belongs to another query');
      const known = new Set(current.graph?.nodes.map((n) => n.id));
      if (event.payload.queryNodeIds.some((id) => !known.has(id))) reject('The search names a node that is not in the query graph');
      return { ...current, search: null, searching: true, status: 'active', failure: null };
    }
    case 'search.completed': {
      checkSearch(event.payload, current);
      return { ...current, search: event.payload, searching: false, status: 'complete', failure: null };
    }
    case 'outcome.committed': {
      const outcome = checkOutcome(event.payload, current);
      const graph = current.graph;
      if (!graph) return current;
      const { nodes, edges, source } = event.payload;
      return {
        ...current,
        outcome,
        graph: { ...graph, nodes: [...graph.nodes, ...nodes], edges: [...graph.edges, ...edges], sources: [...graph.sources, source], strategy: outcome.strategy, outcome: outcome.outcome },
        failure: null,
      };
    }
    case 'operation.failed':
      // The last accepted state stays on screen; only the status and the footer change.
      return { ...current, searching: false, status: 'error', failure: { code: event.payload.code, message: event.payload.message } };
    case 'runtime.input':
    case 'tool.started':
    case 'tool.completed':
    case 'tool.failed':
    case 'runtime.message':
    case 'runtime.completed':
      return current;
  }
}

// project(snapshot, event) -> snapshot. Foreign runs, duplicates and stale sequence numbers return the
// same snapshot; an unknown type, a gap or a rejected event throws.
export function project(snapshot: ProjectionSnapshot, event: ViewEvent): ProjectionSnapshot {
  if (event.runId !== snapshot.runId) return snapshot;
  if (!isProjected(event.type)) throw new Error(`Unsupported view event: ${String(event.type)}`);
  if (!Number.isSafeInteger(event.sequence) || event.sequence < 0) throw new Error(`Invalid sequence: ${event.sequence}`);
  if (event.sequence <= snapshot.sequence) return snapshot;
  if (event.sequence !== snapshot.sequence + 1) throw new ProjectionGapError(snapshot.sequence + 1, event.sequence);
  const applied = apply(snapshot, event);
  const summary = agentSummary(event);
  return {
    ...applied,
    sequence: event.sequence,
    agentEvents: summary ? [...applied.agentEvents, summary] : applied.agentEvents,
    raw: event.type === 'runtime.completed' ? applied.raw : event,
  };
}

// Moves the cursor over an event the reducer rejected, so the events after it can still apply.
export function advancePast(snapshot: ProjectionSnapshot, event: ViewEvent): ProjectionSnapshot {
  return event.runId === snapshot.runId && event.sequence === snapshot.sequence + 1 ? { ...snapshot, sequence: event.sequence } : snapshot;
}

// ---------------------------------------------------------------------------------------------
// Selectors. Everything the scene lights, lifts or labels is read here and nowhere else, so none of it
// can depend on where anything is drawn.

// Cases the decision rule admitted, in rank order. Empty until the search completed.
export function liftedCaseIds(snapshot: ProjectionSnapshot): string[] {
  return snapshot.search ? snapshot.search.admitted.map((a) => a.caseId) : [];
}

// The edges to light: exactly the admitted cases' matched edges.
export function litEdgeIds(snapshot: ProjectionSnapshot): ReadonlySet<string> {
  return new Set(snapshot.search ? snapshot.search.admitted.flatMap((a) => a.matchedEdgeIds) : []);
}

// Similarity of every ranked case, for the field's brightness. Empty until the search completed.
export function visibleScores(snapshot: ProjectionSnapshot): ReadonlyMap<string, number> {
  return new Map(snapshot.search ? snapshot.search.scores : []);
}

export function strategyGroups(snapshot: ProjectionSnapshot): Decision['groups'] {
  return snapshot.search?.decision.groups ?? [];
}

export function memoryHighlight(snapshot: ProjectionSnapshot): { caseIds: readonly string[]; links: readonly ConceptLink[] } {
  return { caseIds: snapshot.memory?.caseIds ?? [], links: snapshot.memory?.links ?? [] };
}

export interface HypothesisLabel {
  readonly nodeId: string;
  readonly label: string;
  readonly isNovel: boolean;
}

const isHypothesis = (node: GraphNode) => node.type === 'Hypothesis';

// The label for each hypothesis in the query graph. The model-chosen name of a novel pattern appears only here.
export function hypothesisLabels(snapshot: ProjectionSnapshot): HypothesisLabel[] {
  return (snapshot.graph?.nodes ?? []).filter(isHypothesis).map((node) => ({
    nodeId: node.id,
    label: hypothesisText(node),
    isNovel: node.meaning === 'novel',
  }));
}
