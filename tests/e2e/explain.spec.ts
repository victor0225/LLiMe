import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { z } from 'zod';
import { repoRoot, loadConfig } from '../../src/config.js';
import { EXPLAIN_COPY, OUTCOME_COPY, STUDENT_COPY, VOICE_CONTROL_COPY, VOICE_STATUS_COPY, firstNumberSelected } from '../../src/copy.js';
import {
  CommandSchema,
  EXPLANATION_MAX_CHARS,
  InterpretationMeaningSchema,
  MATCHING_VERSION,
  RunCreateInputSchema,
  StrategySchema,
  ToolNameSchema,
  type Command,
  type SavedAttempt,
} from '../../src/domain.js';
import { EventSchema, RunSnapshotSchema, type RunEvent, type RunSnapshot } from '../../src/events.js';
import { BootstrapSchema, ROUTES, routePath } from '../../src/routes.js';

const { storybookOrigin } = loadConfig();
const IPAD_VIEWPORTS = [
  { orientation: 'landscape', width: 1194, height: 834 },
  { orientation: 'portrait', width: 834, height: 1194 },
] as const;
const PHONE_WIDTHS = [390, 320] as const;
const MIN_TARGET_PX = 48;
const STORY_TITLES = ['Student/Explain', 'Student/Outcome', 'Student/Explain flow'];
const CAPTURE_DIR = join(repoRoot, '.runtime', 'captures', 'task_b69c29a82c9c');
const RUN_ID = 'story-run';
// The story sweep opens, audits and captures every story in one test, about 1.5 s each.
const STORY_SWEEP_TIMEOUT_MS = 180_000;

// ---------------------------------------------------------------------------------------------
// Synthetic run fixtures, parsed by the shared schemas before any route answers with them.

const problem = { lhs: 8, rhs: 5 };
const independentProblem = { lhs: 9, rhs: 4 };
const at = '2026-11-09T00:00:00.000Z';

function runSnapshot(state: Partial<RunSnapshot>): RunSnapshot {
  return RunSnapshotSchema.parse({
    id: RUN_ID,
    revision: 4,
    seq: 0,
    execution: { throughSeq: state.seq ?? 0, events: [] },
    phase: 'EXPLAIN',
    stopped: false,
    studentId: 'student_7',
    corpusHash: 'synthetic-corpus',
    matchingVersion: MATCHING_VERSION,
    seed: 1,
    lessonProblems: [problem],
    selectedProblems: { initial: problem, independent: independentProblem },
    explanationRevision: 0,
    cancellationEpoch: 0,
    clarificationRounds: 0,
    interventionCount: 0,
    continuationAllowed: false,
    runtime: null,
    lesson: null,
    invitation: null,
    activity: null,
    attempts: [initialAttempt],
    explanation: null,
    graph: null,
    search: null,
    error: null,
    createdAt: at,
    ...state,
  });
}

const initialAttempt: SavedAttempt = {
  id: 'attempt_initial',
  activityId: 'activity_initial',
  activityRevision: 1,
  criterion: 'initial',
  attempt: { start: 8, moves: [9, 10, 11, 12], answer: 12, hints: 0 },
  assessment: null,
  at,
};
const independentAttempt: SavedAttempt = {
  id: 'attempt_independent',
  activityId: 'activity_independent',
  activityRevision: 3,
  criterion: 'independent',
  attempt: { placements: [{ objectId: 'counter_1', to: 'ten_frame' }, { objectId: 'counter_2', to: 'remaining' }, { objectId: 'counter_3', to: 'remaining' }, { objectId: 'counter_4', to: 'remaining' }], answer: 13, hints: 0 },
  assessment: { attemptId: 'attempt_independent', passed: true, processCorrect: true, answerCorrect: true, hints: 0, retention: 'pending' },
  at,
};

function runEvent(seq: number, type: RunEvent['type'], payload: unknown): RunEvent {
  return EventSchema.parse({ runId: RUN_ID, seq, type, payload, at });
}

