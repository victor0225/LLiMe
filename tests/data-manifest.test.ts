import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

// The dataset is synthetic and pinned: these checks tie the parsed seed, the concept links
// and the transcript bytes to the hashes and counts their manifests record.

const dataFile = (relative: string): URL => new URL(`../data/${relative}`, import.meta.url)
const parseDataJson = (relative: string) => JSON.parse(readFileSync(dataFile(relative), 'utf8'))
const sha256 = (input: string | Buffer): string => createHash('sha256').update(input).digest('hex')

const seedManifest: {
  sha256: string
  cases: number
  students: number
  conceptLinks: { sha256: string; count: number }
} = parseDataJson('seed/manifest.json')
const cases: ReadonlyArray<{ studentId: string; concept: string }> = parseDataJson('seed/cases.json')
const conceptLinks: ReadonlyArray<{ kind: string }> = parseDataJson('seed/concept-links.json')

test('seed hash over the compact case array matches the manifest', () => {
  // The hash covers the parsed array re-serialized compactly (key order preserved),
  // not the formatted file bytes, so whitespace changes alone cannot break it.
  assert.equal(sha256(JSON.stringify(cases)), seedManifest.sha256)
})

test('concept-link hash over the compact link array matches the manifest', () => {
  assert.equal(sha256(JSON.stringify(conceptLinks)), seedManifest.conceptLinks.sha256)
})

test('seed holds 781 cases from 120 learners, as the manifest states', () => {
  const learnerCount = new Set(cases.map((seedCase) => seedCase.studentId)).size
  assert.equal(cases.length, 781)
  assert.equal(learnerCount, 120)
  assert.equal(seedManifest.cases, cases.length)
  assert.equal(seedManifest.students, learnerCount)
})

test('the demo learner has 18 subtraction cases and no addition case', () => {
  const demoCases = cases.filter((seedCase) => seedCase.studentId === 'student_7')
  const countFor = (concept: string) => demoCases.filter((seedCase) => seedCase.concept === concept).length
  assert.equal(countFor('subtraction_within_20'), 18)
  assert.equal(countFor('addition_within_20'), 0)
  assert.equal(demoCases.length, 18)
})

test('concept links are one similar and two subconcept records', () => {
  const kindCount = (kind: string) => conceptLinks.filter((link) => link.kind === kind).length
  assert.equal(conceptLinks.length, 3)
  assert.equal(seedManifest.conceptLinks.count, 3)
  assert.equal(kindCount('similar'), 1)
  assert.equal(kindCount('subconcept'), 2)
})

test('lesson transcript bytes match the lesson manifest', () => {
  const lessonManifest: { sha256: string; bytes: number; turns: number } = parseDataJson('lesson/manifest.json')
  const transcript = readFileSync(dataFile('lesson/lesson-transcript.txt'))
  // A speaker turn is a line starting with "[mm:ss] "; "# " header lines are not turns.
  const turnCount = transcript
    .toString('utf8')
    .split('\n')
    .filter((line) => /^\[\d{2}:\d{2}\] /.test(line)).length
  assert.equal(sha256(transcript), lessonManifest.sha256)
  assert.equal(transcript.byteLength, lessonManifest.bytes)
  assert.equal(turnCount, lessonManifest.turns)
})
