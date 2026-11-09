import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { loadConfig } from '../../src/config.js';
import { ACTIVITY_COPY, NUMBER_LINE_COPY, STUDENT_COPY, VOICE_STATUS_COPY, problemQuestion } from '../../src/copy.js';
import { AttemptSchema, CommandSchema, MeaningSchema, StrategySchema } from '../../src/domain.js';
import { routePath } from '../../src/routes.js';

// The practice screen is exercised through its Storybook stories. Each story mounts the real screen
// and the real run queue; the queue's HTTP calls are answered by a stubbed route table in the page,
// which lists every request and holds a command's reply until "Send server reply" is pressed.
const { storybookOrigin } = loadConfig();
const storyUrl = (story: string) => `${storybookOrigin}/iframe.html?id=student-number-line-practice--${story}&viewMode=story`;
const STORY_RUN_ID = 'story_run';
const STORY_RUN_REVISION = 3;
const COMMAND_POST = `POST ${routePath('runCommand', { runId: STORY_RUN_ID })} `;
const RUN_GET = `GET ${routePath('getRun', { runId: STORY_RUN_ID })}`;

const LANDSCAPE = { width: 1194, height: 834 };
// Evaluated in the page: true when nothing makes the page scroll sideways.
const PAGE_FITS_WIDTH = 'document.documentElement.scrollWidth <= window.innerWidth';
const PORTRAIT = { width: 834, height: 1194 };

async function open(page: Page, story: string) {
  await page.goto(storyUrl(story));
  await expect(page.getByRole('group', { name: NUMBER_LINE_COPY.lineLabel })).toBeVisible();
}

async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page }).include('#storybook-root').analyze();
  expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

const line = (page: Page) => page.getByRole('group', { name: NUMBER_LINE_COPY.lineLabel });
const tick = (page: Page, value: number) => line(page).getByRole('button', { name: String(value), exact: true });
const forward = (page: Page) => page.getByRole('button', { name: STUDENT_COPY.moveForward });
const back = (page: Page) => page.getByRole('button', { name: STUDENT_COPY.moveBack });
const reset = (page: Page) => page.getByRole('button', { name: STUDENT_COPY.resetMoves });
const check = (page: Page) => page.getByRole('button', { name: STUDENT_COPY.checkAnswer });
const sendReply = (page: Page) => page.getByRole('button', { name: 'Send server reply' }).click();
const initialScreen = (page: Page) => page.getByRole('region', { name: ACTIVITY_COPY.initial_number_line({ lhs: 8, rhs: 5 }).title });
const requests = (page: Page) => page.getByRole('list', { name: 'Requests (stubbed route)' }).getByRole('listitem');
const commandRequests = (page: Page) => requests(page).filter({ hasText: COMMAND_POST.trim() });
const position = (page: Page) => page.getByText(/^Now at \d+$/);

// The learning commands the page actually POSTed, validated by the shared command schema.
async function postedCommands(page: Page) {
  const entries = await commandRequests(page).allTextContents();
  return entries.map((entry) => CommandSchema.parse(JSON.parse(entry.slice(COMMAND_POST.length))));
}

// What the child submitted, without the envelope the queue adds.
async function submittedAttempts(page: Page) {
  return (await postedCommands(page)).map((command) => ({ type: command.type, attempt: 'attempt' in command ? command.attempt : null }));
}

async function moveForward(page: Page, times: number) {
  for (let i = 0; i < times; i += 1) await forward(page).click();
}

