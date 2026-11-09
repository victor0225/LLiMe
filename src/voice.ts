// Server side of the voice transport: one GPT-Live session per run over WebRTC, created here so the
// provider credential never reaches the browser, plus the sideband observer attached to the same
// session. Audio stays gated until the sideband is attached and the session reports it started.
// The provider key lives only in this module's closure; the browser sees a session ID and an SDP answer.
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SPOKEN_COPY } from './copy.js';
import { type Activity, ExplanationTextSchema, type RunState, type TemplateId, type VoiceOperation, VoiceOperationSchema } from './domain.js';
import type { Engine } from './engine.js';
import {
  ERROR_HTTP_STATUS,
  type ActivityRenderedCommand,
  type HttpErrorCode,
  HTTP_STATUS,
  SDP_MAX_BYTES,
  utf8ByteLength,
  VoiceSessionInputSchema,
  type VoiceCommand,
  type VoiceSessionOutputSchema,
  type VoiceSessionStatus,
  type VoiceSnapshot,
} from './routes.js';
import { RouteError, type RouteHandler } from './server.js';
import { DomainError, type NewEvent, type RunRecord, type Store, type VoiceOperationChange } from './store.js';

export const LIVE_MODEL = 'gpt-live-1';
export const LIVE_SESSIONS_URL = 'https://api.openai.com/v1/live/sessions';
const SIDEBAND_URL = (sessionId: string) => `wss://api.openai.com/v1/live/sessions/${sessionId}/attach`;

// llime limits, not provider guarantees.
export const CREATE_TIMEOUT_MS = 15_000;
// From the SDP answer until the sideband is attached and session.started was observed.
export const READY_TIMEOUT_MS = 15_000;
// The documented wait for session.closed after session.close.
export const CLOSE_TIMEOUT_MS = 15_000;
export const SESSION_LIMIT_MS = 180_000;
export const ACK_TIMEOUT_MS = 10_000;
export const CAPTION_MAX_CHARS = 4_000;
export const FRAGMENT_MAX_COUNT = 2_000;
// The provider accepts 500 tokens per appended context; this is a conservative character bound.
export const APPEND_MAX_CHARS = 1_500;

const SESSION_ID_PATTERN = /^[\w-]{1,200}$/;
const SAFE_TOKEN = /^[\w.:-]{1,120}$/;

// Instructions guide behavior; they do not guarantee it (the capture is checked for leaked hints).
const INSTRUCTIONS = [
  'Speak English to a young child. Keep every turn to one short sentence or question.',
  'Delegate all reasoning to the application and wait for its approved updates before speaking about any activity or result.',
  'Ask one short question at a time. Do not infer why an answer is wrong before the child explains.',
  'Never say the correct answer, never hint at it and never say whether an answer is right or wrong.',
  'Do not praise or announce that the child has learned something. Never claim to have searched for anything before the application reports a result.',
  'Say nothing during an independent check.',
].join(' ');

