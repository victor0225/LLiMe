import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { z } from 'zod';
import { ACTIVITY_COPY, SPOKEN_COPY } from '../src/copy.js';
import { loadSeed, type LoadedSeed } from '../src/dataset.js';
import { type Activity, type RunState, TEMPLATE_KIND, type TemplateId } from '../src/domain.js';
import { createEngine, type RuntimePort, type TurnRequest } from '../src/engine.js';
import type { EventType, RunEventOf } from '../src/events.js';
import { createRunId, DomainError, type NewEvent, Store } from '../src/store.js';
import { createVoiceDelegation, type DelegationVoice, type Fragment, isOperationCurrent, sealExplanationWindow, TranscriptLedger } from '../src/voice.js';

// Delegation runs on the real engine and the real local store, one run namespace per test, removed in
// `after`. GPT-Live is mocked: fragments and delegation events are plain objects fed through the voice
// service's own transcript ledger. The Codex runtime is a stub that stands in for the runtime adapter,
// and activities are published by a stub of the publish tool. Every test name says so.

const TASK_ID = 'v-task_d00002bb8399';
const LIVE = { voiceSessionId: 'vs_1', liveSessionId: 'live_1' } as const;
const THREAD_ID = 'thr_1';
const PROBLEM = { lhs: 8, rhs: 5 };
const WRONG_ANSWER = 12;
const created: string[] = [];

let store: Store;
let corpus: LoadedSeed;

before(async () => {
  store = await Store.connect();
  corpus = loadSeed();
  await store.seed(corpus);
});

after(async () => {
  for (const runId of created) {
    await store.resetRun(runId);
    assert.equal((await store.countNamespace(runId)).total, 0, `namespace ${runId} is empty`);
  }
  await store.close();
});

const fragment = (eventId: string, text: string, startMs: number, endMs: number): Fragment => ({ eventId, stream: 'input', text, startMs, endMs });

function activity(runId: string, templateId: Exclude<TemplateId, 'invitation_addition'>, revision: number): Activity {
  return {
    id: `${runId}_${templateId}_${revision}`,
    revision,
    runId,
    kind: TEMPLATE_KIND[templateId],
    templateId,
    strategy: templateId === 'make_ten_blocks' ? 'make_ten' : templateId.startsWith('clarify') ? 'clarify' : null,
    problem: PROBLEM,
    ...ACTIVITY_COPY[templateId](PROBLEM),
    activitySpec: null,
    specHash: null,
    helperCount: 0,
    evidenceIds: [],
    decisionSummary: '',
  };
}

// The child tried 8 + 5 on the number line (start 8, four moves, answer 12) and is asked to explain.
function explaining(runId: string, state: RunState, at: string): RunState {
  const initial = activity(runId, 'initial_number_line', 1);
  return {
    ...state,
    phase: 'EXPLAIN',
    lessonProblems: [{ lhs: 7, rhs: 4 }],
    selectedProblems: { initial: PROBLEM, independent: { lhs: 9, rhs: 4 } },
    runtime: { model: 'gpt-6.1-terra', serviceTier: 'priority', threadId: THREAD_ID },
    activity: initial,
    attempts: [{ id: `${runId}_initial`, activityId: initial.id, activityRevision: initial.revision, criterion: 'initial', attempt: { start: 8, moves: [9, 10, 11, 12], answer: WRONG_ANSWER, hints: 0 }, assessment: null, at }],
  };
}

type Hold = { reached: Promise<void>; release: () => void; wait: () => Promise<void> };
function hold(): Hold {
  let reach = () => {};
  let release = () => {};
  const reached = new Promise<void>((r) => { reach = r; });
  const released = new Promise<void>((r) => { release = r; });
  return { reached, release, wait: async () => { reach(); await released; } };
}

