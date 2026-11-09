// Child- and teacher-facing copy. The server owns every word a child sees or hears; models choose
// structure only. Operands are substituted from a validated activity or problem, never from model text.
// Isomorphic: shared by the server, the web app and stories.
import type { Problem, TemplateId } from './domain.js';

const sum = (p: Problem) => `${p.lhs} + ${p.rhs}`;
const question = (p: Problem) => `${sum(p)} = ?`;

// The invitation names no strategy: the strategy is chosen later, from the child's own attempt.
export const INVITATION_COPY = {
  title: 'A little challenge for you',
  // Used only when at least one cited memory case is on a linked concept (subtraction history).
  bodyLinkedConcept: 'Remember taking things away in subtraction? Today, let’s put things together with addition. Want to try?',
  bodySameConcept: 'We’ve tried this before. Want to explore it some more?',
  accept: 'Let’s try',
  later: 'Later',
  deferred: 'Okay. Come back when you’re ready.',
  returnToActivity: 'Try the activity',
} as const;

// Outcome screens. Each states only what was observed.
export const OUTCOME_COPY = {
  completeTitle: 'You solved a new problem without help.',
  completeBody: 'Nice work. That’s enough for today.',
  answerRightStepsMissing: 'Your answer is right. We still need to see the steps another time.',
  notSuccessful: 'Let’s check what happened.',
  supportLimit: 'Let’s pause here. We can try another time.',
} as const;

export type ActivityCopy = { title: string; body: string; primaryLabel: string; secondaryLabel: string | null };

const CHECK_ANSWER = 'Check my answer';
const SEND_EXPLANATION = 'Send explanation';

// Copy for every non-invitation template, built from the activity's own problem.
export const ACTIVITY_COPY: { readonly [T in Exclude<TemplateId, 'invitation_addition'>]: (problem: Problem) => ActivityCopy } = {
  initial_number_line: (p) => ({ title: `Show ${sum(p)} on the number line.`, body: question(p), primaryLabel: CHECK_ANSWER, secondaryLabel: null }),
  anchor_start_number_line: (p) => ({ title: `${p.lhs} is the starting point. Count once each time you move.`, body: question(p), primaryLabel: CHECK_ANSWER, secondaryLabel: null }),
  make_ten_blocks: (p) => ({ title: 'Fill the box to ten. Then count what’s left.', body: question(p), primaryLabel: CHECK_ANSWER, secondaryLabel: null }),
  manipulation_retry: (p) => ({ title: 'Let’s try the taps again.', body: question(p), primaryLabel: CHECK_ANSWER, secondaryLabel: null }),
  clarify_first_number: (p) => ({ title: 'Can you show the first number you counted?', body: question(p), primaryLabel: SEND_EXPLANATION, secondaryLabel: null }),
  // Never names or hints at a proposed pattern.
  clarify_show_steps: (p) => ({ title: 'Can you show me how you got your answer?', body: question(p), primaryLabel: SEND_EXPLANATION, secondaryLabel: null }),
  independent_number_line: (p) => ({ title: 'Now try a new one on your own.', body: `Show ${sum(p)}. Mark where you start, then show your moves.`, primaryLabel: CHECK_ANSWER, secondaryLabel: null }),
  independent_make_ten: (p) => ({ title: 'Now make ten on your own.', body: question(p), primaryLabel: CHECK_ANSWER, secondaryLabel: null }),
  // States only the observed new-task performance; retention stays pending and is not claimed.
  completion: () => ({ title: OUTCOME_COPY.completeTitle, body: OUTCOME_COPY.completeBody, primaryLabel: 'Done', secondaryLabel: null }),
};

// Text sent through the ordinary explain command when the child picks a number in clarify_first_number.
export const firstNumberSelected = (n: number) => `First number selected: ${n}.`;

