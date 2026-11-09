/// <reference types="vite/client" />
// Live adapter: turns the server's saved run events into the ordered view events the projection reads,
// and follows one run through the shared event store. Reads only this app's own polling routes.
import { useEffect, useMemo, useState } from 'react';
import { CaseSchema, type LearningCase, type Problem } from '@core/domain';
import { z } from 'zod';
import type { EventType, RunEvent } from '@core/events';
import { createEventStore, type EventStore, type RunView } from '../lib/event-store.js';
import { advancePast, type CorpusIndex, createProjection, project, PROJECTED_EVENT_TYPES, type ProjectedEventType, type ProjectionSnapshot, ProjectionRejectedError, type ViewEvent } from './event-projection.js';

// Every run event type is either projected or dropped on purpose. Typing the table over the full event
// vocabulary makes a newly added event a compile error until someone decides which it is.
export const EVENT_DISPOSITION: Readonly<Record<EventType, 'project' | 'drop'>> = {
  'memory.retrieved': 'project',
  'runtime.input': 'project',
  'tool.started': 'project',
  'tool.completed': 'project',
  'tool.failed': 'project',
  'runtime.message': 'project',
  'runtime.completed': 'project',
  'graph.updated': 'project',
  'search.started': 'project',
  'search.completed': 'project',
  'operation.failed': 'project',
  'outcome.committed': 'project',
  // Transport, voice and bookkeeping events say nothing the scene draws. The tool and graph events carry the
  // same facts, so dropping these loses no evidence.
  'state.committed': 'drop',
  'lesson.detected': 'drop',
  'operation.started': 'drop',
  'operation.cancelled': 'drop',
  'runtime.boundary': 'drop',
  'runtime.item': 'drop',
  'context.committed': 'drop',
  'activity.published': 'drop',
  'notification.queued': 'drop',
  'notification.sent': 'drop',
  'notification.opened': 'drop',
  'voice.delegated': 'drop',
  'voice.commentary': 'drop',
  'turn.steered': 'drop',
};

const isProjected = (type: EventType): type is ProjectedEventType => EVENT_DISPOSITION[type] === 'project' && (PROJECTED_EVENT_TYPES as readonly string[]).includes(type);

export interface EventAdapter {
  // The view event for a run event, or null when the event is dropped.
  accept: (event: RunEvent) => ViewEvent | null;
}

// Stateful because the view numbering and the elapsed clock both depend on the events seen so far.
// Elapsed time is measured from the latest runtime.input, the moment the agent received its instructions.
export function createEventAdapter(): EventAdapter {
  let next = 0;
  let inputAt: number | null = null;
  return {
    accept: (event) => {
      if (!isProjected(event.type)) return null;
      const at = Date.parse(event.at);
      if (event.type === 'runtime.input') inputAt = at;
      const elapsed = inputAt === null ? {} : { elapsedMs: Math.max(0, at - inputAt) };
      // The union is correlated by `type`; spreading the envelope keeps each payload with its own type.
      const view = { runId: event.runId, sequence: next++, type: event.type, payload: event.payload, ...elapsed } as ViewEvent;
      return view;
    },
  };
}

export function adaptRunEvents(events: readonly RunEvent[]): ViewEvent[] {
  const adapter = createEventAdapter();
  return events.flatMap((event) => {
    const view = adapter.accept(event);
    return view ? [view] : [];
  });
}

// Folds view events into a snapshot. An event the projection rejects is logged and skipped, so one
// out-of-scope event (for example a second explanation with a new query ID) cannot stop the view.
export function foldViewEvents(runId: string, corpus: CorpusIndex | null, events: readonly ViewEvent[], from: ProjectionSnapshot = createProjection(runId, corpus)): ProjectionSnapshot {
  return events.reduce((snapshot, event) => {
    try {
      return project(snapshot, event);
    } catch (error) {
      if (!(error instanceof ProjectionRejectedError)) throw error;
      console.error(`Event ${event.type} was not applied: ${error.message}`);
      return advancePast(snapshot, event);
    }
  }, from);
}

export interface LiveRun {
  readonly snapshot: ProjectionSnapshot;
  readonly status: RunView['status'];
  readonly error: string | null;
  // The last event the view applied, with its real elapsed time, for the footer line.
  readonly raw: ViewEvent | null;
  // From the saved run state, for wording the scene cannot take from events.
  readonly problem: Problem | null;
  readonly corpusHash: string | null;
  // The saved run events, for views that look a saved call up by its ID.
  readonly events: readonly RunEvent[];
  readonly lessonText: string | null;
}

// Follows one run. The snapshot is rebuilt from the store's full event list whenever it grows, so a store
// reload after a gap or a reconnect restarts the view from a consistent history.
export function useLiveRun(runId: string, corpus: CorpusIndex | null, store?: EventStore): LiveRun {
  const [own] = useState(() => store ?? createEventStore(runId));
  const [view, setView] = useState<RunView>(() => own.getSnapshot());
  useEffect(() => {
    const sync = () => setView(own.getSnapshot());
    const unsubscribe = own.subscribe(sync);
    own.start();
    sync();
    return () => {
      unsubscribe();
      own.stop();
    };
  }, [own]);
  const snapshot = useMemo(() => foldViewEvents(runId, corpus, adaptRunEvents(view.events)), [runId, corpus, view.events]);
  return { snapshot, status: view.status, error: view.error, raw: snapshot.raw, problem: view.run?.selectedProblems?.initial ?? null, corpusHash: view.run?.corpusHash ?? null, events: view.events, lessonText: view.run?.lesson?.text ?? null };
}

// The pinned corpus the search ran over, loaded on demand so the main bundle stays small. The scene draws
// every branch from it; it never decides anything.
const corpusFiles = (): Record<string, () => Promise<unknown>> => import.meta.glob('../../data/seed/cases.json', { import: 'default' });
const manifestFiles = (): Record<string, () => Promise<unknown>> => import.meta.glob('../../data/seed/manifest.json', { import: 'default' });

export interface Corpus {
  readonly cases: readonly LearningCase[];
  // The hash a run records when it pins this corpus.
  readonly corpusHash: string;
}

export async function loadCorpus(): Promise<Corpus> {
  const [cases] = Object.values(corpusFiles());
  const [manifest] = Object.values(manifestFiles());
  if (!cases || !manifest) throw new Error('The case corpus is not part of this build');
  const { sha256 } = z.object({ sha256: z.string() }).parse(await manifest());
  return { cases: CaseSchema.array().parse(await cases()), corpusHash: sha256 };
}

export function useCorpus(): { corpus: Corpus | null; error: string | null } {
  const [state, setState] = useState<{ corpus: Corpus | null; error: string | null }>({ corpus: null, error: null });
  useEffect(() => {
    let live = true;
    loadCorpus().then(
      (corpus) => live && setState({ corpus, error: null }),
      (error: unknown) => live && setState({ corpus: null, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
