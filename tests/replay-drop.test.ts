import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { z } from 'zod';
import { repoRoot } from '../src/config.js';
import { INBOX_DIR, PREPARED_LESSON_DIR, PREPARED_LESSON_MISMATCH } from '../src/inbox.js';
import { DropRefused, dropLesson } from '../scripts/demo-drop.js';

const RUN_ID = 'test-replay-drop-run';
const transcriptPath = (root: string) => join(root, PREPARED_LESSON_DIR, 'lesson-transcript.txt');
const filesUnder = (root: string) => readdirSync(root, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(root, join(e.parentPath, e.name))).sort();

let root = '';
const realFetch = globalThis.fetch;
let requests: string[] = [];

beforeEach(() => {
  // A scratch checkout holding only the prepared lesson, so any other write would show up.
  root = mkdtempSync(join(tmpdir(), 'llime-replay-drop-'));
  cpSync(join(repoRoot, PREPARED_LESSON_DIR), join(root, PREPARED_LESSON_DIR), { recursive: true });
  requests = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    throw new Error('demo:drop must not call the server');
  };
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
});

describe('demo:drop', () => {
  test('drop refuses a transcript whose hash differs from the manifest', async () => {
    writeFileSync(transcriptPath(root), `${readFileSync(transcriptPath(root), 'utf8')} `);
    await assert.rejects(dropLesson({ runId: RUN_ID, rootDir: root }), (error: unknown) => error instanceof DropRefused && error.message === PREPARED_LESSON_MISMATCH);
    assert.deepEqual(filesUnder(root), ['data/lesson/lesson-transcript.txt', 'data/lesson/manifest.json']);
    assert.deepEqual(requests, []);
  });

  test('otherwise it writes one inbox file through saveTranscript and calls nothing else', async () => {
    const manifest = z.object({ sha256: z.string() }).parse(JSON.parse(readFileSync(join(root, PREPARED_LESSON_DIR, 'manifest.json'), 'utf8')));
    const result = await dropLesson({ runId: RUN_ID, rootDir: root });
    assert.equal(result.contentHash, manifest.sha256);
    assert.deepEqual(filesUnder(root), ['data/lesson/lesson-transcript.txt', 'data/lesson/manifest.json', `${INBOX_DIR}/${RUN_ID}.txt`].sort());
    assert.deepEqual(readFileSync(join(root, INBOX_DIR, `${RUN_ID}.txt`)), readFileSync(transcriptPath(root)));
    assert.deepEqual(requests, [], 'no HTTP request: ingestion starts only from the watcher');
  });

  test('a run ID that cannot name an inbox file is refused before anything is written', async () => {
    await assert.rejects(dropLesson({ runId: '../escape', rootDir: root }));
    assert.deepEqual(filesUnder(root), ['data/lesson/lesson-transcript.txt', 'data/lesson/manifest.json']);
  });
});
