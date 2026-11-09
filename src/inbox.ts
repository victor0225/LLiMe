// Lesson inbox. The Lesson notes save writes a run's transcript into its inbox file, and only this
// watcher turns a saved file into ingestion: it waits for a complete, stable, valid file, commits the
// WAITING -> INGESTING transition, and starts the one ingestion turn after that commit.
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats, watch } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { ErrorCodeSchema, type ErrorCode, IdSchema, type LessonRecord, type RunState } from './domain.js';
import { LESSON_TEXT_MAX_BYTES, LessonSaveInputSchema, LessonSaveOutputSchema, type LessonStatus, LessonStatusSchema, utf8ByteLength } from './routes.js';

// Both paths are relative to the project root.
export const INBOX_DIR = '.runtime/inbox';
export const PREPARED_LESSON_DIR = 'data/lesson';

// A transcript file is held to the same limit as the text the Lesson notes screen may save.
export const INBOX_FILE_MAX_BYTES = LESSON_TEXT_MAX_BYTES;
// File events can be missed or coalesced, so a periodic scan is the backstop that reconciles them.
export const INBOX_SCAN_INTERVAL_MS = 1_000;
// A file is complete only when two checks at least this far apart see the same inode, size and
// modification time; a writer that is still appending changes one of them in between.
export const INBOX_STABILITY_WINDOW_MS = 500;

// A run ID becomes a file name, so only characters that cannot leave the inbox directory are allowed.
const RunFileIdSchema = IdSchema.regex(/^[A-Za-z0-9_-]+$/);
const INBOX_FILE_PATTERN = /^([A-Za-z0-9_-]+)\.txt$/;

export type InboxConfig = { rootDir: string };
export type LessonSaveOutput = z.infer<typeof LessonSaveOutputSchema>;

const inboxDir = (config: InboxConfig) => resolve(config.rootDir, INBOX_DIR);
const inboxFileName = (runId: string) => `${runId}.txt`;
const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Decoding is strict so an invalid byte sequence is refused rather than silently replaced, and keeps
// a byte-order mark so the decoded text re-encodes to exactly the bytes that were hashed.
const decodeUtf8 = (bytes: Uint8Array) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);

export class LessonSaveError extends Error {
  readonly code: Extract<ErrorCode, 'INVALID_INPUT' | 'PAYLOAD_TOO_LARGE'>;
  constructor(code: LessonSaveError['code'], message: string) {
    super(message);
    this.name = 'LessonSaveError';
    this.code = code;
  }
}

