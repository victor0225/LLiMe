import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useState, type ReactNode } from 'react';
import { ACTIVITY_COPY } from '../src/copy';
import { type Activity, type ActivitySpec, ActivitySchema, type Appearance, MATCHING_VERSION, TEMPLATE_KIND } from '../src/domain';
import { type RunEvent, type RunSnapshot, RunSnapshotSchema } from '../src/events';
import { FILM_SEED } from '../src/problems';
import { routePath } from '../src/routes';
import { countHelpers } from '../src/ui/activity-catalog';
import { type ActivityFixture, makeTenIndependent, makeTenSupport, numberLineIndependent, numberLineSupport } from '../src/ui/activity-fixtures';
import { ActivityView, type NumberLineSlot } from '../web/activity/ActivityView';
import { createEventStore, useRunEvents } from '../web/lib/event-store';
import { Practice, sendPracticeAttempt } from '../web/student/Practice';

// Stories mount the real host, workspace and event store with the derived fixtures. A story server
// stands in for the app server; the voice commands it receives and the submitted attempts are written
// to the story log below the activity.

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

// A number-line screen that throws while rendering, to show that a failed render keeps the last
// mounted activity and sends no receipt.
const brokenNumberLine: NumberLineSlot = () => {
  throw new Error('Story number line failed to render');
};

type LogEntry = { kind: 'activity_rendered' | 'submit'; detail: unknown };

const STORY_RUN_ID = 'story_run';
const STORY_TIME = '2026-11-09T10:00:00.000Z';

// A stand-in for the app server, answering the event store through its injected fetch. It holds the
// run's current activity, commits a `state.committed` event when a story delivers a new one (as a
// publication would), and records every voice command the store's queue posts.
function createStoryServer(initial: Activity | null, onVoiceCommand: (body: unknown) => void) {
  let activity = initial;
  let revision = 1;
  const events: RunEvent[] = [];
  const snapshot = (): RunSnapshot =>
    RunSnapshotSchema.parse({
      phase: activity?.kind === 'independent' ? 'VERIFY' : 'PRACTICE',
      stopped: false,
      studentId: 'story_student',
      corpusHash: 'story',
      matchingVersion: MATCHING_VERSION,
      seed: FILM_SEED,
      lessonProblems: null,
      selectedProblems: null,
      explanationRevision: 0,
      cancellationEpoch: 0,
      clarificationRounds: 0,
      interventionCount: 0,
      continuationAllowed: false,
      runtime: null,
      lesson: null,
      invitation: null,
      activity,
      attempts: [],
      explanation: null,
      graph: null,
      search: null,
      error: null,
      createdAt: STORY_TIME,
      id: STORY_RUN_ID,
      revision,
      seq: events.length,
      execution: { throughSeq: events.length, events: [] },
    });
  const commit = () => {
    revision += 1;
    events.push({ runId: STORY_RUN_ID, seq: events.length + 1, type: 'state.committed', payload: { phase: snapshot().phase, revision, caseIds: [] }, at: STORY_TIME });
  };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchDouble: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    if (url.pathname === routePath('bootstrap')) return json({ nonce: 'story-nonce', voice: 'missing_key', inputMode: 'typed', runtime: 'story', database: 'story', dataset: 'synthetic' });
    if (url.pathname === routePath('getRun', { runId: STORY_RUN_ID })) return json(snapshot());
    if (url.pathname === routePath('runEvents', { runId: STORY_RUN_ID })) return json(events.filter((event) => event.seq > Number(url.searchParams.get('after'))));
    if (url.pathname === routePath('voiceCommand', { runId: STORY_RUN_ID }) && init?.method === 'POST') {
      onVoiceCommand(JSON.parse(String(init.body)));
      commit();
      return json(snapshot());
    }
    return new Response(null, { status: 404 });
  };
  return {
    store: createEventStore(STORY_RUN_ID, { fetch: fetchDouble }),
    deliver: (next: Activity) => {
      activity = next;
      commit();
    },
  };
}

type HarnessProps = {
  initial: Activity | null;
  // Defaults to the number-line practice screen, as the student app mounts it.
  numberLine?: NumberLineSlot;
  deliveries?: { label: string; activity: Activity }[];
  // Stories have no voice session, so an independent start is allowed unless a story waits on purpose.
  independentStart?: 'waiting' | 'ready';
};

function Harness({ initial, numberLine, deliveries = [], independentStart = 'ready' }: HarnessProps): ReactNode {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [server] = useState(() => createStoryServer(initial, (body) => setLog((entries) => [...entries, { kind: 'activity_rendered', detail: body }])));
  const { run } = useRunEvents(server.store);
  useEffect(() => {
    server.store.start();
    return () => server.store.stop();
  }, [server]);
  return (
    <main className="story-frame">
      <h1 className="story-heading">Make ten · story fixture, synthetic, no app server</h1>
      {run === null ? null : (
        <ActivityView
          activity={run.activity}
          store={server.store}
          voiceSessionId={null}
          numberLine={numberLine ?? ((shown) => <Practice activity={shown} phase={run.phase} voiceOff={false} submit={sendPracticeAttempt(server.store, shown)} />)}
          independentStart={independentStart}
          onSubmit={(target, attempt) => setLog((entries) => [...entries, { kind: 'submit', detail: { target, attempt } }])}
        />
      )}
      {deliveries.length > 0 ? (
        <section className="story-controls" aria-label="Story controls">
          {deliveries.map(({ label, activity: next }) => (
            <button key={label} type="button" className="p-button" data-variant="secondary" onClick={() => server.deliver(next)}>
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
export const IndependentWaiting: Story = { args: { initial: independent, independentStart: 'waiting' } };
export const HostReplacements: Story = { args: { initial: support, numberLine: brokenNumberLine, deliveries: DELIVERIES } };
export const HostNumberLine: Story = { args: { initial: storyActivity(numberLineSupport, 'anchor_start_number_line') } };
export const HostNumberLineIndependent: Story = { args: { initial: storyActivity(numberLineIndependent, 'independent_number_line') } };
export const HostInvalidFirst: Story = { args: { initial: DELIVERIES[0]?.activity ?? null } };
