// The ten-box workspace: the first addend sits fixed in the box, the second addend waits in the tray,
// and the child moves one object at a time with select-then-destination buttons. Every move is
// recorded as an ordered placement; nothing is placed, counted or answered for the child.
import { useEffect, useId, useReducer, useRef, useState, type ReactNode } from 'react';
import appleUrl from '../assets/objects/apple.svg?no-inline';
import pearUrl from '../assets/objects/pear.svg?no-inline';
import '../styles/make-ten.css';
import { MAKE_TEN_COPY, STUDENT_COPY } from '@core/copy';
import { type ActivityComponent, type Appearance, type MakeTenAttempt, MakeTenAttemptSchema, type MakeTenZone } from '@core/domain';

export type MakeTenSpecProps = Extract<ActivityComponent, { type: 'MakeTenWorkspace' }>['props'];
type Placement = MakeTenAttempt['placements'][number];
type Destination = Exclude<MakeTenZone, 'tray'>;

export type MakeTenWorkspaceProps = {
  // The validated MakeTenWorkspace props from the accepted spec.
  spec: MakeTenSpecProps;
  // Help the accepted spec displays; sent with the attempt (the server derives it again).
  hints: number;
  // Identifies this activity revision, so a refresh can tell that its unsent try was dropped.
  draftKey: string;
  onSubmit: (attempt: MakeTenAttempt) => void;
};

// A ten-frame has ten slots; the box never holds more.
const TEN_FRAME_SLOTS = 10;

// The attempt schema caps the placement trace, so a move or undo that would exceed it is not offered.
const PlacementsSchema = MakeTenAttemptSchema.shape.placements;

// sessionStorage key holding the draftKey of a try that has moves or an answer but was not submitted.
const UNSENT_DRAFT_KEY = 'llime.makeTen.unsentDraft';

const ANSWER_PATTERN = /^\d+$/;

// Served as files rather than inlined, so an image that fails to load falls back to dots.
const OBJECT_ASSET: { readonly [A in Exclude<Appearance, 'dot'>]: string } = { apple: appleUrl, pear: pearUrl };

const movableIds = (count: number) => Array.from({ length: count }, (_, i) => `t${i}`);

type Layout = { box: string[]; leftOver: string[]; tray: string[]; zoneOf: ReadonlyMap<string, MakeTenZone> };

// Positions follow from the trace alone: an object's zone is its last placement, objects never moved
// stay in the tray, and the box and left-over piles keep the order objects arrived in.
function layoutOf(second: number, placements: readonly Placement[]): Layout {
  const ids = movableIds(second);
  const zoneOf = new Map<string, MakeTenZone>(ids.map((id) => [id, 'tray']));
  let box: string[] = [];
  let leftOver: string[] = [];
  for (const { objectId, to } of placements) {
    box = box.filter((id) => id !== objectId);
    leftOver = leftOver.filter((id) => id !== objectId);
    if (to === 'ten_frame') box = [...box, objectId];
    if (to === 'remaining') leftOver = [...leftOver, objectId];
    zoneOf.set(objectId, to);
  }
  return { box, leftOver, tray: ids.filter((id) => zoneOf.get(id) === 'tray'), zoneOf };
}

// The support equation, from what is actually in the box and to the side. It never states the sum.
export function equationLines(first: number, second: number, inBox: number, leftOver: number): string[] {
  if (inBox === 0 && leftOver === 0) return [MAKE_TEN_COPY.equationStart(first, second)];
  const boxTotal = first + inBox;
  const lines = [boxTotal === TEN_FRAME_SLOTS ? MAKE_TEN_COPY.equationBoxFull(first, inBox) : MAKE_TEN_COPY.equationBox(first, inBox)];
  if (leftOver > 0) lines.push(MAKE_TEN_COPY.equationLeftOver(boxTotal, leftOver));
  return lines;
}

type Draft = {
  placements: Placement[];
  // Where each undoable move came from, newest last.
  undoStack: { objectId: string; from: MakeTenZone }[];
  selected: string | null;
  answer: string;
  submitted: boolean;
};

type DraftAction =
  | { type: 'select'; objectId: string }
  | { type: 'place'; to: Destination }
  | { type: 'undo' }
  | { type: 'answer'; text: string }
  | { type: 'submit' };

const EMPTY_DRAFT: Draft = { placements: [], undoStack: [], selected: null, answer: '', submitted: false };

const fitsTrace = (placements: readonly Placement[], next: Placement) => PlacementsSchema.safeParse([...placements, next]).success;

function canPlace(draft: Draft, layout: Layout, first: number, to: Destination): boolean {
  if (draft.submitted || draft.selected === null || layout.zoneOf.get(draft.selected) === to) return false;
  if (to === 'ten_frame' && first + layout.box.length >= TEN_FRAME_SLOTS) return false;
  return fitsTrace(draft.placements, { objectId: draft.selected, to });
}

function canUndo(draft: Draft): boolean {
  const last = draft.undoStack.at(-1);
  return !draft.submitted && last !== undefined && fitsTrace(draft.placements, { objectId: last.objectId, to: last.from });
}

