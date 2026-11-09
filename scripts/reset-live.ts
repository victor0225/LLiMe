// npm run demo:purge -- --run RUN_ID
// Deletes one disposable run namespace from the database: the run, its events, receipts,
// activities, voice operations, outbox rows and the live case it wrote. It runs only while no server
// listens on the app port, because the server is the run's writer. Seed nodes, other runs, exported
// captures, logs, credentials and the database volume are never touched.
import { connect } from 'node:net';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { HOST, loadConfig } from '../src/config.js';
import { DomainError, type NamespaceCounts, type SeedCounts, Store } from '../src/store.js';

// One exact run ID: letters, digits, "_" and "-". Anything that could read as a pattern is refused.
const ExactRunIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,180}$/, 'Give one exact run ID (letters, digits, "_" and "-"); patterns are not accepted');

export class PurgeRefused extends Error {}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('error', () => resolve(false));
  });
}

export type PurgeStore = Pick<Store, 'countNamespace' | 'resetRun' | 'seedCounts'>;
export type PurgeResult = { runId: string; deleted: NamespaceCounts; remaining: NamespaceCounts; seedBefore: SeedCounts; seedAfter: SeedCounts };

// Checks that need no database come first, so a refused purge never opens a connection.
export async function checkPurgeAllowed(runId: string | undefined, port: number): Promise<string> {
  if (runId === undefined || runId.trim() === '') throw new PurgeRefused('Usage: npm run demo:purge -- --run RUN_ID');
  const exact = ExactRunIdSchema.safeParse(runId);
  if (!exact.success) throw new PurgeRefused(exact.error.issues[0]?.message ?? 'Invalid run ID');
  if (await isListening(port)) throw new PurgeRefused(`A server is listening on port ${port}. Stop it (Ctrl-C in its terminal) before purging; find it with: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  return exact.data;
}

export async function purgeRun(store: PurgeStore, runId: string): Promise<PurgeResult> {
  const seedBefore = await store.seedCounts();
  let deleted: NamespaceCounts;
  try {
    deleted = await store.resetRun(runId);
  } catch (error) {
    if (error instanceof DomainError && error.code === 'NOT_FOUND') throw new PurgeRefused(`Unknown run ${runId}; nothing was deleted`);
    throw error;
  }
  return { runId, deleted, remaining: await store.countNamespace(runId), seedBefore, seedAfter: await store.seedCounts() };
}

async function main() {
  const { values } = parseArgs({ options: { run: { type: 'string' } }, strict: true });
  const config = loadConfig();
  const runId = await checkPurgeAllowed(values.run, config.port);
  const { uri, user, password } = config.neo4j;
  if (password === undefined) throw new PurgeRefused('NEO4J_PASSWORD is not set; run npm run setup:env to reuse the machine DB credential');
  const store = await Store.connect({ uri, user, password });
  try {
    const { deleted, remaining, seedBefore, seedAfter } = await purgeRun(store, runId);
    console.log(`Purged run ${runId}: ${JSON.stringify(deleted)}`);
    console.log(`Remaining in namespace ${runId}: ${JSON.stringify(remaining)}`);
    console.log(`Seed counts unchanged: ${JSON.stringify(seedBefore) === JSON.stringify(seedAfter)} ${JSON.stringify(seedAfter)}`);
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof PurgeRefused ? `demo:purge: ${error.message}` : error);
    process.exit(1);
  });
}
