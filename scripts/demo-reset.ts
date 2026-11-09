// npm run demo:reset -- --case main|contrast [--seed N]
// Creates a fresh run on the running server (pinned corpus, new state; the runtime thread starts on
// its first turn) and prints the real run ID. Earlier runs are never touched. While the operator's
// previous run is still active, reset refuses, so a rehearsal never strands a run mid-lesson; stop
// it with Stop learning first.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { loadConfig, repoRoot } from '../src/config.js';
import { IdSchema, PHASE_TRANSITIONS, type RunState, SeedSchema } from '../src/domain.js';
import { BootstrapSchema, HTTP_STATUS, ROUTES, routePath, SESSION_HEADER } from '../src/routes.js';

// The last run this script created on this worktree, so the next reset can check it is finished.
export const OPERATOR_RUN_FILE = '.runtime/demo/operator-run.json';

export const RESET_CASES = ['main', 'contrast'] as const;
export type ResetCase = (typeof RESET_CASES)[number];

const OperatorRunSchema = z.strictObject({ runId: IdSchema, case: z.enum(RESET_CASES), createdAt: z.iso.datetime() });

export class ResetRefused extends Error {}

// A run is active until it is stopped or reaches a phase with no way forward. NEEDS_SUPPORT is
// final only when the run allows no continuation.
export function isRunActive(state: Pick<RunState, 'phase' | 'stopped' | 'continuationAllowed'>): boolean {
  if (state.stopped) return false;
  if (state.phase === 'NEEDS_SUPPORT') return state.continuationAllowed;
  return PHASE_TRANSITIONS[state.phase].length > 0;
}

async function readOperatorRun(file: string): Promise<z.infer<typeof OperatorRunSchema> | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
  return OperatorRunSchema.parse(JSON.parse(text));
}

async function writeOperatorRun(file: string, record: z.infer<typeof OperatorRunSchema>): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temp, file);
}

async function request(origin: string, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, init);
  } catch {
    throw new ResetRefused(`No llime server answers at ${origin}. Start it with npm run start (or npm run dev), then reset again.`);
  }
  return { status: response.status, body: await response.json() };
}

export type ResetOptions = { origin: string; caseName: ResetCase; seed?: number; operatorRunFile?: string; now?: () => Date };

export async function resetRun({ origin, caseName, seed, operatorRunFile = join(repoRoot, OPERATOR_RUN_FILE), now = () => new Date() }: ResetOptions): Promise<{ runId: string; seed: number }> {
  const previous = await readOperatorRun(operatorRunFile);
  if (previous) {
    const { status, body } = await request(origin, routePath('getRun', { runId: previous.runId }));
    // A purged run is gone, so nothing is left active.
    if (status !== HTTP_STATUS.notFound) {
      if (status !== HTTP_STATUS.ok) throw new ResetRefused(`Could not read the previous run ${previous.runId} (status ${status})`);
      const run = ROUTES.getRun.response.parse(body);
      if (isRunActive(run)) throw new ResetRefused(`The previous ${previous.case} run ${run.id} is still active (phase ${run.phase}). Stop it with Stop learning, then reset again.`);
    }
  }

  const bootstrap = await request(origin, routePath('bootstrap'));
  if (bootstrap.status !== HTTP_STATUS.ok) throw new ResetRefused(`GET ${ROUTES.bootstrap.path} answered ${bootstrap.status}`);
  const { nonce, mode } = BootstrapSchema.parse(bootstrap.body);
  if (mode !== 'live') throw new ResetRefused(`The server at ${origin} is a read-only replay; start the live server to reset`);
  const input = ROUTES.createRun.request.parse(seed === undefined ? {} : { seed });
  const created = await request(origin, routePath('createRun'), { method: 'POST', headers: { 'content-type': 'application/json', [SESSION_HEADER]: nonce }, body: JSON.stringify(input) });
  if (created.status !== ROUTES.createRun.status) throw new ResetRefused(`POST ${ROUTES.createRun.path} answered ${created.status}: ${JSON.stringify(created.body).slice(0, 300)}`);
  const run = ROUTES.createRun.response.parse(created.body);
  await writeOperatorRun(operatorRunFile, { runId: run.id, case: caseName, createdAt: now().toISOString() });
  return { runId: run.id, seed: run.seed };
}

async function main() {
  const { values } = parseArgs({ options: { case: { type: 'string' }, seed: { type: 'string' } }, strict: true });
  const caseName = z.enum(RESET_CASES).safeParse(values.case);
  if (!caseName.success) throw new ResetRefused('Usage: npm run demo:reset -- --case main|contrast [--seed N]');
  const seed = values.seed === undefined ? undefined : SeedSchema.parse(Number(values.seed));
  const { runId, seed: stored } = await resetRun({ origin: loadConfig().appOrigin, caseName: caseName.data, ...(seed === undefined ? {} : { seed }) });
  console.log(`Created ${caseName.data} run with seed ${stored}`);
  console.log(runId);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof ResetRefused || error instanceof z.ZodError ? `demo:reset: ${error.message}` : error);
    process.exit(1);
  });
}
