import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ACTIVITY_COPY, INVITATION_COPY, OUTCOME_COPY, SPOKEN_COPY, STUDENT_COPY } from '../src/copy.js';
import { type ActivityContext, type ActivitySpec, CATALOG_VERSION, type Appearance } from '../src/domain.js';
import { activityCatalog, activityPrompt, countHelpers, validateActivity } from '../src/ui/activity-catalog.js';

// Builders take the operands as arguments so each test states only what it needs. The run's real
// pair comes from the problem selector in the fixture tests; here the numbers only need to be valid.
const supportEvidence = ['ev_one', 'ev_two', 'ev_three'];

const contextFor = (workspace: ActivityContext['workspace'], overrides: Partial<ActivityContext> = {}): ActivityContext => ({
  activityId: 'run1_support_1',
  revision: 3,
  phase: 'support',
  workspace,
  problemRef: 'problem_ref_a',
  start: 7,
  addend: 6,
  evidenceIds: supportEvidence,
  ...overrides,
});

const makeTenSpec = (context: ActivityContext, props: Partial<Extract<ActivitySpec['components'][number], { type: 'MakeTenWorkspace' }>['props']> = {}): ActivitySpec => ({
  catalogVersion: CATALOG_VERSION,
  activityId: context.activityId,
  revision: context.revision,
  phase: context.phase,
  problemRef: context.problemRef,
  evidenceIds: context.phase === 'support' ? context.evidenceIds.slice(0, 1) : [],
  components: [{ id: 'box', type: 'MakeTenWorkspace', props: { first: context.start, second: context.addend, appearance: 'apple', highlightEmptySlots: false, showEquation: false, ...props } }],
});

const lineSpec = (context: ActivityContext, extra: ActivitySpec['components'] = []): ActivitySpec => ({
  ...makeTenSpec(context),
  components: [{ id: 'line', type: 'NumberLine', props: { start: context.start, addend: context.addend } }, ...extra],
});

const marker = (value: number, targetId = 'line'): ActivitySpec['components'][number] => ({ id: 'marker', type: 'StartMarker', props: { targetId, value } });
const counter = (targetId = 'line'): ActivitySpec['components'][number] => ({ id: 'counter', type: 'JumpCounter', props: { targetId } });

// Raw objects model what a composer could emit; they bypass the typed builders on purpose.
const asRaw = (spec: ActivitySpec): Record<string, unknown> => JSON.parse(JSON.stringify(spec));

describe('validateActivity accepts', () => {
  test('a make-ten support spec with both helpers, in each appearance', () => {
    const context = contextFor('MakeTenWorkspace');
    const appearances: Appearance[] = ['apple', 'pear', 'dot'];
    for (const appearance of appearances) {
      const spec = makeTenSpec(context, { appearance, highlightEmptySlots: true, showEquation: true });
      assert.deepEqual(validateActivity(spec, context), spec);
    }
  });

  test('plain NumberLine support and the apple, dot and pear appearances', () => {
    const context = contextFor('NumberLine');
    const plain = lineSpec(context);
    assert.deepEqual(validateActivity(plain, context), plain);
    const full = lineSpec(context, [marker(context.start), counter()]);
    assert.deepEqual(validateActivity(full, context), full);
    const makeTen = contextFor('MakeTenWorkspace');
    for (const appearance of ['apple', 'dot', 'pear'] as const) {
      assert.equal(validateActivity(makeTenSpec(makeTen, { appearance }), makeTen).components.length, 1);
    }
  });

  test('independent specs of both workspaces with no helper', () => {
    const makeTen = contextFor('MakeTenWorkspace', { phase: 'independent', evidenceIds: [], revision: 4 });
    const line = contextFor('NumberLine', { phase: 'independent', evidenceIds: [], revision: 4 });
    assert.equal(validateActivity(makeTenSpec(makeTen), makeTen).phase, 'independent');
    assert.equal(validateActivity(lineSpec(line), line).phase, 'independent');
  });

  test('default support that cites no evidence when the context has none', () => {
    const context = contextFor('MakeTenWorkspace', { evidenceIds: [] });
    assert.deepEqual(validateActivity(makeTenSpec(context), context).evidenceIds, []);
  });
});

