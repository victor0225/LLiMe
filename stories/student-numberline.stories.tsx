import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { ACTIVITY_COPY } from '@core/copy';
import { type Activity, ActivitySchema, type ActivitySpec, MATCHING_VERSION, type Problem, ProblemSchema, type RunPhase, type Strategy, TEMPLATE_KIND, type TemplateId } from '@core/domain';
import { type RunSnapshot, RunSnapshotSchema } from '@core/events';
import { FILM_SEED } from '@core/problems';
import { BootstrapSchema, HttpErrorSchema, HTTP_STATUS, routePath } from '@core/routes';
import { countHelpers } from '@core/ui/activity-catalog';
import { numberLineIndependent, numberLineSupport } from '@core/ui/activity-fixtures';
import { createEventStore } from '../web/lib/event-store';
import { Practice, sendPracticeAttempt } from '../web/student/Practice';

// Each story mounts the practice screen on the real run queue. The queue talks to a stubbed route
// table instead of the app server: every request is listed below the screen, and a command's reply
// waits until "Send server reply" is pressed, so a check in flight can be inspected.

const STORY_RUN_ID = 'story_run';
const STORY_RUN_REVISION = 3;
const STORY_CREATED_AT = '2026-11-09T00:00:00.000Z';
// The problems the prepared lesson states; a run never draws them.
const LESSON_PROBLEMS: Problem[] = [
  { lhs: 7, rhs: 4 },
  { lhs: 7, rhs: 6 },
  { lhs: 6, rhs: 5 },
];

const problemOf = (spec: ActivitySpec): Problem => {
  const line = spec.components.find((component) => component.type === 'NumberLine');
  if (line?.type !== 'NumberLine') throw new Error(`Spec ${spec.activityId} has no number line`);
  return ProblemSchema.parse({ lhs: line.props.start, rhs: line.props.addend });
};

const FILM_INITIAL = problemOf(numberLineSupport.spec);
const FILM_INDEPENDENT = problemOf(numberLineIndependent.spec);

type ActivityInput = { id: string; revision: number; templateId: TemplateId; strategy: Strategy | null; problem: Problem; spec: ActivitySpec | null };

function numberLineActivity({ id, revision, templateId, strategy, problem, spec }: ActivityInput): Activity {
  if (templateId === 'invitation_addition') throw new Error('The invitation is not a number-line activity');
  return ActivitySchema.parse({
    id,
    revision,
    runId: STORY_RUN_ID,
    kind: TEMPLATE_KIND[templateId],
    templateId,
    strategy,
    problem,
    ...ACTIVITY_COPY[templateId](problem),
    activitySpec: spec,
    specHash: spec === null ? null : `story-spec-${spec.activityId}`,
    helperCount: spec === null ? 0 : countHelpers(spec),
    evidenceIds: spec?.evidenceIds ?? [],
    decisionSummary: '',
  });
}

function runSnapshot(activity: Activity, phase: RunPhase, initial: Problem): RunSnapshot {
  return RunSnapshotSchema.parse({
    id: STORY_RUN_ID,
    revision: STORY_RUN_REVISION,
    seq: 0,
    execution: { throughSeq: 0, events: [] },
    phase,
    stopped: false,
    studentId: 'student_7',
    corpusHash: 'story-corpus',
    matchingVersion: MATCHING_VERSION,
    seed: FILM_SEED,
    lessonProblems: LESSON_PROBLEMS,
    selectedProblems: { initial, independent: FILM_INDEPENDENT },
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
    createdAt: STORY_CREATED_AT,
  });
}

type ServerReply = 'saved' | 'conflict';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type StubHooks = { record: (entry: string) => void; waitForReply: () => Promise<void> };

// The routes the run queue calls, answered in the browser. A saved command returns the next run
// revision; a conflict answers 409 with the current revision, as the server does for a stale one.
function stubbedRoutes(initialRun: RunSnapshot, reply: ServerReply, { record, waitForReply }: StubHooks): typeof fetch {
  let run = initialRun;
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.origin);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : '';
    record(method === 'POST' ? `${method} ${url.pathname} ${body}` : `${method} ${url.pathname}`);
    if (method === 'GET' && url.pathname === routePath('bootstrap')) {
      return json(HTTP_STATUS.ok, BootstrapSchema.parse({ nonce: 'story-nonce', voice: 'missing_key', inputMode: 'typed', runtime: 'stubbed route', database: 'stubbed route', dataset: 'stubbed route' }));
    }
    if (method === 'GET' && url.pathname === routePath('getRun', { runId: STORY_RUN_ID })) return json(HTTP_STATUS.ok, run);
    if (method === 'POST' && url.pathname === routePath('runCommand', { runId: STORY_RUN_ID })) {
      await waitForReply();
      if (reply === 'conflict') {
        return json(HTTP_STATUS.conflict, HttpErrorSchema.parse({ code: 'STALE_REVISION', message: 'The run changed before this command arrived.', retryable: false, revision: run.revision }));
      }
      run = RunSnapshotSchema.parse({ ...run, revision: run.revision + 1 });
      return json(HTTP_STATUS.ok, run);
    }
    return json(HTTP_STATUS.notFound, HttpErrorSchema.parse({ code: 'NOT_FOUND', message: `No stubbed route for ${method} ${url.pathname}`, retryable: false }));
  };
}

