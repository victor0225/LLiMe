// Live voice check. Opens exactly one GPT-Live session the way the app does: a browser peer
// (headless Chrome with a fake, disabled microphone) sends its SDP offer to a local server, the voice
// service creates the session with the project key and attaches its sideband to the same session.
// The check waits until the service reports the session live (sideband attached and session.started
// observed), asks the tutor for one short greeting, confirms a transcript and remote audio arrived,
// closes the session through the service, waits for session.closed and prints a sanitized JSON log.
// It never prints the key, SDP, transcripts or the full session ID. Exit code 0 only when every
// check passed. Run state lives in memory; this check does not touch the database.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { loadConfig } from '../src/config.js';
import type { VoiceOperation } from '../src/domain.js';
import { SDP_MAX_BYTES } from '../src/routes.js';
import { LIVE_MODEL, type CloseResult, createVoiceService, type VoiceStore } from '../src/voice.js';

const config = loadConfig();
const PORT = config.port;
const ORIGIN = config.appOrigin;
const RUN_ID = `live-voice-${process.pid}`;
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Chrome start, fake microphone and ICE gathering all happen before an offer arrives.
const OFFER_TIMEOUT_MS = 30_000;
// From the create request until the session is live.
const LIVE_TIMEOUT_MS = 15_000;
// From the greeting request until a transcript fragment and remote audio were both observed.
const RESPONSE_TIMEOUT_MS = 20_000;
// Last resort if a bounded wait above misbehaves; every normal path finishes well before this.
const WATCHDOG_MS = 120_000;
const PROFILE_RELEASE_TIMEOUT_MS = 10_000;
const SAFE_TOKEN = /^[\w.:-]{1,120}$/;

const state = {
  voiceSessionId: undefined as string | undefined,
  createMs: undefined as number | undefined,
  createError: undefined as string | undefined,
  liveMs: undefined as number | undefined,
  commentaryOutcome: undefined as string | undefined,
  outputFragments: 0,
  peerConnection: 'new',
  dataChannelOpened: false,
  audioBytesReceived: 0,
  close: undefined as CloseResult | undefined,
  statusAfterClose: undefined as string | undefined,
  pageError: undefined as string | undefined,
  cleanupError: undefined as string | undefined,
  createRequest: undefined as Promise<void> | undefined,
  interrupted: false,
};

// Run state the service needs, kept in memory: this is a provider check, not a database check.
function memoryStore(): VoiceStore {
  const operations: VoiceOperation[] = [];
  return {
    getRun: async (runId) => ({ id: runId, revision: 0, seq: 0, state: { explanationRevision: 0, cancellationEpoch: 0, activity: null } }),
    recordVoiceSessionOpened: async () => {},
    recordAudioGateClosed: async () => {},
    insertVoiceOperation: async (operation) => {
      operations.push(operation);
      return operation;
    },
    listVoiceOperations: async () => operations,
  };
}

const service = createVoiceService({ apiKey: config.openaiApiKey, store: memoryStore() });

// Chrome needs no credentials, so none reach it.
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(KEY|PASSWORD|SECRET|TOKEN)/i.test(name)));
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= SDP_MAX_BYTES + 1024) chunks.push(chunk);
    });
    request.on('end', () => resolve(size <= SDP_MAX_BYTES + 1024 ? Buffer.concat(chunks).toString('utf8') : undefined));
    request.on('error', () => resolve(undefined));
  });
}

function send(response: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const OfferBody = z.object({ sdp: z.string() });

async function handleSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (state.createRequest) return send(response, 409, { error: 'One session per check run' });
  const offer = OfferBody.safeParse(parseJson((await readBody(request)) ?? ''));
  if (!offer.success) return send(response, 400, { error: 'Invalid SDP offer' });
  const startedAt = Date.now();
  let answer: string | undefined;
  state.createRequest = service.createSession(RUN_ID, { commandId: randomUUID(), expectedRevision: 0, sdpOffer: offer.data.sdp }).then(
    (receipt) => {
      state.createMs = Date.now() - startedAt;
      state.voiceSessionId = receipt.voiceSessionId;
      answer = receipt.sdpAnswer;
    },
    (error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'body' in error && typeof error.body === 'object' && error.body !== null && 'code' in error.body ? String(error.body.code) : 'request_failed';
      state.createError = SAFE_TOKEN.test(code) ? code : 'request_failed';
    },
  );
  await state.createRequest;
  if (answer === undefined) return send(response, 502, { error: 'Live session creation failed' });
  send(response, 201, { sdp: answer });
}