function requireRunFileId(runId: string): string {
  const parsed = RunFileIdSchema.safeParse(runId);
  if (!parsed.success) throw new LessonSaveError('INVALID_INPUT', 'The run ID cannot name an inbox file');
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Saving and reading

// Writes the transcript only; it never starts ingestion. The bytes go to a temporary name that the
// watcher ignores, are flushed, and are then renamed over the run's file, so a reader sees either the
// previous complete file or the new complete file, never a partial one.
export async function saveTranscript(runId: string, text: string, config: InboxConfig): Promise<LessonSaveOutput> {
  const id = requireRunFileId(runId);
  if (utf8ByteLength(text) > INBOX_FILE_MAX_BYTES) throw new LessonSaveError('PAYLOAD_TOO_LARGE', 'The lesson is larger than 16 KB');
  const input = LessonSaveInputSchema.safeParse({ text });
  if (!input.success) throw new LessonSaveError('INVALID_INPUT', input.error.issues[0]?.message ?? 'The lesson is not valid');

  const bytes = new TextEncoder().encode(input.data.text);
  const dir = inboxDir(config);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = join(dir, `.${id}.${randomUUID()}.tmp`);
  try {
    const file = await open(tempPath, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tempPath, join(dir, inboxFileName(id)));
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
  return LessonSaveOutputSchema.parse({ saved: true, contentHash: sha256Hex(bytes) });
}

const PreparedLessonManifestSchema = z.object({
  file: z.string().regex(/^[A-Za-z0-9._-]+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().min(1),
  encoding: z.literal('utf-8'),
});

export type PreparedLesson = NonNullable<LessonStatus['prepared']>;
export const PREPARED_LESSON_MISSING = 'Prepared transcript is missing';
export const PREPARED_LESSON_MISMATCH = 'Prepared transcript does not match its manifest';
export type PreparedLessonLoad = { prepared: PreparedLesson; problem: null } | { prepared: null; problem: string };

// Read once when the server starts. The prepared transcript is offered only while its bytes match the
// manifest, so an edited copy is never presented as the prepared lesson; otherwise the screen offers
// loading a file instead, and the caller logs the problem. A malformed manifest is a broken checkout.
export async function loadPreparedLesson(config: InboxConfig): Promise<PreparedLessonLoad> {
  const dir = resolve(config.rootDir, PREPARED_LESSON_DIR);
  const manifestBytes = await readIfPresent(join(dir, 'manifest.json'));
  if (manifestBytes === null) return { prepared: null, problem: PREPARED_LESSON_MISSING };
  const manifest = PreparedLessonManifestSchema.parse(JSON.parse(manifestBytes.toString('utf8')));
  const bytes = await readIfPresent(join(dir, manifest.file));
  if (bytes === null) return { prepared: null, problem: PREPARED_LESSON_MISSING };
  if (bytes.byteLength !== manifest.bytes || sha256Hex(bytes) !== manifest.sha256) return { prepared: null, problem: PREPARED_LESSON_MISMATCH };
  return { prepared: { text: decodeUtf8(bytes), sha256: manifest.sha256 }, problem: null };
}

// What the Lesson notes screen shows for a run: the absolute path of its inbox file, whether a lesson
// was saved there, and the prepared transcript loaded at start. The caller has checked the run exists.
export async function readLesson(runId: string, config: InboxConfig & { prepared: PreparedLesson | null }): Promise<LessonStatus> {
  const id = requireRunFileId(runId);
  const inboxFile = join(inboxDir(config), inboxFileName(id));
  const saved = await readIfPresent(inboxFile);
  return LessonStatusSchema.parse({
    inboxFile,
    saved: saved !== null,
    contentHash: saved === null ? null : sha256Hex(saved),
    prepared: config.prepared,
  });
}

// A run belongs to the server whose inbox received its lesson. Every worktree and test suite on a
// computer shares one database, so a server uses this to act only on its own runs.
export async function hasInboxLesson(runId: string, config: InboxConfig): Promise<boolean> {
  if (!RunFileIdSchema.safeParse(runId).success) return false;
  try {
    return (await lstat(join(inboxDir(config), inboxFileName(runId)))).isFile();
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return false;
    throw error;
  }
}

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------
// Watching

// The store functions ingestion consumes. `beginIngestion` is the WAITING -> INGESTING transition: it
// saves the lesson and writes lesson.detected in one transaction, refuses a run that is no longer
// WAITING, and reports `replayed` when this content's transition was already committed earlier.
export interface IngestionStore {
  getRun(runId: string): Promise<{ revision: number; state: Pick<RunState, 'phase' | 'stopped'> }>;
  beginIngestion(runId: string, input: { expectedRevision: number; lesson: LessonRecord }): Promise<{ replayed: boolean }>;
}

// Starts the run's real ingestion turn. Called once per run, only after the transition committed.
export type StartIngestionTurn = (runId: string) => Promise<void>;

export interface InboxScannerDeps extends InboxConfig {
  store: IngestionStore;
  startIngestionTurn: StartIngestionTurn;
  // Milliseconds; injected so stability is decided by a clock the caller controls.
  now: () => number;
  onOutcome?: (outcome: InboxOutcome) => void;
}

// Everything a check decided about a lesson file. A file still being written yields no outcome.
// `deferred` means nothing was committed and the next scan tries again.
export type InboxOutcome =
  | { kind: 'ingestion_started'; runId: string; contentHash: string }
  | { kind: 'ignored'; fileName: string; reason: 'unknown_run' | 'not_waiting' | 'duplicate' | 'already_started' }
  | { kind: 'rejected'; fileName: string; reason: 'not_a_file' | 'unreadable' | 'too_large' | 'empty' | 'invalid_utf8' }
  | { kind: 'deferred'; fileName: string; reason: string }
  | { kind: 'turn_failed'; runId: string; contentHash: string; reason: string }
  | { kind: 'scan_failed'; reason: string };

export interface InboxScanner {
  // Checks every file in the inbox once.
  scanInbox(): Promise<InboxOutcome[]>;
  // Checks one file named by a file event.
  fileChanged(fileName: string): Promise<InboxOutcome[]>;
  // Resolves once every check requested so far has finished.
  idle(): Promise<void>;
}

type Observation = { fingerprint: string; at: number };
type FileStats = { ino: number; size: number; mtimeMs: number };

const fingerprintOf = (stats: FileStats) => `${stats.ino}:${stats.size}:${stats.mtimeMs}`;

export function createInboxScanner(deps: InboxScannerDeps): InboxScanner {
  const dir = inboxDir(deps);
  // Last unchanged sighting of each file still waiting to prove it is complete.
  const observed = new Map<string, Observation>();
  // The fingerprint each file had when it was decided, so an unchanged file is not decided again.
  const decided = new Map<string, string>();
  // Lesson contents already handled per run: the same content saved again never starts more work.
  const handled = new Set<string>();
  // Checks run one at a time, so a file event and a scan of the same file cannot both act on it.
  let queue: Promise<unknown> = Promise.resolve();

  const serialize = <T>(job: () => Promise<T>): Promise<T> => {
    const next = queue.then(job);
    queue = next.catch(() => undefined);
    return next;
  };

  const report = (outcomes: InboxOutcome[]): InboxOutcome[] => {
    for (const outcome of outcomes) deps.onOutcome?.(outcome);
    return outcomes;
  };

  async function check(fileName: string): Promise<InboxOutcome[]> {
    const runId = INBOX_FILE_PATTERN.exec(fileName)?.[1];
    if (runId === undefined) return [];
    const path = join(dir, fileName);

    let stats: Stats;
    try {
      stats = await lstat(path);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') return [{ kind: 'rejected', fileName, reason: 'unreadable' }];
      observed.delete(fileName);
      decided.delete(fileName);
      return [];
    }
    const fingerprint = fingerprintOf(stats);
    if (decided.get(fileName) === fingerprint) return [];
    const decide = (outcome: InboxOutcome): InboxOutcome[] => {
      observed.delete(fileName);
      decided.set(fileName, fingerprint);
      return [outcome];
    };
    if (!stats.isFile()) return decide({ kind: 'rejected', fileName, reason: 'not_a_file' });
    if (!isStable(fileName, fingerprint)) return [];
    if (stats.size > INBOX_FILE_MAX_BYTES) return decide({ kind: 'rejected', fileName, reason: 'too_large' });

    let bytes: Buffer | null;
    try {
      bytes = await readUnchanged(path, fingerprint);
    } catch {
      // A file this process may not read stays refused until it is saved again (a new inode), and it
      // never holds up the other files in the scan.
      return decide({ kind: 'rejected', fileName, reason: 'unreadable' });
    }
    if (bytes === null) {
      // It changed after the stability checks; start them over.
      observed.delete(fileName);
      return [];
    }
    let text: string;
    try {
      text = decodeUtf8(bytes);
    } catch {
      return decide({ kind: 'rejected', fileName, reason: 'invalid_utf8' });
    }
    if (!LessonSaveInputSchema.safeParse({ text }).success) return decide({ kind: 'rejected', fileName, reason: 'empty' });

    const contentHash = sha256Hex(bytes);
    const contentKey = `${runId}:${contentHash}`;
    if (handled.has(contentKey)) return decide({ kind: 'ignored', fileName, reason: 'duplicate' });

    const result = await beginIngestion(runId, { contentHash, text, source: 'local_file', savedAt: new Date(stats.mtimeMs).toISOString() });
    if (result.kind === 'deferred') return [{ kind: 'deferred', fileName, reason: result.reason }];
    handled.add(contentKey);
    if (result.kind === 'ignored') return decide({ kind: 'ignored', fileName, reason: result.reason });
    startTurn(runId, contentHash);
    return decide({ kind: 'ingestion_started', runId, contentHash });
  }

  // Records the first sighting of a fingerprint; true once the same fingerprint has held for a full window.
  function isStable(fileName: string, fingerprint: string): boolean {
    const previous = observed.get(fileName);
    if (previous === undefined || previous.fingerprint !== fingerprint) {
      observed.set(fileName, { fingerprint, at: deps.now() });
      return false;
    }
    return deps.now() - previous.at >= INBOX_STABILITY_WINDOW_MS;
  }

  type BeginResult = { kind: 'started' } | { kind: 'ignored'; reason: 'unknown_run' | 'not_waiting' | 'already_started' } | { kind: 'deferred'; reason: string };

  async function beginIngestion(runId: string, lesson: LessonRecord): Promise<BeginResult> {
    let run: Awaited<ReturnType<IngestionStore['getRun']>>;
    try {
      run = await deps.store.getRun(runId);
    } catch (error) {
      return errorCodeOf(error) === 'NOT_FOUND' ? { kind: 'ignored', reason: 'unknown_run' } : { kind: 'deferred', reason: messageOf(error) };
    }
    if (run.state.phase !== 'WAITING' || run.state.stopped) return { kind: 'ignored', reason: 'not_waiting' };
    try {
      const { replayed } = await deps.store.beginIngestion(runId, { expectedRevision: run.revision, lesson });
      return replayed ? { kind: 'ignored', reason: 'already_started' } : { kind: 'started' };
    } catch (error) {
      switch (errorCodeOf(error)) {
        case 'NOT_FOUND':
          return { kind: 'ignored', reason: 'unknown_run' };
        case 'WRONG_PHASE':
          return { kind: 'ignored', reason: 'not_waiting' };
        // The same content was committed by an earlier save with another timestamp.
        case 'CONFLICT':
          return { kind: 'ignored', reason: 'already_started' };
        // STALE_REVISION and infrastructure failures committed nothing; the next scan rereads the run.
        default:
          return { kind: 'deferred', reason: messageOf(error) };
      }
    }
  }

  // The turn runs far longer than a check, so it is not awaited; its failure is reported, never retried,
  // because the run already left WAITING and a second turn must never start.
  function startTurn(runId: string, contentHash: string): void {
    let turn: Promise<void>;
    try {
      turn = deps.startIngestionTurn(runId);
    } catch (error) {
      turn = Promise.reject(error);
    }
    // Queued behind the current check, so the failure is reported after the start it belongs to.
    turn.catch((error: unknown) => void serialize(async () => report([{ kind: 'turn_failed', runId, contentHash, reason: messageOf(error) }])));
  }

  async function scanAll(): Promise<InboxOutcome[]> {
    const names = await readdir(dir).catch((error: unknown) => {
      if (errnoCode(error) === 'ENOENT') return [];
      throw error;
    });
    const present = new Set(names);
    for (const name of [...observed.keys(), ...decided.keys()]) {
      if (!present.has(name)) {
        observed.delete(name);
        decided.delete(name);
      }
    }
    const outcomes: InboxOutcome[] = [];
    for (const name of [...names].sort()) outcomes.push(...(await check(name)));
    return outcomes;
  }

  return {
    scanInbox: () => serialize(async () => report(await scanAll())),
    fileChanged: (fileName) => serialize(async () => report(await check(fileName))),
    idle: () => serialize(async () => undefined),
  };
}

// Reads through a handle opened without following links, and only if the opened file still has the
// fingerprint the stability checks saw; null when it changed in the meantime.
async function readUnchanged(path: string, fingerprint: string): Promise<Buffer | null> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // Gone, or swapped for a link, since the stability checks: it is not the file they saw.
    const code = errnoCode(error);
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw error;
  }
  try {
    const stats = await file.stat();
    if (!stats.isFile() || fingerprintOf(stats) !== fingerprint) return null;
    const bytes = await file.readFile();
    return bytes.byteLength === stats.size ? bytes : null;
  } finally {
    await file.close();
  }
}

export interface InboxWatcher {
  stop(): Promise<void>;
}

// Watches the inbox with file events, a startup scan for files saved while the server was down, and a
// periodic scan that reconciles missed events. A watch failure leaves the periodic scan in charge.
export async function watchInbox(deps: InboxScannerDeps): Promise<InboxWatcher> {
  const dir = inboxDir(deps);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const scanner = createInboxScanner(deps);
  const reportFailure = (error: unknown) => deps.onOutcome?.({ kind: 'scan_failed', reason: messageOf(error) });
  let isStopped = false;

  const watcher = watch(dir, (_event, fileName) => {
    if (isStopped) return;
    const checked = fileName === null ? scanner.scanInbox() : scanner.fileChanged(fileName);
    checked.catch(reportFailure);
  });
  watcher.on('error', reportFailure);

  await scanner.scanInbox().catch(reportFailure);
  const timer = setInterval(() => {
    if (!isStopped) scanner.scanInbox().catch(reportFailure);
  }, INBOX_SCAN_INTERVAL_MS);

  return {
    async stop() {
      isStopped = true;
      clearInterval(timer);
      watcher.close();
      // A check already in progress finishes, so a transition it committed is followed by its turn.
      await scanner.idle();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Error inspection: store errors carry a code from the shared error vocabulary; file errors an errno code.

function errorCodeOf(error: unknown): ErrorCode | null {
  if (!(error instanceof Error) || !('code' in error)) return null;
  const code = ErrorCodeSchema.safeParse(error.code);
  return code.success ? code.data : null;
}

function errnoCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : null;
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
