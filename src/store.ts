// Neo4j store: the sole authority for cases, runs, events, receipts, activities and the notification
// outbox. Every state change is one transaction holding the domain write, its events and its
// idempotency receipt; events exist only inside such a transaction.
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import neo4j, { type Driver, type ManagedTransaction, Neo4jError } from 'neo4j-driver';
import { z } from 'zod';
import { compactSha256, validateConceptLinkSet, type LoadedSeed } from './dataset.js';
import {
  ActivitySchema,
  ConceptLinksSchema,
  ConceptSchema,
  EdgeTypeSchema,
  MATCHING_VERSION,
  NEO4J_LABELS,
  NotificationOutboxSchema,
  OutcomeSchema,
  RunStateSchema,
  StrategySchema,
  VoiceOperationSchema,
  VoiceOperationStatusSchema,
  type Activity,
  type Concept,
  type ConceptLink,
  type ErrorCode,
  type LearningCase,
  type LessonRecord,
  type NotificationOutbox,
  type Outcome,
  type RunState,
  type Strategy,
  type VoiceOperation,
  validateCase,
} from './domain.js';
import { EventSchema, type EventPayload, type EventType, type RunEvent, type RunEventOf } from './events.js';

// Reads and evaluators have 2 s, mutations 5 s. The limit is a server-side transaction timeout, so a
// slow query is cancelled by the database rather than abandoned while it keeps holding locks.
export const READ_DEADLINE_MS = 2000;
export const MUTATION_DEADLINE_MS = 5000;
// Cases written per seeding transaction: large enough to be quick, small enough to stay inside the heap budget.
const SEED_BATCH_CASES = 40;
const DEMO_STUDENT_ID = 'student_7';

// A failure the caller can report with a stable code; anything else is an infrastructure error and is rethrown.
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly revision: number | undefined;
  constructor(code: ErrorCode, message: string, options: { retryable?: boolean; revision?: number } = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.revision = options.revision;
  }
}

// ---------------------------------------------------------------------------------------------
// Connection

export type StoreConfig = { uri: string; user: string; password: string };

// Reads the worktree .env without overriding anything already in the environment.
function loadWorktreeEnv(): void {
  const file = new URL('../.env', import.meta.url);
  if (existsSync(file)) process.loadEnvFile(file);
}

export function storeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StoreConfig {
  const { NEO4J_URI: uri, NEO4J_USER: user, NEO4J_PASSWORD: password } = env;
  if (!uri || !user || !password) throw new Error('NEO4J_URI, NEO4J_USER and NEO4J_PASSWORD are not set; run npm run setup:env');
  return { uri, user, password };
}

// A run ID is its own namespace: every run-scoped node carries it and reset matches it exactly.
// Production uses a UUID; a test passes its task ID as the prefix so parallel runs never collide.
export function createRunId(prefix?: string): string {
  return prefix ? `${prefix}-${randomBytes(4).toString('hex')}` : randomUUID();
}

// ---------------------------------------------------------------------------------------------
// Shapes

export type NewEvent = { [T in EventType]: { type: T; payload: EventPayload<T> } }[EventType];

export type TransitionContext = {
  state: RunState;
  revision: number;
  seq: number;
  // The transition's timestamp: its events and records all carry this one instant.
  now: string;
  // Reads saved events of one type inside the same transaction, in seq order.
  eventsOfType<T extends EventType>(type: T): Promise<RunEventOf<T>[]>;
  // Whether the client already confirmed that this activity revision mounted.
  isActivityRendered(activityId: string, revision: number): Promise<boolean>;
};

// A voice or agent operation record written inside a transition. `status` moves an existing row only
// from one of `expected`; `onMismatch: 'skip'` leaves a row that already settled elsewhere untouched.
export type VoiceOperationChange =
  | { kind: 'insert'; operation: VoiceOperation }
  | { kind: 'status'; operationId: string; status: VoiceOperation['status']; expected: readonly VoiceOperation['status'][]; onMismatch: 'skip' | 'reject' };

export type Mutation<R> = {
  state: RunState;
  events: NewEvent[];
  cases?: LearningCase[];
  activities?: Activity[];
  outbox?: NotificationOutbox[];
  voiceOperations?: VoiceOperationChange[];
  // Activity revisions whose render receipt this transition records.
  renderedActivities?: { activityId: string; revision: number }[];
  // The receipt stored for replay. A function receives the events as written, so a result can name their seq.
  result: R | ((written: RunEvent[]) => R);
};

export type TransitionRequest<R> = {
  runId: string;
  // Identifies the action for deduplication, e.g. `publish_activity:3`.
  commandKey: string;
  body: unknown;
  expectedRevision: number;
  resultSchema: z.ZodType<R>;
  apply: (context: TransitionContext) => Mutation<R> | Promise<Mutation<R>>;
};

export type RunRecord = { id: string; revision: number; seq: number; state: RunState };
// Parses a stored command receipt that holds a whole run record.
export const RunRecordSchema: z.ZodType<RunRecord> = z.strictObject({ id: z.string(), revision: z.number().int().min(0), seq: z.number().int().min(0), state: RunStateSchema });

export type StudentCase = { id: string; concept: Concept; strategy: Strategy; outcome: Outcome; createdAt: string; nodeIds: string[] };

export type SeedCounts = {
  cases: number;
  memoryNodes: number;
  students: number;
  concepts: number;
  caseEdges: number;
  conceptLinks: number;
  subconceptEdges: number;
};

export type NamespaceCounts = { run: number; events: number; commands: number; activities: number; voiceOperations: number; outbox: number; liveCases: number; total: number };

// A voice operation that reached one of these is final; its record never changes again.
const SETTLED_VOICE_STATUSES: readonly VoiceOperation['status'][] = ['completed', 'cancelled', 'failed'];
const VOICE_RETURN = 'RETURN v.runId AS runId, v.liveSessionId AS liveSessionId, v.delegationId AS delegationId, v.id AS operationId, v.explanationRevision AS explanationRevision, v.cancellationEpoch AS cancellationEpoch, v.threadId AS threadId, v.turnId AS turnId, v.status AS status';

