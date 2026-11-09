import { useId, useRef, useState, type ReactNode } from 'react';
import { EXPLAIN_COPY, OUTCOME_COPY, STUDENT_COPY } from '@core/copy';
import type { Assessment, Outcome as OutcomeValue } from '@core/domain';
import type { RunEvent, RunEventOf, RunSnapshot } from '@core/events';
import { Mascot } from './Mascot';
import '../styles/explain.css';

// After a failed support activity the run may continue once; a second failure ends the run with a
// pointer to a trusted adult instead of another try.
const SUPPORT_FAILURES_BEFORE_ADULT_HELP = 2;

// What the end of a run can honestly say. Each view is read from committed backend state; none is
// inferred from a screen, a timer or an answer the child typed.
export type OutcomeView =
  | { readonly kind: 'complete' }
  | { readonly kind: 'assisted' }
  | { readonly kind: 'answer_right_steps_missing' }
  | { readonly kind: 'not_successful' }
  | { readonly kind: 'support_limit'; readonly askTrustedAdult: boolean }
  | { readonly kind: 'checking' }
  | { readonly kind: 'runtime_error' }
  | { readonly kind: 'stopped' };

// Resolves once the new run exists (the caller then opens it); rejects when it could not be created.
export type StartNewRun = () => Promise<void>;

function lastCommittedOutcome(run: RunSnapshot, events: readonly RunEvent[]): RunEventOf<'outcome.committed'>['payload'] | null {
  const committed = [...run.execution.events, ...events].filter((event): event is RunEventOf<'outcome.committed'> => event.type === 'outcome.committed');
  return committed.at(-1)?.payload ?? null;
}

function lastIndependentAssessment(run: RunSnapshot): Assessment | null {
  return run.attempts.filter((saved) => saved.criterion === 'independent').at(-1)?.assessment ?? null;
}

function assessedView(outcome: OutcomeValue, assessment: Assessment | null): OutcomeView {
  if (outcome === 'assisted') return { kind: 'assisted' };
  // A right number without the observed steps is incomplete evidence, never a pass.
  if (assessment?.answerCorrect && !assessment.processCorrect) return { kind: 'answer_right_steps_missing' };
  if (outcome === 'failed') return { kind: 'not_successful' };
  if (outcome === 'not_assessed') return { kind: 'support_limit', askTrustedAdult: false };
  // An independent outcome cannot end in NEEDS_SUPPORT; claim nothing until the state agrees.
  return { kind: 'checking' };
}

// `events` are the ones polled after the snapshot; the snapshot's own execution events are read too.
export function outcomeView(run: RunSnapshot, events: readonly RunEvent[]): OutcomeView {
  if (run.stopped) return { kind: 'stopped' };
  if (run.phase === 'ERROR') return { kind: 'runtime_error' };
  const committed = lastCommittedOutcome(run, events);
  // Success needs the saved independent outcome itself, not only a phase that says COMPLETE.
  if (run.phase === 'COMPLETE') return committed?.outcome === 'independent' && committed.saved ? { kind: 'complete' } : { kind: 'checking' };
  if (run.phase !== 'NEEDS_SUPPORT') return { kind: 'checking' };
  if (committed) return assessedView(committed.outcome, lastIndependentAssessment(run));
  const failedSupports = run.attempts.filter((saved) => saved.criterion === 'support' && saved.assessment?.passed === false).length;
  return { kind: 'support_limit', askTrustedAdult: failedSupports >= SUPPORT_FAILURES_BEFORE_ADULT_HELP };
}

export function StartNewRunButton({ startNewRun }: { startNewRun: StartNewRun }) {
  const [state, setState] = useState<'idle' | 'starting' | 'failed'>('idle');
  const inFlight = useRef(false);
  const start = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setState('starting');
    try {
      // Stays disabled after success: the new run replaces this screen, and a second press must not
      // create another run.
      await startNewRun();
    } catch {
      inFlight.current = false;
      setState('failed');
    }
  };
  return (
    <>
      <button className="p-button" type="button" disabled={state === 'starting'} aria-busy={state === 'starting'} onClick={start}>
        {STUDENT_COPY.startNewRun}
      </button>
      {state === 'failed' && (
        <p className="p-helper" data-tone="error" role="alert">
          {EXPLAIN_COPY.startNewRunFailed}
        </p>
      )}
    </>
  );
}

