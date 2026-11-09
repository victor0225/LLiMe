import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { ACTIVITY_COPY, OUTCOME_COPY, STUDENT_COPY } from '@core/copy';
import type { Problem } from '@core/domain';
import { createEventStore } from '../web/lib/event-store';
import { Explanation, Thinking, learningCommandSender, type VoiceControls } from '../web/student/Explanation';
import type { VoiceView } from '../web/voice';
import { ConnectionNotice } from '../web/student/Outcome';

// Story fixtures: a synthetic problem and answer, and voice states as the voice client would report
// them. No story opens a microphone or a provider session.
const problem: Problem = { lhs: 8, rhs: 5 };
const answer = 12;
const STORY_RUN_ID = 'story-run';

// Commands go through the app's own run queue. Without a server behind Storybook they fail visibly;
// browser checks answer them at the HTTP boundary.
const postStoryCommand = learningCommandSender(createEventStore(STORY_RUN_ID));

// Voice controls only record which control was pressed; the fixture state never changes on a press,
// exactly as the real client changes state only when the session does.
const voiceControlCalls: string[] = [];
Object.assign(globalThis, { storyVoiceControlCalls: voiceControlCalls });
const voiceControls: VoiceControls = {
  start: async () => {
    voiceControlCalls.push('start');
  },
  toggleMute: () => {
    voiceControlCalls.push('toggle_mute');
  },
  end: async () => {
    voiceControlCalls.push('end');
  },
  interruptPlayback: () => {
    voiceControlCalls.push('interrupt_playback');
  },
};

// Voice states as the voice client reports them.
const voice = (state: Partial<VoiceView>): VoiceView => ({
  phase: 'live',
  status: 'listening',
  isMuted: false,
  captions: { input: '', output: '' },
  typedEntries: [],
  failure: null,
  voiceSessionId: 'story-voice-session',
  ...state,
});
const tutorQuestion = 'How did you get twelve?';
const longExplanation =
  'I started with eight and called that one, then nine was two, ten was three, eleven was four, and twelve was five. I think I counted the number I started on, so I said twelve, but maybe I should have moved first and then counted, like nine is one, ten is two, eleven is three, twelve is four, thirteen is five. Supercalifragilisticexpialidociouslylongwordwithoutanyspacesatall.';

// The student page canvas the app provides around these screens.
export function StudentPage({ children }: { children: ReactNode }) {
  return <main style={{ minHeight: '100vh', background: 'var(--p-background)', color: 'var(--p-text)', fontFamily: 'var(--p-font)' }}>{children}</main>;
}

const explanation = (state: { voice: VoiceView | null; askFirstNumber?: boolean; question?: string; intro?: string | null; canSend?: boolean }) => (
  <Explanation
    question={state.question ?? STUDENT_COPY.howDidYouGet(answer)}
    problem={problem}
    answer={answer}
    voice={state.voice}
    voiceControls={voiceControls}
    send={postStoryCommand}
    canSend={state.canSend ?? true}
    askFirstNumber={state.askFirstNumber ?? false}
    intro={state.intro ?? null}
  />
);

const meta = {
  title: 'Student/Explain',
  // StudentPage is shared with the other explain story files, not a story.
  excludeStories: ['StudentPage'],
  decorators: [(Story) => <StudentPage>{Story()}</StudentPage>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const EnableVoice: Story = { render: () => explanation({ voice: voice({ phase: 'idle', status: null, voiceSessionId: null }) }) };
export const Connecting: Story = { render: () => explanation({ voice: voice({ phase: 'connecting', status: null }) }) };
export const Listening: Story = {
  render: () => explanation({ voice: voice({ captions: { output: tutorQuestion, input: 'I counted eight, nine, ten' } }) }),
};
export const TutorSpeaking: Story = { render: () => explanation({ voice: voice({ status: 'speaking', captions: { output: tutorQuestion, input: '' } }) }) };
export const MicOff: Story = { render: () => explanation({ voice: voice({ isMuted: true, status: 'muted', captions: { output: tutorQuestion, input: '' } }) }) };
export const LongCaption: Story = { render: () => explanation({ voice: voice({ captions: { output: tutorQuestion, input: longExplanation } }) }) };
export const VoiceEnded: Story = { render: () => explanation({ voice: voice({ phase: 'ended', status: 'off', voiceSessionId: null }) }) };
export const Disconnected: Story = { render: () => explanation({ voice: voice({ phase: 'failed', status: 'disconnected', failure: 'connection', voiceSessionId: null }) }) };
export const MicrophoneDenied: Story = { render: () => explanation({ voice: voice({ phase: 'failed', status: 'disconnected', failure: 'permission', voiceSessionId: null }) }) };
export const TypedOnly: Story = { render: () => explanation({ voice: null }) };

export const ThinkingWithVoice: Story = {
  render: () => <Thinking isUpdating={false} problem={problem} answer={answer} voice={voice({})} voiceControls={voiceControls} send={postStoryCommand} canSend />,
};
export const ActivityUpdating: Story = {
  render: () => <Thinking isUpdating problem={problem} answer={answer} voice={voice({})} voiceControls={voiceControls} send={postStoryCommand} canSend />,
};

export const ClarifyFirstNumber: Story = {
  render: () => explanation({ voice: voice({}), askFirstNumber: true, question: ACTIVITY_COPY.clarify_first_number(problem).title }),
};
export const ClarifyShowSteps: Story = {
  render: () => explanation({ voice: voice({}), question: ACTIVITY_COPY.clarify_show_steps(problem).title }),
};
export const ContinueAfterSupport: Story = {
  render: () => explanation({ voice: null, intro: OUTCOME_COPY.notSuccessful }),
};

export const ConnectionPaused: Story = {
  render: () => (
    <>
      <ConnectionNotice saveUnconfirmed={false} />
      {explanation({ voice: null, canSend: false })}
    </>
  ),
};
export const ConnectionCheckingSave: Story = {
  render: () => (
    <>
      <ConnectionNotice saveUnconfirmed />
      {explanation({ voice: null, canSend: false })}
    </>
  ),
};
