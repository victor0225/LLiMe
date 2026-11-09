// Live voice probe. Opens exactly one GPT-Live session the way the app will: a browser
// peer (headless Chrome with a fake, disabled microphone) sends its SDP offer to a local
// server, the server creates the session with the project key and attaches a sideband
// WebSocket to the same session. The probe confirms the connection, closes the session,
// waits for the final close event and prints a sanitized JSON log. It never prints the
// key, SDP, transcripts or the full session ID. Exit code 0 only when every check passed.
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseEnv } from 'node:util'

const MODEL = 'gpt-live-1'
const LIVE_API = 'https://api.openai.com/v1/live/sessions'
const PORT = Number(process.env.PORT ?? 4130)
const ORIGIN = `http://127.0.0.1:${PORT}`
const CHROME = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
// Chrome start, fake microphone, ICE gathering and the create request all happen before an offer arrives.
const OFFER_TIMEOUT_MS = 30_000
const CREATE_TIMEOUT_MS = 15_000
// From the create request until the peer, data channel, sideband and session.started are all observed.
const CONNECT_TIMEOUT_MS = 15_000
// A session can take a while to finalize after session.close; the official example waits 15 s.
const CLOSE_TIMEOUT_MS = 15_000
// Last resort if a bounded wait above misbehaves; every normal path finishes well before this.
const WATCHDOG_MS = 120_000
const PROFILE_RELEASE_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 64 * 1024
const SAFE_TOKEN = /^[\w.:-]{1,120}$/
const SESSION_ID = /^[\w-]{1,200}$/

// Startup-only browser permissions: the frontend may only ask to close; it receives status,
// captions and delegation metadata. The trusted sideband is not limited by this list.
const SESSION_CONFIG = {
  model: MODEL,
  store: false,
  delegation: { type: 'client' },
  instructions:
    'This is an automated connection check. Speak English. Stay silent and wait; if the user speaks, reply with one short sentence.',
  client: {
    data_channel: {
      allowed_client_events: ['session.close'],
      allowed_server_events: [
        'session.started',
        'session.closed',
        'session.input_transcript.delta',
        'session.output_transcript.delta',
        'session.delegation.created',
        'error',
      ].map((type) => ({ type })),
    },
  },
}

type Channel = 'sideband' | 'dataChannel'
type ApiError = { channel: Channel | 'create'; code: string; type: string; param: string }

const state = {
  createStartedAt: undefined as number | undefined,
  createStatus: undefined as number | undefined,
  createMs: undefined as number | undefined,
  createError: undefined as ApiError | undefined,
  sessionId: undefined as string | undefined,
  sideband: undefined as WebSocket | undefined,
  sidebandOpen: false,
  sidebandOpened: false,
  sidebandCloseCode: undefined as number | undefined,
  peerConnection: 'new',
  dataChannelOpen: false,
  dataChannelOpened: false,
  startedOn: new Set<Channel>(),
  connectMs: undefined as number | undefined,
  closeSentOn: undefined as Channel | undefined,
  closedOn: new Set<Channel>(),
  closeReason: undefined as string | undefined,
  usageSeconds: undefined as number | undefined,
  counts: { sideband: {}, dataChannel: {} } as Record<Channel, Record<string, number>>,
  errors: [] as ApiError[],
  pageError: undefined as string | undefined,
  cleanupError: undefined as string | undefined,
  createRequest: undefined as Promise<void> | undefined,
  closeSignal: undefined as ServerResponse | undefined,
  interrupted: false,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeToken(value: unknown): string {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : '-'
}

function apiError(channel: ApiError['channel'], body: unknown): ApiError {
  const error = isRecord(body) && isRecord(body.error) ? body.error : {}
  return { channel, code: safeToken(error.code), type: safeToken(error.type), param: safeToken(error.param) }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function git(...args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim()
}

// Shell first, then this checkout's .env, then the main checkout's .env (shared by all worktrees).
// Only OPENAI_API_KEY is read; nothing else from those files enters this process.
function loadApiKey(): string {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY
  const checkout = git('rev-parse', '--show-toplevel')
  const mainCheckout = dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir'))
  for (const dir of [checkout, mainCheckout]) {
    const file = join(dir, '.env')
    if (!existsSync(file)) continue
    const key = parseEnv(readFileSync(file, 'utf8')).OPENAI_API_KEY
    if (key) return key
  }
  throw new Error('OPENAI_API_KEY is not set in the shell, this checkout .env or the main checkout .env')
}

// Chrome needs no credentials, so none reach it.
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/(KEY|PASSWORD|SECRET|TOKEN)/i.test(name)),
  )
}