const Report = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('connection'), state: z.string().regex(SAFE_TOKEN) }),
  z.object({ kind: z.literal('channel'), state: z.string() }),
  z.object({ kind: z.literal('audio'), bytes: z.number().min(0) }),
  z.object({ kind: z.literal('error'), message: z.string() }),
]);

async function handleReport(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const report = Report.safeParse(parseJson((await readBody(request)) ?? ''));
  send(response, 204, '');
  if (!report.success) return;
  const data = report.data;
  if (data.kind === 'connection') state.peerConnection = data.state;
  if (data.kind === 'channel' && data.state === 'open') state.dataChannelOpened = true;
  if (data.kind === 'audio') state.audioBytesReceived = Math.max(state.audioBytesReceived, data.bytes);
  if (data.kind === 'error') state.pageError = data.message.slice(0, 200);
}

function route(request: IncomingMessage, response: ServerResponse): void {
  if (request.headers.host !== `127.0.0.1:${PORT}`) return send(response, 403, { error: 'Unexpected host' });
  if (request.method === 'GET' && request.url === '/') return send(response, 200, PAGE, 'text/html; charset=utf-8');
  if (request.method !== 'POST') return send(response, 404, { error: 'Not found' });
  if (request.headers.origin !== ORIGIN) return send(response, 403, { error: 'Unexpected origin' });
  const handled = request.url === '/session' ? handleSession(request, response) : request.url === '/report' ? handleReport(request, response) : undefined;
  if (handled) {
    handled.catch((error: unknown) => {
      state.pageError = `Local route failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200);
    });
    return;
  }
  send(response, 404, { error: 'Not found' });
}

// The page reports only connection facts and the byte count of received remote audio; it never
// echoes transcripts or SDP.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Live voice check</title>
<audio id="remote" autoplay></audio>
<script type="module">
const report = (body) => fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
try {
  const peer = new RTCPeerConnection()
  peer.addEventListener('connectionstatechange', () => report({ kind: 'connection', state: peer.connectionState }))
  peer.addEventListener('track', (event) => { document.getElementById('remote').srcObject = event.streams[0] })
  const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
  for (const track of microphone.getAudioTracks()) {
    track.enabled = false
    peer.addTrack(track, microphone)
  }
  const events = peer.createDataChannel('oai-events')
  events.addEventListener('open', () => report({ kind: 'channel', state: 'open' }))
  await peer.setLocalDescription(await peer.createOffer())
  if (peer.iceGatheringState !== 'complete') {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ICE gathering timed out')), 10000)
      peer.addEventListener('icegatheringstatechange', () => {
        if (peer.iceGatheringState === 'complete') { clearTimeout(timeout); resolve() }
      })
    })
  }
  const response = await fetch('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sdp: peer.localDescription.sdp }) })
  if (!response.ok) throw new Error('Session request failed with HTTP ' + response.status)
  await peer.setRemoteDescription({ type: 'answer', sdp: (await response.json()).sdp })
  setInterval(async () => {
    const stats = await peer.getStats()
    let bytes = 0
    stats.forEach((entry) => { if (entry.type === 'inbound-rtp' && entry.kind === 'audio') bytes += entry.bytesReceived || 0 })
    report({ kind: 'audio', bytes })
  }, 500)
} catch (error) {
  report({ kind: 'error', message: String(error && error.message || error) })
}
</script>`;

// Ctrl-C ends the waits that precede the close, but never the wait for the final close event.
async function waitFor(condition: () => boolean | Promise<boolean>, ms: number, isInterruptible = true): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!(await condition()) && !(isInterruptible && state.interrupted)) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return condition();
}

function stopChrome(chrome: ChildProcess | undefined): Promise<void> {
  if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const force = setTimeout(() => chrome.kill('SIGKILL'), 5_000);
    chrome.once('exit', () => {
      clearTimeout(force);
      resolve();
    });
    chrome.kill('SIGTERM');
  });
}

