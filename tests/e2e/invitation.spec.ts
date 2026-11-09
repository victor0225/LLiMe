import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Request, type TestInfo } from '@playwright/test';
import { loadConfig } from '../../src/config.js';
import { INVITATION_COPY, STUDENT_COPY } from '../../src/copy.js';
import { type Activity, CommandSchema, type RunPhase } from '../../src/domain.js';
import { EventSchema, type RunEvent, type RunSnapshot, RunSnapshotSchema } from '../../src/events.js';
import { ROUTES, routePath, SESSION_HEADER } from '../../src/routes.js';

// The run routes have no backend handler yet, so these checks answer them at the browser boundary with
// bodies parsed by the shared schemas. The invitation itself is whatever the snapshot carries.
const RUN_ID = 'run-invitation';
const NONCE = 'nonce-invitation';
const LANDSCAPE = { width: 1194, height: 834 };
const PORTRAIT = { width: 834, height: 1194 };
const AT = '2026-11-09T09:00:00.000Z';

function invitation(body: string): Activity {
  return {
    id: 'activity-invitation',
    revision: 0,
    runId: RUN_ID,
    kind: 'invitation',
    templateId: 'invitation_addition',
    strategy: null,
    problem: { lhs: 8, rhs: 5 },
    title: INVITATION_COPY.title,
    body,
    primaryLabel: INVITATION_COPY.accept,
    secondaryLabel: INVITATION_COPY.later,
    activitySpec: null,
    specHash: null,
    helperCount: 0,
    evidenceIds: ['seed_7_0'],
    decisionSummary: 'Synthetic test invitation.',
  };
}

function runSnapshot({ phase, revision, seq, invitationBody = null }: { phase: RunPhase; revision: number; seq: number; invitationBody?: string | null }): RunSnapshot {
  const selected = phase === 'WAITING' || phase === 'INGESTING' ? null : { initial: { lhs: 8, rhs: 5 }, independent: { lhs: 9, rhs: 4 } };
  return RunSnapshotSchema.parse({
    id: RUN_ID,
    revision,
    seq,
    execution: { throughSeq: seq, events: [] },
    phase,
    stopped: false,
    studentId: 'student_7',
    corpusHash: 'synthetic-corpus-hash',
    matchingVersion: 'typed-path-v1',
    seed: 7,
    lessonProblems: selected ? [{ lhs: 7, rhs: 4 }] : null,
    selectedProblems: selected,
    explanationRevision: 0,
    cancellationEpoch: 0,
    clarificationRounds: 0,
    interventionCount: 0,
    continuationAllowed: false,
    runtime: null,
    lesson: phase === 'WAITING' ? null : { contentHash: 'synthetic-lesson-hash', text: 'Synthetic lesson.', source: 'local_file', savedAt: AT },
    invitation: invitationBody === null ? null : invitation(invitationBody),
    activity: null,
    attempts: [],
    explanation: null,
    graph: null,
    search: null,
    error: null,
    createdAt: AT,
  });
}

const committed = (seq: number, phase: RunPhase, revision: number): RunEvent =>
  EventSchema.parse({ runId: RUN_ID, seq, type: 'state.committed', payload: { phase, revision, caseIds: [] }, at: AT });
const published = (seq: number, activity: Activity): RunEvent => EventSchema.parse({ runId: RUN_ID, seq, type: 'activity.published', payload: { activity }, at: AT });

// The committed history of a run that reached its invitation.
const invitedHistory = (body: string) => [committed(1, 'INGESTING', 1), published(2, invitation(body)), committed(3, 'INVITED', 2)];

type RunStub = { commands: Request[]; setRun: (run: RunSnapshot) => void; setEvents: (events: RunEvent[]) => void; releaseRun: () => void };

