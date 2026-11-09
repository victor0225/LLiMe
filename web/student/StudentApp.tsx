import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STUDENT_COPY, VOICE_STATUS_COPY } from '@core/copy';
import { type Activity, type Command, RunCreateInputSchema, type TemplateId } from '@core/domain';
import type { RunEvent, RunSnapshot } from '@core/events';
import { BootstrapSchema, HTTP_STATUS, NotificationOpenedInputSchema, ROUTES, routePath, SESSION_HEADER } from '@core/routes';
import { createEventStore, EVENT_POLL_INTERVAL_MS, type EventStore, RunRequestError, useRunEvents } from '../lib/event-store';
import { browserVoiceEnv, createCorrectionPlayback, createVoiceClient, eventStoreVoiceApi, useVoice, type VoiceClient, type VoiceView } from '../voice';
import { ActivityView, type NumberLineSlot } from '../activity/ActivityView';
import { ExplainFlow, isExplainFlowRun, VoiceStatus } from './Explanation';
import { DeferredInvitation, Invitation } from './Invitation';
import { Mascot } from './Mascot';
import { ActivityUnavailable } from './Outcome';
import { Practice } from './Practice';
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
  // Mounted for every phase after the invitation (and for a stopped run). Without it the app composes
  // its own screens; stories pass one to show a single screen.
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
      <RunUnavailableCard />
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

  const { submit, isPending, unansweredRevision } = useRunSubmit(store);
  const openedUnavailable = useNotificationOpened(store, runId);
  const run = view.run;
  // Once the run moves past the revision the unanswered command targeted, its outcome is known.
  const saveUnconfirmed = unansweredRevision !== null && run?.revision === unansweredRevision;
  const connection = view.status === 'live' || view.status === 'loading' ? 'live' : 'paused';
  const voiceOff = useAudioGateClosed(runId, run?.phase === 'VERIFY');
  const voice = useRunVoice(store, runId, run);

  if (openedUnavailable) return <StudentFrame>{unavailable ? unavailable(openedUnavailable) : <ActivityUnavailable />}</StudentFrame>;
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
      <RunScreen slot={slot} isPending={isPending} activity={activity ?? ((current) => <ComposedActivity slot={current} store={store} voice={voice} />)} />
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
      // The generated make-ten check carries its own Start, gated on voice teardown.
      if (run.activity && MAKE_TEN_TEMPLATES.has(run.activity.templateId)) return <>{activity?.(slot)}</>;
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
      <Mascot state="idle" size={120} />
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
// The screen for each phase after the invitation.

// Number-line activities, whether app-owned (initial, retry) or generated (anchored support,
// independent check); the make-ten templates mount the generated workspace instead.
const NUMBER_LINE_TEMPLATES: ReadonlySet<TemplateId> = new Set(['initial_number_line', 'anchor_start_number_line', 'manipulation_retry', 'independent_number_line']);
const MAKE_TEN_TEMPLATES: ReadonlySet<TemplateId> = new Set(['make_ten_blocks', 'independent_make_ten']);

// `view` is null when this server offers no voice; the client still exists to tear audio down.
type RunVoice = { view: VoiceView | null; client: VoiceClient; controls: VoiceControlsForRun; independentStart: 'waiting' | 'ready' };
type VoiceControlsForRun = Pick<VoiceClient, 'start' | 'toggleMute' | 'end' | 'interruptPlayback'>;

// Make-ten specs never contain a number line, so this slot is never mounted by them.
const NO_NUMBER_LINE: NumberLineSlot = () => <p className="p-status" data-tone="error" role="alert">{STUDENT_COPY.activityOpenFailed}</p>;

