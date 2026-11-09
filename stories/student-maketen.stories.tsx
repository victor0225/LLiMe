import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import { ACTIVITY_COPY } from '../src/copy';
import { type Activity, type ActivitySpec, ActivitySchema, type Appearance, TEMPLATE_KIND } from '../src/domain';
import { countHelpers } from '../src/ui/activity-catalog';
import { type ActivityFixture, makeTenIndependent, makeTenSupport, numberLineIndependent, numberLineSupport } from '../src/ui/activity-fixtures';
import { ActivityView, type NumberLineSlot, type NumberLineSlotProps } from '../web/activity/ActivityView';

// Stories mount the real host and workspace with the derived fixtures. Nothing is sent: the render
// receipt and submitted attempts are written to the story log below the activity.

type GeneratedTemplate = 'make_ten_blocks' | 'independent_make_ten' | 'anchor_start_number_line' | 'independent_number_line';

type ActivityChanges = { id?: string; revision?: number; spec?: ActivitySpec; evidenceIds?: string[] };

// A stored activity record as publication saves it, built from a derived fixture. The hash is a
// labeled story value; the host only forwards it.
function storyActivity({ context, spec }: ActivityFixture, templateId: GeneratedTemplate, changes: ActivityChanges = {}): Activity {
  const problem = { lhs: context.start, rhs: context.addend };
  const copy = ACTIVITY_COPY[templateId](problem);
  const id = changes.id ?? context.activityId;
  const revision = changes.revision ?? context.revision;
  const activitySpec = changes.spec ?? spec;
  return ActivitySchema.parse({
    id,
    revision,
    runId: 'story_run',
    kind: TEMPLATE_KIND[templateId],
    templateId,
    strategy: templateId === 'make_ten_blocks' || templateId === 'independent_make_ten' ? 'make_ten' : 'anchor_start',
    problem,
    ...copy,
    activitySpec,
    specHash: `story-hash-${id}-${revision}`,
    helperCount: countHelpers(activitySpec),
    evidenceIds: changes.evidenceIds ?? context.evidenceIds,
    decisionSummary: '',
  });
}

const withAppearance = (spec: ActivitySpec, appearance: Appearance): ActivitySpec => ({
  ...spec,
  components: spec.components.map((component) => (component.type === 'MakeTenWorkspace' ? { ...component, props: { ...component.props, appearance } } : component)),
});

const withSpec = (spec: ActivitySpec, changes: Partial<Omit<ActivitySpec, 'components'>>): ActivitySpec => ({ ...spec, ...changes });

const support = storyActivity(makeTenSupport, 'make_ten_blocks');
const independent = storyActivity(makeTenIndependent, 'independent_make_ten');
const nextRevision = support.revision + 1;
const nextId = `${support.id}_next`;
const sameIds = { id: nextId, revision: nextRevision };
// Each replacement below is newer than the support activity, so only its own fault rejects it.
const wrongMathSpec: ActivitySpec = {
  ...withSpec(makeTenSupport.spec, { activityId: nextId, revision: nextRevision }),
  components: makeTenSupport.spec.components.map((component) => (component.type === 'MakeTenWorkspace' ? { ...component, props: { ...component.props, first: component.props.first - 1 } } : component)),
};

const DELIVERIES: { label: string; activity: Activity }[] = [
  { label: 'Wrong numbers', activity: storyActivity(makeTenSupport, 'make_ten_blocks', { ...sameIds, spec: wrongMathSpec }) },
  { label: 'Stale spec revision', activity: storyActivity(makeTenSupport, 'make_ten_blocks', { ...sameIds, spec: withSpec(makeTenSupport.spec, { activityId: nextId, revision: support.revision }) }) },
  { label: 'Forged evidence', activity: storyActivity(makeTenSupport, 'make_ten_blocks', { ...sameIds, spec: withSpec(makeTenSupport.spec, { activityId: nextId, revision: nextRevision, evidenceIds: ['story_forged_case'] }) }) },
  { label: 'Older activity', activity: storyActivity(makeTenSupport, 'make_ten_blocks', { id: `${support.id}_older`, revision: support.revision - 1, spec: withSpec(makeTenSupport.spec, { activityId: `${support.id}_older`, revision: support.revision - 1 }) }) },
  { label: 'Number line that fails to render', activity: storyActivity(numberLineIndependent, 'independent_number_line', { revision: independent.revision + 1, id: 'story_line_failing', spec: withSpec(numberLineIndependent.spec, { activityId: 'story_line_failing', revision: independent.revision + 1 }) }) },
  { label: 'Independent activity', activity: independent },
];

