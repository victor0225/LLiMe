import type { Meta, StoryObj } from '@storybook/react-vite';
import { useEffect, useMemo } from 'react';
import { createEventStore } from '../web/lib/event-store';
import { ExplainFlow, type VoiceControls } from '../web/student/Explanation';
import { browserVoiceEnv, createVoiceClient, eventStoreVoiceApi, useVoice } from '../web/voice';
import { createStoryRun } from './student-explain-outcome.stories';
import { StudentPage } from './student-explain.stories';

// Without voice no control is ever offered, so these are never pressed.
const noVoiceControls: VoiceControls = {
  start: async () => {},
  toggleMute: () => {},
  end: async () => {},
  interruptPlayback: () => {},
};

function useServerRun(runId: string) {
  const store = useMemo(() => createEventStore(runId), [runId]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  return store;
}

// The explanation flow on a server run: the snapshot, polled events and commands all go through the
// app's event store, so browser checks drive it only by answering HTTP.
function ServerRun({ runId }: { runId: string }) {
  const store = useServerRun(runId);
  return <ExplainFlow store={store} voice={null} voiceControls={noVoiceControls} startNewRun={createStoryRun} />;
}

// The same flow with the real browser voice client, so microphone permission and session requests
// are the browser's and the server's own.
function ServerRunWithVoice({ runId }: { runId: string }) {
  const store = useServerRun(runId);
  const client = useMemo(() => createVoiceClient({ env: browserVoiceEnv(), api: eventStoreVoiceApi(store, runId) }), [store, runId]);
  const voice = useVoice(client);
  return <ExplainFlow store={store} voice={voice} voiceControls={client} startNewRun={createStoryRun} />;
}

const meta = {
  title: 'Student/Explain flow',
  component: ServerRun,
  args: { runId: 'story-run' },
  decorators: [(Story) => <StudentPage>{Story()}</StudentPage>],
} satisfies Meta<typeof ServerRun>;
export default meta;

export const FromServer: StoryObj<typeof meta> = {};
export const FromServerWithVoice: StoryObj<typeof meta> = { render: (args) => <ServerRunWithVoice {...args} /> };
