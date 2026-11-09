import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { Mascot, type MascotState } from '../web/student/Mascot';
import { EMPTY_DRAFT, NumberLine, type NumberLineDraft } from '../web/student/NumberLine';
import { VoiceStatus, type VoiceControls } from '../web/student/Explanation';
import type { VoiceView } from '../web/voice';
import { StudentPage } from './student-explain.stories';

// Fixtures only: voice states as the voice client reports them, and number-line drafts held locally.
// No story opens a microphone, a provider session or a server request.
const voiceControls: VoiceControls = { start: async () => {}, toggleMute: () => {}, end: async () => {}, interruptPlayback: () => {} };
const voice = (state: Partial<VoiceView>): VoiceView => ({
  phase: 'live',
  status: 'listening',
  isMuted: false,
  captions: { input: '', output: '' },
  typedEntries: [],
  failure: null,
  voiceSessionId: 'fixture-voice-session',
  ...state,
});

function NumberLineFixture({ startMarker, showMoveCount }: { startMarker: number | null; showMoveCount: boolean }) {
  const [draft, setDraft] = useState<NumberLineDraft>(EMPTY_DRAFT);
  return <NumberLine draft={draft} onDraftChange={setDraft} startMarker={startMarker} showMoveCount={showMoveCount} disabled={false} />;
}

const meta = {
  title: 'Student/Components',
  decorators: [(Story) => <StudentPage>{Story()}</StudentPage>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const VoiceStatusListening: Story = { render: () => <VoiceStatus voice={voice({})} controls={voiceControls} offerStart /> };
export const VoiceStatusSpeaking: Story = { render: () => <VoiceStatus voice={voice({ status: 'speaking' })} controls={voiceControls} offerStart /> };
export const VoiceStatusMuted: Story = { render: () => <VoiceStatus voice={voice({ isMuted: true, status: 'muted' })} controls={voiceControls} offerStart /> };
export const VoiceStatusDisconnected: Story = {
  render: () => <VoiceStatus voice={voice({ phase: 'failed', status: 'disconnected', failure: 'connection', voiceSessionId: null })} controls={voiceControls} offerStart />,
};
export const VoiceStatusOffForIndependentCheck: Story = {
  render: () => <VoiceStatus voice={voice({ phase: 'ended', status: 'off', voiceSessionId: null })} controls={voiceControls} offerStart={false} />,
};
export const NumberLinePlain: Story = { render: () => <NumberLineFixture startMarker={null} showMoveCount={false} /> };
export const NumberLineAnchoredSupport: Story = { render: () => <NumberLineFixture startMarker={8} showMoveCount /> };
const MASCOT_STATES: readonly MascotState[] = ['idle', 'welcome', 'listening', 'thinking', 'encouragement'];
export const MascotPoses: Story = {
  render: () => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--p-space-2)', padding: 'var(--p-space-2)' }}>
      {MASCOT_STATES.map((state) => (
        <Mascot key={state} state={state} size={140} />
      ))}
    </div>
  ),
};
