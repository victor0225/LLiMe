import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { loadConfig } from '../../src/config.js';
import { ACTIVITY_COPY, MAKE_TEN_COPY, STUDENT_COPY } from '../../src/copy.js';
import { type MakeTenAttempt, MakeTenAttemptSchema } from '../../src/domain.js';
import { makeTenIndependent, makeTenSupport } from '../../src/ui/activity-fixtures.js';

const STORYBOOK = loadConfig().storybookOrigin;
const LANDSCAPE = { width: 1194, height: 834 };
const PORTRAIT = { width: 834, height: 1194 };
const TEN = 10;

const SUPPORT = { start: makeTenSupport.context.start, addend: makeTenSupport.context.addend };
const INDEPENDENT = { start: makeTenIndependent.context.start, addend: makeTenIndependent.context.addend };

type Zone = MakeTenAttempt['placements'][number]['to'];
type Destination = Exclude<Zone, 'tray'>;

const openStory = (page: Page, id: string) => page.goto(`${STORYBOOK}/iframe.html?id=student-maketen--${id}&viewMode=story`);

const objectButton = (page: Page, objectId: string) => page.locator(`button[data-object-id="${objectId}"]`);
const destinationButton = (page: Page, to: Destination) => page.getByRole('button', { name: to === 'ten_frame' ? STUDENT_COPY.putInBox : STUDENT_COPY.putToSide });
const expectEquation = (page: Page, lines: string[]) => expect(page.locator('.mt-equation-line')).toHaveText(lines);

