import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { EXPLAIN_COPY, OUTCOME_COPY, STUDENT_COPY, VOICE_CONTROL_COPY, VOICE_STATUS_COPY, firstNumberSelected, problemQuestion } from '@core/copy';
import { EXPLANATION_MAX_CHARS, type Command, type Problem, type RunPhase, type SavedAttempt } from '@core/domain';
import type { RunEvent, RunSnapshot } from '@core/events';
import { useRunEvents, type EventStore } from '../lib/event-store';
import type { VoiceClient, VoiceView } from '../voice';
import { ConnectionNotice, Outcome, outcomeView, type StartNewRun } from './Outcome';
import '../styles/explain.css';

// The voice controls a student screen may press. A press only asks the voice client to act; the row
// changes when the client's own state changes.
export type VoiceControls = Pick<VoiceClient, 'start' | 'toggleMute' | 'end' | 'interruptPlayback'>;

// A learning command as a screen asks for it; the run's command queue adds the latest revision. The
// caller keeps the command ID across retries of the same action, so a send whose answer was lost is
// reconciled by the server instead of arriving twice. Resolves once the server committed the command
// and rejects when it was not accepted.
type WithoutEnvelope<C> = C extends unknown ? Omit<C, 'commandId' | 'revision'> : never;
export type LearningCommandRequest = WithoutEnvelope<Command>;
export type SendLearningCommand = (command: LearningCommandRequest, commandId: string) => Promise<void>;

// The command ID for an action: reused while the same action is retried, fresh once it changes.
function useRetryCommandId() {
  const last = useRef<{ key: string; commandId: string } | null>(null);
  return {
    forAction: (key: string) => {
      if (last.current?.key !== key) last.current = { key, commandId: crypto.randomUUID() };
      return last.current.commandId;
    },
    settled: () => {
      last.current = null;
    },
  };
}

// The clarification offers the same 0-20 ticks as the number line the child used.
const NUMBER_LINE_TICKS = Array.from({ length: 21 }, (_, tick) => tick);

// The selected number and the child's own words travel as one explanation, joined by a newline.
export function combineExplanation(selection: string | null, typed: string): string {
  return [selection, typed.trim()].filter((part) => part).join('\n');
}

function voiceStatusLabel(voice: VoiceView): string | null {
  // A refused microphone is not a lost connection, so it is named for what happened.
  if (voice.failure === 'permission') return EXPLAIN_COPY.microphoneDeniedTitle;
  if (voice.phase === 'starting' || voice.phase === 'connecting') return EXPLAIN_COPY.voiceConnecting;
  return voice.status === null ? null : VOICE_STATUS_COPY[voice.status];
}

export type VoiceStatusProps = {
  voice: VoiceView;
  controls: VoiceControls;
  // False during independent work: voice reopens only by the child's choice after an assessment.
  offerStart: boolean;
};

// The compact voice row every student screen reuses. "Listening" appears only while the session is
// live with the microphone on, and "Voice is off" only after the client tore the audio down.
export function VoiceStatus({ voice, controls, offerStart }: VoiceStatusProps) {
  const label = voiceStatusLabel(voice);
  const isLive = voice.phase === 'live';
  const canStart = offerStart && (voice.phase === 'idle' || voice.phase === 'ended');
  const canEnd = isLive || voice.phase === 'starting' || voice.phase === 'connecting';
  const canReconnect = offerStart && voice.phase === 'failed' && voice.failure !== 'permission';
  return (
    <div className="ex ex-voice" data-phase={voice.phase} data-status={voice.status ?? 'none'}>
      <p className="ex-voice-status" role="status">
        {label !== null && (
          <>
            <span className="ex-voice-mark" aria-hidden="true" />
            {label}
          </>
        )}
      </p>
      <div className="ex-voice-controls">
        {canStart && (
          <button className="p-button" data-variant="secondary" type="button" onClick={() => void controls.start()}>
            {VOICE_CONTROL_COPY.enable}
          </button>
        )}
        {isLive && (
          <button className="p-button" data-variant="secondary" type="button" aria-pressed={voice.isMuted} onClick={controls.toggleMute}>
            {VOICE_CONTROL_COPY.mute}
          </button>
        )}
        {canEnd && (
          <button className="p-button" data-variant="secondary" type="button" onClick={() => void controls.end()}>
            {VOICE_CONTROL_COPY.end}
          </button>
        )}
        {canReconnect && (
          <button className="p-button" data-variant="secondary" type="button" onClick={() => void controls.start()}>
            {VOICE_CONTROL_COPY.reconnect}
          </button>
        )}
      </div>
    </div>
  );
}

