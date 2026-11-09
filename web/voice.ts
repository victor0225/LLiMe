// Browser side of the voice transport: microphone capture, the WebRTC peer, captions from the
// transcripts the session actually produced, mute, End voice, a playback-interruption hook, full
// audio teardown before independent work, and the typed fallback (always labeled as typed).
// The provider key never reaches this file: the server exchanges the SDP offer and answers with a
// session ID and the SDP answer only.
import { useSyncExternalStore } from 'react';
import type { VOICE_STATUS_COPY } from '@core/copy';
import { ROUTES, routePath, type VoiceSessionOutputSchema, type VoiceSnapshot } from '@core/routes';
import { z } from 'zod';
import type { EventStore } from './lib/event-store.js';

// The label of the one data channel the session opens; it must exist before the offer is created.
const EVENTS_CHANNEL = 'oai-events';
const ICE_TIMEOUT_MS = 10_000;
const READY_TIMEOUT_MS = 15_000;
const POLL_MS = 1_000;
// How long the tutor still counts as speaking after the last spoken caption.
const SPEAKING_HOLD_MS = 1_500;

// ---------------------------------------------------------------------------------------------
// What the client needs from the browser and from the server, as narrow interfaces. The real
// WebRTC, audio and fetch objects satisfy them; tests supply scripted ones.