function count(channel: Channel, type: string): void {
  const counts = state.counts[channel]
  counts[type] = (counts[type] ?? 0) + 1
}

function isConnected(): boolean {
  return (
    state.sidebandOpen &&
    state.peerConnection === 'connected' &&
    state.dataChannelOpen &&
    state.startedOn.size > 0
  )
}

function noteConnected(): void {
  if (state.connectMs === undefined && state.createStartedAt !== undefined && isConnected()) {
    state.connectMs = Date.now() - state.createStartedAt
  }
}

// Records one server event from either channel. Only the type, close reason, usage and
// error identifiers are kept; transcript text and session configuration are dropped.
function observe(channel: Channel, event: unknown): void {
  if (!isRecord(event) || typeof event.type !== 'string') return count(channel, 'unparsed')
  count(channel, safeToken(event.type))
  if (event.type === 'session.started') state.startedOn.add(channel)
  if (event.type === 'error') state.errors.push(apiError(channel, event))
  if (event.type === 'session.closed') {
    state.closedOn.add(channel)
    state.closeReason = safeToken(event.reason)
    const usage = isRecord(event.usage) ? event.usage.seconds : undefined
    if (typeof usage === 'number') state.usageSeconds = usage
  }
  noteConnected()
}

function attachSideband(apiKey: string, sessionId: string): void {
  const socket = new WebSocket(`wss://api.openai.com/v1/live/sessions/${sessionId}/attach`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  state.sideband = socket
  socket.addEventListener('open', () => {
    state.sidebandOpen = true
    state.sidebandOpened = true
    noteConnected()
  })
  socket.addEventListener('message', ({ data }) => {
    observe('sideband', typeof data === 'string' ? parseJson(data) : undefined)
  })
  socket.addEventListener('close', ({ code }) => {
    state.sidebandOpen = false
    state.sidebandCloseCode = code
  })
  socket.addEventListener('error', () => {})
}

async function createSession(apiKey: string, sdp: string): Promise<string | undefined> {
  state.createStartedAt = Date.now()
  const response = await fetch(LIVE_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: SESSION_CONFIG, transport: { type: 'webrtc', sdp } }),
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  })
  state.createStatus = response.status
  state.createMs = Date.now() - state.createStartedAt
  const body = parseJson(await response.text())
  if (response.status !== 201) {
    state.createError = apiError('create', body)
    return undefined
  }
  const session = isRecord(body) && isRecord(body.session) ? body.session : {}
  const transport = isRecord(body) && isRecord(body.transport) ? body.transport : {}
  if (typeof session.id !== 'string' || !SESSION_ID.test(session.id) || typeof transport.sdp !== 'string') {
    state.createError = { channel: 'create', code: 'unexpected_response_shape', type: '-', param: '-' }
    return undefined
  }
  state.sessionId = session.id
  // Attach before answering the browser so the server observes the session from the start,
  // but never wait for session.started here: the browser cannot connect until it has the answer.
  attachSideband(apiKey, session.id)
  return transport.sdp
}

function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_BODY_BYTES) chunks.push(chunk)
    })
    request.on('end', () => resolve(size <= MAX_BODY_BYTES ? Buffer.concat(chunks).toString('utf8') : undefined))
    request.on('error', () => resolve(undefined))
  })
}

function send(response: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  response.end(typeof body === 'string' ? body : JSON.stringify(body))
}