type HarnessProps = { activity: Activity; phase: RunPhase; initial: Problem; voiceOff: boolean; reply: ServerReply };

function PracticeHarness({ activity, phase, initial, voiceOff, reply }: HarnessProps) {
  const [requests, setRequests] = useState<string[]>([]);
  const [release, setRelease] = useState<(() => void) | null>(null);
  const [store] = useState(() =>
    createEventStore(STORY_RUN_ID, {
      fetch: stubbedRoutes(runSnapshot(activity, phase, initial), reply, {
        record: (entry) => setRequests((previous) => [...previous, entry]),
        waitForReply: () => new Promise<void>((resolve) => setRelease(() => () => resolve())),
      }),
    }),
  );
  const sendReply = () => {
    release?.();
    setRelease(null);
  };

  return (
    <div style={{ minHeight: '100vh', background: 'var(--p-background)' }}>
      <main>
        <Practice activity={activity} phase={phase} voiceOff={voiceOff} submit={sendPracticeAttempt(store, activity)} />
      </main>
      <aside aria-label="Story harness" style={{ maxWidth: 1160, margin: '0 auto', padding: 'var(--p-space-2)', fontFamily: 'var(--p-font)', color: 'var(--p-text)' }}>
        <button type="button" className="p-button" data-variant="secondary" disabled={release === null} onClick={sendReply}>
          Send server reply
        </button>
        <ol aria-label="Requests (stubbed route)" style={{ fontSize: 'var(--p-font-small)', overflowWrap: 'anywhere' }}>
          {requests.map((entry, index) => (
            <li key={`${index}-${entry}`}>
              <code>{entry}</code>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}

const meta = {
  title: 'Student/Number line practice',
  component: PracticeHarness,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof PracticeHarness>;
export default meta;
type Story = StoryObj<typeof meta>;

const initialActivity = numberLineActivity({ id: 'story_initial', revision: 0, templateId: 'initial_number_line', strategy: null, problem: FILM_INITIAL, spec: null });

export const Initial: Story = {
  args: { activity: initialActivity, phase: 'INITIAL', initial: FILM_INITIAL, voiceOff: false, reply: 'saved' },
};

export const InitialConflict: Story = {
  args: { ...Initial.args, reply: 'conflict' },
};

const OTHER_PAIR = ProblemSchema.parse({ lhs: 6, rhs: 6 });

export const InitialOtherPair: Story = {
  args: {
    activity: numberLineActivity({ id: 'story_initial_other', revision: 0, templateId: 'initial_number_line', strategy: null, problem: OTHER_PAIR, spec: null }),
    phase: 'INITIAL',
    initial: OTHER_PAIR,
    voiceOff: false,
    reply: 'saved',
  },
};

export const AnchoredSupport: Story = {
  args: {
    activity: numberLineActivity({
      id: numberLineSupport.spec.activityId,
      revision: numberLineSupport.spec.revision,
      templateId: 'anchor_start_number_line',
      strategy: 'anchor_start',
      problem: FILM_INITIAL,
      spec: numberLineSupport.spec,
    }),
    phase: 'PRACTICE',
    initial: FILM_INITIAL,
    voiceOff: false,
    reply: 'saved',
  },
};

export const Retry: Story = {
  args: {
    activity: numberLineActivity({ id: 'story_retry', revision: 1, templateId: 'manipulation_retry', strategy: 'retry', problem: FILM_INITIAL, spec: null }),
    phase: 'PRACTICE',
    initial: FILM_INITIAL,
    voiceOff: false,
    reply: 'saved',
  },
};

const independentActivity = numberLineActivity({
  id: numberLineIndependent.spec.activityId,
  revision: numberLineIndependent.spec.revision,
  templateId: 'independent_number_line',
  strategy: null,
  problem: FILM_INDEPENDENT,
  spec: numberLineIndependent.spec,
});

export const Independent: Story = {
  args: { activity: independentActivity, phase: 'VERIFY', initial: FILM_INITIAL, voiceOff: false, reply: 'saved' },
};

export const IndependentVoiceOff: Story = {
  args: { ...Independent.args, voiceOff: true },
};