export type TrackLike = { enabled: boolean; stop: () => void };
export type StreamLike = { getAudioTracks: () => TrackLike[] };
export type ChannelLike = {
  onmessage: ((event: { data: unknown }) => void) | null;
  close: () => void;
};
export type PeerLike = {
  readonly iceGatheringState: string;
  readonly connectionState: string;
  readonly localDescription: { sdp: string } | null;
  ontrack: ((event: { streams: readonly StreamLike[] }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  onicegatheringstatechange: (() => void) | null;
  addTrack: (track: TrackLike, stream: StreamLike) => void;
  createDataChannel: (label: string) => ChannelLike;
  createOffer: () => Promise<{ type: 'offer'; sdp?: string }>;
  setLocalDescription: (description: { type: 'offer'; sdp?: string }) => Promise<void>;
  setRemoteDescription: (description: { type: 'answer'; sdp: string }) => Promise<void>;
  close: () => void;
};
export type PlaybackLike = { srcObject: StreamLike | null; muted: boolean; pause: () => void; play: () => Promise<void> };

export type VoiceEnv = {
  getMicrophone: () => Promise<StreamLike>;
  createPeer: () => PeerLike;
  createPlayback: () => PlaybackLike;
};

export type VoiceApi = {
  createSession: (sdpOffer: string) => Promise<z.input<typeof VoiceSessionOutputSchema>>;
  snapshot: () => Promise<VoiceSnapshot>;
  closeVoice: (voiceSessionId: string) => Promise<void>;
  audioGateClosed: (voiceSessionId: string) => Promise<void>;
  typedCorrection: (text: string, voiceSessionId: string | null) => Promise<void>;
};

// ---------------------------------------------------------------------------------------------
// State.

type StatusKey = keyof typeof VOICE_STATUS_COPY;

export type VoiceFailure = 'permission' | 'connection' | 'unavailable';
export type VoicePhase = 'idle' | 'starting' | 'connecting' | 'live' | 'ending' | 'ended' | 'failed';

export type VoiceView = {
  readonly phase: VoicePhase;
  // The key of the status line to show (from the shared copy); null while voice is not in use.
  readonly status: StatusKey | null;
  readonly isMuted: boolean;
  // Text the session actually transcribed: the student's words and the tutor's words, kept apart.
  readonly captions: { readonly input: string; readonly output: string };
  // Corrections the student typed. They are shown as typed, never as speech.
  readonly typedEntries: readonly string[];
  readonly failure: VoiceFailure | null;
  readonly voiceSessionId: string | null;
};

const IDLE: VoiceView = { phase: 'idle', status: null, isMuted: false, captions: { input: '', output: '' }, typedEntries: [], failure: null, voiceSessionId: null };

// Data-channel events used for captions only; the server's sideband is the canonical record.
const TranscriptEventSchema = z.object({ type: z.enum(['session.input_transcript.delta', 'session.output_transcript.delta']), event_id: z.string().min(1), delta: z.string() });

export type VoiceClientOptions = {
  env: VoiceEnv;
  api: VoiceApi;
  pollMs?: number;
  readyTimeoutMs?: number;
  iceTimeoutMs?: number;
};

export type VoiceClient = ReturnType<typeof createVoiceClient>;

export function createVoiceClient({ env, api, pollMs = POLL_MS, readyTimeoutMs = READY_TIMEOUT_MS, iceTimeoutMs = ICE_TIMEOUT_MS }: VoiceClientOptions) {
  const listeners = new Set<() => void>();
  let view = IDLE;
  let peer: PeerLike | null = null;
  let channel: ChannelLike | null = null;
  let microphone: StreamLike | null = null;
  let playback: PlaybackLike | null = null;
  let poller: ReturnType<typeof setTimeout> | null = null;
  let speakingTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  const seenEvents = new Set<string>();

  const publish = (patch: Partial<VoiceView>) => {
    view = { ...view, ...patch };
    for (const listener of listeners) listener();
  };

  const statusFor = (phase: VoicePhase, isMuted: boolean, isSpeaking = false): StatusKey | null => {
    if (phase === 'failed') return 'disconnected';
    if (phase === 'ended') return 'off';
    if (phase !== 'live') return null;
    if (isMuted) return 'muted';
    return isSpeaking ? 'speaking' : 'listening';
  };

  // Releases every audio resource in a fixed order: stop playback and detach its stream, stop the
  // microphone tracks, then close the peer. Resolves only once all of that has happened.
  async function teardownAudio(): Promise<void> {
    generation += 1;
    if (poller) clearTimeout(poller);
    if (speakingTimer) clearTimeout(speakingTimer);
    poller = null;
    speakingTimer = null;
    if (playback) {
      playback.pause();
      playback.srcObject = null;
    }
    for (const track of microphone?.getAudioTracks() ?? []) {
      track.enabled = false;
      track.stop();
    }
    if (channel) channel.onmessage = null;
    channel?.close();
    if (peer) {
      peer.ontrack = null;
      peer.onconnectionstatechange = null;
      peer.onicegatheringstatechange = null;
      peer.close();
    }
    playback = null;
    microphone = null;
    channel = null;
    peer = null;
  }

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  async function gatherIce(connection: PeerLike): Promise<void> {
    if (connection.iceGatheringState === 'complete') return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ICE gathering timed out')), iceTimeoutMs);
      connection.onicegatheringstatechange = () => {
        if (connection.iceGatheringState !== 'complete') return;
        clearTimeout(timer);
        resolve();
      };
    });
  }

  function onChannelMessage(event: { data: unknown }) {
    if (typeof event.data !== 'string') return;
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      return;
    }
    const parsed = TranscriptEventSchema.safeParse(raw);
    if (!parsed.success || seenEvents.has(parsed.data.event_id)) return;
    seenEvents.add(parsed.data.event_id);
    // Fragments are appended exactly as received: spaces and repeated words included.
    if (parsed.data.type === 'session.input_transcript.delta') {
      publish({ captions: { ...view.captions, input: view.captions.input + parsed.data.delta } });
      return;
    }
    publish({ captions: { ...view.captions, output: view.captions.output + parsed.data.delta }, status: statusFor(view.phase, view.isMuted, true) });
    if (speakingTimer) clearTimeout(speakingTimer);
    speakingTimer = setTimeout(() => publish({ status: statusFor(view.phase, view.isMuted) }), SPEAKING_HOLD_MS);
  }

  // Polls the server's view of the session. Audio is allowed only while the server says it is live;
  // if the server reports the session gone, the local audio is torn down and the failure is shown.
  async function watch(run: number, voiceSessionId: string) {
    const deadline = Date.now() + readyTimeoutMs;
    for (;;) {
      if (run !== generation) return;
      const snapshot = await api.snapshot().catch(() => null);
      if (run !== generation) return;
      if (snapshot && snapshot.voiceSessionId === voiceSessionId) {
        if (snapshot.status === 'live' && snapshot.audioGate === 'open' && view.phase === 'connecting') openAudio();
        if (snapshot.status === 'failed' || snapshot.status === 'closed' || snapshot.status === 'expired') return lose('connection');
      }
      if (view.phase === 'connecting' && Date.now() > deadline) return lose('connection');
      await new Promise<void>((resolve) => (poller = setTimeout(resolve, pollMs)));
    }
  }

  function openAudio() {
    for (const track of microphone?.getAudioTracks() ?? []) track.enabled = !view.isMuted;
    if (playback) {
      playback.muted = false;
      void playback.play().catch(() => {});
    }
    publish({ phase: 'live', status: statusFor('live', view.isMuted) });
  }

  // The session is gone or unusable: audio stops now, and typed input stays available.
  async function lose(failure: VoiceFailure) {
    const voiceSessionId = view.voiceSessionId;
    await teardownAudio();
    publish({ phase: 'failed', status: 'disconnected', failure });
    if (voiceSessionId) await api.closeVoice(voiceSessionId).catch(() => {});
  }

  async function start(): Promise<void> {
    if (view.phase !== 'idle' && view.phase !== 'ended' && view.phase !== 'failed') return;
    const typedEntries = view.typedEntries;
    seenEvents.clear();
    view = { ...IDLE, typedEntries };
    publish({ phase: 'starting' });
    const run = (generation += 1);
    try {
      microphone = await env.getMicrophone().catch(() => {
        throw new MicrophoneDenied();
      });
      // The microphone starts disabled and playback starts muted until the server reports the
      // session ready.
      for (const track of microphone.getAudioTracks()) track.enabled = false;
      playback = env.createPlayback();
      playback.muted = true;
      const connection = env.createPeer();
      peer = connection;
      connection.ontrack = (event) => {
        if (playback && event.streams[0]) playback.srcObject = event.streams[0];
      };
      connection.onconnectionstatechange = () => {
        if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') void lose('connection');
      };
      for (const track of microphone.getAudioTracks()) connection.addTrack(track, microphone);
      // The data channel is created before the offer so it is part of the negotiation.
      channel = connection.createDataChannel(EVENTS_CHANNEL);
      channel.onmessage = onChannelMessage;
      await connection.setLocalDescription(await connection.createOffer());
      await gatherIce(connection);
      const sdpOffer = connection.localDescription?.sdp;
      if (!sdpOffer) throw new Error('The browser produced no SDP offer');
      publish({ phase: 'connecting' });
      const session = await api.createSession(sdpOffer);
      if (run !== generation) {
        await api.closeVoice(session.voiceSessionId).catch(() => {});
        return;
      }
      publish({ voiceSessionId: session.voiceSessionId });
      await connection.setRemoteDescription({ type: 'answer', sdp: session.sdpAnswer });
      void watch(run, session.voiceSessionId);
    } catch (error) {
      if (run !== generation) return;
      await teardownAudio();
      publish({ phase: 'failed', status: 'disconnected', failure: error instanceof MicrophoneDenied ? 'permission' : 'unavailable' });
    }
  }

  function setMuted(isMuted: boolean) {
    if (view.phase !== 'live') return;
    for (const track of microphone?.getAudioTracks() ?? []) track.enabled = !isMuted;
    publish({ isMuted, status: statusFor('live', isMuted) });
  }

  return {
    subscribe: (onChange: () => void) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getSnapshot: () => view,
    start,
    // Muting silences the microphone only. It neither closes the session nor stops its billing.
    toggleMute: () => setMuted(!view.isMuted),
    // Stops model audio at once, for example when a correction replaces what the tutor was saying.
    // Playback resumes with resumePlayback once corrected content is ready to speak.
    interruptPlayback: () => {
      if (!playback) return;
      playback.muted = true;
      playback.pause();
    },
    resumePlayback: () => {
      if (!playback || view.phase !== 'live') return;
      playback.muted = false;
      void playback.play().catch(() => {});
    },
    // End voice: local audio is released first, then the server closes the session.
    async end() {
      const voiceSessionId = view.voiceSessionId;
      if (view.phase === 'idle' || view.phase === 'ended') return;
      publish({ phase: 'ending' });
      await teardownAudio();
      publish({ phase: 'ended', status: 'off' });
      if (voiceSessionId) await api.closeVoice(voiceSessionId).catch(() => {});
    },
    // Called before independent work. Resolves only after microphone, playback and peer are gone and
    // the server has recorded that, so the caller can enable the independent problem. A session
    // that never started needs no acknowledgment: no recorded session means the gate is closed.
    async teardownForIndependentWork() {
      const voiceSessionId = view.voiceSessionId;
      await teardownAudio();
      if (view.phase !== 'idle') publish({ phase: 'ended', status: 'off' });
      if (!voiceSessionId) return;
      await api.audioGateClosed(voiceSessionId);
      await api.closeVoice(voiceSessionId).catch(() => {});
    },
    // The typed fallback. The entry is recorded and shown as typed; it is never presented as speech.
    async sendTyped(text: string) {
      await api.typedCorrection(text, view.voiceSessionId);
      publish({ typedEntries: [...view.typedEntries, text] });
    },
  };
}