async function stubRun(page: Page, { run, events, holdRun = false }: { run: RunSnapshot; events: RunEvent[]; holdRun?: boolean }): Promise<RunStub> {
  const commands: Request[] = [];
  let current = run;
  let history = events;
  let release: () => void = () => {};
  const held = holdRun ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
  await page.route(`**${routePath('bootstrap')}`, (route) =>
    route.fulfill({ json: ROUTES.bootstrap.response.parse({ nonce: NONCE, voice: 'missing_key', inputMode: 'typed', runtime: 'codex-app-server', database: 'neo4j', dataset: 'seed-v7' }) }),
  );
  await page.route(`**${routePath('getRun', { runId: RUN_ID })}`, async (route) => {
    await held;
    await route.fulfill({ json: ROUTES.getRun.response.parse(current) });
  });
  await page.route(`**${routePath('runEvents', { runId: RUN_ID })}?*`, (route) => {
    const after = ROUTES.runEvents.query.parse({ after: new URL(route.request().url()).searchParams.get('after') ?? '' }).after;
    return route.fulfill({ json: ROUTES.runEvents.response.parse(history.filter((event) => event.seq > after)) });
  });
  await page.route(`**${routePath('runCommand', { runId: RUN_ID })}`, (route) => {
    commands.push(route.request());
    const command = CommandSchema.parse(route.request().postDataJSON());
    current = runSnapshot({ phase: 'INITIAL', revision: command.revision + 1, seq: current.seq + 1, invitationBody: current.invitation?.body ?? null });
    return route.fulfill({ json: ROUTES.runCommand.response.parse(current) });
  });
  return { commands, setRun: (next) => (current = next), setEvents: (next) => (history = next), releaseRun: () => release() };
}

const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function openStudent(page: Page) {
  await page.goto(`/student?runId=${encodeURIComponent(RUN_ID)}`);
}

async function expectNoAxeViolations(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

test('a fixture story mounting the student screen makes no /api request', async ({ page }) => {
  const api: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) api.push(request.url());
  });
  await page.goto(`${loadConfig().storybookOrigin}/iframe.html?id=student-invitation--linked-concept&viewMode=story`);
  // The invitation shows only after the store's first snapshot, so every mount-time read has been issued.
  await expect(page.getByText(INVITATION_COPY.bodyLinkedConcept, { exact: true })).toBeVisible();
  expect(api).toEqual([]);
});