function sessionConfig() {
  return {
    model: LIVE_MODEL,
    store: false,
    delegation: { type: 'client' },
    instructions: INSTRUCTIONS,
    // The browser may only ask to close; it receives status, captions and delegation metadata.
    // The trusted sideband is not limited by this list.
    client: {
      data_channel: {
        allowed_client_events: ['session.close'],
        allowed_server_events: ['session.started', 'session.closed', 'session.input_transcript.delta', 'session.output_transcript.delta', 'session.delegation.created', 'error'].map((type) => ({ type })),
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Provider events. Parsed by exact type; only allowlisted fields survive, so credentials, SDP,
// account data and raw audio can never reach a log or a record.

const token = z.string().regex(SAFE_TOKEN);
const optionalToken = token.optional().catch(undefined);
const timestamp = z.number().int().min(0);
const transcript = { event_id: z.string().min(1).max(200), delta: z.string(), start_ms: timestamp, end_ms: timestamp };

const PROVIDER_EVENTS = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.started') }).transform(() => ({ type: 'session.started' as const })),
  z
    .object({ type: z.literal('session.closed'), reason: optionalToken, usage: z.object({ seconds: z.number().min(0) }).optional().catch(undefined) })
    .transform((e) => ({ type: 'session.closed' as const, reason: e.reason ?? null, usageSeconds: e.usage?.seconds ?? null })),
  z.object({ type: z.literal('session.usage.updated'), usage: z.object({ seconds: z.number().min(0) }) }).transform((e) => ({ type: 'session.usage.updated' as const, usageSeconds: e.usage.seconds })),
  z.object({ type: z.literal('session.input_transcript.delta'), ...transcript }).transform((e) => ({ type: e.type, eventId: e.event_id, delta: e.delta, startMs: e.start_ms, endMs: e.end_ms })),
  z.object({ type: z.literal('session.output_transcript.delta'), ...transcript }).transform((e) => ({ type: e.type, eventId: e.event_id, delta: e.delta, startMs: e.start_ms, endMs: e.end_ms })),
  z
    .object({ type: z.literal('session.delegation.created'), event_id: z.string().min(1).max(200), offset_ms: timestamp, delegation: z.object({ id: z.string().min(1).max(180), target: z.literal('client') }) })
    .transform((e) => ({ type: e.type, eventId: e.event_id, offsetMs: e.offset_ms, delegationId: e.delegation.id })),
  z
    .object({ type: z.enum(['session.commentary.appended', 'session.thinking.appended', 'session.instructions.appended']), client_event_id: z.string().min(1).max(200) })
    .transform((e) => ({ type: 'append.acknowledged' as const, clientEventId: e.client_event_id })),
  z
    .object({ type: z.literal('error'), error: z.object({ code: optionalToken, type: optionalToken, param: optionalToken, client_event_id: z.string().min(1).max(200).optional().catch(undefined) }) })
    .transform((e) => ({ type: 'error' as const, code: e.error.code ?? null, errorType: e.error.type ?? null, param: e.error.param ?? null, clientEventId: e.error.client_event_id ?? null })),
]);
export type ProviderEvent = z.output<typeof PROVIDER_EVENTS>;

// Returns null for anything that is not exactly one of the known events, including the reflected
// raw-audio events the sideband also receives.
export function parseProviderEvent(raw: unknown): ProviderEvent | null {
  const parsed = PROVIDER_EVENTS.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------------------------
// Transcript fragments.

export type Fragment = { eventId: string; stream: 'input' | 'output'; text: string; startMs: number; endMs: number };
export type LedgerResult = 'appended' | 'duplicate' | 'caption_limit' | 'fragment_limit';

// Fragments are appended exactly as received (spaces and repeats included), deduplicated by event
// ID, with the speaker streams kept apart. A bound is never enforced by truncating: the fragment that
// would cross it is refused and the caller closes voice.
export class TranscriptLedger {
  private readonly seen = new Set<string>();
  private readonly fragments: Record<Fragment['stream'], Fragment[]> = { input: [], output: [] };
  private readonly chars: Record<Fragment['stream'], number> = { input: 0, output: 0 };

  add(fragment: Fragment): LedgerResult {
    if (this.seen.has(fragment.eventId)) return 'duplicate';
    if (this.fragments.input.length + this.fragments.output.length >= FRAGMENT_MAX_COUNT) return 'fragment_limit';
    if (this.chars[fragment.stream] + fragment.text.length > CAPTION_MAX_CHARS) return 'caption_limit';
    this.seen.add(fragment.eventId);
    this.fragments[fragment.stream].push(fragment);
    this.chars[fragment.stream] += fragment.text.length;
    return 'appended';
  }

  stream(stream: Fragment['stream']): readonly Fragment[] {
    return [...this.fragments[stream]];
  }
}

// ---------------------------------------------------------------------------------------------
// Records.

// Builds a voice operation with all eight correlation IDs. A delegation requires a real Live
// session, so a record that would need an invented provider ID fails validation instead.
export function buildVoiceOperation(input: VoiceOperation): VoiceOperation {
  return VoiceOperationSchema.parse(input);
}

// ---------------------------------------------------------------------------------------------
// Service.

export type SidebandHandlers = { onOpen: () => void; onMessage: (text: string) => void; onClose: () => void };
export type SidebandLink = { send: (text: string) => void; close: () => void };
export type OpenSideband = (url: string, headers: { Authorization: string }, handlers: SidebandHandlers) => SidebandLink;

// The sideband is a server WebSocket with an Authorization header; Node's global WebSocket sends it.
export const openLiveSideband: OpenSideband = (url, headers, handlers) => {
  const socket = new WebSocket(url, { headers });
  let isClosed = false;
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', ({ data }) => {
    if (typeof data === 'string') handlers.onMessage(data);
  });
  socket.addEventListener('close', () => {
    if (isClosed) return;
    isClosed = true;
    handlers.onClose();
  });
  socket.addEventListener('error', () => {});
  return {
    send: (text) => socket.send(text),
    close: () => {
      isClosed = true;
      socket.close();
    },
  };
};

// The store functions voice needs. The real Store satisfies this; tests substitute a recorder.
export type VoiceRun = Omit<RunRecord, 'state'> & { state: Pick<RunState, 'explanationRevision' | 'cancellationEpoch' | 'activity'> };
export type VoiceStore = {
  getRun: (runId: string) => Promise<VoiceRun>;
  recordVoiceSessionOpened: (runId: string, voiceSessionId: string) => Promise<void>;
  recordAudioGateClosed: (runId: string, activityId: string, activityRevision: number, voiceSessionId: string | null) => Promise<void>;
  insertVoiceOperation: (operation: VoiceOperation) => Promise<VoiceOperation>;
  listVoiceOperations: (runId: string) => Promise<VoiceOperation[]>;
};

export type DelegationCreated = {
  runId: string;
  voiceSessionId: string;
  liveSessionId: string;
  delegationId: string;
  offsetMs: number;
  // Every input fragment observed so far, with its interval; the delegation window is computed from these.
  inputFragments: readonly Fragment[];
};
export type DelegationIncomplete = { runId: string; voiceSessionId: string; delegationId: string };
// A child's input fragment as it is first observed, after deduplication.
export type InputFragmentObserved = { runId: string; voiceSessionId: string; liveSessionId: string; fragment: Fragment };

// The hook the delegation work builds on. Both callbacks run synchronously inside event handling,
// so they must not throw and should hand work off.
export type VoiceHooks = {
  delegationCreated?: (event: DelegationCreated) => void;
  delegationIncomplete?: (event: DelegationIncomplete) => void;
  inputFragment?: (event: InputFragmentObserved) => void;
};

export type VoiceFailure = 'caption_limit' | 'fragment_limit' | 'sideband_lost' | 'not_ready' | 'persist_failed';
export type CloseResult = { finalization: 'complete' | 'incomplete' | 'not_open'; usageSeconds: number | null };
export type AppendKind = 'commentary' | 'thinking' | 'instructions';
export type AppendOutcome = 'accepted' | 'rejected' | 'unconfirmed';
export type VoiceSessionReceipt = z.input<typeof VoiceSessionOutputSchema>;

export type VoiceDeps = {
  apiKey: string | undefined;
  store: VoiceStore;
  fetch?: typeof fetch;
  openSideband?: OpenSideband;
  hooks?: VoiceHooks;
};

type Session = {
  runId: string;
  voiceSessionId: string;
  liveSessionId: string;
  commandId: string;
  offerDigest: string;
  sdpAnswer: string;
  status: VoiceSessionStatus;
  link: SidebandLink;
  isSidebandOpen: boolean;
  isStarted: boolean;
  isCloseRequested: boolean;
  isCloseSent: boolean;
  isGateAcknowledged: boolean;
  isExpired: boolean;
  failure: VoiceFailure | null;
  usageSeconds: number | null;
  ledger: TranscriptLedger;
  delegations: Map<string, { completed: boolean }>;
  seenEvents: Set<string>;
  pendingAcks: Map<string, (outcome: AppendOutcome) => void>;
  timers: Set<ReturnType<typeof setTimeout>>;
  readyTimer: ReturnType<typeof setTimeout> | null;
  closing: Promise<CloseResult> | null;
  finishClose: ((finalization: CloseResult['finalization']) => void) | null;
};

const ACTIVE: readonly VoiceSessionStatus[] = ['connecting', 'live'];
const isActive = (session: Session) => ACTIVE.includes(session.status);

const unavailable = (message: string, retryable = false) => new RouteError({ code: 'RUNTIME_DISCONNECTED', message, retryable });
const invalid = (message: string) => new RouteError({ code: 'INVALID_INPUT', message, retryable: false });

type ReplyCode = Exclude<HttpErrorCode, 'INTERNAL'>;
const isReplyCode = (code: string): code is ReplyCode => code !== 'INTERNAL' && Object.hasOwn(ERROR_HTTP_STATUS, code);

// A domain failure answers with its shared code; anything else is an infrastructure fault and is rethrown.
export function asRouteError(error: unknown): unknown {
  if (!(error instanceof DomainError) || !isReplyCode(error.code)) return error;
  const body = { code: error.code, message: error.message, retryable: error.retryable };
  return new RouteError(error.revision === undefined ? body : { ...body, revision: error.revision });
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

export type VoiceService = ReturnType<typeof createVoiceService>;

export function createVoiceService(deps: VoiceDeps) {
  const { apiKey, store } = deps;
  const request = deps.fetch ?? fetch;
  const openSideband = deps.openSideband ?? openLiveSideband;
  const sessionsByRun = new Map<string, Session[]>();
  const queues = new Map<string, Promise<unknown>>();

  const latest = (runId: string) => sessionsByRun.get(runId)?.at(-1);
  const find = (runId: string, voiceSessionId: string | null | undefined) =>
    voiceSessionId ? sessionsByRun.get(runId)?.find((s) => s.voiceSessionId === voiceSessionId) : latest(runId);

  // Creation for one run is serialized so a duplicate command always finds the first one's receipt.
  function serialize<T>(runId: string, task: () => Promise<T>): Promise<T> {
    const run = (queues.get(runId) ?? Promise.resolve()).then(task, task);
    queues.set(runId, run.catch(() => {}));
    return run;
  }

  function schedule(session: Session, ms: number, action: () => void) {
    const timer = setTimeout(() => {
      session.timers.delete(timer);
      action();
    }, ms);
    timer.unref();
    session.timers.add(timer);
    return timer;
  }

  function clearTimers(session: Session) {
    for (const timer of session.timers) clearTimeout(timer);
    session.timers.clear();
  }

  function sendClose(session: Session) {
    if (!session.isSidebandOpen || session.isCloseSent) return;
    session.isCloseSent = true;
    session.link.send(JSON.stringify({ type: 'session.close', event_id: `close_${randomUUID()}` }));
  }

  // Sends session.close once and waits up to 15 s for session.closed. The sideband stays open until
  // then so the final usage is not lost.
  function beginClose(session: Session): Promise<CloseResult> {
    if (session.closing) return session.closing;
    session.isCloseRequested = true;
    session.closing = new Promise<CloseResult>((resolve) => {
      session.finishClose = (finalization) => {
        session.finishClose = null;
        clearTimers(session);
        session.link.close();
        for (const settle of session.pendingAcks.values()) settle('unconfirmed');
        session.pendingAcks.clear();
        if (session.status !== 'failed') session.status = session.isExpired ? 'expired' : 'closed';
        resolve({ finalization, usageSeconds: session.usageSeconds });
      };
    });
    schedule(session, CLOSE_TIMEOUT_MS, () => session.finishClose?.('incomplete'));
    sendClose(session);
    return session.closing;
  }

  function markDelegationsIncomplete(session: Session) {
    for (const [delegationId, state] of session.delegations) {
      if (!state.completed) deps.hooks?.delegationIncomplete?.({ runId: session.runId, voiceSessionId: session.voiceSessionId, delegationId });
    }
  }

  // A failed session gates audio at once and stays visible as failed; typed input is the recovery.
  function fail(session: Session, reason: VoiceFailure) {
    if (!isActive(session)) return;
    session.status = 'failed';
    session.failure = reason;
    markDelegationsIncomplete(session);
    if (reason === 'sideband_lost') {
      clearTimers(session);
      session.isCloseRequested = true;
      session.closing ??= Promise.resolve({ finalization: 'incomplete', usageSeconds: session.usageSeconds });
      session.link.close();
      return;
    }
    void beginClose(session);
  }

  function becomeLiveWhenReady(session: Session) {
    if (session.status !== 'connecting' || !session.isSidebandOpen || !session.isStarted) return;
    session.status = 'live';
    if (session.readyTimer) clearTimeout(session.readyTimer);
    if (session.readyTimer) session.timers.delete(session.readyTimer);
    session.readyTimer = null;
  }

  function onEvent(session: Session, event: ProviderEvent) {
    switch (event.type) {
      case 'session.started':
        session.isStarted = true;
        becomeLiveWhenReady(session);
        return;
      case 'session.closed':
        session.usageSeconds = event.usageSeconds ?? session.usageSeconds;
        session.isCloseRequested = true;
        session.closing ??= Promise.resolve({ finalization: 'complete', usageSeconds: session.usageSeconds });
        if (session.finishClose) session.finishClose('complete');
        else if (session.status !== 'failed') {
          clearTimers(session);
          session.link.close();
          session.status = 'closed';
        }
        return;
      case 'session.usage.updated':
        session.usageSeconds = event.usageSeconds;
        return;
      case 'session.input_transcript.delta':
      case 'session.output_transcript.delta': {
        const stream = event.type === 'session.input_transcript.delta' ? 'input' : 'output';
        const fragment: Fragment = { eventId: event.eventId, stream, text: event.delta, startMs: event.startMs, endMs: event.endMs };
        const result = session.ledger.add(fragment);
        if (result === 'caption_limit' || result === 'fragment_limit') fail(session, result);
        if (result === 'appended' && stream === 'input') deps.hooks?.inputFragment?.({ runId: session.runId, voiceSessionId: session.voiceSessionId, liveSessionId: session.liveSessionId, fragment });
        return;
      }
      case 'session.delegation.created': {
        if (session.seenEvents.has(event.eventId) || session.delegations.has(event.delegationId)) return;
        session.seenEvents.add(event.eventId);
        session.delegations.set(event.delegationId, { completed: false });
        deps.hooks?.delegationCreated?.({
          runId: session.runId,
          voiceSessionId: session.voiceSessionId,
          liveSessionId: session.liveSessionId,
          delegationId: event.delegationId,
          offsetMs: event.offsetMs,
          inputFragments: session.ledger.stream('input'),
        });
        return;
      }
      case 'append.acknowledged':
        session.pendingAcks.get(event.clientEventId)?.('accepted');
        return;
      case 'error':
        if (event.clientEventId) session.pendingAcks.get(event.clientEventId)?.('rejected');
        return;
    }
  }

  function attach(session: Session): SidebandHandlers {
    return {
      onOpen: () => {
        session.isSidebandOpen = true;
        if (session.isCloseRequested) sendClose(session);
        becomeLiveWhenReady(session);
      },
      onMessage: (text) => {
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          return;
        }
        const event = parseProviderEvent(raw);
        if (event) onEvent(session, event);
      },
      onClose: () => {
        session.isSidebandOpen = false;
        if (session.finishClose) session.finishClose('incomplete');
        else if (isActive(session)) fail(session, 'sideband_lost');
      },
    };
  }

  async function callProvider(key: string, offer: string): Promise<{ liveSessionId: string; sdpAnswer: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CREATE_TIMEOUT_MS);
    try {
      const response = await request(LIVE_SESSIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: sessionConfig(), transport: { type: 'webrtc', sdp: offer } }),
        signal: controller.signal,
      });
      const body: unknown = await response.json().catch(() => undefined);
      const parsed = z.object({ session: z.object({ id: z.string().regex(SESSION_ID_PATTERN) }), transport: z.object({ sdp: z.string().min(1) }) }).safeParse(body);
      if (response.status !== HTTP_STATUS.created || !parsed.success) throw new Error(`The Live session request answered HTTP ${response.status}`);
      return { liveSessionId: parsed.data.session.id, sdpAnswer: parsed.data.transport.sdp };
    } catch {
      // Provider details are not passed on: the student sees only the typed-input recovery.
      throw unavailable('Voice could not start. Use typed input instead.', true);
    } finally {
      clearTimeout(timer);
    }
  }

  const receiptOf = (session: Session): VoiceSessionReceipt => ({ voiceSessionId: session.voiceSessionId, sdpAnswer: session.sdpAnswer, status: session.status });

  async function createSession(runId: string, raw: unknown): Promise<VoiceSessionReceipt> {
    const sdpBytes = typeof raw === 'object' && raw !== null && 'sdpOffer' in raw && typeof raw.sdpOffer === 'string' ? utf8ByteLength(raw.sdpOffer) : 0;
    if (sdpBytes > SDP_MAX_BYTES) throw new RouteError({ code: 'PAYLOAD_TOO_LARGE', message: `The SDP offer is larger than ${SDP_MAX_BYTES} bytes`, retryable: false });
    const parsed = VoiceSessionInputSchema.safeParse(raw);
    if (!parsed.success) throw invalid(`Invalid voice session request: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`.slice(0, 300));
    const input = parsed.data;
    const key = apiKey;
    if (!key) throw unavailable('Voice is unavailable because no provider key is configured. Use typed input instead.');

    return serialize(runId, async () => {
      const offerDigest = digest(input.sdpOffer);
      const known = sessionsByRun.get(runId)?.find((s) => s.commandId === input.commandId);
      if (known) {
        if (known.offerDigest !== offerDigest) throw new RouteError({ code: 'CONFLICT', message: 'This command ID was already used for a different offer', retryable: false, revision: (await store.getRun(runId)).revision });
        return receiptOf(known);
      }
      const run = await store.getRun(runId);
      if (run.revision !== input.expectedRevision) throw new RouteError({ code: 'STALE_REVISION', message: 'The run changed; reload it before starting voice', retryable: false, revision: run.revision });
      const current = latest(runId);
      if (current && isActive(current)) throw new RouteError({ code: 'CONFLICT', message: 'A voice session is already open for this run', retryable: false, revision: run.revision });

      const { liveSessionId, sdpAnswer } = await callProvider(key, input.sdpOffer);
      const session: Session = {
        runId,
        voiceSessionId: `voice_${randomUUID()}`,
        liveSessionId,
        commandId: input.commandId,
        offerDigest,
        sdpAnswer,
        status: 'connecting',
        link: { send: () => {}, close: () => {} },
        isSidebandOpen: false,
        isStarted: false,
        isCloseRequested: false,
        isCloseSent: false,
        isGateAcknowledged: false,
        isExpired: false,
        failure: null,
        usageSeconds: null,
        ledger: new TranscriptLedger(),
        delegations: new Map(),
        seenEvents: new Set(),
        pendingAcks: new Map(),
        timers: new Set(),
        readyTimer: null,
        closing: null,
        finishClose: null,
      };
      sessionsByRun.set(runId, [...(sessionsByRun.get(runId) ?? []), session]);
      // Attach right away so the server observes the session from its start; the browser cannot
      // connect until it has the answer, so nothing here waits for session.started.
      session.link = openSideband(SIDEBAND_URL(liveSessionId), { Authorization: `Bearer ${key}` }, attach(session));
      session.readyTimer = schedule(session, READY_TIMEOUT_MS, () => fail(session, 'not_ready'));
      schedule(session, SESSION_LIMIT_MS, () => {
        session.isExpired = true;
        void beginClose(session);
      });
      try {
        await store.recordVoiceSessionOpened(runId, session.voiceSessionId);
      } catch {
        fail(session, 'persist_failed');
        throw unavailable('Voice could not start. Use typed input instead.', true);
      }
      return receiptOf(session);
    });
  }

  async function snapshot(runId: string): Promise<VoiceSnapshot> {
    const run = await store.getRun(runId);
    const operations = await store.listVoiceOperations(runId);
    const active = operations.filter((o) => o.status === 'started' || o.status === 'steered').at(-1);
    const session = latest(runId);
    return {
      voiceSessionId: session?.voiceSessionId ?? null,
      status: session?.status ?? null,
      activeOperationId: active?.operationId ?? null,
      explanationRevision: run.state.explanationRevision,
      cancellationEpoch: run.state.cancellationEpoch,
      // No session, a failed one, a closing one or an acknowledged teardown all mean audio is off.
      audioGate: session && session.status === 'live' && !session.isCloseRequested && !session.isGateAcknowledged ? 'open' : 'closed',
    };
  }

  async function close(runId: string, voiceSessionId?: string | null): Promise<CloseResult> {
    const session = find(runId, voiceSessionId);
    if (!session) return { finalization: 'not_open', usageSeconds: null };
    return beginClose(session);
  }

  // Records that the browser tore down microphone and playback. The session is closed behind it so
  // a torn-down client never leaves a billable session running.
  function acknowledgeGate(runId: string, voiceSessionId: string) {
    const session = find(runId, voiceSessionId);
    if (!session) return;
    session.isGateAcknowledged = true;
    void beginClose(session);
  }

  async function append(runId: string, kind: AppendKind, { delegationId, text }: { delegationId: string | null; text: string }): Promise<{ eventId: string; outcome: AppendOutcome }> {
    const session = latest(runId);
    if (!session || session.status !== 'live' || session.isCloseRequested) throw unavailable('Voice is not connected.', true);
    if (text.length > APPEND_MAX_CHARS) throw invalid(`Appended context is longer than ${APPEND_MAX_CHARS} characters`);
    if (kind === 'commentary' && text.trim() === '') throw invalid('Commentary must not be empty');
    if (delegationId !== null && !session.delegations.has(delegationId)) throw invalid('Unknown delegation');
    const eventId = `${kind}_${randomUUID()}`;
    const acknowledged = new Promise<AppendOutcome>((resolve) => {
      const timer = schedule(session, ACK_TIMEOUT_MS, () => settle('unconfirmed'));
      const settle = (outcome: AppendOutcome) => {
        clearTimeout(timer);
        session.timers.delete(timer);
        session.pendingAcks.delete(eventId);
        resolve(outcome);
      };
      session.pendingAcks.set(eventId, settle);
    });
    session.link.send(JSON.stringify({ type: `session.${kind}.append`, event_id: eventId, delegation_id: delegationId, content: text }));
    // An acknowledgment means the text was accepted, never that it finished playing.
    return { eventId, outcome: await acknowledged };
  }

  return {
    createSession,
    snapshot,
    close,
    acknowledgeGate,
    // Speakable update for the original session; the model may paraphrase it lightly.
    sendCommentary: (runId: string, input: { delegationId: string | null; text: string }) => append(runId, 'commentary', input),
    // Quiet context the model can use later without saying it; empty content is allowed.
    sendThinking: (runId: string, input: { delegationId: string | null; text: string }) => append(runId, 'thinking', input),
    // Redirects the conversation and may interrupt speech in progress.
    sendInstructions: (runId: string, text: string) => append(runId, 'instructions', { delegationId: null, text }),
    completeDelegation(runId: string, delegationId: string) {
      const state = latest(runId)?.delegations.get(delegationId);
      if (state) state.completed = true;
    },
    transcript: (runId: string) => ({ input: latest(runId)?.ledger.stream('input') ?? [], output: latest(runId)?.ledger.stream('output') ?? [] }),
    failureReason: (runId: string) => latest(runId)?.failure ?? null,
    liveSessionId: (runId: string, voiceSessionId: string) => find(runId, voiceSessionId)?.liveSessionId ?? null,
    // The run's session while it can still speak, or null.
    activeSession(runId: string): { voiceSessionId: string; liveSessionId: string } | null {
      const session = latest(runId);
      return session && session.status === 'live' && !session.isCloseRequested ? { voiceSessionId: session.voiceSessionId, liveSessionId: session.liveSessionId } : null;
    },
    recordOperation: (operation: VoiceOperation) => store.insertVoiceOperation(buildVoiceOperation(operation)),
    // Gate-and-close every open session of this process; used when the server stops.
    async closeAll() {
      const open = [...sessionsByRun.values()].flat().filter((s) => !s.closing);
      await Promise.all(open.map((s) => beginClose(s)));
    },
    store,
  };
}

