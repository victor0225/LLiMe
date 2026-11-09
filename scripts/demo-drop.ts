// npm run demo:drop -- --run RUN_ID
// Writes the prepared lesson transcript into that run's inbox, for rehearsals and ingestion tests.
// It only writes the file: the inbox watcher of the running server is the sole trigger for
// ingestion, exactly as when the lesson is saved from the Lesson notes screen.
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { repoRoot } from '../src/config.js';
import { IdSchema } from '../src/domain.js';
import { type InboxConfig, LessonSaveError, loadPreparedLesson, saveTranscript } from '../src/inbox.js';

export class DropRefused extends Error {}

export type DropOptions = { runId: string; rootDir?: string; save?: typeof saveTranscript };

export async function dropLesson({ runId, rootDir = repoRoot, save = saveTranscript }: DropOptions): Promise<{ contentHash: string; sha256: string }> {
  const id = IdSchema.parse(runId);
  const config: InboxConfig = { rootDir };
  // The transcript is used only when its bytes match the manifest hash, so a drop never feeds an
  // edited lesson into a rehearsal.
  const lesson = await loadPreparedLesson(config);
  if (lesson.prepared === null) throw new DropRefused(lesson.problem);
  const { contentHash } = await save(id, lesson.prepared.text, config);
  return { contentHash, sha256: lesson.prepared.sha256 };
}

async function main() {
  const { values } = parseArgs({ options: { run: { type: 'string' } }, strict: true });
  if (!values.run) throw new DropRefused('Usage: npm run demo:drop -- --run RUN_ID');
  const { contentHash } = await dropLesson({ runId: values.run });
  console.log(`Saved the prepared lesson into the inbox of run ${values.run} (sha256 ${contentHash}); the running server's watcher picks it up.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof DropRefused || error instanceof LessonSaveError || error instanceof z.ZodError ? `demo:drop: ${error.message}` : error);
    process.exit(1);
  });
}
