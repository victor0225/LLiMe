import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { type Activity, type Problem, TEMPLATE_KIND, type TemplateId } from '../src/domain.js';
import { problemRefOf } from '../src/problems.js';
import { activityContextOf, ActivityValidationError, validateActivity } from '../src/ui/activity-catalog.js';
import { type ActivityFixture, makeTenIndependent, makeTenSupport, numberLineIndependent, numberLineSupport } from '../src/ui/activity-fixtures.js';

// A stored activity record with only the fields the context is built from set meaningfully.
function storedActivity(templateId: TemplateId, overrides: Partial<Activity> = {}): Activity {
  return {
    id: 'run1_activity_4',
    revision: 4,
    runId: 'run1',
    kind: TEMPLATE_KIND[templateId],
    templateId,
    strategy: null,
    problem: { lhs: 7, rhs: 6 },
    title: 'title',
    body: 'body',
    primaryLabel: 'Check my answer',
    secondaryLabel: null,
    activitySpec: null,
    specHash: null,
    helperCount: 0,
    evidenceIds: [],
    decisionSummary: '',
    ...overrides,
  };
}

// The stored record that the fixture's context describes, as publication would have saved it.
function activityForFixture({ context }: ActivityFixture, templateId: TemplateId): Activity {
  const problem: Problem = { lhs: context.start, rhs: context.addend };
  return storedActivity(templateId, { id: context.activityId, revision: context.revision, problem, evidenceIds: context.evidenceIds });
}

const throwsValidation = (activity: Activity) => assert.throws(() => activityContextOf(activity), ActivityValidationError);

describe('activityContextOf', () => {
  test('builds a make-ten support context from the stored record', () => {
    const activity = storedActivity('make_ten_blocks', { problem: { lhs: 8, rhs: 5 }, evidenceIds: ['seed_0_5'] });
    assert.deepEqual(activityContextOf(activity), {
      activityId: 'run1_activity_4',
      revision: 4,
      phase: 'support',
      workspace: 'MakeTenWorkspace',
      problemRef: problemRefOf({ lhs: 8, rhs: 5 }),
      start: 8,
      addend: 5,
      evidenceIds: ['seed_0_5'],
    });
  });

  test('each generated-activity template mounts its own workspace and phase', () => {
    const expected: [TemplateId, string, string][] = [
      ['make_ten_blocks', 'support', 'MakeTenWorkspace'],
      ['independent_make_ten', 'independent', 'MakeTenWorkspace'],
      ['anchor_start_number_line', 'support', 'NumberLine'],
      ['independent_number_line', 'independent', 'NumberLine'],
    ];
    for (const [templateId, phase, workspace] of expected) {
      const context = activityContextOf(storedActivity(templateId));
      assert.deepEqual([context.phase, context.workspace], [phase, workspace], templateId);
    }
  });

  test('reproduces every derived fixture context, and each fixture spec validates against it', () => {
    const cases: [ActivityFixture, TemplateId][] = [
      [makeTenSupport, 'make_ten_blocks'],
      [makeTenIndependent, 'independent_make_ten'],
      [numberLineSupport, 'anchor_start_number_line'],
      [numberLineIndependent, 'independent_number_line'],
    ];
    for (const [fixture, templateId] of cases) {
      const context = activityContextOf(activityForFixture(fixture, templateId));
      assert.deepEqual(context, fixture.context, templateId);
      assert.deepEqual(validateActivity(fixture.spec, context), fixture.spec, templateId);
    }
  });

  test('takes operands from the stored problem, so a spec for other numbers is rejected', () => {
    const activity = activityForFixture(makeTenSupport, 'make_ten_blocks');
    const context = activityContextOf({ ...activity, problem: { lhs: 9, rhs: 4 } });
    assert.throws(() => validateActivity(makeTenSupport.spec, context), ActivityValidationError);
  });

  test('rejects templates that carry no generated workspace', () => {
    const plain: TemplateId[] = ['invitation_addition', 'initial_number_line', 'manipulation_retry', 'clarify_first_number', 'clarify_show_steps', 'completion'];
    for (const templateId of plain) throwsValidation(storedActivity(templateId));
  });

  test('rejects a record whose kind its template does not produce', () => {
    throwsValidation(storedActivity('make_ten_blocks', { kind: 'independent' }));
    throwsValidation(storedActivity('independent_make_ten', { kind: 'support' }));
  });

  test('rejects a record without a problem', () => {
    throwsValidation(storedActivity('make_ten_blocks', { problem: null }));
  });

  test('rejects stored IDs that a spec could not carry', () => {
    throwsValidation(storedActivity('make_ten_blocks', { id: 'run1:activity' }));
    throwsValidation(storedActivity('make_ten_blocks', { evidenceIds: ['case one'] }));
  });
});