// Shown where a correction would go once the explanation can no longer change this run.
export function CorrectionClosed({ startNewRun }: { startNewRun: StartNewRun }) {
  return (
    <div className="ex ex-correction-closed">
      <p className="ex-quiet">{EXPLAIN_COPY.correctionClosed}</p>
      <StartNewRunButton startNewRun={startNewRun} />
    </div>
  );
}

// The run's connection, not voice. Committed work stays on screen; new submissions wait for the
// reconnect, and an unacknowledged save is never called saved.
export function ConnectionNotice({ saveUnconfirmed }: { saveUnconfirmed: boolean }) {
  return (
    <div className="ex ex-connection p-status" role="status">
      {saveUnconfirmed ? STUDENT_COPY.checkingSave : STUDENT_COPY.disconnected}
    </div>
  );
}

// A notification tap whose activity cannot be opened, whether the server does not know it (404) or
// the run has moved past it (409). Neither case changes earlier work, and neither claims it was done.
export function ActivityUnavailable() {
  return <OutcomeScreen title={STUDENT_COPY.activityOpenFailed} />;
}

function OutcomeScreen({ title, body, tone, children }: { title: string; body?: string; tone?: 'success'; children?: ReactNode }) {
  const headingId = useId();
  return (
    <section className="ex ex-outcome" aria-labelledby={headingId} data-tone={tone}>
      <div className="p-card ex-outcome-card" aria-live="polite">
        <Mascot state="encouragement" size={160} />
        <h1 id={headingId} className="ex-title">
          {title}
        </h1>
        {body && <p className="ex-body">{body}</p>}
      </div>
      {children && <div className="ex-actions">{children}</div>}
    </section>
  );
}

export type OutcomeProps = { view: OutcomeView; startNewRun: StartNewRun };

export function Outcome({ view, startNewRun }: OutcomeProps) {
  // Done and Pause only change this screen: they send no command and create no record.
  const [closedAs, setClosedAs] = useState<'done' | 'paused' | null>(null);
  if (closedAs === 'done') return <OutcomeScreen title={STUDENT_COPY.doneCollapsed} />;
  if (closedAs === 'paused') return <OutcomeScreen title={EXPLAIN_COPY.pausedTitle} body={EXPLAIN_COPY.pausedBody} />;
  const done = (
    <button className="p-button" type="button" onClick={() => setClosedAs('done')}>
      {EXPLAIN_COPY.done}
    </button>
  );
  switch (view.kind) {
    case 'complete':
      return (
        <OutcomeScreen title={OUTCOME_COPY.completeTitle} body={OUTCOME_COPY.completeBody} tone="success">
          {done}
        </OutcomeScreen>
      );
    case 'assisted':
      return (
        <OutcomeScreen title={EXPLAIN_COPY.assistedTitle} body={EXPLAIN_COPY.assistedBody}>
          {done}
        </OutcomeScreen>
      );
    case 'answer_right_steps_missing':
      return <OutcomeScreen title={OUTCOME_COPY.answerRightStepsMissing}>{done}</OutcomeScreen>;
    case 'not_successful':
      return <OutcomeScreen title={OUTCOME_COPY.notSuccessful}>{done}</OutcomeScreen>;
    case 'support_limit':
      return (
        <OutcomeScreen title={OUTCOME_COPY.supportLimit} body={view.askTrustedAdult ? EXPLAIN_COPY.askTrustedAdult : undefined}>
          {done}
        </OutcomeScreen>
      );
    case 'checking':
      return <OutcomeScreen title={STUDENT_COPY.checkingSave} />;
    case 'runtime_error':
      return (
        <OutcomeScreen title={STUDENT_COPY.runtimeError}>
          <StartNewRunButton startNewRun={startNewRun} />
          <button className="p-button" data-variant="secondary" type="button" onClick={() => setClosedAs('paused')}>
            {STUDENT_COPY.pause}
          </button>
        </OutcomeScreen>
      );
    case 'stopped':
      return (
        <OutcomeScreen title={EXPLAIN_COPY.stoppedTitle} body={EXPLAIN_COPY.stoppedBody}>
          <StartNewRunButton startNewRun={startNewRun} />
        </OutcomeScreen>
      );
  }
}
