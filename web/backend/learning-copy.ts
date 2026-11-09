// Plain-language labels for the backend scenes. Backend surfaces only: nothing here is shown to a child,
// and the model-chosen name of a novel pattern never leaves this surface.
import type { GraphNode, Meaning, NodeType, Strategy } from '@core/domain';
import type { ViewEvent } from './event-projection.js';

// Short names for strategy groups, as they read beside "solved alone" counts.
export const STRATEGY_NAME: Readonly<Record<Strategy, string>> = {
  anchor_start: 'Mark the start',
  repeat_count: 'Count again',
  retry: 'Try again',
  make_ten: 'Make ten',
  reverse_direction: 'Check direction',
  clarify: 'Ask first',
};

// What each known hypothesis says, phrased as a question about the child's work, never as a diagnosis.
export const HYPOTHESIS_TEXT: Readonly<Record<Meaning, string>> = {
  count_start: 'Start counted as a move?',
  slip: 'A move missed while tapping?',
  partition_gap: 'Unsure how to split the number?',
  direction_error: 'Moving in the wrong direction?',
  unknown: 'Need more evidence',
};

const NOVEL_PREFIX = 'Possible new pattern: ';

const isKnownMeaning = (meaning: string): meaning is Meaning => Object.hasOwn(HYPOTHESIS_TEXT, meaning);

// A novel hypothesis carries a model-chosen snake_case name; it is shown as a possible pattern, never as a fact.
export function hypothesisText(node: Pick<GraphNode, 'meaning' | 'proposedMeaning'>): string {
  if (node.meaning === 'novel') return `${NOVEL_PREFIX}${node.proposedMeaning ?? 'unnamed'}`;
  return isKnownMeaning(node.meaning) ? HYPOTHESIS_TEXT[node.meaning] : node.meaning;
}

// ---------------------------------------------------------------------------------------------
// Header, source chip and footer lines.

// Where the picture comes from. A recorded replay is never shown as live.
export const SOURCE_LABEL = {
  simulation: 'Simulation · recorded agent input · synthetic cases',
  live: 'Live · Codex App Server · Neo4j · synthetic history',
} as const;
export type SourceKind = keyof typeof SOURCE_LABEL;

export const NOT_SAVED_SUFFIX = ' · not saved';

export const SCENE_COPY = {
  title: 'This student’s learning memory',
  otherLearners: 'Learning from similar experiences',
  student: 'This student',
  newSituation: '+1 NEW',
  usedToSearch: 'used to search',
  suggests: 'suggests',
  tileCaption: 'each tile is one student’s memory',
  waiting: 'waiting for agent events',
  nextStep: 'NEXT STEP',
  nextStepNotChosen: 'Not chosen yet',
  outcomeLabel: 'OUTCOME',
  outcomeNotChecked: 'Not checked yet',
  outcomePending: 'Pending · this child’s check',
  solvedAlone: 'Solved alone',
  notYet: 'Not yet',
  retentionPending: 'Retention · pending',
  addedToMemory: 'Added to learning memory',
  localPreview: 'Local preview · not saved',
  askTheChild: 'NEXT STEP · ASK THE CHILD',
  noComparableCase: 'no comparable case to borrow from',
  used: 'NEXT STEP · USED',
  attemptFallback: 'Number line attempt',
  observationFallback: 'One move short',
  whatTheChildSaid: 'WHAT THE CHILD SAID',
  possibleReason: 'POSSIBLE REASON',
  observation: 'OBSERVATION',
  attempt: 'ATTEMPT',
  concept: 'CONCEPT',
} as const;

export const fromCases = (count: number) => `NEXT STEP · FROM ${count} CASES`;
export const solvedAloneLater = (independent: number, total: number) => `${independent} of ${total} solved alone later`;
export const groupLabel = (strategy: Strategy, independent: number, total: number) => `${STRATEGY_NAME[strategy]} · ${independent}/${total} solved alone`;
export const selectedHeading = (count: number, floor: number) => `${count} SELECTED · SCORE ≥ ${floor.toFixed(2)}`;
export const otherLearnersSummary = (cases: number, learners: number) => `${cases} past situations across ${learners} other students`;
export const fieldCaption = (close: number) => `brighter = more similar · ${close} close enough to use`;
export const sharedConcept = (concept: string) => `SHARED CONCEPT · ${concept.replaceAll('_', ' ').toUpperCase()}`;