for (const [orientation, viewport] of [['landscape', LANDSCAPE], ['portrait', PORTRAIT]] as const) {
  test.describe(`student invitation, iPad ${orientation}`, () => {
    test.use({ viewport });

    test("Let's try sends exactly one accept command with commandId and the snapshot revision (stubbed route)", async ({ page }, testInfo) => {
      const run = runSnapshot({ phase: 'INVITED', revision: 2, seq: 3, invitationBody: INVITATION_COPY.bodyLinkedConcept });
      const stub = await stubRun(page, { run, events: invitedHistory(INVITATION_COPY.bodyLinkedConcept) });
      await openStudent(page);
      await expect(page.getByRole('heading', { name: INVITATION_COPY.title })).toBeVisible();
      await expect(button(page, INVITATION_COPY.later)).toBeVisible();
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `student-invitation-${orientation}`);
      expect(stub.commands).toHaveLength(0);

      await button(page, INVITATION_COPY.accept).dblclick();
      await expect(page.getByRole('heading', { name: INVITATION_COPY.title })).toHaveCount(0);
      expect(stub.commands).toHaveLength(1);
      const [request] = stub.commands;
      const command = CommandSchema.parse(request?.postDataJSON());
      expect(command).toEqual({ type: 'accept', commandId: expect.stringMatching(/^[0-9a-f-]{36}$/), revision: run.revision });
      expect(request?.headers()[SESSION_HEADER]).toBe(NONCE);
    });

    test('Later sends no command and shows the deferred state with Try the activity (stubbed route)', async ({ page }, testInfo) => {
      const run = runSnapshot({ phase: 'INVITED', revision: 2, seq: 3, invitationBody: INVITATION_COPY.bodyLinkedConcept });
      const stub = await stubRun(page, { run, events: invitedHistory(INVITATION_COPY.bodyLinkedConcept) });
      await openStudent(page);
      await button(page, INVITATION_COPY.later).click();
      await expect(page.getByText(INVITATION_COPY.deferred)).toBeVisible();
      await expect(button(page, INVITATION_COPY.accept)).toHaveCount(0);
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `student-deferred-${orientation}`);

      await button(page, INVITATION_COPY.returnToActivity).click();
      await expect(page.getByRole('heading', { name: INVITATION_COPY.title })).toBeVisible();
      await expect(button(page, INVITATION_COPY.accept)).toBeEnabled();
      expect(stub.commands).toHaveLength(0);
    });

    test('no invitation renders before a committed invitation exists; Empty and Loading are distinct (stubbed route)', async ({ page }, testInfo) => {
      const waiting = runSnapshot({ phase: 'WAITING', revision: 0, seq: 0 });
      const stub = await stubRun(page, { run: waiting, events: [], holdRun: true });
      await openStudent(page);
      const main = page.getByRole('main');
      await expect(main).toHaveAttribute('aria-busy', 'true');
      await expect(page.getByText(STUDENT_COPY.loading)).toBeVisible();
      await expect(page.getByText(STUDENT_COPY.waitingTitle)).toHaveCount(0);
      await expect(page.getByRole('button')).toHaveCount(0);
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `student-loading-${orientation}`);

      stub.releaseRun();
      await expect(page.getByRole('heading', { name: STUDENT_COPY.waitingTitle })).toBeVisible();
      await expect(page.getByText(STUDENT_COPY.waitingBody)).toBeVisible();
      await expect(page.getByText(STUDENT_COPY.loading)).toHaveCount(0);
      await expect(main).not.toHaveAttribute('aria-busy', 'true');
      await expect(page.getByRole('button')).toHaveCount(0);
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `student-empty-${orientation}`);

      // The lesson was accepted: the run is ingesting, and still no invitation exists.
      stub.setRun(runSnapshot({ phase: 'INGESTING', revision: 1, seq: 1 }));
      stub.setEvents([committed(1, 'INGESTING', 1)]);
      await expect(page.getByText(STUDENT_COPY.preparing)).toBeVisible();
      await expect(button(page, INVITATION_COPY.accept)).toHaveCount(0);
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `student-preparing-${orientation}`);

      // Only the committed invitation makes the offer appear.
      stub.setRun(runSnapshot({ phase: 'INVITED', revision: 2, seq: 3, invitationBody: INVITATION_COPY.bodyLinkedConcept }));
      stub.setEvents(invitedHistory(INVITATION_COPY.bodyLinkedConcept));
      await expect(button(page, INVITATION_COPY.accept)).toBeVisible();
      expect(stub.commands).toHaveLength(0);
    });

    test('the invitation body is the server-provided copy for linked and same-concept evidence (stubbed route)', async ({ page }) => {
      for (const body of [INVITATION_COPY.bodyLinkedConcept, INVITATION_COPY.bodySameConcept]) {
        await page.unrouteAll();
        await stubRun(page, { run: runSnapshot({ phase: 'INVITED', revision: 2, seq: 3, invitationBody: body }), events: invitedHistory(body) });
        await openStudent(page);
        await expect(page.getByRole('heading', { name: INVITATION_COPY.title })).toBeVisible();
        await expect(page.getByText(body, { exact: true })).toBeVisible();
        const other = body === INVITATION_COPY.bodyLinkedConcept ? INVITATION_COPY.bodySameConcept : INVITATION_COPY.bodyLinkedConcept;
        await expect(page.getByText(other, { exact: true })).toHaveCount(0);
      }
    });

    test('every invitation story renders its state with no accessibility violations', async ({ page }, testInfo) => {
      const stories = [
        ['loading', STUDENT_COPY.loading],
        ['empty', STUDENT_COPY.waitingTitle],
        ['preparing', STUDENT_COPY.preparing],
        ['linked-concept', INVITATION_COPY.bodyLinkedConcept],
        ['same-concept', INVITATION_COPY.bodySameConcept],
        ['disconnected', STUDENT_COPY.disconnected],
        ['deferred', INVITATION_COPY.deferred],
      ] as const;
      for (const [story, text] of stories) {
        await page.goto(`${loadConfig().storybookOrigin}/iframe.html?id=student-invitation--${story}&viewMode=story`);
        await expect(page.getByText(text, { exact: true })).toBeVisible();
        expect((await new AxeBuilder({ page }).include('#storybook-root').analyze()).violations).toEqual([]);
        await capture(page, testInfo, `story-invitation-${story}-${orientation}`);
      }
    });

    test('a lost connection shows the paused state below the invitation and disables Let’s try (stubbed route)', async ({ page }, testInfo) => {
      const run = runSnapshot({ phase: 'INVITED', revision: 2, seq: 3, invitationBody: INVITATION_COPY.bodyLinkedConcept });
      await stubRun(page, { run, events: invitedHistory(INVITATION_COPY.bodyLinkedConcept) });
      await openStudent(page);
      await expect(button(page, INVITATION_COPY.accept)).toBeEnabled();
      await page.route(`**${routePath('runEvents', { runId: RUN_ID })}?*`, (route) => route.abort('failed'));
      await expect(page.getByText(STUDENT_COPY.disconnected)).toBeVisible();
      await expect(button(page, INVITATION_COPY.accept)).toBeDisabled();
      await expectNoAxeViolations(page);
      await capture(page, testInfo, `student-disconnected-${orientation}`);
    });
  });
}
