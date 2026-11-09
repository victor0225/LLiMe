import { useSyncExternalStore } from 'react';
import type { ErrorBody } from '@core/domain';
import { type RunEvent, type RunSnapshot, RunSnapshotSchema } from '@core/events';
import { BootstrapSchema, HttpErrorSchema, ROUTES, type RouteName, routePath, SESSION_HEADER } from '@core/routes';
import type { z } from 'zod';

// One request a second keeps every screen close to live without a push channel.
export const EVENT_POLL_INTERVAL_MS = 1000;

export type RunView = {
  // The last committed run state; replaced only by a snapshot that is at least as new.
  readonly run: RunSnapshot | null;
  readonly events: readonly RunEvent[];
  readonly lastSeq: number;
  // `reconnecting`: the server could not be reached; polling retries and then reloads the run.
  // `failed` is final: an unknown run or a response this app cannot read.
  readonly status: 'loading' | 'live' | 'reconnecting' | 'failed';
  readonly error: string | null;
};

type Routes = typeof ROUTES;
// POST routes that act on one run. They share the run's single mutation queue.
export type RunMutation = Exclude<{ [N in RouteName]: Routes[N]['method'] extends 'POST' ? N : never }[RouteName], 'createRun'>;
type MutationBody<N extends RunMutation> = z.input<Routes[N]['request']>;
type MutationResult<N extends RunMutation> = z.output<Routes[N]['response']>;
type ExtraParams = Omit<NonNullable<Parameters<typeof routePath>[1]>, 'runId'>;

export type Schedule = (task: () => Promise<void>, delayMs: number) => () => void;

export type EventStore = {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => RunView;
  start: () => void;
  stop: () => void;
  // Queues a mutation behind any pending one for this run. `buildBody` runs when the request is
  // actually sent, with the latest run, so it reads the current revision; it returns null to drop
  // an action whose target (activity, revision or voice session) is no longer current.
  sendRunCommand: <N extends RunMutation>(name: N, buildBody: (run: RunSnapshot) => MutationBody<N> | null, params?: ExtraParams) => Promise<MutationResult<N> | null>;
};

// An error answer from the server. `body` is null when the answer was not a shared error body,
// for example a proxy error while the app server is down.
export class RunRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody | null,
  ) {
    super(body?.message ?? `The server answered HTTP ${status}`);
  }
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`The server answered HTTP ${status}`);
  }
}

// A lost connection or a 5xx is temporary; anything else will not fix itself by retrying.
const isTemporary = (error: unknown) => (error instanceof HttpStatusError ? error.status >= 500 : error instanceof TypeError);

const defaultSchedule: Schedule = (task, delayMs) => {
  const timer = setTimeout(() => void task(), delayMs);
  return () => clearTimeout(timer);
};

// The single ordered feed and command queue for one run. Screens read it through useRunEvents.
export function createEventStore(runId: string, { fetch: request = fetch, schedule = defaultSchedule }: { fetch?: typeof fetch; schedule?: Schedule } = {}): EventStore {
  let view: RunView = { run: null, events: [], lastSeq: 0, status: 'loading', error: null };
  let mustReload = true;
  let running = false;
  let cancelPoll = () => {};
  let nonce: string | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();

  const publish = (next: Partial<RunView>) => {
    view = { ...view, ...next };
    for (const listener of listeners) listener();
  };

  const getJson = async (path: string): Promise<unknown> => {
    const response = await request(path, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new HttpStatusError(response.status);
    return response.json();
  };
  const loadRun = async () => ROUTES.getRun.response.parse(await getJson(routePath('getRun', { runId })));

  // A replayed or slow answer can carry an older snapshot; it never replaces a newer one.
  const applyRun = (run: RunSnapshot) => {
    if (!view.run || run.seq >= view.run.seq) publish({ run });
  };
  const refreshRun = async () => applyRun(await loadRun());

  // Restarts the feed from a consistent snapshot: its saved execution events, then polling after its seq.
  const reload = async () => {
    const run = await loadRun();
    publish({ run, events: run.execution.events, lastSeq: run.seq });
    mustReload = false;
  };

  // Returns false when an event is missing, because rendering past a gap would show a history
  // that never happened.
  const append = (incoming: readonly RunEvent[]) => {
    const fresh = incoming.filter((event) => event.seq > view.lastSeq);
    if (!fresh.every((event, index) => event.seq === view.lastSeq + index + 1)) return false;
    const last = fresh.at(-1);
    if (last) publish({ events: [...view.events, ...fresh], lastSeq: last.seq });
    return true;
  };

  const poll = async () => {
    try {
      if (mustReload) await reload();
      const events = ROUTES.runEvents.response.parse(await getJson(`${routePath('runEvents', { runId })}?after=${view.lastSeq}`));
      if (!append(events)) mustReload = true;
      const revision = view.run?.revision ?? -1;
      if (events.some((event) => event.type === 'state.committed' && event.payload.revision > revision)) await refreshRun();
      if (view.status !== 'live') publish({ status: 'live', error: null });
    } catch (error) {
      if (!isTemporary(error)) return publish({ status: 'failed', error: error instanceof Error ? error.message : String(error) });
      mustReload = true;
      if (view.status !== 'reconnecting') publish({ status: 'reconnecting' });
    }
    if (running) cancelPoll = schedule(poll, EVENT_POLL_INTERVAL_MS);
  };

  const sessionNonce = async () => (nonce ??= BootstrapSchema.parse(await getJson(routePath('bootstrap'))).nonce);
  const post = async (path: string, body: unknown) =>
    request(path, { method: 'POST', headers: { 'content-type': 'application/json', [SESSION_HEADER]: await sessionNonce() }, body: JSON.stringify(body) });

  const send = async <N extends RunMutation>(name: N, buildBody: (run: RunSnapshot) => MutationBody<N> | null, params: ExtraParams): Promise<MutationResult<N> | null> => {
    const run = view.run ?? (await loadRun());
    applyRun(run);
    const body = buildBody(run);
    if (body === null) return null;
    const route = ROUTES[name];
    const path = routePath(name, { ...params, runId });
    const valid = route.request.parse(body);
    let response = await post(path, valid);
    if (response.status === 403) {
      // The nonce rotates when the server restarts. Resending the same command ID is safe: the
      // server deduplicates it.
      nonce = null;
      response = await post(path, valid);
    }
    const answer: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = HttpErrorSchema.safeParse(answer);
      // A conflict means this page is behind: refresh, and leave any retry to the person. If the
      // refresh fails too, the poll reloads the run once the server answers.
      if (response.status === 409) await refreshRun().catch(() => (mustReload = true));
      throw new RunRequestError(response.status, error.success ? error.data : null);
    }
    // The value was just parsed by this route's own response schema; TypeScript cannot follow the
    // generic route key through the table lookup, so it is named here.
    const result = route.response.parse(answer) as MutationResult<N>;
    const snapshot = RunSnapshotSchema.safeParse(result);
    if (snapshot.success) applyRun(snapshot.data);
    else await refreshRun();
    return result;
  };

  return {
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getSnapshot: () => view,
    start: () => {
      if (running) return;
      running = true;
      cancelPoll = schedule(poll, 0);
    },
    stop: () => {
      running = false;
      cancelPoll();
    },
    sendRunCommand: (name, buildBody, params = {}) => {
      const result = queue.then(() => send(name, buildBody, params));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}

export function useRunEvents(store: EventStore): RunView {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
