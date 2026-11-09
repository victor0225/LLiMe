import type { Meta, StoryObj } from '@storybook/react-vite';
import { INVITATION_COPY } from '../src/copy';
import type { RunPhase } from '../src/domain';
import { type RunSnapshot, RunSnapshotSchema } from '../src/events';
import { HttpErrorSchema, ROUTES, routePath } from '../src/routes';
import { createEventStore, type EventStore } from '../web/lib/event-store';
import { DeferredInvitation } from '../web/student/Invitation';
import { StudentApp } from '../web/student/StudentApp';

const RUN_ID = 'story-run';
const AT = '2026-11-09T09:00:00.000Z';

// A synthetic run in the given phase, parsed by the same schema as the server's snapshot.
function storyRun(phase: RunPhase, invitationBody: string | null = null): RunSnapshot {
  const isAfterLesson = phase !== 'WAITING';
  const selected = invitationBody === null ? null : { initial: { lhs: 8, rhs: 5 }, independent: { lhs: 9, rhs: 4 } };
  return RunSnapshotSchema.parse({
    id: RUN_ID,
    revision: invitationBody === null ? 0 : 2,
    seq: 0,
    execution: { throughSeq: 0, events: [] },
    phase,
    stopped: false,
    studentId: 'student_7',
    corpusHash: 'synthetic-corpus-hash',
    matchingVersion: 'typed-path-v1',
    seed: 7,
    lessonProblems: selected ? [{ lhs: 7, rhs: 4 }] : null,
    selectedProblems: selected,
    explanationRevision: 0,
    cancellationEpoch: 0,
    clarificationRounds: 0,
    interventionCount: 0,
    continuationAllowed: false,
    runtime: null,
    lesson: isAfterLesson ? { contentHash: 'synthetic-lesson-hash', text: 'Synthetic lesson.', source: 'local_file', savedAt: AT } : null,
    invitation:
      invitationBody === null
        ? null
        : {
            id: 'activity-invitation',
            revision: 0,
            runId: RUN_ID,
            kind: 'invitation',
            templateId: 'invitation_addition',
            strategy: null,
            problem: { lhs: 8, rhs: 5 },
            title: INVITATION_COPY.title,
            body: invitationBody,
            primaryLabel: INVITATION_COPY.accept,
            secondaryLabel: INVITATION_COPY.later,
            activitySpec: null,
            specHash: null,
            helperCount: 0,
            evidenceIds: ['seed_7_0'],
            decisionSummary: 'Synthetic story invitation.',
          },
    activity: null,
    attempts: [],
    explanation: null,
    graph: null,
    search: null,
    error: null,
    createdAt: AT,
  });
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const pathOf = (input: RequestInfo | URL) => new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;

// The run's store answered from fixtures. `run: null` keeps the first snapshot pending; `offline`
// makes polling fail after the snapshot loaded. Commands are refused: stories never change a run.
function storyStore(run: RunSnapshot | null, { offline = false } = {}): EventStore {
  const answer = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const path = pathOf(input);
    if (init?.method === 'POST') return json(HttpErrorSchema.parse({ code: 'RUNTIME_DISCONNECTED', message: 'Stories do not change a run', retryable: false }), 503);
    if (path === routePath('bootstrap')) return json(ROUTES.bootstrap.response.parse({ nonce: 'story', voice: 'missing_key', inputMode: 'typed', runtime: 'story', database: 'none', dataset: 'synthetic' }));
    if (path === routePath('getRun', { runId: RUN_ID })) return run ? json(ROUTES.getRun.response.parse(run)) : new Promise<Response>(() => {});
    if (path === routePath('runEvents', { runId: RUN_ID }) && !offline) return json(ROUTES.runEvents.response.parse([]));
    throw new TypeError('Failed to fetch');
  };
  return createEventStore(RUN_ID, { fetch: answer });
}

const meta = {
  title: 'Student/Invitation',
  component: StudentApp,
  parameters: {
    docs: {
      description: {
        component:
          'The student screen from the first snapshot to the invitation. Each story reads a synthetic run snapshot through the shared store; Let’s try is refused here because stories never change a run.',
      },
    },
  },
  args: { runId: RUN_ID },
} satisfies Meta<typeof StudentApp>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { store: storyStore(null) } };
export const Empty: Story = { args: { store: storyStore(storyRun('WAITING')) } };
export const Preparing: Story = { args: { store: storyStore(storyRun('INGESTING')) } };
export const LinkedConcept: Story = { args: { store: storyStore(storyRun('INVITED', INVITATION_COPY.bodyLinkedConcept)) } };
export const SameConcept: Story = { args: { store: storyStore(storyRun('INVITED', INVITATION_COPY.bodySameConcept)) } };
export const Disconnected: Story = { args: { store: storyStore(storyRun('INVITED', INVITATION_COPY.bodyLinkedConcept), { offline: true }) } };
// After Later; Try the activity returns to the same invitation inside the app.
export const Deferred: Story = {
  render: () => (
    <div className="student-app">
      <main className="student-workspace">
        <DeferredInvitation onReturn={() => {}} />
      </main>
    </div>
  ),
};
