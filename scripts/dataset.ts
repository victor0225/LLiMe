// Verifies the pinned seed against its manifest without touching the database or the seed files.
import { DEFAULT_SEED_DIR, loadSeed, SeedIntegrityError } from '../src/dataset.js';

try {
  const seed = loadSeed(process.argv[2] ?? DEFAULT_SEED_DIR);
  const own = seed.cases.filter((c) => c.studentId === 'student_7');
  const count = (concept: string) => own.filter((c) => c.concept === concept).length;
  console.log(`seed version   ${seed.manifest.version}`);
  console.log(`cases          ${seed.cases.length} from ${new Set(seed.cases.map((c) => c.studentId)).size} learners`);
  console.log(`nodes / edges  ${seed.cases.reduce((n, c) => n + c.nodes.length, 0)} / ${seed.cases.reduce((n, c) => n + c.edges.length, 0)}`);
  console.log(`corpus sha256  ${seed.corpusHash} (matches manifest)`);
  console.log(`links sha256   ${seed.manifest.conceptLinks.sha256} (matches manifest, ${seed.conceptLinks.length} records)`);
  console.log(`student_7      ${count('subtraction_within_20')} subtraction, ${count('addition_within_20')} addition`);
} catch (error) {
  console.error(error instanceof SeedIntegrityError ? `seed rejected: ${error.message}` : error);
  process.exit(1);
}
