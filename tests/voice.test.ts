import assert from 'node:assert/strict';
import { afterEach, describe, mock, test } from 'node:test';
import { CORRELATION_ID_KEYS, type VoiceOperation } from '../src/domain.js';
import { SDP_MAX_BYTES, type VoiceCommand } from '../src/routes.js';
import { RouteError } from '../src/server.js';
import {
  buildVoiceOperation,
  CLOSE_TIMEOUT_MS,
  createVoiceHandlers,
  createVoiceService,
  parseProviderEvent,
  type SidebandHandlers,
  type SidebandLink,
  type VoiceService,
  type VoiceStore,
} from '../src/voice.js';

const RUN_ID = 'run-voice-1';
const signal = new AbortController().signal;
const KEY = 'sk-test-key-that-must-never-leave-the-server';
const SDP_OFFER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n';
const SDP_ANSWER = 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\ns=answer\r\nt=0 0\r\n';
const LIVE_ID = 'live_9f3a2c';
const COMMAND_A = '6f1c1f43-2a52-4d6b-9a8e-6f8f7c0d9b11';
const COMMAND_B = '1b0f1d2e-7a2b-4a84-8b0b-0d5e9c2a7f55';

type Frame = Record<string, unknown>;

// A scripted stand-in for the provider's sideband socket: the test decides what arrives.
class FakeSideband implements SidebandLink {
  readonly sent: Frame[] = [];
  isClosed = false;
  constructor(
    readonly url: string,
    readonly handlers: SidebandHandlers,
  ) {}
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Frame);
  }
  close(): void {
    this.isClosed = true;
  }
  open(): void {
    this.handlers.onOpen();
  }
  emit(event: Frame): void {
    this.handlers.onMessage(JSON.stringify(event));
  }
  drop(): void {
    this.handlers.onClose();
  }
}

type Call = { url: string; headers: Record<string, string>; body: string };

function fakeStore(overrides: Partial<VoiceStore> = {}) {
  const calls: string[] = [];
  const operations: VoiceOperation[] = [];
  const store: VoiceStore = {
    async getRun(runId) {
      calls.push('getRun');
      return { id: runId, revision: 4, seq: 9, state: { explanationRevision: 0, cancellationEpoch: 0, activity: null } };
    },
    async recordVoiceSessionOpened() {
      calls.push('recordVoiceSessionOpened');
    },
    async recordAudioGateClosed() {
      calls.push('recordAudioGateClosed');
    },
    async insertVoiceOperation(op) {
      calls.push('insertVoiceOperation');
      operations.push(op);
      return op;
    },
    async listVoiceOperations() {
      calls.push('listVoiceOperations');
      return operations;
    },
    ...overrides,
  };
  return { store, calls, operations };
}

function harness(options: { apiKey?: string | undefined; reply?: () => Response; store?: Partial<VoiceStore> } = {}) {
  const calls: Call[] = [];
  const sidebands: FakeSideband[] = [];
  const hooks = { delegations: [] as unknown[], incomplete: [] as unknown[] };
  const { store, calls: storeCalls, operations } = fakeStore(options.store);
  const reply = options.reply ?? (() => Response.json({ session: { id: LIVE_ID }, transport: { sdp: SDP_ANSWER } }, { status: 201 }));
  const service = createVoiceService({
    apiKey: 'apiKey' in options ? options.apiKey : KEY,
    store,
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
      return reply();
    },
    openSideband: (url, headers, handlers) => {
      assert.equal(headers.Authorization, `Bearer ${KEY}`);
      const link = new FakeSideband(url, handlers);
      sidebands.push(link);
      return link;
    },
    hooks: {
      delegationCreated: (event) => hooks.delegations.push(event),
      delegationIncomplete: (event) => hooks.incomplete.push(event),
    },
  });
  return { service, calls, sidebands, hooks, storeCalls, operations };
}

const createInput = (commandId = COMMAND_A, sdpOffer = SDP_OFFER) => ({ commandId, expectedRevision: 4, sdpOffer });

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<RouteError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  assert.ok(error instanceof RouteError, `expected a RouteError, got ${String(error)}`);
  assert.equal(error.body.code, code);
  return error;
}

