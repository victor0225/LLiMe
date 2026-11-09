import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { VoiceSnapshot } from '../src/routes.js';
import { type ChannelLike, createVoiceClient, type PeerLike, type PlaybackLike, type StreamLike, type TrackLike, type VoiceApi, type VoiceEnv } from '../web/voice.js';

const SESSION = 'voice_session_1';

// Scripted browser objects that write every action into one shared log, so tests can assert order.
function browser(options: { denyMicrophone?: boolean } = {}) {
  const log: string[] = [];
  const track: TrackLike & { enabled: boolean } = {
    enabled: true,
    stop() {
      log.push('track.stop');
    },
  };
  const microphone: StreamLike = { getAudioTracks: () => [track] };
  const channel: ChannelLike = {
    onmessage: null,
    close() {
      log.push('channel.close');
    },
  };
  const peer: PeerLike = {
    iceGatheringState: 'complete',
    connectionState: 'connected',
    localDescription: { sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' },
    ontrack: null,
    onconnectionstatechange: null,
    onicegatheringstatechange: null,
    addTrack() {
      log.push(`peer.addTrack(enabled=${String(track.enabled)})`);
    },
    createDataChannel(label) {
      log.push(`peer.createDataChannel(${label})`);
      return channel;
    },
    async createOffer() {
      log.push('peer.createOffer');
      return { type: 'offer', sdp: 'v=0\r\n' };
    },
    async setLocalDescription() {
      log.push('peer.setLocalDescription');
    },
    async setRemoteDescription() {
      log.push('peer.setRemoteDescription');
    },
    close() {
      log.push('peer.close');
    },
  };
  const playback: PlaybackLike = {
    srcObject: null,
    muted: false,
    pause() {
      log.push('playback.pause');
    },
    async play() {
      log.push('playback.play');
    },
  };
  const env: VoiceEnv = {
    getMicrophone: async () => {
      if (options.denyMicrophone) throw new Error('NotAllowedError');
      return microphone;
    },
    createPeer: () => peer,
    createPlayback: () => playback,
  };
  return { env, log, track, channel, peer, playback };
}

function server(initial: Partial<VoiceSnapshot> = {}) {
  const log: string[] = [];
  const state = { snapshot: { voiceSessionId: SESSION, status: 'live', activeOperationId: null, explanationRevision: 0, cancellationEpoch: 0, audioGate: 'open', ...initial } as VoiceSnapshot };
  const typed: unknown[] = [];
  const api: VoiceApi = {
    async createSession() {
      log.push('server.createSession');
      return { voiceSessionId: SESSION, sdpAnswer: 'v=0\r\n', status: 'connecting' };
    },
    async snapshot() {
      return state.snapshot;
    },
    async closeVoice() {
      log.push('server.closeVoice');
    },
    async audioGateClosed() {
      log.push('server.audioGateClosed');
    },
    async typedCorrection(text, voiceSessionId) {
      typed.push({ text, voiceSessionId });
    },
  };
  return { api, log, state, typed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

async function liveClient(options: { denyMicrophone?: boolean; snapshot?: Partial<VoiceSnapshot> } = {}) {
  const b = browser(options);
  const s = server(options.snapshot);
  const client = createVoiceClient({ env: b.env, api: { ...s.api, audioGateClosed: async (id) => { b.log.push('ack'); await s.api.audioGateClosed(id); } }, pollMs: 2 });
  return { b, s, client };
}

describe('browser voice client', () => {
  test('mocked provider: teardown pauses remote audio, stops tracks, closes the peer, and only then acknowledges', async () => {
    const { b, s, client } = await liveClient();
    await client.start();
    await settle();
    assert.equal(client.getSnapshot().phase, 'live');
    b.log.length = 0;
    await client.teardownForIndependentWork();
    assert.deepEqual(b.log, ['playback.pause', 'track.stop', 'channel.close', 'peer.close', 'ack']);
    assert.deepEqual(s.log.slice(-2), ['server.audioGateClosed', 'server.closeVoice']);
    assert.equal(b.playback.srcObject, null);
    assert.equal(b.track.enabled, false);
    assert.equal(client.getSnapshot().status, 'off');
  });

  test('mocked provider: the data channel is created before the offer and the microphone and playback stay gated until the server says live', async () => {
    const { b, s, client } = await liveClient({ snapshot: { status: 'connecting', audioGate: 'closed' } });
    await client.start();
    await settle();
    assert.ok(b.log.indexOf('peer.createDataChannel(oai-events)') < b.log.indexOf('peer.createOffer'));
    assert.ok(b.log.includes('peer.addTrack(enabled=false)'));
    assert.equal(b.track.enabled, false);
    assert.equal(b.playback.muted, true);
    assert.equal(client.getSnapshot().phase, 'connecting');
    assert.equal(client.getSnapshot().status, null);
    s.state.snapshot = { ...s.state.snapshot, status: 'live', audioGate: 'open' };
    await settle();
    assert.equal(client.getSnapshot().phase, 'live');
    assert.equal(client.getSnapshot().status, 'listening');
    assert.equal(b.track.enabled, true);
    assert.equal(b.playback.muted, false);
    await client.end();
  });

  test('mocked provider: captions are the actual transcript fragments, appended exactly, deduplicated, input and output apart', async () => {
    const { b, client } = await liveClient();
    await client.start();
    await settle();
    const deliver = (type: string, id: string, delta: string) => b.channel.onmessage?.({ data: JSON.stringify({ type, event_id: id, delta, start_ms: 0, end_ms: 1 }) });
    deliver('session.input_transcript.delta', 'a', 'I counted ');
    deliver('session.input_transcript.delta', 'b', 'eight eight');
    deliver('session.input_transcript.delta', 'b', 'eight eight');
    deliver('session.output_transcript.delta', 'c', 'How did you ');
    deliver('session.output_transcript.delta', 'd', 'get 12?');
    b.channel.onmessage?.({ data: 'not json' });
    b.channel.onmessage?.({ data: JSON.stringify({ type: 'session.output_audio.delta', event_id: 'z', delta: 'QUJD' }) });
    assert.deepEqual(client.getSnapshot().captions, { input: 'I counted eight eight', output: 'How did you get 12?' });
    assert.equal(client.getSnapshot().status, 'speaking');
    await client.end();
  });

  test('mocked provider: mute disables the microphone track and leaves the session open', async () => {
    const { b, s, client } = await liveClient();
    await client.start();
    await settle();
    client.toggleMute();
    assert.equal(b.track.enabled, false);
    assert.equal(client.getSnapshot().status, 'muted');
    assert.ok(!s.log.includes('server.closeVoice'));
    client.toggleMute();
    assert.equal(b.track.enabled, true);
    assert.equal(client.getSnapshot().status, 'listening');
    await client.end();
  });

  test('mocked provider: End voice releases all local audio first and then asks the server to close', async () => {
    const { b, s, client } = await liveClient();
    await client.start();
    await settle();
    b.log.length = 0;
    await client.end();
    assert.deepEqual(b.log, ['playback.pause', 'track.stop', 'channel.close', 'peer.close']);
    assert.equal(s.log.at(-1), 'server.closeVoice');
    assert.equal(client.getSnapshot().phase, 'ended');
  });

  test('mocked provider: interrupting playback pauses model audio and resume plays it again', async () => {
    const { b, client } = await liveClient();
    await client.start();
    await settle();
    b.log.length = 0;
    client.interruptPlayback();
    assert.deepEqual(b.log, ['playback.pause']);
    assert.equal(b.playback.muted, true);
    client.resumePlayback();
    assert.equal(b.playback.muted, false);
    assert.equal(b.log.at(-1), 'playback.play');
    await client.end();
  });

  test('mocked provider: a session the server reports as failed tears audio down and shows the disconnected status', async () => {
    const { b, s, client } = await liveClient();
    await client.start();
    await settle();
    b.log.length = 0;
    s.state.snapshot = { ...s.state.snapshot, status: 'failed', audioGate: 'closed' };
    await settle();
    assert.deepEqual(b.log.slice(0, 4), ['playback.pause', 'track.stop', 'channel.close', 'peer.close']);
    assert.equal(client.getSnapshot().phase, 'failed');
    assert.equal(client.getSnapshot().status, 'disconnected');
  });

  test('mocked provider: a microphone track that ends during a live session leaves listening for the unavailable recovery once and closes the session', async () => {
    const { b, s, client } = await liveClient();
    await client.start();
    await settle();
    assert.equal(client.getSnapshot().status, 'listening');
    const ended = b.track.onended;
    assert.ok(ended);
    ended();
    ended();
    await settle();
    assert.deepEqual([client.getSnapshot().phase, client.getSnapshot().status, client.getSnapshot().failure], ['failed', 'disconnected', 'unavailable']);
    assert.equal(s.log.filter((entry) => entry === 'server.closeVoice').length, 1);
    assert.equal(b.track.onended, null);
  });

  test('mocked provider: a denied microphone fails visibly and typed input still works, labeled as typed', async () => {
    const { s, client } = await liveClient({ denyMicrophone: true });
    await client.start();
    assert.equal(client.getSnapshot().phase, 'failed');
    assert.equal(client.getSnapshot().failure, 'permission');
    assert.ok(!s.log.includes('server.createSession'), 'no session is requested without a microphone');
    await client.sendTyped('I counted eight then five');
    assert.deepEqual(s.typed, [{ text: 'I counted eight then five', voiceSessionId: null }]);
    assert.deepEqual(client.getSnapshot().typedEntries, ['I counted eight then five']);
    assert.deepEqual(client.getSnapshot().captions, { input: '', output: '' }, 'typed text never appears as a spoken caption');
  });

  test('mocked provider: teardown before any session needs no server acknowledgment', async () => {
    const { s, client } = await liveClient();
    await client.teardownForIndependentWork();
    assert.deepEqual(s.log, []);
  });
});
