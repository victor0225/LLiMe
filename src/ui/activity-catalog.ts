// The generated-activity catalog: which components a composer may use, the rules a spec must obey
// before it is published, and the prompt that teaches a composer the shape. Isomorphic: the browser
// mounts only specs that passed `validateActivity`, so this module imports no Node module.
import { defineCatalog, defineSchema, type PromptContext } from '@json-render/core';
import {
  type Activity,
  type ActivityComponent,
  type ActivityContext,
  ActivityContextSchema,
  ActivitySpecSchema,
  type ActivitySpec,
  CATALOG_VERSION,
  JumpCounterPropsSchema,
  MakeTenWorkspacePropsSchema,
  NUMBER_LINE_MAX,
  NumberLinePropsSchema,
  StartMarkerPropsSchema,
  TEMPLATE_KIND,
  type TemplateId,
  type Workspace as WorkspaceType,
} from '../domain.js';
import { problemRefOf, SUM_MAX, SUM_MIN } from '../problems.js';

const schema = defineSchema(
  (s) => ({
    spec: s.object({
      catalogVersion: s.string(),
      activityId: s.string(),
      revision: s.number(),
      phase: s.string(),
      problemRef: s.string(),
      evidenceIds: s.array(s.string()),
      components: s.array(s.object({ id: s.string(), type: s.ref('catalog.components'), props: s.propsOf('catalog.components') })),
    }),
    catalog: s.object({ components: s.map({ props: s.zod(), description: s.string() }) }),
  }),
  { promptTemplate: composerPromptTemplate },
);

const components = {
  MakeTenWorkspace: {
    props: MakeTenWorkspacePropsSchema,
    description: 'One ten-frame and tray with conserved objects. Match the supplied operands. Apple is default, pear allowed, dot fallback. Helpers are support-only.',
  },
  NumberLine: {
    props: NumberLinePropsSchema,
    description: 'Primary number-line workspace. Operands must match the supplied problem exactly. No prefilled student moves.',
  },
  StartMarker: {
    props: StartMarkerPropsSchema,
    description: 'Optional support-only marker for the initial location. Does not select or move the learner start. Target the NumberLine id.',
  },
  JumpCounter: {
    props: JumpCounterPropsSchema,
    description: 'Optional support-only live count of learner moves. Target the NumberLine id. Never provides a completed answer.',
  },
};

// Replaces the library's default prompt, which teaches streamed UI patches: a composer here returns
// one complete document of the shape below.
function composerPromptTemplate({ options, formatZodType }: PromptContext): string {
  const componentLines = Object.entries(components).map(([name, { props, description }]) => `- ${name}: ${formatZodType(props)} - ${description}`);
  const rules = options.customRules ?? [];
  return [
    options.system ?? 'You compose one learning activity as a single JSON document.',
    '',
    `DOCUMENT (catalogVersion ${CATALOG_VERSION}):`,
    '{"catalogVersion": string, "activityId": string, "revision": number, "phase": "support"|"independent", "problemRef": string, "evidenceIds": string[], "components": [{"id": string, "type": <component name>, "props": <that component\'s props>}]}',
    '',
    `AVAILABLE COMPONENTS (${componentLines.length}):`,
    ...componentLines,
    '',
    'RULES:',
    ...rules.map((rule, index) => `${index + 1}. ${rule}`),
  ].join('\n');
}

export const activityCatalog = defineCatalog(schema, { components });

export class ActivityValidationError extends Error {
  override readonly name = 'ActivityValidationError';
}

const fail = (message: string): never => {
  throw new ActivityValidationError(message);
};

type Workspace = Extract<ActivityComponent, { type: 'NumberLine' | 'MakeTenWorkspace' }>;

const isWorkspace = (component: ActivityComponent): component is Workspace => component.type === 'NumberLine' || component.type === 'MakeTenWorkspace';