// Explains a voice failure in words next to the row; typing stays open either way.
function VoiceNotice({ voice }: { voice: VoiceView }) {
  if (voice.phase !== 'failed') return null;
  return <p className="ex-quiet">{voice.failure === 'permission' ? EXPLAIN_COPY.microphoneDeniedBody : EXPLAIN_COPY.voiceDisconnectedBody}</p>;
}

// Captions are plain text, not a live region, so a screen reader is not interrupted per fragment.
function Captions({ voice }: { voice: VoiceView }) {
  const { input, output } = voice.captions;
  if (!input && !output) return null;
  return (
    <div className="ex-captions">
      {output && (
        <figure className="ex-caption" data-speaker="tutor">
          <figcaption>{EXPLAIN_COPY.captionTutor}</figcaption>
          <p>{output}</p>
        </figure>
      )}
      {input && (
        <figure className="ex-caption" data-speaker="you">
          <figcaption>{EXPLAIN_COPY.captionYou}</figcaption>
          <p>{input}</p>
        </figure>
      )}
    </div>
  );
}

// The problem and the child's submitted answer stay visible while they explain it.
function ProblemCard({ problem, answer }: { problem: Problem; answer: number }) {
  return (
    <div className="p-card ex-problem">
      <p className="ex-math">{problemQuestion(problem)}</p>
      <dl className="ex-answer">
        <dt>{STUDENT_COPY.yourAnswer}</dt>
        <dd>{answer}</dd>
      </dl>
    </div>
  );
}

type TypedExplanationProps = {
  selection: string | null;
  send: SendLearningCommand;
  canSend: boolean;
  autoFocus: boolean;
};

// The labeled typed fallback. Nothing is cut to fit: text over the limit keeps Send disabled, and a
// failed send keeps the draft.
function TypedExplanation({ selection, send, canSend, autoFocus }: TypedExplanationProps) {
  const fieldId = useId();
  const countId = useId();
  const errorId = useId();
  const previewId = useId();
  const [draft, setDraft] = useState('');
  const [state, setState] = useState<'editing' | 'sending' | 'failed'>('editing');
  const inFlight = useRef(false);
  const commandIds = useRetryCommandId();
  const text = combineExplanation(selection, draft);
  const isTooLong = text.length > EXPLANATION_MAX_CHARS;
  const isSendable = canSend && state !== 'sending' && text.length > 0 && !isTooLong;

  const submit = async () => {
    if (!isSendable || inFlight.current) return;
    inFlight.current = true;
    setState('sending');
    try {
      await send({ type: 'explain', text }, commandIds.forAction(text));
      commandIds.settled();
      setDraft('');
      setState('editing');
    } catch {
      setState('failed');
    } finally {
      inFlight.current = false;
    }
  };
  // Ctrl/Cmd+Enter sends; plain Enter stays a newline.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    void submit();
  };
  const describedBy = [countId, isTooLong ? errorId : null].filter(Boolean).join(' ');

  return (
    <div className="ex-typed">
      <label className="p-label" htmlFor={fieldId}>
        {STUDENT_COPY.explanationLabel}
      </label>
      <textarea
        id={fieldId}
        className="p-input"
        value={draft}
        autoFocus={autoFocus}
        readOnly={state === 'sending'}
        aria-invalid={isTooLong}
        aria-describedby={describedBy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <p className="p-helper" id={countId}>
        {EXPLAIN_COPY.characterCount(text.length, EXPLANATION_MAX_CHARS)}
      </p>
      {isTooLong && (
        <p className="p-helper" data-tone="error" id={errorId}>
          {EXPLAIN_COPY.tooLong(EXPLANATION_MAX_CHARS)}
        </p>
      )}
      {selection !== null && (
        <div className="ex-preview">
          <p className="p-label" id={previewId}>
            {EXPLAIN_COPY.messagePreview}
          </p>
          <p className="ex-preview-text" aria-labelledby={previewId}>
            {text}
          </p>
        </div>
      )}
      <button className="p-button" type="button" disabled={!isSendable} aria-busy={state === 'sending'} onClick={submit}>
        {STUDENT_COPY.sendExplanation}
      </button>
      {state === 'failed' && (
        <p className="p-helper" data-tone="error" role="alert">
          {EXPLAIN_COPY.sendFailed}
        </p>
      )}
    </div>
  );
}