describe('validateActivity rejects', () => {
  test('an unknown component, an unknown prop and an unknown root field', () => {
    const context = contextFor('NumberLine');
    const unknownComponent = asRaw(lineSpec(context));
    unknownComponent.components = [{ id: 'line', type: 'Button', props: { start: 7, addend: 6 } }];
    assert.throws(() => validateActivity(unknownComponent, context), /components\.0/);

    const unknownProp = asRaw(lineSpec(context));
    unknownProp.components = [{ id: 'line', type: 'NumberLine', props: { start: 7, addend: 6, label: 'Count on' } }];
    assert.throws(() => validateActivity(unknownProp, context), /label/);

    const unknownRoot = asRaw(lineSpec(context));
    unknownRoot.title = 'Count on';
    assert.throws(() => validateActivity(unknownRoot, context), /title/);

    const wrongCatalog = asRaw(lineSpec(context));
    wrongCatalog.catalogVersion = 'llime-math-v1';
    assert.throws(() => validateActivity(wrongCatalog, context), /catalogVersion/);
  });

  test('a stale activityId, revision, phase or problemRef', () => {
    const context = contextFor('MakeTenWorkspace');
    const base = makeTenSpec(context);
    for (const field of ['activityId', 'revision', 'phase', 'problemRef'] as const) {
      const stale = { ...base, [field]: field === 'revision' ? base.revision - 1 : field === 'phase' ? 'independent' : `${base[field]}_old` };
      assert.throws(() => validateActivity(stale, context), new RegExp(`Stale or mismatched activity context: ${field}`));
    }
  });

  test('forged or duplicate evidence', () => {
    const context = contextFor('MakeTenWorkspace');
    const forged = { ...makeTenSpec(context), evidenceIds: ['ev_one', 'ev_forged'] };
    assert.throws(() => validateActivity(forged, context), /Invalid activity evidence/);
    const duplicate = { ...makeTenSpec(context), evidenceIds: ['ev_one', 'ev_one'] };
    assert.throws(() => validateActivity(duplicate, context), /Invalid activity evidence/);
  });

  test('evidence-based support must cite 1..5 allowed IDs and default support must cite none', () => {
    const allowed = ['ev_a', 'ev_b', 'ev_c', 'ev_d', 'ev_e'];
    const evidenceContext = contextFor('MakeTenWorkspace', { evidenceIds: allowed });
    assert.throws(() => validateActivity({ ...makeTenSpec(evidenceContext), evidenceIds: [] }, evidenceContext), /Invalid activity evidence/);
    assert.deepEqual(validateActivity({ ...makeTenSpec(evidenceContext), evidenceIds: allowed }, evidenceContext).evidenceIds, allowed);
    assert.deepEqual(validateActivity({ ...makeTenSpec(evidenceContext), evidenceIds: ['ev_c'] }, evidenceContext).evidenceIds, ['ev_c']);
    assert.throws(() => validateActivity({ ...makeTenSpec(evidenceContext), evidenceIds: [...allowed, 'ev_f'] }, evidenceContext), /evidenceIds/);

    const defaultContext = contextFor('MakeTenWorkspace', { evidenceIds: [] });
    assert.throws(() => validateActivity({ ...makeTenSpec(defaultContext), evidenceIds: ['ev_a'] }, defaultContext), /Invalid activity evidence/);
  });

  test('duplicate component IDs or types, and zero or two workspaces', () => {
    const context = contextFor('NumberLine');
    const duplicateId = lineSpec(context, [{ id: 'line', type: 'JumpCounter', props: { targetId: 'line' } }]);
    assert.throws(() => validateActivity(duplicateId, context), /Duplicate component/);

    const duplicateType = lineSpec(context, [counter(), { id: 'counter_two', type: 'JumpCounter', props: { targetId: 'line' } }]);
    assert.throws(() => validateActivity(duplicateType, context), /Duplicate component/);

    const noWorkspace = { ...lineSpec(context), components: [counter()] };
    assert.throws(() => validateActivity(noWorkspace, context), /Exactly one workspace/);

    const twoWorkspaces = lineSpec(context, [{ id: 'box', type: 'MakeTenWorkspace', props: { first: 7, second: 6, appearance: 'apple', highlightEmptySlots: false, showEquation: false } }]);
    assert.throws(() => validateActivity(twoWorkspaces, context), /Exactly one workspace/);
  });

  test('a workspace that does not match the strategy', () => {
    const makeTen = contextFor('MakeTenWorkspace');
    const line = contextFor('NumberLine');
    assert.throws(() => validateActivity(lineSpec(makeTen), makeTen), /Workspace does not match strategy/);
    assert.throws(() => validateActivity(makeTenSpec(line), line), /Workspace does not match strategy/);
  });

  test('operands that differ from the selected pair', () => {
    const makeTen = contextFor('MakeTenWorkspace');
    assert.throws(() => validateActivity(makeTenSpec(makeTen, { first: makeTen.start + 1 }), makeTen), /Problem mismatch/);
    assert.throws(() => validateActivity(makeTenSpec(makeTen, { second: makeTen.addend + 1 }), makeTen), /Problem mismatch/);

    const line = contextFor('NumberLine');
    const wrongStart = { ...lineSpec(line), components: [{ id: 'line', type: 'NumberLine' as const, props: { start: line.start + 1, addend: line.addend } }] };
    const wrongAddend = { ...lineSpec(line), components: [{ id: 'line', type: 'NumberLine' as const, props: { start: line.start, addend: line.addend - 1 } }] };
    assert.throws(() => validateActivity(wrongStart, line), /Problem mismatch/);
    assert.throws(() => validateActivity(wrongAddend, line), /Problem mismatch/);
  });

  test('a problem whose sum leaves the range the workspace can show', () => {
    const tooBig = contextFor('NumberLine', { start: 19, addend: 2 });
    assert.throws(() => validateActivity(lineSpec(tooBig), tooBig), /Problem mismatch/);
    const noLeftover = contextFor('MakeTenWorkspace', { start: 4, addend: 6 });
    assert.throws(() => validateActivity(makeTenSpec(noLeftover), noLeftover), /Problem mismatch/);
  });

  test('a wrong StartMarker value or target', () => {
    const context = contextFor('NumberLine');
    assert.throws(() => validateActivity(lineSpec(context, [marker(context.start + 1)]), context), /Wrong start marker/);
    assert.throws(() => validateActivity(lineSpec(context, [marker(context.start, 'elsewhere')]), context), /Invalid scaffold target/);
    assert.throws(() => validateActivity(lineSpec(context, [counter('elsewhere')]), context), /Invalid scaffold target/);
  });

  test('any helper component next to MakeTenWorkspace', () => {
    const context = contextFor('MakeTenWorkspace');
    const withMarker = { ...makeTenSpec(context), components: [...makeTenSpec(context).components, marker(context.start, 'box')] };
    const withCounter = { ...makeTenSpec(context), components: [...makeTenSpec(context).components, counter('box')] };
    assert.throws(() => validateActivity(withMarker, context), /Invalid scaffold target/);
    assert.throws(() => validateActivity(withCounter, context), /Invalid scaffold target/);
  });

  test('every helper on an independent spec, including the MakeTen highlightEmptySlots and showEquation', () => {
    const line = contextFor('NumberLine', { phase: 'independent', evidenceIds: [] });
    assert.throws(() => validateActivity(lineSpec(line, [marker(line.start)]), line), /Independent task cannot contain scaffolds/);
    assert.throws(() => validateActivity(lineSpec(line, [counter()]), line), /Independent task cannot contain scaffolds/);
    assert.throws(() => validateActivity(lineSpec(line, [marker(line.start), counter()]), line), /Independent task cannot contain scaffolds/);

    const makeTen = contextFor('MakeTenWorkspace', { phase: 'independent', evidenceIds: [] });
    assert.throws(() => validateActivity(makeTenSpec(makeTen, { highlightEmptySlots: true }), makeTen), /Independent task cannot contain scaffolds/);
    assert.throws(() => validateActivity(makeTenSpec(makeTen, { showEquation: true }), makeTen), /Independent task cannot contain scaffolds/);
    assert.throws(() => validateActivity(makeTenSpec(makeTen, { highlightEmptySlots: true, showEquation: true }), makeTen), /Independent task cannot contain scaffolds/);
  });
});