class MicrophoneDenied extends Error {}

// ---------------------------------------------------------------------------------------------
// Real browser wiring.

// Browser globals are read by name and checked once, so this file type-checks for the server tests
// (which have no DOM types) as well as for the browser build.
function browserGlobal(name: string): unknown {
  return Reflect.get(globalThis, name);
}

function construct(name: string): unknown {
  const constructor = browserGlobal(name);
  if (typeof constructor !== 'function') throw new Error(`${name} is not available in this browser`);
  return Reflect.construct(constructor, []);
}

export function browserVoiceEnv(): VoiceEnv {
  return {
    getMicrophone: () => {
      const devices = Reflect.get(Object(browserGlobal('navigator')), 'mediaDevices');
      return Reflect.apply(Reflect.get(Object(devices), 'getUserMedia'), devices, [{ audio: { echoCancellation: true } }]);
    },
    createPeer: () => {
      const created = construct('RTCPeerConnection');
      if (!isPeer(created)) throw new Error('RTCPeerConnection is not usable');
      return created;
    },
    createPlayback: () => {
      const created = construct('Audio');
      if (!isPlayback(created)) throw new Error('Audio playback is not usable');
      Reflect.set(created, 'autoplay', true);
      return created;
    },
  };
}

const isPeer = (value: unknown): value is PeerLike => typeof value === 'object' && value !== null && typeof Reflect.get(value, 'createDataChannel') === 'function';
const isPlayback = (value: unknown): value is PlaybackLike => typeof value === 'object' && value !== null && typeof Reflect.get(value, 'pause') === 'function';

