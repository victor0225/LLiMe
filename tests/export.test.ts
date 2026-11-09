import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import { HOST, parseConfig } from '../src/config.js';
import { loadSeed } from '../src/dataset.js';
import { CONTRACT_VERSION, type SearchResult, validateCase } from '../src/domain.js';
import { readLesson } from '../src/inbox.js';
import { bootServer, type RunningServer } from '../src/server.js';
import { buildSearchResult, chooseActivity, rank, rankingHash } from '../src/search.js';
import { createRunId, Store } from '../src/store.js';
import { CAPTURE_FILES, CaptureManifestSchema, exportCapture, findLeaks, MANIFEST_FILE, REDACTED, redact } from '../scripts/export-capture.js';

// Real local Neo4j and the real route handlers. The run's events are appended directly, as the
// runtime adapter would; no model is called. Planted secrets are fake values.
const NONCE = 'export-suite-nonce-0123456789';
const FAKE_KEY = 'sk-test-0000000000000000000000fake';
const FAKE_SDP = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\na=ice-ufrag:fake\r\na=fingerprint:sha-256 00:11\r\n';
const created: string[] = [];
let store: Store;
let server: RunningServer;
let origin = '';
let scratch = '';
let runId = '';
let search: SearchResult;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, HOST, resolve));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('No port was assigned');
  return address.port;
}

// The real search over the pinned corpus for the recorded film query.
async function filmSearch(corpus: ReturnType<typeof loadSeed>): Promise<SearchResult> {
  const capture = z.object({ query: z.unknown() }).parse(JSON.parse(readFileSync(new URL('../data/captures/backend.capture.json', import.meta.url), 'utf8')));
  const query = validateCase(capture.query);
  const ranked = rank(query, corpus.cases);
  return buildSearchResult({ query, corpusHash: corpus.corpusHash, ranked, decision: chooseActivity(query, ranked, false), rankingHash: await rankingHash(ranked) });
}