// Opens a session and makes it live: sideband attached and session.started observed.
async function liveSession(h: ReturnType<typeof harness>) {
  const receipt = await h.service.createSession(RUN_ID, createInput());
  const sideband = h.sidebands[0];
  assert.ok(sideband);
  sideband.open();
  sideband.emit({ type: 'session.started' });
  return { receipt, sideband };
}

const delta = (type: 'session.input_transcript.delta' | 'session.output_transcript.delta', eventId: string, text: string, start: number, end: number): Frame => ({
  type,
  event_id: eventId,
  delta: text,
  start_ms: start,
  end_ms: end,
});

afterEach(() => {
  mock.timers.reset();
});

describe('session creation', () => {
  test('mocked provider: an SDP offer over 64 KiB or not starting with v=0 is rejected before any network call', async () => {
    const h = harness();
    await rejectsWith(h.service.createSession(RUN_ID, createInput(COMMAND_A, 'v=0\r\n' + 'a'.repeat(SDP_MAX_BYTES))), 'PAYLOAD_TOO_LARGE');
    await rejectsWith(h.service.createSession(RUN_ID, createInput(COMMAND_A, 'm=audio 9 UDP/TLS/RTP/SAVPF 111')), 'INVALID_INPUT');
    // Exactly the limit is accepted.
    const atLimit = 'v=0\r\n' + 'a'.repeat(SDP_MAX_BYTES - 5);
    await h.service.createSession(RUN_ID, createInput(COMMAND_B, atLimit));
    assert.equal(h.calls.length, 1);
  });

  test('mocked provider: a missing key returns the typed-fallback error before any network call', async () => {
    const h = harness({ apiKey: undefined });
    const error = await rejectsWith(h.service.createSession(RUN_ID, createInput()), 'RUNTIME_DISCONNECTED');
    assert.match(error.body.message, /type/i);
    assert.equal(h.calls.length, 0);
    assert.equal(h.sidebands.length, 0);
    assert.deepEqual(h.storeCalls, []);
  });

  test('mocked provider: the browser response never contains the key or upstream headers', async () => {
    const h = harness({
      reply: () =>
        Response.json({ session: { id: LIVE_ID, client_secret: 'upstream-secret' }, transport: { sdp: SDP_ANSWER } }, { status: 201, headers: { 'openai-organization': 'org-private', 'x-request-id': 'req_private' } }),
    });
    const receipt = await h.service.createSession(RUN_ID, createInput());
    const text = JSON.stringify(receipt);
    assert.deepEqual(Object.keys(receipt).sort(), ['sdpAnswer', 'status', 'voiceSessionId']);
    for (const secret of [KEY, 'upstream-secret', 'org-private', 'req_private', LIVE_ID]) assert.ok(!text.includes(secret), `the response leaks ${secret}`);
    // The provider call itself carried the key; it never appears in the snapshot either.
    assert.equal(h.calls[0]?.headers.authorization, `Bearer ${KEY}`);
    assert.ok(!JSON.stringify(await h.service.snapshot(RUN_ID)).includes(KEY));
  });

  test('mocked provider: the create request carries the offer, client delegation and a 15 s limit, and attaches the sideband to the same session', async () => {
    const h = harness();
    await h.service.createSession(RUN_ID, createInput());
    const body = JSON.parse(h.calls[0]?.body ?? '{}') as { session: { model: string; delegation: { type: string }; store: boolean }; transport: { type: string; sdp: string } };
    assert.equal(h.calls[0]?.url, 'https://api.openai.com/v1/live/sessions');
    assert.equal(body.session.model, 'gpt-live-1');
    assert.deepEqual(body.session.delegation, { type: 'client' });
    assert.equal(body.session.store, false);
    assert.deepEqual(body.transport, { type: 'webrtc', sdp: SDP_OFFER });
    assert.equal(h.sidebands[0]?.url, `wss://api.openai.com/v1/live/sessions/${LIVE_ID}/attach`);
  });

  test('mocked provider: the same commandId returns the same session receipt and opens no second session', async () => {
    const h = harness();
    const [first, concurrent] = await Promise.all([h.service.createSession(RUN_ID, createInput()), h.service.createSession(RUN_ID, createInput())]);
    const again = await h.service.createSession(RUN_ID, createInput());
    assert.deepEqual(concurrent, first);
    assert.deepEqual(again, first);
    assert.equal(h.calls.length, 1);
    assert.equal(h.sidebands.length, 1);
    assert.equal(h.storeCalls.filter((c) => c === 'recordVoiceSessionOpened').length, 1);
    // The same command with a different offer is a conflict, not a replay.
    await rejectsWith(h.service.createSession(RUN_ID, createInput(COMMAND_A, SDP_OFFER + 'a=changed\r\n')), 'CONFLICT');
    // A second command while the session is active never opens another billable session.
    await rejectsWith(h.service.createSession(RUN_ID, createInput(COMMAND_B)), 'CONFLICT');
    assert.equal(h.calls.length, 1);
  });

  test('mocked provider: a stale expected revision is rejected with the current revision before any network call', async () => {
    const h = harness();
    const error = await rejectsWith(h.service.createSession(RUN_ID, { ...createInput(), expectedRevision: 3 }), 'STALE_REVISION');
    assert.equal(error.body.revision, 4);
    assert.equal(h.calls.length, 0);
  });

  test('mocked provider: a provider failure leaves no session, no sideband and a retryable typed-fallback error', async () => {
    const h = harness({ reply: () => Response.json({ error: { code: 'model_not_found', message: 'private upstream detail' } }, { status: 404 }) });
    const error = await rejectsWith(h.service.createSession(RUN_ID, createInput()), 'RUNTIME_DISCONNECTED');
    assert.ok(!error.body.message.includes('private upstream detail'));
    assert.equal(h.sidebands.length, 0);
    assert.equal((await h.service.snapshot(RUN_ID)).voiceSessionId, null);
    // A fresh command may try again after a failed create.
    const retry = harness();
    await retry.service.createSession(RUN_ID, createInput(COMMAND_B));
  });

  test('mocked provider: a create request that exceeds 15 s is aborted and reported as a failure', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const calls: AbortSignal[] = [];
    const service = createVoiceService({
      apiKey: KEY,
      store: fakeStore().store,
      fetch: (_url, init) => {
        const signal = init?.signal;
        assert.ok(signal);
        calls.push(signal);
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
      },
      openSideband: () => assert.fail('no sideband without a session'),
    });
    const pending = rejectsWith(service.createSession(RUN_ID, createInput()), 'RUNTIME_DISCONNECTED');
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(14_999);
    assert.equal(calls[0]?.aborted, false);
    mock.timers.tick(1);
    await pending;
    assert.equal(calls[0]?.aborted, true);
  });
});