async function harness() {
  const runId = createRunId(TASK_ID);
  created.push(runId);
  await store.createRun({ runId, seed: 20261109 }, corpus);
  const commitAs = async (name: string, change: (s: RunState, at: string) => { state: RunState; events: NewEvent[]; activities?: Activity[] }) => {
    const { revision } = await store.getRun(runId);
    await store.transition({ runId, commandKey: `${name}:${randomUUID()}`, body: {}, expectedRevision: revision, resultSchema: z.object({}), apply: ({ state, now }) => ({ ...change(state, now), result: {} }) });
  };
  await commitAs('setup', (s, at) => ({ state: explaining(runId, s, at), events: [] }));

  // Stub runtime in place of the Codex runtime adapter: one thread per run. A steer that reaches the
  // running turn records turn.steered with the turn it expected, unless the run moved past its epoch.
  const runtime = { active: null as string | null, endsOnSteer: false, steerHold: null as Hold | null, steerCalls: [] as { expectedTurnId: string; operationId: string }[], startCalls: [] as string[] };
  const codex: RuntimePort = {
    async startTurn(request: TurnRequest) {
      runtime.startCalls.push(request.operationId);
      runtime.active = `turn_${runtime.startCalls.length}`;
    },
    async steerTurn(request: TurnRequest) {
      const expectedTurnId = runtime.active;
      if (expectedTurnId === null || request.phase !== 'explanation') return false;
      runtime.steerCalls.push({ expectedTurnId, operationId: request.operationId });
      const held = runtime.steerHold;
      runtime.steerHold = null;
      await held?.wait();
      if (runtime.endsOnSteer) {
        runtime.active = null;
        return false;
      }
      const { revision } = await store.getRun(runId);
      const { explanationRevision } = request.input;
      await store
        .transition({
          runId,
          commandKey: `turn_steered:${request.operationId}`,
          body: { expectedTurnId },
          expectedRevision: revision,
          resultSchema: z.object({}),
          apply: ({ state }) => {
            if (state.cancellationEpoch !== request.cancellationEpoch) throw new DomainError('CONFLICT', 'superseded');
            return {
              state,
              events: [{ type: 'turn.steered', payload: { threadId: THREAD_ID, expectedTurnId, operationId: request.operationId, explanationRevision, cancellationEpoch: request.cancellationEpoch } }],
              voiceOperations: [{ kind: 'status', operationId: request.operationId, status: 'steered', expected: ['started'], onMismatch: 'skip' }],
              result: {},
            };
          },
        })
        .catch((error: unknown) => {
          if (!(error instanceof DomainError && error.code === 'CONFLICT')) throw error;
        });
      return true;
    },
    interruptTurn: async () => {},
    closeVoice: (id) => delegation.closeVoice(id),
  };

  // Mocked GPT-Live session: the transcript ledger is the voice service's own; appends are recorded.
  const ledger = new TranscriptLedger();
  const live = { session: LIVE as typeof LIVE | null, closedAfterStop: 0, closed: 0 };
  const appends: { type: 'commentary' | 'thinking'; delegationId: string | null; text: string }[] = [];
  const voice: DelegationVoice = {
    activeSession: () => live.session,
    transcript: () => ({ input: ledger.stream('input'), output: [] }),
    sendCommentary: async (_runId, input) => {
      appends.push({ type: 'commentary', ...input });
      return { eventId: randomUUID(), outcome: 'accepted' };
    },
    sendThinking: async (_runId, input) => {
      appends.push({ type: 'thinking', ...input });
      return { eventId: randomUUID(), outcome: 'accepted' };
    },
    completeDelegation: () => {},
    close: async () => {
      live.closed += 1;
      if ((await store.getRun(runId)).state.stopped) live.closedAfterStop += 1;
      live.session = null;
      return { finalization: 'complete', usageSeconds: 1 };
    },
  };

  const engine = createEngine({ store, runtime: codex });
  const delegation = createVoiceDelegation({ store, engine, onError: (error) => { throw error; } });
  delegation.attach(voice);

  const ofType = async <T extends EventType>(type: T): Promise<RunEventOf<T>[]> => (await store.events(runId)).filter((e): e is RunEventOf<T> => e.type === type);
  const revision = async () => (await store.getRun(runId)).revision;

  return {
    runId,
    engine,
    runtime,
    live,
    appends,
    delegation,
    ofType,
    commentary: () => appends.filter((a) => a.type === 'commentary'),
    operations: () => store.listVoiceOperations(runId),
    state: async () => (await store.getRun(runId)).state,
    explanations: async () => (await ofType('operation.started')).filter((e) => e.payload.phase === 'explanation'),
    // A fragment the mocked provider sends; the ledger drops repeated event IDs before delegation sees it.
    async hear(...fragments: Fragment[]) {
      for (const f of fragments) {
        if (ledger.add(f) === 'appended') await delegation.coordinator.inputFragment({ runId, ...LIVE, fragment: f });
      }
    },
    delegate: (delegationId: string, offsetMs: number) => delegation.coordinator.delegationCreated({ runId, ...LIVE, delegationId, offsetMs, inputFragments: ledger.stream('input') }),
    async publish(templateId: 'make_ten_blocks' | 'clarify_first_number'): Promise<Activity> {
      const published = activity(runId, templateId, (await revision()) + 1);
      await commitAs('publish_activity', (s) => ({ state: { ...s, phase: templateId === 'make_ten_blocks' ? 'PRACTICE' : 'CLARIFY', activity: published }, events: [{ type: 'activity.published', payload: { activity: published } }], activities: [published] }));
      return published;
    },
    async moveEpochOnly() {
      await commitAs('epoch', (s) => ({ state: { ...s, cancellationEpoch: s.cancellationEpoch + 1 }, events: [] }));
    },
    async render(a: Activity, voiceSessionId: string | null = LIVE.voiceSessionId) {
      await delegation.activityRendered(runId, { type: 'activity_rendered', commandId: randomUUID(), voiceSessionId, expectedRunRevision: await revision(), activityId: a.id, activityRevision: a.revision, specHash: a.specHash });
    },
    async correctByTyping(text: string) {
      await engine.typedCorrection(runId, { type: 'typed_correction', commandId: randomUUID(), voiceSessionId: null, expectedRunRevision: await revision(), text });
    },
    async stop() {
      await engine.command(runId, { type: 'stop_learning', commandId: randomUUID(), revision: await revision() });
    },
  };
}

