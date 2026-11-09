import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { NUMBER_LINE_COPY, STUDENT_COPY } from '@core/copy';
import { type Attempt, AttemptSchema, NUMBER_LINE_MAX, NUMBER_LINE_MIN } from '@core/domain';

// The child's unsent work on the line: the start they chose (null until chosen) and every move
// after it, as the positions visited in order. It becomes an attempt only when it is submitted.
export type NumberLineDraft = { readonly start: Attempt['start'] | null; readonly moves: Attempt['moves'] };

export const EMPTY_DRAFT: NumberLineDraft = { start: null, moves: [] };

export const draftPosition = (draft: NumberLineDraft): number | null => draft.moves.at(-1) ?? draft.start;

export type NumberLineProps = {
  draft: NumberLineDraft;
  onDraftChange: (draft: NumberLineDraft) => void;
  // A support activity may anchor the start. The marker only shows the anchor: the start is still
  // recorded by the child's own Start press.
  startMarker: number | null;
  // A support activity may show a live count of the child's own moves.
  showMoveCount: boolean;
  // While a check is in flight or after it was saved, the line cannot change.
  disabled: boolean;
};

const TICKS = Array.from({ length: NUMBER_LINE_MAX - NUMBER_LINE_MIN + 1 }, (_, i) => NUMBER_LINE_MIN + i);
const MovesSchema = AttemptSchema.shape.moves;

const STEP_BY_KEY: Readonly<Record<string, -1 | 1>> = { ArrowLeft: -1, ArrowRight: 1 };

const onLine = (value: number) => value >= NUMBER_LINE_MIN && value <= NUMBER_LINE_MAX;

// A move goes to a neighbouring tick on the line, and only while the attempt still accepts moves.
function canMoveTo(draft: NumberLineDraft, target: number): boolean {
  const position = draftPosition(draft);
  if (position === null || Math.abs(target - position) !== 1 || !onLine(target)) return false;
  return MovesSchema.safeParse([...draft.moves, target]).success;
}

type TickRole = 'start' | 'move' | 'current' | 'inert';

function tickRole(draft: NumberLineDraft, value: number, startMarker: number | null, disabled: boolean): TickRole {
  const position = draftPosition(draft);
  if (value === position) return 'current';
  if (disabled) return 'inert';
  if (position === null) return startMarker === null || startMarker === value ? 'start' : 'inert';
  return canMoveTo(draft, value) ? 'move' : 'inert';
}

