import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState, type ReactNode } from 'react';
import type { MakeTenAttempt } from '../src/domain';
import { countHelpers } from '../src/ui/activity-catalog';
import { type ActivityFixture, makeTenIndependent, makeTenSupport } from '../src/ui/activity-fixtures';
import { MakeTenWorkspace } from '../web/student/MakeTenWorkspace';

// The ten-box workspace on its own, with the derived fixtures' props. Submitted attempts are only
// written to the story log; nothing is sent.
function Workspace({ fixture }: { fixture: ActivityFixture }): ReactNode {
  const [sent, setSent] = useState<MakeTenAttempt[]>([]);
  const workspace = fixture.spec.components.find((component) => component.type === 'MakeTenWorkspace');
  return (
    <main className="story-frame" style={{ padding: 'var(--p-space-2)', fontFamily: 'var(--p-font)' }}>
      <h1 style={{ fontSize: 'var(--p-font-small)', color: 'var(--p-muted)' }}>Make ten workspace · story fixture, synthetic, nothing is sent</h1>
      {workspace?.type === 'MakeTenWorkspace' ? (
        <MakeTenWorkspace spec={workspace.props} hints={countHelpers(fixture.spec)} draftKey={`story-${fixture.context.activityId}`} onSubmit={(attempt) => setSent((all) => [...all, attempt])} />
      ) : null}
      <section aria-label="Story log">
        <ol>
          {sent.map((attempt, index) => (
            <li key={index} data-log-kind="submit">
              <code>{JSON.stringify(attempt)}</code>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

const meta = { title: 'Student/MakeTen workspace', component: Workspace } satisfies Meta<typeof Workspace>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Support: Story = { args: { fixture: makeTenSupport } };
export const Independent: Story = { args: { fixture: makeTenIndependent } };
