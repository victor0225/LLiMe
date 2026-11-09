import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { loadConfig } from '../../src/config.js';
import { MATCHING_VERSION } from '../../src/domain.js';
import { EventSchema, type RunEvent, RunSnapshotSchema } from '../../src/events.js';

const { storybookOrigin } = loadConfig();
const PREFIX = 'backend-codex-execution-inspector--';
const STORIES = [
  'memory-and-publish',
  'no-events',
  'waiting-for-result',
  'failed-and-retried',
  'steered-and-cancelled',
  'missing-ids',
  'transport-request-id',
  'unsafe-payloads',
  'output-over-limit',
  'notification-transport',
  'default-decision',
  'evidence-decision',
  'final-failure',
  'live-route',
] as const;

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
] as const;

async function open(page: Page, story: (typeof STORIES)[number]) {
  await page.goto(`${storybookOrigin}/iframe.html?id=${PREFIX}${story}&viewMode=story`);
  await expect(page.getByRole('heading', { level: 1, name: 'Codex Execution Inspector' })).toBeVisible();
}

const card = (page: Page, title: string): Locator => page.locator('article.insp-card').filter({ has: page.getByRole('heading', { level: 2, name: title, exact: true }) });
const rootText = (page: Page) => page.locator('#storybook-root').textContent();

// A scripted run served to the live route: the browser tests answer the polling routes themselves.
const RUN_ID = 'run_live_01';
const AT = '2026-11-09T10:00:00.000Z';
const ref = { threadId: 'thr_1', turnId: 'turn_1', callId: 'call_1', itemId: 'item_1', serverRequestId: 7, attempt: 1 };
const memoryResult = {
  ok: true,
  tool: 'get_personal_memory',
  data: {
    memorySnapshotId: 'mem_1',
    studentId: 'student_7',
    corpusHash: 'corpus',
    cases: [{ caseId: 'seed_7_0', concept: 'subtraction_within_20', strategy: 'make_ten', outcome: 'assisted', retention: 'pending', nodeIds: ['seed_7_0:attempt'] }],
    summaries: [{ conceptId: 'addition_within_20', link: 'today', total: 0, independent: 0, assisted: 0, failed: 0, notAssessed: 0, firstAt: null, lastAt: null }],
    unassessedConceptIds: [],
  },
};
const make = (seq: number, type: string, payload: unknown): RunEvent => EventSchema.parse({ runId: RUN_ID, seq, type, payload, at: AT });
const liveEvents = {
  started: make(1, 'tool.started', { ...ref, name: 'get_personal_memory', arguments: { conceptIds: ['addition_within_20'], includeUnassessed: false } }),
  saved: make(2, 'tool.completed', { ...ref, name: 'get_personal_memory', result: memoryResult, elapsedMs: 9 }),
  acknowledged: make(3, 'runtime.item', { threadId: 'thr_1', turnId: 'turn_1', id: 'item_1', type: 'dynamicToolCall', lifecycle: 'completed', tool: 'get_personal_memory' }),
  output: make(4, 'runtime.message', { threadId: 'thr_1', turnId: 'turn_1', itemId: 'item_2', text: 'Done.', partial: false }),
  failed: make(5, 'operation.failed', { operationId: 'op_1', code: 'MODEL_TIMEOUT', message: 'The model turn timed out.' }),
};

function snapshot(events: readonly RunEvent[]) {
  const seq = events.at(-1)?.seq ?? 0;
  return RunSnapshotSchema.parse({
    phase: 'WAITING', stopped: false, studentId: 'student_7', corpusHash: 'corpus', matchingVersion: MATCHING_VERSION, seed: 1,
    lessonProblems: null, selectedProblems: null, explanationRevision: 0, cancellationEpoch: 0, clarificationRounds: 0, interventionCount: 0,
    continuationAllowed: false, runtime: null, lesson: null, invitation: null, activity: null, attempts: [], explanation: null, graph: null,
    search: null, error: null, createdAt: AT, id: RUN_ID, revision: 0, seq, execution: { throughSeq: seq, events },
  });
}