export function NumberLine({ draft, onDraftChange, startMarker, showMoveCount, disabled }: NumberLineProps) {
  const position = draftPosition(draft);
  // Before a start is chosen, the arrow keys move this focus cursor; Enter then records it.
  const [cursor, setCursor] = useState(startMarker ?? NUMBER_LINE_MIN);
  const ticks = useRef(new Map<number, HTMLButtonElement>());
  // Set when the control that had focus is about to disappear or move: focus then follows the
  // line's tab stop instead of falling back to the page.
  const focusTabStop = useRef(false);
  const tabStop = position ?? cursor;

  // Keep the current position visible when the line is wider than its card.
  useEffect(() => {
    const tick = ticks.current.get(tabStop);
    if (position !== null) tick?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (focusTabStop.current) tick?.focus();
    focusTabStop.current = false;
  }, [position, tabStop]);

  const chooseStart = (value: number) => {
    focusTabStop.current = true;
    onDraftChange({ start: value, moves: [] });
  };
  const moveTo = (target: number) => {
    if (canMoveTo(draft, target)) onDraftChange({ ...draft, moves: [...draft.moves, target] });
  };
  // A move button that cannot go further becomes disabled; focus then moves to the current tick.
  const step = (direction: -1 | 1) => {
    if (position === null) return;
    const target = position + direction;
    const next: NumberLineDraft = { ...draft, moves: [...draft.moves, target] };
    if (!canMoveTo(next, target + direction)) focusTabStop.current = true;
    moveTo(target);
  };

  const pressTick = (value: number) => {
    const role = tickRole(draft, value, startMarker, disabled);
    if (role === 'start') chooseStart(value);
    if (role === 'move') moveTo(value);
  };

  // Each arrow press records at most one adjacent move. A held key repeats keydown events; those
  // are ignored so one press can never become several moves.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = STEP_BY_KEY[event.key];
    if (step === undefined || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    if (event.repeat || disabled) return;
    if (position === null) {
      if (startMarker !== null) return;
      const next = Math.min(NUMBER_LINE_MAX, Math.max(NUMBER_LINE_MIN, cursor + step));
      setCursor(next);
      ticks.current.get(next)?.focus();
      return;
    }
    focusTabStop.current = event.target instanceof HTMLButtonElement && event.target.dataset.tick !== undefined;
    moveTo(position + step);
  };

  const canReset = !disabled && draft.start !== null;
  const reset = () => {
    focusTabStop.current = true;
    setCursor(draft.start ?? cursor);
    onDraftChange(EMPTY_DRAFT);
  };

  return (
    <div className="nl" onKeyDown={onKeyDown}>
      {startMarker !== null && position === null && (
        <button type="button" className="p-button nl-start" disabled={disabled} onClick={() => chooseStart(startMarker)}>
          {STUDENT_COPY.startAt(startMarker)}
        </button>
      )}
      <div className="nl-rail" role="group" aria-label={NUMBER_LINE_COPY.lineLabel}>
        {TICKS.map((value) => {
          const role = tickRole(draft, value, startMarker, disabled);
          return (
            <button
              key={value}
              ref={(element) => {
                if (element) ticks.current.set(value, element);
                else ticks.current.delete(value);
              }}
              type="button"
              className="nl-tick"
              data-tick={value}
              data-role={role}
              data-start={value === draft.start ? '' : undefined}
              data-start-marker={value === startMarker ? '' : undefined}
              aria-current={role === 'current' ? 'true' : undefined}
              aria-disabled={role === 'current' || role === 'inert' ? 'true' : undefined}
              tabIndex={value === tabStop ? 0 : -1}
              onClick={() => pressTick(value)}
            >
              {value}
            </button>
          );
        })}
      </div>
      <div className="nl-readout">
        <p className="nl-position" role="status">
          {position === null ? '' : NUMBER_LINE_COPY.position(position)}
        </p>
        {showMoveCount && <p className="nl-count">{NUMBER_LINE_COPY.moveCount(draft.moves.length)}</p>}
      </div>
      <div className="nl-moves">
        <button type="button" className="p-button nl-move" data-variant="secondary" disabled={disabled || position === null || !canMoveTo(draft, position - 1)} onClick={() => step(-1)}>
          <ArrowIcon direction="back" />
          {STUDENT_COPY.moveBack}
        </button>
        <button type="button" className="p-button nl-move" data-variant="secondary" disabled={disabled || position === null || !canMoveTo(draft, position + 1)} onClick={() => step(1)}>
          {STUDENT_COPY.moveForward}
          <ArrowIcon direction="forward" />
        </button>
      </div>
      <button type="button" className="p-button nl-reset" data-variant="quiet" disabled={!canReset} onClick={reset}>
        {STUDENT_COPY.resetMoves}
      </button>
    </div>
  );
}

// The move buttons carry their direction as a picture as well as in words.
function ArrowIcon({ direction }: { direction: 'back' | 'forward' }) {
  return (
    <svg className="p-icon nl-arrow" data-direction={direction} viewBox="0 0 256 256" aria-hidden="true" focusable="false">
      <path d="M224.49,136.49l-72,72a12,12,0,0,1-17-17L187,140H40a12,12,0,0,1,0-24H187L135.51,64.48a12,12,0,0,1,17-17l72,72A12,12,0,0,1,224.49,136.49Z" />
    </svg>
  );
}