async function handleSession(apiKey: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (state.createRequest) return send(response, 409, { error: 'One session per probe run' })
  const body = parseJson((await readBody(request)) ?? '')
  const sdp = isRecord(body) ? body.sdp : undefined
  if (typeof sdp !== 'string' || !sdp.startsWith('v=0')) return send(response, 400, { error: 'Invalid SDP offer' })
  let answer: string | undefined
  state.createRequest = createSession(apiKey, sdp).then(
    (result) => {
      answer = result
    },
    () => {
      state.createError = { channel: 'create', code: 'request_failed_or_timed_out', type: '-', param: '-' }
    },
  )
  await state.createRequest
  if (answer === undefined) return send(response, 502, { error: 'Live session creation failed' })
  send(response, 201, { sdp: answer })
}

async function handleReport(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const report = parseJson((await readBody(request)) ?? '')
  send(response, 204, '')
  if (!isRecord(report)) return
  if (report.kind === 'connection') state.peerConnection = safeToken(report.state)
  if (report.kind === 'channel') {
    state.dataChannelOpen = report.state === 'open'
    if (state.dataChannelOpen) state.dataChannelOpened = true
  }
  if (report.kind === 'event') observe('dataChannel', report.event)
  if (report.kind === 'error' && typeof report.message === 'string') state.pageError = report.message.slice(0, 200)
  noteConnected()
}