const bootstrap = BootstrapSchema.parse({ nonce: 'story-nonce', voice: 'missing_key', inputMode: 'typed', runtime: 'stubbed', database: 'stubbed', dataset: 'synthetic' });

// ---------------------------------------------------------------------------------------------
// HTTP stubs at the browser boundary. Every request body is parsed by the route's shared schema.

const pathIs = (path: string) => (url: URL) => url.pathname === path;

async function stubBootstrap(page: Page) {
  await page.route(pathIs(routePath('bootstrap')), (route) => route.fulfill({ json: bootstrap }));
}

// Answers the run snapshot and its event feed; `state` can be changed by the test between polls.
async function stubRun(page: Page, state: { snapshot: RunSnapshot; events: RunEvent[] }) {
  await stubBootstrap(page);
  await page.route(pathIs(routePath('getRun', { runId: RUN_ID })), (route) => route.fulfill({ json: state.snapshot }));
  await page.route(pathIs(routePath('runEvents', { runId: RUN_ID })), (route) => {
    const after = Number(new URL(route.request().url()).searchParams.get('after'));
    return route.fulfill({ json: state.events.filter((event) => event.seq > after) });
  });
}

// Records each learning command after parsing it with the shared command schema.
async function recordCommands(page: Page, answer: RunSnapshot): Promise<Command[]> {
  const commands: Command[] = [];
  await page.route(pathIs(routePath('runCommand', { runId: RUN_ID })), (route: Route) => {
    commands.push(CommandSchema.parse(route.request().postDataJSON()));
    return route.fulfill({ json: answer });
  });
  return commands;
}

const StoryIndexSchema = z.object({ entries: z.record(z.string(), z.object({ id: z.string(), title: z.string(), type: z.string() })) });

const storyUrl = (id: string) => `${storybookOrigin}/iframe.html?id=${id}&viewMode=story`;

async function openStory(page: Page, id: string) {
  await page.goto(storyUrl(id));
  await expect(page.locator('#storybook-root main')).toBeVisible();
}

