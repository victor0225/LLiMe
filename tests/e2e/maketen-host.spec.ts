import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { loadConfig } from '../../src/config.js';
import { STUDENT_COPY } from '../../src/copy.js';
import { ActivityRenderedCommandSchema } from '../../src/routes.js';
import { makeTenIndependent, makeTenSupport, numberLineIndependent, numberLineSupport } from '../../src/ui/activity-fixtures.js';

const STORYBOOK = loadConfig().storybookOrigin;
const LANDSCAPE = { width: 1194, height: 834 };
const PORTRAIT = { width: 834, height: 1194 };

type FixtureContext = { activityId: string; revision: number };

const openStory = (page: Page, id: string) => page.goto(`${STORYBOOK}/iframe.html?id=student-maketen--${id}&viewMode=story`);

// The stories store each fixture activity with this labeled hash; the host must forward it unchanged.
const storedReceipt = ({ activityId, revision }: FixtureContext) => ({ activityId, activityRevision: revision, specHash: `story-hash-${activityId}-${revision}`, voiceSessionId: null });

async function expectAccessible(page: Page): Promise<void> {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

// The activity_rendered commands the run's queue posted to the stubbed voice-command route.
async function receipts(page: Page): Promise<unknown[]> {
  return (await page.locator('[data-log-kind="activity_rendered"] code').allTextContents()).map((text) => {
    const { activityId, activityRevision, specHash, voiceSessionId } = ActivityRenderedCommandSchema.parse(JSON.parse(text));
    return { activityId, activityRevision, specHash, voiceSessionId };
  });
}

const mountedActivity = (page: Page) => page.locator('.activity-card');
const recoveryLine = (page: Page) => page.getByRole('status').filter({ hasText: STUDENT_COPY.activityOpenFailed });
const deliver = (page: Page, label: string) => page.getByRole('button', { name: `Deliver: ${label}` }).click();

async function expectMounted(page: Page, { activityId, revision }: FixtureContext): Promise<void> {
  await expect(mountedActivity(page)).toHaveAttribute('data-activity-id', activityId);
  await expect(mountedActivity(page)).toHaveAttribute('data-activity-revision', String(revision));
}

const numberLineProp = (page: Page, name: string) => page.locator(`[data-prop="${name}"]`);

for (const [orientation, viewport] of [['landscape', LANDSCAPE], ['portrait', PORTRAIT]] as const) {
  test.describe(`activity host, iPad ${orientation}`, () => {
    test.use({ viewport });

    test('an invalid, stale or forged spec keeps the previous activity with the recovery line and sends no activity_rendered', async ({ page }) => {
      await openStory(page, 'host-invalid-first');
      await expect(recoveryLine(page)).toBeVisible();
      await expect(mountedActivity(page)).toHaveCount(0);
      await expect(page.getByRole('button', { name: STUDENT_COPY.putInBox })).toHaveCount(0);
      await expect.poll(() => receipts(page)).toEqual([]);
      await expectAccessible(page);

      await openStory(page, 'host-replacements');
      await expectMounted(page, makeTenSupport.context);
      await page.locator('button[data-object-id="t0"]').click();
      await page.getByRole('button', { name: STUDENT_COPY.putInBox }).click();

      for (const label of ['Wrong numbers', 'Stale spec revision', 'Forged evidence', 'Older activity']) {
        await deliver(page, label);
        await expect(recoveryLine(page)).toBeVisible();
        await expectMounted(page, makeTenSupport.context);
        // The child's unsent move survives the rejected replacement.
        await expect(page.locator('button[data-object-id="t0"]')).toHaveAttribute('data-zone', 'ten_frame');
        await expectAccessible(page);
      }
      await expect.poll(() => receipts(page)).toEqual([storedReceipt(makeTenSupport.context)]);
    });

    test('activity_rendered is sent once after mount with the stored hash (stubbed route)', async ({ page }) => {
      await openStory(page, 'host-replacements');
      await expectMounted(page, makeTenSupport.context);
      await page.locator('button[data-object-id="t0"]').click();
      await page.getByRole('button', { name: STUDENT_COPY.putInBox }).click();
      await page.setViewportSize(viewport === LANDSCAPE ? PORTRAIT : LANDSCAPE);
      await expect.poll(() => receipts(page)).toEqual([storedReceipt(makeTenSupport.context)]);

      await deliver(page, 'Independent activity');
      await expectMounted(page, makeTenIndependent.context);
      await expect(recoveryLine(page)).toHaveCount(0);
      await expect.poll(() => receipts(page)).toEqual([storedReceipt(makeTenSupport.context), storedReceipt(makeTenIndependent.context)]);

      // A spec that validates but whose controls fail to render is never acknowledged.
      await deliver(page, 'Number line that fails to render');
      await expect(recoveryLine(page)).toBeVisible();
      await expectMounted(page, makeTenIndependent.context);
      await expect.poll(() => receipts(page)).toEqual([storedReceipt(makeTenSupport.context), storedReceipt(makeTenIndependent.context)]);
      await expectAccessible(page);
    });

    test('a NumberLine spec with StartMarker and JumpCounter mounts the number-line slot with them', async ({ page }) => {
      await openStory(page, 'host-number-line');
      await expectMounted(page, numberLineSupport.context);
      await expect(numberLineProp(page, 'start')).toHaveText(String(numberLineSupport.context.start));
      await expect(numberLineProp(page, 'addend')).toHaveText(String(numberLineSupport.context.addend));
      await expect(numberLineProp(page, 'startMarker')).toHaveText(String(numberLineSupport.context.start));
      await expect(numberLineProp(page, 'showJumpCount')).toHaveText('true');
      await expect(numberLineProp(page, 'hints')).toHaveText('2');
      await expect.poll(() => receipts(page)).toEqual([storedReceipt(numberLineSupport.context)]);
      await expectAccessible(page);

      await openStory(page, 'host-number-line-independent');
      await expectMounted(page, numberLineIndependent.context);
      await expect(numberLineProp(page, 'startMarker')).toHaveText('none');
      await expect(numberLineProp(page, 'showJumpCount')).toHaveText('false');
      await expect(numberLineProp(page, 'hints')).toHaveText('0');
      await expect.poll(() => receipts(page)).toEqual([storedReceipt(numberLineIndependent.context)]);
      await expectAccessible(page);
    });
  });
}