async function expectAccessible(page: Page): Promise<void> {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

async function move(page: Page, objectId: string, to: Destination): Promise<void> {
  await objectButton(page, objectId).click();
  await destinationButton(page, to).click();
}

async function zoneOf(page: Page, objectId: string): Promise<string | null> {
  return objectButton(page, objectId).getAttribute('data-zone');
}

async function expectConservedCounts(page: Page, problem: { start: number; addend: number }): Promise<void> {
  await expect(page.locator('[data-object-id]')).toHaveCount(problem.start + problem.addend);
  expect(await page.locator('.mt-box [data-object-id]').count()).toBeLessThanOrEqual(TEN);
}

async function submitted(page: Page): Promise<{ target: unknown; attempt: MakeTenAttempt }[]> {
  const entries = await page.locator('[data-log-kind="submit"] code').allTextContents();
  return entries.map((text) => {
    const { target, attempt } = JSON.parse(text);
    return { target, attempt: MakeTenAttemptSchema.parse(attempt) };
  });
}

// The partition a correct make-ten trace shows: fill the box to ten, put the rest to the side.
function makeTenMoves({ start, addend }: { start: number; addend: number }): { objectId: string; to: Destination }[] {
  return Array.from({ length: addend }, (_, i) => ({ objectId: `t${i}`, to: i < TEN - start ? 'ten_frame' : 'remaining' }));
}

async function answerAndCheck(page: Page, answer: number): Promise<void> {
  await page.getByLabel(STUDENT_COPY.yourAnswer).fill(String(answer));
  await page.getByRole('button', { name: STUDENT_COPY.checkAnswer }).click();
}

const FOCUS_CHECK_MS = 50;
const isFocused = (target: Locator) => expect(target).toBeFocused({ timeout: FOCUS_CHECK_MS }).then(() => true, () => false);

async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < 60; presses += 1) {
    if (await isFocused(target)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Keyboard focus never reached the control');
}

for (const [orientation, viewport] of [['landscape', LANDSCAPE], ['portrait', PORTRAIT]] as const) {
  test.describe(`make-ten workspace, iPad ${orientation}`, () => {
    test.use({ viewport });

    test('a move transfers an object; the total never changes; the box never exceeds 10', async ({ page }) => {
      await openStory(page, 'support');
      await expectConservedCounts(page, SUPPORT);
      await expectAccessible(page);

      const toFill = TEN - SUPPORT.start;
      for (let i = 0; i < toFill; i += 1) {
        await move(page, `t${i}`, 'ten_frame');
        expect(await zoneOf(page, `t${i}`)).toBe('ten_frame');
        await expect(page.locator('.mt-tray [data-object-id]')).toHaveCount(SUPPORT.addend - i - 1);
        await expectConservedCounts(page, SUPPORT);
      }
      await expect(page.locator('.mt-box [data-object-id]')).toHaveCount(TEN);

      // A full box offers no room: the next object can only go to the side.
      await objectButton(page, `t${toFill}`).click();
      await expect(destinationButton(page, 'ten_frame')).toBeDisabled();
      await expectAccessible(page);
      await destinationButton(page, 'remaining').click();
      expect(await zoneOf(page, `t${toFill}`)).toBe('remaining');
      await expectConservedCounts(page, SUPPORT);

      // An object in the box moves out again as the same object, not a copy.
      await move(page, 't0', 'remaining');
      expect(await zoneOf(page, 't0')).toBe('remaining');
      await expect(objectButton(page, 't0')).toHaveCount(1);
      await expectConservedCounts(page, SUPPORT);
      await expectAccessible(page);
    });

    test('undo restores the previous placement and the derived equation', async ({ page }) => {
      await openStory(page, 'support');
      await move(page, 't0', 'ten_frame');
      await move(page, 't1', 'ten_frame');
      await move(page, 't2', 'remaining');
      await expectEquation(page, [`${SUPPORT.start} + 2 = ${TEN}`, `${TEN} + 1 = ?`]);

      await page.getByRole('button', { name: MAKE_TEN_COPY.undo }).click();
      expect(await zoneOf(page, 't2')).toBe('tray');
      await expectEquation(page, [`${SUPPORT.start} + 2 = ${TEN}`]);
      await page.getByRole('button', { name: MAKE_TEN_COPY.undo }).click();
      expect(await zoneOf(page, 't1')).toBe('tray');
      await expectEquation(page, [`${SUPPORT.start} + 1`]);
      await expectConservedCounts(page, SUPPORT);
      await expectAccessible(page);

      // The restoring moves stay in the trace, after the moves they undo.
      await answerAndCheck(page, SUPPORT.start + SUPPORT.addend);
      const [only] = await submitted(page);
      expect(only?.attempt.placements).toEqual([
        { objectId: 't0', to: 'ten_frame' },
        { objectId: 't1', to: 'ten_frame' },
        { objectId: 't2', to: 'remaining' },
        { objectId: 't2', to: 'tray' },
        { objectId: 't1', to: 'tray' },
      ]);
    });

    test('8 + 5 support shows 8 + 5, then 8 + 2 = 10, then 10 + 3 = ?, and never 13', async ({ page }) => {
      const { start, addend } = SUPPORT;
      const total = String(start + addend);
      const card = page.locator('.activity-card');
      const neverShowsTotal = async () => {
        expect(await card.innerText()).not.toContain(total);
      };

      await openStory(page, 'support');
      await expectEquation(page, [`${start} + ${addend}`]);
      await neverShowsTotal();
      const moves = makeTenMoves(SUPPORT);
      for (const [index, { objectId, to }] of moves.entries()) {
        await move(page, objectId, to);
        await neverShowsTotal();
        if (index === TEN - start - 1) await expectEquation(page, [`${start} + ${TEN - start} = ${TEN}`]);
      }
      await expectEquation(page, [`${start} + ${TEN - start} = ${TEN}`, `${TEN} + ${addend - (TEN - start)} = ?`]);
      await expectAccessible(page);
    });

    test('submit sends {placements, answer, hints} once with the placements in action order', async ({ page }) => {
      await openStory(page, 'support');
      const moves = makeTenMoves(SUPPORT);
      for (const { objectId, to } of moves) await move(page, objectId, to);
      const check = page.getByRole('button', { name: STUDENT_COPY.checkAnswer });
      await expect(check).toBeDisabled();
      await expect(page.getByText(MAKE_TEN_COPY.answerFirst)).toBeVisible();
      await answerAndCheck(page, SUPPORT.start + SUPPORT.addend);
      await expect(check).toBeDisabled();
      await check.click({ force: true });
      await expectAccessible(page);

      const sent = await submitted(page);
      expect(sent).toHaveLength(1);
      // Both support helpers are shown, so the activity's help exposure is two.
      expect(sent[0]).toEqual({
        target: { activityId: makeTenSupport.context.activityId, activityRevision: makeTenSupport.context.revision },
        attempt: { placements: moves, answer: SUPPORT.start + SUPPORT.addend, hints: 2 },
      });
    });

    test('an independent spec shows no highlight, no equation and no helper, with the same controls', async ({ page }) => {
      await openStory(page, 'independent');
      const { title } = ACTIVITY_COPY.independent_make_ten({ lhs: INDEPENDENT.start, rhs: INDEPENDENT.addend });
      await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
      await expect(page.locator('.mt-equation')).toHaveCount(0);
      await expect(page.locator('[data-highlight="true"]')).toHaveCount(0);
      await expect(page.getByRole('img', { name: MAKE_TEN_COPY.emptySlot })).toHaveCount(0);
      for (const name of [STUDENT_COPY.putInBox, STUDENT_COPY.putToSide, MAKE_TEN_COPY.undo, STUDENT_COPY.checkAnswer]) {
        await expect(page.getByRole('button', { name })).toBeVisible();
      }
      await expectConservedCounts(page, INDEPENDENT);
      await expect(objectButton(page, 't0')).toBeDisabled();
      await expectAccessible(page);
      await page.getByRole('button', { name: STUDENT_COPY.startProblem }).click();
      await expect(objectButton(page, 't0')).toBeEnabled();

      const moves = makeTenMoves(INDEPENDENT);
      for (const { objectId, to } of moves) await move(page, objectId, to);
      await expect(page.locator('.mt-equation')).toHaveCount(0);
      await answerAndCheck(page, INDEPENDENT.start + INDEPENDENT.addend);
      expect((await submitted(page)).map(({ attempt }) => attempt)).toEqual([{ placements: moves, answer: INDEPENDENT.start + INDEPENDENT.addend, hints: 0 }]);
    });

    test('apple, pear and dot give the same counts and payload; a missing asset falls back to dot', async ({ page }) => {
      const runSupport = async (story: string, appearance: string) => {
        await openStory(page, story);
        await expect(page.locator('.mt')).toHaveAttribute('data-appearance', appearance);
        await expectConservedCounts(page, SUPPORT);
        await expectAccessible(page);
        for (const { objectId, to } of makeTenMoves(SUPPORT)) await move(page, objectId, to);
        await answerAndCheck(page, SUPPORT.start + SUPPORT.addend);
        return (await submitted(page)).map(({ attempt }) => attempt);
      };

      const apple = await runSupport('support', 'apple');
      expect(await runSupport('support-pear', 'pear')).toEqual(apple);
      expect(await runSupport('support-dot', 'dot')).toEqual(apple);

      // Only the image fails; the module that names its URL still loads.
      await page.route(/\/apple[^/]*\.svg/, (route) => (route.request().resourceType() === 'image' ? route.fulfill({ status: 404, body: '' }) : route.continue()));
      expect(await runSupport('support', 'dot')).toEqual(apple);
      await expect(page.getByRole('button', { name: MAKE_TEN_COPY.movableObject('dot', 1) })).toBeVisible();
    });

    test.describe('with touch', () => {
      test.use({ hasTouch: true });

      test('keyboard-only placement gives the same payload as touch', async ({ page }) => {
        const moves = makeTenMoves(SUPPORT);
        const answer = SUPPORT.start + SUPPORT.addend;

        await openStory(page, 'support');
        for (const { objectId, to } of moves) {
          await objectButton(page, objectId).tap();
          await destinationButton(page, to).tap();
        }
        await page.getByLabel(STUDENT_COPY.yourAnswer).tap();
        await page.keyboard.type(String(answer));
        await page.getByRole('button', { name: STUDENT_COPY.checkAnswer }).tap();
        const byTouch = (await submitted(page)).map(({ attempt }) => attempt);

        await openStory(page, 'support');
        for (const { objectId, to } of moves) {
          await tabTo(page, objectButton(page, objectId));
          await page.keyboard.press('Enter');
          await expect(objectButton(page, objectId)).toHaveAttribute('aria-pressed', 'true');
          await tabTo(page, destinationButton(page, to));
          await page.keyboard.press('Space');
        }
        await tabTo(page, page.getByLabel(STUDENT_COPY.yourAnswer));
        await page.keyboard.type(String(answer));
        await tabTo(page, page.getByRole('button', { name: STUDENT_COPY.checkAnswer }));
        await page.keyboard.press('Enter');
        await expectAccessible(page);
        const byKeyboard = (await submitted(page)).map(({ attempt }) => attempt);

        expect(byTouch).toEqual([{ placements: moves, answer, hints: 2 }]);
        expect(byKeyboard).toEqual(byTouch);
      });
    });

    test('rotation keeps every placement and the answer draft', async ({ page }) => {
      await openStory(page, 'support');
      const moves = makeTenMoves(SUPPORT);
      for (const { objectId, to } of moves) await move(page, objectId, to);
      await page.getByLabel(STUDENT_COPY.yourAnswer).fill('1');

      await page.setViewportSize(viewport === LANDSCAPE ? PORTRAIT : LANDSCAPE);
      for (const { objectId, to } of moves) expect(await zoneOf(page, objectId)).toBe(to);
      await expect(page.getByLabel(STUDENT_COPY.yourAnswer)).toHaveValue('1');
      await expectAccessible(page);

      await page.getByLabel(STUDENT_COPY.yourAnswer).fill(String(SUPPORT.start + SUPPORT.addend));
      await page.getByRole('button', { name: STUDENT_COPY.checkAnswer }).click();
      expect((await submitted(page)).map(({ attempt }) => attempt.placements)).toEqual([moves]);
    });

    test('a refresh drops the unsent try and says so', async ({ page }) => {
      await openStory(page, 'support');
      await move(page, 't0', 'ten_frame');
      await page.reload();
      await expect(page.getByRole('status').filter({ hasText: STUDENT_COPY.draftReset })).toBeVisible();
      expect(await zoneOf(page, 't0')).toBe('tray');
      await expect(page.getByLabel(STUDENT_COPY.yourAnswer)).toHaveValue('');
      await expectAccessible(page);
    });
  });
}