export const STUDENT_COPY = {
  waitingTitle: 'Ready when you are.',
  waitingBody: 'Your next activity will appear here.',
  preparing: 'Getting an activity ready…',
  // The question after a wrong initial answer names the child's own submitted answer.
  howDidYouGet: (answer: number) => `How did you get ${answer}?`,
  explanationLabel: 'Tell me how you worked it out.',
  sendExplanation: SEND_EXPLANATION,
  interpreting: 'Thanks. Let’s look at your way.',
  checkAnswer: CHECK_ANSWER,
  startAt: (start: number) => `Start at ${start}`,
  moveForward: 'Move one step forward',
  moveBack: 'Move one step back',
  resetMoves: 'Reset current moves',
  draftReset: 'This unfinished try was reset.',
  putInBox: 'Put in the box',
  putToSide: 'Put to the side',
  yourAnswer: 'Your answer',
  activityOpenFailed: 'This activity could not be opened. Your previous work has not changed.',
  stopLearning: 'Stop learning',
  disconnected: 'Connection paused. Your work is saved.',
  checkingSave: 'Checking whether your work was saved…',
  runtimeError: 'I couldn’t finish getting your next activity.',
  startNewRun: 'Start a new run',
  pause: 'Pause',
  doneCollapsed: 'See you next time.',
} as const;

// The OS notification after an invitation commits. It carries no transcript, explanation or diagnosis.
export const NOTIFICATION_COPY = {
  title: 'llime',
  body: 'A quick challenge from today\'s lesson?',
} as const;

export const VOICE_STATUS_COPY = {
  listening: 'Listening to you',
  speaking: 'Your tutor is speaking',
  thinking: 'Finding a helpful next step',
  disconnected: 'Connection lost',
  muted: 'Microphone muted',
  // Shown only after microphone and playback were actually torn down for the independent check.
  off: 'Voice is off for this challenge.',
} as const;

export const VOICE_CONTROL_COPY = {
  enable: 'Enable voice',
  mute: 'Mute',
  end: 'End voice',
  typeInstead: 'Type instead',
} as const;

// The only content the app sends to the Live session for speaking; Live may paraphrase it lightly.
export const SPOKEN_COPY = {
  howDidYouGet: STUDENT_COPY.howDidYouGet,
  clarifyFirstNumber: 'Which number did you count first?',
  clarifyShowSteps: 'Can you show me how you got your answer?',
  makeTenIntroduction: 'Let\'s try it with a ten-box. Fill the box with apples, then see what\'s left.',
  independentHandover: 'Here\'s a new one. I\'ll stay quiet this time.',
} as const;

// Teacher-facing class-end screen that saves the lesson transcript.
export const LESSON_NOTES_COPY = {
  title: 'Lesson notes',
  header: 'llime · Lesson notes',
  classLabel: 'Grade 2 math · Addition within 20',
  loadFile: 'Load .txt file',
  usePrepared: 'Use prepared transcript',
  readyPrompt: 'Load today\'s lesson transcript to get started.',
  readyFooter: 'Review the transcript, then finish the lesson.',
  transcriptHeading: 'Transcript',
  loadedMeta: (lines: number, kb: string, source: string) => `${lines} lines · ${kb} of 16 KB · ${source}`,
  preparedSourceLabel: 'prepared synthetic transcript',
  loadedFooter: 'llime starts when you finish the lesson.',
  finish: 'Finish lesson',
  saving: 'Saving…',
  startedHeading: 'Thanks! I’ve got today’s lesson.',
  startedBody: 'I’m connecting it to what we learned before. A next step will be ready soon.',
  saveFailed: 'Couldn\'t save. Your transcript is still here.',
  retrySave: 'Try saving again',
  preparedUnavailable: 'Prepared transcript unavailable. Load a .txt file.',
  notTextFile: 'Choose a .txt file.',
  fileTooLarge: 'This file is larger than 16 KB.',
  notUtf8: 'This file isn\'t plain UTF-8 text.',
  textTooLarge: 'Shorten the transcript to 16 KB or less.',
} as const;
