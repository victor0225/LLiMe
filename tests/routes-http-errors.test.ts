import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { HOST, parseConfig } from '../src/config.js';
import { ErrorBodySchema } from '../src/domain.js';
import { ERROR_HTTP_STATUS, HttpErrorSchema, routePath, SESSION_HEADER } from '../src/routes.js';
import { createAppServer, type RouteHandlers } from '../src/server.js';

const config = parseConfig({ PORT: '4996', VITE_PORT: '4995', STORYBOOK_PORT: '4994' });
const NONCE = 'error-code-nonce';
let dist = '';

type Reply = { status: number; headers: IncomingHttpHeaders; text: string };

function send(server: Server, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = request({ host: HOST, port, method, path, headers: { host: `${HOST}:${config.port}`, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function withServer(handlers: RouteHandlers, check: (server: Server) => Promise<void>) {
  const server = createAppServer({ config, nonce: NONCE, handlers, frontend: { kind: 'static', distDir: dist } });
  await new Promise<void>((resolve) => server.listen(0, HOST, resolve));
  try {
    await check(server);
  } finally {
    server.close();
  }
}

before(() => {
  dist = mkdtempSync(join(tmpdir(), 'llime-errors-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>errors</title>');
});
after(() => rmSync(dist, { recursive: true, force: true }));

describe('HTTP error codes', () => {
  test('a refused Host, Origin or session is FORBIDDEN (403); an unbound handler is NOT_READY (503); a server fault is INTERNAL (500)', () => {
    assert.equal(ERROR_HTTP_STATUS.FORBIDDEN, 403);
    assert.equal(ERROR_HTTP_STATUS.NOT_READY, 503);
    assert.equal(ERROR_HTTP_STATUS.INTERNAL, 500);
  });

  test('an INTERNAL error carries a safe error ID and nothing else that could hold a stack', () => {
    assert.ok(HttpErrorSchema.safeParse({ code: 'INTERNAL', message: 'The server failed to answer this request', retryable: false, errorId: 'err_0123456789abcdef' }).success);
    assert.equal(HttpErrorSchema.safeParse({ code: 'INTERNAL', message: 'The server failed to answer this request', retryable: false }).success, false);
    for (const errorId of ['Error: boom\n    at main (/Users/x/src/server.ts:1:1)', '/Users/x/.env_secret', 'err 0123456789']) {
      assert.equal(ErrorBodySchema.safeParse({ code: 'INTERNAL', message: 'x', retryable: false, errorId }).success, false, errorId);
    }
    assert.equal(ErrorBodySchema.safeParse({ code: 'INTERNAL', message: 'x', retryable: false, errorId: 'err_0123456789', stack: 'at main' }).success, false);
  });

  test('the server answers a wrong Host with FORBIDDEN', async () => {
    await withServer({}, async (server) => {
      const reply = await send(server, 'GET', '/', { host: 'evil.example:4996' });
      assert.equal(reply.status, 403);
      assert.equal(HttpErrorSchema.parse(JSON.parse(reply.text)).code, 'FORBIDDEN');
    });
  });

  test('the server answers a POST without the session nonce with FORBIDDEN', async () => {
    await withServer({}, async (server) => {
      const reply = await send(server, 'POST', routePath('createRun'), { 'content-type': 'application/json' }, '{}');
      assert.equal(reply.status, 403);
      assert.equal(HttpErrorSchema.parse(JSON.parse(reply.text)).code, 'FORBIDDEN');
    });
  });

  test('the server answers a route without a handler with a retryable NOT_READY', async () => {
    await withServer({}, async (server) => {
      const reply = await send(server, 'GET', routePath('getRun', { runId: 'run-1' }));
      assert.equal(reply.status, 503);
      const error = HttpErrorSchema.parse(JSON.parse(reply.text));
      assert.deepEqual([error.code, error.retryable], ['NOT_READY', true]);
    });
  });

  test('a handler fault is a 500 INTERNAL whose error ID matches the log line and carries no text from the fault', async () => {
    const handlers: RouteHandlers = {
      getRun: async () => {
        throw new Error('secret-detail /Users/someone/.env');
      },
    };
    await withServer(handlers, async (server) => {
      const original = console.error;
      const logged: string[] = [];
      console.error = (...args: unknown[]) => logged.push(args.map(String).join(' '));
      try {
        const reply = await send(server, 'GET', routePath('getRun', { runId: 'run-1' }), { [SESSION_HEADER]: NONCE });
        assert.equal(reply.status, 500);
        const error = HttpErrorSchema.parse(JSON.parse(reply.text));
        assert.equal(error.code, 'INTERNAL');
        assert.ok(error.errorId);
        assert.doesNotMatch(reply.text, /secret-detail|\.env|at /);
        assert.ok(logged.some((line) => line.includes(error.errorId ?? 'missing') && line.includes('secret-detail')), 'the log line names the same error ID as the response');
      } finally {
        console.error = original;
      }
    });
  });
});