function FirstNumberChoice({ labelledBy, selected, onSelect }: { labelledBy: string; selected: number | null; onSelect: (tick: number) => void }) {
  const name = useId();
  return (
    <fieldset className="ex-first-number" aria-labelledby={labelledBy}>
      <div className="ex-ticks">
        {NUMBER_LINE_TICKS.map((tick) => (
          <label key={tick} className="ex-tick">
            <input type="radio" name={name} value={tick} checked={selected === tick} onChange={() => onSelect(tick)} />
            <span>{tick}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function StopLearning({ send, canSend }: { send: SendLearningCommand; canSend: boolean }) {
  const [state, setState] = useState<'idle' | 'stopping' | 'failed'>('idle');
  const inFlight = useRef(false);
  const commandIds = useRetryCommandId();
  const stop = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState('stopping');
    try {
      await send({ type: 'stop_learning' }, commandIds.forAction('stop_learning'));
      commandIds.settled();
      setState('idle');
    } catch {
      setState('failed');
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <div className="ex-stop">
      <button className="p-button" data-variant="quiet" type="button" disabled={!canSend || state === 'stopping'} aria-busy={state === 'stopping'} onClick={stop}>
        {STUDENT_COPY.stopLearning}
      </button>
      {state === 'failed' && (
        <p className="p-helper" data-tone="error" role="alert">
          {EXPLAIN_COPY.stopFailed}
        </p>
      )}
    </div>
  );
}

function TypeInsteadButton({ onPress }: { onPress: () => void }) {
  return (
    <button className="p-button" data-variant="secondary" type="button" onClick={onPress}>
      {VOICE_CONTROL_COPY.typeInstead}
    </button>
  );
}

export type ExplanationProps = {
  // The question heading: "How did you get 12?" or the clarification activity's own title.
  question: string;
  problem: Problem;
  answer: number;
  // Null when this server offers no voice; the typed fallback is then open from the start.
  voice: VoiceView | null;
  voiceControls: VoiceControls;
  send: SendLearningCommand;
  // False while the run's connection is paused; nothing new is sent until it is confirmed.
  canSend: boolean;
  // clarify_first_number: a 0-20 selection plus optional words, sent as one explanation.
  askFirstNumber: boolean;
  // A short line before the question, e.g. after a support activity that did not work.
  intro: string | null;
};

// The explanation step after a wrong answer. Voice delegation seals the spoken explanation on the
// server, so there is no Done button and no transcript review here.
export function Explanation({ question, problem, answer, voice, voiceControls, send, canSend, askFirstNumber, intro }: ExplanationProps) {
  const headingId = useId();
  const [isTyping, setIsTyping] = useState(voice === null || askFirstNumber);
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <section className="ex ex-screen" aria-labelledby={headingId}>
      <div className="ex-guide">
        {intro && <p className="p-speech ex-intro">{intro}</p>}
        <h1 id={headingId} className="ex-title">
          {question}
        </h1>
        {voice && <VoiceStatus voice={voice} controls={voiceControls} offerStart />}
        {voice && <VoiceNotice voice={voice} />}
        {!isTyping && <TypeInsteadButton onPress={() => setIsTyping(true)} />}
      </div>
      <div className="ex-work">
        <ProblemCard problem={problem} answer={answer} />
        {voice && <Captions voice={voice} />}
        {askFirstNumber && <FirstNumberChoice labelledBy={headingId} selected={selected} onSelect={setSelected} />}
        {isTyping && (
          <TypedExplanation
            selection={selected === null ? null : firstNumberSelected(selected)}
            send={send}
            canSend={canSend}
            autoFocus={voice !== null && !askFirstNumber}
          />
        )}
      </div>
      <StopLearning send={send} canSend={canSend} />
    </section>
  );
}

export type ThinkingProps = {
  // A correction replaced the activity; its replacement is not published yet.
  isUpdating: boolean;
  problem: Problem;
  answer: number;
  voice: VoiceView | null;
  voiceControls: VoiceControls;
  send: SendLearningCommand;
  canSend: boolean;
};

// Waiting for the backend after an accepted explanation. It shows no progress figure, tool or
// diagnosis; voice can still be muted and typing still sends a correction.
export function Thinking({ isUpdating, problem, answer, voice, voiceControls, send, canSend }: ThinkingProps) {
  const headingId = useId();
  const [isTyping, setIsTyping] = useState(false);
  return (
    <section className="ex ex-screen" aria-labelledby={headingId}>
      <div className="ex-guide">
        <h1 id={headingId} className="ex-title" aria-live="polite">
          {isUpdating ? EXPLAIN_COPY.activityUpdating : STUDENT_COPY.interpreting}
        </h1>
        <p className="ex-quiet">{VOICE_STATUS_COPY.thinking}</p>
        {voice && <VoiceStatus voice={voice} controls={voiceControls} offerStart />}
        {!isTyping && <TypeInsteadButton onPress={() => setIsTyping(true)} />}
      </div>
      <div className="ex-work">
        <ProblemCard problem={problem} answer={answer} />
        {voice && <Captions voice={voice} />}
        {isTyping && <TypedExplanation selection={null} send={send} canSend={canSend} autoFocus />}
      </div>
      <StopLearning send={send} canSend={canSend} />
    </section>
  );
}

// Whether a typed or spoken correction can still replace the activity. After the practice attempt
// was submitted, in the independent check or once the run ended, it needs a fresh run instead.
export function correctionWindow(run: RunSnapshot): 'open' | 'closed' {
  if (run.stopped) return 'closed';
  if (run.phase === 'PROCESSING') return 'open';
  if (run.phase !== 'PRACTICE' || run.activity === null) return 'closed';
  const { id, revision } = run.activity;
  return run.attempts.some((saved) => saved.activityId === id && saved.activityRevision === revision) ? 'closed' : 'open';
}

// The latest correction superseded the operation that was running for the current epoch.
function isCorrectionPending(run: RunSnapshot, events: readonly RunEvent[]): boolean {
  return [...run.execution.events, ...events].some(
    (event) => event.type === 'operation.cancelled' && event.payload.reason === 'superseded' && event.payload.cancellationEpoch === run.cancellationEpoch,
  );
}

// Phases this flow renders, plus any stopped run. Practice, support, the retry and the independent
// check belong to their own screens.
export const EXPLAIN_FLOW_PHASES: readonly RunPhase[] = ['EXPLAIN', 'PROCESSING', 'CLARIFY', 'NEEDS_SUPPORT', 'COMPLETE', 'ERROR'];

export function isExplainFlowRun(run: RunSnapshot): boolean {
  return run.stopped || EXPLAIN_FLOW_PHASES.includes(run.phase);
}

// Sends a learning command through the run's single mutation queue, with the revision current when
// the request actually leaves.
export function learningCommandSender(store: EventStore): SendLearningCommand {
  return async (command, commandId) => {
    await store.sendRunCommand('runCommand', (run) => ({ ...command, commandId, revision: run.revision }));
  };
}

export type ExplainFlowProps = {
  store: EventStore;
  // Null when this server offers no voice.
  voice: VoiceView | null;
  voiceControls: VoiceControls;
  startNewRun: StartNewRun;
};

function lastAttempt(run: RunSnapshot, criterion?: SavedAttempt['criterion']): SavedAttempt | null {
  return run.attempts.filter((saved) => criterion === undefined || saved.criterion === criterion).at(-1) ?? null;
}

// The slot the student app mounts for the phases above.
export function ExplainFlow({ store, voice, voiceControls, startNewRun }: ExplainFlowProps) {
  const { run, events, status } = useRunEvents(store);
  // Commands this flow sent that have no answer yet; while the connection is down they are the
  // work whose save cannot be confirmed.
  const [unansweredSends, setUnansweredSends] = useState(0);
  const sendThroughQueue = useMemo(() => learningCommandSender(store), [store]);
  const send: SendLearningCommand = useCallback(
    async (command, commandId) => {
      setUnansweredSends((count) => count + 1);
      try {
        await sendThroughQueue(command, commandId);
      } finally {
        setUnansweredSends((count) => count - 1);
      }
    },
    [sendThroughQueue],
  );
  // A correction replaced the activity: what the tutor was saying about it is stale, so it stops now.
  const isUpdating = run !== null && run.phase === 'PROCESSING' && isCorrectionPending(run, events);
  useEffect(() => {
    if (isUpdating) voiceControls.interruptPlayback();
  }, [isUpdating, voiceControls]);
  if (!run) return null;
  const connection = status === 'reconnecting' ? 'paused' : 'live';
  const canSend = connection === 'live' && !run.stopped;
  const problem = run.activity?.problem ?? run.selectedProblems?.initial ?? null;
  const voiceProps = { voice, voiceControls, send, canSend };
  const explanation = (attempt: SavedAttempt | null, question: (answer: number) => string, askFirstNumber: boolean, intro: string | null) =>
    problem && attempt ? (
      <Explanation question={question(attempt.attempt.answer)} problem={problem} answer={attempt.attempt.answer} askFirstNumber={askFirstNumber} intro={intro} {...voiceProps} />
    ) : null;

  const screen = (): ReactNode => {
    if (run.stopped || run.phase === 'COMPLETE' || run.phase === 'ERROR' || (run.phase === 'NEEDS_SUPPORT' && !run.continuationAllowed)) {
      return <Outcome view={outcomeView(run, events)} startNewRun={startNewRun} />;
    }
    switch (run.phase) {
      case 'EXPLAIN':
        return explanation(lastAttempt(run, 'initial'), STUDENT_COPY.howDidYouGet, false, null);
      case 'NEEDS_SUPPORT':
        // A failed support activity allows the ordinary explanation flow once.
        return explanation(lastAttempt(run), STUDENT_COPY.howDidYouGet, false, OUTCOME_COPY.notSuccessful);
      case 'CLARIFY': {
        const activity = run.activity;
        if (activity?.kind !== 'clarification') return null;
        return explanation(lastAttempt(run), () => activity.title, activity.templateId === 'clarify_first_number', null);
      }
      case 'PROCESSING': {
        const attempt = lastAttempt(run);
        if (!problem || !attempt) return null;
        // A typed correction silences the tutor before it is sent.
        const sendCorrection: SendLearningCommand = (command, commandId) => {
          voiceControls.interruptPlayback();
          return send(command, commandId);
        };
        return <Thinking isUpdating={isUpdating} problem={problem} answer={attempt.attempt.answer} {...voiceProps} send={sendCorrection} />;
      }
      default:
        return null;
    }
  };

  return (
    <>
      {connection === 'paused' && <ConnectionNotice saveUnconfirmed={unansweredSends > 0} />}
      {screen()}
    </>
  );
}