// ---------------------------------------------------------------------------------------------
// Route handlers.

export type TypedCorrectionRequest = {
  command: Extract<VoiceCommand, { type: 'typed_correction' }>;
  inputMode: 'typed';
  // A typed correction is never a delegation, and names a Live session only when one really exists.
  delegationId: null;
  liveSessionId: string | null;
};

// The explanation-correction and render-receipt transitions belong to the learning engine.
export type VoiceCommandPorts = {
  typedCorrection: (runId: string, request: TypedCorrectionRequest) => Promise<Awaited<ReturnType<RouteHandler<'voiceCommand'>>>>;
  activityRendered: (runId: string, command: ActivityRenderedCommand) => Promise<Awaited<ReturnType<RouteHandler<'voiceCommand'>>>>;
};

async function mapped<T>(task: () => Promise<T>): Promise<T> {
  try {
    return await task();
  } catch (error) {
    throw asRouteError(error);
  }
}

// Route lines (registered by the server): createVoiceSession, voiceSnapshot, voiceCommand.
export function createVoiceHandlers(service: VoiceService, ports: VoiceCommandPorts) {
  const createVoiceSession: RouteHandler<'createVoiceSession'> = ({ params, body }) => mapped(() => service.createSession(params.runId, body));
  const voiceSnapshot: RouteHandler<'voiceSnapshot'> = ({ params }) => mapped(() => service.snapshot(params.runId));
  const voiceCommand: RouteHandler<'voiceCommand'> = ({ params, body }) =>
    mapped(async () => {
      const { runId } = params;
      switch (body.type) {
        case 'close_voice':
          await service.close(runId, body.voiceSessionId);
          return service.snapshot(runId);
        case 'audio_gate_closed': {
          const run = await service.store.getRun(runId);
          // Without an activity there is no independent check to unlock; the local teardown still counts.
          if (run.state.activity) await service.store.recordAudioGateClosed(runId, run.state.activity.id, run.state.activity.revision, body.voiceSessionId);
          service.acknowledgeGate(runId, body.voiceSessionId);
          return service.snapshot(runId);
        }
        case 'typed_correction':
          return ports.typedCorrection(runId, {
            command: body,
            inputMode: 'typed',
            delegationId: null,
            liveSessionId: body.voiceSessionId ? service.liveSessionId(runId, body.voiceSessionId) : null,
          });
        case 'activity_rendered':
          return ports.activityRendered(runId, body);
      }
    });
  return { createVoiceSession, voiceSnapshot, voiceCommand };
}

