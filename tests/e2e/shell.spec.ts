import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { loadConfig } from '../../src/config.js';
import { STUDENT_COPY } from '../../src/copy.js';

const { storybookOrigin } = loadConfig();

test('the shell loads on its own origin without errors or accessibility violations', async ({ page, baseURL }, testInfo) => {
  const problems: string[] = [];
  const foreignRequests: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(message.text());
  });
  page.on('request', (request) => {
    if (!request.url().startsWith(`${baseURL}/`)) foreignRequests.push(request.url());
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: STUDENT_COPY.waitingTitle })).toBeVisible();
  await expect(page.getByText(STUDENT_COPY.waitingBody)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('shell.png'), fullPage: true });

  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(problems).toEqual([]);
  expect(foreignRequests).toEqual([]);
});

test('the shell story renders in Storybook with the design tokens', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));

  await page.goto(`${storybookOrigin}/iframe.html?id=shell-app--waiting&viewMode=story`);
  const heading = page.getByRole('heading', { level: 1, name: STUDENT_COPY.waitingTitle });
  await expect(heading).toBeVisible();
  // The tokens stylesheet loaded: the heading uses the token text color, not the browser default.
  await expect(heading).toHaveCSS('color', 'rgb(60, 60, 60)');

  expect((await new AxeBuilder({ page }).include('#storybook-root').analyze()).violations).toEqual([]);
  expect(problems).toEqual([]);
});