const RUN_SCOPED_LABELS = ['Event', 'Command', 'Activity', 'VoiceOperation', 'NotificationOutbox'] as const;

// Phases in which a step may have been cut off by a restart.
const RECOVERABLE_PHASES: readonly RunState['phase'][] = ['INGESTING', 'PROCESSING', 'VERIFY'];

const str = (value: unknown) => z.string().parse(value);
const num = (value: unknown) => z.number().parse(value);

function parseEvent(raw: unknown): RunEvent {
  return EventSchema.parse(JSON.parse(str(raw)));
}

// Identity of a voice operation without its status, which legitimately changes.
const correlationKey = (o: VoiceOperation) =>
  compactSha256([o.runId, o.liveSessionId, o.delegationId, o.operationId, o.explanationRevision, o.cancellationEpoch, o.threadId, o.turnId]);

const caseHash = (c: LearningCase) => compactSha256(c);

// ---------------------------------------------------------------------------------------------

export class Store {
  private constructor(
    private readonly driver: Driver,
    private readonly now: () => Date,
  ) {}

  static async connect(config?: StoreConfig, options: { now?: () => Date } = {}): Promise<Store> {
    if (!config) loadWorktreeEnv();
    const { uri, user, password } = config ?? storeConfigFromEnv();
    const driver = neo4j.driver(uri, neo4j.auth.basic(user, password), { disableLosslessIntegers: true, maxTransactionRetryTime: MUTATION_DEADLINE_MS });
    await driver.verifyConnectivity();
    const store = new Store(driver, options.now ?? (() => new Date()));
    await store.init();
    return store;
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  private async read<T>(work: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.driver.session();
    try {
      return await session.executeRead(work, { timeout: READ_DEADLINE_MS });
    } catch (error) {
      throw mapDatabaseError(error);
    } finally {
      await session.close();
    }
  }

  private async write<T>(work: (tx: ManagedTransaction) => Promise<T>, timeout = MUTATION_DEADLINE_MS): Promise<T> {
    const session = this.driver.session();
    try {
      return await session.executeWrite(work, { timeout });
    } catch (error) {
      throw mapDatabaseError(error);
    } finally {
      await session.close();
    }
  }

  private async init(): Promise<void> {
    const uniques: [string, string][] = [...NEO4J_LABELS.map((label): [string, string] => [label, 'id']), ['NotificationOutbox', 'uniqueKey']];
    for (const [label, property] of uniques) {
      const name = `${label.toLowerCase()}_${property.toLowerCase()}`;
      try {
        await this.write((tx) => tx.run(`CREATE CONSTRAINT ${name} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${property} IS UNIQUE`));
      } catch (error) {
        // Two processes creating the same constraint at once is not a failure.
        if (!(error instanceof Neo4jError && /EquivalentSchemaRuleAlreadyExists|ConstraintAlreadyExists/.test(error.code))) throw error;
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  // Seed: idempotent; a case ID with a different hash is rejected before any write.

  async seed(seed: LoadedSeed): Promise<{ written: number; existing: number }> {
    await this.assertNoHashConflict(seed.cases);
    await this.write((tx) => this.writeConceptHierarchy(tx, seed.conceptLinks), MUTATION_DEADLINE_MS * 4);
    let written = 0;
    for (let i = 0; i < seed.cases.length; i += SEED_BATCH_CASES) {
      const batch = seed.cases.slice(i, i + SEED_BATCH_CASES);
      written += await this.write(async (tx) => {
        let fresh = 0;
        for (const c of batch) fresh += (await this.writeCase(tx, c, null)) ? 1 : 0;
        return fresh;
      }, MUTATION_DEADLINE_MS * 6);
    }
    return { written, existing: seed.cases.length - written };
  }

  private async assertNoHashConflict(cases: readonly LearningCase[]): Promise<void> {
    const stored = await this.read(async (tx) => {
      const result = await tx.run('MATCH (c:Case) WHERE c.id IN $ids RETURN c.id AS id, c.hash AS hash', { ids: cases.map((c) => c.id) });
      return new Map(result.records.map((r) => [str(r.get('id')), str(r.get('hash'))]));
    });
    for (const c of cases) {
      const hash = stored.get(c.id);
      if (hash !== undefined && hash !== caseHash(c)) throw new DomainError('CONFLICT', `Case ${c.id} already exists with different content`);
    }
  }

  private async writeConceptHierarchy(tx: ManagedTransaction, links: readonly ConceptLink[]): Promise<void> {
    validateConceptLinkSet(links);
    const ids = new Set(links.flatMap((l) => [l.from, l.to]));
    await tx.run('UNWIND $ids AS id MERGE (:Concept {id: id})', { ids: [...ids] });
    for (const l of links) {
      const relation = l.kind === 'subconcept' ? 'SUBCONCEPT_OF' : 'CONCEPT_LINK';
      // Merged on endpoints and kind so reseeding can never add a second edge.
      await tx.run(`MATCH (a:Concept {id: $from}), (b:Concept {id: $to}) MERGE (a)-[r:${relation} {kind: $kind}]->(b) SET r.reason = $reason`, l);
    }
  }

  // Returns true when the case was created, false when an identical one already existed.
  private async writeCase(tx: ManagedTransaction, c: LearningCase, runId: string | null): Promise<boolean> {
    const hash = caseHash(c);
    // MERGE takes the case's lock, so a concurrent writer of the same ID waits and then sees it as existing.
    const created = await tx.run(
      `MERGE (c:Case {id: $id})
       ON CREATE SET c.pending = true, c.studentId = $studentId, c.concept = $concept, c.provenance = $provenance,
                     c.createdAt = $createdAt, c.strategy = $strategy, c.outcome = $outcome, c.runId = $runId,
                     c.hash = $hash, c.payload = $payload
       RETURN c.hash AS hash, c.pending IS NOT NULL AS fresh`,
      { id: c.id, studentId: c.studentId, concept: c.concept, provenance: c.provenance, createdAt: c.createdAt, strategy: c.strategy, outcome: c.outcome, runId, hash, payload: JSON.stringify(c) },
    );
    const record = created.records[0];
    if (!record) throw new Error('Case merge returned no row');
    if (str(record.get('hash')) !== hash) throw new DomainError('CONFLICT', `Case ${c.id} already exists with different content`);
    if (record.get('fresh') !== true) return false;

    const nodes = c.nodes.map((n) => ({ id: n.id, type: n.type, meaning: n.meaning, stage: n.stage, sourceIds: n.sourceIds, proposedMeaning: n.proposedMeaning ?? null }));
    await tx.run(
      `UNWIND $nodes AS n MATCH (c:Case {id: $caseId})
       CREATE (m:MemoryNode {id: n.id, type: n.type, meaning: n.meaning, stage: n.stage, sourceIds: n.sourceIds})
       FOREACH (_ IN CASE WHEN n.proposedMeaning IS NULL THEN [] ELSE [1] END | SET m.proposedMeaning = n.proposedMeaning)
       CREATE (c)-[:CONTAINS]->(m)`,
      { nodes, caseId: c.id },
    );
    for (const type of EdgeTypeSchema.options) {
      const edges = c.edges.filter((e) => e.type === type);
      if (edges.length === 0) continue;
      // The relationship type comes from the validated enum, the only interpolated value.
      await tx.run(`UNWIND $edges AS e MATCH (a:MemoryNode {id: e.from}), (b:MemoryNode {id: e.to}) CREATE (a)-[:${type} {id: e.id, stage: e.stage}]->(b)`, { edges });
    }
    // Joins the case into one memory graph; search stays case-local and never reads these edges.
    await tx.run(
      `MATCH (c:Case {id: $id}) MERGE (s:Student {id: c.studentId}) MERGE (k:Concept {id: c.concept})
       WITH c, s, k MATCH (c)-[:CONTAINS]->(a:MemoryNode {type: 'Attempt'}) MERGE (s)-[:HAD]->(a)
       WITH c, k MATCH (c)-[:CONTAINS]->(x:MemoryNode {type: 'Concept'}) MERGE (x)-[:INSTANCE_OF]->(k)`,
      { id: c.id },
    );
    await tx.run('MATCH (c:Case {id: $id}) REMOVE c.pending', { id: c.id });
    return true;
  }

  // Counts the seed only: live cases written by runs (provenance live_demo) are left out, so a run in
  // progress never changes what the seed reports.
  async seedCounts(): Promise<SeedCounts> {
    return this.read(async (tx) => {
      const count = async (query: string) => num((await tx.run(query)).records[0]?.get('n'));
      return {
        cases: await count(`MATCH (n:Case {provenance: 'synthetic'}) RETURN count(n) AS n`),
        memoryNodes: await count(`MATCH (:Case {provenance: 'synthetic'})-[:CONTAINS]->(n:MemoryNode) RETURN count(n) AS n`),
        students: await count('MATCH (n:Student) RETURN count(n) AS n'),
        concepts: await count('MATCH (n:Concept) RETURN count(n) AS n'),
        caseEdges: await count(`MATCH (:Case {provenance: 'synthetic'})-[:CONTAINS]->(:MemoryNode)-[r]->(:MemoryNode) RETURN count(r) AS n`),
        conceptLinks: await count('MATCH (:Concept)-[r:CONCEPT_LINK]->(:Concept) RETURN count(r) AS n'),
        subconceptEdges: await count('MATCH (:Concept)-[r:SUBCONCEPT_OF]->(:Concept) RETURN count(r) AS n'),
      };
    });
  }

  async caseCount(): Promise<number> {
    return this.read(async (tx) => num((await tx.run('MATCH (n:Case) RETURN count(n) AS n')).records[0]?.get('n')));
  }

  // The fixed curriculum relations as stored; the model can neither read nor change how they are kept.
  async getConceptLinks(): Promise<ConceptLink[]> {
    const rows = await this.read(async (tx) => {
      const result = await tx.run(
        `MATCH (a:Concept)-[r:SUBCONCEPT_OF|CONCEPT_LINK]->(b:Concept) RETURN a.id AS from, b.id AS to, r.kind AS kind, r.reason AS reason ORDER BY kind, from`,
      );
      return result.records.map((r) => ({ from: r.get('from'), to: r.get('to'), kind: r.get('kind'), reason: r.get('reason') }));
    });
    const links = ConceptLinksSchema.parse(rows);
    validateConceptLinkSet(links);
    return links;
  }

  // -------------------------------------------------------------------------------------------
  // Runs

  // Pins the corpus at creation: the eligible case IDs and the corpus hash never change for this run.
  async createRun(input: { runId: string; seed?: number; studentId?: string }, corpus: LoadedSeed): Promise<RunRecord> {
    const pinned = corpus.cases.map((c) => c.id).sort();
    const present = await this.read(async (tx) => {
      const result = await tx.run('MATCH (c:Case) WHERE c.id IN $ids RETURN count(c) AS n', { ids: pinned });
      return num(result.records[0]?.get('n'));
    });
    if (present !== pinned.length) throw new DomainError('NOT_FOUND', `The corpus is not fully loaded (${present} of ${pinned.length} cases); run the seed first`);
    const state = RunStateSchema.parse({
      phase: 'WAITING',
      stopped: false,
      studentId: input.studentId ?? DEMO_STUDENT_ID,
      corpusHash: corpus.corpusHash,
      matchingVersion: MATCHING_VERSION,
      seed: input.seed ?? randomInt(0, 0x100000000),
      lessonProblems: null,
      selectedProblems: null,
      explanationRevision: 0,
      cancellationEpoch: 0,
      clarificationRounds: 0,
      interventionCount: 0,
      continuationAllowed: false,
      runtime: null,
      lesson: null,
      invitation: null,
      activity: null,
      attempts: [],
      explanation: null,
      graph: null,
      search: null,
      error: null,
      createdAt: this.now().toISOString(),
    });
    await this.write((tx) =>
      tx.run('CREATE (r:Run {id: $id, revision: 0, seq: 0, state: $state, corpusHash: $corpusHash, corpusCaseIds: $pinned})', {
        id: input.runId,
        state: JSON.stringify(state),
        corpusHash: corpus.corpusHash,
        pinned,
      }),
    );
    return this.getRun(input.runId);
  }

  async getRun(runId: string): Promise<RunRecord> {
    return this.read(async (tx) => {
      const result = await tx.run('MATCH (r:Run {id: $id}) RETURN r.state AS state, r.revision AS revision, r.seq AS seq', { id: runId });
      const row = result.records[0];
      if (!row) throw runNotFound(runId);
      return { id: runId, revision: num(row.get('revision')), seq: num(row.get('seq')), state: RunStateSchema.parse(JSON.parse(str(row.get('state')))) };
    });
  }

  async getPinnedCorpus(runId: string): Promise<{ corpusHash: string; caseIds: string[] }> {
    return this.read(async (tx) => {
      const result = await tx.run('MATCH (r:Run {id: $id}) RETURN r.corpusHash AS hash, r.corpusCaseIds AS ids', { id: runId });
      const row = result.records[0];
      if (!row) throw runNotFound(runId);
      return { corpusHash: str(row.get('hash')), caseIds: z.array(z.string()).parse(row.get('ids')) };
    });
  }

  async events(runId: string, after = 0): Promise<RunEvent[]> {
    return this.read(async (tx) => {
      const exists = await tx.run('MATCH (r:Run {id: $id}) RETURN r.id AS id', { id: runId });
      if (exists.records.length === 0) throw runNotFound(runId);
      const result = await tx.run('MATCH (e:Event {runId: $runId}) WHERE e.seq > $after RETURN e.payload AS payload ORDER BY e.seq', { runId, after });
      return result.records.map((r) => parseEvent(r.get('payload')));
    });
  }

  // All of a student's synthetic cases of one concept inside the run's pinned corpus, newest first,
  // equal timestamps by ID ascending. Live outcomes are never part of the pinned corpus.
  async listStudentCases(runId: string, studentId: string, concept: Concept): Promise<StudentCase[]> {
    return this.read(async (tx) => {
      const result = await tx.run(
        `MATCH (r:Run {id: $runId})
         MATCH (c:Case {studentId: $studentId, concept: $concept, provenance: 'synthetic'}) WHERE c.id IN r.corpusCaseIds
         RETURN c.id AS id, c.createdAt AS createdAt, c.strategy AS strategy, c.outcome AS outcome, c.payload AS payload
         ORDER BY c.createdAt DESC, c.id ASC`,
        { runId, studentId, concept },
      );
      return result.records.map((r) => {
        const payload = z.object({ nodes: z.array(z.object({ id: z.string() })) }).parse(JSON.parse(str(r.get('payload'))));
        return {
          id: str(r.get('id')),
          concept: ConceptSchema.parse(concept),
          strategy: StrategySchema.parse(r.get('strategy')),
          outcome: OutcomeSchema.parse(r.get('outcome')),
          createdAt: str(r.get('createdAt')),
          nodeIds: payload.nodes.map((n) => n.id),
        };
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Transition: state, events, records and the command receipt commit together or not at all.

  async transition<R>(request: TransitionRequest<R>): Promise<{ result: R; replayed: boolean }> {
    const { runId, commandKey, body, expectedRevision } = request;
    const key = `${runId}:${commandKey}`;
    const bodyHash = compactSha256(body);
    return this.write(async (tx) => {
      // Taking the run's write lock first serializes concurrent commands on one run.
      const locked = await tx.run('MATCH (r:Run {id: $id}) SET r.lock = coalesce(r.lock, 0) + 1 RETURN r.state AS state, r.revision AS revision, r.seq AS seq', { id: runId });
      const row = locked.records[0];
      if (!row) throw runNotFound(runId);
      const receipt = await tx.run('MATCH (c:Command {id: $key}) RETURN c.hash AS hash, c.result AS result', { key });
      const prior = receipt.records[0];
      if (prior) {
        if (str(prior.get('hash')) !== bodyHash) throw new DomainError('CONFLICT', 'The same action was already committed with different content', { revision: num(row.get('revision')) });
        return { result: request.resultSchema.parse(JSON.parse(str(prior.get('result')))), replayed: true };
      }
      const revision = num(row.get('revision'));
      if (revision !== expectedRevision) throw new DomainError('STALE_REVISION', `The run is at revision ${revision}, not ${expectedRevision}`, { revision });
      const seq = num(row.get('seq'));
      const state = RunStateSchema.parse(JSON.parse(str(row.get('state'))));
      const at = this.now().toISOString();
      const mutation = await request.apply({
        state,
        revision,
        seq,
        now: at,
        eventsOfType: async (type) => {
          const found = await tx.run('MATCH (e:Event {runId: $runId, type: $type}) RETURN e.payload AS payload ORDER BY e.seq', { runId, type });
          return found.records.map((r) => parseEvent(r.get('payload'))).filter((e): e is RunEventOf<typeof type> => e.type === type);
        },
        isActivityRendered: async (activityId, revision) => {
          const found = await tx.run('MATCH (a:Activity {id: $id}) RETURN a.renderedAt IS NOT NULL AS rendered', { id: activityKey(runId, activityId, revision) });
          return found.records[0]?.get('rendered') === true;
        },
      });

      const newState = RunStateSchema.parse(mutation.state);
      const cases = mutation.cases ?? [];
      for (const c of cases) await this.writeCase(tx, c, c.provenance === 'live_demo' ? runId : null);
      for (const activity of mutation.activities ?? []) await this.writeActivity(tx, activity);
      for (const outbox of mutation.outbox ?? []) await this.writeOutbox(tx, NotificationOutboxSchema.parse(outbox));
      for (const change of mutation.voiceOperations ?? []) await this.writeVoiceOperationChange(tx, runId, change);
      for (const rendered of mutation.renderedActivities ?? []) await this.markActivityRendered(tx, runId, rendered, at);

      const committed: NewEvent = { type: 'state.committed', payload: { phase: newState.phase, revision: revision + 1, caseIds: cases.map((c) => c.id) } };
      const written = await this.writeEvents(tx, runId, seq, [...mutation.events, committed], at);
      const result = typeof mutation.result === 'function' ? (mutation.result as (events: RunEvent[]) => R)(written) : mutation.result;
      await tx.run('MATCH (r:Run {id: $id}) SET r.state = $state, r.revision = $revision, r.seq = $seq', {
        id: runId,
        state: JSON.stringify(newState),
        revision: revision + 1,
        seq: seq + written.length,
      });
      await tx.run('CREATE (:Command {id: $key, runId: $runId, hash: $hash, result: $result})', { key, runId, hash: bodyHash, result: JSON.stringify(result) });
      return { result, replayed: false };
    });
  }

  private async writeEvents(tx: ManagedTransaction, runId: string, lastSeq: number, events: readonly NewEvent[], at = this.now().toISOString()): Promise<RunEvent[]> {
    // Parsing the envelope here means an event with a payload outside its schema cannot be saved.
    const written = events.map((event, i) => EventSchema.parse({ runId, seq: lastSeq + i + 1, type: event.type, payload: event.payload, at }));
    for (const event of written) {
      await tx.run('CREATE (:Event {id: $id, runId: $runId, seq: $seq, type: $type, payload: $payload})', {
        id: `${runId}:${event.seq}`,
        runId,
        seq: event.seq,
        type: event.type,
        payload: JSON.stringify(event),
      });
    }
    return written;
  }

  // Appends events that report something that happened without a state change (tool.*, notification.*).
  // The run revision does not move.
  async appendEvents(runId: string, events: readonly NewEvent[]): Promise<RunEvent[]> {
    return this.write(async (tx) => this.appendEventsInTx(tx, runId, events));
  }

  private async appendEventsInTx(tx: ManagedTransaction, runId: string, events: readonly NewEvent[]): Promise<RunEvent[]> {
    const locked = await tx.run('MATCH (r:Run {id: $id}) SET r.lock = coalesce(r.lock, 0) + 1 RETURN r.seq AS seq', { id: runId });
    const row = locked.records[0];
    if (!row) throw runNotFound(runId);
    const seq = num(row.get('seq'));
    const written = await this.writeEvents(tx, runId, seq, events);
    await tx.run('MATCH (r:Run {id: $id}) SET r.seq = $seq', { id: runId, seq: seq + written.length });
    return written;
  }

  private async writeActivity(tx: ManagedTransaction, activity: Activity): Promise<void> {
    // One current activity per run; earlier ones stay readable.
    await tx.run('MATCH (a:Activity {runId: $runId, current: true}) SET a.current = false', { runId: activity.runId });
    await tx.run('CREATE (:Activity {id: $id, runId: $runId, activityId: $activityId, revision: $revision, current: true, payload: $payload})', {
      id: activityKey(activity.runId, activity.id, activity.revision),
      runId: activity.runId,
      activityId: activity.id,
      revision: activity.revision,
      payload: JSON.stringify(activity),
    });
  }

  async getActivity(runId: string, activityId: string, revision: number): Promise<Activity | null> {
    return this.read(async (tx) => {
      const result = await tx.run('MATCH (a:Activity {id: $id}) RETURN a.payload AS payload', { id: activityKey(runId, activityId, revision) });
      const row = result.records[0];
      return row ? ActivitySchema.parse(JSON.parse(str(row.get('payload')))) : null;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Lesson ingestion start: WAITING -> INGESTING, recording the saved transcript and lesson.detected.

  async beginIngestion(runId: string, input: { expectedRevision: number; lesson: LessonRecord }): Promise<{ revision: number; eventSeq: number; replayed: boolean }> {
    const { lesson } = input;
    const { result, replayed } = await this.transition({
      runId,
      commandKey: `begin_ingestion:${lesson.contentHash}`,
      body: lesson,
      expectedRevision: input.expectedRevision,
      resultSchema: z.object({ revision: z.number(), eventSeq: z.number() }),
      apply: (context) => {
        if (context.state.phase !== 'WAITING' || context.state.stopped) throw new DomainError('WRONG_PHASE', `Ingestion cannot start in ${context.state.phase}`, { revision: context.revision });
        return {
          state: { ...context.state, phase: 'INGESTING', lesson },
          events: [{ type: 'lesson.detected', payload: { contentHash: lesson.contentHash, source: lesson.source, bytes: new TextEncoder().encode(lesson.text).length } }],
          result: (written) => ({ revision: context.revision + 1, eventSeq: written[0]?.seq ?? context.seq + 1 }),
        };
      },
    });
    // A replay means another caller already started this ingestion; only the first caller runs the turn.
    return { ...result, replayed };
  }

  // -------------------------------------------------------------------------------------------
  // Notification outbox. Delivery is a record, not a phase: none of these touch the run revision.

  private async writeOutbox(tx: ManagedTransaction, row: NotificationOutbox): Promise<void> {
    await tx.run(
      `CREATE (:NotificationOutbox {id: $notificationId, runId: $runId, activityId: $activityId, activityRevision: $activityRevision,
         transport: $transport, status: $status, attemptCount: $attemptCount, createdAt: $createdAt, lastErrorCode: $lastErrorCode,
         uniqueKey: $uniqueKey})`,
      { ...row, uniqueKey: `${row.activityId}|${row.activityRevision}|${row.transport}` },
    );
  }

  private outboxRow(record: { get(key: string): unknown }): NotificationOutbox {
    return NotificationOutboxSchema.parse({
      notificationId: record.get('id'),
      runId: record.get('runId'),
      activityId: record.get('activityId'),
      activityRevision: record.get('activityRevision'),
      transport: record.get('transport'),
      status: record.get('status'),
      attemptCount: record.get('attemptCount'),
      createdAt: record.get('createdAt'),
      lastErrorCode: record.get('lastErrorCode'),
    });
  }

  async getNotification(notificationId: string): Promise<NotificationOutbox | null> {
    return this.read(async (tx) => {
      const result = await tx.run(OUTBOX_RETURN('MATCH (n:NotificationOutbox {id: $id})'), { id: notificationId });
      const row = result.records[0];
      return row ? this.outboxRow(row) : null;
    });
  }

  // pending -> dispatching with attemptCount + 1 in one statement; null when absent or not pending.
  async claimNotification(notificationId: string): Promise<NotificationOutbox | null> {
    return this.write(async (tx) => {
      const result = await tx.run(OUTBOX_RETURN("MATCH (n:NotificationOutbox {id: $id}) WHERE n.status = 'pending' SET n.status = 'dispatching', n.attemptCount = n.attemptCount + 1"), { id: notificationId });
      const row = result.records[0];
      return row ? this.outboxRow(row) : null;
    });
  }

  // status injected and notification.sent in one transaction. The event must describe this very row.
  async markNotificationSent(notificationId: string, event: EventPayload<'notification.sent'>): Promise<void> {
    await this.write(async (tx) => {
      const found = await tx.run(OUTBOX_RETURN("MATCH (n:NotificationOutbox {id: $id}) WHERE n.status = 'dispatching'"), { id: notificationId });
      const record = found.records[0];
      if (!record) throw new DomainError('CONFLICT', `Notification ${notificationId} is not being dispatched`);
      const row = this.outboxRow(record);
      if (event.notificationId !== row.notificationId || event.runId !== row.runId || event.activityId !== row.activityId || event.activityRevision !== row.activityRevision) {
        throw new DomainError('VALIDATION_FAILED', 'The sent event does not match the outbox row');
      }
      await tx.run("MATCH (n:NotificationOutbox {id: $id}) SET n.status = 'injected', n.lastErrorCode = null", { id: notificationId });
      await this.appendEventsInTx(tx, row.runId, [{ type: 'notification.sent', payload: event }]);
    });
  }

  async markNotificationFailed(notificationId: string, lastErrorCode: string): Promise<void> {
    await this.finishNotification(notificationId, 'failed', lastErrorCode);
  }

  // Ambiguous outcome (crash after the subprocess started): a deliberate retry is required.
  async markNotificationUnknown(notificationId: string, lastErrorCode: string): Promise<void> {
    await this.finishNotification(notificationId, 'unknown', lastErrorCode);
  }

  private async finishNotification(notificationId: string, status: 'failed' | 'unknown', lastErrorCode: string): Promise<void> {
    await this.write(async (tx) => {
      const result = await tx.run("MATCH (n:NotificationOutbox {id: $id}) WHERE n.status = 'dispatching' SET n.status = $status, n.lastErrorCode = $lastErrorCode RETURN n.id AS id", { id: notificationId, status, lastErrorCode });
      if (result.records.length === 0) throw new DomainError('CONFLICT', `Notification ${notificationId} is not being dispatched`);
    });
  }

  // Rows waiting to be sent, oldest first, for the dispatcher's backlog scan.
  async listPendingNotifications(): Promise<string[]> {
    return this.read(async (tx) => {
      const result = await tx.run("MATCH (n:NotificationOutbox {status: 'pending'}) RETURN n.id AS id ORDER BY n.createdAt, n.id");
      return result.records.map((r) => str(r.get('id')));
    });
  }

  // Rows left in `dispatching` by a crash; the dispatcher marks them unknown on restart.
  async listDispatchingNotifications(): Promise<string[]> {
    return this.read(async (tx) => {
      const result = await tx.run("MATCH (n:NotificationOutbox {status: 'dispatching'}) RETURN n.id AS id ORDER BY n.createdAt, n.id");
      return result.records.map((r) => str(r.get('id')));
    });
  }

  // -------------------------------------------------------------------------------------------
  // Voice operations: one record per voice or agent operation, keyed by its operation ID. Status
  // changes are records, not run transitions: they never move the run revision.

  private voiceRow(record: { get(key: string): unknown }): VoiceOperation {
    const keys = ['runId', 'liveSessionId', 'delegationId', 'operationId', 'explanationRevision', 'cancellationEpoch', 'threadId', 'turnId', 'status'];
    return VoiceOperationSchema.parse(Object.fromEntries(keys.map((key) => [key, record.get(key)])));
  }

  // Idempotent on the operation ID: a repeat returns the stored row, whatever status it has reached.
  // The same ID with different correlation is a conflict.
  async insertVoiceOperation(input: VoiceOperation): Promise<VoiceOperation> {
    const op = VoiceOperationSchema.parse(input);
    return this.write(async (tx) => {
      const run = await tx.run('MATCH (r:Run {id: $id}) RETURN r.id AS id', { id: op.runId });
      if (run.records.length === 0) throw runNotFound(op.runId);
      const merged = await tx.run(
        `MERGE (v:VoiceOperation {id: $operationId})
         ON CREATE SET v.runId = $runId, v.liveSessionId = $liveSessionId, v.delegationId = $delegationId, v.explanationRevision = $explanationRevision,
                       v.cancellationEpoch = $cancellationEpoch, v.threadId = $threadId, v.turnId = $turnId, v.status = $status
         ${VOICE_RETURN}`,
        op,
      );
      const record = merged.records[0];
      if (!record) throw new Error('Voice operation merge returned no row');
      const stored = this.voiceRow(record);
      if (correlationKey(op) !== correlationKey(stored)) {
        throw new DomainError('CONFLICT', `Operation ${op.operationId} already exists with different correlation`);
      }
      return stored;
    });
  }

  async getVoiceOperation(operationId: string): Promise<VoiceOperation | null> {
    return this.read(async (tx) => {
      const result = await tx.run(`MATCH (v:VoiceOperation {id: $operationId}) ${VOICE_RETURN}`, { operationId });
      const record = result.records[0];
      return record ? this.voiceRow(record) : null;
    });
  }

  // Moves an operation only from the status the caller saw, and never out of a settled one, so two
  // racing callers cannot both win.
  async updateVoiceOperationStatus(operationId: string, status: VoiceOperation['status'], expected: VoiceOperation['status']): Promise<VoiceOperation> {
    const next = VoiceOperationStatusSchema.parse(status);
    const from = VoiceOperationStatusSchema.parse(expected);
    return this.write(async (tx) => {
      const changed = await tx.run(
        `MATCH (v:VoiceOperation {id: $operationId}) WHERE v.status = $from AND NOT v.status IN $settled SET v.status = $next ${VOICE_RETURN}`,
        { operationId, from, next, settled: SETTLED_VOICE_STATUSES },
      );
      const record = changed.records[0];
      if (record) return this.voiceRow(record);
      const exists = await tx.run('MATCH (v:VoiceOperation {id: $operationId}) RETURN v.status AS status', { operationId });
      const current = exists.records[0];
      if (!current) throw new DomainError('NOT_FOUND', `Unknown voice operation ${operationId}`);
      throw new DomainError('CONFLICT', `Operation ${operationId} is ${str(current.get('status'))}, not ${from}`);
    });
  }

  async listVoiceOperations(runId: string): Promise<VoiceOperation[]> {
    return this.read(async (tx) => {
      const result = await tx.run(`MATCH (v:VoiceOperation {runId: $runId}) ${VOICE_RETURN} ORDER BY v.id`, { runId });
      return result.records.map((r) => this.voiceRow(r));
    });
  }

  private async writeVoiceOperationChange(tx: ManagedTransaction, runId: string, change: VoiceOperationChange): Promise<void> {
    if (change.kind === 'insert') {
      const op = VoiceOperationSchema.parse(change.operation);
      if (op.runId !== runId) throw new DomainError('VALIDATION_FAILED', `Operation ${op.operationId} belongs to run ${op.runId}, not ${runId}`);
      const merged = await tx.run(
        `MERGE (v:VoiceOperation {id: $operationId})
         ON CREATE SET v.runId = $runId, v.liveSessionId = $liveSessionId, v.delegationId = $delegationId, v.explanationRevision = $explanationRevision,
                       v.cancellationEpoch = $cancellationEpoch, v.threadId = $threadId, v.turnId = $turnId, v.status = $status
         ${VOICE_RETURN}`,
        op,
      );
      const record = merged.records[0];
      if (!record) throw new Error('Voice operation merge returned no row');
      if (correlationKey(op) !== correlationKey(this.voiceRow(record))) throw new DomainError('CONFLICT', `Operation ${op.operationId} already exists with different correlation`);
      return;
    }
    const next = VoiceOperationStatusSchema.parse(change.status);
    const changed = await tx.run(
      'MATCH (v:VoiceOperation {id: $operationId, runId: $runId}) WHERE v.status IN $expected AND NOT v.status IN $settled SET v.status = $next RETURN v.id AS id',
      { operationId: change.operationId, runId, expected: [...change.expected], settled: SETTLED_VOICE_STATUSES, next },
    );
    if (changed.records.length > 0 || change.onMismatch === 'skip') return;
    throw new DomainError('CONFLICT', `Operation ${change.operationId} is not in ${change.expected.join(' or ')}`);
  }

  private async markActivityRendered(tx: ManagedTransaction, runId: string, rendered: { activityId: string; revision: number }, at: string): Promise<void> {
    const marked = await tx.run('MATCH (a:Activity {id: $id}) WHERE a.renderedAt IS NULL SET a.renderedAt = $at RETURN a.id AS id', { id: activityKey(runId, rendered.activityId, rendered.revision), at });
    if (marked.records.length === 0) throw new DomainError('CONFLICT', `Activity ${rendered.activityId} revision ${rendered.revision} is unknown or already rendered`);
  }

  // The run's pinned corpus as full cases, in ID order. The pin is fixed at run creation, so a live case
  // committed later can never enter it.
  async getPinnedCases(runId: string): Promise<LearningCase[]> {
    return this.read(async (tx) => {
      const pinned = await tx.run('MATCH (r:Run {id: $id}) RETURN r.corpusCaseIds AS ids', { id: runId });
      const row = pinned.records[0];
      if (!row) throw runNotFound(runId);
      const result = await tx.run('MATCH (c:Case) WHERE c.id IN $ids RETURN c.payload AS payload ORDER BY c.id', { ids: z.array(z.string()).parse(row.get('ids')) });
      return result.records.map((r) => validateCase(JSON.parse(str(r.get('payload')))));
    });
  }

  // Runs a restart may need to reconcile: mid-step phases and stopped runs. Phase lives inside the state
  // JSON, so the filter runs here. A shared development database holds other processes' runs, so a caller
  // may limit the scan to its own run-ID prefix.
  async listRecoverableRuns(runIdPrefix: string | null = null): Promise<RunRecord[]> {
    const runs = await this.read(async (tx) => {
      const result = await tx.run('MATCH (r:Run) WHERE $prefix IS NULL OR r.id STARTS WITH $prefix RETURN r.id AS id, r.state AS state, r.revision AS revision, r.seq AS seq ORDER BY r.id', { prefix: runIdPrefix });
      return result.records.map((r) => ({ id: str(r.get('id')), revision: num(r.get('revision')), seq: num(r.get('seq')), state: RunStateSchema.parse(JSON.parse(str(r.get('state')))) }));
    });
    return runs.filter((r) => r.state.stopped || RECOVERABLE_PHASES.includes(r.state.phase));
  }

  // -------------------------------------------------------------------------------------------
  // Audio gate: a record, not a transition. An independent check counts only when the microphone and
  // playback were torn down for that activity, or when the run never opened a voice session.

  async recordVoiceSessionOpened(runId: string, voiceSessionId: string): Promise<void> {
    await this.write(async (tx) => {
      const result = await tx.run(
        'MATCH (r:Run {id: $id}) SET r.voiceSessionIds = CASE WHEN $session IN coalesce(r.voiceSessionIds, []) THEN r.voiceSessionIds ELSE coalesce(r.voiceSessionIds, []) + $session END RETURN r.id AS id',
        { id: runId, session: voiceSessionId },
      );
      if (result.records.length === 0) throw runNotFound(runId);
    });
  }

  async recordAudioGateClosed(runId: string, activityId: string, activityRevision: number, voiceSessionId: string | null): Promise<void> {
    await this.write(async (tx) => {
      const result = await tx.run('MATCH (a:Activity {id: $id}) SET a.audioGateClosedAt = coalesce(a.audioGateClosedAt, $at), a.audioGateSessionId = $session RETURN a.id AS id', {
        id: activityKey(runId, activityId, activityRevision),
        at: this.now().toISOString(),
        session: voiceSessionId,
      });
      if (result.records.length === 0) throw new DomainError('NOT_FOUND', `Unknown activity ${activityId} revision ${activityRevision}`);
    });
  }

  async audioGateClosed(runId: string, activityId: string, activityRevision: number): Promise<boolean> {
    return this.read(async (tx) => {
      const result = await tx.run(
        `MATCH (r:Run {id: $runId}) OPTIONAL MATCH (a:Activity {id: $id})
         RETURN size(coalesce(r.voiceSessionIds, [])) = 0 AS noVoice, a.audioGateClosedAt IS NOT NULL AS closed`,
        { runId, id: activityKey(runId, activityId, activityRevision) },
      );
      const row = result.records[0];
      if (!row) throw runNotFound(runId);
      return row.get('noVoice') === true || row.get('closed') === true;
    });
  }

  // -------------------------------------------------------------------------------------------
  // Reset: removes exactly one run namespace. Seed nodes, other runs and volumes are never touched.

  async resetRun(runId: string): Promise<NamespaceCounts> {
    return this.write(async (tx) => {
      const before = await this.namespaceCounts(tx, runId);
      if (before.run === 0) throw runNotFound(runId);
      await tx.run(`MATCH (n) WHERE n.runId = $runId AND any(l IN labels(n) WHERE l IN $labels) DETACH DELETE n`, { runId, labels: RUN_SCOPED_LABELS });
      // A live case written by this run goes with it, including its graph; seed cases have no runId.
      await tx.run(`MATCH (c:Case {provenance: 'live_demo', runId: $runId}) OPTIONAL MATCH (c)-[:CONTAINS]->(m:MemoryNode) DETACH DELETE m, c`, { runId });
      await tx.run('MATCH (r:Run {id: $runId}) DETACH DELETE r', { runId });
      return before;
    });
  }

  async countNamespace(runId: string): Promise<NamespaceCounts> {
    return this.read((tx) => this.namespaceCounts(tx, runId));
  }

  private async namespaceCounts(tx: ManagedTransaction, runId: string): Promise<NamespaceCounts> {
    const result = await tx.run(
      `OPTIONAL MATCH (r:Run {id: $runId}) WITH count(r) AS run
       OPTIONAL MATCH (n) WHERE n.runId = $runId WITH run, collect(labels(n)) AS groups
       OPTIONAL MATCH (c:Case {provenance: 'live_demo', runId: $runId}) WITH run, groups, count(c) AS liveCases
       RETURN run, groups, liveCases`,
      { runId },
    );
    const row = result.records[0];
    const groups = z.array(z.array(z.string())).parse(row?.get('groups') ?? []);
    const countLabel = (label: string) => groups.filter((g) => g.includes(label)).length;
    const counts = {
      run: num(row?.get('run') ?? 0),
      events: countLabel('Event'),
      commands: countLabel('Command'),
      activities: countLabel('Activity'),
      voiceOperations: countLabel('VoiceOperation'),
      outbox: countLabel('NotificationOutbox'),
      liveCases: num(row?.get('liveCases') ?? 0),
    };
    return { ...counts, total: Object.values(counts).reduce((a, b) => a + b, 0) };
  }
}

const OUTBOX_RETURN = (match: string) =>
  `${match} RETURN n.id AS id, n.runId AS runId, n.activityId AS activityId, n.activityRevision AS activityRevision, n.transport AS transport, n.status AS status, n.attemptCount AS attemptCount, n.createdAt AS createdAt, n.lastErrorCode AS lastErrorCode`;

const activityKey = (runId: string, activityId: string, revision: number) => `${runId}|${activityId}|${revision}`;

const runNotFound = (runId: string) => new DomainError('NOT_FOUND', `Unknown run ${runId}`);

function mapDatabaseError(error: unknown): unknown {
  if (error instanceof Neo4jError) {
    if (/TransactionTimedOut/.test(error.code)) return new DomainError('TOOL_TIMEOUT', 'The database did not answer in time', { retryable: true });
    if (/ConstraintValidationFailed/.test(error.code)) return new DomainError('CONFLICT', 'A record with this identity already exists');
  }
  return error;
}
