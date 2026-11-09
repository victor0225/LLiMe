// npm run demo:export -- --run RUN_ID
// Exports one run as an immutable, read-only capture under .runtime/captures/<captureId>/: the
// bootstrap answer, the run snapshot, its ordered events through the snapshot's seq, the lesson and
// voice status, and a manifest with the hashes that identify what produced it. It reads through the
// server's GET routes only, so exporting can never change a run.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig, repoRoot } from '../src/config.js';
import { CONTRACT_VERSION, IdentifierSchema, IdSchema, MATCHING_VERSION, RuntimePhaseSchema } from '../src/domain.js';
import type { RunEvent, RunEventOf } from '../src/events.js';
import { HTTP_STATUS, ROUTES, type RouteName, routePath } from '../src/routes.js';

export const CAPTURES_DIR = '.runtime/captures';
export const REDACTED = '[redacted]';

// The files of a capture, by the GET route that produced each. The voice snapshot is optional: a
// server without a voice module answers 503 for it, and the capture then records no voice status.
export const CAPTURE_FILES = {
  bootstrap: 'bootstrap.json',
  snapshot: 'snapshot.json',
  events: 'events.json',
  lesson: 'lesson.json',
  voiceSnapshot: 'voice-snapshot.json',
} as const;
export const MANIFEST_FILE = 'manifest.json';

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const CaptureManifestSchema = z.strictObject({
  captureId: IdentifierSchema,
  runId: IdSchema,
  // Everything in a capture was recorded from a real run; a viewer labels it that way.
  source: z.literal('recorded'),
  exportedAt: z.iso.datetime(),
  throughSeq: z.number().int().min(0),
  corpusHash: z.string().min(1),
  matchingVersion: z.literal(MATCHING_VERSION),
  // From the run's last search.completed; null when the run never searched.
  rankingHash: Sha256Schema.nullable(),
  // One entry per distinct prompt the runtime received, in the order it first appeared.
  promptHashes: z.array(z.strictObject({ phase: RuntimePhaseSchema, promptHash: z.string().min(1) })),
  runtime: z.strictObject({ model: z.string().min(1), serviceTier: z.string().min(1).nullable() }).nullable(),
  contractVersion: z.string().min(1),
  commit: z.strictObject({ sha: z.string().regex(/^[0-9a-f]{40}$/), dirty: z.boolean() }),
  files: z.record(z.string().regex(/^[a-z-]+\.json$/), Sha256Schema),
});
export type CaptureManifest = z.infer<typeof CaptureManifestSchema>;

const EventListSchema = ROUTES.runEvents.response;

export type Capture = {
  dir: string;
  manifest: CaptureManifest;
  bootstrap: z.output<typeof ROUTES.bootstrap.response>;
  snapshot: z.output<typeof ROUTES.getRun.response>;
  events: RunEvent[];
  lesson: z.output<typeof ROUTES.getLesson.response>;
  voiceSnapshot: z.output<typeof ROUTES.voiceSnapshot.response> | null;
};

// ---------------------------------------------------------------------------------------------
// Redaction. The routes already return allowlisted fields; this is the second line, so a field a
// later schema lets through still never reaches a capture file.

// Field names whose values are never exported, whatever they hold.
const FORBIDDEN_KEYS: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'credential field', pattern: /^(authorization|proxy-authorization|cookie|set-cookie|password|secret|api[-_]?key|openai[-_]?api[-_]?key|(access|refresh|id|bearer)?[-_]?token)$/i },
  { rule: 'session nonce', pattern: /^(nonce|x-llime-session)$/i },
  { rule: 'SDP field', pattern: /sdp/i },
  { rule: 'raw audio field', pattern: /^(audio|raw[-_]?audio|audio[-_]?(data|bytes|base64|chunk|delta|buffer)|pcm)$/i },
  { rule: 'reasoning field', pattern: /reasoning/i },
];