describe('the explanation window rule', () => {
  test('joins the fragments of a window exactly, in timeline order, keeping spaces and repeated words', () => {
    const seal = sealExplanationWindow([fragment('e2', ' eight, eight, nine', 1400, 1900), fragment('e1', 'I started at', 1000, 1400)], 0, 2000);
    assert.deepEqual(seal, { kind: 'sealed', text: 'I started at eight, eight, nine', eventIds: ['e1', 'e2'] });
  });
  test('a fragment ending exactly at the cutoff is inside, because a fragment interval excludes its end', () => {
    assert.equal(sealExplanationWindow([fragment('e1', 'I counted eight', 1000, 2000)], 0, 2000).kind, 'sealed');
    assert.deepEqual(sealExplanationWindow([fragment('e1', 'I counted eight', 1000, 2001)], 0, 2000), { kind: 'clarify', reason: 'crossing_cutoff' });
  });
  test('speech before the previous cutoff or from the cutoff on is outside the window, and the tutor is never the explanation', () => {
    const tutor: Fragment = { eventId: 'out', stream: 'output', text: 'How did you get 12?', startMs: 1000, endMs: 1500 };
    const seal = sealExplanationWindow([fragment('old', 'before', 200, 1000), fragment('in', 'I started at eight', 1000, 1500), tutor, fragment('next', 'later', 2000, 2400)], 1000, 2000);
    assert.deepEqual(seal, { kind: 'sealed', text: 'I started at eight', eventIds: ['in'] });
  });
  test('an empty or blank window asks for clarification instead of sealing', () => {
    assert.deepEqual(sealExplanationWindow([], 0, 2000), { kind: 'clarify', reason: 'empty' });
    assert.deepEqual(sealExplanationWindow([fragment('e1', '   ', 100, 300)], 0, 2000), { kind: 'clarify', reason: 'empty' });
  });
  test('a window longer than an explanation may be asks for clarification instead of truncating', () => {
    assert.equal(sealExplanationWindow([fragment('e1', 'a'.repeat(600), 100, 1900)], 0, 2000).kind, 'sealed');
    assert.deepEqual(sealExplanationWindow([fragment('e1', 'a'.repeat(601), 100, 1900)], 0, 2000), { kind: 'clarify', reason: 'too_long' });
  });
});