// The order is part of the contract: the first failing rule names the error, so a stale context is
// reported as stale rather than as a wrong problem.
export function validateActivity(value: unknown, context: ActivityContext): ActivitySpec {
  const parsed = ActivitySpecSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'spec'}: ${issue.message}`);
    return fail(`Invalid activity spec: ${issues.join('; ')}`);
  }
  const spec = parsed.data;
  if (!activityCatalog.validate(spec).success) return fail('Catalog validation failed');

  for (const field of ['activityId', 'revision', 'phase', 'problemRef'] as const) {
    if (spec[field] !== context[field]) return fail(`Stale or mismatched activity context: ${field}`);
  }

  const citesOnlyAllowed = spec.evidenceIds.every((id) => context.evidenceIds.includes(id));
  const citesOnce = new Set(spec.evidenceIds).size === spec.evidenceIds.length;
  // Support built on retrieved evidence must say which; independent specs never need to.
  const missingRequired = spec.phase === 'support' && context.evidenceIds.length > 0 && spec.evidenceIds.length === 0;
  if (!citesOnlyAllowed || !citesOnce || missingRequired) return fail('Invalid activity evidence');

  if (new Set(spec.components.map((c) => c.id)).size !== spec.components.length || new Set(spec.components.map((c) => c.type)).size !== spec.components.length) {
    return fail('Duplicate component');
  }
  const workspaces = spec.components.filter(isWorkspace);
  const workspace = workspaces[0];
  if (workspaces.length !== 1 || workspace === undefined) return fail('Exactly one workspace');
  if (workspace.type !== context.workspace) return fail('Workspace does not match strategy');
  if (spec.phase === 'independent' && spec.components.length !== 1) return fail('Independent task cannot contain scaffolds');

  if (workspace.type === 'NumberLine') {
    const { start, addend } = workspace.props;
    if (start !== context.start || addend !== context.addend || start + addend > NUMBER_LINE_MAX) return fail('Problem mismatch');
    for (const component of spec.components) {
      if ((component.type === 'StartMarker' || component.type === 'JumpCounter') && component.props.targetId !== workspace.id) return fail('Invalid scaffold target');
      if (component.type === 'StartMarker' && component.props.value !== start) return fail('Wrong start marker');
    }
    return spec;
  }

  const { first, second, highlightEmptySlots, showEquation } = workspace.props;
  if (first !== context.start || second !== context.addend || first + second < SUM_MIN || first + second > SUM_MAX) return fail('Problem mismatch');
  // Marker and counter belong to the number line; a ten-frame carries its helpers as booleans.
  if (spec.components.length !== 1) return fail('Invalid scaffold target');
  if (spec.phase === 'independent' && (highlightEmptySlots || showEquation)) return fail('Independent task cannot contain scaffolds');
  return spec;
}

// The workspace each generated-activity template mounts. The other templates (initial, retry,
// clarification, invitation, completion) are application-owned and carry no generated spec.
const TEMPLATE_WORKSPACE: Partial<Record<TemplateId, WorkspaceType>> = {
  anchor_start_number_line: 'NumberLine',
  independent_number_line: 'NumberLine',
  make_ten_blocks: 'MakeTenWorkspace',
  independent_make_ten: 'MakeTenWorkspace',
};

// The validation context for a stored activity, built only from what the server committed (ID,
// revision, template, problem, allowed evidence), never from the spec it is about to check. The
// server builds it before publication and the browser before mounting, so both apply the same rules.
export function activityContextOf(activity: Activity): ActivityContext {
  const workspace = TEMPLATE_WORKSPACE[activity.templateId];
  if (workspace === undefined) return fail(`Template ${activity.templateId} has no generated workspace`);
  if (TEMPLATE_KIND[activity.templateId] !== activity.kind) return fail(`Kind ${activity.kind} does not match template ${activity.templateId}`);
  if (activity.problem === null) return fail(`Activity ${activity.id} has no problem`);
  const parsed = ActivityContextSchema.safeParse({
    activityId: activity.id,
    revision: activity.revision,
    phase: activity.kind,
    workspace,
    problemRef: problemRefOf(activity.problem),
    start: activity.problem.lhs,
    addend: activity.problem.rhs,
    evidenceIds: activity.evidenceIds,
  });
  if (!parsed.success) return fail(`Activity ${activity.id} cannot carry a generated spec: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
  return parsed.data;
}

// Help the spec itself exposes: each displayed helper counts once. The server stores this at
// publication so help exposure never depends on what the client reports.
export function countHelpers(spec: ActivitySpec): number {
  let count = 0;
  for (const component of spec.components) {
    if (component.type === 'StartMarker' || component.type === 'JumpCounter') count += 1;
    if (component.type === 'MakeTenWorkspace') count += Number(component.props.highlightEmptySlots) + Number(component.props.showEquation);
  }
  return count;
}

export function activityPrompt(): string {
  return activityCatalog.prompt({
    customRules: [
      `Output only the specified catalog document. Use catalogVersion ${CATALOG_VERSION}.`,
      'Copy activityId, revision, phase and problemRef from the server context. For support with nonempty allowed evidence, select 1..5 distinct allowed IDs; otherwise use an empty evidenceIds array.',
      'Use exactly one workspace of context.workspace, with the supplied operands. Never choose a different problem.',
      'StartMarker and JumpCounter are optional support-only helpers targeting NumberLine. Use each type at most once; at most three components.',
      'MakeTenWorkspace is a single component. Set appearance to apple, pear or dot; apple is default. Its boolean helpers are support-only.',
      'Independent activities contain one workspace, no helper components, and MakeTenWorkspace highlightEmptySlots and showEquation both false.',
      'Do not generate executable code, URLs, text, instructions, chrome or answers.',
    ],
  });
}