// Secret shapes inside otherwise allowed text, such as a key pasted into a lesson or a message.
const SECRET_TEXT: readonly { rule: string; pattern: RegExp }[] = [
  { rule: 'provider key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { rule: 'bearer credential', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
];
// A session description is redacted whole: any of its lines can identify the connection.
const SDP_TEXT = /(^|[\r\n])v=0\r?\n|a=(ice-ufrag|ice-pwd|fingerprint):/;

const forbiddenKeyRule = (key: string) => FORBIDDEN_KEYS.find((k) => k.pattern.test(key))?.rule;

function redactText(text: string, literals: readonly string[]): string {
  if (SDP_TEXT.test(text)) return REDACTED;
  let out = text;
  for (const { pattern } of SECRET_TEXT) out = out.replace(pattern, REDACTED);
  for (const literal of literals) out = out.split(literal).join(REDACTED);
  return out;
}

// Returns a redacted copy; the input is not changed. `literals` are exact secret values to remove
// wherever they appear, such as the session nonce the export itself received.
export function redact(value: unknown, literals: readonly string[] = []): unknown {
  if (typeof value === 'string') return redactText(value, literals);
  if (Array.isArray(value)) return value.map((item) => redact(item, literals));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, forbiddenKeyRule(key) ? REDACTED : redact(item, literals)]));
  }
  return value;
}

// Every place in a document that still holds something redact() would remove, as "path: rule".
export function findLeaks(value: unknown, literals: readonly string[] = [], path = '$'): string[] {
  if (typeof value === 'string') {
    const rules = [
      ...(SDP_TEXT.test(value) ? ['SDP body'] : []),
      ...SECRET_TEXT.filter(({ pattern }) => new RegExp(pattern.source, pattern.flags).test(value)).map(({ rule }) => rule),
      ...(literals.some((l) => value.includes(l)) ? ['secret value'] : []),
    ];
    return rules.map((rule) => `${path}: ${rule}`);
  }
  if (Array.isArray(value)) return value.flatMap((item, i) => findLeaks(item, literals, `${path}[${i}]`));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => {
      const rule = forbiddenKeyRule(key);
      if (rule && item !== REDACTED) return [`${path}.${key}: ${rule}`];
      return rule ? [] : findLeaks(item, literals, `${path}.${key}`);
    });
  }
  return [];
}

// ---------------------------------------------------------------------------------------------
// Reading the run through GET routes.

export type Fetch = typeof fetch;

// A refusal with a message the operator can act on; anything else is a bug and keeps its stack.
export class CaptureError extends Error {}

async function getRoute<N extends RouteName>(fetchFn: Fetch, origin: string, name: N, params: { runId?: string } = {}, query = ''): Promise<{ status: number; body: unknown }> {
  if (ROUTES[name].method !== 'GET') throw new CaptureError(`${name} is not a GET route; export only reads`);
  let response: Response;
  try {
    response = await fetchFn(`${origin}${routePath(name, params)}${query}`, { method: 'GET', headers: { accept: 'application/json' } });
  } catch {
    throw new CaptureError(`No llime server answers at ${origin}. Start it with npm run start (or npm run dev), then export again.`);
  }
  return { status: response.status, body: await response.json() };
}

async function readRoute<S extends z.ZodType>(fetchFn: Fetch, origin: string, name: RouteName, schema: S, params: { runId?: string } = {}, query = ''): Promise<z.output<S>> {
  const { status, body } = await getRoute(fetchFn, origin, name, params, query);
  if (status === HTTP_STATUS.notFound && params.runId) throw new CaptureError(`Unknown run ${params.runId}`);
  if (status !== HTTP_STATUS.ok) throw new CaptureError(`GET ${ROUTES[name].path} answered ${status}: ${JSON.stringify(body).slice(0, 300)}`);
  return schema.parse(body);
}

// A consistent cut: the snapshot fixes throughSeq, and the event list must hold exactly 1..throughSeq
// in order, so a capture never mixes a newer event into an older state.
function eventsThrough(events: RunEvent[], throughSeq: number): RunEvent[] {
  const cut = events.filter((e) => e.seq <= throughSeq);
  const gap = cut.findIndex((e, i) => e.seq !== i + 1);
  if (gap !== -1 || cut.length !== throughSeq) throw new CaptureError(`The event stream is not contiguous through seq ${throughSeq}; export again`);
  return cut;
}