function parseAnswer(text: string): number | null {
  const trimmed = text.trim();
  return ANSWER_PATTERN.test(trimmed) && Number.isSafeInteger(Number(trimmed)) ? Number(trimmed) : null;
}

function reduceDraft(draft: Draft, action: DraftAction, first: number, second: number): Draft {
  if (draft.submitted) return draft;
  const layout = layoutOf(second, draft.placements);
  switch (action.type) {
    case 'select':
      if (!layout.zoneOf.has(action.objectId)) return draft;
      return { ...draft, selected: draft.selected === action.objectId ? null : action.objectId };
    case 'place': {
      const objectId = draft.selected;
      if (objectId === null || !canPlace(draft, layout, first, action.to)) return draft;
      const from = layout.zoneOf.get(objectId) ?? 'tray';
      return { ...draft, placements: [...draft.placements, { objectId, to: action.to }], undoStack: [...draft.undoStack, { objectId, from }], selected: null };
    }
    case 'undo': {
      const last = draft.undoStack.at(-1);
      if (last === undefined || !canUndo(draft)) return draft;
      // The restoring move is part of the observed trace, so it is appended rather than erased.
      return { ...draft, placements: [...draft.placements, { objectId: last.objectId, to: last.from }], undoStack: draft.undoStack.slice(0, -1), selected: null };
    }
    case 'answer':
      return { ...draft, answer: action.text };
    case 'submit':
      return parseAnswer(draft.answer) === null ? draft : { ...draft, selected: null, submitted: true };
    default: {
      const unhandled: never = action;
      return unhandled;
    }
  }
}

// Storage can be unavailable (private browsing, blocked site data). Then a refresh simply shows no
// reset notice; the draft itself is never stored, so nothing is lost or restored either way.
function readUnsentDraft(): string | null {
  try {
    return window.sessionStorage.getItem(UNSENT_DRAFT_KEY);
  } catch {
    return null;
  }
}

function writeUnsentDraft(draftKey: string | null): void {
  try {
    if (draftKey === null) window.sessionStorage.removeItem(UNSENT_DRAFT_KEY);
    else window.sessionStorage.setItem(UNSENT_DRAFT_KEY, draftKey);
  } catch {
    // See readUnsentDraft: without storage there is no notice to show later.
  }
}

function ObjectArt({ appearance, onMissing }: { appearance: Appearance; onMissing: () => void }): ReactNode {
  if (appearance === 'dot') return <span className="mt-dot" aria-hidden="true" />;
  return <img className="mt-art" src={OBJECT_ASSET[appearance]} alt="" width={48} height={48} draggable={false} onError={onMissing} />;
}

