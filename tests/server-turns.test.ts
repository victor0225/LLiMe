import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActiveTurn, CodexRuntime, TurnResult } from '../src/codex.js';
import { trackTurnSettlement } from '../src/server.js';

// A Codex runtime whose interrupt is acknowledged at once while the turn ends later, as the App
// Server does: the terminal event follows the acknowledgement.
function lateEndingRuntime() {
  const calls: string[] = [];
  let endTurn: (result: TurnResult) => void = () => {};
  const runtime: CodexRuntime = {
    startTurn: async (request) => {
      const done = new Promise<TurnResult>((resolve) => (endTurn = resolve));
      const turn: ActiveTurn = { threadId: 'thread-1', turnId: 'turn-1', operationId: request.operationId ?? 'op-1', done };
      return turn;
    },
    trySteer: async () => null,
    steer: async () => {
      throw new Error('steer is not used here');
    },
    interrupt: async () => {},
    interruptActiveTurns: async () => {
      calls.push('interrupt acknowledged');
      setTimeout(() => {
        calls.push('turn ended');
        endTurn({ threadId: 'thread-1', turnId: 'turn-1', operationId: 'op-1', status: 'interrupted', final: null, error: { code: 'CANCELLED', message: 'The server is stopping', retryable: false } });
      }, 20);
    },
    close: async () => {},
    closeAll: async () => {},
  };
  return { runtime, calls };
}

test('shutdown waits for an interrupted turn to end and its settlement to be written, not only for the interrupt acknowledgement', async () => {
  const { runtime: codex, calls } = lateEndingRuntime();
  const turns = trackTurnSettlement(codex, async (runId) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    calls.push(`settled ${runId}`);
  });
  // The runtime port settles a turn once it is done, as createRuntimePort and the ingestion starter do.
  const turn = await turns.runtime.startTurn({ runId: 'run-1', phase: 'ingestion', input: {}, operationId: 'op-1' });
  void (async () => {
    await turn.done;
    await turns.settle('run-1', { operationId: 'op-1', phase: 'ingestion', cancellationEpoch: 0, status: 'failed', message: 'The server is stopping' });
  })();

  await codex.interruptActiveTurns();
  await turns.settled();
  calls.push('store closes');
  assert.deepEqual(calls, ['interrupt acknowledged', 'turn ended', 'settled run-1', 'store closes']);
});

test('with no turn running, the settlement wait resolves at once', async () => {
  const { runtime } = lateEndingRuntime();
  const turns = trackTurnSettlement(runtime, async () => {});
  const started = Date.now();
  await turns.settled();
  assert.ok(Date.now() - started < 50);
});

test('a failed settlement does not keep shutdown waiting', async () => {
  const { runtime } = lateEndingRuntime();
  const turns = trackTurnSettlement(runtime, async () => {
    throw new Error('write failed');
  });
  await assert.rejects(turns.settle('run-1', { operationId: 'op-1', phase: 'ingestion', cancellationEpoch: 0, status: 'failed' }), /write failed/);
  await turns.settled();
});
