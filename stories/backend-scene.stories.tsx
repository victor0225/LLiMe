import { useEffect, useMemo, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { CaseSchema, ConceptLinkSchema, type ConceptLink, type LearningCase, type MemorySummary, validateCase } from '@core/domain';
import { buildSearchResult, chooseActivity, rank, rankingHash } from '@core/search';
import type { RawLine } from '../web/backend/learning-copy';
import { createProjection, indexCorpus, project, type ProjectionSnapshot, type ViewEvent } from '../web/backend/event-projection';
import { LearningMemoryScene, LiveBackendScene, type Reveal } from '../web/backend/LearningMemoryScene';
import '../web/styles/backend-scene.css';
import seedCases from '../data/seed/cases.json';
import seedLinks from '../data/seed/concept-links.json';
import seedManifest from '../data/seed/manifest.json';
import recordedCapture from '../data/captures/backend.capture.json';

// The recorded agent input that drives the replay. Search, admission and grouping are computed by the same
// search module the server uses, over the same pinned corpus, so the replay shows what a run would show.
const RUN_ID = 'recorded-replay';
const cases = CaseSchema.array().parse(seedCases);
const links: ConceptLink[] = ConceptLinkSchema.array().parse(seedLinks);
const corpus = indexCorpus(cases);
const query = validateCase(recordedCapture.query);

type AgentEvent = { type: string; payload: Record<string, unknown> };
const agentEvents = recordedCapture.events as AgentEvent[];

const only = (types: readonly string[]): LearningCase => {
  const keep = new Set(query.nodes.filter((n) => types.includes(n.type)).map((n) => n.id));
  return { ...query, nodes: query.nodes.filter((n) => keep.has(n.id)), edges: query.edges.filter((e) => keep.has(e.from) && keep.has(e.to)) };
};
const BASE_TYPES = ['Attempt', 'Concept'];

// A step either feeds accepted events to the projection or advances what is shown of data already accepted.
// `recorded` is the agent's own recorded text for the footer: it is shown as recorded and never projected.
type Step = { readonly events: readonly ViewEvent[]; readonly raw: ViewEvent['type']; readonly recorded?: undefined } | { readonly events: readonly ViewEvent[]; readonly raw?: undefined; readonly recorded: RawLine } | { readonly reveal: Reveal };

interface Trace {
  // Applied before step 0: the attempt and its concept are already in this learner's memory.
  readonly preamble: ViewEvent;
  readonly steps: readonly Step[];
  readonly outcome: ViewEvent;
}

async function buildTrace(outcome: 'independent' | 'failed'): Promise<Trace> {
  const ranked = rank(query, cases);
  const search = buildSearchResult({ query, corpusHash: seedManifest.sha256, ranked, decision: chooseActivity(query, ranked, false), rankingHash: await rankingHash(ranked) });
  let sequence = 0;
  const next = <E extends ViewEvent>(event: Omit<E, 'runId' | 'sequence'>): E => ({ runId: RUN_ID, sequence: sequence++, ...event }) as E;
  const input = agentEvents.find((e) => e.type === 'runtime.input');
  const started = agentEvents.find((e) => e.type === 'tool.started');
  const message = agentEvents.find((e) => e.type === 'runtime.message');
  if (!input || !started || !message) throw new Error('The recorded input is missing an agent event');
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const explanation = text((input.payload.input as { explanation?: unknown } | undefined)?.explanation);
  const base = next({ type: 'graph.updated', payload: { graph: only(BASE_TYPES) } });
  const recordedLine = (type: string, ...fields: string[]): RawLine => ({ type: `${type} · recorded`, fields });
  const observed = next({ type: 'graph.updated', payload: { graph: only([...BASE_TYPES, 'Observation', 'Explanation']) } });
  const reasoned = next({ type: 'graph.updated', payload: { graph: only([...BASE_TYPES, 'Observation', 'Explanation', 'Hypothesis']) } });
  const searched = [
    next({ type: 'search.started', payload: { matchingVersion: search.matchingVersion, queryId: query.id, candidateCount: search.candidateCount, queryNodeIds: query.nodes.filter((n) => n.stage === 'context').map((n) => n.id) } }),
    next({ type: 'search.completed', payload: search }),
  ];
  const strategy = search.decision.strategy;
  const attempt = query.nodes.find((n) => n.type === 'Attempt');
  if (!attempt) throw new Error('The recorded query has no attempt');
  const id = (suffix: string) => `${query.id}:${suffix}`;
  const sourceId = id('evaluation');
  const committed = next({
    type: 'outcome.committed',
    payload: {
      queryId: query.id,
      persistedCaseId: query.id,
      strategy,
      outcome,
      saved: false,
      nodes: [
        { id: id('intervention'), type: 'Intervention', meaning: strategy, stage: 'result', sourceIds: [sourceId] },
        { id: id('outcome'), type: 'Outcome', meaning: outcome, stage: 'result', sourceIds: [sourceId] },
      ],
      edges: [
        { id: id('intervention-link'), from: attempt.id, to: id('intervention'), type: 'FOLLOWED_BY', stage: 'result' },
        { id: id('outcome-link'), from: id('intervention'), to: id('outcome'), type: 'EVALUATED_BY', stage: 'result' },
      ],
      source: { id: sourceId, text: JSON.stringify({ strategy, outcome }) },
    },
  });
  return {
    preamble: base,
    outcome: committed,
    steps: [
      { events: [], recorded: recordedLine('runtime.input', `model=${text(input.payload.model)}`, `input="${explanation}"`) },
      { events: [observed], raw: 'graph.updated' },
      { events: [reasoned], recorded: recordedLine('runtime.message', `tool=${text(started.payload.name)}`, `"${text(message.payload.text)}"`) },
      { events: searched, raw: 'search.completed' },
      { reveal: 'lifted' },
      { reveal: 'chosen' },
    ],
  };
}

interface Replay {
  readonly snapshot: ProjectionSnapshot;
  readonly raw: ViewEvent | null;
  readonly recorded: RawLine | null;
  readonly reveal: Reveal;
}

function replay(trace: Trace, cursor: number, committed: boolean): Replay {
  let snapshot = project(createProjection(RUN_ID, corpus), trace.preamble);
  let raw: ViewEvent | null = null;
  let recorded: RawLine | null = null;
  let reveal: Reveal = 'none';
  for (const step of trace.steps.slice(0, cursor)) {
    if ('reveal' in step) {
      reveal = step.reveal;
      continue;
    }
    for (const event of step.events) {
      snapshot = project(snapshot, event);
      if (event.type === step.raw) {
        raw = event;
        recorded = null;
      }
    }
    if (step.recorded) {
      recorded = step.recorded;
      raw = null;
    }
  }
  if (committed) {
    snapshot = project(snapshot, trace.outcome);
    raw = trace.outcome;
    recorded = null;
  }
  return { snapshot, raw, recorded, reveal };
}

const FORWARD = new Set(['ArrowRight', 'PageDown', ' ']);
const BACK = new Set(['ArrowLeft', 'PageUp']);

// The operator presses a key per step; nothing is timed. Back replays from the start.
function ExecutionPlayer({ startStep = 0, outcome = 'independent', startCommitted = false }: { startStep?: number; outcome?: 'independent' | 'failed'; startCommitted?: boolean }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const [cursor, setCursor] = useState(startStep);
  const [committed, setCommitted] = useState(startCommitted);
  const [hint, setHint] = useState(false);

  useEffect(() => {
    let live = true;
    void buildTrace(outcome).then((built) => live && setTrace(built));
    return () => {
      live = false;
    };
  }, [outcome]);

  const total = trace?.steps.length ?? 0;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'h' || e.key === 'H') return setHint((on) => !on);
      if (FORWARD.has(e.key)) {
        e.preventDefault();
        if (cursor < total) setCursor(cursor + 1);
        else if (!committed) setCommitted(true);
      } else if (BACK.has(e.key)) {
        e.preventDefault();
        if (committed) setCommitted(false);
        else if (cursor > 0) setCursor(cursor - 1);
      } else if (e.key === 'r' || e.key === 'R') {
        setCursor(0);
        setCommitted(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cursor, total, committed]);

  const view = useMemo(() => (trace ? replay(trace, Math.min(cursor, total), committed) : null), [trace, cursor, total, committed]);
  if (!view) return null;
  return (
    <>
      <LearningMemoryScene snapshot={view.snapshot} reveal={view.reveal} rawEvent={view.raw} recordedLine={view.recorded} source="simulation" cases={cases} problem={{ lhs: 8, rhs: 5 }} />
      <p role="status" className="sr-only" style={{ position: 'fixed', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)' }}>{`Step ${cursor} of ${total}${committed ? ' · outcome' : ''}`}</p>
      {hint && (
        <div style={{ position: 'fixed', right: 24, top: 68, zIndex: 2, background: '#0e1319', border: '1px solid #2c3743', borderRadius: 6, padding: '10px 14px', font: '14px/1.6 system-ui', color: '#a9b6c3' }}>
          → next · ← back · R restart · H hide
          <br />
          Simulation · no live calls
        </div>
      )}
    </>
  );
}

// The opening: what the memory read returned for this learner, before any attempt exists.
function OpeningMemory() {
  const [view, setView] = useState<Replay | null>(null);
  useEffect(() => {
    const mine = cases.filter((c) => c.studentId === query.studentId);
    const summary = (concept: MemorySummary['conceptId'], link: MemorySummary['link']): MemorySummary => {
      const own = mine.filter((c) => c.concept === concept);
      const count = (outcome: string) => own.filter((c) => c.outcome === outcome).length;
      const times = own.map((c) => c.createdAt).sort();
      return { conceptId: concept, link, total: own.length, independent: count('independent'), assisted: count('assisted'), failed: count('failed'), notAssessed: count('not_assessed'), firstAt: times[0] ?? null, lastAt: times.at(-1) ?? null };
    };
    // Memory worth recalling for the invitation: earlier attempts on the linked concept that needed help.
    const recalled = mine.filter((c) => c.concept === 'subtraction_within_20' && c.outcome !== 'independent').map((c) => c.id);
    const event: ViewEvent = { runId: RUN_ID, sequence: 0, type: 'memory.retrieved', payload: { conceptIds: ['addition_within_20', 'subtraction_within_20'], caseIds: recalled, summaries: [summary('addition_within_20', 'today'), summary('subtraction_within_20', 'similar')], links } };
    setView({ snapshot: project(createProjection(RUN_ID, corpus), event), raw: event, recorded: null, reveal: 'none' });
  }, []);
  if (!view) return null;
  return <LearningMemoryScene snapshot={view.snapshot} reveal="none" rawEvent={view.raw} source="simulation" cases={cases} />;
}

const meta = { title: 'Backend/Learning memory', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

// Press → to step through the scene; ← goes back; R restarts; H shows the keys.
export const ExecutionAndGraph: Story = { render: () => <ExecutionPlayer /> };
// The same player opened on the chosen next step.
export const GraphOverview: Story = { render: () => <ExecutionPlayer startStep={6} /> };
// The independent check did not pass: the committed result reads "Not yet".
export const OutcomeNotYet: Story = { render: () => <ExecutionPlayer startStep={6} outcome="failed" startCommitted /> };
export const OpeningMemoryRecalled: Story = { render: () => <OpeningMemory /> };
// Follows a real run on this app's own server: open with ?args=runId:<id>.
export const LiveRun: StoryObj<{ runId: string }> = { args: { runId: '' }, render: ({ runId }) => (runId ? <LiveBackendScene runId={runId} /> : <p>Waiting for a run id</p>) };