function route(apiKey: string, request: IncomingMessage, response: ServerResponse): void {
  if (request.headers.host !== `127.0.0.1:${PORT}`) return send(response, 403, { error: 'Unexpected host' })
  if (request.method === 'GET' && request.url === '/') return send(response, 200, PAGE, 'text/html; charset=utf-8')
  if (request.method === 'GET' && request.url === '/close-signal') {
    state.closeSignal = response
    return
  }
  if (request.method !== 'POST') return send(response, 404, { error: 'Not found' })
  if (request.headers.origin !== ORIGIN) return send(response, 403, { error: 'Unexpected origin' })
  const handled = request.url === '/session' ? handleSession(apiKey, request, response)
    : request.url === '/report' ? handleReport(request, response)
    : undefined
  if (handled) {
    handled.catch((error: unknown) => {
      state.pageError = `Local route failed: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200)
    })
    return
  }
  send(response, 404, { error: 'Not found' })
}

// The page reports only event types and close facts; it never echoes transcripts or SDP.
const PAGE = `<!doctype html><meta charset="utf-8"><title>Live voice probe</title>
<script type="module">
const report = (body) => fetch('/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
try {
  const peer = new RTCPeerConnection()
  peer.addEventListener('connectionstatechange', () => report({ kind: 'connection', state: peer.connectionState }))
  const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true } })
  for (const track of microphone.getAudioTracks()) {
    track.enabled = false
    peer.addTrack(track, microphone)
  }
  const events = peer.createDataChannel('oai-events')
  events.addEventListener('open', () => report({ kind: 'channel', state: 'open' }))
  events.addEventListener('close', () => report({ kind: 'channel', state: 'closed' }))
  events.addEventListener('message', ({ data }) => {
    const event = JSON.parse(data)
    report({ kind: 'event', event: { type: event.type, reason: event.reason, usage: event.usage, error: event.error && { code: event.error.code, type: event.error.type, param: event.error.param } } })
  })
  fetch('/close-signal').then((response) => response.json()).then(({ close }) => {
    if (close && events.readyState === 'open') events.send(JSON.stringify({ type: 'session.close', event_id: 'probe_close_data_channel' }))
  }, () => {})
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
} catch (error) {
  report({ kind: 'error', message: String(error && error.message || error) })
}
</script>`

// Ctrl-C ends the connection wait early, but never the wait for the final close event.
async function waitFor(condition: () => boolean, ms: number, isInterruptible = true): Promise<boolean> {
  const deadline = Date.now() + ms
  while (!condition() && !(isInterruptible && state.interrupted)) {
    if (Date.now() > deadline) return false
    await sleep(50)
  }
  return condition()
}

// Sends session.close once, preferring the trusted sideband; the browser data channel is the
// fallback when the sideband never opened. Keeps every connection alive until session.closed.
async function closeSession(): Promise<void> {
  if (state.sideband && state.sidebandOpen) {
    state.sideband.send(JSON.stringify({ type: 'session.close', event_id: 'probe_close_sideband' }))
    state.closeSentOn = 'sideband'
  } else if (state.closeSignal && state.dataChannelOpen) {
    send(state.closeSignal, 200, { close: true })
    state.closeSignal = undefined
    state.closeSentOn = 'dataChannel'
  } else {
    return
  }
  await waitFor(() => state.closedOn.size > 0, CLOSE_TIMEOUT_MS, false)
}

function stopChrome(chrome: ChildProcess | undefined): Promise<void> {
  if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const force = setTimeout(() => chrome.kill('SIGKILL'), 5_000)
    chrome.once('exit', () => {
      clearTimeout(force)
      resolve()
    })
    chrome.kill('SIGTERM')
  })
}

// Chrome's helper processes outlive the browser process for a moment and keep writing to the
// profile, so the profile is deleted only once no process references it any more.
async function releaseProfile(profile: string): Promise<void> {
  const isInUse = () => spawnSync('pgrep', ['-f', profile]).status === 0
  if (!(await waitFor(() => !isInUse(), PROFILE_RELEASE_TIMEOUT_MS, false))) spawnSync('pkill', ['-KILL', '-f', profile])
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

function summary(): Record<string, unknown> {
  const passed =
    state.createStatus === 201 &&
    state.connectMs !== undefined &&
    state.closedOn.size > 0 &&
    state.closeReason === 'close_requested' &&
    state.usageSeconds !== undefined &&
    state.cleanupError === undefined
  return {
    probe: 'GPT-Live WebRTC session with server sideband',
    model: MODEL,
    sessionIdPrefix: state.sessionId ? `${state.sessionId.slice(0, 9)}…` : null,
    createStatus: state.createStatus ?? null,
    createMs: state.createMs ?? null,
    createError: state.createError ?? null,
    connectMs: state.connectMs ?? null,
    peerConnection: state.peerConnection,
    dataChannelOpened: state.dataChannelOpened,
    sidebandOpened: state.sidebandOpened,
    sidebandCloseCode: state.sidebandCloseCode ?? null,
    sessionStartedOn: [...state.startedOn],
    closeSentOn: state.closeSentOn ?? null,
    sessionClosedOn: [...state.closedOn],
    closeReason: state.closeReason ?? null,
    usageSeconds: state.usageSeconds ?? null,
    eventCounts: state.counts,
    errors: state.errors,
    pageError: state.pageError ?? null,
    cleanupError: state.cleanupError ?? null,
    interrupted: state.interrupted,
    passed,
  }
}

async function main(): Promise<boolean> {
  const apiKey = loadApiKey()
  const server = createServer((request, response) => route(apiKey, request, response))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(PORT, '127.0.0.1', resolve)
  })
  const profile = mkdtempSync(join(tmpdir(), 'live-voice-probe-'))
  let chrome: ChildProcess | undefined
  try {
    chrome = spawn(
      CHROME,
      [
        '--headless=new',
        `--user-data-dir=${profile}`,
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--no-first-run',
        '--no-default-browser-check',
        `${ORIGIN}/`,
      ],
      { env: childEnv(), stdio: 'ignore' },
    )
    chrome.once('error', (error) => {
      state.pageError = `Chrome failed to start: ${error.message}`
    })
    await waitFor(() => state.createRequest !== undefined || state.pageError !== undefined, OFFER_TIMEOUT_MS)
    // A create request already sent is always awaited so a session it opens is never left running.
    await state.createRequest
    if (state.sessionId) {
      await waitFor(isConnected, CONNECT_TIMEOUT_MS)
      await closeSession()
    }
  } finally {
    try {
      if (state.closeSignal) send(state.closeSignal, 200, { close: false })
      state.sideband?.close()
      await stopChrome(chrome)
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      await releaseProfile(profile)
    } catch (error) {
      state.cleanupError = error instanceof Error ? error.message : String(error)
    }
  }
  const result = summary()
  console.log(JSON.stringify(result, null, 2))
  return result.passed === true
}

process.on('SIGINT', () => {
  state.interrupted = true
})
setTimeout(() => {
  console.error('Live voice probe watchdog expired; exiting without confirmed close.')
  process.exit(1)
}, WATCHDOG_MS).unref()

main().then(
  (passed) => process.exit(passed ? 0 : 1),
  (error: unknown) => {
    console.error(`Live voice probe failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  },
)