function ComposedActivity({ slot, store, voice }: { slot: StudentSlot; store: EventStore; voice: RunVoice | null }) {
  const { run } = slot;
  const shownVoice = voice?.view ?? null;
  const controls = voice?.controls ?? SILENT_VOICE;
  if (isExplainFlowRun(run)) return <ExplainFlow store={store} voice={shownVoice} voiceControls={controls} startNewRun={startNewRun} />;
  const activity = run.activity;
  if (activity === null) return null;
  // During support the tutor may still be talking, so the child keeps Mute and End voice; voice is
  // offered fresh only at the explanation step.
  const voiceRow = shownVoice !== null && run.phase === 'PRACTICE' && shownVoice.phase !== 'idle' && <VoiceStatus voice={shownVoice} controls={controls} offerStart={false} />;
  if (MAKE_TEN_TEMPLATES.has(activity.templateId)) {
    const commandType = run.phase === 'VERIFY' ? 'verify' : 'practice';
    return (
      <>
        {voiceRow}
        <ActivityView
          activity={activity}
          store={store}
          voiceSessionId={shownVoice?.voiceSessionId ?? null}
          numberLine={NO_NUMBER_LINE}
          independentStart={voice?.independentStart ?? 'ready'}
          onSubmit={(_target, attempt) => void slot.submit({ type: commandType, attempt })}
        />
      </>
    );
  }
  if (!NUMBER_LINE_TEMPLATES.has(activity.templateId)) return null;
  return (
    <>
      {voiceRow}
      <Practice activity={activity} phase={run.phase} voiceOff={slot.voiceOff} submit={slot.submit} />
    </>
  );
}

// Controls for a run without voice; no voice control is shown then, so none is ever pressed.
const SILENT_VOICE = { start: async () => {}, toggleMute: () => {}, end: async () => {}, interruptPlayback: () => {} };

// Creates a run and returns its ID; the caller decides whether to open it.
export async function createRun(): Promise<string> {
  const bootstrap = await fetch(routePath('bootstrap'), { headers: { accept: 'application/json' } });
  if (!bootstrap.ok) throw new Error(`The app could not be reached (HTTP ${bootstrap.status})`);
  const { nonce } = BootstrapSchema.parse(await bootstrap.json());
  const response = await fetch(routePath('createRun'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', [SESSION_HEADER]: nonce },
    body: JSON.stringify(RunCreateInputSchema.parse({})),
  });
  if (response.status !== ROUTES.createRun.status) throw new Error(`The run was not created (HTTP ${response.status})`);
  return ROUTES.createRun.response.parse(await response.json()).id;
}

async function startNewRun(): Promise<void> {
  const runId = await createRun();
  window.location.assign(`${window.location.pathname}?runId=${encodeURIComponent(runId)}`);
}

// One voice client per run, offered only when this server has voice configured for live input. The
// client always exists so that teardown before the independent check also covers a session that
// is no longer shown.
function useRunVoice(store: EventStore, runId: string | null, run: RunSnapshot | null): RunVoice | null {
  const [isOffered, setOffered] = useState(false);
  useEffect(() => {
    let isCurrent = true;
    fetch(routePath('bootstrap'), { headers: { accept: 'application/json' } })
      .then(async (response) => BootstrapSchema.safeParse(response.ok ? await response.json() : null))
      .then((bootstrap) => isCurrent && setOffered(bootstrap.success && bootstrap.data.voice === 'configured_unverified' && bootstrap.data.inputMode === 'live'))
      // Unreachable: typing stays available and voice is simply not offered.
      .catch(() => isCurrent && setOffered(false));
    return () => {
      isCurrent = false;
    };
  }, []);
  const client = useMemo(() => createVoiceClient({ env: browserVoiceEnv(), api: eventStoreVoiceApi(store, runId ?? '') }), [store, runId]);
  // Leaving the run releases the microphone and closes the session.
  useEffect(() => () => void client.end(), [client]);
  const view = useVoice(client);
  const isIndependent = run?.phase === 'VERIFY';
  const independentStart = useIndependentTeardown(client, view, isIndependent);
  const controls = useCorrectionPlayback(client, run);
  if (runId === null) return null;
  return { view: isOffered ? view : null, client, controls, independentStart };
}