// ---------------------------------------------------------------------------------------------
// Delegation. A client delegation from the Live session seals one explanation revision from the
// child's transcript and hands it to the engine, which steers the running Codex turn or starts a new
// one. Approved speech follows only the matching render receipt. Voice never grades: it only supplies
// explanation text and speaks app copy.

export type ClarifyReason = 'crossing_cutoff' | 'empty' | 'too_long';
export type WindowSeal = { kind: 'sealed'; text: string; eventIds: string[] } | { kind: 'clarify'; reason: ClarifyReason };

// Provider intervals exclude their end, so a fragment that ends exactly at the cutoff was spoken
// before it. A fragment belongs to the window its interval ends in.
const endsInWindow = (f: Fragment, fromMs: number, cutoffMs: number) => f.endMs > fromMs && f.endMs <= cutoffMs;
const crossesCutoff = (f: Fragment, cutoffMs: number) => f.startMs < cutoffMs && f.endMs > cutoffMs;

// Seals the text of one explanation window from the child's input fragments. Fragments are joined
// exactly as the provider sent them, in timeline order. A fragment still running at the cutoff is never
// split by guessed word timing, and text that cannot become an explanation (blank, or longer than an
// explanation may be) is asked again rather than truncated.
export function sealExplanationWindow(fragments: readonly Fragment[], fromMs: number, cutoffMs: number): WindowSeal {
  const input = fragments.filter((f) => f.stream === 'input');
  if (input.some((f) => crossesCutoff(f, cutoffMs))) return { kind: 'clarify', reason: 'crossing_cutoff' };
  const inside = input.filter((f) => endsInWindow(f, fromMs, cutoffMs)).toSorted((a, b) => a.startMs - b.startMs);
  const text = inside.map((f) => f.text).join('');
  if (text.trim() === '') return { kind: 'clarify', reason: 'empty' };
  if (!ExplanationTextSchema.safeParse(text).success) return { kind: 'clarify', reason: 'too_long' };
  return { kind: 'sealed', text, eventIds: inside.map((f) => f.eventId) };
}