describe('sealing a delegation', () => {
  test('a delegation seals exactly one revision from the fragments in its window; a partial transcript sends no command (mocked GPT-Live, stub runtime)', async () => {
    const h = await harness();
    await h.hear(fragment('e1', 'I started at eight', 1000, 1600), fragment('e2', ' and counted to twelve', 1600, 2600));
    assert.equal((await h.operations()).length, 0, 'fragments alone never start a learning command');

    assert.equal((await h.delegate('del_1', 3000)).outcome, 'accepted');
    const { explanation } = await h.state();
    assert.deepEqual(explanation && { text: explanation.text, inputMode: explanation.inputMode, revision: explanation.revision }, { text: 'I started at eight and counted to twelve', inputMode: 'voice', revision: 1 });
    const [operation] = await h.operations();
    assert.deepEqual((await h.ofType('voice.delegated')).map((e) => e.payload), [{ runId: h.runId, liveSessionId: LIVE.liveSessionId, delegationId: 'del_1', operationId: operation?.operationId, explanationRevision: 1, cancellationEpoch: 0, threadId: THREAD_ID, turnId: null, offsetMs: 3000 }]);
    const [started] = await h.explanations();
    const [delegated] = await h.ofType('voice.delegated');
    const between = (await h.ofType('state.committed')).filter((e) => started && delegated && e.seq > Math.min(started.seq, delegated.seq) && e.seq < Math.max(started.seq, delegated.seq));
    assert.equal(between.length, 0, 'voice.delegated is committed in the explanation transaction');
  });

  test('fragments are deduplicated by event ID; a delayed fragment inside the window supersedes that revision; a later utterance waits for its own delegation (mocked GPT-Live, stub runtime)', async () => {
    const h = await harness();
    await h.hear(fragment('e1', 'I started at eight', 1000, 1400), fragment('e1', 'I started at eight', 1000, 1400));
    await h.delegate('del_1', 2000);
    assert.equal((await h.state()).explanation?.text, 'I started at eight', 'a repeated provider event is counted once');

    await h.hear(fragment('e2', ' and said eight was one', 1400, 1900));
    const state = await h.state();
    assert.equal(state.explanation?.text, 'I started at eight and said eight was one', 'the delayed fragment creates one superseding revision');
    assert.equal(state.explanationRevision, 2);
    const [first, second] = (await h.operations()).toSorted((a, b) => a.explanationRevision - b.explanationRevision);
    assert.equal(second?.delegationId, 'del_1');
    assert.deepEqual((await h.ofType('operation.cancelled')).map((e) => e.payload), [{ operationId: first?.operationId, reason: 'superseded', explanationRevision: 1, cancellationEpoch: 0 }]);

    await h.hear(fragment('e3', 'Then I got twelve', 2100, 2600));
    assert.equal((await h.state()).explanationRevision, 2, 'speech after the cutoff waits for its own delegation');
    await h.delegate('del_2', 3000);
    assert.equal((await h.state()).explanation?.text, 'Then I got twelve');
  });

  test('a fragment crossing the cutoff is not split and a clarification is requested (mocked GPT-Live, stub runtime)', async () => {
    const h = await harness();
    await h.hear(fragment('e1', 'I started', 1000, 1400), fragment('e2', ' at eight and', 1800, 2300));
    assert.deepEqual(await h.delegate('del_1', 2000), { outcome: 'clarification', reason: 'crossing_cutoff' });
    assert.equal((await h.operations()).length, 0);
    assert.deepEqual(h.commentary().map((a) => [a.delegationId, a.text]), [['del_1', SPOKEN_COPY.howDidYouGet(WRONG_ANSWER)]]);
    assert.equal((await h.ofType('voice.commentary')).length, 1);

    await h.hear(fragment('e3', ' counted to twelve', 2300, 2800));
    await h.delegate('del_2', 3000);
    assert.equal((await h.state()).explanation?.text, 'I started at eight and counted to twelve', 'the deferred fragment is sealed whole with the next answer');
  });

  test('a duplicate delegationId gives one VoiceOperation, one tool mutation, and the first receipt (mocked GPT-Live, stub runtime)', async () => {
    const h = await harness();
    await h.hear(fragment('e1', 'I started at eight', 1000, 1600));
    const [first, second] = await Promise.all([h.delegate('del_1', 2000), h.delegate('del_1', 2000)]);
    await h.hear(fragment('e2', ' and counted', 2100, 2400));
    const third = await h.delegate('del_1', 2500);
    assert.equal((await h.operations()).length, 1);
    assert.equal((await h.explanations()).length, 1);
    assert.equal(h.runtime.startCalls.length, 1);
    assert.deepEqual(second, first);
    assert.deepEqual(third, first);
    assert.equal(h.appends.filter((a) => a.type === 'thinking').length, 1, 'quiet progress is sent once per delegation');
  });

  test('quiet progress goes to the Live session as an empty thinking append for the delegation, never as speech (mocked GPT-Live, stub runtime)', async () => {
    const h = await harness();
    await h.hear(fragment('e1', 'I started at eight', 1000, 1600));
    await h.delegate('del_1', 2000);
    assert.deepEqual(h.appends, [{ type: 'thinking', delegationId: 'del_1', text: '' }]);
  });
});

