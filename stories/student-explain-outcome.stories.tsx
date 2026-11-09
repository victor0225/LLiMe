import type { Meta, StoryObj } from '@storybook/react-vite';
import { ACTIVITY_COPY } from '@core/copy';
import { ActivityUnavailable, CorrectionClosed, Outcome, type OutcomeView } from '../web/student/Outcome';
import { createRun } from '../web/student/StudentApp';
import { StudentPage } from './student-explain.stories';

// Creates a run as the student app does; stories stay on the page instead of opening it.
export async function createStoryRun(): Promise<void> {
  await createRun();
}

const outcome = (view: OutcomeView) => <Outcome view={view} startNewRun={createStoryRun} />;

const meta = {
  title: 'Student/Outcome',
  excludeStories: ['createStoryRun'],
  decorators: [(Story) => <StudentPage>{Story()}</StudentPage>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Complete: Story = { render: () => outcome({ kind: 'complete' }) };
export const Assisted: Story = { render: () => outcome({ kind: 'assisted' }) };
export const AnswerRightStepsMissing: Story = { render: () => outcome({ kind: 'answer_right_steps_missing' }) };
export const NotSuccessful: Story = { render: () => outcome({ kind: 'not_successful' }) };
export const SupportLimit: Story = { render: () => outcome({ kind: 'support_limit', askTrustedAdult: false }) };
export const SupportLimitAskAdult: Story = { render: () => outcome({ kind: 'support_limit', askTrustedAdult: true }) };
export const CheckingSave: Story = { render: () => outcome({ kind: 'checking' }) };
export const RuntimeError: Story = { render: () => outcome({ kind: 'runtime_error' }) };
export const Stopped: Story = { render: () => outcome({ kind: 'stopped' }) };
export const ActivityUnavailableToOpen: Story = { render: () => <ActivityUnavailable /> };
// Shown inside a practice screen after its attempt was submitted; the heading stands for that screen.
export const CorrectionNeedsNewRun: Story = {
  render: () => (
    <div style={{ maxWidth: 1160, margin: '0 auto', padding: 'var(--p-space-4) var(--p-space-2)' }}>
      <h1>{ACTIVITY_COPY.make_ten_blocks({ lhs: 8, rhs: 5 }).title}</h1>
      <CorrectionClosed startNewRun={createStoryRun} />
    </div>
  ),
};