// Chrome's helper processes outlive the browser process for a moment and keep writing to the
// profile, so the profile is deleted only once no process references it any more.
async function releaseProfile(profile: string): Promise<void> {
  const isInUse = () => spawnSync('pgrep', ['-f', profile]).status === 0;
  if (!(await waitFor(() => !isInUse(), PROFILE_RELEASE_TIMEOUT_MS, false))) spawnSync('pkill', ['-KILL', '-f', profile]);
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function summary(): Record<string, unknown> {
  const liveSessionId = state.voiceSessionId ? service.liveSessionId(RUN_ID, state.voiceSessionId) : null;
  const passed =
    state.createError === undefined &&
    state.createMs !== undefined &&
    state.liveMs !== undefined &&
    state.outputFragments > 0 &&
    state.audioBytesReceived > 0 &&
    state.close?.finalization === 'complete' &&
    state.close.usageSeconds !== null &&
    state.cleanupError === undefined;
  return {
    check: 'GPT-Live WebRTC session with server sideband',
    model: LIVE_MODEL,
    sessionIdPrefix: liveSessionId ? `${liveSessionId.slice(0, 9)}…` : null,
    createMs: state.createMs ?? null,
    createError: state.createError ?? null,
    liveMs: state.liveMs ?? null,
    peerConnection: state.peerConnection,
    dataChannelOpened: state.dataChannelOpened,
    greetingOutcome: state.commentaryOutcome ?? null,
    outputTranscriptFragments: state.outputFragments,
    remoteAudioBytesReceived: state.audioBytesReceived,
    closeFinalization: state.close?.finalization ?? null,
    usageSeconds: state.close?.usageSeconds ?? null,
    statusAfterClose: state.statusAfterClose ?? null,
    failureReason: service.failureReason(RUN_ID),
    pageError: state.pageError ?? null,
    cleanupError: state.cleanupError ?? null,
    interrupted: state.interrupted,
    passed,
  };
}

async function main(): Promise<boolean> {
  if (!config.openaiApiKey) throw new Error('OPENAI_API_KEY is not configured; run npm run setup:env on a computer with keys');
  const server = createServer((request, response) => route(request, response));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  const profile = mkdtempSync(join(tmpdir(), 'live-voice-check-'));
  let chrome: ChildProcess | undefined;
  try {
    chrome = spawn(
      CHROME,
      ['--headless=new', `--user-data-dir=${profile}`, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--no-first-run', '--no-default-browser-check', `${ORIGIN}/`],
      { env: childEnv(), stdio: 'ignore' },
    );
    chrome.once('error', (error) => {
      state.pageError = `Chrome failed to start: ${error.message}`;
    });
    await waitFor(() => state.createRequest !== undefined || state.pageError !== undefined, OFFER_TIMEOUT_MS);
    // A create request already sent is always awaited so a session it opens is never left running.
    await state.createRequest;
    if (state.voiceSessionId) {
      const createdAt = Date.now() - (state.createMs ?? 0);
      const isLive = await waitFor(async () => (await service.snapshot(RUN_ID)).status === 'live', LIVE_TIMEOUT_MS);
      if (isLive) {
        state.liveMs = Date.now() - createdAt;
        const greeting = await service.sendCommentary(RUN_ID, { delegationId: null, text: 'Say hello to the child in one short sentence.' }).catch(() => undefined);
        state.commentaryOutcome = greeting?.outcome ?? 'send_failed';
        await waitFor(() => {
          state.outputFragments = service.transcript(RUN_ID).output.length;
          return state.outputFragments > 0 && state.audioBytesReceived > 0;
        }, RESPONSE_TIMEOUT_MS);
      }
    }
  } finally {
    try {
      // The close is requested through the service even when a check above failed, so no session stays open.
      state.close = await service.close(RUN_ID, state.voiceSessionId ?? null);
      state.statusAfterClose = (await service.snapshot(RUN_ID)).status ?? undefined;
      await stopChrome(chrome);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await releaseProfile(profile);
    } catch (error) {
      state.cleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  const result = summary();
  console.log(JSON.stringify(result, null, 2));
  return result.passed === true;
}

process.on('SIGINT', () => {
  state.interrupted = true;
});
setTimeout(() => {
  console.error('Live voice check watchdog expired; exiting without confirmed close.');
  process.exit(1);
}, WATCHDOG_MS).unref();

main().then(
  (passed) => process.exit(passed ? 0 : 1),
  (error: unknown) => {
    console.error(`Live voice check failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
