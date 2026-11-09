import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STUDENT_COPY, VOICE_STATUS_COPY } from '@core/copy';
import type { Activity, Command } from '@core/domain';
import type { RunEvent, RunSnapshot } from '@core/events';
import { HTTP_STATUS, NotificationOpenedInputSchema, ROUTES, routePath } from '@core/routes';
import { createEventStore, EVENT_POLL_INTERVAL_MS, type EventStore, RunRequestError, useRunEvents } from '../lib/event-store';
import { DeferredInvitation, Invitation } from './Invitation';
import { Mascot } from './Mascot';
import '../styles/student.css';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// A learning command as a screen states it; StudentApp adds the command ID and the current revision.
export type StudentCommandInput = DistributiveOmit<Command, 'commandId' | 'revision'>;
// `conflict`: the run moved on (409); the snapshot was reloaded and the command was not resent.
export type SubmitResult = 'saved' | 'conflict' | 'failed';
// Why a notification's activity cannot open: the server does not know it (404), or it is no longer
// current, for example already completed or superseded (409).
export type UnavailableReason = 'not_found' | 'conflict';

// What a mounted student screen receives. Every field comes from the run's shared store.
export type StudentSlot = {
  readonly run: RunSnapshot;
  readonly events: readonly RunEvent[];
  // `paused` while the server is unreachable: screens disable every submission until it is back.
  readonly connection: 'live' | 'paused';
  // A submission got no answer; its effect is unknown until the next snapshot.
  readonly saveUnconfirmed: boolean;
  // True only once the server acknowledged that microphone and playback were torn down.
  readonly voiceOff: boolean;
  readonly submit: (command: StudentCommandInput) => Promise<SubmitResult>;
};

export type StudentAppProps = {
  readonly runId: string | null;
  // Mounted for every phase after the invitation (and for a stopped run).
  readonly activity?: (slot: StudentSlot) => ReactNode;
  // Shown when a notification's activity cannot open.
  readonly unavailable?: (reason: UnavailableReason) => ReactNode;
  // A store bound to other responses, for stories; the app creates one per run.
  readonly store?: EventStore;
};

export function StudentApp({ runId, activity, unavailable, store }: StudentAppProps) {
  if (store) return <StudentRun store={store} runId={runId} activity={activity} unavailable={unavailable} />;
  if (!runId) return <RunUnavailable />;
  return <StudentRunForId runId={runId} activity={activity} unavailable={unavailable} />;
}

function StudentRunForId({ runId, ...rest }: Omit<StudentAppProps, 'store'> & { runId: string }) {
  const store = useMemo(() => createEventStore(runId), [runId]);
  return <StudentRun store={store} runId={runId} {...rest} />;
}

function StudentFrame({ children, isBusy = false }: { children: ReactNode; isBusy?: boolean }) {
  return (
    <div className="student-app">
      <header className="student-header">
        <span className="student-wordmark">{STUDENT_COPY.wordmark}</span>
      </header>
      <main className="student-workspace" aria-busy={isBusy}>
        {children}
      </main>
    </div>
  );
}

function RunUnavailable() {
  return (
    <StudentFrame>
      <section className="student-card student-message">
        <Mascot state="idle" size={120} />
        <h1 className="student-tutor">{STUDENT_COPY.runUnavailable}</h1>
      </section>
    </StudentFrame>
  );
}

type StudentRunProps = Omit<StudentAppProps, 'store' | 'runId'> & { store: EventStore; runId: string | null };

