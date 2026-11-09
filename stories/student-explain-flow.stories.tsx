import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo } from 'react';
import { createEventStore } from '../web/lib/event-store';
import { ExplainFlow, type VoiceControlsStub } from '../web/student/Explanation';
import { createStoryRun } from './student-explain-outcome.stories';
import { StudentPage } from './student-explain.stories';

// This flow runs without voice, so no control is ever offered.
const noVoiceControls: VoiceControlsStub = {
  enable: () => {},
  setMuted: () => {},
  end: () => {},
  reconnect: () => {},
};

// The explanation flow on a server run: the snapshot, polled events and commands all go through the
// app's event store, so browser checks drive it only by answering HTTP.
function ServerRun({ runId }: { runId: string }) {
  const store = useMemo(() => createEventStore(runId), [runId]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  return <ExplainFlow store={store} voice={null} voiceControls={noVoiceControls} startNewRun={createStoryRun} />;
}

const meta = {
  title: 'Student/Explain flow',
  component: ServerRun,
  args: { runId: 'story-run' },
  decorators: [(Story) => <StudentPage>{Story()}</StudentPage>],
} satisfies Meta<typeof ServerRun>;
export default meta;

export const FromServer: StoryObj<typeof meta> = {};