describe('countHelpers', () => {
  test('helper count is one per StartMarker, JumpCounter, highlightEmptySlots and showEquation', () => {
    const line = contextFor('NumberLine');
    assert.equal(countHelpers(lineSpec(line)), 0);
    assert.equal(countHelpers(lineSpec(line, [marker(line.start)])), 1);
    assert.equal(countHelpers(lineSpec(line, [counter()])), 1);
    assert.equal(countHelpers(lineSpec(line, [marker(line.start), counter()])), 2);

    const makeTen = contextFor('MakeTenWorkspace');
    assert.equal(countHelpers(makeTenSpec(makeTen)), 0);
    assert.equal(countHelpers(makeTenSpec(makeTen, { highlightEmptySlots: true })), 1);
    assert.equal(countHelpers(makeTenSpec(makeTen, { showEquation: true })), 1);
    assert.equal(countHelpers(makeTenSpec(makeTen, { highlightEmptySlots: true, showEquation: true })), 2);
  });
});

// Copy tables mix fixed strings with builders of operand-specific strings; only the fixed ones are listed.
const plainStrings = (table: Record<string, unknown>): string[] => Object.values(table).flatMap((value) => (typeof value === 'string' ? [value] : []));

describe('activityPrompt', () => {
  const prompt = activityPrompt();

  test('the composer prompt carries the catalog rules and no child-facing copy', () => {
    assert.ok(prompt.includes(CATALOG_VERSION));
    for (const name of activityCatalog.componentNames) assert.ok(prompt.includes(name), `lists ${name}`);
    for (const rule of ['support-only', 'at most three components', 'one workspace', 'Do not generate executable code, URLs, text']) {
      assert.ok(prompt.includes(rule), `states: ${rule}`);
    }
    const sample = { lhs: 8, rhs: 5 };
    const copyStrings = [
      ...plainStrings(INVITATION_COPY),
      ...plainStrings(OUTCOME_COPY),
      ...plainStrings(SPOKEN_COPY),
      ...plainStrings(STUDENT_COPY),
      ...Object.values(ACTIVITY_COPY).flatMap((build) => {
        const { title, body, primaryLabel, secondaryLabel } = build(sample);
        return [title, body, primaryLabel, secondaryLabel ?? ''];
      }),
    ].filter((text) => text.length >= 8);
    for (const text of copyStrings) assert.ok(!prompt.includes(text), `prompt leaks child copy: ${text}`);
  });

  test('asks for the single catalog document, not UI patches', () => {
    assert.ok(!/JSONL|JSON Patch|\/elements|\/state/.test(prompt));
    assert.ok(prompt.includes('Output only the specified catalog document'));
  });
});
