// The local HTTP server: the API routes from the shared route table behind the request guards, and
// the web app (built files, or the Vite dev server behind a proxy during development).
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, request as forward, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { extname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { z } from 'zod';
import { type Config, HOST, loadConfig, repoRoot } from './config.js';
import { type ErrorBody, IdSchema } from './domain.js';
import { ERROR_HTTP_STATUS, HTTP_STATUS, type HttpErrorCode, HttpErrorSchema, MAX_JSON_BODY_BYTES, ROUTES, type RouteName, SESSION_HEADER } from './routes.js';

type Routes = typeof ROUTES;
type ParamNames<P extends string> = P extends `${string}:${infer Name}/${infer Rest}` ? Name | ParamNames<`/${Rest}`> : P extends `${string}:${infer Name}` ? Name : never;
type Parsed<S> = S extends z.ZodType ? z.output<S> : undefined;

export type RouteRequest<N extends RouteName> = {
  params: Record<ParamNames<Routes[N]['path']>, string>;
  query: Parsed<Routes[N]['query']>;
  body: Parsed<Routes[N]['request']>;
};
export type RouteHandler<N extends RouteName> = (request: RouteRequest<N>) => Promise<z.input<Routes[N]['response']>>;
// Routes without a handler answer "not ready" until their lane binds one.
export type RouteHandlers = { [N in RouteName]?: RouteHandler<N> };

// Thrown by a handler to answer with a shared error code; the code decides the HTTP status.
export class RouteError extends Error {
  constructor(readonly body: ErrorBody & { code: HttpErrorCode }) {
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

// Error answers for requests that never reach a route. The shared codes have no dedicated value
// for a refused host or session, a missing handler or a server bug, so these reuse the closest one.
const FORBIDDEN = (message: string): ErrorBody => ({ code: 'INVALID_INPUT', message, retryable: false });
const NOT_READY = (message: string): ErrorBody => ({ code: 'RUNTIME_DISCONNECTED', message, retryable: true });
const INTERNAL: ErrorBody = { code: 'RUNTIME_DISCONNECTED', message: 'The server failed to answer this request', retryable: false };
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

function serveBuilt(distDir: string) {
  const files = builtFiles(distDir);
  const page = files.get('/index.html');
  if (!page) throw new Error('index.html is missing from the build');
  return async (req: IncomingMessage, res: ServerResponse, pathname: string) => {
    // Paths without a dot are client routes (for example /lesson-notes) rendered by the page.
    const isClientRoute = !pathname.includes('.');
    const found = isClientRoute ? page : files.get(pathname);
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

export function createAppServer({ config, nonce, handlers = {}, frontend }: { config: Config; nonce: string; handlers?: RouteHandlers; frontend: Frontend }): Server {
  const allowedHosts = new Set([`${HOST}:${config.port}`, `localhost:${config.port}`]);
  const allowedOrigins = new Set([config.appOrigin, `http://localhost:${config.port}`]);
  const serveFrontend = frontend.kind === 'static' ? serveBuilt(frontend.distDir) : proxyToVite(config.vitePort);

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const method = req.method ?? 'GET';
    if (method === 'POST') {
      // A page on another origin cannot read the nonce, so it cannot mutate local state.
      const origin = req.headers.origin;
      if (req.headers[SESSION_HEADER] !== nonce || (origin !== undefined && !allowedOrigins.has(origin))) return sendJson(res, HTTP_STATUS.forbidden, FORBIDDEN('Invalid session or origin'));
    }
    const match = matchRoute(method, url.pathname);
    if (!match) return sendJson(res, HTTP_STATUS.notFound, NOT_FOUND);
    // The route table and the handler map share their keys, but TypeScript cannot correlate a
    // runtime key with its handler type; the parsing below enforces each route's own schemas.
    const handler = handlers[match.name] as ((request: { params: unknown; query: unknown; body: unknown }) => Promise<unknown>) | undefined;
    if (!handler) return sendJson(res, HTTP_STATUS.unavailable, NOT_READY(`Not ready: ${method} ${ROUTES[match.name].path} has no handler yet`));
    const route: Routes[RouteName] = ROUTES[match.name];
    try {
      const params = parseParams(match.params);
      const query = route.query ? requireValid(route.query, Object.fromEntries(url.searchParams), 'query') : undefined;
      const body = route.request ? requireValid(route.request, await readJsonBody(req), 'body') : undefined;
      const result = route.response.safeParse(await handler({ params, query, body }));
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
      console.error(error);
      if (!res.headersSent) sendJson(res, HTTP_STATUS.internalError, INTERNAL);
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

async function main() {
  const config = loadConfig();
  const isDev = process.argv.includes('--dev');
  // Vite runs only in development; recording serves the built files with no dev server.
  const vite = isDev ? await (await import('vite')).createServer({ configFile: join(repoRoot, 'vite.config.ts') }) : undefined;
  await vite?.listen();
  const server = createAppServer({ config, nonce: randomBytes(24).toString('hex'), frontend: isDev ? { kind: 'dev' } : { kind: 'static', distDir: join(repoRoot, 'dist') } });
  await listen(server, config.port);
  console.log(`llime is ready at ${config.appOrigin}/${isDev ? ` (Vite dev server on ${HOST}:${config.vitePort})` : ''}`);
  const stop = () => {
    server.close();
    server.closeAllConnections();
    void vite?.close();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
