// Plain-language labels for the backend scenes. Backend surfaces only: nothing here is shown to a child,
// and the model-chosen name of a novel pattern never leaves this surface.
import type { GraphNode, Meaning, Strategy } from '@core/domain';

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
