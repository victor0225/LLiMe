import { useEffect, useId, useRef, useState } from 'react';
import { NUMBER_LINE_COPY, STUDENT_COPY, VOICE_STATUS_COPY, problemQuestion } from '@core/copy';
import { type Activity, type Attempt, COMMAND_PHASES, type CommandType, type RunPhase, type TemplateId } from '@core/domain';
import { HTTP_STATUS } from '@core/routes';
import { type EventStore, RunRequestError } from '../lib/event-store';
import { EMPTY_DRAFT, NumberLine, type NumberLineDraft, draftPosition } from './NumberLine';
import '../styles/number-line.css';

// The commands that submit a number-line attempt; the run phase decides which one applies.
const SUBMIT_COMMAND_TYPES = ['attempt', 'practice', 'verify'] as const satisfies readonly CommandType[];
type SubmitCommandType = (typeof SUBMIT_COMMAND_TYPES)[number];

export type PracticeCommand = { type: SubmitCommandType; attempt: Attempt };
// `conflict`: the run moved on (409, or the activity changed before the command was sent); the
// screen never resends. `failed`: the attempt was not saved and the draft is kept.
export type SubmitResult = 'saved' | 'conflict' | 'failed';

export type PracticeProps = {
  // The accepted number-line activity: initial, anchored support, plain retry or independent check.
  activity: Activity;
  phase: RunPhase;
  // True only after microphone and playback teardown was acknowledged for this run.
  voiceOff: boolean;
  submit: (command: PracticeCommand) => Promise<SubmitResult>;
};

// Every number-line activity the child acts on. Other templates have their own screens.
const NUMBER_LINE_TEMPLATES: ReadonlySet<TemplateId> = new Set(['initial_number_line', 'anchor_start_number_line', 'manipulation_retry', 'independent_number_line']);

// A conflict means the run moved on: the screen returns to the draft and never resends by itself.
const REQUEST_AFTER: Readonly<Record<SubmitResult, 'idle' | 'saved' | 'unconfirmed'>> = { saved: 'saved', conflict: 'idle', failed: 'unconfirmed' };

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

// Sends the attempt through the run's single mutation queue. The command is dropped if, by the time
// it is sent, the run no longer shows this exact activity revision.
export function sendPracticeAttempt(store: EventStore, activity: Activity): PracticeProps['submit'] {
  return async (command) => {
    try {
      const snapshot = await store.sendRunCommand('runCommand', (run) =>
        run.activity?.id === activity.id && run.activity.revision === activity.revision ? { ...command, commandId: crypto.randomUUID(), revision: run.revision } : null,
      );
      return snapshot === null ? 'conflict' : 'saved';
    } catch (error) {
      if (error instanceof RunRequestError && error.status === HTTP_STATUS.conflict) return 'conflict';
      return 'failed';
    }
  };
}

export function Practice(props: PracticeProps) {
  // A new or revised activity always starts from an empty draft.
  return <PracticeScreen key={activityKey(props.activity)} {...props} />;
}

function PracticeScreen({ activity, phase, voiceOff, submit }: PracticeProps) {
  const titleId = useId();
  const reasonId = useId();
  const [draft, setDraft] = useState<NumberLineDraft>(EMPTY_DRAFT);
  // `unconfirmed`: the last check got no answer the screen can trust. The draft stays and the child
  // may check again; a stale second command is rejected by the server's revision check.
  const [request, setRequest] = useState<'idle' | 'pending' | 'saved' | 'unconfirmed'>('idle');
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
  const isLocked = request === 'pending' || request === 'saved';
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
    setRequest(REQUEST_AFTER[result]);
  };

  return (
    <section className="nl-practice" aria-labelledby={titleId}>
      <div className="nl-guide">
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
          {request === 'unconfirmed' && (
            <p className="p-status nl-notice" role="status">
              {STUDENT_COPY.checkingSave}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