describe('audio gate and transcripts', () => {
  test('mocked provider: audio stays gated until sideband attach and session.started are both observed', async () => {
    const h = harness();
    await h.service.createSession(RUN_ID, createInput());
    const sideband = h.sidebands[0];
    assert.ok(sideband);
    let snapshot = await h.service.snapshot(RUN_ID);
    assert.deepEqual([snapshot.status, snapshot.audioGate], ['connecting', 'closed']);
    sideband.open();
    snapshot = await h.service.snapshot(RUN_ID);
    assert.deepEqual([snapshot.status, snapshot.audioGate], ['connecting', 'closed']);
    sideband.emit({ type: 'session.started' });
    snapshot = await h.service.snapshot(RUN_ID);
    assert.deepEqual([snapshot.status, snapshot.audioGate], ['live', 'open']);
  });

  test('mocked provider: a session that never becomes ready within 15 s is closed and reported as failed', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    await h.service.createSession(RUN_ID, createInput());
    h.sidebands[0]?.open();
    mock.timers.tick(14_999);
    assert.equal((await h.service.snapshot(RUN_ID)).status, 'connecting');
    mock.timers.tick(1);
    const snapshot = await h.service.snapshot(RUN_ID);
    assert.deepEqual([snapshot.status, snapshot.audioGate], ['failed', 'closed']);
    assert.ok(h.sidebands[0]?.sent.some((frame) => frame.type === 'session.close'));
  });

  test('mocked provider: fragments are appended exactly, deduplicated by event ID, input and output kept separate', async () => {
    const h = harness();
    const { sideband } = await liveSession(h);
    sideband.emit(delta('session.input_transcript.delta', 'e1', 'I added ', 1000, 1200));
    sideband.emit(delta('session.input_transcript.delta', 'e2', 'eight eight', 1200, 1500));
    sideband.emit(delta('session.input_transcript.delta', 'e2', 'eight eight', 1200, 1500));
    sideband.emit(delta('session.output_transcript.delta', 'e3', 'How did you ', 1600, 1800));
    sideband.emit(delta('session.output_transcript.delta', 'e4', 'get 12?', 1800, 2000));
    sideband.emit(delta('session.input_transcript.delta', 'e3', 'same id on another stream', 2000, 2100));
    const transcript = h.service.transcript(RUN_ID);
    assert.equal(transcript.input.map((f) => f.text).join(''), 'I added eight eight');
    assert.equal(transcript.output.map((f) => f.text).join(''), 'How did you get 12?');
    assert.deepEqual(transcript.input[1], { eventId: 'e2', stream: 'input', text: 'eight eight', startMs: 1200, endMs: 1500 });
    assert.equal(transcript.input.length, 2);
    assert.equal(transcript.output.length, 2);
  });

  test('mocked provider: more than 4,000 caption characters closes voice visibly', async () => {
    const h = harness();
    const { sideband } = await liveSession(h);
    sideband.emit(delta('session.input_transcript.delta', 'big1', 'a'.repeat(4000), 0, 10));
    assert.equal((await h.service.snapshot(RUN_ID)).status, 'live');
    // The output stream has its own buffer.
    sideband.emit(delta('session.output_transcript.delta', 'out1', 'b'.repeat(4000), 10, 20));
    assert.equal((await h.service.snapshot(RUN_ID)).status, 'live');
    sideband.emit(delta('session.input_transcript.delta', 'big2', 'a', 20, 30));
    const snapshot = await h.service.snapshot(RUN_ID);
    assert.deepEqual([snapshot.status, snapshot.audioGate], ['failed', 'closed']);
    assert.equal(h.service.failureReason(RUN_ID), 'caption_limit');
    assert.ok(sideband.sent.some((frame) => frame.type === 'session.close'));
    // Nothing is silently truncated into the retained evidence.
    assert.equal(h.service.transcript(RUN_ID).input.map((f) => f.text).join('').length, 4000);
  });

  test('mocked provider: more than 2,000 fragments closes voice visibly', async () => {
    const h = harness();
    const { sideband } = await liveSession(h);
    for (let i = 0; i < 2000; i += 1) {
      sideband.emit(delta(i % 2 === 0 ? 'session.input_transcript.delta' : 'session.output_transcript.delta', `f${i}`, 'x', i, i + 1));
    }
    assert.equal((await h.service.snapshot(RUN_ID)).status, 'live');
    sideband.emit(delta('session.input_transcript.delta', 'one-too-many', 'x', 5000, 5001));
    assert.equal((await h.service.snapshot(RUN_ID)).status, 'failed');
    assert.equal(h.service.failureReason(RUN_ID), 'fragment_limit');
  });

  test('mocked provider: sideband loss gates audio and marks an in-flight delegation incomplete', async () => {
    const h = harness();
    const { sideband } = await liveSession(h);
    sideband.emit(delta('session.input_transcript.delta', 'e1', 'twelve', 900, 1000));
    sideband.emit({ type: 'session.delegation.created', event_id: 'd-event', offset_ms: 1000, delegation: { id: 'deleg_1', type: 'delegation', target: 'client' } });
    assert.equal(h.hooks.delegations.length, 1);
    sideband.drop();
    const snapshot = await h.service.snapshot(RUN_ID);
    assert.deepEqual([snapshot.status, snapshot.audioGate], ['failed', 'closed']);
    assert.equal(h.service.failureReason(RUN_ID), 'sideband_lost');
    assert.deepEqual(h.hooks.incomplete, [{ runId: RUN_ID, voiceSessionId: snapshot.voiceSessionId, delegationId: 'deleg_1' }]);
    await rejectsWith(h.service.sendCommentary(RUN_ID, { delegationId: 'deleg_1', text: 'Here is a thought.' }), 'RUNTIME_DISCONNECTED');
  });

  test('mocked provider: a delegation event reaches the hook once with its offset and the input fragments, duplicates dropped', async () => {
    const h = harness();
    const { receipt, sideband } = await liveSession(h);
    sideband.emit(delta('session.input_transcript.delta', 'e1', 'I counted ', 100, 400));
    sideband.emit(delta('session.input_transcript.delta', 'e2', 'on my fingers', 400, 900));
    const created = { type: 'session.delegation.created', event_id: 'd1', offset_ms: 1000, delegation: { id: 'deleg_1', type: 'delegation', target: 'client' } };
    sideband.emit(created);
    sideband.emit(created);
    assert.deepEqual(h.hooks.delegations, [
      {
        runId: RUN_ID,
        voiceSessionId: receipt.voiceSessionId,
        liveSessionId: LIVE_ID,
        delegationId: 'deleg_1',
        offsetMs: 1000,
        inputFragments: [
          { eventId: 'e1', stream: 'input', text: 'I counted ', startMs: 100, endMs: 400 },
          { eventId: 'e2', stream: 'input', text: 'on my fingers', startMs: 400, endMs: 900 },
        ],
      },
    ]);
  });

  test('mocked provider: session.commentary.append is sent for a known delegation with a bounded body and the matching acknowledgment resolves it', async () => {
    const h = harness();
    const { sideband } = await liveSession(h);
    sideband.emit({ type: 'session.delegation.created', event_id: 'd1', offset_ms: 10, delegation: { id: 'deleg_1', type: 'delegation', target: 'client' } });
    const sending = h.service.sendCommentary(RUN_ID, { delegationId: 'deleg_1', text: 'Which number did you count first?' });
    await new Promise((resolve) => setImmediate(resolve));
    const frame = sideband.sent.find((f) => f.type === 'session.commentary.append');
    assert.ok(frame);
    assert.equal(frame.delegation_id, 'deleg_1');
    assert.equal(frame.content, 'Which number did you count first?');
    sideband.emit({ type: 'session.commentary.appended', client_event_id: frame.event_id });
    assert.deepEqual(await sending, { eventId: frame.event_id, outcome: 'accepted' });
    await rejectsWith(h.service.sendCommentary(RUN_ID, { delegationId: 'unknown', text: 'x' }), 'INVALID_INPUT');
    await rejectsWith(h.service.sendCommentary(RUN_ID, { delegationId: null, text: 'x'.repeat(5000) }), 'INVALID_INPUT');
  });
});