before(async () => {
  store = await Store.connect();
  const corpus = loadSeed();
  scratch = mkdtempSync(join(tmpdir(), 'llime-export-'));
  writeFileSync(join(scratch, 'index.html'), '<!doctype html><title>llime</title>');
  const config = parseConfig({ PORT: String(await freePort()) });
  origin = config.appOrigin;
  server = await bootServer(
    {
      store: { getRun: (id) => store.getRun(id), events: (id, after) => store.events(id, after), getNotification: (id) => store.getNotification(id), appendEvents: (id, events) => store.appendEvents(id, events), close: async () => {} },
      createRun: async () => assert.fail('export creates no run'),
      lessons: { readLesson: (id) => readLesson(id, { rootDir: scratch, prepared: null }), saveTranscript: async () => assert.fail('export saves no lesson') },
      startInbox: async () => ({ stop: async () => {} }),
      startOutbox: async () => ({ stop: async () => {} }),
    },
    { config, nonce: NONCE, frontend: { kind: 'static', distDir: scratch }, dataset: 'synthetic', signals: new EventEmitter() },
  );
  await server.ready;

  runId = createRunId('test-export');
  created.push(runId);
  await store.createRun({ runId, seed: 7 }, corpus);
  search = await filmSearch(corpus);
  await store.appendEvents(runId, [
    { type: 'lesson.detected', payload: { contentHash: 'a'.repeat(64), source: 'local_file', bytes: 120 } },
    {
      type: 'runtime.input',
      payload: {
        threadId: 'thread-1',
        model: 'gpt-6.1-terra',
        serviceTier: 'priority',
        phase: 'ingestion',
        promptHash: 'b'.repeat(64),
        instructions: 'Read the lesson.',
        // The adapter's input is free-form, so this is where an unexpected field could slip through.
        input: { authorization: `Bearer ${FAKE_KEY}`, sdpOffer: FAKE_SDP, reasoning: 'hidden chain of thought', audio: 'UklGRgAAAABXQVZF', nonce: NONCE, apiKey: FAKE_KEY, text: 'lesson text' },
      },
    },
    { type: 'search.completed', payload: search },
    { type: 'runtime.message', payload: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', text: `Pasted by mistake: ${FAKE_KEY} and ${FAKE_SDP}`, partial: false } },
  ]);
});

after(async () => {
  await server?.shutdown();
  for (const id of created) await store.resetRun(id).catch(() => undefined);
  await store?.close();
  rmSync(scratch, { recursive: true, force: true });
});

const sha256 = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('demo:export (real Neo4j, real routes)', () => {
  test('export issues only GET requests, and DB node and event counts are unchanged', async () => {
    const methods: string[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      methods.push(init?.method ?? 'GET');
      return fetch(input, init);
    };
    const before = { namespace: await store.countNamespace(runId), seed: await store.seedCounts(), events: (await store.events(runId, 0)).length };
    await exportCapture({ origin, runId, capturesDir: join(scratch, 'get-only'), fetch: recordingFetch });
    assert.ok(methods.length >= 4);
    assert.deepEqual([...new Set(methods)], ['GET']);
    assert.deepEqual({ namespace: await store.countNamespace(runId), seed: await store.seedCounts(), events: (await store.events(runId, 0)).length }, before);
  });

  test('export redacts every forbidden field; the manifest hashes match the files; rankingHash equals the run\'s search.completed', async () => {
    const capturesDir = join(scratch, 'redaction');
    const { captureId, dir } = await exportCapture({ origin, runId, capturesDir });
    assert.equal(dir, join(capturesDir, captureId));
    const manifest = CaptureManifestSchema.parse(JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8')));

    // Voice is not bound on this server, so the capture holds no voice status.
    assert.deepEqual(Object.keys(manifest.files).sort(), [CAPTURE_FILES.bootstrap, CAPTURE_FILES.events, CAPTURE_FILES.lesson, CAPTURE_FILES.snapshot].sort());
    assert.deepEqual(readdirSync(dir).sort(), [...Object.keys(manifest.files), MANIFEST_FILE].sort());
    for (const [file, hash] of Object.entries(manifest.files)) assert.equal(sha256(join(dir, file)), hash, file);

    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const secret of [FAKE_KEY, NONCE, 'v=0', 'ice-ufrag', 'hidden chain of thought', 'UklGRgAAAABXQVZF']) assert.equal(text.includes(secret), false, `${file} holds ${secret}`);
      assert.deepEqual(findLeaks(JSON.parse(text), [NONCE]), [], file);
    }
    const events = z.array(z.object({ type: z.string(), payload: z.record(z.string(), z.unknown()) })).parse(JSON.parse(readFileSync(join(dir, CAPTURE_FILES.events), 'utf8')));
    const input = z.record(z.string(), z.unknown()).parse(events.find((e) => e.type === 'runtime.input')?.payload.input);
    assert.deepEqual(input, { authorization: REDACTED, sdpOffer: REDACTED, reasoning: REDACTED, audio: REDACTED, nonce: REDACTED, apiKey: REDACTED, text: 'lesson text' });

    assert.equal(manifest.rankingHash, search.rankingHash);
    assert.deepEqual(manifest.promptHashes, [{ phase: 'ingestion', promptHash: 'b'.repeat(64) }]);
    assert.equal(manifest.contractVersion, CONTRACT_VERSION);
    assert.equal(manifest.corpusHash, search.corpusHash);
    assert.equal(manifest.runId, runId);
    assert.equal(manifest.throughSeq, 4);
    assert.equal(manifest.source, 'recorded');
    assert.match(manifest.commit.sha, /^[0-9a-f]{40}$/);
  });

  test('an unknown run is refused and leaves no capture directory', async () => {
    const capturesDir = join(scratch, 'unknown');
    await assert.rejects(exportCapture({ origin, runId: 'test-export-unknown', capturesDir }), /Unknown run test-export-unknown/);
    assert.equal(existsSync(capturesDir) && readdirSync(capturesDir).length > 0, false);
  });
});

describe('redact', () => {
  test('replaces forbidden fields and secret text but keeps ordinary status fields', () => {
    const planted = { headers: { Authorization: 'Bearer abcdefgh12345678' }, sdpAnswer: FAKE_SDP, reasoning_summary: 'x', rawAudio: 'AAAA', audioGate: 'closed', note: `key ${FAKE_KEY} here`, nested: [{ sessionNonce: 'n' }] };
    assert.deepEqual(redact(planted, ['n0nce']), { headers: { Authorization: REDACTED }, sdpAnswer: REDACTED, reasoning_summary: REDACTED, rawAudio: REDACTED, audioGate: 'closed', note: `key ${REDACTED} here`, nested: [{ sessionNonce: 'n' }] });
    assert.deepEqual(findLeaks(redact(planted, ['n0nce']), ['n0nce']), []);
  });

  test('findLeaks names each surviving secret by path', () => {
    assert.deepEqual(findLeaks({ a: { authorization: 'x' }, b: [`${FAKE_KEY}`], c: FAKE_SDP }), ['$.a.authorization: credential field', '$.b[0]: provider key', '$.c: SDP body']);
  });
});