// Voice requests go through the run's single mutation queue (revision-checked, one at a time);
// the snapshot is a plain read.
export function eventStoreVoiceApi(store: EventStore, runId: string): VoiceApi {
  const newId = () => crypto.randomUUID();
  return {
    async createSession(sdpOffer) {
      const result = await store.sendRunCommand('createVoiceSession', (run) => ({ commandId: newId(), expectedRevision: run.revision, sdpOffer }));
      if (!result) throw new Error('The voice session request was dropped');
      return result;
    },
    async snapshot() {
      const response = await fetch(routePath('voiceSnapshot', { runId }));
      if (!response.ok) throw new Error(`The server answered HTTP ${response.status}`);
      return ROUTES.voiceSnapshot.response.parse(await response.json());
    },
    async closeVoice(voiceSessionId) {
      await store.sendRunCommand('voiceCommand', (run) => ({ type: 'close_voice', commandId: newId(), expectedRunRevision: run.revision, voiceSessionId }));
    },
    async audioGateClosed(voiceSessionId) {
      await store.sendRunCommand('voiceCommand', (run) => ({ type: 'audio_gate_closed', commandId: newId(), expectedRunRevision: run.revision, voiceSessionId }));
    },
    async typedCorrection(text, voiceSessionId) {
      await store.sendRunCommand('voiceCommand', (run) => ({ type: 'typed_correction', commandId: newId(), expectedRunRevision: run.revision, voiceSessionId, text }));
    },
  };
}

export function useVoice(client: VoiceClient): VoiceView {
  return useSyncExternalStore(client.subscribe, client.getSnapshot);
}

// ---------------------------------------------------------------------------------------------
// Which revision may reopen the speaker after a correction. Playback itself is the client's
// interruptPlayback and resumePlayback; this decides only when to call them.

export type CorrectionPlayback = {
  readonly isInterrupted: boolean;
  // Call the moment a correction is sent or observed (a newer explanation revision in the run).
  correctionStarted(explanationRevision: number): void;
  // Call after the server accepted activity_rendered for the activity of `explanationRevision`.
  // Only the replacement for the newest correction reopens the speaker, so the child hears the
  // corrected commentary and never the stale one.
  replacementRendered(explanationRevision: number): boolean;
};

export function createCorrectionPlayback(client: Pick<VoiceClient, 'interruptPlayback' | 'resumePlayback'>): CorrectionPlayback {
  let awaitedRevision: number | null = null;
  return {
    get isInterrupted() {
      return awaitedRevision !== null;
    },
    correctionStarted(explanationRevision) {
      awaitedRevision = Math.max(awaitedRevision ?? explanationRevision, explanationRevision);
      client.interruptPlayback();
    },
    replacementRendered(explanationRevision) {
      if (awaitedRevision === null || explanationRevision < awaitedRevision) return false;
      awaitedRevision = null;
      client.resumePlayback();
      return true;
    },
  };
}
