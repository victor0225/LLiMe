import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { type Config, HOST, parseConfig } from '../src/config.js';
import { type Command, ErrorBodySchema } from '../src/domain.js';
import { MAX_JSON_BODY_BYTES, routePath, SESSION_HEADER } from '../src/routes.js';
import { createAppServer, listen, RouteError, type RouteHandlers } from '../src/server.js';

// The configured app port drives Host and Origin checks; the test server itself listens on a free
// port and requests carry the configured Host header, so no fixed port is needed.
const config: Config = parseConfig({ PORT: '4999', VITE_PORT: '4998', STORYBOOK_PORT: '4997' });
const appHost = `${HOST}:${config.port}`;
const NONCE = 'test-session-nonce';
const RUN_ID = 'run-1';
const COMMAND: Command = { type: 'accept', commandId: '6f1c1f43-2a52-4d6b-9a8e-6f8f7c0d9b11', revision: 3 };

type Reply = { status: number; headers: IncomingHttpHeaders; text: string };
type Send = { method?: string; path: string; headers?: Record<string, string>; body?: string };

let dist = '';

const notCalled = async (): Promise<never> => {
  throw new Error('The guard must reject the request before the handler runs');
};

function portOf(server: Server): AddressInfo {
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object', 'the server is listening on a TCP port');
  return address;
}

function startServer(handlers: RouteHandlers = {}): Promise<Server> {
  const server = createAppServer({ config, nonce: NONCE, handlers, frontend: { kind: 'static', distDir: dist } });
  return new Promise((resolve) => server.listen(0, HOST, () => resolve(server)));
}