function StudentRun({ store, runId, activity, unavailable }: StudentRunProps) {
  const view = useRunEvents(store);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);

  const { submit, isPending, saveUnconfirmed } = useRunSubmit(store);
  const openedUnavailable = useNotificationOpened(store, runId);
  const run = view.run;
  const connection = view.status === 'live' || view.status === 'loading' ? 'live' : 'paused';
  const voiceOff = useAudioGateClosed(runId, run?.phase === 'VERIFY');

  if (openedUnavailable) return <StudentFrame>{unavailable ? unavailable(openedUnavailable) : <RunUnavailableCard />}</StudentFrame>;
  if (!run) {
    if (view.status === 'failed') return <RunUnavailable />;
    return (
      <StudentFrame isBusy>
        <section className="student-card student-message">
          <Mascot state="thinking" size={120} />
          <h1 className="student-tutor">{STUDENT_COPY.loading}</h1>
        </section>
        <ConnectionStatus connection={connection} saveUnconfirmed={false} />
      </StudentFrame>
    );
  }

  const slot: StudentSlot = { run, events: view.events, connection, saveUnconfirmed, voiceOff, submit };
  return (
    <StudentFrame>
      <RunScreen slot={slot} isPending={isPending} activity={activity} />
      <ConnectionStatus connection={connection} saveUnconfirmed={saveUnconfirmed} />
    </StudentFrame>
  );
}

function RunScreen({ slot, isPending, activity }: { slot: StudentSlot; isPending: boolean; activity: StudentAppProps['activity'] }) {
  const { run } = slot;
  const [deferredId, setDeferredId] = useState<string | null>(null);

  if (run.stopped) return <>{activity?.(slot)}</>;
  switch (run.phase) {
    case 'WAITING':
    case 'NO_MATCH':
      return <Waiting />;
    case 'INGESTING':
      return <Waiting isPreparing />;
    case 'INVITED': {
      const { invitation } = run;
      // No invitation is shown until one was committed.
      if (!invitation) return <Waiting />;
      const key = activityKey(invitation);
      if (deferredId === key) return <DeferredInvitation onReturn={() => setDeferredId(null)} />;
      return (
        <Invitation
          invitation={invitation}
          isBusy={isPending}
          isDisabled={slot.connection === 'paused'}
          onAccept={() => void slot.submit({ type: 'accept' })}
          onLater={() => setDeferredId(key)}
        />
      );
    }
    case 'VERIFY':
      return <IndependentGate slot={slot} activity={activity} />;
    default:
      return <>{activity?.(slot)}</>;
  }
}

const activityKey = (activity: Activity) => `${activity.id}:${activity.revision}`;

function Waiting({ isPreparing = false }: { isPreparing?: boolean }) {
  return (
    <section className="student-card student-message">
      <Mascot state={isPreparing ? 'thinking' : 'idle'} size={120} />
      <div>
        <h1 className="student-tutor">{STUDENT_COPY.waitingTitle}</h1>
        <p className="student-secondary">{STUDENT_COPY.waitingBody}</p>
        {isPreparing && (
          <p className="student-secondary" role="status">
            {STUDENT_COPY.preparing}
          </p>
        )}
      </div>
    </section>
  );
}

// The independent check starts only after the server acknowledged that voice is off, so no help
// can reach the child during it.
function IndependentGate({ slot, activity }: { slot: StudentSlot; activity: StudentAppProps['activity'] }) {
  const [startedKey, setStartedKey] = useState<string | null>(null);
  const current = slot.run.activity;
  const key = current ? activityKey(current) : null;
  if (key !== null && startedKey === key) return <>{activity?.(slot)}</>;
  return (
    <section className="student-card student-message">
      <div>
        {current && <h1 className="student-tutor">{current.title}</h1>}
        {slot.voiceOff && <p className="student-secondary">{VOICE_STATUS_COPY.off}</p>}
        <div className="student-actions">
          <button type="button" className="p-button student-primary" disabled={!slot.voiceOff || key === null || slot.connection === 'paused'} onClick={() => setStartedKey(key)}>
            {STUDENT_COPY.startProblem}
          </button>
        </div>
      </div>
    </section>
  );
}

function RunUnavailableCard() {
  return (
    <section className="student-card student-message">
      <h1 className="student-tutor">{STUDENT_COPY.runUnavailable}</h1>
    </section>
  );
}

