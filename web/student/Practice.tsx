import { useEffect, useId, useRef, useState } from 'react';
import { NUMBER_LINE_COPY, STUDENT_COPY, VOICE_STATUS_COPY, problemQuestion } from '@core/copy';
import { type Activity, type Attempt, COMMAND_PHASES, type CommandType, type RunPhase, type TemplateId } from '@core/domain';
import { Mascot } from './Mascot';
import { EMPTY_DRAFT, NumberLine, type NumberLineDraft, draftPosition } from './NumberLine';
import type { SubmitResult } from './StudentApp';
import '../styles/number-line.css';

// The commands that submit a number-line attempt; the run phase decides which one applies.
const SUBMIT_COMMAND_TYPES = ['attempt', 'practice', 'verify'] as const satisfies readonly CommandType[];
type SubmitCommandType = (typeof SUBMIT_COMMAND_TYPES)[number];

export type PracticeCommand = { type: SubmitCommandType; attempt: Attempt };

export type PracticeProps = {
  // The accepted number-line activity: initial, anchored support, plain retry or independent check.
  activity: Activity;
  phase: RunPhase;
  // True only after microphone and playback teardown was acknowledged for this run.
  voiceOff: boolean;
  // StudentApp's slot.submit: it adds the command ID and revision and reports the saved state.
  submit: (command: PracticeCommand) => Promise<SubmitResult>;
};

// Every number-line activity the child acts on. Other templates have their own screens.
const NUMBER_LINE_TEMPLATES: ReadonlySet<TemplateId> = new Set(['initial_number_line', 'anchor_start_number_line', 'manipulation_retry', 'independent_number_line']);

// Small enough that the companion never crowds the number line in either orientation.
const MASCOT_SIZE_PX = 88;

// The line offers no help on request, so the child adds no hints of their own. The server adds the
// helpers the accepted activity displayed, so a zero here can never hide them.
const REQUESTED_HINTS = 0;

// A reload throws the unsent draft away. This marker only remembers that one existed, so the
// screen can say so; the moves themselves are never kept.
const UNSENT_DRAFT_KEY = 'llime.number-line.unsent';
const activityKey = (activity: Activity) => `${activity.id}#${activity.revision}`;

function readUnsentMarker(): string | null {
  try {
    return sessionStorage.getItem(UNSENT_DRAFT_KEY);
  } catch {
    // Without storage the reset notice cannot be shown; the draft is discarded all the same.
    return null;
  }
}

function writeUnsentMarker(value: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(UNSENT_DRAFT_KEY);
    else sessionStorage.setItem(UNSENT_DRAFT_KEY, value);
  } catch {
    // Without storage the reset notice cannot be shown; nothing else depends on the marker.
  }
}

export function Practice(props: PracticeProps) {
  // A new or revised activity always starts from an empty draft.
  return <PracticeScreen key={activityKey(props.activity)} {...props} />;
}

function PracticeScreen({ activity, phase, voiceOff, submit }: PracticeProps) {
  const titleId = useId();
  const reasonId = useId();
  const [draft, setDraft] = useState<NumberLineDraft>(EMPTY_DRAFT);
  // After a conflict or a failure the draft stays and the screen never resends by itself; the run
  // frame says whether the save is still being checked.
  const [request, setRequest] = useState<'idle' | 'pending' | 'saved'>('idle');
  const [showDraftReset, setShowDraftReset] = useState(() => readUnsentMarker() === activityKey(activity));
  const inFlight = useRef(false);

  useEffect(() => {
    writeUnsentMarker(draft.start === null || request === 'saved' ? null : activityKey(activity));
  }, [draft, request, activity]);

  const problem = activity.problem;
  if (problem === null || !NUMBER_LINE_TEMPLATES.has(activity.templateId)) {
    return (
      <p className="p-status" data-tone="error" role="alert">
        {STUDENT_COPY.activityOpenFailed}
      </p>
    );
  }

  const helpers = activity.activitySpec?.components ?? [];
  const startMarker = helpers.flatMap((component) => (component.type === 'StartMarker' ? [component.props.value] : []))[0] ?? null;
  const showMoveCount = helpers.some((component) => component.type === 'JumpCounter');
  const commandType = SUBMIT_COMMAND_TYPES.find((type) => COMMAND_PHASES[type].includes(phase));
  const position = draftPosition(draft);
  const isLocked = request !== 'idle';
  const canCheck = commandType !== undefined && draft.start !== null && !isLocked;
  const question = problemQuestion(problem);

  const changeDraft = (next: NumberLineDraft) => {
    setShowDraftReset(false);
    setDraft(next);
  };

  // One press sends one command; further presses do nothing until the server has answered.
  const check = async () => {
    if (!canCheck || inFlight.current || commandType === undefined || draft.start === null || position === null) return;
    inFlight.current = true;
    setRequest('pending');
    const result = await submit({ type: commandType, attempt: { start: draft.start, moves: draft.moves, answer: position, hints: REQUESTED_HINTS } });
    inFlight.current = false;
    setRequest(result === 'saved' ? 'saved' : 'idle');
  };

  return (
    <section className="nl-practice" aria-labelledby={titleId}>
      <div className="nl-guide">
        <Mascot state="idle" size={MASCOT_SIZE_PX} />
        <h1 id={titleId} className="nl-title">
          {activity.title}
        </h1>
        {activity.body !== question && <p className="nl-instruction">{activity.body}</p>}
        {showDraftReset && (
          <p className="p-status nl-notice" role="status">
            {STUDENT_COPY.draftReset}
          </p>
        )}
        {activity.kind === 'independent' && voiceOff && <p className="nl-voice-off">{VOICE_STATUS_COPY.off}</p>}
      </div>
      <div className="nl-workspace">
        <p className="nl-equation">{question}</p>
        <NumberLine draft={draft} onDraftChange={changeDraft} startMarker={startMarker} showMoveCount={showMoveCount} disabled={isLocked} />
        <div className="nl-submit">
          <button
            type="button"
            className="p-button nl-check"
            disabled={!canCheck}
            aria-busy={request === 'pending'}
            aria-describedby={draft.start === null ? reasonId : undefined}
            onClick={() => void check()}
          >
            {activity.primaryLabel}
          </button>
          {draft.start === null && (
            <p id={reasonId} className="p-helper nl-reason">
              {NUMBER_LINE_COPY.chooseStart}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