describe('runtime handoff', () => {
  test('an active turn is steered with expectedTurnId and writes turn.steered (mocked GPT-Live, stub runtime)', async () => {
    const h = await harness();
    await h.hear(fragment('e1', 'I started at eight', 1000, 1400));
    await h.delegate('del_1', 2000);
    assert.equal(h.runtime.active, 'turn_1', 'the explanation turn is running');

    await h.hear(fragment('e2', ' and said eight was one', 1400, 1900));
    const correction = (await h.operations()).find((o) => o.explanationRevision === 2);
    assert.deepEqual(h.runtime.steerCalls, [{ expectedTurnId: 'turn_1', operationId: correction?.operationId }]);
    assert.equal(h.runtime.startCalls.length, 1, 'no second turn');
    assert.deepEqual((await h.ofType('turn.steered')).map((e) => e.payload), [{ threadId: THREAD_ID, expectedTurnId: 'turn_1', operationId: correction?.operationId, explanationRevision: 2, cancellationEpoch: 1 }]);
    assert.equal(correction?.status, 'steered');
  });

  test('a completed turn, including the completion race, gets a new turn in the same thread; steering never undoes an executed tool (mocked GPT-Live, stub runtime)', async () => {
    const completed = await harness();
    await completed.hear(fragment('e1', 'I started at eight', 1000, 1400));
    await completed.delegate('del_1', 2000);
    completed.runtime.active = null;
    await completed.hear(fragment('e2', ' and said eight was one', 1400, 1900));
    assert.equal(completed.runtime.steerCalls.length, 0);
    assert.equal(completed.runtime.startCalls.length, 2, 'the completed turn is followed by a new turn in the run thread');

    const race = await harness();
    await race.hear(fragment('e1', 'I started at eight', 1000, 1400));
    await race.delegate('del_1', 2000);
    const support = await race.publish('make_ten_blocks');
    race.runtime.endsOnSteer = true;
    await race.hear(fragment('e2', ' and said eight was one', 1400, 1900));
    assert.equal(race.runtime.steerCalls.length, 1, 'the steer reached a turn that was just finishing');
    assert.equal(race.runtime.startCalls.length, 2, 'so the revision gets a new turn');
    assert.equal((await race.ofType('turn.steered')).length, 0);
    assert.deepEqual((await race.ofType('activity.published')).map((e) => e.payload.activity), [support], 'the support the turn already published stays in history');
  });

  test('a result for an older revision or epoch is rejected at tool mutation and at spoken delivery, writes operation.cancelled and speaks nothing (mocked GPT-Live, stub runtime)', async () => {
    const h = await harness();
    await h.hear(fragment('e1', 'I started at eight', 1000, 1400));
    await h.delegate('del_1', 2000);
    const stale = await h.publish('make_ten_blocks');
    const steer = hold();
    h.runtime.steerHold = steer;
    const late = h.hear(fragment('e2', ' and said eight was one', 1400, 1900));
    await steer.reached;
    await h.correctByTyping('I started at nine');
    steer.release();
    await late;

    const superseded = (await h.operations()).find((o) => o.explanationRevision === 2);
    assert.ok(superseded);
    assert.equal(isOperationCurrent(await h.state(), superseded), false, 'a tool result bound to the superseded revision is not current');
    assert.equal((await h.ofType('turn.steered')).filter((e) => e.payload.operationId === superseded.operationId).length, 0, 'a steer that landed after the newer revision records nothing');
    await assert.rejects(h.render(stale), (error: unknown) => error instanceof DomainError && error.code === 'CONFLICT', 'the superseded activity cannot be acknowledged');
    assert.deepEqual(await h.delegation.coordinator.activityRendered({ runId: h.runId, voiceSessionId: LIVE.voiceSessionId, activityId: stale.id, activityRevision: stale.revision }), { outcome: 'silent', reason: 'not_current_activity' });
    assert.equal(h.commentary().length, 0);
    assert.equal((await h.ofType('operation.cancelled')).filter((e) => e.payload.operationId === superseded.operationId).length, 1, 'cancelled once');

    await h.hear(fragment('e3', 'I started at nine and counted', 2100, 2600));
    await h.delegate('del_2', 3000);
    const replacement = await h.publish('make_ten_blocks');
    await h.moveEpochOnly();
    await h.render(replacement);
    assert.equal(h.commentary().length, 0);
    const current = (await h.operations()).find((o) => o.delegationId === 'del_2');
    assert.equal(current?.status, 'cancelled', 'an operation left open by an older epoch is cancelled at delivery');
    assert.equal((await h.ofType('operation.cancelled')).filter((e) => e.payload.operationId === current?.operationId).length, 1);
  });
});

