// The local HTTP server: the API routes from the shared route table behind the request guards, and
// the web app (built files, or the Vite dev server behind a proxy during development).
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, request as forward, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { extname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import neo4j, { Neo4jError } from 'neo4j-driver';
import { z } from 'zod';
import { type Config, HOST, loadConfig, repoRoot } from './config.js';
import { type Command, type ErrorBody, type ErrorCode, ErrorCodeSchema, IdSchema, type NotificationOutbox, type RunCreateInput, type RunState } from './domain.js';
import {
  ERROR_HTTP_STATUS,
  HTTP_STATUS,
  type HttpErrorCode,
  HttpErrorSchema,
  LESSON_TEXT_MAX_BYTES,
  type LessonStatus,
  MAX_JSON_BODY_BYTES,
  ROUTES,
  type RouteName,
  SDP_MAX_BYTES,
  SESSION_HEADER,
  utf8ByteLength,
} from './routes.js';
import { loadSeed } from './dataset.js';
import { hasInboxLesson, loadPreparedLesson, readLesson, saveTranscript, watchInbox } from './inbox.js';
import { type CodexRuntime, createCodexRuntime, createIngestionStarter, createRuntimePort, createServerRuntimePort, type SettleOperation } from './codex.js';
import { createEngine } from './engine.js';
import { defaultSimctlRunner, type OutboxLoop, parseNotifyConfig, startOutboxLoop } from './notify.js';
import { callTool } from './tools.js';
import { createVoiceDelegation, createVoiceHandlers, createVoiceService } from './voice.js';
import { createRunId, type RunRecord, Store } from './store.js';

type Routes = typeof ROUTES;
type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}` ? Name | ParamNames<`/${Rest}`> : P extends `${string}:${infer Name}` ? Name : never;
type Parsed<S> = S extends z.ZodType ? z.output<S> : undefined;

export type RouteRequest<N extends RouteName> = {
  params: Record<ParamNames<Routes[N]['path']>, string>;
  query: Parsed<Routes[N]['query']>;
  body: Parsed<Routes[N]['request']>;
  // Aborted when the client goes away before the answer is sent.
  signal: AbortSignal;
};
export type RouteHandler<N extends RouteName> = (request: RouteRequest<N>) => Promise<z.input<Routes[N]['response']>>;
// Routes without a handler answer "not ready" until their lane binds one.
export type RouteHandlers = { [N in RouteName]?: RouteHandler<N> };

// Thrown by a handler to answer with a shared error code; the code decides the HTTP status.
// INTERNAL is excluded: only the server's own fault path answers 500, so a handler cannot send a
// fault's text to the browser under that code.
export class RouteError extends Error {
  constructor(readonly body: ErrorBody & { code: Exclude<HttpErrorCode, 'INTERNAL'> }) {
    super(body.message);
  }
}

export type Frontend = { kind: 'static'; distDir: string } | { kind: 'dev' };

// Same-origin only. Inline styles are allowed because React writes style attributes.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";
// Vite's development page needs one inline script to start React Fast Refresh.
const DEV_CSP = CSP.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

// Error answers for requests that never reach a route.
const FORBIDDEN = (message: string): ErrorBody => ({ code: 'FORBIDDEN', message, retryable: false });
const NOT_READY = (message: string): ErrorBody => ({ code: 'NOT_READY', message, retryable: true });
// A fault answers with an ID that matches its log line; the fault's own text never reaches the browser.
const INTERNAL = (errorId: string): ErrorBody => ({ code: 'INTERNAL', message: 'The server failed to answer this request', retryable: false, errorId });
const NOT_FOUND: ErrorBody = { code: 'NOT_FOUND', message: 'Not found', retryable: false };

const isApiPath = (pathname: string) => pathname === '/api' || pathname.startsWith('/api/');
const isRouteName = (name: string): name is RouteName => Object.hasOwn(ROUTES, name);

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

// Each route path becomes a pattern once: `:name` matches one path segment.
const ROUTE_PATTERNS = Object.keys(ROUTES)
  .filter(isRouteName)
  .map((name) => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${ROUTES[name].path.replace(/:([a-zA-Z]+)/g, (_match, key: string) => (keys.push(key), '([^/]+)'))}$`);
    return { name, method: ROUTES[name].method, keys, pattern };
  });

