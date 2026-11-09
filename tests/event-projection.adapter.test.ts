import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EVENT_TYPES, type EventType, type RunEvent } from '../src/events.js';
import { createProjection, PROJECTED_EVENT_TYPES } from '../web/backend/event-projection.js';
import { adaptRunEvents, EVENT_DISPOSITION, foldViewEvents } from '../web/backend/server-adapter.js';

const RUN = 'run_adapter';
const START = Date.parse('2026-11-09T10:00:00.000Z');
const at = (offsetMs: number) => new Date(START + offsetMs).toISOString();

// Minimal valid payloads for the events the scene reads; the rest only need their type.
const raw = (seq: number, type: EventType, offsetMs: number, payload: unknown): RunEvent => ({ runId: RUN, seq, type, payload, at: at(offsetMs) }) as RunEvent;

describe('server adapter', () => {
  test('every v2 event type is mapped or dropped explicitly, with consecutive sequence and real elapsed time', () => {
    assert.deepEqual(Object.keys(EVENT_DISPOSITION).sort(), [...EVENT_TYPES].sort(), 'the table covers exactly the event vocabulary');
    const projected = EVENT_TYPES.filter((t) => EVENT_DISPOSITION[t] === 'project');
    assert.deepEqual([...projected].sort(), [...PROJECTED_EVENT_TYPES].sort(), 'the table and the projection agree on what is consumed');

    // One event of every type, in an order with known offsets: input at 1000 ms, others after it.
    const events = EVENT_TYPES.map((type, index) => raw(index + 1, type, type === 'runtime.input' ? 1000 : 1000 + (index + 1) * 250, {}));
    const adapted = adaptRunEvents(events);
    assert.deepEqual(adapted.map((e) => e.type), events.filter((e) => EVENT_DISPOSITION[e.type] === 'project').map((e) => e.type));
    assert.deepEqual(adapted.map((e) => e.sequence), adapted.map((_, i) => i), 'sequence is renumbered consecutively from 0');
    const input = adapted.find((e) => e.type === 'runtime.input');
    assert.equal(input?.elapsedMs, 0);
    for (const e of adapted) {
      const source = events.find((s) => s.type === e.type);
      assert.ok(source);
      if (e.sequence > (input?.sequence ?? Infinity)) assert.equal(e.elapsedMs, Date.parse(source.at) - (START + 1000), e.type);
    }
  });

  test('events before the first runtime.input carry no elapsed time', () => {
    const [first] = adaptRunEvents([raw(1, 'memory.retrieved', 0, {})]);
    assert.equal(first?.elapsedMs, undefined);
  });

  test('a rejected event is skipped and the events after it still apply', () => {
    const messages = [raw(1, 'runtime.message', 0, { threadId: 't', turnId: 'u', itemId: 'i', text: 'one', partial: false }), raw(2, 'search.started', 100, { matchingVersion: 'typed-path-v1', queryId: 'q', candidateCount: 0, queryNodeIds: [] }), raw(3, 'runtime.message', 200, { threadId: 't', turnId: 'u', itemId: 'j', text: 'two', partial: false })];
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const snapshot = foldViewEvents(RUN, null, adaptRunEvents(messages));
      assert.equal(snapshot.sequence, 2);
      assert.deepEqual(snapshot.agentEvents.map((e) => e.label), ['one', 'two']);
      assert.equal(snapshot.searching, false, 'the rejected search start changed nothing');
    } finally {
      console.error = originalError;
    }
    assert.equal(createProjection(RUN).sequence, -1);
  });
});