const ofType = <T extends RunEvent['type']>(events: RunEvent[], type: T) => events.filter((e): e is RunEventOf<T> => e.type === type);

function promptHashesOf(events: RunEvent[]): CaptureManifest['promptHashes'] {
  const seen = new Set<string>();
  return ofType(events, 'runtime.input').flatMap(({ payload: { phase, promptHash } }) => {
    const key = `${phase}|${promptHash}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ phase, promptHash }];
  });
}

function currentCommit(): CaptureManifest['commit'] {
  const git = (args: string[]) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  return { sha: git(['rev-parse', 'HEAD']).trim(), dirty: git(['status', '--porcelain']).trim() !== '' };
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const stamp = (now: Date) => now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
export const newCaptureId = (now: Date) => `capture-${stamp(now)}-${randomBytes(4).toString('hex')}`;

export type ExportOptions = {
  origin: string;
  runId: string;
  capturesDir?: string;
  fetch?: Fetch;
  now?: () => Date;
  commit?: () => CaptureManifest['commit'];
};

export async function exportCapture({ origin, runId, capturesDir = join(repoRoot, CAPTURES_DIR), fetch: fetchFn = fetch, now = () => new Date(), commit = currentCommit }: ExportOptions): Promise<{ captureId: string; dir: string; manifest: CaptureManifest; manifestSha256: string }> {
  const id = IdSchema.parse(runId);
  const bootstrap = await readRoute(fetchFn, origin, 'bootstrap', ROUTES.bootstrap.response);
  const snapshot = await readRoute(fetchFn, origin, 'getRun', ROUTES.getRun.response, { runId: id });
  const events = eventsThrough(await readRoute(fetchFn, origin, 'runEvents', EventListSchema, { runId: id }, '?after=0'), snapshot.seq);
  const lesson = await readRoute(fetchFn, origin, 'getLesson', ROUTES.getLesson.response, { runId: id });
  const voice = await getRoute(fetchFn, origin, 'voiceSnapshot', { runId: id });
  if (voice.status !== HTTP_STATUS.ok && voice.status !== HTTP_STATUS.unavailable) throw new CaptureError(`GET ${ROUTES.voiceSnapshot.path} answered ${voice.status}`);
  const voiceSnapshot = voice.status === HTTP_STATUS.ok ? ROUTES.voiceSnapshot.response.parse(voice.body) : null;

  const exportedAt = now();
  const captureId = newCaptureId(exportedAt);
  const searches = ofType(events, 'search.completed');
  const secrets = [bootstrap.nonce];
  const documents: [string, unknown][] = [
    [CAPTURE_FILES.bootstrap, bootstrap],
    [CAPTURE_FILES.snapshot, snapshot],
    [CAPTURE_FILES.events, events],
    [CAPTURE_FILES.lesson, lesson],
  ];
  if (voiceSnapshot) documents.push([CAPTURE_FILES.voiceSnapshot, voiceSnapshot]);
  const texts = documents.map(([file, body]) => [file, `${JSON.stringify(redact(body, secrets), null, 2)}\n`] as const);
  const manifest = CaptureManifestSchema.parse({
    captureId,
    runId: id,
    source: 'recorded',
    exportedAt: exportedAt.toISOString(),
    throughSeq: snapshot.seq,
    corpusHash: snapshot.corpusHash,
    matchingVersion: snapshot.matchingVersion,
    rankingHash: searches.at(-1)?.payload.rankingHash ?? null,
    promptHashes: promptHashesOf(events),
    runtime: snapshot.runtime ? { model: snapshot.runtime.model, serviceTier: snapshot.runtime.serviceTier } : null,
    contractVersion: CONTRACT_VERSION,
    commit: commit(),
    files: Object.fromEntries(texts.map(([file, text]) => [file, sha256(text)])),
  });
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  // Written beside the final name and renamed once complete, so a capture directory is never partial
  // and an existing capture is never overwritten.
  await mkdir(capturesDir, { recursive: true });
  const dir = join(capturesDir, captureId);
  const tempDir = join(capturesDir, `.${captureId}.tmp`);
  await mkdir(tempDir);
  try {
    for (const [file, text] of [...texts, [MANIFEST_FILE, manifestText] as const]) await writeFile(join(tempDir, file), text, { flag: 'wx' });
    const leaks = (await Promise.all([...texts.map(([file]) => file), MANIFEST_FILE].map(async (file) => findLeaks(JSON.parse(await readFile(join(tempDir, file), 'utf8')), secrets, file)))).flat();
    if (leaks.length > 0) throw new CaptureError(`Refusing to keep a capture that still holds secrets: ${leaks.join('; ')}`);
    await rename(tempDir, dir);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
  return { captureId, dir, manifest, manifestSha256: sha256(manifestText) };
}

// ---------------------------------------------------------------------------------------------
// Reading a capture back, for replay. Every file must match its manifest hash and its route schema.

export async function loadCapture(captureId: string, capturesDir: string = join(repoRoot, CAPTURES_DIR)): Promise<Capture> {
  const id = IdentifierSchema.safeParse(captureId);
  if (!id.success) throw new CaptureError('The capture ID may contain only letters, digits, "_" and "-"');
  const dir = join(capturesDir, id.data);
  let manifestText: string;
  try {
    manifestText = await readFile(join(dir, MANIFEST_FILE), 'utf8');
  } catch {
    throw new CaptureError(`No capture ${id.data} in ${capturesDir}`);
  }
  const manifest = CaptureManifestSchema.parse(JSON.parse(manifestText));
  if (manifest.captureId !== id.data) throw new CaptureError(`The manifest in ${dir} names capture ${manifest.captureId}`);
  const read = async (file: string): Promise<unknown> => {
    const expected = manifest.files[file];
    if (expected === undefined) return null;
    const text = await readFile(join(dir, file), 'utf8');
    if (sha256(text) !== expected) throw new CaptureError(`${file} in capture ${id.data} does not match its manifest hash`);
    return JSON.parse(text);
  };
  const required = async (file: string) => {
    const body = await read(file);
    if (body === null) throw new CaptureError(`Capture ${id.data} has no ${file}`);
    return body;
  };
  const snapshot = ROUTES.getRun.response.parse(await required(CAPTURE_FILES.snapshot));
  const events = EventListSchema.parse(await required(CAPTURE_FILES.events));
  if (snapshot.id !== manifest.runId || snapshot.seq !== manifest.throughSeq) throw new CaptureError(`Capture ${id.data} snapshot does not match its manifest`);
  const voice = await read(CAPTURE_FILES.voiceSnapshot);
  return {
    dir,
    manifest,
    bootstrap: ROUTES.bootstrap.response.parse(await required(CAPTURE_FILES.bootstrap)),
    snapshot,
    events: eventsThrough(events, manifest.throughSeq),
    lesson: ROUTES.getLesson.response.parse(await required(CAPTURE_FILES.lesson)),
    voiceSnapshot: voice === null ? null : ROUTES.voiceSnapshot.response.parse(voice),
  };
}

async function main() {
  const { values } = parseArgs({ options: { run: { type: 'string' } }, strict: true });
  if (!values.run) throw new CaptureError('Usage: npm run demo:export -- --run RUN_ID');
  const { appOrigin } = loadConfig();
  const { captureId, dir, manifest, manifestSha256 } = await exportCapture({ origin: appOrigin, runId: values.run });
  console.log(`Exported run ${manifest.runId} through seq ${manifest.throughSeq}`);
  console.log(`captureId ${captureId}`);
  console.log(`path ${dir}`);
  console.log(`rankingHash ${manifest.rankingHash ?? 'none (the run never searched)'}`);
  for (const [file, hash] of Object.entries(manifest.files)) console.log(`sha256 ${hash}  ${file}`);
  console.log(`sha256 ${manifestSha256}  ${MANIFEST_FILE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof CaptureError || error instanceof z.ZodError ? `demo:export: ${error.message}` : error);
    process.exit(1);
  });
}
