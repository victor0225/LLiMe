// Verifies the pinned seed, then loads it into Neo4j. Safe to run repeatedly: existing cases are left
// as they are, a case ID with different content is rejected, and the seed files are never modified.
import { loadSeed, SeedIntegrityError } from '../src/dataset.js';
import { DomainError, Store } from '../src/store.js';

try {
  const seed = loadSeed();
  const store = await Store.connect();
  try {
    const report = await store.seed(seed);
    const counts = await store.seedCounts();
    console.log(`corpus sha256  ${seed.corpusHash}`);
    console.log(`written        ${report.written} cases (${report.existing} already present)`);
    console.log(`cases ${counts.cases}  memory nodes ${counts.memoryNodes}  case edges ${counts.caseEdges}  students ${counts.students}`);
    console.log(`concepts ${counts.concepts}  CONCEPT_LINK ${counts.conceptLinks}  SUBCONCEPT_OF ${counts.subconceptEdges}`);
  } finally {
    await store.close();
  }
} catch (error) {
  console.error(error instanceof SeedIntegrityError || error instanceof DomainError ? `seed failed: ${error.message}` : error);
  process.exit(1);
}