export function MakeTenWorkspace({ spec, hints, draftKey, onSubmit }: MakeTenWorkspaceProps): ReactNode {
  const { first, second, highlightEmptySlots, showEquation } = spec;
  const [draft, dispatch] = useReducer((current: Draft, action: DraftAction) => reduceDraft(current, action, first, second), EMPTY_DRAFT);
  // The requested appearance holds for the whole attempt; only a missing asset switches it to dots.
  const [assetMissing, setAssetMissing] = useState(false);
  const [wasReset] = useState(() => readUnsentDraft() === draftKey);
  const ids = { box: useId(), tray: useId(), leftOver: useId(), answer: useId(), answerReason: useId(), moveHint: useId() };
  const objectButtons = useRef(new Map<string, HTMLButtonElement>());
  const answerInput = useRef<HTMLInputElement>(null);
  const focusAfterMove = useRef(false);

  const appearance: Appearance = assetMissing ? 'dot' : spec.appearance;
  const layout = layoutOf(second, draft.placements);
  const answer = parseAnswer(draft.answer);
  const canSubmit = !draft.submitted && answer !== null;

  useEffect(() => {
    if (draft.submitted) writeUnsentDraft(null);
    else if (draft.placements.length > 0 || draft.answer !== '') writeUnsentDraft(draftKey);
  }, [draft.submitted, draft.placements.length, draft.answer, draftKey]);

  // After a move the destination buttons are disabled, so keep keyboard focus useful: go to the next
  // object still in the tray, or to the answer once the tray is empty.
  useEffect(() => {
    if (!focusAfterMove.current) return;
    focusAfterMove.current = false;
    const next = layoutOf(second, draft.placements).tray[0];
    (next === undefined ? answerInput.current : objectButtons.current.get(next))?.focus();
  }, [draft.placements, second]);

  const place = (to: Destination) => {
    focusAfterMove.current = true;
    dispatch({ type: 'place', to });
  };

  const undo = () => {
    focusAfterMove.current = draft.undoStack.length === 1;
    dispatch({ type: 'undo' });
  };

  const submit = () => {
    if (!canSubmit || answer === null) return;
    dispatch({ type: 'submit' });
    onSubmit(MakeTenAttemptSchema.parse({ placements: draft.placements, answer, hints }));
  };

  const art = <ObjectArt appearance={appearance} onMissing={() => setAssetMissing(true)} />;

  const movable = (objectId: string) => (
    <li key={objectId} className="mt-slot">
      <button
        type="button"
        className="mt-object"
        data-object-id={objectId}
        data-zone={layout.zoneOf.get(objectId)}
        aria-pressed={draft.selected === objectId}
        aria-label={MAKE_TEN_COPY.movableObject(appearance, Number(objectId.slice(1)) + 1)}
        disabled={draft.submitted}
        ref={(node) => {
          if (node === null) objectButtons.current.delete(objectId);
          else objectButtons.current.set(objectId, node);
        }}
        onClick={() => dispatch({ type: 'select', objectId })}
      >
        {art}
      </button>
    </li>
  );

  const frameSlot = (slot: number) => {
    if (slot < first) {
      return (
        <li key={`f${slot}`} className="mt-slot">
          <span className="mt-object mt-fixed" role="img" data-object-id={`f${slot}`} aria-label={MAKE_TEN_COPY.fixedObject(appearance)}>
            {art}
          </span>
        </li>
      );
    }
    const objectId = layout.box[slot - first];
    if (objectId !== undefined) return movable(objectId);
    return (
      <li key={`empty${slot}`} className="mt-slot mt-empty" data-highlight={highlightEmptySlots} aria-hidden={!highlightEmptySlots}>
        {highlightEmptySlots ? <span className="mt-empty-mark" role="img" aria-label={MAKE_TEN_COPY.emptySlot} /> : null}
      </li>
    );
  };

  return (
    <div className="mt" data-appearance={appearance} data-submitted={draft.submitted}>
      {wasReset ? (
        <p className="p-status mt-notice" role="status">
          {STUDENT_COPY.draftReset}
        </p>
      ) : null}
      <div className="mt-board">
        <section className="mt-zone mt-box" aria-labelledby={ids.box}>
          <h3 id={ids.box} className="mt-zone-label">
            {MAKE_TEN_COPY.box}
          </h3>
          <ul className="mt-frame">{Array.from({ length: TEN_FRAME_SLOTS }, (_, slot) => frameSlot(slot))}</ul>
        </section>
        <section className="mt-zone mt-tray" aria-labelledby={ids.tray}>
          <h3 id={ids.tray} className="mt-zone-label">
            {MAKE_TEN_COPY.tray}
          </h3>
          <ul className="mt-pile">{layout.tray.map(movable)}</ul>
        </section>
        <section className="mt-zone mt-left-over" aria-labelledby={ids.leftOver}>
          <h3 id={ids.leftOver} className="mt-zone-label">
            {MAKE_TEN_COPY.leftOver}
          </h3>
          <ul className="mt-pile">{layout.leftOver.map(movable)}</ul>
        </section>
      </div>
      {showEquation ? (
        <div className="mt-equation" role="group" aria-label={MAKE_TEN_COPY.equationLabel} aria-live="polite">
          {equationLines(first, second, layout.box.length, layout.leftOver.length).map((line) => (
            <p key={line} className="mt-equation-line">
              {line}
            </p>
          ))}
        </div>
      ) : null}
      <div className="mt-controls">
        <button type="button" className="p-button" aria-describedby={ids.moveHint} disabled={!canPlace(draft, layout, first, 'ten_frame')} onClick={() => place('ten_frame')}>
          {STUDENT_COPY.putInBox}
        </button>
        <button type="button" className="p-button" aria-describedby={ids.moveHint} disabled={!canPlace(draft, layout, first, 'remaining')} onClick={() => place('remaining')}>
          {STUDENT_COPY.putToSide}
        </button>
        <button type="button" className="p-button" data-variant="secondary" disabled={!canUndo(draft)} onClick={undo}>
          {MAKE_TEN_COPY.undo}
        </button>
      </div>
      {draft.submitted ? null : (
        <p id={ids.moveHint} className="p-helper mt-hint" aria-live="polite">
          {draft.selected === null ? MAKE_TEN_COPY.selectFirst(appearance) : MAKE_TEN_COPY.selected}
        </p>
      )}
      <div className="mt-answer">
        <label htmlFor={ids.answer} className="p-label">
          {STUDENT_COPY.yourAnswer}
        </label>
        <input
          id={ids.answer}
          ref={answerInput}
          className="p-input mt-answer-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={draft.answer}
          disabled={draft.submitted}
          onChange={(event) => dispatch({ type: 'answer', text: event.target.value })}
        />
        <button type="button" className="p-button" disabled={!canSubmit} aria-busy={draft.submitted} aria-describedby={canSubmit || draft.submitted ? undefined : ids.answerReason} onClick={submit}>
          {STUDENT_COPY.checkAnswer}
        </button>
      </div>
      {canSubmit || draft.submitted ? null : (
        <p id={ids.answerReason} className="p-helper mt-hint">
          {MAKE_TEN_COPY.answerFirst}
        </p>
      )}
    </div>
  );
}