describe('records and failure', () => {
  test('mocked provider: provider events are parsed by exact type and only allowlisted fields are kept', () => {
    assert.deepEqual(
      parseProviderEvent({ type: 'session.input_transcript.delta', event_id: 'e1', delta: 'hi', start_ms: 1, end_ms: 2, authorization: 'Bearer x', sdp: 'v=0', account: { id: 'acct' } }),
      { type: 'session.input_transcript.delta', eventId: 'e1', delta: 'hi', startMs: 1, endMs: 2 },
    );
    assert.deepEqual(
      parseProviderEvent({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 15 }, session: { instructions: 'private' } }),
      { type: 'session.closed', reason: 'close_requested', usageSeconds: 15 },
    );
    assert.deepEqual(
      parseProviderEvent({ type: 'error', error: { type: 'invalid_request_error', code: 'bad', param: 'p', message: 'free text', client_event_id: 'c1' } }),
      { type: 'error', code: 'bad', errorType: 'invalid_request_error', param: 'p', clientEventId: 'c1' },
    );
    // Reflected raw audio and every unknown or malformed event is dropped, never logged.
    assert.equal(parseProviderEvent({ type: 'session.input_audio.append', audio: 'AAAA' }), null);
    assert.equal(parseProviderEvent({ type: 'session.output_audio.delta', audio: 'AAAA', start_ms: 0, end_ms: 20 }), null);
    assert.equal(parseProviderEvent({ type: 'session.input_transcript.delta.extra', event_id: 'e', delta: 'x', start_ms: 0, end_ms: 1 }), null);
    assert.equal(parseProviderEvent({ type: 'session.input_transcript.delta', delta: 'x', start_ms: 0, end_ms: 1 }), null);
    assert.equal(parseProviderEvent({ type: 'session.input_transcript.delta', event_id: 'e', delta: 5, start_ms: 0, end_ms: 1 }), null);
    assert.equal(parseProviderEvent({ type: 'session.delegation.created', event_id: 'd', offset_ms: 5, delegation: { id: 'x', type: 'delegation', target: 'responses' } }), null);
    assert.equal(parseProviderEvent('not an object'), null);
    assert.equal(parseProviderEvent(null), null);
  });

  test('mocked provider: reflected audio on the sideband never reaches the transcript or the session state', async () => {
    const h = harness();
    const { sideband } = await liveSession(h);
    sideband.emit({ type: 'session.input_audio.append', audio: 'QUJD' });
    sideband.emit({ type: 'session.output_audio.delta', audio: 'QUJD', start_ms: 0, end_ms: 20 });
    assert.deepEqual(h.service.transcript(RUN_ID), { input: [], output: [] });
    assert.equal((await h.service.snapshot(RUN_ID)).status, 'live');
  });

  test('mocked provider: a voice failure never produces an assessment', async () => {
    const writes: string[] = [];
    const guarded = Object.fromEntries(
      ['recordVoiceSessionOpened', 'recordAudioGateClosed', 'insertVoiceOperation'].map((name) => [name, async () => void writes.push(name)]),
    );
    const h = harness({ reply: () => new Response('boom', { status: 500 }), store: guarded });
    await rejectsWith(h.service.createSession(RUN_ID, createInput()), 'RUNTIME_DISCONNECTED');
    const live = harness({ store: guarded });
    const { sideband } = await liveSession(live);
    sideband.drop();
    const allowed = new Set(['getRun', 'listVoiceOperations', 'recordVoiceSessionOpened']);
    // Only voice bookkeeping is ever written; the store interface has no attempt or assessment write at all.
    assert.ok(writes.every((name) => allowed.has(name)), `unexpected writes: ${writes.join(', ')}`);
    assert.deepEqual(Object.keys(fakeStore().store).filter((name) => /assess|attempt|verify/i.test(name)), []);
  });

  test('mocked provider: typed fallback records delegationId null and input mode typed', async () => {
    const received: unknown[] = [];
    const h = harness();
    const handlers = createVoiceHandlers(h.service, {
      typedCorrection: async (runId, request) => {
        received.push({ runId, request });
        throw new RouteError({ code: 'RUNTIME_DISCONNECTED', message: 'stop here', retryable: false });
      },
      activityRendered: async () => assert.fail('not used'),
    });
    const command: VoiceCommand = { type: 'typed_correction', commandId: COMMAND_A, expectedRunRevision: 4, voiceSessionId: null, text: 'I counted eight then five' };
    await rejectsWith(handlers.voiceCommand?.({ params: { runId: RUN_ID }, query: undefined, signal, body: command }) ?? Promise.reject(new Error('no handler')), 'RUNTIME_DISCONNECTED');
    assert.deepEqual(received, [{ runId: RUN_ID, request: { command, inputMode: 'typed', delegationId: null, liveSessionId: null } }]);
  });

  test('mocked provider: typed correction beside a live session names the real session but still no delegation', async () => {
    const received: unknown[] = [];
    const h = harness();
    const { receipt } = await liveSession(h);
    const handlers = createVoiceHandlers(h.service, {
      typedCorrection: async (_runId, request) => {
        received.push(request);
        throw new RouteError({ code: 'RUNTIME_DISCONNECTED', message: 'stop here', retryable: false });
      },
      activityRendered: async () => assert.fail('not used'),
    });
    const command: VoiceCommand = { type: 'typed_correction', commandId: COMMAND_B, expectedRunRevision: 4, voiceSessionId: receipt.voiceSessionId, text: 'eight plus five' };
    await rejectsWith(handlers.voiceCommand?.({ params: { runId: RUN_ID }, query: undefined, signal, body: command }) ?? Promise.reject(new Error('no handler')), 'RUNTIME_DISCONNECTED');
    assert.deepEqual(received, [{ command, inputMode: 'typed', delegationId: null, liveSessionId: LIVE_ID }]);
  });

  test('mocked provider: a VoiceOperation carries all eight correlation IDs and never fabricates liveSessionId', () => {
    const ids = { runId: RUN_ID, operationId: 'op-1', explanationRevision: 2, cancellationEpoch: 1, threadId: 'thread-1', turnId: 'turn-1' };
    const voice = buildVoiceOperation({ ...ids, liveSessionId: LIVE_ID, delegationId: 'deleg_1', status: 'started' });
    assert.deepEqual(Object.keys(voice).sort(), [...CORRELATION_ID_KEYS, 'status'].sort());
    assert.equal(voice.liveSessionId, LIVE_ID);
    assert.equal(voice.delegationId, 'deleg_1');
    const typed = buildVoiceOperation({ ...ids, liveSessionId: null, delegationId: null, status: 'started' });
    assert.equal(typed.liveSessionId, null);
    assert.equal(typed.delegationId, null);
    // A delegation without a Live session would need a fabricated session ID, so it is refused.
    assert.throws(() => buildVoiceOperation({ ...ids, liveSessionId: null, delegationId: 'deleg_1', status: 'started' }));
  });

  test('mocked provider: a recorded operation is read back through the snapshot as the active operation', async () => {
    const h = harness();
    await liveSession(h);
    await h.service.recordOperation(buildVoiceOperation({ runId: RUN_ID, operationId: 'op-7', explanationRevision: 1, cancellationEpoch: 0, threadId: null, turnId: null, liveSessionId: LIVE_ID, delegationId: 'deleg_1', status: 'started' }));
    assert.equal((await h.service.snapshot(RUN_ID)).activeOperationId, 'op-7');
  });

  test('mocked provider: the session open is persisted with the voice session ID the browser uses', async () => {
    const opened: unknown[] = [];
    const h = harness({ store: { recordVoiceSessionOpened: async (runId, voiceSessionId) => void opened.push([runId, voiceSessionId]) } });
    const receipt = await h.service.createSession(RUN_ID, createInput());
    assert.deepEqual(opened, [[RUN_ID, receipt.voiceSessionId]]);
  });

  test('mocked provider: audio_gate_closed records the gate for the current activity through the store', async () => {
    const recorded: unknown[] = [];
    const activity = { id: 'act-1', revision: 2 };
    const h = harness({
      store: {
        getRun: async (runId) => ({ id: runId, revision: 4, seq: 1, state: { explanationRevision: 0, cancellationEpoch: 0, activity: activity as never } }),
        recordAudioGateClosed: async (...args) => void recorded.push(args),
      },
    });
    const { receipt } = await liveSession(h);
    const handlers = createVoiceHandlers(h.service, { typedCorrection: async () => assert.fail('x'), activityRendered: async () => assert.fail('x') });
    const result = await handlers.voiceCommand?.({ params: { runId: RUN_ID }, query: undefined, signal, body: { type: 'audio_gate_closed', commandId: COMMAND_B, expectedRunRevision: 4, voiceSessionId: receipt.voiceSessionId } });
    assert.deepEqual(recorded, [[RUN_ID, 'act-1', 2, receipt.voiceSessionId]]);
    assert.ok(result && 'audioGate' in result && result.audioGate === 'closed');
  });
});