// Matches a path against the route table; parameters stay raw until validation.
function matchRoute(method: string, pathname: string): { name: RouteName; params: Record<string, string> } | null {
  for (const { name, method: routeMethod, keys, pattern } of ROUTE_PATTERNS) {
    const values = routeMethod === method ? pattern.exec(pathname)?.slice(1) : undefined;
    if (values) return { name, params: Object.fromEntries(keys.map((key, i) => [key, values[i] ?? ''])) };
  }
  return null;
}

const invalid = (message: string) => new RouteError({ code: 'INVALID_INPUT', message, retryable: false });

function parseParams(raw: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(value);
      } catch {
        throw invalid(`Invalid ${key}`);
      }
      if (!IdSchema.safeParse(decoded).success) throw invalid(`Invalid ${key}`);
      return [key, decoded];
    }),
  );
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const tooLarge = new RouteError({ code: 'PAYLOAD_TOO_LARGE', message: `The request body is larger than ${MAX_JSON_BODY_BYTES} bytes`, retryable: false });
  if (Number(req.headers['content-length'] ?? 0) > MAX_JSON_BODY_BYTES) throw tooLarge;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > MAX_JSON_BODY_BYTES) throw tooLarge;
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw invalid('The request body is not valid JSON');
  }
}

function requireValid<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw invalid(`Invalid ${what}: ${result.error.issues.map((i) => `${i.path.join('.') || what} ${i.message}`).join('; ')}`.slice(0, 300));
  return result.data;
}

// Indexes the built files once at startup. A request path is looked up in this index, never joined
// onto a disk path, so nothing outside the build (sources, .env, .runtime) can be reached.
function builtFiles(distDir: string): Map<string, { file: string; type: string }> {
  if (!existsSync(join(distDir, 'index.html'))) throw new Error(`${join(distDir, 'index.html')} is missing; run npm run build first`);
  const files = new Map<string, { file: string; type: string }>();
  for (const entry of readdirSync(distDir, { recursive: true, encoding: 'utf8' })) {
    const file = join(distDir, entry);
    const type = CONTENT_TYPES[extname(entry)];
    if (type && statSync(file).isFile()) files.set(`/${entry.split(sep).join('/')}`, { file, type });
  }
  return files;
}

// Runtime data, the seed and captures stay private even if a copy ever lands inside the build.
const PRIVATE_TOP_LEVEL = new Set(['data', 'captures']);
const isPrivatePath = (pathname: string) => {
  const segments = pathname.split('/').filter(Boolean);
  return segments.some((segment) => segment.startsWith('.')) || PRIVATE_TOP_LEVEL.has(segments[0] ?? '');
};

function serveBuilt(distDir: string) {
  const files = builtFiles(distDir);
  const page = files.get('/index.html');
  if (!page) throw new Error('index.html is missing from the build');
  return async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    // Paths without a dot are client routes (for example /lesson-notes) rendered by the page.
    const isClientRoute = !pathname.includes('.');
    const found = isPrivatePath(pathname) ? undefined : isClientRoute ? page : files.get(pathname);
    if (!found) return sendJson(res, HTTP_STATUS.notFound, NOT_FOUND);
    const body = await readFile(found.file);
    res.writeHead(HTTP_STATUS.ok, { 'content-type': found.type, 'content-security-policy': CSP, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}

function proxyToVite(vitePort: number) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const upstream = forward({ host: HOST, port: vitePort, method: req.method, path: req.url, headers: req.headers }, (reply) => {
      res.writeHead(reply.statusCode ?? HTTP_STATUS.internalError, { ...reply.headers, 'content-security-policy': DEV_CSP });
      reply.pipe(res);
    });
    upstream.on('error', () => {
      if (res.headersSent) return res.destroy();
      sendJson(res, HTTP_STATUS.unavailable, NOT_READY(`The Vite dev server on port ${vitePort} is not running`));
    });
    req.pipe(upstream);
  };
}

// Text fields with their own byte limit inside a body that already fits the JSON limit. Checked
// before the schema so an oversized field is a 413, not a structural 400.
const FIELD_LIMITS: Partial<Record<RouteName, { field: string; maxBytes: number }>> = {
  saveLesson: { field: 'text', maxBytes: LESSON_TEXT_MAX_BYTES },
  createVoiceSession: { field: 'sdpOffer', maxBytes: SDP_MAX_BYTES },
};