// Context belongs below the card it describes, not in a toast that disappears before it is read.
function ConnectionStatus({ connection, saveUnconfirmed }: { connection: StudentSlot['connection']; saveUnconfirmed: boolean }) {
  const message = saveUnconfirmed ? STUDENT_COPY.checkingSave : connection === 'paused' ? STUDENT_COPY.disconnected : null;
  return (
    <p className="student-connection" role="status">
      {message}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// Commands, the notification tap and the voice gate.

function useRunSubmit(store: EventStore) {
  const [isPending, setPending] = useState(false);
  const [saveUnconfirmed, setSaveUnconfirmed] = useState(false);
  // A command that got no answer. Sending it again unchanged lets the server return its receipt
  // instead of applying a second, different command.
  const unanswered = useRef<{ input: string; command: Command } | null>(null);

  const submit = useCallback(
    async (input: StudentCommandInput): Promise<SubmitResult> => {
      const inputKey = JSON.stringify(input);
      // Assigned when the request is actually built, with the revision current at that moment.
      const attempt: { sent: Command | null } = { sent: null };
      setPending(true);
      try {
        await store.sendRunCommand('runCommand', (run) => {
          const previous = unanswered.current;
          attempt.sent = previous && previous.input === inputKey && previous.command.revision === run.revision ? previous.command : { ...input, commandId: crypto.randomUUID(), revision: run.revision };
          return attempt.sent;
        });
        unanswered.current = null;
        setSaveUnconfirmed(false);
        return 'saved';
      } catch (error) {
        if (error instanceof RunRequestError) {
          unanswered.current = null;
          setSaveUnconfirmed(false);
          return error.status === HTTP_STATUS.conflict ? 'conflict' : 'failed';
        }
        unanswered.current = attempt.sent ? { input: inputKey, command: attempt.sent } : null;
        setSaveUnconfirmed(attempt.sent !== null);
        return 'failed';
      } finally {
        setPending(false);
      }
    },
    [store],
  );
  return { submit, isPending, saveUnconfirmed };
}

const NOTIFICATION_PARAMS = ['activityId', 'activityRevision', 'notificationId'] as const;

// A notification tap opens /student?runId=…&activityId=…&activityRevision=…&notificationId=…. The page
// reports the tap once; opening is not consent, so the invitation still waits for Let's try.
function useNotificationOpened(store: EventStore, runId: string | null): UnavailableReason | null {
  const [reason, setReason] = useState<UnavailableReason | null>(null);
  const handled = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const notificationId = params.get('notificationId');
    if (!runId || !notificationId || handled.current === notificationId) return;
    handled.current = notificationId;
    // A refresh is not a second tap, so the tap parameters leave the address once read.
    const url = new URL(window.location.href);
    for (const name of NOTIFICATION_PARAMS) url.searchParams.delete(name);
    window.history.replaceState(window.history.state, '', url);

    const opened = NotificationOpenedInputSchema.safeParse({
      commandId: crypto.randomUUID(),
      activityId: params.get('activityId'),
      activityRevision: Number(params.get('activityRevision')),
    });
    if (!opened.success) return setReason('not_found');
    store.sendRunCommand('notificationOpened', () => opened.data, { notificationId }).catch((error: unknown) => {
      if (error instanceof RunRequestError && error.status === HTTP_STATUS.notFound) return setReason('not_found');
      if (error instanceof RunRequestError && error.status === HTTP_STATUS.conflict) return setReason('conflict');
      // Unreachable server: the run screen shows the paused state and the invitation stays usable.
    });
  }, [store, runId]);
  return reason;
}

function useAudioGateClosed(runId: string | null, isActive: boolean): boolean {
  const [isClosed, setClosed] = useState(false);
  useEffect(() => {
    if (!runId || !isActive) return;
    let isCurrent = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const response = await fetch(routePath('voiceSnapshot', { runId }), { headers: { accept: 'application/json' }, cache: 'no-store' });
        const voice = response.ok ? ROUTES.voiceSnapshot.response.safeParse(await response.json()) : null;
        if (voice?.success && voice.data.audioGate === 'closed') return isCurrent && setClosed(true);
      } catch {
        // Unreachable: the gate stays closed and the next check retries.
      }
      if (isCurrent) timer = setTimeout(() => void check(), EVENT_POLL_INTERVAL_MS);
    };
    void check();
    return () => {
      isCurrent = false;
      clearTimeout(timer);
    };
  }, [runId, isActive]);
  return isActive && isClosed;
}