// An operation may still change the run, or be spoken about, only while the run is at the explanation
// revision and cancellation epoch it was started for.
export function isOperationCurrent(state: RunState, operation: Pick<VoiceOperation, 'explanationRevision' | 'cancellationEpoch'>): boolean {
  return !state.stopped && state.explanationRevision === operation.explanationRevision && state.cancellationEpoch === operation.cancellationEpoch;
}

const isOpenOperation = (operation: VoiceOperation) => operation.status === 'started' || operation.status === 'steered';

// The only words an activity is introduced with. Templates without approved speech are never talked
// about: the support for an anchored start, a retry and the completion speak for themselves on screen.
const ACTIVITY_SPEECH: Readonly<Record<TemplateId, string | null>> = {
  invitation_addition: null,
  initial_number_line: null,
  anchor_start_number_line: null,
  make_ten_blocks: SPOKEN_COPY.makeTenIntroduction,
  manipulation_retry: null,
  clarify_first_number: SPOKEN_COPY.clarifyFirstNumber,
  clarify_show_steps: SPOKEN_COPY.clarifyShowSteps,
  independent_number_line: SPOKEN_COPY.independentHandover,
  independent_make_ten: SPOKEN_COPY.independentHandover,
  completion: null,
};

// The question asked again when the child's words could not be sealed: the explanation question while
// explaining, the clarification's own question while clarifying, and nothing while work is running.
function questionToRepeat(state: RunState): string | null {
  if (state.phase === 'EXPLAIN') {
    const initial = state.attempts.findLast((a) => a.criterion === 'initial');
    return initial ? SPOKEN_COPY.howDidYouGet(initial.attempt.answer) : null;
  }
  if (state.phase === 'CLARIFY' && state.activity) return ACTIVITY_SPEECH[state.activity.templateId];
  return null;
}