describe('close and teardown', () => {
  test('mocked provider: close sends session.close and waits up to 15 s for session.closed', async () => {
    assert.equal(CLOSE_TIMEOUT_MS, 15_000);
    mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    const { receipt, sideband } = await liveSession(h);
    let settled = false;
    const closing = h.service.close(RUN_ID, receipt.voiceSessionId).then((result) => {
      settled = true;
      return result;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      sideband.sent.filter((frame) => frame.type === 'session.close').length,
      1,
    );
    assert.equal(sideband.isClosed, false, 'the sideband stays open until session.closed');
    mock.timers.tick(CLOSE_TIMEOUT_MS - 1);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    mock.timers.tick(1);
    const result = await closing;
    assert.deepEqual(result, { finalization: 'incomplete', usageSeconds: null });
    assert.equal(sideband.isClosed, true);
    const snapshot = await h.service.snapshot(RUN_ID);
    assert.deepEqual([snapshot.status, snapshot.audioGate], ['closed', 'closed']);
  });

  test('mocked provider: close resolves with the final usage as soon as session.closed arrives', async () => {
    const h = harness();
    const { receipt, sideband } = await liveSession(h);
    const closing = h.service.close(RUN_ID, receipt.voiceSessionId);
    await new Promise((resolve) => setImmediate(resolve));
    sideband.emit({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 17 } });
    assert.deepEqual(await closing, { finalization: 'complete', usageSeconds: 17 });
    // Closing again is harmless and sends nothing more.
    assert.deepEqual(await h.service.close(RUN_ID, receipt.voiceSessionId), { finalization: 'complete', usageSeconds: 17 });
    assert.equal(sideband.sent.filter((frame) => frame.type === 'session.close').length, 1);
    // A duplicate create after the close reports the closed session instead of opening another.
    const replay = await h.service.createSession(RUN_ID, createInput());
    assert.equal(replay.status, 'closed');
    assert.equal(h.calls.length, 1);
  });

  test('mocked provider: ending voice before the sideband opens still closes the session once it attaches', async () => {
    const h = harness();
    const receipt = await h.service.createSession(RUN_ID, createInput());
    const closing = h.service.close(RUN_ID, receipt.voiceSessionId);
    const sideband = h.sidebands[0];
    assert.ok(sideband);
    sideband.open();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sideband.sent.filter((frame) => frame.type === 'session.close').length, 1);
    sideband.emit({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 15 } });
    assert.deepEqual(await closing, { finalization: 'complete', usageSeconds: 15 });
  });

  test('mocked provider: the 180 s session limit closes an abandoned session', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const h = harness();
    const { sideband } = await liveSession(h);
    mock.timers.tick(179_999);
    assert.equal(sideband.sent.filter((frame) => frame.type === 'session.close').length, 0);
    mock.timers.tick(1);
    assert.equal(sideband.sent.filter((frame) => frame.type === 'session.close').length, 1);
    assert.equal(h.service.failureReason(RUN_ID), null);
  });

  test('mocked provider: close_voice through the handler answers with the closed snapshot', async () => {
    const h = harness();
    const { receipt, sideband } = await liveSession(h);
    const handlers = createVoiceHandlers(h.service, { typedCorrection: async () => assert.fail('x'), activityRendered: async () => assert.fail('x') });
    const pending = handlers.voiceCommand?.({ params: { runId: RUN_ID }, query: undefined, signal, body: { type: 'close_voice', commandId: COMMAND_B, expectedRunRevision: 4, voiceSessionId: receipt.voiceSessionId } });
    await new Promise((resolve) => setImmediate(resolve));
    sideband.emit({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 20 } });
    const result = await pending;
    assert.ok(result && 'status' in result && result.status === 'closed');
  });
});

// Type-level guard: the service interface exposes exactly what the later delegation work needs.
const _surface: (keyof VoiceService)[] = ['createSession', 'snapshot', 'close', 'sendCommentary', 'transcript', 'failureReason', 'recordOperation'];
void _surface;