// The sentence in the header: what is happening now, in plain words.
export const OPERATION_COPY = {
  interrupted: 'Step interrupted. The last accepted state is kept.',
  recalling: 'Recalling what this student has learned before',
  listening: 'Listening to how this child counted',
  reading: 'Reading how this child explained the answer',
  possible: 'A possible reason, not a diagnosis',
  searching: 'Searching similar learning experiences',
  found: 'Found similar experiences in other students’ memories',
  helped: 'Which explanations helped in similar situations',
  choosing: 'Choosing how to explain from relevant learning experiences',
  solvedAlone: 'Solved alone. A new learning result.',
  notYetSolved: 'Not solved alone yet. Another step is needed.',
} as const;

// The line under the stage: the type, then key=value fields in the event's own words.
export interface RawLine {
  readonly type: string;
  readonly fields: readonly string[];
}

const RAW_TEXT_MAX = 160;
const quote = (text: string) => `"${text.length > RAW_TEXT_MAX ? `${text.slice(0, RAW_TEXT_MAX - 1)}…` : text}"`;
const inputText = (input: unknown): string => (typeof input === 'string' ? input : input === undefined ? '' : JSON.stringify(input));

function rawFields(event: ViewEvent, added: readonly NodeType[]): string[] {
  switch (event.type) {
    case 'memory.retrieved':
      return [`cases=${event.payload.caseIds.length}`, `concepts=${event.payload.conceptIds.join(',')}`, `links=${event.payload.links.length}`];
    case 'runtime.input':
      return [`model=${event.payload.model}`, `phase=${event.payload.phase}`, `input=${quote(inputText(event.payload.input))}`];
    case 'tool.started':
      return [event.payload.name, 'called'];
    case 'tool.completed':
      return [event.payload.name, `callId=${event.payload.callId}`];
    case 'tool.failed':
      return [event.payload.name, event.payload.error.code];
    case 'runtime.message':
      return [quote(event.payload.text)];
    case 'runtime.completed':
      return [`status=${event.payload.status}`];
    case 'graph.updated':
      return [`nodes=${event.payload.graph.nodes.length}`, ...added.map((type) => `+${type}`)];
    case 'search.started':
      return [`candidateCount=${event.payload.candidateCount}`, `matching=${event.payload.matchingVersion}`];
    case 'search.completed': {
      const top = event.payload.candidates[0];
      return [
        `ranked=${event.payload.candidateCount}`,
        ...(top ? [`top=${top.id}`, `score=${top.score.toFixed(2)}`, `coverage=${top.coverage.toFixed(2)}`] : []),
        `decision=${event.payload.decision.strategy}`,
        `evidence=${event.payload.decision.evidenceIds.length}`,
      ];
    }
    case 'outcome.committed':
      return [`intervention=${event.payload.strategy}`, `outcome=${event.payload.outcome}`, `saved=${event.payload.saved}`];
    case 'operation.failed':
      return [`code=${event.payload.code}`, 'last accepted state kept'];
  }
}

export function rawLine(event: ViewEvent | null, added: readonly NodeType[] = []): RawLine {
  if (!event) return { type: 'ready', fields: [SCENE_COPY.waiting] };
  const fields = rawFields(event, added);
  return { type: event.type, fields: event.elapsedMs === undefined ? fields : [...fields, `+${(event.elapsedMs / 1000).toFixed(1)}s`] };
}

export const MISSING_RUN = 'Open this page with ?run=<run id> to follow a run.';
export const CORPUS_MISMATCH = 'This run searched a different case corpus than the one bundled with this page, so its result cannot be drawn.';