// A sealed explanation on its way to the engine's explain command with voice provenance.
export type VoiceExplanation = {
  runId: string;
  commandId: string;
  expectedRevision: number;
  text: string;
  liveSessionId: string;
  delegationId: string;
  offsetMs: number;
  operationId: string;
};

export type DelegationPorts = {
  readRun(runId: string): Promise<{ revision: number; state: RunState }>;
  // Commits the explanation (input mode voice), its VoiceOperation and voice.delegated; the engine
  // then steers the active Codex turn or starts a new one in the run's thread.
  explainByVoice(input: VoiceExplanation): Promise<unknown>;
  transition: Store['transition'];
  listVoiceOperations(runId: string): Promise<VoiceOperation[]>;
  // The run's Live session while it can still speak, or null.
  activeSession(runId: string): { voiceSessionId: string; liveSessionId: string } | null;
  // Every input fragment the session observed so far.
  inputTranscript(runId: string): readonly Fragment[];
  sendCommentary(runId: string, input: { delegationId: string | null; text: string }): Promise<{ outcome: AppendOutcome }>;
  sendThinking(runId: string, input: { delegationId: string | null; text: string }): Promise<{ outcome: AppendOutcome }>;
  // Marks a delegation answered, so a later session failure does not report it as incomplete.
  completeDelegation(runId: string, delegationId: string): void;
  closeVoice(runId: string): Promise<void>;
  newId(): string;
};

export type DelegationReceipt =
  | { outcome: 'accepted'; operation: VoiceOperation }
  | { outcome: 'clarification'; reason: ClarifyReason }
  | { outcome: 'rejected'; reason: 'stopped' | 'wrong_phase' };

export type SilentReason = 'no_session' | 'stopped' | 'not_current_activity' | 'stale' | 'no_approved_speech';
export type SpokenDelivery = { outcome: 'spoken'; text: string; acknowledgement: AppendOutcome | 'replayed' } | { outcome: 'silent'; reason: SilentReason };

export type RenderReceipt = { runId: string; voiceSessionId: string | null; activityId: string; activityRevision: number };

// Another command moved the run between reading it and committing; retrying covers a render or audio
// receipt landing at the same moment without looping on a run that keeps moving.
const STALE_REVISION_RETRIES = 2;

// Thrown inside a voice record transition when the run moved past what the record reports, so the
// transaction rolls back and nothing is said about stale work.
class Superseded extends Error {}

type SealedWindow = { fromMs: number; cutoffMs: number; delegationId: string; text: string };

// Delegation state of one Live session. Offsets are milliseconds from that session's start, so a new
// session starts a new timeline.
type DelegationWindows = {
  liveSessionId: string;
  // End of the last sealed window; the next window starts here.
  cutoffMs: number;
  sealed: SealedWindow | null;
  receipts: Map<string, Promise<DelegationReceipt>>;
};

