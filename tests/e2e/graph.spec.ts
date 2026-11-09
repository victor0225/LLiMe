import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test } from '@playwright/test';
import { loadConfig } from '../../src/config.js';
import { CaseSchema, validateCase } from '../../src/domain.js';
import { buildSearchResult, chooseActivity, rank, rankingHash } from '../../src/search.js';

const { storybookOrigin } = loadConfig();
const readJson = (relative: string): unknown => JSON.parse(readFileSync(new URL(`../../data/${relative}`, import.meta.url), 'utf8'));
const EVIDENCE_DIR = new URL('../../.runtime/captures/graph/', import.meta.url).pathname;

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
] as const;
// Text in the scene is at least this large on screen, in CSS pixels.
const MIN_TEXT_PX = 14;
// Transitions run up to 0.9 s plus a stagger; this lets a step settle before it is measured.
const SETTLE_MS = 1700;
const STORY = (id: string) => `${storybookOrigin}/iframe.html?id=${id}&viewMode=story`;
const GRAPH_3D = 'backend-3d-graph--searched-memory';
const STORY_IDS = ['backend-learning-memory--execution-and-graph', 'backend-learning-memory--graph-overview', 'backend-learning-memory--outcome-not-yet', 'backend-learning-memory--opening-memory-recalled', GRAPH_3D] as const;
// Steps of the player: 0..6, then the committed outcome.
const LAST_STEP = 6;
const PLAYER = 'backend-learning-memory--execution-and-graph';

const ranked = rank(
  validateCase((readJson('captures/backend.capture.json') as { query: unknown }).query),
  CaseSchema.array().parse(readJson('seed/cases.json')),
);
const query = validateCase((readJson('captures/backend.capture.json') as { query: unknown }).query);
const search = buildSearchResult({ query, corpusHash: (readJson('seed/manifest.json') as { sha256: string }).sha256, ranked, decision: chooseActivity(query, ranked, false), rankingHash: await rankingHash(ranked) });

// Page-side code is passed as source text so this file needs no DOM typings, which would replace the
// Node types the rest of the project is checked with.
const inPage = <T>(page: Page, body: string): Promise<T> => page.evaluate<T>(`(() => {${body}})()`);

async function open(page: Page, id: string): Promise<void> {
  await page.goto(STORY(id), { waitUntil: 'domcontentloaded' });
  await page.locator('.learning-memory').waitFor({ timeout: 60_000 });
  if (id === GRAPH_3D) await page.locator('.graph-canvas[data-nodes]').waitFor({ timeout: 60_000 });
}