// Stand-in for the number-line workspace until that component is bound: it shows the props the host
// passes so the slot contract is visible. It records nothing and submits nothing.
function NumberLineProbe({ start, addend, startMarker, showJumpCount, hints }: NumberLineSlotProps): ReactNode {
  return (
    <dl className="story-number-line" aria-label="Number line slot (stand-in)">
      <dt>start</dt>
      <dd data-prop="start">{start}</dd>
      <dt>addend</dt>
      <dd data-prop="addend">{addend}</dd>
      <dt>startMarker</dt>
      <dd data-prop="startMarker">{startMarker ?? 'none'}</dd>
      <dt>showJumpCount</dt>
      <dd data-prop="showJumpCount">{String(showJumpCount)}</dd>
      <dt>hints</dt>
      <dd data-prop="hints">{hints}</dd>
    </dl>
  );
}

// A number-line component that throws while rendering, to show that a failed render keeps the last
// mounted activity and sends no receipt.
const BrokenNumberLine: NumberLineSlot = () => {
  throw new Error('Story number line failed to render');
};

type LogEntry = { kind: 'activity_rendered' | 'submit'; detail: unknown };

function Harness({ initial, numberLine = NumberLineProbe, deliveries = [] }: { initial: Activity | null; numberLine?: NumberLineSlot; deliveries?: { label: string; activity: Activity }[] }): ReactNode {
  const [activity, setActivity] = useState<Activity | null>(initial);
  const [log, setLog] = useState<LogEntry[]>([]);
  const append = (entry: LogEntry) => setLog((entries) => [...entries, entry]);
  return (
    <main className="story-frame">
      <h1 className="story-heading">Make ten · story fixture, synthetic, nothing is sent</h1>
      <ActivityView
        activity={activity}
        numberLine={numberLine}
        acknowledgeRender={(target) => append({ kind: 'activity_rendered', detail: target })}
        onSubmit={(target, attempt) => append({ kind: 'submit', detail: { target, attempt } })}
      />
      {deliveries.length > 0 ? (
        <section className="story-controls" aria-label="Story controls">
          {deliveries.map(({ label, activity: next }) => (
            <button key={label} type="button" className="p-button" data-variant="secondary" onClick={() => setActivity(next)}>
              Deliver: {label}
            </button>
          ))}
        </section>
      ) : null}
      <section className="story-log" aria-label="Story log">
        <ol>
          {log.map((entry, index) => (
            <li key={index} data-log-kind={entry.kind}>
              <code>{JSON.stringify(entry.detail)}</code>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

const meta = {
  title: 'Student/MakeTen',
  component: Harness,
  decorators: [
    (Story) => (
      <>
        <style>{'.story-frame{box-sizing:border-box;min-height:100vh;padding:var(--p-space-2);background:var(--p-surface);font-family:var(--p-font)}.story-heading{margin:0 0 var(--p-space-1);font-size:var(--p-font-small);color:var(--p-muted)}.story-controls,.story-log{margin-top:var(--p-space-2);font-size:var(--p-font-small)}.story-controls{display:flex;flex-wrap:wrap;gap:var(--p-space-1)}.story-log code{word-break:break-all}'}</style>
        <Story />
      </>
    ),
  ],
} satisfies Meta<typeof Harness>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Support: Story = { args: { initial: support } };
export const SupportPear: Story = { args: { initial: storyActivity(makeTenSupport, 'make_ten_blocks', { spec: withAppearance(makeTenSupport.spec, 'pear') }) } };
export const SupportDot: Story = { args: { initial: storyActivity(makeTenSupport, 'make_ten_blocks', { spec: withAppearance(makeTenSupport.spec, 'dot') }) } };
export const Independent: Story = { args: { initial: independent } };
export const HostReplacements: Story = { args: { initial: support, numberLine: BrokenNumberLine, deliveries: DELIVERIES } };
export const HostNumberLine: Story = { args: { initial: storyActivity(numberLineSupport, 'anchor_start_number_line') } };
export const HostNumberLineIndependent: Story = { args: { initial: storyActivity(numberLineIndependent, 'independent_number_line') } };
export const HostInvalidFirst: Story = { args: { initial: DELIVERIES[0]?.activity ?? null } };
