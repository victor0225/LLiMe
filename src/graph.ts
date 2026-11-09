// Builders for a live learning case: the context graph a child's explanation produces, the history a
// clarification keeps, and the result layer an assessed outcome adds. Pure functions of their inputs.
import {
  type Attempt,
  AttemptSchema,
  type Concept,
  type GraphEdge,
  type GraphNode,
  type LearningCase,
  type Outcome,
  type Proposal,
  ProposalSchema,
  type Strategy,
  validateCase,
} from './domain.js';

// A proposal the graph cannot hold: an ungrounded quote or hypotheses that disagree without a request
// to clarify. The tool handler reports it as a validation failure before anything is written.
export class GraphProposalError extends Error {
  override readonly name = 'GraphProposalError';
}

// Every explanation revision gets its own context case, so each round stays a separate, immutable record.
export const contextCaseId = (runId: string, explanationRevision: number): string => `${runId}_context_${explanationRevision}`;

// The only source an interpretation may quote: the child's own words for this revision.
export const speechSourceId = (caseId: string): string => `${caseId}:speech`;

// Only addition within 20 has activities, and the engine interprets only a trace that stopped one move
// short (start a, moves a+1 … a+b-1), so the observed concept and observation are fixed.
const CONTEXT_CONCEPT: Concept = 'addition_within_20';
const OBSERVATION_MEANING = 'one_move_short';
const ATTEMPT_MEANING = 'addition';
const EXPLANATION_MEANING = 'learner_account';

// Question meanings use the seed's own vocabulary, chosen by what was asked.
export const QUESTION_MEANING = {
  clarify_first_number: 'what_counted_first',
  clarify_show_steps: 'show_me_again',
  continuation: 'why_that_number',
} as const;
export type QuestionMeaning = (typeof QUESTION_MEANING)[keyof typeof QUESTION_MEANING];

// `unknown` only says the account is thin, so it never disagrees with another meaning.
const CONFLICT_EXEMPT_MEANING = 'unknown';

// Nodes every round shares: one attempt, one concept and one observation per case.
const SHARED_SUFFIXES: readonly string[] = ['attempt', 'concept', 'observation'];
const PRIOR_PREFIX = 'prior_';

export type ContextCaseInput = {
  id: string;
  studentId: string;
  createdAt: string;
  attempt: Attempt;
  explanation: string;
  proposal: Proposal;
};

function assertGrounded(id: string, explanation: string, proposal: Proposal): void {
  const sourceId = speechSourceId(id);
  for (const item of proposal.interpretations) {
    if (item.sourceId !== sourceId) throw new GraphProposalError(`Interpretation source ${item.sourceId} is not this explanation's source ${sourceId}`);
    if (!explanation.includes(item.quote)) throw new GraphProposalError(`Interpretation quote is not verbatim in the explanation: "${item.quote.slice(0, 80)}"`);
  }
}

function assertNoConflict(proposal: Proposal): void {
  const supported = new Set(proposal.interpretations.filter((i) => i.relation === 'SUPPORTS' && i.meaning !== CONFLICT_EXEMPT_MEANING).map((i) => i.meaning));
  if (supported.size > 1 && !proposal.needsClarification) {
    throw new GraphProposalError(`Conflicting hypotheses require clarification: ${[...supported].join(', ')}`);
  }
}

// The graph of one explanation of one attempt. Throws GraphProposalError for an ungrounded or
// conflicting proposal, and the domain validator's error for anything the case rules reject.
export function contextCase({ id, studentId, createdAt, attempt, explanation, proposal: rawProposal }: ContextCaseInput): LearningCase {
  const proposal = ProposalSchema.parse(rawProposal);
  assertGrounded(id, explanation, proposal);
  assertNoConflict(proposal);
  const actions = `${id}:actions`;
  const speech = speechSourceId(id);
  const node = (suffix: string, type: GraphNode['type'], meaning: string, sourceId: string): GraphNode => ({ id: `${id}:${suffix}`, type, meaning, stage: 'context', sourceIds: [sourceId] });
  const nodes: GraphNode[] = [
    node('attempt', 'Attempt', ATTEMPT_MEANING, actions),
    node('concept', 'Concept', CONTEXT_CONCEPT, actions),
    node('observation', 'Observation', OBSERVATION_MEANING, actions),
    node('explanation', 'Explanation', EXPLANATION_MEANING, speech),
  ];
  const edges: GraphEdge[] = [];
  const link = (from: string, type: GraphEdge['type'], to: string) => edges.push({ id: `${id}:e${edges.length}`, from: `${id}:${from}`, to: `${id}:${to}`, type, stage: 'context' });
  link('attempt', 'TARGETS', 'concept');
  link('attempt', 'OBSERVED', 'observation');
  link('observation', 'EXPLAINED_BY', 'explanation');
  for (const item of proposal.interpretations) {
    const suffix = `hypothesis_${item.meaning}`;
    if (!nodes.some((n) => n.id === `${id}:${suffix}`)) {
      const hypothesis = node(suffix, 'Hypothesis', item.meaning, speech);
      nodes.push(item.meaning === 'novel' && item.proposedMeaning ? { ...hypothesis, proposedMeaning: item.proposedMeaning } : hypothesis);
    }
    link('explanation', item.relation, suffix);
  }
  return validateCase({
    id,
    studentId,
    provenance: 'live_demo',
    createdAt,
    concept: CONTEXT_CONCEPT,
    sources: [
      { id: actions, text: JSON.stringify(AttemptSchema.parse(attempt)) },
      { id: speech, text: explanation },
    ],
    nodes,
    edges,
    strategy: 'clarify',
    outcome: 'not_assessed',
    retention: 'pending',
  });
}

