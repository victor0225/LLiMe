import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';
import { z } from 'zod';
import { loadConfig } from '../../src/config.js';
import { LESSON_NOTES_COPY } from '../../src/copy.js';
import { RunSnapshotSchema } from '../../src/events.js';
import { HttpErrorSchema, LESSON_TEXT_MAX_BYTES, ROUTES, routePath, SESSION_HEADER, utf8ByteLength } from '../../src/routes.js';

// The lesson routes have no backend handler yet, so these checks answer them at the browser boundary
// with bodies parsed by the shared route schemas. The real save, watcher and file hash run on the iPad.
const RUN_ID = 'run-lesson-notes';
const NONCE = 'nonce-lesson-notes';
const LANDSCAPE = { width: 1194, height: 834 };
const PORTRAIT = { width: 834, height: 1194 };

const dataFile = (path: string) => new URL(`../../data/${path}`, import.meta.url);
const preparedTranscript = readFileSync(dataFile('lesson/lesson-transcript.txt'), 'utf8');
const lessonManifest = z.object({ sha256: z.string(), bytes: z.number() }).parse(JSON.parse(readFileSync(dataFile('lesson/manifest.json'), 'utf8')));
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const lessonPath = routePath('getLesson', { runId: RUN_ID });

type SaveReply = 'saved' | 'network-error' | 'hold';
type LessonStub = { posts: string[]; nonces: (string | undefined)[]; releaseHeldSave: () => void };

// The run before its lesson exists; the save queue reads it to learn the current revision.
const waitingRun = RunSnapshotSchema.parse({
  id: RUN_ID,
  revision: 0,
  seq: 0,
  execution: { throughSeq: 0, events: [] },
  phase: 'WAITING',
  stopped: false,
  studentId: 'student_7',
  corpusHash: 'synthetic-corpus-hash',
  matchingVersion: 'typed-path-v1',
  seed: 7,
  lessonProblems: null,
  selectedProblems: null,
  explanationRevision: 0,
  cancellationEpoch: 0,
  clarificationRounds: 0,
  interventionCount: 0,
  continuationAllowed: false,
  runtime: null,
  lesson: null,
  invitation: null,
  activity: null,
  attempts: [],
  explanation: null,
  graph: null,
  search: null,
  error: null,
  createdAt: '2026-11-09T09:00:00.000Z',
});

// Answers bootstrap and both lesson routes. `replies` is consumed one per save; the last one repeats.
async function stubLessonRoutes(page: Page, { prepared = preparedTranscript as string | null, saved = false, replies = ['saved'] as SaveReply[] } = {}): Promise<LessonStub> {
  const posts: string[] = [];
  const nonces: (string | undefined)[] = [];
  let release: () => void = () => {};
  let status = ROUTES.getLesson.response.parse({
    inboxFile: `/llime/.runtime/inbox/${RUN_ID}/lesson.txt`,
    saved,
    contentHash: saved && prepared !== null ? sha256(prepared) : null,
    prepared: prepared === null ? null : { text: prepared, sha256: sha256(prepared) },
  });
  const markSaved = (text: string) => {
    status = ROUTES.getLesson.response.parse({ ...status, saved: true, contentHash: sha256(text) });
  };
  await page.route(`**${routePath('getRun', { runId: RUN_ID })}`, (route) => route.fulfill({ json: ROUTES.getRun.response.parse(waitingRun) }));
  await page.route(`**${routePath('bootstrap')}`, (route) =>
    route.fulfill({ json: ROUTES.bootstrap.response.parse({ nonce: NONCE, voice: 'missing_key', inputMode: 'typed', runtime: 'codex-app-server', database: 'neo4j', dataset: 'seed-v7' }) }),
  );
  await page.route(`**${lessonPath}`, async (route: Route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: status });
    const { text } = ROUTES.saveLesson.request.parse(route.request().postDataJSON());
    posts.push(text);
    nonces.push(route.request().headers()[SESSION_HEADER]);
    const reply = replies[Math.min(posts.length - 1, replies.length - 1)];
    if (reply === 'network-error') return route.abort('failed');
    if (reply === 'hold') await new Promise<void>((resolve) => (release = resolve));
    markSaved(text);
    return route.fulfill({ status: ROUTES.saveLesson.status, json: ROUTES.saveLesson.response.parse({ saved: true, contentHash: sha256(text) }) });
  });
  return { posts, nonces, releaseHeldSave: () => release() };
}

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const finishButton = (page: Page) => button(page, LESSON_NOTES_COPY.finish);
const transcriptLines = (page: Page) => page.getByRole('list', { name: LESSON_NOTES_COPY.transcriptHeading }).getByRole('listitem');