describe('spoken delivery', () => {
  test('commentary is sent only after the matching committed activity_rendered; with no receipt or a mismatch, nothing is spoken (mocked GPT-Live, stub runtime)', async () => {
    const h = await harness();
    await h.hear(fragment('e1', 'I started at eight', 1000, 1600));
    await h.delegate('del_1', 2000);
    const support = await h.publish('make_ten_blocks');
    assert.equal(h.commentary().length, 0, 'publication alone speaks nothing');

    await assert.rejects(h.render({ ...support, revision: support.revision - 1 }), (error: unknown) => error instanceof DomainError && error.code === 'CONFLICT');
    await h.render(support, 'vs_other');
    assert.equal(h.commentary().length, 0, 'a receipt from another voice session speaks nothing');

    await h.render(support);
    const [operation] = await h.operations();
    assert.deepEqual(h.commentary().map((a) => [a.delegationId, a.text]), [['del_1', SPOKEN_COPY.makeTenIntroduction]]);
    assert.deepEqual((await h.ofType('voice.commentary')).map((e) => e.payload), [{ liveSessionId: LIVE.liveSessionId, delegationId: 'del_1', operationId: operation?.operationId, activityId: support.id, activityRevision: support.revision, explanationRevision: 1, cancellationEpoch: 0, text: SPOKEN_COPY.makeTenIntroduction }]);
    assert.equal(operation?.status, 'started', 'speaking does not settle the operation; the end of its turn does');

    await h.render(support);
    assert.equal(h.commentary().length, 1, 'a repeated receipt is not spoken twice');
  });

  test('a published clarification is spoken through the same receipt path with its approved question (mocked GPT-Live, stub runtime)', async () => {
    const h = await harness();
    await h.hear(fragment('e1', 'I just counted', 1000, 1600));
    await h.delegate('del_1', 2000);
    await h.render(await h.publish('clarify_first_number'));
    assert.deepEqual(h.commentary().map((a) => a.text), [SPOKEN_COPY.clarifyFirstNumber]);
  });

  test('a live session that starts while the child explains speaks the explanation question once (mocked GPT-Live)', async () => {
    const h = await harness();
    const initial = (await h.state()).attempts.findLast((a) => a.criterion === 'initial');
    assert.ok(initial);
    h.delegation.hooks.sessionLive?.({ runId: h.runId, voiceSessionId: LIVE.voiceSessionId });
    h.delegation.hooks.sessionLive?.({ runId: h.runId, voiceSessionId: LIVE.voiceSessionId });
    for (let i = 0; i < 100 && h.commentary().length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    // Give the second hook call time to settle; it replays the same record and speaks nothing more.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(h.commentary().map((a) => a.text), [SPOKEN_COPY.howDidYouGet(initial.attempt.answer)]);
  });

  test('a voice failure never produces an assessment; stop_learning closes voice after its commit (mocked GPT-Live, stub runtime)', async () => {
    const failed = await harness();
    await failed.hear(fragment('e1', 'I started at eight', 1000, 1600));
    await failed.delegate('del_1', 2000);
    failed.delegation.hooks.delegationIncomplete?.({ runId: failed.runId, voiceSessionId: LIVE.voiceSessionId, delegationId: 'del_1' });
    failed.live.session = null;
    await failed.render(await failed.publish('make_ten_blocks'));
    assert.equal(failed.commentary().length, 0);
    assert.ok((await failed.state()).attempts.every((a) => a.assessment === null), 'no attempt was assessed');
    assert.equal((await failed.ofType('outcome.committed')).length, 0);

    const stopped = await harness();
    await stopped.hear(fragment('e1', 'I started at eight', 1000, 1600));
    await stopped.delegate('del_1', 2000);
    await stopped.stop();
    assert.equal(stopped.live.closed, 1);
    assert.equal(stopped.live.closedAfterStop, 1, 'voice closes after the stop commit');
    await stopped.hear(fragment('e2', 'wait, I meant nine', 2100, 2600));
    assert.deepEqual(await stopped.delegate('del_2', 3000), { outcome: 'rejected', reason: 'stopped' });
    assert.equal((await stopped.explanations()).length, 1, 'no learning command after stop');
  });
});