async function expectNoAxeViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).include('#storybook-root').analyze();
  expect(violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`)).toEqual([]);
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  expect(overflow).toBeLessThanOrEqual(0);
}

async function visibleText(page: Page) {
  return page.locator('#storybook-root').innerText();
}

// Learning vocabulary that must never reach the child: tool names, hypothesis meanings, strategies.
const BACKEND_TERMS = [...ToolNameSchema.options, ...InterpretationMeaningSchema.options, ...StrategySchema.options, 'Codex'];

for (const viewport of IPAD_VIEWPORTS) {
  test.describe(`explanation screens, iPad ${viewport.orientation}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('Type instead shows a labeled textarea; a blank Send is disabled; Send emits one explain with the exact trimmed text (UI07) (stubbed route)', async ({ page }) => {
      await stubRun(page, { snapshot: runSnapshot({}), events: [] });
      const commands = await recordCommands(page, runSnapshot({ phase: 'PROCESSING', revision: 5 }));
      await openStory(page, 'student-explain--listening');

      await page.getByRole('button', { name: VOICE_CONTROL_COPY.typeInstead }).click();
      const field = page.getByLabel(STUDENT_COPY.explanationLabel);
      await expect(field).toBeFocused();
      const send = page.getByRole('button', { name: STUDENT_COPY.sendExplanation });
      await expect(send).toBeDisabled();
      await field.fill('   \n  ');
      await expect(send).toBeDisabled();

      await field.fill('  I counted 8, 9, 10, 11, 12.\nThat is five.  ');
      await send.dblclick();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toMatchObject({ type: 'explain', text: 'I counted 8, 9, 10, 11, 12.\nThat is five.', revision: 4 });
      await expectNoAxeViolations(page);
    });

    test('Ctrl/Cmd+Enter sends the typed explanation and plain Enter adds a newline (stubbed route)', async ({ page }) => {
      await stubRun(page, { snapshot: runSnapshot({}), events: [] });
      const commands = await recordCommands(page, runSnapshot({ phase: 'PROCESSING', revision: 5 }));
      await openStory(page, 'student-explain--typed-only');
      const field = page.getByLabel(STUDENT_COPY.explanationLabel);
      await field.click();
      await field.pressSequentially('one');
      await field.press('Enter');
      await field.pressSequentially('two');
      expect(commands).toEqual([]);
      await field.press('ControlOrMeta+Enter');
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toMatchObject({ type: 'explain', text: 'one\ntwo' });
    });

    test('a failed send keeps the draft, says so, and resends the same words with the same command ID (stubbed route)', async ({ page }) => {
      await stubRun(page, { snapshot: runSnapshot({}), events: [] });
      const commands: Command[] = [];
      await page.route(pathIs(routePath('runCommand', { runId: RUN_ID })), (route) => {
        commands.push(CommandSchema.parse(route.request().postDataJSON()));
        return commands.length === 1
          ? route.fulfill({ status: 503, json: { code: 'RUNTIME_DISCONNECTED', message: 'Store unavailable' } })
          : route.fulfill({ json: runSnapshot({ phase: 'PROCESSING', revision: 5 }) });
      });
      await openStory(page, 'student-explain--typed-only');
      const field = page.getByLabel(STUDENT_COPY.explanationLabel);
      const send = page.getByRole('button', { name: STUDENT_COPY.sendExplanation });
      await field.fill('I counted the start.');
      await send.click();
      await expect(page.getByRole('alert')).toHaveText(EXPLAIN_COPY.sendFailed);
      await expect(field).toHaveValue('I counted the start.');

      await send.click();
      await expect.poll(() => commands.length).toBe(2);
      expect(commands[1]?.commandId).toBe(commands[0]?.commandId);
      await expect(field).toHaveValue('');
    });

    test('Stop learning sends one stop_learning command (stubbed route)', async ({ page }) => {
      await stubRun(page, { snapshot: runSnapshot({}), events: [] });
      const commands = await recordCommands(page, runSnapshot({ stopped: true, revision: 5 }));
      await openStory(page, 'student-explain--listening');
      await page.getByRole('button', { name: STUDENT_COPY.stopLearning }).dblclick();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toMatchObject({ type: 'stop_learning', revision: 4 });
    });

    test('with the microphone denied, Type instead remains and no listening state appears (UI07)', async ({ page }) => {
      await openStory(page, 'student-explain--microphone-denied');
      await expect(page.getByRole('button', { name: VOICE_CONTROL_COPY.typeInstead })).toBeVisible();
      await expect(page.getByRole('status').first()).toContainText(EXPLAIN_COPY.microphoneDeniedTitle);
      await expect(page.getByText(EXPLAIN_COPY.microphoneDeniedBody)).toBeVisible();
      expect(await visibleText(page)).not.toContain(VOICE_STATUS_COPY.listening);
      await expect(page.getByRole('button', { name: VOICE_CONTROL_COPY.enable })).toHaveCount(0);
      await expectNoAxeViolations(page);
    });

    test('the real voice client, with getUserMedia denied by the browser, shows the denied state and keeps Type instead (stubbed route)', async ({ page }) => {
      // Instrumented browser boundary: the permission prompt is refused, as a child or parent might.
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: { getUserMedia: () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')) },
        });
      });
      await stubRun(page, { snapshot: runSnapshot({}), events: [] });
      const voiceRequests: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.includes('/voice/')) voiceRequests.push(request.url());
      });
      await openStory(page, 'student-explain-flow--from-server-with-voice');
      await page.getByRole('button', { name: VOICE_CONTROL_COPY.enable }).click();
      await expect(page.getByRole('status').first()).toHaveText(EXPLAIN_COPY.microphoneDeniedTitle);
      await expect(page.getByText(EXPLAIN_COPY.microphoneDeniedBody)).toBeVisible();
      await expect(page.getByRole('button', { name: VOICE_CONTROL_COPY.typeInstead })).toBeVisible();
      await expect(page.getByRole('button', { name: VOICE_CONTROL_COPY.reconnect })).toHaveCount(0);
      expect(await visibleText(page)).not.toContain(VOICE_STATUS_COPY.listening);
      // No session is requested without a microphone.
      expect(voiceRequests).toEqual([]);
      await expectNoAxeViolations(page);
    });

    test('a long caption wraps with no page horizontal overflow at 834 px and at 320/390 px, and shows no tool names (UI05)', async ({ page }) => {
      await openStory(page, 'student-explain--long-caption');
      const caption = page.locator('[data-speaker="you"] p');
      for (const width of [viewport.width, ...PHONE_WIDTHS]) {
        await page.setViewportSize({ width, height: viewport.height });
        await expect(caption).toBeVisible();
        await expectNoHorizontalOverflow(page);
        const box = await caption.boundingBox();
        expect(box && box.x + box.width).toBeLessThanOrEqual(width);
      }
      const text = await visibleText(page);
      for (const term of BACKEND_TERMS) expect(text).not.toContain(term);
      await expectNoAxeViolations(page);
    });

    test('clarify_first_number sends "First number selected: n." plus the optional text as one explain, within 600 characters and never truncated (stubbed route)', async ({ page }) => {
      await stubRun(page, { snapshot: runSnapshot({ phase: 'CLARIFY' }), events: [] });
      const commands = await recordCommands(page, runSnapshot({ phase: 'PROCESSING', revision: 5 }));
      await openStory(page, 'student-explain--clarify-first-number');

      await page.getByRole('radio', { name: '8', exact: true }).check();
      const field = page.getByLabel(STUDENT_COPY.explanationLabel);
      const expected = `${firstNumberSelected(8)}\nI started on eight`;
      await field.fill('  I started on eight ');
      await expect(page.locator('.ex-preview-text')).toHaveText(expected);

      // Over the limit nothing is cut: Send stays disabled and the words stay as typed.
      const tooLong = 'a'.repeat(EXPLANATION_MAX_CHARS);
      await field.fill(tooLong);
      await expect(page.getByRole('button', { name: STUDENT_COPY.sendExplanation })).toBeDisabled();
      await expect(page.getByText(EXPLAIN_COPY.tooLong(EXPLANATION_MAX_CHARS))).toBeVisible();
      await expect(field).toHaveValue(tooLong);

      await field.fill('  I started on eight ');
      await page.getByRole('button', { name: STUDENT_COPY.sendExplanation }).click();
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]).toMatchObject({ type: 'explain', text: expected });
      expect(expected.length).toBeLessThanOrEqual(EXPLANATION_MAX_CHARS);
      await expectNoAxeViolations(page);
    });

    test('Thinking shows no percentage, diagnosis or outcome; mute and the typed fallback stay available (UI06)', async ({ page }) => {
      await openStory(page, 'student-explain--thinking-with-voice');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(STUDENT_COPY.interpreting);
      const text = await visibleText(page);
      expect(text).not.toMatch(/\d\s*%/);
      for (const term of [...BACKEND_TERMS, ...Object.values(OUTCOME_COPY), EXPLAIN_COPY.assistedTitle]) expect(text).not.toContain(term);
      await expect(page.getByRole('button', { name: VOICE_CONTROL_COPY.mute })).toBeEnabled();
      await page.getByRole('button', { name: VOICE_CONTROL_COPY.typeInstead }).click();
      await expect(page.getByLabel(STUDENT_COPY.explanationLabel)).toBeFocused();
      await expectNoAxeViolations(page);
    });

    test('Disconnected offers distinct Reconnect and Type instead and fakes no recovery (UI08)', async ({ page }) => {
      await openStory(page, 'student-explain--disconnected');
      const reconnect = page.getByRole('button', { name: VOICE_CONTROL_COPY.reconnect });
      const typeInstead = page.getByRole('button', { name: VOICE_CONTROL_COPY.typeInstead });
      await expect(reconnect).toBeVisible();
      await expect(typeInstead).toBeVisible();

      await reconnect.click();
      expect(await page.evaluate<string[]>('globalThis.storyVoiceControlCalls')).toEqual(['start']);
      // The press asks for a reconnect; the row still says the connection is lost until it is back.
      await expect(page.getByRole('status').first()).toHaveText(VOICE_STATUS_COPY.disconnected);
      await expect(page.getByLabel(STUDENT_COPY.explanationLabel)).toHaveCount(0);

      await typeInstead.click();
      await expect(page.getByLabel(STUDENT_COPY.explanationLabel)).toBeVisible();
      expect(await page.evaluate<string[]>('globalThis.storyVoiceControlCalls')).toEqual(['start']);
      const text = await visibleText(page);
      expect(text).not.toContain(VOICE_STATUS_COPY.listening);
      expect(text).not.toContain(STUDENT_COPY.disconnected);
      await expectNoAxeViolations(page);
    });

    test('Saved and Assisted copy differ; Assisted never claims independence; there is no retention claim (UI10)', async ({ page }) => {
      await openStory(page, 'student-outcome--complete');
      const saved = await visibleText(page);
      expect(saved).toContain(OUTCOME_COPY.completeTitle);
      await expectNoAxeViolations(page);

      await openStory(page, 'student-outcome--assisted');
      const assisted = await visibleText(page);
      expect(assisted).toContain(EXPLAIN_COPY.assistedTitle);
      expect(assisted).not.toContain(OUTCOME_COPY.completeTitle);
      // It may suggest trying alone next time, but never says this work was done alone.
      expect(assisted).not.toMatch(/without help|by yourself|you solved|you did (it|that)/i);
      for (const text of [saved, assisted]) expect(text).not.toMatch(/retention|remember|mastered|learned it/i);
      await expectNoAxeViolations(page);
    });

    test('no success screen appears before a committed outcome event (stubbed route)', async ({ page }) => {
      const state = {
        snapshot: runSnapshot({ phase: 'COMPLETE', revision: 6, seq: 5, attempts: [initialAttempt, independentAttempt] }),
        events: [] as RunEvent[],
      };
      await stubRun(page, state);
      const firstPoll = page.waitForRequest((request) => new URL(request.url()).pathname === routePath('runEvents', { runId: RUN_ID }));
      await openStory(page, 'student-explain-flow--from-server');
      await firstPoll;
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(STUDENT_COPY.checkingSave);
      expect(await visibleText(page)).not.toContain(OUTCOME_COPY.completeTitle);

      const outcome = runEvent(6, 'outcome.committed', {
        queryId: 'query_run',
        persistedCaseId: 'case_run',
        strategy: 'make_ten',
        outcome: 'independent',
        saved: true,
        nodes: [],
        edges: [],
        source: { id: 'run', text: 'This run' },
      });
      const committed = runEvent(7, 'state.committed', { phase: 'COMPLETE', revision: 7, caseIds: ['case_run'] });
      state.events = [outcome, committed];
      state.snapshot = runSnapshot({ phase: 'COMPLETE', revision: 7, seq: 7, attempts: [initialAttempt, independentAttempt], execution: { throughSeq: 7, events: [outcome, committed] } });
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(OUTCOME_COPY.completeTitle);
      await expectNoAxeViolations(page);
    });

    test('Start a new run posts /api/runs once; Done sends nothing (stubbed route)', async ({ page }) => {
      await stubBootstrap(page);
      const created: unknown[] = [];
      await page.route(pathIs(routePath('createRun')), (route) => {
        created.push(RunCreateInputSchema.parse(route.request().postDataJSON()));
        return route.fulfill({ status: ROUTES.createRun.status, json: runSnapshot({ id: 'story-run-next', phase: 'WAITING', attempts: [] }) });
      });
      await openStory(page, 'student-outcome--runtime-error');
      const start = page.getByRole('button', { name: STUDENT_COPY.startNewRun });
      await start.dblclick();
      await expect.poll(() => created.length).toBe(1);
      await expect(start).toBeDisabled();
      await expect(page.getByRole('button', { name: STUDENT_COPY.pause })).toBeVisible();

      const apiRequests: Request[] = [];
      await openStory(page, 'student-outcome--complete');
      page.on('request', (request) => {
        if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request);
      });
      await page.getByRole('button', { name: EXPLAIN_COPY.done }).click();
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(STUDENT_COPY.doneCollapsed);
      expect(apiRequests).toEqual([]);
    });

    test('keyboard-only order, visible focus, 48 px targets, contrast, reduced motion (UI12–UI15)', async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await openStory(page, 'student-explain--listening');
      const order: string[] = [];
      for (let step = 0; step < 4; step += 1) {
        await page.keyboard.press('Tab');
        const focused = await page.evaluate<{ name: string; outline: string; width: number }>(
          '(() => { const el = document.activeElement; const style = getComputedStyle(el); return { name: el.textContent.trim(), outline: style.outlineStyle, width: parseFloat(style.outlineWidth) }; })()',
        );
        expect(focused.outline).not.toBe('none');
        expect(focused.width).toBeGreaterThanOrEqual(3);
        order.push(focused.name);
      }
      expect(order).toEqual([VOICE_CONTROL_COPY.mute, VOICE_CONTROL_COPY.end, VOICE_CONTROL_COPY.typeInstead, STUDENT_COPY.stopLearning]);
      // No trap: focus continues past the last control.
      await page.keyboard.press('Tab');
      expect(await page.evaluate<string>('document.activeElement.textContent.trim()')).not.toBe(STUDENT_COPY.stopLearning);

      for (const id of ['student-explain--listening', 'student-explain--clarify-first-number', 'student-outcome--runtime-error']) {
        await openStory(page, id);
        for (const target of await page.locator('#storybook-root').locator('button, textarea, input').all()) {
          const box = await target.boundingBox();
          expect(box?.width).toBeGreaterThanOrEqual(MIN_TARGET_PX);
          expect(box?.height).toBeGreaterThanOrEqual(MIN_TARGET_PX);
        }
        const moving = await page.evaluate<string[]>(
          "[...document.querySelectorAll('#storybook-root *')].filter((el) => { const s = getComputedStyle(el); return s.animationName !== 'none' || s.transitionDuration.split(',').some((d) => parseFloat(d) > 0); }).map((el) => el.className)",
        );
        expect(moving).toEqual([]);
        // Axe includes the WCAG text-contrast rule.
        await expectNoAxeViolations(page);
      }
    });

    test('every explain and outcome story renders without errors, overflow or accessibility violations (stubbed route)', async ({ page, request }) => {
      test.setTimeout(STORY_SWEEP_TIMEOUT_MS);
      const index = StoryIndexSchema.parse(await (await request.get(`${storybookOrigin}/index.json`)).json());
      const ids = Object.values(index.entries)
        .filter((entry) => entry.type === 'story' && STORY_TITLES.includes(entry.title))
        .map((entry) => entry.id);
      expect(ids.length).toBeGreaterThan(20);
      // The server-run story reads this run; the others never call the server while only rendering.
      await stubRun(page, { snapshot: runSnapshot({}), events: [] });
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      mkdirSync(CAPTURE_DIR, { recursive: true });
      for (const id of ids) {
        await openStory(page, id);
        await expectNoHorizontalOverflow(page);
        await expectNoAxeViolations(page);
        await page.screenshot({ path: join(CAPTURE_DIR, `${id}-${viewport.orientation}.png`), fullPage: true });
      }
      expect(errors).toEqual([]);
    });
  });
}
