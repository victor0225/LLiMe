import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { ConceptLinksSchema } from '../src/domain.js';
import { compactSha256, DEFAULT_SEED_DIR, loadSeed, resolveRelatedLeaf, SeedIntegrityError, validateConceptLinkSet } from '../src/dataset.js';

const scratch: string[] = [];
after(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// A private copy of the pinned seed that a test may corrupt without touching the shipped files.
function seedCopy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'seed-copy-'));
  scratch.push(dir);
  cpSync(DEFAULT_SEED_DIR, dir, { recursive: true });
  return dir;
}

describe('pinned seed', () => {
  test('loads 781 cases from 120 learners', () => {
    const seed = loadSeed();
    assert.equal(seed.cases.length, 781);
    assert.equal(new Set(seed.cases.map((c) => c.studentId)).size, 120);
    assert.equal(seed.corpusHash, seed.manifest.sha256);
  });

  test('student_7 has 18 subtraction and 0 addition cases', () => {
    const own = loadSeed().cases.filter((c) => c.studentId === 'student_7');
    assert.equal(own.filter((c) => c.concept === 'subtraction_within_20').length, 18);
    assert.equal(own.filter((c) => c.concept === 'addition_within_20').length, 0);
  });

  test('rejects a seed whose compact-JSON SHA-256 differs from the manifest before any write', () => {
    const dir = seedCopy();
    const file = join(dir, 'cases.json');
    const cases = JSON.parse(readFileSync(file, 'utf8')) as { createdAt: string }[];
    assert.ok(cases[0]);
    cases[0].createdAt = '2030-01-01T00:00:00.000Z';
    writeFileSync(file, JSON.stringify(cases, null, 2));
    assert.throws(() => loadSeed(dir), (error) => error instanceof SeedIntegrityError && /cases/.test(error.message));
  });

  test('hashes the compact JSON of the parsed array, not the file bytes', () => {
    const dir = seedCopy();
    const file = join(dir, 'cases.json');
    writeFileSync(file, `${JSON.stringify(JSON.parse(readFileSync(file, 'utf8')), null, 4)}\n`);
    assert.equal(loadSeed(dir).cases.length, 781);
  });

  test('rejects concept links whose hash differs', () => {
    const dir = seedCopy();
    const file = join(dir, 'concept-links.json');
    const links = JSON.parse(readFileSync(file, 'utf8')) as { reason: string }[];
    assert.ok(links[0]);
    links[0].reason = 'a different reason';
    writeFileSync(file, JSON.stringify(links));
    assert.throws(() => loadSeed(dir), (error) => error instanceof SeedIntegrityError && /concept links/.test(error.message));
  });
});

describe('concept links', () => {
  const links = loadSeed().conceptLinks;

  test('validates three ConceptLink records: one similar, two subconcept', () => {
    assert.equal(ConceptLinksSchema.parse(links).length, 3);
    assert.equal(links.filter((l) => l.kind === 'similar').length, 1);
    assert.equal(links.filter((l) => l.kind === 'subconcept').length, 2);
    assert.doesNotThrow(() => validateConceptLinkSet(links));
  });

  test('a set with a missing or duplicated record is rejected', () => {
    assert.throws(() => validateConceptLinkSet(links.slice(1)), SeedIntegrityError);
    const [first] = links;
    assert.ok(first);
    assert.throws(() => validateConceptLinkSet([...links, first]), SeedIntegrityError);
  });

  test('a subconcept whose child leaf is not under the parent is rejected', () => {
    const swapped = links.map((l) => (l.kind === 'subconcept' && l.from === 'addition_within_20' ? { ...l, to: 'subtraction' as const } : l));
    assert.throws(() => validateConceptLinkSet(swapped), SeedIntegrityError);
  });

  test('the related leaf resolves through the parents in both directions', () => {
    assert.equal(resolveRelatedLeaf('addition_within_20', links)?.leaf, 'subtraction_within_20');
    assert.equal(resolveRelatedLeaf('subtraction_within_20', links)?.leaf, 'addition_within_20');
    assert.equal(resolveRelatedLeaf('addition_within_20', links)?.link, 'similar');
  });

  test('a prerequisite link points from the prior concept to today only', () => {
    const prerequisite = [...links.filter((l) => l.kind === 'subconcept'), { from: 'subtraction' as const, to: 'addition' as const, kind: 'prerequisite' as const, reason: 'test-only variant' }];
    assert.equal(resolveRelatedLeaf('addition_within_20', prerequisite)?.link, 'prerequisite');
    assert.equal(resolveRelatedLeaf('subtraction_within_20', prerequisite), null);
  });

  test('compactSha256 is stable and key-order sensitive', () => {
    assert.equal(compactSha256({ a: 1, b: 2 }), compactSha256({ a: 1, b: 2 }));
    assert.notEqual(compactSha256({ a: 1, b: 2 }), compactSha256({ b: 2, a: 1 }));
  });
});