export type AskedQuestion = { text: string; meaning: QuestionMeaning };

// Carries the earlier rounds into the newest one: earlier explanations, hypotheses and questions become
// `prior_` records linked forward by NEXT, so a later round supersedes but never erases them. The search
// is narrowed to the newest round, so copied history never changes what is matched. A correction answers
// no new question, so it passes null and only the NEXT link is added.
export function appendClarification(current: LearningCase, prior: LearningCase, question: AskedQuestion | null): LearningCase {
  const priorPrefix = `${prior.id}:`;
  const remap = (id: string): string => {
    const suffix = id.startsWith(priorPrefix) ? id.slice(priorPrefix.length) : id;
    return SHARED_SUFFIXES.includes(suffix) ? `${current.id}:${suffix}` : `${current.id}:${PRIOR_PREFIX}${suffix}`;
  };
  const isShared = (id: string) => SHARED_SUFFIXES.includes(id.slice(priorPrefix.length));
  const questionSource = `${current.id}:question_source`;
  const questionNode = `${current.id}:question`;
  const clarificationEdge = (type: GraphEdge['type'], from: string, to: string): GraphEdge => ({ id: `${current.id}:clarification_${type}`, from, to, type, stage: 'context' });
  const asked = question
    ? {
        sources: [{ id: questionSource, text: question.text }],
        nodes: [{ id: questionNode, type: 'Question' as const, meaning: question.meaning, stage: 'context' as const, sourceIds: [questionSource] }],
        edges: [clarificationEdge('ASKED', `${current.id}:attempt`, questionNode), clarificationEdge('ANSWERED_BY', questionNode, `${current.id}:explanation`)],
      }
    : { sources: [], nodes: [], edges: [] };
  return validateCase({
    ...current,
    sources: [...current.sources, ...prior.sources.map((s) => ({ ...s, id: remap(s.id) })), ...asked.sources],
    nodes: [...current.nodes, ...prior.nodes.filter((n) => !isShared(n.id)).map((n) => ({ ...n, id: remap(n.id), sourceIds: n.sourceIds.map(remap) })), ...asked.nodes],
    edges: [
      ...current.edges,
      ...prior.edges.filter((e) => e.type !== 'TARGETS' && e.type !== 'OBSERVED').map((e) => ({ ...e, id: remap(e.id), from: remap(e.from), to: remap(e.to) })),
      ...asked.edges,
      clarificationEdge('NEXT', remap(`${priorPrefix}explanation`), `${current.id}:explanation`),
    ],
    retrievalContext: { nodeIds: current.nodes.map((n) => n.id), edgeIds: current.edges.map((e) => e.id) },
  });
}

// Moves a case to a new ID by replacing its ID prefix everywhere.
export function renameCase(c: LearningCase, id: string): LearningCase {
  const rename = (value: string): string => (value.startsWith(`${c.id}:`) ? `${id}${value.slice(c.id.length)}` : value);
  return validateCase({
    ...c,
    id,
    sources: c.sources.map((s) => ({ ...s, id: rename(s.id) })),
    nodes: c.nodes.map((n) => ({ ...n, id: rename(n.id), sourceIds: n.sourceIds.map(rename) })),
    edges: c.edges.map((e) => ({ ...e, id: rename(e.id), from: rename(e.from), to: rename(e.to) })),
    ...(c.retrievalContext ? { retrievalContext: { nodeIds: c.retrievalContext.nodeIds.map(rename), edgeIds: c.retrievalContext.edgeIds.map(rename) } } : {}),
  });
}

export type ResultLayer = {
  // Every intervention the child received, in order; the case records the last one as its strategy.
  strategies: readonly [Strategy, ...Strategy[]];
  outcome: Outcome;
  // The stored facts the outcome was built from, as text, so the record explains itself.
  evaluation: string;
};

// Appends the result layer in the same shape as the seed: Attempt → Intervention(s) → Outcome. Result
// nodes are stage `result`, so they never enter a similarity feature.
export function addResult(c: LearningCase, { strategies, outcome, evaluation }: ResultLayer): LearningCase {
  const evaluationSource = `${c.id}:evaluation`;
  const resultNode = (suffix: string, type: GraphNode['type'], meaning: string): GraphNode => ({ id: `${c.id}:${suffix}`, type, meaning, stage: 'result', sourceIds: [evaluationSource] });
  const interventionSuffix = (index: number) => (index === 0 ? 'intervention' : `intervention_${index + 1}`);
  const interventions = strategies.map((strategy, index) => resultNode(interventionSuffix(index), 'Intervention', strategy));
  const followEdges: GraphEdge[] = interventions.map((n, index) => ({
    id: `${n.id}-link`,
    from: index === 0 ? `${c.id}:attempt` : `${c.id}:${interventionSuffix(index - 1)}`,
    to: n.id,
    type: 'FOLLOWED_BY',
    stage: 'result',
  }));
  const lastIntervention = `${c.id}:${interventionSuffix(strategies.length - 1)}`;
  return validateCase({
    ...c,
    strategy: strategies[strategies.length - 1] ?? strategies[0],
    outcome,
    sources: [...c.sources, { id: evaluationSource, text: evaluation }],
    nodes: [...c.nodes, ...interventions, resultNode('outcome', 'Outcome', outcome)],
    edges: [...c.edges, ...followEdges, { id: `${c.id}:outcome-link`, from: lastIntervention, to: `${c.id}:outcome`, type: 'EVALUATED_BY', stage: 'result' }],
  });
}
