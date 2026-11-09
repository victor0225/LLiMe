import { useSyncExternalStore } from 'react';
import type { RunEvent } from '@core/events';
import { ROUTES, routePath } from '@core/routes';

// One request a second keeps every screen close to live without a push channel.
export const EVENT_POLL_INTERVAL_MS = 1000;

export type EventStoreSnapshot = {
  readonly events: readonly RunEvent[];
  readonly lastSeq: number;
  // `paused`: the server could not be reached and the next poll retries. `failed` is final: an
  // unknown run, an unreadable response or a missing event, because showing events after a gap
  // would present a history that never happened.
  readonly status: 'idle' | 'live' | 'paused' | 'failed';
  readonly error: string | null;
};

export type EventStore = {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => EventStoreSnapshot;
  start: () => void;
  stop: () => void;
};

// The single ordered event feed for one run. Readers share it through useRunEvents.
export function createEventStore(runId: string, fetchEvents: typeof fetch = fetch): EventStore {
  let snapshot: EventStoreSnapshot = { events: [], lastSeq: 0, status: 'idle', error: null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  const listeners = new Set<() => void>();

  const publish = (next: EventStoreSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const fail = (error: string) => publish({ ...snapshot, status: 'failed', error });
  const pause = () => {
    if (snapshot.status !== 'paused') publish({ ...snapshot, status: 'paused' });
  };

  // Events must continue the feed exactly: seq lastSeq + 1, lastSeq + 2, ...
  const append = (incoming: readonly RunEvent[]) => {
    const continues = incoming.every((event, index) => event.seq === snapshot.lastSeq + index + 1);
    if (!continues) return fail(`Events after seq ${snapshot.lastSeq} arrived out of order`);
    const last = incoming.at(-1);
    if (last || snapshot.status !== 'live') publish({ events: [...snapshot.events, ...incoming], lastSeq: last?.seq ?? snapshot.lastSeq, status: 'live', error: null });
  };

  const pollOnce = async () => {
    let response: Response;
    try {
      response = await fetchEvents(`${routePath('runEvents', { runId })}?after=${snapshot.lastSeq}`, { headers: { accept: 'application/json' } });
    } catch {
      // The run's state lives on the server, so a lost connection loses nothing; the next poll retries.
      return pause();
    }
    if (response.status >= 500) return pause();
    if (!response.ok) return fail(`Event poll failed with HTTP ${response.status}`);
    const events = ROUTES.runEvents.response.safeParse(await response.json().catch(() => null));
    if (!events.success) return fail('The server sent events in an unexpected shape');
    append(events.data);
  };

  const poll = async () => {
    await pollOnce();
    // The next poll starts only after this one finished, so responses cannot arrive out of order.
    if (running && snapshot.status !== 'failed') timer = setTimeout(poll, EVENT_POLL_INTERVAL_MS);
  };

  return {
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getSnapshot: () => snapshot,
    start: () => {
      if (running) return;
      running = true;
      void poll();
    },
    stop: () => {
      running = false;
      clearTimeout(timer);
    },
  };
}

export function useRunEvents(store: EventStore): EventStoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot);
}
