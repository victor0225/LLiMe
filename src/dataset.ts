// Loads the pinned seed corpus and the fixed concept links, and resolves related concepts through them.
// Loading only reads and verifies files: nothing here touches the database, so a corrupted seed is
// rejected before any write can happen.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CaseSchema,
  ConceptLinksSchema,
  ConceptSchema,
  validateCase,
  type Concept,
  type ConceptLink,
  type CurriculumConcept,
  type LearningCase,
} from './domain.js';

export const DEFAULT_SEED_DIR = fileURLToPath(new URL('../data/seed/', import.meta.url));

// The seed version this build was written against; a different version is a different corpus.
export const SEED_VERSION = 7;

export class SeedIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedIntegrityError';
  }
}

export const SeedManifestSchema = z.strictObject({
  version: z.literal(SEED_VERSION),
  cases: z.number().int().min(1),
  students: z.number().int().min(1),
  topologies: z.number().int().min(1),
  nodes: z.number().int().min(1),
  edges: z.number().int().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  provenance: z.string(),
  conceptLinks: z.strictObject({
    file: z.string().min(1),
    count: z.number().int().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
});
export type SeedManifest = z.infer<typeof SeedManifestSchema>;

// Both seed hashes are taken over compact JSON of the parsed value with its original key order, so
// reformatting a file does not change its identity but reordering or editing a value does.
export function compactSha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export type LoadedSeed = {
  manifest: SeedManifest;
  // The case-array hash from the manifest; runs pin it as their corpus identity.
  corpusHash: string;
  cases: LearningCase[];
  conceptLinks: ConceptLink[];
};

function readJson(dir: string, file: string): unknown {
  try {
    return JSON.parse(readFileSync(`${dir.replace(/\/$/, '')}/${file}`, 'utf8'));
  } catch (error) {
    throw new SeedIntegrityError(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function loadSeed(dir: string = DEFAULT_SEED_DIR): LoadedSeed {
  const manifest = SeedManifestSchema.parse(readJson(dir, 'manifest.json'));
  const rawCases = readJson(dir, 'cases.json');
  if (!Array.isArray(rawCases)) throw new SeedIntegrityError('cases.json is not an array');
  if (compactSha256(rawCases) !== manifest.sha256) throw new SeedIntegrityError('cases.json does not match the manifest hash');

  const rawLinks = readJson(dir, manifest.conceptLinks.file);
  if (compactSha256(rawLinks) !== manifest.conceptLinks.sha256) throw new SeedIntegrityError('concept links do not match the manifest hash');
  const conceptLinks = ConceptLinksSchema.parse(rawLinks);
  if (conceptLinks.length !== manifest.conceptLinks.count) throw new SeedIntegrityError('concept link count differs from the manifest');
  validateConceptLinkSet(conceptLinks);

  const cases = rawCases.map((c) => validateCase(CaseSchema.parse(c)));
  if (cases.length !== manifest.cases) throw new SeedIntegrityError(`Expected ${manifest.cases} cases, found ${cases.length}`);
  if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new SeedIntegrityError('Duplicate case ID in the seed');
  const students = new Set(cases.map((c) => c.studentId)).size;
  if (students !== manifest.students) throw new SeedIntegrityError(`Expected ${manifest.students} learners, found ${students}`);

  return { manifest, corpusHash: manifest.sha256, cases, conceptLinks };
}

// ---------------------------------------------------------------------------------------------
// Concept hierarchy: leaf -> parent (subconcept), parent <-> parent (similar), prior -> today (prerequisite).

const PARENTS: readonly CurriculumConcept[] = ['addition', 'subtraction'];
const isParent = (id: CurriculumConcept) => PARENTS.includes(id);

// The seed carries exactly one similar relation between the two parents and one subconcept record per
// leaf. Anything else means the curriculum rules were edited, so loading stops.
export function validateConceptLinkSet(links: readonly ConceptLink[]): void {
  const similar = links.filter((l) => l.kind === 'similar');
  const subconcepts = links.filter((l) => l.kind === 'subconcept');
  if (links.length !== 3 || similar.length !== 1 || subconcepts.length !== 2) throw new SeedIntegrityError('Expected one similar and two subconcept links');
  const [relation] = similar;
  if (!relation || !isParent(relation.from) || !isParent(relation.to) || relation.from === relation.to) throw new SeedIntegrityError('The similar link must join the two parent concepts');
  const leaves = new Set<CurriculumConcept>();
  const parents = new Set<CurriculumConcept>();
  for (const l of subconcepts) {
    const childIsLeaf = ConceptSchema.safeParse(l.from).success;
    if (!childIsLeaf || !isParent(l.to) || !l.from.startsWith(l.to)) throw new SeedIntegrityError(`${l.from} is not a leaf of ${l.to}`);
    leaves.add(l.from);
    parents.add(l.to);
  }
  if (leaves.size !== 2 || parents.size !== 2) throw new SeedIntegrityError('Each leaf needs its own parent');
}

const parentOf = (leaf: Concept, links: readonly ConceptLink[]) => links.find((l) => l.kind === 'subconcept' && l.from === leaf)?.to;

// The part of a leaf ID after its parent, e.g. "_within_20". Leaves of the same range share it.
const rangeOf = (leaf: Concept, parent: CurriculumConcept) => leaf.slice(parent.length);

export type RelatedLeaf = { leaf: Concept; link: 'similar' | 'prerequisite' };

// Today's leaf resolves to its parent, follows a parent-level relation, then resolves the linked
// parent's leaf of the same range. Never aggregates other ranges and never uses a parent ID as a case
// concept. A similar link reads both ways; a prerequisite reads from the prior concept to today.
export function resolveRelatedLeaf(today: Concept, links: readonly ConceptLink[]): RelatedLeaf | null {
  const todayParent = parentOf(today, links);
  if (!todayParent) return null;
  const range = rangeOf(today, todayParent);
  for (const l of links) {
    const other = l.kind === 'similar' ? (l.from === todayParent ? l.to : l.to === todayParent ? l.from : null) : l.kind === 'prerequisite' && l.to === todayParent ? l.from : null;
    if (!other || (l.kind !== 'similar' && l.kind !== 'prerequisite')) continue;
    const leaf = links.find((s) => s.kind === 'subconcept' && s.to === other && rangeOf(ConceptSchema.parse(s.from), other) === range)?.from;
    const parsed = ConceptSchema.safeParse(leaf);
    if (parsed.success) return { leaf: parsed.data, link: l.kind };
  }
  return null;
}
