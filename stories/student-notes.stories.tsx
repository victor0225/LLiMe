import type { Meta, StoryObj } from '@storybook/react-vite';
import { ROUTES } from '../src/routes';
import preparedText from '../data/lesson/lesson-transcript.txt?raw';
import lessonManifest from '../data/lesson/manifest.json';
import { LessonNotesScreen } from '../web/notes/LessonNotes';

// The status the lesson route serves before anything was saved, parsed like a real response.
const lessonStatus = ROUTES.getLesson.response.parse({
  inboxFile: '/llime/.runtime/inbox/story-run/lesson.txt',
  saved: false,
  contentHash: null,
  prepared: { text: preparedText, sha256: lessonManifest.sha256 },
});
const prepared = lessonStatus.prepared?.text ?? null;

// Stories never reach the server: saving resolves locally, fails, or never answers.
const saved = () => Promise.resolve();
const failed = () => Promise.reject(new Error('The story has no server'));
const pending = () => new Promise<void>(() => {});

const meta = {
  title: 'Class/Lesson notes',
  component: LessonNotesScreen,
  parameters: {
    docs: {
      description: {
        component:
          'The class-end screen on the iPad. Start and Stop frame the class without capturing audio; Stop reveals the prepared transcript and Finish lesson saves it. In these stories saving stays local.',
      },
    },
  },
  args: { prepared, save: saved },
} satisfies Meta<typeof LessonNotesScreen>;
export default meta;

type Story = StoryObj<typeof meta>;

export const Ready: Story = {};
export const Recording: Story = { args: { initialPhase: 'recording', initialSeconds: 83 } };
export const Stopped: Story = { args: { initialPhase: 'stopped', initialSeconds: 125 } };
export const Saving: Story = { args: { initialPhase: 'saving', initialSeconds: 125, save: pending } };
export const Started: Story = { args: { initialPhase: 'started' } };
export const SaveFailed: Story = { args: { initialPhase: 'saveFailed', initialSeconds: 125, save: failed } };
export const PreparedUnavailable: Story = { args: { initialPhase: 'stopped', initialSeconds: 125, prepared: null } };