export function createDelegationCoordinator(ports: DelegationPorts) {
  // One active voice session per run.
  const windows = new Map<string, DelegationWindows>();
  const queues = new Map<string, Promise<unknown>>();

  // Delegations, fragments and deliveries of one run take effect one at a time, in arrival order.
  function serialized<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const result = (queues.get(runId) ?? Promise.resolve()).then(work);
    // The queue only orders work; each caller still receives its own failure through `result`.
    queues.set(runId, result.catch(() => undefined));
    return result;
  }

  function windowsFor(runId: string, liveSessionId: string): DelegationWindows {
    const existing = windows.get(runId);
    if (existing?.liveSessionId === liveSessionId) return existing;
    const fresh: DelegationWindows = { liveSessionId, cutoffMs: 0, sealed: null, receipts: new Map() };
    windows.set(runId, fresh);
    return fresh;
  }

  const sessionFor = (runId: string, liveSessionId: string) => (ports.activeSession(runId)?.liveSessionId === liveSessionId ? ports.activeSession(runId) : null);

  async function withLatestRevision<T>(runId: string, attempt: (expectedRevision: number) => Promise<T>): Promise<T> {
    for (let retries = 0; ; retries += 1) {
      const { revision } = await ports.readRun(runId);
      try {
        return await attempt(revision);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'STALE_REVISION' && retries < STALE_REVISION_RETRIES) continue;
        throw error;
      }
    }
  }

  // Commits one voice record at the latest run revision; null when the run moved past it meanwhile.
  async function commitVoiceRecord<R>(
    runId: string,
    commandKey: string,
    body: unknown,
    resultSchema: z.ZodType<R>,
    build: (state: RunState) => { events: NewEvent[]; voiceOperations?: VoiceOperationChange[]; result: R },
  ): Promise<{ result: R; replayed: boolean } | null> {
    try {
      return await withLatestRevision(runId, (expectedRevision) =>
        ports.transition({ runId, commandKey, body, expectedRevision, resultSchema, apply: ({ state }) => ({ state, ...build(state) }) }),
      );
    } catch (error) {
      if (error instanceof Superseded) return null;
      throw error;
    }
  }

  // Speaks approved app copy as a commentary record. The record is committed first, re-checking that
  // the run is still where the words apply; only then do the words reach the Live session.
  async function speak(
    runId: string,
    commandKey: string,
    body: unknown,
    text: string,
    record: { liveSessionId: string; delegationId: string | null; operationId: string | null; activity: Activity | null },
    stillApplies: (state: RunState) => boolean,
  ): Promise<SpokenDelivery> {
    const { liveSessionId, delegationId, operationId, activity } = record;
    const committed = await commitVoiceRecord(runId, commandKey, body, z.object({ text: z.string() }), (state) => {
      if (!stillApplies(state)) throw new Superseded();
      const payload = {
        liveSessionId,
        delegationId,
        operationId,
        activityId: activity?.id ?? null,
        activityRevision: activity?.revision ?? null,
        explanationRevision: state.explanationRevision,
        cancellationEpoch: state.cancellationEpoch,
        text,
      };
      return { events: [{ type: 'voice.commentary', payload }], result: { text } };
    });
    if (!committed) return { outcome: 'silent', reason: 'stale' };
    if (committed.replayed) return { outcome: 'spoken', text: committed.result.text, acknowledgement: 'replayed' };
    const { outcome } = await ports.sendCommentary(runId, { delegationId, text });
    if (delegationId !== null) ports.completeDelegation(runId, delegationId);
    return { outcome: 'spoken', text, acknowledgement: outcome };
  }

  async function askAgain(runId: string, liveSessionId: string, commandKey: string, delegationId: string | null): Promise<SpokenDelivery> {
    const { state } = await ports.readRun(runId);
    if (state.stopped) return { outcome: 'silent', reason: 'stopped' };
    const text = questionToRepeat(state);
    if (text === null) return { outcome: 'silent', reason: 'no_approved_speech' };
    const stillApplies = (current: RunState) => !current.stopped && current.phase === state.phase && current.explanationRevision === state.explanationRevision;
    return speak(runId, commandKey, { delegationId }, text, { liveSessionId, delegationId, operationId: null, activity: null }, stillApplies);
  }

  // A delivery that finds an operation of an older epoch still open cancels it, so stale work is
  // recorded as cancelled even when nothing else closed it.
  async function cancelOperations(runId: string, operations: readonly VoiceOperation[]): Promise<void> {
    for (const { operationId } of operations) {
      await commitVoiceRecord(runId, `operation_cancelled:${operationId}`, { operationId }, z.object({}), (state) => ({
        events: [{ type: 'operation.cancelled', payload: { operationId, reason: state.stopped ? 'stopped' : 'superseded', explanationRevision: state.explanationRevision, cancellationEpoch: state.cancellationEpoch } }],
        voiceOperations: [{ kind: 'status', operationId, status: 'cancelled', expected: ['started', 'steered'], onMismatch: 'skip' }],
        result: {},
      }));
    }
  }

  async function submitRevision(runId: string, liveSessionId: string, window: SealedWindow): Promise<DelegationReceipt> {
    const operationId = ports.newId();
    const commandId = ports.newId();
    try {
      await withLatestRevision(runId, (expectedRevision) =>
        ports.explainByVoice({ runId, commandId, expectedRevision, text: window.text, liveSessionId, delegationId: window.delegationId, offsetMs: window.cutoffMs, operationId }),
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === 'WRONG_PHASE') return { outcome: 'rejected', reason: 'wrong_phase' };
      throw error;
    }
    const operation = (await ports.listVoiceOperations(runId)).find((o) => o.operationId === operationId);
    if (!operation) throw new Error(`The explanation committed without its voice operation ${operationId}`);
    return { outcome: 'accepted', operation };
  }

  async function handleDelegation(runId: string, state: DelegationWindows, delegation: DelegationCreated): Promise<DelegationReceipt> {
    const { liveSessionId, delegationId, offsetMs } = delegation;
    // An empty thinking update right away keeps the model from improvising an acknowledgement while
    // the app works; anything it says next comes from approved app copy.
    if (sessionFor(runId, liveSessionId)) await ports.sendThinking(runId, { delegationId, text: '' });
    if ((await ports.readRun(runId)).state.stopped) {
      ports.completeDelegation(runId, delegationId);
      return { outcome: 'rejected', reason: 'stopped' };
    }
    const seal = sealExplanationWindow(delegation.inputFragments, state.cutoffMs, offsetMs);
    if (seal.kind === 'clarify') {
      // The cutoff stays put, so the deferred words are sealed whole with the child's next answer.
      if (sessionFor(runId, liveSessionId)) await askAgain(runId, liveSessionId, `voice_question:${delegationId}`, delegationId);
      return { outcome: 'clarification', reason: seal.reason };
    }
    const window: SealedWindow = { fromMs: state.cutoffMs, cutoffMs: offsetMs, delegationId, text: seal.text };
    state.cutoffMs = offsetMs;
    const receipt = await submitRevision(runId, liveSessionId, window);
    if (receipt.outcome === 'accepted') state.sealed = window;
    else ports.completeDelegation(runId, delegationId);
    return receipt;
  }

  // A delayed fragment of an already sealed window revises that explanation as a correction. The
  // sealed revision itself never changes; the engine supersedes it.
  async function reviseSealedWindow(runId: string, state: DelegationWindows, fragment: Fragment, fragments: readonly Fragment[]): Promise<DelegationReceipt | null> {
    const window = state.sealed;
    if (!window || !endsInWindow(fragment, window.fromMs, window.cutoffMs)) return null;
    const seal = sealExplanationWindow(fragments, window.fromMs, window.cutoffMs);
    if (seal.kind !== 'sealed' || seal.text === window.text) return null;
    if ((await ports.readRun(runId)).state.stopped) return null;
    const revised: SealedWindow = { ...window, text: seal.text };
    const receipt = await submitRevision(runId, state.liveSessionId, revised);
    if (receipt.outcome === 'accepted') state.sealed = revised;
    return receipt;
  }

  async function deliverActivitySpeech(receipt: RenderReceipt): Promise<SpokenDelivery> {
    const { runId } = receipt;
    const live = ports.activeSession(runId);
    if (!live || receipt.voiceSessionId !== live.voiceSessionId) return { outcome: 'silent', reason: 'no_session' };
    const { state } = await ports.readRun(runId);
    if (state.stopped) return { outcome: 'silent', reason: 'stopped' };
    const isRenderedActivity = (s: RunState) => s.activity?.id === receipt.activityId && s.activity.revision === receipt.activityRevision;
    const activity = state.activity;
    if (!activity || !isRenderedActivity(state)) return { outcome: 'silent', reason: 'not_current_activity' };

    const operations = (await ports.listVoiceOperations(runId)).filter((o) => o.runId === runId);
    const stale = operations.filter((o) => isOpenOperation(o) && !isOperationCurrent(state, o));
    if (stale.length > 0) {
      await cancelOperations(runId, stale);
      return { outcome: 'silent', reason: 'stale' };
    }
    const text = ACTIVITY_SPEECH[activity.templateId];
    if (text === null) return { outcome: 'silent', reason: 'no_approved_speech' };
    // The engine settles an operation when its turn ends, so the one for this revision may already be
    // completed; the commentary only names it.
    const operation = operations.findLast((o) => isOperationCurrent(state, o) && (isOpenOperation(o) || o.status === 'completed')) ?? null;
    return speak(
      runId,
      `voice_commentary:${activity.id}:${activity.revision}`,
      { activityId: activity.id, activityRevision: activity.revision, liveSessionId: live.liveSessionId },
      text,
      { liveSessionId: live.liveSessionId, delegationId: operation?.delegationId ?? null, operationId: operation?.operationId ?? null, activity },
      (current) => !current.stopped && isRenderedActivity(current) && (operation === null || isOperationCurrent(current, operation)),
    );
  }

  return {
    inputFragment(event: InputFragmentObserved): Promise<DelegationReceipt | null> {
      return serialized(event.runId, async () => {
        const state = windowsFor(event.runId, event.liveSessionId);
        return reviseSealedWindow(event.runId, state, event.fragment, ports.inputTranscript(event.runId));
      });
    },
    delegationCreated(event: DelegationCreated): Promise<DelegationReceipt> {
      const state = windowsFor(event.runId, event.liveSessionId);
      const first = state.receipts.get(event.delegationId);
      if (first) return first;
      const receipt = serialized(event.runId, () => handleDelegation(event.runId, state, event));
      state.receipts.set(event.delegationId, receipt);
      return receipt;
    },
    // The first question after a wrong answer, once the child is asked to explain.
    askForExplanation(runId: string): Promise<SpokenDelivery> {
      return serialized(runId, async () => {
        const live = ports.activeSession(runId);
        if (!live) return { outcome: 'silent', reason: 'no_session' };
        const initial = (await ports.readRun(runId)).state.attempts.findLast((a) => a.criterion === 'initial');
        if (!initial) return { outcome: 'silent', reason: 'no_approved_speech' };
        return askAgain(runId, live.liveSessionId, `voice_question:${initial.id}`, null);
      });
    },
    activityRendered(receipt: RenderReceipt): Promise<SpokenDelivery> {
      return serialized(receipt.runId, () => deliverActivitySpeech(receipt));
    },
    // Runs after stop_learning committed: the run takes no more spoken explanations.
    learningStopped(runId: string): Promise<void> {
      return serialized(runId, async () => {
        windows.delete(runId);
        await ports.closeVoice(runId);
      });
    },
    // Words the observer missed are never reconstructed: the in-flight window is dropped and the child
    // is asked again in the next session.
    voiceFailed(runId: string): void {
      windows.delete(runId);
    },
  };
}