for (const [orientation, viewport] of [['landscape', LANDSCAPE], ['portrait', PORTRAIT]] as const) {
  test.describe(`number line (${orientation})`, () => {
    test.use({ viewport });

    test('four forward moves from start 8 reach 12 and Check submits {start:8, moves:[9,10,11,12], answer:12, hints:0} once (stubbed route)', async ({ page }, testInfo) => {
      await open(page, 'initial');
      await expect(page.getByText(problemQuestion({ lhs: 8, rhs: 5 }))).toBeVisible();
      await expectAccessible(page);
      await page.screenshot({ path: testInfo.outputPath(`initial-${orientation}.png`) });

      await tick(page, 8).click();
      await moveForward(page, 4);
      await expect(page.getByText(NUMBER_LINE_COPY.position(12))).toBeVisible();
      await expectAccessible(page);

      await check(page).click();
      await expect(commandRequests(page)).toHaveCount(1);
      await sendReply(page);
      expect(await submittedAttempts(page)).toEqual([{ type: 'attempt', attempt: { start: 8, moves: [9, 10, 11, 12], answer: 12, hints: 0 } }]);
      const [command] = await postedCommands(page);
      expect(command?.revision).toBe(STORY_RUN_REVISION);
      expect(AttemptSchema.safeParse(command && 'attempt' in command ? command.attempt : null).success).toBe(true);

      // The screen shows the child's numbers only: no hypothesis or strategy vocabulary.
      const screenText = (await initialScreen(page).textContent()) ?? '';
      for (const word of [...MeaningSchema.options, ...StrategySchema.options]) expect(screenText).not.toContain(word);
      await expectAccessible(page);
    });

    test('Reset is disabled until there is a draft, back is disabled at 0 and the move count never goes negative', async ({ page }) => {
      await open(page, 'anchored-support');
      await expect(page.getByText(NUMBER_LINE_COPY.moveCount(0))).toBeVisible();
      await expect(reset(page)).toBeDisabled();
      await expect(back(page)).toBeDisabled();

      await page.getByRole('button', { name: STUDENT_COPY.startAt(8) }).click();
      await forward(page).click();
      await expect(page.getByText(NUMBER_LINE_COPY.moveCount(1))).toBeVisible();
      await reset(page).click();
      await expect(page.getByText(NUMBER_LINE_COPY.moveCount(0))).toBeVisible();
      await expect(reset(page)).toBeDisabled();
      await expect(back(page)).toBeDisabled();
      await expectAccessible(page);

      await open(page, 'initial');
      await tick(page, 0).click();
      await expect(page.getByText(NUMBER_LINE_COPY.position(0))).toBeVisible();
      await expect(back(page)).toBeDisabled();
      await expect(forward(page)).toBeEnabled();
    });

    test('forward is disabled at the line upper bound', async ({ page }) => {
      await open(page, 'initial');
      await tick(page, 18).click();
      await moveForward(page, 2);
      await expect(page.getByText(NUMBER_LINE_COPY.position(20))).toBeVisible();
      await expect(forward(page)).toBeDisabled();
      // The disabled button cannot keep focus, so it moves to the current tick, not the page.
      await expect(tick(page, 20)).toBeFocused();
      await expect(back(page)).toBeEnabled();
      await expectAccessible(page);
    });

    test('before a start is chosen no move is recorded', async ({ page }) => {
      await open(page, 'initial');
      await expect(forward(page)).toBeDisabled();
      await expect(back(page)).toBeDisabled();
      await expect(check(page)).toBeDisabled();
      await expect(page.getByText(NUMBER_LINE_COPY.chooseStart)).toBeVisible();

      await tick(page, 0).focus();
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await expect(tick(page, 2)).toBeFocused();
      await expect(position(page)).toHaveCount(0);
      await expect(check(page)).toBeDisabled();
      await expect(commandRequests(page)).toHaveCount(0);
      await expectAccessible(page);
    });

    test('Enter records the focused start, each non-repeated arrow press records one adjacent move, key-repeat is ignored', async ({ page }) => {
      await open(page, 'initial');
      await tick(page, 0).focus();
      for (let i = 0; i < 8; i += 1) await page.keyboard.press('ArrowRight');
      await expect(tick(page, 8)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByText(NUMBER_LINE_COPY.position(8))).toBeVisible();

      // A held key: the first keydown moves, the browser's repeated keydowns do not.
      await page.keyboard.down('ArrowRight');
      await page.keyboard.down('ArrowRight');
      await page.keyboard.down('ArrowRight');
      await page.keyboard.up('ArrowRight');
      await expect(page.getByText(NUMBER_LINE_COPY.position(9))).toBeVisible();
      await expect(tick(page, 9)).toBeFocused();

      await page.keyboard.press('ArrowLeft');
      await expect(page.getByText(NUMBER_LINE_COPY.position(8))).toBeVisible();
      await expectAccessible(page);

      await check(page).click();
      await expect(commandRequests(page)).toHaveCount(1);
      expect(await submittedAttempts(page)).toEqual([{ type: 'attempt', attempt: { start: 8, moves: [9, 8], answer: 8, hints: 0 } }]);
    });

    test('refresh discards the unsent draft and shows "This unfinished try was reset."', async ({ page }) => {
      await open(page, 'initial');
      await expect(page.getByText(STUDENT_COPY.draftReset)).toHaveCount(0);
      await tick(page, 8).click();
      await moveForward(page, 2);
      await expect(page.getByText(NUMBER_LINE_COPY.position(10))).toBeVisible();

      await page.reload();
      await expect(page.getByText(STUDENT_COPY.draftReset)).toBeVisible();
      await expect(position(page)).toHaveCount(0);
      await expect(check(page)).toBeDisabled();
      await expect(page.getByText(NUMBER_LINE_COPY.chooseStart)).toBeVisible();
      await expectAccessible(page);

      // Only an unsent try is announced: reloading a screen with no draft says nothing.
      await page.reload();
      await expect(page.getByText(STUDENT_COPY.draftReset)).toHaveCount(0);
    });

    test('Check sends one command; a second press while it is in flight sends nothing (stubbed route)', async ({ page }) => {
      await open(page, 'initial');
      await tick(page, 8).click();
      await moveForward(page, 4);
      await check(page).click();
      await expect(check(page)).toBeDisabled();
      await expect(check(page)).toHaveAttribute('aria-busy', 'true');
      await check(page).click({ force: true });
      await check(page).press('Enter');
      await expect(commandRequests(page)).toHaveCount(1);
      await expectAccessible(page);

      await sendReply(page);
      await expect(check(page)).not.toHaveAttribute('aria-busy', 'true');
      await expect(commandRequests(page)).toHaveCount(1);
      // A saved attempt is immutable: nothing on the line can change it any more.
      await expect(forward(page)).toBeDisabled();
      await expect(reset(page)).toBeDisabled();
    });

    test('a 409 reloads the snapshot and never resends the attempt (stubbed route)', async ({ page }) => {
      await open(page, 'initial-conflict');
      await tick(page, 8).click();
      await moveForward(page, 4);
      await check(page).click();
      await expect(commandRequests(page)).toHaveCount(1);
      await sendReply(page);
      await expect(check(page)).toBeEnabled();
      await expect(check(page)).not.toHaveAttribute('aria-busy', 'true');

      const entries = await requests(page).allTextContents();
      const post = entries.findIndex((entry) => entry.startsWith(COMMAND_POST));
      expect(entries.slice(post + 1)).toContain(RUN_GET);
      await expect(commandRequests(page)).toHaveCount(1);
      await expectAccessible(page);
    });

    test('an unconfirmed check keeps the draft and says the save is being checked (stubbed route)', async ({ page }) => {
      await open(page, 'initial-unavailable');
      await tick(page, 8).click();
      await moveForward(page, 4);
      await check(page).click();
      await expect(commandRequests(page)).toHaveCount(1);
      await sendReply(page);
      await expect(page.getByText(STUDENT_COPY.checkingSave)).toBeVisible();
      await expect(page.getByText(NUMBER_LINE_COPY.position(12))).toBeVisible();
      await expect(check(page)).toBeEnabled();
      await expect(commandRequests(page)).toHaveCount(1);
      await expectAccessible(page);
    });

    test('independent screen shows the new problem with zero prefilled moves and no hint, jump counter, start marker or microphone control, and shows the voice-off notice only when the voice state says teardown happened', async ({ page }, testInfo) => {
      await open(page, 'independent');
      await expect(page.getByText(problemQuestion({ lhs: 9, rhs: 4 }))).toBeVisible();
      await expect(position(page)).toHaveCount(0);
      await expect(page.getByText(/^\d+ moves?$/)).toHaveCount(0);
      await expect(page.locator('[data-start-marker]')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /^Start at/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /voice|mute|microphone|reconnect|type instead/i })).toHaveCount(0);
      await expect(page.getByText(VOICE_STATUS_COPY.off)).toHaveCount(0);
      await expectAccessible(page);

      await open(page, 'independent-voice-off');
      await expect(page.getByText(VOICE_STATUS_COPY.off)).toBeVisible();
      await expect(position(page)).toHaveCount(0);
      await expectAccessible(page);
      await page.screenshot({ path: testInfo.outputPath(`independent-${orientation}.png`) });

      await tick(page, 9).click();
      await moveForward(page, 4);
      await check(page).click();
      await expect(commandRequests(page)).toHaveCount(1);
      expect(await submittedAttempts(page)).toEqual([{ type: 'verify', attempt: { start: 9, moves: [10, 11, 12, 13], answer: 13, hints: 0 } }]);
    });

    test('a non-film pair (6 + 6) renders and submits its own numbers', async ({ page }) => {
      await open(page, 'initial-other-pair');
      await expect(page.getByText(problemQuestion({ lhs: 6, rhs: 6 }))).toBeVisible();
      await tick(page, 6).click();
      await moveForward(page, 6);
      await check(page).click();
      await expect(commandRequests(page)).toHaveCount(1);
      expect(await submittedAttempts(page)).toEqual([{ type: 'attempt', attempt: { start: 6, moves: [7, 8, 9, 10, 11, 12], answer: 12, hints: 0 } }]);
      await expectAccessible(page);
    });

    test('a StartMarker shows the anchor but the child\'s Start click is still recorded', async ({ page }, testInfo) => {
      await open(page, 'anchored-support');
      await expect(line(page).locator('[data-start-marker]')).toHaveText('8');
      await expect(position(page)).toHaveCount(0);
      await expect(forward(page)).toBeDisabled();
      await expect(check(page)).toBeDisabled();
      await expectAccessible(page);
      await page.screenshot({ path: testInfo.outputPath(`anchored-support-${orientation}.png`) });

      await page.getByRole('button', { name: STUDENT_COPY.startAt(8) }).click();
      await expect(page.getByText(NUMBER_LINE_COPY.position(8))).toBeVisible();
      await moveForward(page, 5);
      await expect(page.getByText(NUMBER_LINE_COPY.moveCount(5))).toBeVisible();
      await check(page).click();
      await expect(commandRequests(page)).toHaveCount(1);
      expect(await submittedAttempts(page)).toEqual([{ type: 'practice', attempt: { start: 8, moves: [9, 10, 11, 12, 13], answer: 13, hints: 0 } }]);
    });

    test('the plain retry opens empty, with no helper, and submits as practice', async ({ page }, testInfo) => {
      await open(page, 'retry');
      await expect(position(page)).toHaveCount(0);
      await expect(page.getByText(/^\d+ moves?$/)).toHaveCount(0);
      await expect(page.locator('[data-start-marker]')).toHaveCount(0);
      await expectAccessible(page);
      await page.screenshot({ path: testInfo.outputPath(`retry-${orientation}.png`) });

      await tick(page, 8).click();
      await moveForward(page, 5);
      await check(page).click();
      await expect(commandRequests(page)).toHaveCount(1);
      expect(await submittedAttempts(page)).toEqual([{ type: 'practice', attempt: { start: 8, moves: [9, 10, 11, 12, 13], answer: 13, hints: 0 } }]);
    });
  });
}

test('rotating between landscape and portrait keeps the start and every move', async ({ page }) => {
  await page.setViewportSize(LANDSCAPE);
  await open(page, 'initial');
  await tick(page, 8).click();
  await moveForward(page, 3);
  await expect(page.getByText(NUMBER_LINE_COPY.position(11))).toBeVisible();

  await page.setViewportSize(PORTRAIT);
  await expect(page.getByText(NUMBER_LINE_COPY.position(11))).toBeVisible();
  expect(await page.evaluate(PAGE_FITS_WIDTH)).toBe(true);
  await expectAccessible(page);
  await forward(page).click();

  await page.setViewportSize(LANDSCAPE);
  await expect(page.getByText(NUMBER_LINE_COPY.position(12))).toBeVisible();
  expect(await page.evaluate(PAGE_FITS_WIDTH)).toBe(true);
  await check(page).click();
  await expect(commandRequests(page)).toHaveCount(1);
  expect(await submittedAttempts(page)).toEqual([{ type: 'attempt', attempt: { start: 8, moves: [9, 10, 11, 12], answer: 12, hints: 0 } }]);
});