// Serves the run's saved events up to `published`; `after` repeats the last event once to prove a
// repeated delivery is applied a single time.
function serveRun(page: Page, state: { published: RunEvent[]; created: string[] }) {
  return page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/bootstrap') return json({ nonce: 'nonce-1', voice: 'missing_key', inputMode: 'typed', runtime: 'Codex App Server 0.166.0', database: 'Neo4j', dataset: 'synthetic' });
    if (url.pathname === `/api/runs/${RUN_ID}/events`) {
      const after = Number(url.searchParams.get('after'));
      return json(state.published.filter((e) => e.seq > after));
    }
    if (url.pathname === `/api/runs/${RUN_ID}`) return json(snapshot(state.published));
    if (url.pathname === '/api/runs' && route.request().method() === 'POST') {
      state.created.push(route.request().headers()['x-primer-session'] ?? '');
      return json({ ...snapshot([]), id: 'run_next_02' }, 201);
    }
    return json({ code: 'NOT_FOUND', message: 'unknown', retryable: false }, 404);
  });
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test.describe('lifecycle', () => {
      test('a TOOL RESULT card appears only after tool.completed with a saved result', async ({ page }) => {
        await open(page, 'waiting-for-result');
        await expect(card(page, 'TOOL CALL')).toContainText('Running');
        await expect(card(page, 'TOOL RESULT')).toHaveCount(0);
        await expect(page.getByText(/Saved ·|Result saved/)).toHaveCount(0);

        await open(page, 'memory-and-publish');
        await expect(card(page, 'TOOL RESULT')).toHaveCount(2);
      });

      test('a saved result before the runtime acknowledgement shows "Saved · runtime acknowledgement pending" on the same card', async ({ page }) => {
        await open(page, 'memory-and-publish');
        const publishResult = card(page, 'TOOL RESULT').filter({ hasText: 'publish_activity' });
        await expect(publishResult).toContainText('Saved · runtime acknowledgement pending');
        const memoryResult = card(page, 'TOOL RESULT').filter({ hasText: 'get_personal_memory' });
        await expect(memoryResult).toContainText('Saved · runtime acknowledged');
        await expect(memoryResult.locator('.insp-status')).not.toContainText('pending');
      });

      test('tool.failed stays visible and a retry gets its own card', async ({ page }) => {
        await open(page, 'failed-and-retried');
        await expect(card(page, 'TOOL CALL')).toHaveCount(2);
        await expect(card(page, 'TOOL RESULT')).toHaveCount(2);
        const failed = card(page, 'TOOL RESULT').filter({ hasText: 'attempt 1' });
        await expect(failed).toContainText('Failed');
        await expect(failed).toContainText('VALIDATION_FAILED');
        await expect(card(page, 'TOOL RESULT').filter({ hasText: 'attempt 2' })).toContainText('Saved');
        await expect(card(page, 'TOOL CALL').filter({ hasText: 'Attempt2' })).toContainText('Completed');
        await expect(page.getByRole('button', { name: /retry/i })).toHaveCount(0);
      });

      test('turn.steered and operation.cancelled render as their own states', async ({ page }) => {
        await open(page, 'steered-and-cancelled');
        await expect(card(page, 'TURN STEERED')).toContainText('Steered');
        await expect(card(page, 'OPERATION CANCELLED')).toContainText('Superseded by a newer explanation');
        await expect(card(page, 'TOOL CALL')).toContainText('Cancelled');
        await expect(card(page, 'TOOL RESULT')).toHaveCount(0);
        await expect(page.locator('.insp-chip').filter({ hasText: 'Execution' })).toContainText('Cancelled');
      });
    });

    test.describe('identity and safety', () => {
      test('missing IDs show Not assigned', async ({ page }) => {
        await open(page, 'missing-ids');
        const header = page.getByRole('list', { name: 'Execution identifiers' }).or(page.locator('[aria-label="Execution identifiers"]'));
        await expect(header.getByText('Not assigned')).toHaveCount(2);
        const call = card(page, 'TOOL CALL');
        await expect(call.locator('.insp-id').filter({ hasText: 'Item ID' })).toContainText('Not assigned');
        await expect(call.locator('.insp-id').filter({ hasText: 'Transport request ID' })).toContainText('Not assigned');
        await expect(page.locator('.insp-chip').filter({ hasText: 'Runtime' })).toContainText('Not assigned');
      });

      test('the transport request ID is shown separately from callId and itemId', async ({ page }) => {
        await open(page, 'transport-request-id');
        const call = card(page, 'TOOL CALL');
        // The row shows a short suffix; the full ID is its title and the Selected evidence pane lists it whole.
        const full = (label: string) => call.locator('.insp-id').filter({ hasText: label }).locator('code');
        await expect(full('Transport request ID')).toHaveAttribute('title', 'rpc-request-91');
        await expect(full('Call ID')).toHaveAttribute('title', 'call_memory');
        await expect(full('Item ID')).toHaveAttribute('title', 'item_call_memory');
        const evidence = page.getByLabel('Call identifiers');
        await expect(evidence.locator('.insp-id').filter({ hasText: 'Transport request ID' }).locator('code')).toHaveText('rpc-request-91');
        await expect(evidence.locator('.insp-id').filter({ hasText: 'Item ID' }).locator('code')).toHaveText('item_call_memory');
      });

      test('reasoning-type and unknown payload types never render', async ({ page }) => {
        await open(page, 'unsafe-payloads');
        const text = (await rootText(page)) ?? '';
        expect(text).not.toContain('secret chain of thought');
        expect(text).not.toContain('hidden thought text');
        expect(text).not.toMatch(/reasoning/i);
        await expect(page.getByText('1 unreadable event was not shown.')).toBeVisible();
        await page.getByRole('button', { name: 'Details' }).click();
        await expect(page.getByLabel('Details')).toContainText('Items not shown2');
      });

      test('credential-like fields and home-directory prefixes are redacted', async ({ page }) => {
        await open(page, 'unsafe-payloads');
        const text = (await rootText(page)) ?? '';
        for (const secret of ['sk-live-abcdefghijklmnop1234', 'abcdefgh12345678', '/Users/sunho', 'child@example.com']) expect(text).not.toContain(secret);
        expect(text).toContain('[redacted]');
        expect(text).toContain('~/LLiMe/data/seed.json');
      });
    });

    test.describe('output and refresh', () => {
      test('output over 16,000 characters shows the partial-output failure', async ({ page }) => {
        await open(page, 'output-over-limit');
        const output = card(page, 'OUTPUT → STUDENT');
        await expect(output).toContainText('Output limit reached. See failure details.');
        await expect(output).toContainText('Partial observable output');
        await expect(output).toContainText('Output limit exceeded');
        await expect(output).not.toContainText('Complete');
        await expect(output.locator('.insp-output')).toContainText('a'.repeat(100));
      });

      test('a refresh rebuilds cards from the snapshot\'s execution events, and polling then adds later events exactly once', async ({ page }) => {
        const state = { published: [liveEvents.started, liveEvents.saved], created: [] as string[] };
        await serveRun(page, state);
        await open(page, 'live-route');
        const result = card(page, 'TOOL RESULT');
        await expect(result).toHaveCount(1);
        await expect(result).toContainText('Saved · runtime acknowledgement pending');

        // Later events arrive by polling: the acknowledgement updates the same card, the output adds one card.
        state.published = [liveEvents.started, liveEvents.saved, liveEvents.acknowledged, liveEvents.output];
        await expect(result).toContainText('Saved · runtime acknowledged');
        await expect(card(page, 'OUTPUT → STUDENT')).toHaveCount(1);
        await page.waitForTimeout(2500);
        await expect(card(page, 'TOOL RESULT')).toHaveCount(1);
        await expect(card(page, 'TOOL CALL')).toHaveCount(1);
        await expect(card(page, 'OUTPUT → STUDENT')).toHaveCount(1);

        // A refresh rebuilds every card from the snapshot alone, before any new event arrives.
        await page.reload();
        await expect(card(page, 'TOOL RESULT')).toContainText('Saved · runtime acknowledged');
        await expect(card(page, 'OUTPUT → STUDENT')).toHaveCount(1);
        await expect(card(page, 'TOOL CALL')).toHaveCount(1);
        await expect(page.locator('.insp-poll')).toContainText('through event 4');
        await expect(page.locator('.insp-chip').filter({ hasText: 'Runtime' })).toContainText('Codex App Server 0.166.0');
        await expect(page.locator('.insp-badge')).toHaveText('Live');
      });
    });

    test.describe('actions and labels', () => {
      test('View evidence says Waiting for result until the result exists, then hands the call\'s IDs to the graph', async ({ page }) => {
        await open(page, 'waiting-for-result');
        const waiting = card(page, 'TOOL CALL').getByRole('button', { name: 'Waiting for result' });
        await expect(waiting).toBeDisabled();
        await expect(page.getByRole('button', { name: 'View evidence' })).toHaveCount(0);

        await open(page, 'memory-and-publish');
        await card(page, 'TOOL CALL').filter({ hasText: 'get_personal_memory' }).getByRole('button', { name: 'View evidence' }).click();
        expect(await page.evaluate('window.__handoff')).toEqual({
          runId: 'run_fixture_01',
          callId: 'call_memory',
          attempt: 1,
          name: 'get_personal_memory',
          itemId: 'item_call_memory',
          caseIds: ['seed_7_0'],
          nodeIds: ['seed_7_0:attempt'],
          edgeIds: [],
        });
        await card(page, 'TOOL CALL').filter({ hasText: 'publish_activity' }).getByRole('button', { name: 'View evidence' }).click();
        expect(await page.evaluate('window.__handoff')).toMatchObject({ callId: 'call_publish', caseIds: ['seed_7_0'] });
      });

      test('notification events show transport status, never a tool card', async ({ page }) => {
        await open(page, 'notification-transport');
        await expect(card(page, 'SIMULATOR NOTIFICATION')).toHaveCount(2);
        await expect(card(page, 'SIMULATOR NOTIFICATION').first()).toContainText('queued');
        await expect(card(page, 'SIMULATOR NOTIFICATION').last()).toContainText('sent');
        await expect(card(page, 'TOOL CALL')).toHaveCount(0);
        await expect(card(page, 'TOOL RESULT')).toHaveCount(0);
      });

      test('a default decision is labeled "Default, no comparable evidence" with no match count', async ({ page }) => {
        await open(page, 'default-decision');
        const decision = card(page, 'DECISION');
        await expect(decision).toContainText('Default, no comparable evidence');
        const text = (await decision.textContent()) ?? '';
        expect(text).not.toMatch(/659|match|\d+ of \d+/i);
        await page.getByRole('button', { name: 'Decision' }).click();
        await expect(page.getByLabel('Decision', { exact: true })).toContainText('Default, no comparable evidence');

        await open(page, 'evidence-decision');
        await expect(card(page, 'DECISION')).toContainText('3 of 4 independent');
      });

      test('a final failure offers Start a new run (POST /api/runs) and no per-tool retry', async ({ page }) => {
        await open(page, 'final-failure');
        await expect(page.getByRole('button', { name: /retry/i })).toHaveCount(0);
        await page.getByRole('button', { name: 'Start a new run' }).click();
        expect(await page.evaluate('window.__newRun')).toBe(1);
        await expect(card(page, 'TOOL RESULT')).toContainText('Failed');

        const state = { published: [liveEvents.started, liveEvents.failed], created: [] as string[] };
        await serveRun(page, state);
        await open(page, 'live-route');
        await expect(page.getByRole('button', { name: /retry/i })).toHaveCount(0);
        await page.getByRole('button', { name: 'Start a new run' }).click();
        await expect.poll(() => state.created).toEqual(['nonce-1']);
        await expect.poll(() => page.evaluate('window.__newRunId')).toBe('run_next_02');
      });
    });

    test('every story passes axe and fits the viewport', async ({ page }, testInfo) => {
      const state = { published: [liveEvents.started, liveEvents.saved, liveEvents.acknowledged], created: [] as string[] };
      await serveRun(page, state);
      for (const story of STORIES) {
        await open(page, story);
        await expect(page.locator('.inspector')).toBeVisible();
        if (story === 'live-route') await expect(card(page, 'TOOL RESULT')).toHaveCount(1);
        expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), `${story} has no horizontal scroll`).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`${story}-${viewport.width}.png`), fullPage: true });
        expect((await new AxeBuilder({ page }).include('#storybook-root').analyze()).violations, story).toEqual([]);
      }
    });
  });
}
