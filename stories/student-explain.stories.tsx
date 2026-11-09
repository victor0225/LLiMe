import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactNode } from 'react';
import { ACTIVITY_COPY, OUTCOME_COPY, STUDENT_COPY } from '@core/copy';
import { ActivitySchema, type Problem } from '@core/domain';
import { routePath } from '@core/routes';
import {
  Explanation,
  RetryIntro,
  Thinking,
  type LearningCommandRequest,
  type VoiceControlsStub,
  type VoiceStateStub,
} from '../web/student/Explanation';
import { ConnectionNotice } from '../web/student/Outcome';

// Story fixtures: a synthetic problem and answer, and voice states as the voice client would report
// them. No story opens a microphone or a provider session.
const problem: Problem = { lhs: 8, rhs: 5 };
const answer = 12;
const STORY_RUN_ID = 'story-run';

// Stories have no run of their own. Each command is posted the way the app's queue sends it, so
// browser checks read the exact body at the HTTP boundary.
async function postStoryCommand(command: LearningCommandRequest): Promise<void> {
  const response = await fetch(routePath('runCommand', { runId: STORY_RUN_ID }), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...command, commandId: crypto.randomUUID(), revision: 0 }),
  });
  if (!response.ok) throw new Error(`The command was not accepted (HTTP ${response.status})`);
}

// Voice controls only record which control was pressed; the fixture state never changes on a press,
// exactly as a real client changes state only when the session does.
const voiceControlCalls: string[] = [];
Object.assign(globalThis, { storyVoiceControlCalls: voiceControlCalls });
const voiceControls: VoiceControlsStub = {
  enable: () => voiceControlCalls.push('enable'),
  setMuted: (muted) => voiceControlCalls.push(muted ? 'mute' : 'unmute'),
  end: () => voiceControlCalls.push('end'),
  reconnect: () => voiceControlCalls.push('reconnect'),
};

const voice = (state: Partial<VoiceStateStub>): VoiceStateStub => ({
  session: 'live',
  microphone: 'on',
  tutorSpeaking: false,
  inputCaption: '',
  outputCaption: '',
  ...state,
});
const tutorQuestion = 'How did you get twelve?';
const longExplanation =
  'I started with eight and called that one, then nine was two, ten was three, eleven was four, and twelve was five. I think I counted the number I started on, so I said twelve, but maybe I should have moved first and then counted, like nine is one, ten is two, eleven is three, twelve is four, thirteen is five. Supercalifragilisticexpialidociouslylongwordwithoutanyspacesatall.';

function Page({ children }: { children: ReactNode }) {
  return <main className="story-student-page">{children}</main>;
}

const explanation = (state: { voice: VoiceStateStub | null; askFirstNumber?: boolean; question?: string; intro?: string | null; canSend?: boolean }) => (
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
  decorators: [(Story) => <Page>{Story()}</Page>],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const EnableVoice: Story = { render: () => explanation({ voice: voice({ session: 'off' }) }) };
export const Connecting: Story = { render: () => explanation({ voice: voice({ session: 'connecting' }) }) };
export const Listening: Story = {
  render: () => explanation({ voice: voice({ outputCaption: tutorQuestion, inputCaption: 'I counted eight, nine, ten' }) }),
};
export const TutorSpeaking: Story = { render: () => explanation({ voice: voice({ tutorSpeaking: true, outputCaption: tutorQuestion }) }) };
export const MicOff: Story = { render: () => explanation({ voice: voice({ microphone: 'muted', outputCaption: tutorQuestion }) }) };
export const LongCaption: Story = { render: () => explanation({ voice: voice({ outputCaption: tutorQuestion, inputCaption: longExplanation }) }) };
export const Reconnecting: Story = { render: () => explanation({ voice: voice({ session: 'reconnecting', outputCaption: tutorQuestion }) }) };
export const Disconnected: Story = { render: () => explanation({ voice: voice({ session: 'disconnected' }) }) };
export const MicrophoneDenied: Story = { render: () => explanation({ voice: voice({ session: 'off', microphone: 'denied' }) }) };
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

const retryActivity = ActivitySchema.parse({
  id: 'story_activity_retry',
  revision: 2,
  runId: STORY_RUN_ID,
  kind: 'retry',
  templateId: 'manipulation_retry',
  strategy: 'retry',
  problem,
  ...ACTIVITY_COPY.manipulation_retry(problem),
  activitySpec: null,
  specHash: null,
  helperCount: 0,
  evidenceIds: [],
  decisionSummary: '',
});
// The number-line practice mounts in this slot in the app; the story shows only where it goes.
export const RetryIntroduction: Story = {
  render: () => (
    <div className="story-wide">
      <RetryIntro activity={retryActivity}>
        <div className="story-practice-slot" aria-hidden="true" />
      </RetryIntro>
    </div>
  ),
};