export type DelegationCoordinator = ReturnType<typeof createDelegationCoordinator>;

// What delegation uses of the voice service.
export type DelegationVoice = Pick<VoiceService, 'activeSession' | 'transcript' | 'sendCommentary' | 'sendThinking' | 'completeDelegation' | 'close'>;

export type VoiceDelegationDeps = {
  store: Pick<Store, 'getRun' | 'transition' | 'listVoiceOperations'>;
  engine: Pick<Engine, 'explain' | 'activityRendered'>;
  onError?: (error: unknown) => void;
};

// Wires delegation between the voice service and the engine. Create it first, pass `hooks` to
// createVoiceService, then `attach` the created service. The server routes activity_rendered through
// `activityRendered` and binds the engine's closeVoice to `closeVoice`.
export function createVoiceDelegation({ store, engine, onError }: VoiceDelegationDeps) {
  const report = onError ?? ((error: unknown) => console.error('Voice delegation failed', error));
  let voice: DelegationVoice | null = null;
  const attached = () => {
    if (!voice) throw new Error('The voice service is not attached to delegation yet');
    return voice;
  };

  // The engine's explain transition writes the explanation, its VoiceOperation and voice.delegated in
  // one transaction; the delegation offset is part of the voice provenance.
  async function explainByVoice(input: VoiceExplanation): Promise<void> {
    const { runId, commandId, expectedRevision, text, liveSessionId, delegationId, offsetMs, operationId } = input;
    await engine.explain(runId, { commandId, revision: expectedRevision, text, provenance: { inputMode: 'voice', liveSessionId, delegationId, offsetMs }, operationId });
  }

  const coordinator = createDelegationCoordinator({
    readRun: async (runId) => {
      const { revision, state } = await store.getRun(runId);
      return { revision, state };
    },
    explainByVoice,
    transition: (request) => store.transition(request),
    listVoiceOperations: (runId) => store.listVoiceOperations(runId),
    activeSession: (runId) => voice?.activeSession(runId) ?? null,
    inputTranscript: (runId) => attached().transcript(runId).input,
    sendCommentary: (runId, input) => attached().sendCommentary(runId, input),
    sendThinking: (runId, input) => attached().sendThinking(runId, input),
    completeDelegation: (runId, delegationId) => attached().completeDelegation(runId, delegationId),
    closeVoice: async (runId) => {
      await attached().close(runId);
    },
    newId: () => randomUUID(),
  });

  // Voice hooks run inside provider event handling, so work is handed off and failures are reported.
  const hooks: VoiceHooks = {
    delegationCreated: (event) => void coordinator.delegationCreated(event).catch(report),
    inputFragment: (event) => void coordinator.inputFragment(event).catch(report),
    delegationIncomplete: (event) => coordinator.voiceFailed(event.runId),
  };

  return {
    hooks,
    coordinator,
    attach(service: DelegationVoice) {
      voice = service;
    },
    // The render receipt is the engine's transition; approved speech for the activity may follow it.
    async activityRendered(runId: string, command: ActivityRenderedCommand) {
      const outcome = await engine.activityRendered(runId, command);
      await coordinator.activityRendered({ runId, voiceSessionId: command.voiceSessionId, activityId: command.activityId, activityRevision: command.activityRevision }).catch(report);
      return outcome;
    },
    closeVoice: (runId: string) => coordinator.learningStopped(runId),
    askForExplanation: (runId: string) => coordinator.askForExplanation(runId),
  };
}