// A correction makes what the tutor was saying stale: playback stops at once and resumes only when
// the replacement for the newest correction is on screen.
function useCorrectionPlayback(client: VoiceClient, run: RunSnapshot | null): VoiceControlsForRun {
  const playback = useMemo(() => createCorrectionPlayback(client), [client]);
  const revision = run?.explanationRevision ?? 0;
  const latestRevision = useRef(revision);
  latestRevision.current = revision;
  const superseded = run !== null && [...run.execution.events].some((event) => event.type === 'operation.cancelled' && event.payload.reason === 'superseded' && event.payload.cancellationEpoch === run.cancellationEpoch);
  useEffect(() => {
    if (superseded) playback.correctionStarted(revision);
  }, [playback, superseded, revision]);
  const shownActivity = run?.activity && (run.phase === 'PRACTICE' || run.phase === 'CLARIFY') ? `${run.activity.id}:${run.activity.revision}` : null;
  useEffect(() => {
    if (shownActivity !== null) playback.replacementRendered(revision);
  }, [playback, shownActivity, revision]);
  return useMemo(
    () => ({
      start: client.start,
      toggleMute: client.toggleMute,
      end: client.end,
      // A typed correction becomes the next explanation revision.
      interruptPlayback: () => playback.correctionStarted(latestRevision.current + 1),
    }),
    [client, playback],
  );
}

// The tutor's handover may still be playing when the independent check arrives. Once its transcript
// has stopped growing for a moment, or at the latest after the cap, microphone and playback are torn
// down and the server records it. The check's Start waits for that record; with no audio it is ready.
const HANDOVER_SETTLE_MS = 1500;
const HANDOVER_CAP_MS = 8000;

function useIndependentTeardown(client: VoiceClient, view: VoiceView, isIndependent: boolean): 'waiting' | 'ready' {
  const since = useRef<number | null>(null);
  const [teardown, setTeardown] = useState<'none' | 'running' | 'done' | 'failed'>('none');
  const hasAudio = view.phase === 'starting' || view.phase === 'connecting' || view.phase === 'live' || view.phase === 'ending';
  useEffect(() => {
    if (isIndependent) return;
    since.current = null;
    setTeardown('none');
  }, [isIndependent]);
  useEffect(() => {
    if (!isIndependent || !hasAudio || teardown !== 'none') return;
    since.current ??= Date.now();
    const remaining = HANDOVER_CAP_MS - (Date.now() - since.current);
    const timer = setTimeout(() => {
      setTeardown('running');
      client.teardownForIndependentWork().then(
        () => setTeardown('done'),
        // Without the server's record the check stays closed rather than risking spoken help.
        () => setTeardown('failed'),
      );
    }, Math.max(0, Math.min(HANDOVER_SETTLE_MS, remaining)));
    return () => clearTimeout(timer);
  }, [client, isIndependent, hasAudio, teardown, view.captions.output]);
  if (!isIndependent) return 'waiting';
  return teardown === 'done' || (teardown === 'none' && !hasAudio) ? 'ready' : 'waiting';
}

// ---------------------------------------------------------------------------------------------
// Commands, the notification tap and the voice gate.

function useRunSubmit(store: EventStore) {
  const [isPending, setPending] = useState(false);
  const [unansweredRevision, setUnansweredRevision] = useState<number | null>(null);
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
        setUnansweredRevision(null);
        return 'saved';
      } catch (error) {
        if (error instanceof RunRequestError) {
          unanswered.current = null;
          setUnansweredRevision(null);
          return error.status === HTTP_STATUS.conflict ? 'conflict' : 'failed';
        }
        unanswered.current = attempt.sent ? { input: inputKey, command: attempt.sent } : null;
        setUnansweredRevision(attempt.sent?.revision ?? null);
        return 'failed';
      } finally {
        setPending(false);
      }
    },
    [store],
  );
  return { submit, isPending, unansweredRevision };
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