function send(server: Server, { method = 'GET', path, headers = {}, body }: Send): Promise<Reply> {
  const { port } = portOf(server);
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, method, path, headers: { host: appHost, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const post = (server: Server, path: string, body: unknown, headers: Record<string, string> = {}) =>
  send(server, { method: 'POST', path, body: JSON.stringify(body), headers: { [SESSION_HEADER]: NONCE, origin: config.appOrigin, 'content-type': 'application/json', ...headers } });

const errorOf = (reply: Reply) => ErrorBodySchema.parse(JSON.parse(reply.text));

async function withServer(handlers: RouteHandlers, check: (server: Server) => Promise<void>) {
  const server = await startServer(handlers);
  try {
    await check(server);
  } finally {
    server.close();
  }
}

before(() => {
  dist = mkdtempSync(join(tmpdir(), 'llime-shell-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(join(dist, 'assets', 'main-1.js'), 'export {};');
  writeFileSync(join(dist, 'assets', 'notes.txt'), 'not a served type');
  writeFileSync(join(dist, '..', 'outside-dist.html'), 'must never be served');
});

after(() => {
  rmSync(join(dist, '..', 'outside-dist.html'), { force: true });
  rmSync(dist, { recursive: true, force: true });
});

describe('configuration', () => {
  test('derives the app origin from PORT on loopback', () => {
    assert.equal(parseConfig({ PORT: '4110' }).appOrigin, 'http://127.0.0.1:4110');
  });

  test('uses the default ports when the variables are unset or empty, as in .env.example', () => {
    const defaults = parseConfig({ PORT: '', VITE_PORT: '', STORYBOOK_PORT: '' });
    assert.deepEqual([defaults.port, defaults.vitePort, defaults.storybookPort], [4317, 5173, 6006]);
  });

  test('treats an empty secret as missing, never as an empty password', () => {
    assert.equal(parseConfig({ NEO4J_PASSWORD: '', OPENAI_API_KEY: '' }).neo4j.password, undefined);
  });

  test('rejects a port that is not a number in range', () => {
    assert.throws(() => parseConfig({ PORT: 'abc' }), /PORT/);
    assert.throws(() => parseConfig({ PORT: '80' }), /PORT/);
  });

  test('rejects two services on the same port', () => {
    assert.throws(() => parseConfig({ PORT: '4110', VITE_PORT: '4110' }), /must differ/);
  });

  test('rejects a database outside loopback', () => {
    assert.throws(() => parseConfig({ NEO4J_URI: 'bolt://db.example.com:7687' }), /NEO4J_URI/);
  });

  test('names the bad variable without echoing its value', () => {
    assert.throws(() => parseConfig({ LLIME_MODEL: 'secret-looking-value' }), (error: Error) => error.message.includes('LLIME_MODEL') && !error.message.includes('secret-looking-value'));
  });
});

describe('request guards', () => {
  test('binds to 127.0.0.1 only', async () => {
    const server = createAppServer({ config, nonce: NONCE, frontend: { kind: 'static', distDir: dist } });
    await listen(server, 0);
    try {
      assert.equal(portOf(server).address, HOST);
    } finally {
      server.close();
    }
  });

  test('rejects a request whose Host is not the configured app origin', async () => {
    await withServer({}, async (server) => {
      for (const host of ['evil.example:4999', `${HOST}:4317`, `localhost:${config.port}`, `localhost:${config.port + 1}`]) {
        const reply = await send(server, { path: '/', headers: { host } });
        assert.equal(reply.status, 403, host);
      }
      assert.equal((await send(server, { path: '/', headers: { host: appHost } })).status, 200);
    });
  });

  test('rejects a POST without the session nonce or from another origin, and sends no CORS headers', async () => {
    await withServer({ createRun: notCalled }, async (server) => {
      const noNonce = await send(server, { method: 'POST', path: routePath('createRun'), body: '{}', headers: { origin: config.appOrigin } });
      const otherOrigin = await post(server, routePath('createRun'), {}, { origin: 'http://127.0.0.1:4317' });
      for (const reply of [noNonce, otherOrigin]) {
        assert.equal(reply.status, 403);
        errorOf(reply);
        assert.equal(reply.headers['access-control-allow-origin'], undefined);
      }
    });
  });
});

describe('API routes', () => {
  test('a route without a bound handler answers with an explicit not-ready error', async () => {
    await withServer({}, async (server) => {
      const reply = await send(server, { path: routePath('getRun', { runId: RUN_ID }) });
      assert.equal(reply.status, 503);
      const error = errorOf(reply);
      assert.equal(error.retryable, true);
      assert.match(error.message, /not ready/i);
    });
  });

  test('an unknown API path is a 404', async () => {
    await withServer({}, async (server) => {
      const reply = await send(server, { path: '/api/nothing-here' });
      assert.equal(reply.status, 404);
      assert.equal(errorOf(reply).code, 'NOT_FOUND');
    });
  });

  test('an unknown run is a 404', async () => {
    const handlers: RouteHandlers = {
      runEvents: async ({ params }) => {
        throw new RouteError({ code: 'NOT_FOUND', message: `Run ${params.runId} not found`, retryable: false });
      },
    };
    await withServer(handlers, async (server) => {
      const reply = await send(server, { path: `${routePath('runEvents', { runId: 'missing' })}?after=0` });
      assert.equal(reply.status, 404);
      assert.equal(errorOf(reply).code, 'NOT_FOUND');
    });
  });

  test('a stale revision and a conflicting command are 409s that carry the current revision', async () => {
    for (const code of ['STALE_REVISION', 'CONFLICT'] as const) {
      const handlers: RouteHandlers = {
        runCommand: async () => {
          throw new RouteError({ code, message: 'The run moved on', retryable: true, revision: 4 });
        },
      };
      await withServer(handlers, async (server) => {
        const reply = await post(server, routePath('runCommand', { runId: RUN_ID }), COMMAND);
        assert.equal(reply.status, 409, code);
        assert.deepEqual(errorOf(reply), { code, message: 'The run moved on', retryable: true, revision: 4 });
      });
    }
  });

  test('passes the validated path, query and body to the bound handler', async () => {
    const seen: unknown[] = [];
    const handlers: RouteHandlers = {
      runEvents: async ({ params, query }) => {
        seen.push(params.runId, query.after);
        return [];
      },
      runCommand: async ({ body }) => {
        seen.push(body.type);
        throw new RouteError({ code: 'WRONG_PHASE', message: 'Not now', retryable: false, revision: 0 });
      },
    };
    await withServer(handlers, async (server) => {
      const events = await send(server, { path: `${routePath('runEvents', { runId: RUN_ID })}?after=7` });
      assert.equal(events.status, 200);
      assert.deepEqual(JSON.parse(events.text), []);
      assert.equal(events.headers['cache-control'], 'no-store');
      assert.equal((await post(server, routePath('runCommand', { runId: RUN_ID }), COMMAND)).status, 409);
      assert.deepEqual(seen, [RUN_ID, 7, 'accept']);
    });
  });

  test('rejects an invalid cursor, malformed JSON or a body that fails the route schema with 400 before the handler runs', async () => {
    let calls = 0;
    const handlers: RouteHandlers = {
      runEvents: async () => {
        calls += 1;
        return [];
      },
      runCommand: async () => {
        calls += 1;
        throw new RouteError({ code: 'CONFLICT', message: 'unexpected', retryable: false, revision: 0 });
      },
    };
    await withServer(handlers, async (server) => {
      const replies = [
        await send(server, { path: `${routePath('runEvents', { runId: RUN_ID })}?after=-1` }),
        await send(server, { path: routePath('runEvents', { runId: RUN_ID }) }),
        await send(server, { method: 'POST', path: routePath('runCommand', { runId: RUN_ID }), body: '{not json', headers: { [SESSION_HEADER]: NONCE } }),
        await post(server, routePath('runCommand', { runId: RUN_ID }), { type: 'accept' }),
      ];
      assert.deepEqual(replies.map((r) => [r.status, errorOf(r).code]), Array(4).fill([400, 'INVALID_INPUT']));
      assert.equal(calls, 0);
    });
  });

  test('rejects a body over the size limit with 413', async () => {
    const handlers: RouteHandlers = { createRun: notCalled };
    await withServer(handlers, async (server) => {
      const reply = await post(server, routePath('createRun'), { padding: 'x'.repeat(MAX_JSON_BODY_BYTES) });
      assert.equal(reply.status, 413);
      assert.equal(errorOf(reply).code, 'PAYLOAD_TOO_LARGE');
    });
  });

  test('a handler result that breaks the response schema is a 500, never sent to the browser', async () => {
    // JSON.parse stands in for a handler bug: its value is checked only at run time.
    const handlers: RouteHandlers = { runEvents: async () => JSON.parse('[{"seq":1}]') };
    await withServer(handlers, async (server) => {
      const reply = await send(server, { path: `${routePath('runEvents', { runId: RUN_ID })}?after=0` });
      assert.equal(reply.status, 500);
      assert.doesNotMatch(reply.text, /seq/);
    });
  });
});

describe('static files', () => {
  test('serves the built page and assets with the content security policy', async () => {
    await withServer({}, async (server) => {
      const page = await send(server, { path: '/' });
      assert.equal(page.status, 200);
      assert.match(page.headers['content-type'] ?? '', /^text\/html/);
      assert.match(String(page.headers['content-security-policy']), /script-src 'self';/);
      const script = await send(server, { path: '/assets/main-1.js' });
      assert.equal(script.status, 200);
      assert.match(script.headers['content-type'] ?? '', /^text\/javascript/);
    });
  });

  test('serves the page for a client route so screens can be opened by URL', async () => {
    await withServer({}, async (server) => {
      const reply = await send(server, { path: '/lesson-notes' });
      assert.equal(reply.status, 200);
      assert.match(reply.text, /<title>shell<\/title>/);
    });
  });

  test('serves nothing outside the built files or of an unlisted type', async () => {
    await withServer({}, async (server) => {
      for (const path of ['/assets/notes.txt', '/../outside-dist.html', '/%2e%2e/outside-dist.html', '/assets/..%2f..%2foutside-dist.html', '/.env', '/package.json']) {
        assert.equal((await send(server, { path })).status, 404, path);
      }
    });
  });
});
