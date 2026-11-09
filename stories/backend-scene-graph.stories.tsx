import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { CaseSchema, validateCase } from '@core/domain';
import { buildSearchResult, chooseActivity, rank, rankingHash } from '@core/search';
import { createProjection, indexCorpus, project, type ProjectionSnapshot, type ViewEvent } from '../web/backend/event-projection';
import { GraphCanvas, type DisposalReport } from '../web/backend/GraphCanvas';
import '../web/styles/backend-scene.css';
import seedCases from '../data/seed/cases.json';
import seedManifest from '../data/seed/manifest.json';
import recordedCapture from '../data/captures/backend.capture.json';

const RUN_ID = 'recorded-replay';
const cases = CaseSchema.array().parse(seedCases);
const query = validateCase(recordedCapture.query);

// The finished search over the pinned corpus, built by the same search module the server uses.
async function searched(): Promise<ProjectionSnapshot> {
  const ranked = rank(query, cases);
  const search = buildSearchResult({ query, corpusHash: seedManifest.sha256, ranked, decision: chooseActivity(query, ranked, false), rankingHash: await rankingHash(ranked) });
  const events: ViewEvent[] = [
    { runId: RUN_ID, sequence: 0, type: 'graph.updated', payload: { graph: query } },
    { runId: RUN_ID, sequence: 1, type: 'search.started', payload: { matchingVersion: search.matchingVersion, queryId: query.id, candidateCount: search.candidateCount, queryNodeIds: query.nodes.map((n) => n.id) } },
    { runId: RUN_ID, sequence: 2, type: 'search.completed', payload: search },
  ];
  return events.reduce(project, createProjection(RUN_ID, indexCorpus(cases)));
}

// The canvas mounts and unmounts on a key press so a test can read what was released on the way out.
function Graph3D() {
  const [snapshot, setSnapshot] = useState<ProjectionSnapshot | null>(null);
  const [mounted, setMounted] = useState(true);
  const [report, setReport] = useState<DisposalReport | null>(null);
  useEffect(() => {
    void searched().then(setSnapshot);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'u' || e.key === 'U') setMounted((on) => !on);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!snapshot) return null;
  return (
    <main className="learning-memory" style={{ gridTemplateRows: 'minmax(0, 1fr)' }} data-disposal={report ? JSON.stringify(report) : undefined}>
      {mounted ? <GraphCanvas snapshot={snapshot} cases={cases} reveal="chosen" onDisposed={setReport} /> : <p role="status" className="lm-operation">3D view closed</p>}
    </main>
  );
}

const meta = { title: 'Backend/3D graph', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;

// The memory of every learner in 3D, after the search; press U to unmount and release the scene.
export const SearchedMemory: StoryObj<typeof meta> = { render: () => <Graph3D /> };