async function openLessonNotes(page: Page) {
  await page.goto(`/lesson-notes?runId=${encodeURIComponent(RUN_ID)}`);
  await expect(button(page, LESSON_NOTES_COPY.startRecording)).toBeVisible();
}

async function recordAndStop(page: Page) {
  await button(page, LESSON_NOTES_COPY.startRecording).click();
  await button(page, LESSON_NOTES_COPY.stopRecording).click();
}

async function expectNoAxeViolations(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

// Browser-side snippets, kept as source text because the test project has no DOM types.
// Counts every microphone request instead of letting the browser prompt for one.
const COUNT_MICROPHONE_REQUESTS = `
  window.microphoneRequests = 0;
  navigator.mediaDevices.getUserMedia = () => {
    window.microphoneRequests += 1;
    return Promise.reject(new DOMException('Microphone use is not expected here', 'NotAllowedError'));
  };`;
// How far the page overflows the viewport, and which elements scroll their own content.
const MEASURE_PAGE_LAYOUT = `(() => {
  const page = document.documentElement;
  const scrollers = [...document.querySelectorAll('body *')].filter((element) => {
    const overflowY = getComputedStyle(element).overflowY;
    return (overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight;
  });
  return {
    horizontalOverflow: page.scrollWidth - page.clientWidth,
    verticalOverflow: page.scrollHeight - page.clientHeight,
    scrollers: scrollers.map((element) => element.tagName),
  };
})()`;

function textOfBytes(bytes: number): string {
  // Two-byte characters make the UTF-8 size larger than the string length, so a length check would pass.
  const head = `[00:00] Ms. Ortiz: ${'é'.repeat(4000)}`;
  return head + 'a'.repeat(bytes - utf8ByteLength(head));
}

for (const [orientation, viewport] of [['landscape', LANDSCAPE], ['portrait', PORTRAIT]] as const) {
  test.describe(`lesson notes, iPad ${orientation}`, () => {
    test.use({ viewport });

    test('Finish lesson is disabled in ready and recording (stubbed route)', async ({ page }) => {
      await stubLessonRoutes(page);
      await openLessonNotes(page);
      await expect(page.getByText(LESSON_NOTES_COPY.readyStatus)).toBeVisible();
      await expect(finishButton(page)).toBeDisabled();
      await button(page, LESSON_NOTES_COPY.startRecording).click();
      await expect(button(page, LESSON_NOTES_COPY.stopRecording)).toBeVisible();
      await expect(page.getByText(LESSON_NOTES_COPY.recordingPanel)).toBeVisible();
      await expect(finishButton(page)).toBeDisabled();
      await button(page, LESSON_NOTES_COPY.stopRecording).click();
      await expect(finishButton(page)).toBeEnabled();
    });

    test('the record control never requests microphone permission (stubbed route)', async ({ page }) => {
      await page.addInitScript({ content: COUNT_MICROPHONE_REQUESTS });
      const stub = await stubLessonRoutes(page);
      await openLessonNotes(page);
      await recordAndStop(page);
      await finishButton(page).click();
      await expect(page.getByRole('heading', { name: LESSON_NOTES_COPY.startedHeading })).toBeVisible();
      expect(stub.posts).toHaveLength(1);
      expect(await page.evaluate('window.microphoneRequests')).toBe(0);
    });

    test('saving the prepared transcript posts text whose UTF-8 SHA-256 equals data/lesson/manifest.json (stubbed route)', async ({ page }) => {
      const stub = await stubLessonRoutes(page);
      await openLessonNotes(page);
      await recordAndStop(page);
      await expect(page.getByText(LESSON_NOTES_COPY.loadedMeta(27, '2.2', LESSON_NOTES_COPY.preparedSourceLabel))).toBeVisible();
      await finishButton(page).click();
      await expect(page.getByRole('heading', { name: LESSON_NOTES_COPY.startedHeading })).toBeVisible();
      expect(stub.posts).toHaveLength(1);
      expect(sha256(stub.posts[0] ?? '')).toBe(lessonManifest.sha256);
      expect(utf8ByteLength(stub.posts[0] ?? '')).toBe(lessonManifest.bytes);
      expect(stub.nonces).toEqual([NONCE]);
    });

    test('16384 bytes is accepted and 16385 is blocked, counting multi-byte characters by UTF-8 bytes (stubbed route)', async ({ page }) => {
      const atLimit = textOfBytes(LESSON_TEXT_MAX_BYTES);
      const overLimit = textOfBytes(LESSON_TEXT_MAX_BYTES + 1);
      expect(atLimit.length).toBeLessThan(LESSON_TEXT_MAX_BYTES);
      expect(overLimit.length).toBeLessThan(LESSON_TEXT_MAX_BYTES);

      // Shown text over the limit cannot be saved.
      await stubLessonRoutes(page, { prepared: overLimit });
      await openLessonNotes(page);
      await recordAndStop(page);
      await expect(page.getByText(LESSON_NOTES_COPY.textTooLarge)).toBeVisible();
      await expect(finishButton(page)).toBeDisabled();

      // Shown text at the limit saves as is.
      await page.unrouteAll();
      const stub = await stubLessonRoutes(page, { prepared: atLimit });
      await openLessonNotes(page);
      await recordAndStop(page);
      await expect(finishButton(page)).toBeEnabled();

      // A loaded file over the limit is refused; one at the limit replaces the transcript.
      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles({ name: 'too-long.txt', mimeType: 'text/plain', buffer: Buffer.from(overLimit, 'utf8') });
      await expect(page.getByRole('alert')).toHaveText(LESSON_NOTES_COPY.fileTooLarge);
      await fileInput.setInputFiles({ name: 'at-limit.txt', mimeType: 'text/plain', buffer: Buffer.from(atLimit, 'utf8') });
      await expect(page.getByText(LESSON_NOTES_COPY.loadedMeta(1, '16.0', 'at-limit.txt'))).toBeVisible();
      await finishButton(page).click();
      await expect(page.getByRole('heading', { name: LESSON_NOTES_COPY.startedHeading })).toBeVisible();
      expect(stub.posts.map(utf8ByteLength)).toEqual([LESSON_TEXT_MAX_BYTES]);
    });

    test('a non-.txt file and an invalid UTF-8 file are refused and the shown transcript is untouched (stubbed route)', async ({ page }) => {
      const stub = await stubLessonRoutes(page);
      await openLessonNotes(page);
      await recordAndStop(page);
      const shownBefore = await transcriptLines(page).allInnerTexts();
      expect(shownBefore).toHaveLength(27);
      const fileInput = page.locator('input[type="file"]');

      await fileInput.setInputFiles({ name: 'worksheet.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7') });
      await expect(page.getByRole('alert')).toHaveText(LESSON_NOTES_COPY.notTextFile);
      expect(await transcriptLines(page).allInnerTexts()).toEqual(shownBefore);

      await fileInput.setInputFiles({ name: 'broken.txt', mimeType: 'text/plain', buffer: Buffer.from([0x5b, 0x30, 0xff, 0xfe, 0x41]) });
      await expect(page.getByRole('alert')).toHaveText(LESSON_NOTES_COPY.notUtf8);
      expect(await transcriptLines(page).allInnerTexts()).toEqual(shownBefore);
      await expect(page.getByText(LESSON_NOTES_COPY.loadedMeta(27, '2.2', LESSON_NOTES_COPY.preparedSourceLabel))).toBeVisible();

      await finishButton(page).click();
      await expect(page.getByRole('heading', { name: LESSON_NOTES_COPY.startedHeading })).toBeVisible();
      expect(stub.posts.map(sha256)).toEqual([lessonManifest.sha256]);
    });

    test('a failed save keeps the transcript and offers Try saving again (stubbed route)', async ({ page }) => {
      const stub = await stubLessonRoutes(page, { replies: ['network-error', 'saved'] });
      await openLessonNotes(page);
      await recordAndStop(page);
      const shownBefore = await transcriptLines(page).allInnerTexts();
      await finishButton(page).click();
      await expect(page.getByText(LESSON_NOTES_COPY.saveFailed)).toBeVisible();
      expect(await transcriptLines(page).allInnerTexts()).toEqual(shownBefore);
      await expect(button(page, LESSON_NOTES_COPY.loadFile)).toBeVisible();
      await button(page, LESSON_NOTES_COPY.retrySave).click();
      await expect(page.getByRole('heading', { name: LESSON_NOTES_COPY.startedHeading })).toBeVisible();
      expect(stub.posts).toEqual([preparedTranscript, preparedTranscript]);
    });

    test('after a successful save the mascot screen replaces the page and a refresh restores it (stubbed route)', async ({ page }) => {
      await stubLessonRoutes(page);
      await openLessonNotes(page);
      await recordAndStop(page);
      await finishButton(page).click();
      const started = page.getByRole('status').filter({ has: page.getByRole('heading', { name: LESSON_NOTES_COPY.startedHeading }) });
      await expect(started).toBeVisible();
      await expect(started.getByText(LESSON_NOTES_COPY.startedBody)).toBeVisible();
      await expect(started.locator('svg.llime-mascot')).toBeVisible();
      await expect(page.getByRole('button')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: LESSON_NOTES_COPY.transcriptHeading })).toHaveCount(0);

      await page.reload();
      await expect(page.getByRole('heading', { name: LESSON_NOTES_COPY.startedHeading })).toBeVisible();
      await expect(page.getByRole('button')).toHaveCount(0);
    });

    test('no horizontal overflow and only the transcript list scrolls (stubbed route)', async ({ page }) => {
      await stubLessonRoutes(page);
      await openLessonNotes(page);
      await recordAndStop(page);
      await expect(transcriptLines(page)).toHaveCount(27);
      expect(await page.evaluate(MEASURE_PAGE_LAYOUT)).toEqual({ horizontalOverflow: 0, verticalOverflow: 0, scrollers: ['OL'] });
      await expect(finishButton(page)).toBeInViewport();
    });

    test('every lesson-notes state has no accessibility violations (stubbed route)', async ({ page }, testInfo) => {
      const stub = await stubLessonRoutes(page, { replies: ['network-error', 'hold'] });
      await openLessonNotes(page);
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `lesson-notes-ready-${orientation}`);

      await button(page, LESSON_NOTES_COPY.startRecording).click();
      await expect(button(page, LESSON_NOTES_COPY.stopRecording)).toBeVisible();
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `lesson-notes-recording-${orientation}`);

      await button(page, LESSON_NOTES_COPY.stopRecording).click();
      await expect(transcriptLines(page)).toHaveCount(27);
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `lesson-notes-stopped-${orientation}`);

      await finishButton(page).click();
      await expect(page.getByText(LESSON_NOTES_COPY.saveFailed)).toBeVisible();
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `lesson-notes-save-failed-${orientation}`);

      await button(page, LESSON_NOTES_COPY.retrySave).click();
      await expect(button(page, LESSON_NOTES_COPY.saving)).toBeDisabled();
      await expect(button(page, LESSON_NOTES_COPY.loadFile)).toHaveCount(0);
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `lesson-notes-saving-${orientation}`);

      stub.releaseHeldSave();
      await expect(page.getByRole('heading', { name: LESSON_NOTES_COPY.startedHeading })).toBeVisible();
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `lesson-notes-started-${orientation}`);

      await page.unrouteAll();
      await stubLessonRoutes(page, { prepared: null });
      await openLessonNotes(page);
      await recordAndStop(page);
      await expect(page.getByText(LESSON_NOTES_COPY.preparedUnavailable)).toBeVisible();
      await expect(finishButton(page)).toBeDisabled();
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `lesson-notes-unavailable-${orientation}`);
    });

    test('every lesson-notes story renders its state with no accessibility violations', async ({ page }, testInfo) => {
      const stories = [
        ['ready', LESSON_NOTES_COPY.startRecording],
        ['recording', LESSON_NOTES_COPY.stopRecording],
        ['stopped', LESSON_NOTES_COPY.stoppedFooter],
        ['saving', LESSON_NOTES_COPY.saving],
        ['started', LESSON_NOTES_COPY.startedHeading],
        ['save-failed', LESSON_NOTES_COPY.saveFailed],
        ['prepared-unavailable', LESSON_NOTES_COPY.preparedUnavailable],
      ] as const;
      for (const [story, text] of stories) {
        await page.goto(`${loadConfig().storybookOrigin}/iframe.html?id=class-lesson-notes--${story}&viewMode=story`);
        await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
        expect((await new AxeBuilder({ page }).include('#storybook-root').analyze()).violations).toEqual([]);
        await capture(page, testInfo, `story-lesson-notes-${story}-${orientation}`);
      }
    });

    test('a page without a run says so and offers no recording (stubbed route)', async ({ page }) => {
      await page.route(`**${routePath('getLesson', { runId: 'unknown-run' })}`, (route) =>
        route.fulfill({ status: 404, json: HttpErrorSchema.parse({ code: 'NOT_FOUND', message: 'Unknown run', retryable: false }) }),
      );
      for (const url of ['/lesson-notes', '/lesson-notes?runId=unknown-run']) {
        await page.goto(url);
        await expect(page.getByText(LESSON_NOTES_COPY.runUnavailable)).toBeVisible();
        await expect(page.getByRole('button')).toHaveCount(0);
      }
    });
  });
}
