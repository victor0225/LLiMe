// Derives the four activity fixtures (make-ten and number-line, support and independent) and writes
// src/ui/activity-fixtures.ts. The numbers come from the seeded problem selector and the evidence
// IDs from real seed cases, so no fixture is written by hand: run `npx tsx scripts/derive-activity-fixtures.ts`
// after changing either source, and commit the result.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { type ActivityComponent, type ActivityContext, type ActivitySpec, CaseSchema, CATALOG_VERSION, type LearningCase, type Problem, type Strategy } from '../src/domain.js';
import { FILM_SEED, problemRefOf, selectProblems } from '../src/problems.js';
import { validateActivity } from '../src/ui/activity-catalog.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SEED_CASES_PATH = join(repoRoot, 'data/seed/cases.json');
export const FIXTURES_PATH = join(repoRoot, 'src/ui/activity-fixtures.ts');

// The problems the prepared class lesson states aloud; the selector never picks them.
export const PREPARED_LESSON_PROBLEMS: readonly Problem[] = [
  { lhs: 7, rhs: 4 },
  { lhs: 7, rhs: 6 },
  { lhs: 6, rhs: 5 },
];

const FIXTURE_RUN_ID = 'fixture_run';
const SUPPORT_REVISION = 1;
const INDEPENDENT_REVISION = 2;

export type FixtureSet = {
  makeTenSupport: { context: ActivityContext; spec: ActivitySpec };
  makeTenIndependent: { context: ActivityContext; spec: ActivitySpec };
  numberLineSupport: { context: ActivityContext; spec: ActivitySpec };
  numberLineIndependent: { context: ActivityContext; spec: ActivitySpec };
};

// A support activity cites a case that ended in independent success under the strategy it teaches,
// the kind of evidence a real decision admits, on the addition concept the activity practises. The
// first such case in seed order keeps the choice stable.
function evidenceCaseFor(cases: readonly LearningCase[], strategy: Strategy): string {
  const found = cases.find((c) => c.concept === 'addition_within_20' && c.strategy === strategy && c.outcome === 'independent');
  if (found === undefined) throw new Error(`The seed has no independent-success case for ${strategy}`);
  return found.id;
}

function contextFor(workspace: ActivityContext['workspace'], phase: ActivityContext['phase'], problem: Problem, evidenceIds: string[]): ActivityContext {
  return {
    activityId: `${FIXTURE_RUN_ID}_${phase}_${phase === 'support' ? SUPPORT_REVISION : INDEPENDENT_REVISION}`,
    revision: phase === 'support' ? SUPPORT_REVISION : INDEPENDENT_REVISION,
    phase,
    workspace,
    problemRef: problemRefOf(problem),
    start: problem.lhs,
    addend: problem.rhs,
    evidenceIds,
  };
}

function specFor(context: ActivityContext, components: ActivityComponent[]): ActivitySpec {
  return {
    catalogVersion: CATALOG_VERSION,
    activityId: context.activityId,
    revision: context.revision,
    phase: context.phase,
    problemRef: context.problemRef,
    evidenceIds: context.evidenceIds,
    components,
  };
}

// Every fixture is checked by the same validator the publish step uses, so a fixture that drifts
// from the catalog fails here instead of in a test of something else.
function checked(context: ActivityContext, components: ActivityComponent[]): { context: ActivityContext; spec: ActivitySpec } {
  return { context, spec: validateActivity(specFor(context, components), context) };
}

export function deriveFixtures(cases: readonly LearningCase[], seed: number, lessonProblems: readonly Problem[]): FixtureSet {
  const { initial, independent } = selectProblems(seed, lessonProblems);
  const makeTenEvidence = [evidenceCaseFor(cases, 'make_ten')];
  const anchorEvidence = [evidenceCaseFor(cases, 'anchor_start')];
  const makeTen = (problem: Problem, helpers: boolean): ActivityComponent[] => [
    { id: 'box', type: 'MakeTenWorkspace', props: { first: problem.lhs, second: problem.rhs, appearance: 'apple', highlightEmptySlots: helpers, showEquation: helpers } },
  ];
  const line = (problem: Problem): ActivityComponent => ({ id: 'line', type: 'NumberLine', props: { start: problem.lhs, addend: problem.rhs } });

  return {
    makeTenSupport: checked(contextFor('MakeTenWorkspace', 'support', initial, makeTenEvidence), makeTen(initial, true)),
    makeTenIndependent: checked(contextFor('MakeTenWorkspace', 'independent', independent, []), makeTen(independent, false)),
    numberLineSupport: checked(contextFor('NumberLine', 'support', initial, anchorEvidence), [
      line(initial),
      { id: 'marker', type: 'StartMarker', props: { targetId: 'line', value: initial.lhs } },
      { id: 'counter', type: 'JumpCounter', props: { targetId: 'line' } },
    ]),
    numberLineIndependent: checked(contextFor('NumberLine', 'independent', independent, []), [line(independent)]),
  };
}

export function renderFixturesSource(fixtures: FixtureSet): string {
  const declarations = Object.entries(fixtures).map(([name, fixture]) => `export const ${name}: ActivityFixture = ${JSON.stringify(fixture, null, 2)};`);
  return [
    '// Generated by scripts/derive-activity-fixtures.ts from the seeded problem selector and the seed cases.',
    '// Do not edit by hand: rerun the script and commit its output.',
    "import type { ActivityContext, ActivitySpec } from '../domain.js';",
    '',
    'export type ActivityFixture = { readonly context: ActivityContext; readonly spec: ActivitySpec };',
    '',
    declarations.join('\n\n'),
    '',
  ].join('\n');
}

export function deriveActivityFixturesSource(): string {
  const cases = z.array(CaseSchema).parse(JSON.parse(readFileSync(SEED_CASES_PATH, 'utf8')));
  return renderFixturesSource(deriveFixtures(cases, FILM_SEED, PREPARED_LESSON_PROBLEMS));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = deriveActivityFixturesSource();
  writeFileSync(FIXTURES_PATH, source);
  console.log(`Wrote ${FIXTURES_PATH} (${Buffer.byteLength(source)} bytes) for seed ${FILM_SEED}`);
  console.log(source);
}