async function advance(page: Page, presses: number): Promise<void> {
  for (let i = 0; i < presses; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(SETTLE_MS);
}

// Everything the scene shows that depends on the step, read from the DOM.
async function stateOf(page: Page) {
  return inPage<{ step: string | null; scored: number; lifted: string[]; open: string[]; litEdges: string[]; visibleResults: number; transforms: string[]; raw: string | null | undefined; operation: string | null | undefined; source: string | null | undefined }>(page, `
    const ids = (selector) => [...document.querySelectorAll(selector)].map((e) => e.getAttribute('data-case-id') ?? e.getAttribute('data-edge-id')).sort();
    const root = document.querySelector('.learning-memory');
    const resOpacity = [...document.querySelectorAll('.glyph:not(.mine) .res')].map((e) => getComputedStyle(e).opacity);
    return {
      step: root?.getAttribute('data-step') ?? null,
      scored: ids('.glyph.scored').length,
      lifted: ids('.glyph.lifted'),
      open: ids('.glyph.open:not(.mine)'),
      litEdges: ids('.glyph line.lit'),
      visibleResults: resOpacity.filter((o) => o !== '0').length,
      transforms: [...document.querySelectorAll('.glyph:not(.mine)')].map((e) => e.style.transform),
      raw: document.querySelector('.lm-raw')?.textContent,
      operation: document.querySelector('.lm-operation')?.textContent,
      source: document.querySelector('.lm-source')?.textContent,
    };
  `);
}

async function layoutProblems(page: Page): Promise<{ smallest: number; outside: string[]; scrolls: boolean }> {
  return inPage(page, `
    const svg = document.querySelector('.learning-memory svg');
    if (!svg) throw new Error('The scene has no svg');
    const scale = svg.getScreenCTM()?.a ?? 1;
    const shown = (el) => {
      for (let node = el; node && node !== svg; node = node.parentElement) if (getComputedStyle(node).opacity === '0') return false;
      return true;
    };
    const texts = [...svg.querySelectorAll('text')].filter((t) => (t.textContent ?? '').trim() !== '' && shown(t));
    const sizes = texts.map((t) => parseFloat(getComputedStyle(t).fontSize) * scale);
    const html = [...document.querySelectorAll('.lm-header *, .lm-raw, .lm-raw *')].filter((e) => e.children.length === 0 && (e.textContent ?? '').trim() !== '').map((e) => parseFloat(getComputedStyle(e).fontSize));
    const outside = texts
      .filter((t) => {
        const r = t.getBoundingClientRect();
        return r.left < -0.5 || r.top < -0.5 || r.right > window.innerWidth + 0.5 || r.bottom > window.innerHeight + 0.5;
      })
      .map((t) => t.textContent ?? '');
    const doc = document.documentElement;
    return { smallest: Math.min(...sizes, ...html), outside, scrolls: doc.scrollHeight > window.innerHeight || doc.scrollWidth > window.innerWidth };
  `);
}

test.describe('Learning memory scene', () => {
  for (const viewport of VIEWPORTS) {
    test(`every step fits ${viewport.width}x${viewport.height} with text of at least ${MIN_TEXT_PX}px and no scrolling`, async ({ page }) => {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      await page.setViewportSize(viewport);
      await open(page, PLAYER);
      const hashes: string[] = [];
      for (let step = 0; step <= LAST_STEP + 1; step++) {
        await page.waitForTimeout(SETTLE_MS);
        const problems = await layoutProblems(page);
        expect(problems.scrolls, `step ${step} scrolls`).toBe(false);
        expect(problems.outside, `step ${step} has text outside the screen`).toEqual([]);
        expect(problems.smallest, `step ${step} has text under ${MIN_TEXT_PX}px`).toBeGreaterThanOrEqual(MIN_TEXT_PX);
        const file = `${EVIDENCE_DIR}step${step}-${viewport.width}x${viewport.height}.png`;
        const png = await page.screenshot({ path: file });
        hashes.push(`${createHash('sha256').update(png).digest('hex')}  step${step}-${viewport.width}x${viewport.height}.png`);
        await page.keyboard.press('ArrowRight');
      }
      writeFileSync(`${EVIDENCE_DIR}screenshots-${viewport.width}x${viewport.height}.sha256`, `${hashes.join('\n')}\n`);
    });
  }

  test('nothing from the search is visible before it completes, and what is lifted and lit is exactly what the search admitted', async ({ page }) => {
    await open(page, PLAYER);
    await advance(page, 3);
    const beforeSearch = await stateOf(page);
    expect(beforeSearch.step).toBe('3');
    expect(beforeSearch.scored).toBe(0);
    expect(beforeSearch.litEdges).toEqual([]);
    expect(beforeSearch.visibleResults).toBe(0);

    await advance(page, 1);
    const searched = await stateOf(page);
    expect(searched.step).toBe('4');
    expect(searched.scored).toBe(search.candidateCount);
    expect(searched.lifted).toEqual([]);
    expect(searched.visibleResults, 'results stay hidden until the cases are lifted').toBe(0);
    expect(searched.litEdges).toEqual([...new Set(search.admitted.flatMap((a) => a.matchedEdgeIds))].sort());
    expect(searched.transforms, 'a search never moves a tile').toEqual(beforeSearch.transforms);

    await advance(page, 1);
    const lifted = await stateOf(page);
    expect(lifted.lifted).toEqual(search.admitted.map((a) => a.caseId).sort());
    expect(lifted.open).toEqual(lifted.lifted);
    expect(search.decision.evidenceIds.every((id) => lifted.lifted.includes(id))).toBe(true);
    await expect(page.locator('.lm-raw')).toContainText(`ranked=${search.candidateCount}`);

    await advance(page, 1);
    const chosen = await stateOf(page);
    expect(chosen.step).toBe('6');
    await expect(page.getByText(`${search.decision.groups[0]?.independent}/${search.decision.groups[0]?.total} solved alone`).first()).toBeVisible();
  });

  test('the committed outcome adds +1 NEW and a result, and the source chip says simulation and not saved', async ({ page }) => {
    await open(page, PLAYER);
    await advance(page, LAST_STEP + 1);
    const done = await stateOf(page);
    expect(done.step).toBe('outcome');
    expect(done.source).toBe('Simulation · recorded agent input · synthetic cases · not saved');
    await expect(page.getByText('+1 NEW')).toBeVisible();
    await expect(page.locator('.lm-raw')).toContainText('outcome.committed');
    await expect(page.locator('.glyph.fresh')).toHaveCount(1);
    expect(done.operation).toContain('Solved alone');
    await expect(page.getByText('Local preview · not saved')).toBeVisible();
  });

  test('reduced motion gives the same final state', async ({ browser }) => {
    const finalState = async (reducedMotion: 'reduce' | 'no-preference') => {
      const context = await browser.newContext({ reducedMotion, viewport: VIEWPORTS[0] });
      const page = await context.newPage();
      await open(page, PLAYER);
      await advance(page, LAST_STEP + 1);
      const state = await stateOf(page);
      const transitions = await inPage<string>(page, "return getComputedStyle(document.querySelector('.glyph')).transitionDuration;");
      await context.close();
      return { state, transitions };
    };
    const normal = await finalState('no-preference');
    const reduced = await finalState('reduce');
    expect(reduced.state).toEqual(normal.state);
    expect(reduced.transitions).toBe('0s');
    expect(normal.transitions).not.toBe('0s');
  });

  test('axe passes on every story', async ({ page }) => {
    test.setTimeout(180_000);
    for (const id of STORY_IDS) {
      await open(page, id);
      await page.waitForTimeout(500);
      const result = await new AxeBuilder({ page }).analyze();
      expect(result.violations, id).toEqual([]);
    }
  });

  test('p95 frame time over a 10-second scene is measured and reported', async ({ page }, testInfo) => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.setViewportSize(VIEWPORTS[0]);
    await open(page, PLAYER);
    await page.waitForTimeout(SETTLE_MS);
    await inPage<void>(page, `
      const frames = [];
      let last = performance.now();
      const sample = (now) => {
        frames.push(now - last);
        last = now;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      window.frameSamples = frames;
    `);
    // Ten seconds through the whole scene: a step about every 1.25 s, then the outcome.
    for (let step = 0; step <= LAST_STEP; step++) {
      await page.waitForTimeout(1250);
      await page.keyboard.press('ArrowRight');
    }
    await page.waitForTimeout(2500);
    const frames = await inPage<number[]>(page, 'return window.frameSamples;');
    const sorted = [...frames].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
    const report = { frames: frames.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: sorted.at(-1) ?? 0, targetMs: 33 };
    writeFileSync(`${EVIDENCE_DIR}frame-times.json`, `${JSON.stringify(report, null, 2)}\n`);
    testInfo.annotations.push({ type: 'p95 frame time', description: `${report.p95Ms.toFixed(1)} ms over ${report.frames} frames` });
    console.log(`p95 frame time ${report.p95Ms.toFixed(1)} ms (p50 ${report.p50Ms.toFixed(1)}, p99 ${report.p99Ms.toFixed(1)}, max ${report.maxMs.toFixed(1)}) over ${report.frames} frames; target <= ${report.targetMs} ms`);
    expect(report.frames).toBeGreaterThan(100);
  });

  test('the 3D graph draws every learner and unmounting releases the renderer, geometry and materials', async ({ page }) => {
    await page.setViewportSize(VIEWPORTS[0]);
    await open(page, GRAPH_3D);
    const nodes = Number(await page.locator('.graph-canvas').getAttribute('data-nodes'));
    expect(nodes).toBeGreaterThan(5000);
    // The canvas has real content: its frame compresses far worse than the empty page left after unmounting.
    await page.waitForTimeout(1000);
    const clip = { x: 0, y: 100, width: 800, height: 500 };
    const withScene = (await page.screenshot({ clip })).length;
    await page.keyboard.press('u');
    await expect(page.locator('[data-disposal]')).toHaveCount(1);
    const report = JSON.parse((await page.locator('[data-disposal]').getAttribute('data-disposal')) ?? '{}') as { geometriesBefore: number; geometriesAfter: number; disposedGeometries: number; disposedMaterials: number; rendererDisposed: boolean };
    expect(report.rendererDisposed).toBe(true);
    expect(report.geometriesBefore).toBeGreaterThan(0);
    expect(report.geometriesAfter).toBe(0);
    expect(report.disposedGeometries).toBeGreaterThan(0);
    expect(report.disposedMaterials).toBeGreaterThan(0);
    await expect(page.locator('canvas')).toHaveCount(0);
    expect(withScene).toBeGreaterThan((await page.screenshot({ clip })).length * 2);
  });

  test('p95 frame time of the 3D graph over 10 seconds is measured and reported', async ({ page }, testInfo) => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    await page.setViewportSize(VIEWPORTS[0]);
    await open(page, GRAPH_3D);
    await page.waitForTimeout(1000);
    const frames = await inPage<number[]>(page, `
      return new Promise((resolve) => {
        const deltas = [];
        const start = performance.now();
        let last = start;
        const sample = (now) => {
          deltas.push(now - last);
          last = now;
          if (now - start < 10000) requestAnimationFrame(sample);
          else resolve(deltas);
        };
        requestAnimationFrame(sample);
      });
    `);
    const sorted = [...frames].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
    const report = { frames: frames.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: sorted.at(-1) ?? 0, targetMs: 33 };
    writeFileSync(`${EVIDENCE_DIR}frame-times-3d.json`, `${JSON.stringify(report, null, 2)}\n`);
    testInfo.annotations.push({ type: 'p95 frame time 3D', description: `${report.p95Ms.toFixed(1)} ms over ${report.frames} frames` });
    console.log(`3D p95 frame time ${report.p95Ms.toFixed(1)} ms (p50 ${report.p50Ms.toFixed(1)}, p99 ${report.p99Ms.toFixed(1)}, max ${report.maxMs.toFixed(1)}) over ${report.frames} frames; target <= ${report.targetMs} ms`);
    expect(report.frames).toBeGreaterThan(5);
  });

  test('the opening highlights exactly the recalled cases and the three concept links, with no result slots yet', async ({ page }) => {
    const personal = CaseSchema.array().parse(readJson('seed/cases.json')).filter((c) => c.studentId === query.studentId && c.concept === 'subtraction_within_20' && c.outcome !== 'independent');
    await open(page, 'backend-learning-memory--opening-memory-recalled');
    await expect(page.locator('.glyph.mine.recalled')).toHaveCount(personal.length);
    await expect(page.locator('.concept-link')).toHaveCount(3);
    await expect(page.locator('.concept-link.similar')).toHaveCount(1);
    await expect(page.locator('.slot')).toHaveCount(0);
    await expect(page.locator('.lm-operation')).toHaveText('Recalling what this student has learned before');
  });
});
