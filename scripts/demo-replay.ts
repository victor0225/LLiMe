// npm run demo:replay -- --capture CAPTURE_ID [--port N]
// Serves an exported capture read-only: the built viewers plus the GET routes, answered from the
// capture files. Every POST is refused, and nothing here opens the database, the Codex runtime or a
// voice session, so watching a replay any number of times changes no record.
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { HOST, parseConfig, repoRoot } from '../src/config.js';
import { type Bootstrap, ROUTES, type RouteName } from '../src/routes.js';
import { createAppServer, listen, RouteError, type RouteHandlers } from '../src/server.js';
import { CAPTURES_DIR, type Capture, CaptureError, loadCapture } from './export-capture.js';

const PortSchema = z.coerce.number().int().min(1024).max(65535);

const READ_ONLY: RouteError['body'] = { code: 'FORBIDDEN', message: 'This is a read-only replay; it accepts no commands', retryable: false };
const unknownRun = (runId: string) => new RouteError({ code: 'NOT_FOUND', message: `Unknown run ${runId}`, retryable: false });

class ReplayError extends Error {}

const isRouteName = (name: string): name is RouteName => Object.hasOwn(ROUTES, name);

// Answers from the capture only. A route the capture holds no answer for stays unbound, which the
// server reports as not ready, the same as the live server without that module.
export function replayHandlers(capture: Capture, nonce: string): RouteHandlers {
  const { snapshot, voiceSnapshot } = capture;
  const runOf = (runId: string) => {
    if (runId !== snapshot.id) throw unknownRun(runId);
  };
  // Typed with the parsed output, so the replay answer cannot leave out its mode.
  const bootstrap: Bootstrap = { ...capture.bootstrap, nonce, mode: 'replay', captureId: capture.manifest.captureId };
  const reads: RouteHandlers = {
    bootstrap: async () => bootstrap,
    getRun: async ({ params }) => (runOf(params.runId), snapshot),
    runEvents: async ({ params, query }) => (runOf(params.runId), capture.events.filter((e) => e.seq > query.after)),
    getLesson: async ({ params }) => (runOf(params.runId), capture.lesson),
    ...(voiceSnapshot ? { voiceSnapshot: async ({ params }) => (runOf(params.runId), voiceSnapshot) } : {}),
  };
  const refuse = async (): Promise<never> => {
    throw new RouteError(READ_ONLY);
  };
  const writes: RouteHandlers = {};
  for (const name of Object.keys(ROUTES).filter(isRouteName)) if (ROUTES[name].method === 'POST') writes[name] = refuse;
  return { ...writes, ...reads };
}

// True when something already accepts connections on the port; replay never shadows a live server.
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

export type ReplayOptions = { captureId: string; port: number; capturesDir?: string; distDir?: string };
export type RunningReplay = { url: string; capture: Capture; close(): Promise<void> };

export async function startReplay({ captureId, port, capturesDir = join(repoRoot, CAPTURES_DIR), distDir = join(repoRoot, 'dist') }: ReplayOptions): Promise<RunningReplay> {
  const replayPort = PortSchema.parse(port);
  if (await isListening(replayPort)) throw new ReplayError(`Port ${replayPort} is already in use; replay never shares a port with a running server. Find its owner with: lsof -nP -iTCP:${replayPort} -sTCP:LISTEN`);
  const capture = await loadCapture(captureId, capturesDir);
  // Only the port is configured: no database or provider setting reaches this process.
  const config = parseConfig({ PORT: String(replayPort) });
  const nonce = randomBytes(24).toString('hex');
  const server: Server = createAppServer({ config, nonce, handlers: replayHandlers(capture, nonce), frontend: { kind: 'static', distDir } });
  await listen(server, replayPort);
  return {
    url: `${config.appOrigin}/`,
    capture,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

async function main() {
  const { values } = parseArgs({ options: { capture: { type: 'string' }, port: { type: 'string' } }, strict: true });
  if (!values.capture) throw new ReplayError('Usage: npm run demo:replay -- --capture CAPTURE_ID [--port N]');
  // Without --port, the replay takes the app port the shell assigns (default 4317), so it starts only
  // once the live server on that port is stopped. The worktree .env is not read: it holds credentials.
  const port = values.port ?? String(parseConfig({ PORT: process.env.PORT }).port);
  const replay = await startReplay({ captureId: values.capture, port: PortSchema.parse(port) });
  const { manifest } = replay.capture;
  console.log(`Replay of capture ${manifest.captureId} (run ${manifest.runId}, recorded through seq ${manifest.throughSeq}) is read-only at ${replay.url}`);
  const stop = () => void replay.close().then(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof ReplayError || error instanceof CaptureError || error instanceof z.ZodError ? `demo:replay: ${error.message}` : error);
    process.exit(1);
  });
}