function rejectOversizedField(name: RouteName, body: unknown) {
  const limit = FIELD_LIMITS[name];
  const value: unknown = limit && typeof body === 'object' && body !== null ? Reflect.get(body, limit.field) : undefined;
  if (limit && typeof value === 'string' && utf8ByteLength(value) > limit.maxBytes) {
    throw new RouteError({ code: 'PAYLOAD_TOO_LARGE', message: `${limit.field} is larger than ${limit.maxBytes} bytes`, retryable: false });
  }
}

// Compares in constant time so response timing cannot reveal how much of a guess was right.
function isSessionNonce(header: string | string[] | undefined, nonce: string): boolean {
  if (typeof header !== 'string') return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(nonce);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createAppServer({ config, nonce, handlers = {}, frontend }: { config: Config; nonce: string; handlers?: RouteHandlers; frontend: Frontend }): Server {
  // Every client addresses the backend by this one host; a proxy in front of it must rewrite Host.
  const allowedHosts = new Set([`${HOST}:${config.port}`]);
  // Mutations may come from the app itself or from the configured local Vite and Storybook pages.
  const allowedOrigins = new Set([config.appOrigin, `http://${HOST}:${config.vitePort}`, config.storybookOrigin]);
  const serveFrontend = frontend.kind === 'static' ? serveBuilt(frontend.distDir) : proxyToVite(config.vitePort);

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? 'GET';
    if (method === 'POST') {
      // A page on another origin cannot read the nonce, so it cannot mutate local state. A request
      // without an Origin header (an operator script) still needs the nonce from /api/bootstrap.
      const origin = req.headers.origin;
      if (!isSessionNonce(req.headers[SESSION_HEADER], nonce) || (origin !== undefined && !allowedOrigins.has(origin))) return sendJson(res, HTTP_STATUS.forbidden, FORBIDDEN('Invalid session or origin'));
    }
    const match = matchRoute(method, url.pathname);
    if (!match) return sendJson(res, HTTP_STATUS.notFound, NOT_FOUND);
    // The route table and the handler map share their keys, but TypeScript cannot correlate a
    // runtime key with its handler type; the parsing below enforces each route's own schemas.
    const handler = handlers[match.name] as ((request: { params: unknown; query: unknown; body: unknown; signal: AbortSignal }) => Promise<unknown>) | undefined;
    if (!handler) return sendJson(res, HTTP_STATUS.unavailable, NOT_READY(`Not ready: ${method} ${ROUTES[match.name].path} has no handler yet`));
    const route: Routes[RouteName] = ROUTES[match.name];
    try {
      const params = parseParams(match.params);
      const query = route.query ? requireValid(route.query, Object.fromEntries(url.searchParams), 'query') : undefined;
      let body: unknown;
      if (route.request) {
        const raw = await readJsonBody(req);
        rejectOversizedField(match.name, raw);
        body = requireValid(route.request, raw, 'body');
      }
      const aborted = new AbortController();
      res.once('close', () => {
        if (!res.writableFinished) aborted.abort();
      });
      const result = route.response.safeParse(await handler({ params, query, body, signal: aborted.signal }));
      if (!result.success) throw new Error(`${match.name} returned a response that breaks its schema: ${result.error.message}`);
      sendJson(res, route.status, result.data);
    } catch (error) {
      if (!(error instanceof RouteError)) throw error;
      const body = HttpErrorSchema.parse(error.body);
      sendJson(res, ERROR_HTTP_STATUS[error.body.code], body);
    }
  }

  const server = createServer((req, res) => {
    const handle = async () => {
      if (!allowedHosts.has(req.headers.host ?? '')) return sendJson(res, HTTP_STATUS.forbidden, FORBIDDEN('Invalid host'));
      const url = new URL(req.url ?? '/', config.appOrigin);
      if (isApiPath(url.pathname)) return handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, HTTP_STATUS.notFound, NOT_FOUND);
      return serveFrontend(req, res, url.pathname);
    };
    handle().catch((error: unknown) => {
      const errorId = `err_${randomBytes(8).toString('hex')}`;
      console.error(`Request failed (error ${errorId}):`, error);
      if (!res.headersSent) sendJson(res, HTTP_STATUS.internalError, INTERNAL(errorId));
      else res.destroy();
    });
  });

  // Development only: Vite's HMR WebSocket reaches the dev server through the app origin.
  if (frontend.kind === 'dev') {
    server.on('upgrade', (req: IncomingMessage, socket, head: Buffer) => {
      const origin = req.headers.origin;
      if (!allowedHosts.has(req.headers.host ?? '') || (origin !== undefined && !allowedOrigins.has(origin))) return socket.destroy();
      const upstream = connect(config.vitePort, HOST, () => {
        const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
    });
  }
  return server;
}

// Listens on loopback only; a busy port fails with the command that shows its owner.
export function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use. Find its owner with: lsof -nP -iTCP:${port} -sTCP:LISTEN`) : error),
    );
    server.listen(port, HOST, resolve);
  });
}

// ---------------------------------------------------------------------------------------------
// What the routes need from the other modules. Tests bind stand-ins. The engine, voice and Codex
// modules are optional until their lanes land; their routes answer NOT_READY meanwhile.

export type RunStorePort = Pick<Store, 'getRun' | 'events' | 'getNotification' | 'appendEvents' | 'close'>;

type CommandOutcome = Promise<{ run: RunRecord; replayed: boolean }>;

export type EnginePort = {
  command(runId: string, command: Command): CommandOutcome;
  // Moves operations a restart cut off to their honest end state and repeats the Codex and voice
  // cleanup of stopped runs. Idempotent: a second call changes nothing.
  recoverInterrupted(): Promise<{ interrupted: string[]; cleaned: string[] }>;
};

export type LessonPort = {
  readLesson(runId: string): Promise<LessonStatus>;
  // Writes the run's inbox file only; the inbox watcher alone starts ingestion.
  saveTranscript(runId: string, text: string): Promise<{ saved: true; contentHash: string }>;
};

// The voice module answers its own three routes; the server puts its guards and error mapping around them.
export type VoiceRoutes = Pick<Required<RouteHandlers>, 'createVoiceSession' | 'voiceSnapshot' | 'voiceCommand'>;

export type RuntimePort = {
  // Resolves once every interrupted turn has saved its terminal events and its settlement.
  interruptActiveTurns(): Promise<void>;
  // Closes every Codex child's stdin and waits for it to exit.
  close(): Promise<void>;
};

export type Stoppable = { stop(): Promise<void> };

export type ServerPorts = {
  store: RunStorePort;
  // Pins the corpus and stores the seed; the run starts WAITING with no events.
  createRun(input: RunCreateInput): Promise<RunRecord>;
  lessons: LessonPort;
  engine?: EnginePort;
  voice?: { routes: VoiceRoutes; closeAll(): Promise<void> };
  runtime?: RuntimePort;
  // Started after recovery, so neither a lesson file nor a pending notification acts on a run that
  // is still being reconciled.
  startInbox(): Promise<Stoppable>;
  startOutbox(): Promise<Stoppable>;
};

// ---------------------------------------------------------------------------------------------
// Route handlers.

// Lane errors carry a shared code (and, for conflicts, the run revision); other modules need not
// share one error class for the HTTP mapping to see that.
const LaneErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean().optional(),
  revision: z.number().int().min(0).optional(),
});

const isRouteErrorCode = (code: ErrorCode): code is Exclude<HttpErrorCode, 'INTERNAL'> => code !== 'INTERNAL' && Object.hasOwn(ERROR_HTTP_STATUS, code);

const isDatabaseUnreachable = (error: unknown) =>
  error instanceof Neo4jError && (error.code === neo4j.error.SERVICE_UNAVAILABLE || error.code === neo4j.error.SESSION_EXPIRED);

const runIdOf = (params: object): string | undefined => {
  const value: unknown = Reflect.get(params, 'runId');
  return typeof value === 'string' ? value : undefined;
};

// Turns a lane failure into its HTTP answer. A conflict always names the current revision so the
// browser can refresh before deciding anything; anything unrecognized stays a server fault (500).
async function toRouteError(error: unknown, store: RunStorePort, runId: string | undefined): Promise<unknown> {
  if (isDatabaseUnreachable(error)) return new RouteError({ code: 'NOT_READY', message: 'The database is not reachable', retryable: true });
  const lane = LaneErrorSchema.safeParse(error instanceof RouteError ? error.body : error);
  if (!lane.success || !isRouteErrorCode(lane.data.code)) return error;
  const { code, message, retryable = false } = lane.data;
  const isConflict = ERROR_HTTP_STATUS[code] === HTTP_STATUS.conflict;
  if (error instanceof RouteError && (!isConflict || lane.data.revision !== undefined)) return error;
  const revision = lane.data.revision ?? (isConflict && runId !== undefined ? (await store.getRun(runId)).revision : undefined);
  return new RouteError({ code, message: message.slice(0, 300), retryable, ...(revision === undefined ? {} : { revision }) });
}

// The snapshot a record describes: its state plus every event through its seq. Events are never
// edited and each seq up to the record's was committed with or before it, so filtering a later
// event read reproduces exactly that history; events appended since stay out.
async function snapshotAt(store: RunStorePort, record: RunRecord) {
  const events = (await store.events(record.id, 0)).filter((event) => event.seq <= record.seq);
  if (events.length !== record.seq || events.some((event, i) => event.seq !== i + 1)) throw new Error(`Run ${record.id} is missing events through seq ${record.seq}`);
  return { ...record.state, id: record.id, revision: record.revision, seq: record.seq, execution: { throughSeq: record.seq, events } };
}

// Runs one piece of work per run at a time, in arrival order.
function perRunQueue() {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(runId: string, work: () => Promise<T>): Promise<T> => {
    const result = (tails.get(runId) ?? Promise.resolve()).then(work, work);
    const tail = result.catch(() => undefined);
    tails.set(runId, tail);
    void tail.then(() => tails.get(runId) === tail && tails.delete(runId));
    return result;
  };
}

const conflict = (message: string, revision: number) => new RouteError({ code: 'CONFLICT', message, retryable: false, revision });

// The activity a notification may open: the run's current activity, or its invitation while it waits.
function isCurrentActivity(state: RunState, row: NotificationOutbox): boolean {
  const matches = (activity: RunState['activity']) => activity !== null && activity.id === row.activityId && activity.revision === row.activityRevision;
  return !state.stopped && (matches(state.activity) || (state.phase === 'INVITED' && matches(state.invitation)));
}

export type HandlerOptions = {
  config: Config;
  nonce: string;
  dataset: string;
  // Lets the server refuse new work while it shuts down.
  admit?: () => void;
};

export function createRouteHandlers(ports: Pick<ServerPorts, 'store' | 'createRun' | 'engine' | 'lessons' | 'voice'>, options: HandlerOptions): RouteHandlers {
  const { store, engine, lessons, voice } = ports;
  const serialized = perRunQueue();
  const handle =
    <N extends RouteName>(_name: N, handler: RouteHandler<N>): RouteHandler<N> =>
    async (request) => {
      options.admit?.();
      try {
        return await handler(request);
      } catch (error) {
        throw await toRouteError(error, store, runIdOf(request.params));
      }
    };
  const isVoiceConfigured = options.config.openaiApiKey !== undefined;

  const engineRoutes: RouteHandlers = engine
    ? { runCommand: handle('runCommand', async ({ params, body }) => snapshotAt(store, (await engine.command(params.runId, body)).run)) }
    : {};
  const voiceRoutes: RouteHandlers = voice
    ? {
        createVoiceSession: handle('createVoiceSession', voice.routes.createVoiceSession),
        voiceSnapshot: handle('voiceSnapshot', voice.routes.voiceSnapshot),
        voiceCommand: handle('voiceCommand', voice.routes.voiceCommand),
      }
    : {};

  return {
    ...engineRoutes,
    ...voiceRoutes,
    bootstrap: handle('bootstrap', async () => ({
      nonce: options.nonce,
      voice: isVoiceConfigured ? 'configured_unverified' : 'missing_key',
      inputMode: isVoiceConfigured ? 'live' : 'typed',
      runtime: 'Codex App Server',
      database: 'Neo4j',
      dataset: options.dataset,
      // This server only runs live turns; a replay of a capture is served elsewhere.
      mode: 'live',
      captureId: null,
    })),
    createRun: handle('createRun', async ({ body }) => snapshotAt(store, await ports.createRun(body))),
    getRun: handle('getRun', async ({ params }) => snapshotAt(store, await store.getRun(params.runId))),
    runEvents: handle('runEvents', async ({ params, query }) => store.events(params.runId, query.after)),
    getLesson: handle('getLesson', async ({ params }) => {
      await store.getRun(params.runId);
      return lessons.readLesson(params.runId);
    }),
    saveLesson: handle('saveLesson', async ({ params, body }) => {
      await store.getRun(params.runId);
      return lessons.saveTranscript(params.runId, body.text);
    }),
    // A real tap is transport evidence only: it is recorded once per notification and never starts
    // or grades the activity.
    notificationOpened: handle('notificationOpened', ({ params, body }) =>
      serialized(params.runId, async () => {
        const run = await store.getRun(params.runId);
        const row = await store.getNotification(params.notificationId);
        if (!row || row.runId !== run.id) throw new RouteError({ code: 'NOT_FOUND', message: `Unknown notification ${params.notificationId} for this run`, retryable: false });
        if (row.activityId !== body.activityId || row.activityRevision !== body.activityRevision) throw conflict('The tap names a different activity than its notification', run.revision);
        const events = await store.events(run.id, 0);
        const isRecorded = events.some((event) => event.type === 'notification.opened' && event.payload.notificationId === row.notificationId);
        if (isRecorded) return snapshotAt(store, run);
        if (!isCurrentActivity(run.state, row)) throw conflict('The notification’s activity is no longer current', run.revision);
        await store.appendEvents(run.id, [{ type: 'notification.opened', payload: { notificationId: row.notificationId, runId: run.id, activityId: row.activityId, activityRevision: row.activityRevision } }]);
        return snapshotAt(store, await store.getRun(run.id));
      }),
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Boot and shutdown.

// The graceful-shutdown bound; past it the process stops waiting and reports a forced exit.
export const SHUTDOWN_DEADLINE_MS = 5000;

export type SignalSource = {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
};

export type BootOptions = {
  config: Config;
  nonce: string;
  frontend: Frontend;
  dataset: string;
  // Tests listen on a free port; the configured port still drives the Host and Origin checks.
  listenPort?: number;
  signals?: SignalSource;
  shutdownDeadlineMs?: number;
  closeFrontend?: () => Promise<void>;
};

export type ShutdownReport = { forced: boolean; failures: string[]; elapsedMs: number };

export type RunningServer = {
  port: number;
  // Resolves once recovery finished and the routes answer; rejects (after shutting down) if recovery failed.
  ready: Promise<void>;
  shutdown(): Promise<ShutdownReport>;
  stopped: Promise<ShutdownReport>;
};

// Listens first, so a busy port fails at once; every API route answers NOT_READY until restart
// recovery has run, so no request can act on a run that still looks mid-operation.
export async function bootServer(ports: ServerPorts, options: BootOptions): Promise<RunningServer> {
  const handlers: RouteHandlers = {};
  const server = createAppServer({ config: options.config, nonce: options.nonce, handlers, frontend: options.frontend });
  const openResponses = new Set<ServerResponse>();
  let onResponsesDone: (() => void) | null = null;
  server.on('request', (_req: IncomingMessage, res: ServerResponse) => {
    openResponses.add(res);
    res.once('close', () => {
      openResponses.delete(res);
      if (openResponses.size === 0) onResponsesDone?.();
    });
  });
  await listen(server, options.listenPort ?? options.config.port);
  const address = server.address();
  if (address === null || typeof address !== 'object') throw new Error('The server is not listening on a TCP port');

  const { runtime, voice } = ports;
  let isStopping = false;
  const loops: Stoppable[] = [];
  const admit = () => {
    if (isStopping) throw new RouteError({ code: 'NOT_READY', message: 'The server is shutting down', retryable: true });
  };

  const recover = async () => {
    if (ports.engine) {
      // Never restarts model work: a cut-off step ends in ERROR and stopped runs are cleaned up again.
      const { interrupted, cleaned } = await ports.engine.recoverInterrupted();
      if (interrupted.length + cleaned.length > 0) console.log(`Restart recovery: ${interrupted.length} interrupted, ${cleaned.length} stopped runs cleaned up`);
    }
    loops.push(await ports.startInbox());
    loops.push(await ports.startOutbox());
    if (!isStopping) Object.assign(handlers, createRouteHandlers(ports, { config: options.config, nonce: options.nonce, dataset: options.dataset, admit }));
  };

  let resolveStopped: (report: ShutdownReport) => void = () => {};
  const stopped = new Promise<ShutdownReport>((resolve) => (resolveStopped = resolve));
  let shutdownRun: Promise<ShutdownReport> | null = null;
  const signals = options.signals ?? process;
  const onSignal = () => void shutdown();

  const shutdown = (): Promise<ShutdownReport> => {
    shutdownRun ??= (async () => {
      const started = performance.now();
      isStopping = true;
      signals.off('SIGINT', onSignal);
      signals.off('SIGTERM', onSignal);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const failures: string[] = [];
      const step = async (name: string, work: () => Promise<unknown>) => {
        try {
          await work();
        } catch (error) {
          failures.push(name);
          console.error(`Shutdown: could not ${name}:`, error);
        }
      };
      const responsesDone = () => (openResponses.size === 0 ? Promise.resolve() : new Promise<void>((resolve) => (onResponsesDone = resolve)));
      const sequence = async () => {
        await ready.catch(() => undefined);
        await step('stop the inbox watcher and the outbox', () => Promise.all(loops.map((loop) => loop.stop())));
        if (voice) await step('close the voice sessions', () => voice.closeAll());
        if (runtime) await step('interrupt active turns', () => runtime.interruptActiveTurns());
        // An answer is sent only after its commit, so waiting for open responses waits for their writes.
        await step('finish requests in progress', responsesDone);
        if (options.closeFrontend) await step('close the dev server', options.closeFrontend);
        server.closeIdleConnections();
        await step('close the HTTP server', () => closed);
        await step('close the database driver', () => ports.store.close());
        if (runtime) await step('close the Codex children', () => runtime.close());
      };
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<true>((resolve) => (timer = setTimeout(() => resolve(true), options.shutdownDeadlineMs ?? SHUTDOWN_DEADLINE_MS)));
      const forced = await Promise.race([sequence().then(() => false as const), deadline]);
      clearTimeout(timer);
      if (forced) server.closeAllConnections();
      const report = { forced, failures, elapsedMs: Math.round(performance.now() - started) };
      resolveStopped(report);
      return report;
    })();
    return shutdownRun;
  };

  const ready = recover();
  ready.catch(async (error: unknown) => {
    console.error('Startup recovery failed; shutting down:', error);
    await shutdown();
  });
  signals.once('SIGINT', onSignal);
  signals.once('SIGTERM', onSignal);
  return { port: address.port, ready, shutdown, stopped };
}

// Notifications go only to an explicitly configured Simulator. Without one the outbox stays off and
// pending rows wait, instead of guessing a device that may belong to another worker.
// Codex acknowledges an interrupt before the turn ends; the turn's terminal events and the engine's
// settlement are written after that. This tracks both, so shutdown can wait for them before the
// store closes instead of losing them to a closed driver.
export function trackTurnSettlement(codex: CodexRuntime, settleOperation: SettleOperation) {
  const pending = new Set<Promise<unknown>>();
  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    const forget = () => void pending.delete(work);
    work.then(forget, forget);
    return work;
  }
  const runtime: CodexRuntime = {
    ...codex,
    startTurn: async (request) => {
      const turn = await codex.startTurn(request);
      track(turn.done);
      return turn;
    },
  };
  const settle: SettleOperation = (runId, settlement) => track(settleOperation(runId, settlement));
  // A finished turn calls settle on a later tick, so the wait repeats until nothing new appears.
  async function settled(): Promise<void> {
    while (pending.size > 0) {
      await Promise.allSettled([...pending]);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return { runtime, settle, settled };
}

async function startConfiguredOutbox(config: Config, store: Store): Promise<OutboxLoop | null> {
  if (config.simulatorUdid === undefined) {
    console.log('Notifications are off: set SIMULATOR_UDID to the iPad Simulator that should receive them.');
    return null;
  }
  const notify = parseNotifyConfig({ deviceUdid: config.simulatorUdid });
  return startOutboxLoop({ store, runSimctl: defaultSimctlRunner, config: notify, onOutcome: (outcome) => console.log(`Outbox: ${JSON.stringify(outcome)}`) });
}

async function main() {
  const config = loadConfig();
  const isDev = process.argv.includes('--dev');
  const { uri, user, password } = config.neo4j;
  if (password === undefined) throw new Error('NEO4J_PASSWORD is not set; run npm run setup:env to reuse the machine DB credential');
  const store = await Store.connect({ uri, user, password });
  const corpus = loadSeed();
  const rootDir = repoRoot;
  const lesson = await loadPreparedLesson({ rootDir });
  if (lesson.problem) console.log(lesson.problem);

  // The outbox starts after recovery, but a publish must be able to wake it whenever it runs.
  let outbox: OutboxLoop | null = null;
  const wakeOutbox = { kick: () => void outbox?.kick() };
  // A Codex child works in an empty directory, so no project instructions or settings reach it.
  const agentDir = join(rootDir, '.runtime', 'agent');
  await mkdir(agentDir, { recursive: true });
  const codex = createCodexRuntime({
    store,
    callTool: (context, name, args) => callTool({ store, outbox: wakeOutbox }, context, name, args),
    config: { command: join(rootDir, 'node_modules', '.bin', 'codex'), cwd: agentDir, model: config.model, serviceTier: config.serviceTier, stderrLogPath: join(rootDir, '.runtime', 'logs', 'codex.stderr.log') },
  });
  // The engine, the runtime and voice delegation refer to each other: a finished turn settles
  // through the engine, and a stopped run closes its voice through delegation. The lambdas resolve
  // these names only when they run, after every one exists.
  const turns = trackTurnSettlement(codex, (runId, settlement) => engine.settleOperation(runId, settlement));
  const engine = createEngine({
    store,
    runtime: createRuntimePort({ runtime: turns.runtime, settle: turns.settle, closeVoice: async (runId) => void (await delegation.closeVoice(runId)) }),
  });
  const delegation = createVoiceDelegation({ store, engine });
  const voiceService = createVoiceService({ apiKey: config.openaiApiKey, store, hooks: delegation.hooks });
  delegation.attach(voiceService);
  const serverRuntime = createServerRuntimePort(codex);
  const voiceRoutes = createVoiceHandlers(voiceService, {
    typedCorrection: async (runId, request) => snapshotAt(store, (await engine.typedCorrection(runId, request.command)).run),
    activityRendered: async (runId, command) => snapshotAt(store, (await delegation.activityRendered(runId, command)).run),
  });

  // Vite runs only in development; recording serves the built files with no dev server.
  const vite = isDev ? await (await import('vite')).createServer({ configFile: join(repoRoot, 'vite.config.ts') }) : undefined;
  await vite?.listen();

  const running = await bootServer(
    {
      store,
      createRun: (input) => store.createRun({ runId: createRunId(), ...input }, corpus),
      lessons: {
        readLesson: (runId) => readLesson(runId, { rootDir, prepared: lesson.prepared }),
        saveTranscript: (runId, text) => saveTranscript(runId, text, { rootDir }),
      },
      engine: {
        command: (runId, command) => engine.command(runId, command),
        // Several checkouts share the local database; this one recovers only the runs whose lesson
        // is in its own inbox, the same owner test the outbox uses.
        recoverInterrupted: () => engine.recoverInterrupted({ ownsRun: (runId) => hasInboxLesson(runId, { rootDir }) }),
      },
      voice: { routes: voiceRoutes, closeAll: () => voiceService.closeAll() },
      runtime: {
        interruptActiveTurns: async () => {
          await serverRuntime.interruptActiveTurns();
          await turns.settled();
        },
        close: serverRuntime.close,
      },
      startInbox: () =>
        watchInbox({
          rootDir,
          store,
          startIngestionTurn: createIngestionStarter({ runtime: turns.runtime, store, settle: turns.settle }),
          now: Date.now,
          onOutcome: (outcome) => console.log(`Inbox: ${JSON.stringify(outcome)}`),
        }),
      startOutbox: async () => {
        outbox = await startConfiguredOutbox(config, store);
        return outbox ?? { stop: async () => {} };
      },
    },
    {
      config,
      nonce: randomBytes(24).toString('hex'),
      frontend: isDev ? { kind: 'dev' } : { kind: 'static', distDir: join(repoRoot, 'dist') },
      dataset: `synthetic seed v${corpus.manifest.version}, ${corpus.manifest.cases} cases`,
      ...(vite ? { closeFrontend: () => vite.close() } : {}),
    },
  );
  await running.ready;
  console.log(`llime is ready at ${config.appOrigin}/${isDev ? ` (Vite dev server on ${HOST}:${config.vitePort})` : ''}`);
  const report = await running.stopped;
  console.log(`Stopped in ${report.elapsedMs} ms${report.forced ? '; the shutdown deadline passed before every resource closed' : ''}${report.failures.length ? `; failed to ${report.failures.join(', ')}` : ''}`);
  process.exit(report.forced || report.failures.length > 0 ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
