import type { SearchResult } from '@core/domain';
import { STUDENT_COPY } from '@core/copy';
import { type EventPayload, EventSchema, RUNTIME_MESSAGE_MAX_CHARS, type RunEvent, RunSnapshotSchema } from '@core/events';
import { BootstrapSchema, ROUTES, routePath, SESSION_HEADER } from '@core/routes';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { createEventStore, type RunView, useRunEvents } from '../lib/event-store';
import '../styles/inspector.css';
import {
  Card,
  IdRow,
  INSPECTOR_LABELS,
  JsonDetails,
  type SelectedCall,
  type ToolInvocation,
  ToolCallCard,
  ToolResultCard,
  evidenceReferences,
  redactText,
  selectedCallFor,
} from './ToolCard';

export type { SelectedCall } from './ToolCard';

// ---------------------------------------------------------------------------------------------
// Projection: saved events in, cards out. Pure; the same events always give the same cards.

// Runtime items that may appear as progress. Anything else (reasoning, raw responses, unknown kinds)
// is dropped; tool-call items only reconcile the runtime acknowledgement of a tool card.
const OBSERVABLE_ITEM_TYPES: ReadonlySet<string> = new Set(['agentMessage', 'userMessage']);
const TOOL_ITEM_TYPE = 'dynamicToolCall';

export type ConnectionState = 'Starting' | 'Connected' | 'Disconnected' | 'Authentication required' | 'Failed';
export type ExecutionState = 'Idle' | 'Running' | 'Completed' | 'Cancelled' | 'Failed' | 'Retrying';

type Base = { seq: number; at: string };
export type OutputEntry = Base & { kind: 'output'; key: string; threadId: string; turnId: string; itemId: string; text: string; complete: boolean; overflowed: boolean };

export type FeedEntry =
  | (Base & { kind: 'input'; payload: EventPayload<'lesson.detected'> })
  | (Base & { kind: 'boundary'; payload: EventPayload<'runtime.boundary'> })
  | (Base & { kind: 'task'; payload: EventPayload<'runtime.input'> })
  | (Base & { kind: 'progress'; payload: EventPayload<'runtime.item'> })
  | (Base & { kind: 'toolCall'; key: string })
  | (Base & { kind: 'toolResult'; key: string })
  | OutputEntry
  | (Base & { kind: 'turn'; payload: EventPayload<'runtime.completed'> })
  | (Base & { kind: 'decision'; search: SearchResult; hypotheses: string[] })
  | (Base & { kind: 'activity'; payload: EventPayload<'activity.published'> })
  | (Base & { kind: 'outcome'; payload: EventPayload<'outcome.committed'> })
  | (Base & { kind: 'memory'; payload: EventPayload<'memory.retrieved'> })
  | (Base & { kind: 'failed'; payload: EventPayload<'operation.failed'> })
  | (Base & { kind: 'cancelled'; payload: EventPayload<'operation.cancelled'> })
  | (Base & { kind: 'steered'; payload: EventPayload<'turn.steered'> })
  | (Base & { kind: 'voiceDelegated'; payload: EventPayload<'voice.delegated'> })
  | (Base & { kind: 'voiceCommentary'; payload: EventPayload<'voice.commentary'> })
  | (Base & { kind: 'notification'; stage: 'queued' | 'sent' | 'opened'; payload: EventPayload<'notification.queued'> });

export type InspectorModel = {
  entries: FeedEntry[];
  calls: ReadonlyMap<string, ToolInvocation>;
  connection: ConnectionState;
  execution: ExecutionState;
  threadId: string | null;
  turnId: string | null;
  latestSearch: SearchResult | null;
  hypotheses: string[];
  // Events kept out of the view: reasoning and other non-allowlisted items. Only the count is kept.
  hiddenCount: number;
};

const callKey = (callId: string, attempt: number) => `${callId}#${attempt}`;
const outputKey = (threadId: string, turnId: string, itemId: string) => `${threadId}/${turnId}/${itemId}`;

// Parses each event on its own so one unreadable event cannot hide the rest.
export function parseExecutionEvents(raw: readonly unknown[]): { events: RunEvent[]; rejectedCount: number } {
  const events: RunEvent[] = [];
  let rejectedCount = 0;
  for (const item of raw) {
    const parsed = EventSchema.safeParse(item);
    if (parsed.success) events.push(parsed.data);
    else rejectedCount += 1;
  }
  return { events, rejectedCount };
}

const novelLabel = (graph: EventPayload<'context.committed'>['graph']) =>
  graph.nodes.filter((n) => n.type === 'Hypothesis' && n.meaning === 'novel' && n.proposedMeaning).map((n) => `Possible new pattern: ${n.proposedMeaning}`);

export function buildInspectorModel(input: readonly RunEvent[]): InspectorModel {
  // Order by seq and drop repeats: the same saved event applied twice changes nothing.
  const ordered = [...new Map(input.map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
  const entries: FeedEntry[] = [];
  const calls = new Map<string, ToolInvocation>();
  const outputs = new Map<string, OutputEntry>();
  const acknowledgedItems = new Set<string>();
  let operationId: string | null = null;
  let connection: ConnectionState = 'Starting';
  let execution: ExecutionState = 'Idle';
  let threadId: string | null = null;
  let turnId: string | null = null;
  let latestSearch: SearchResult | null = null;
  let hypotheses: string[] = [];
  let hiddenCount = 0;

  const patchCall = (key: string, patch: Partial<ToolInvocation>) => {
    const existing = calls.get(key);
    if (existing) calls.set(key, { ...existing, ...patch });
  };
  const cancelRunning = (matches: (call: ToolInvocation) => boolean) => {
    for (const [key, call] of calls) if (call.status === 'running' && matches(call)) patchCall(key, { status: 'cancelled' });
  };
  const noteIds = (thread: string, turn: string | null) => {
    threadId = thread;
    if (turn) turnId = turn;
  };

  for (const event of ordered) {
    const base = { seq: event.seq, at: event.at };
    switch (event.type) {
      case 'lesson.detected':
        entries.push({ ...base, kind: 'input', payload: event.payload });
        break;
      case 'runtime.boundary':
        connection = 'Connected';
        entries.push({ ...base, kind: 'boundary', payload: event.payload });
        break;
      case 'runtime.input':
        noteIds(event.payload.threadId, null);
        execution = 'Running';
        entries.push({ ...base, kind: 'task', payload: event.payload });
        break;
      case 'operation.started':
        operationId = event.payload.operationId;
        execution = 'Running';
        break;
      case 'runtime.item': {
        const { payload } = event;
        noteIds(payload.threadId, payload.turnId);
        if (payload.type === TOOL_ITEM_TYPE) {
          if (payload.lifecycle === 'completed') {
            acknowledgedItems.add(payload.id);
            for (const [key, call] of calls) if (call.itemId === payload.id && call.acknowledgement === 'pending') patchCall(key, { acknowledgement: 'acknowledged' });
          }
        } else if (OBSERVABLE_ITEM_TYPES.has(payload.type)) entries.push({ ...base, kind: 'progress', payload });
        else hiddenCount += 1;
        break;
      }
      case 'tool.started': {
        const { payload } = event;
        const key = callKey(payload.callId, payload.attempt);
        noteIds(payload.threadId, payload.turnId);
        if (calls.has(key)) break;
        const retried = [...calls.values()].some((c) => c.callId === payload.callId);
        calls.set(key, {
          key,
          callId: payload.callId,
          attempt: payload.attempt,
          threadId: payload.threadId,
          turnId: payload.turnId,
          itemId: payload.itemId,
          serverRequestId: payload.serverRequestId,
          operationId,
          name: payload.name,
          arguments: payload.arguments,
          startedSeq: event.seq,
          startedAt: event.at,
          status: 'running',
          resultSeq: null,
          resultAt: null,
          result: null,
          error: null,
          elapsedMs: null,
          acknowledgement: payload.itemId === null ? 'unknown' : 'pending',
        });
        if (retried) execution = 'Retrying';
        entries.push({ ...base, kind: 'toolCall', key });
        break;
      }
      case 'tool.completed': {
        const { payload } = event;
        const key = callKey(payload.callId, payload.attempt);
        noteIds(payload.threadId, payload.turnId);
        if (calls.get(key)?.resultSeq != null) break;
        if (!calls.has(key)) {
          calls.set(key, orphanCall(key, event, payload.name));
          entries.push({ ...base, kind: 'toolCall', key });
        }
        const itemId = payload.itemId;
        patchCall(key, {
          status: 'completed',
          result: payload.result,
          elapsedMs: payload.elapsedMs,
          resultSeq: event.seq,
          resultAt: event.at,
          acknowledgement: itemId === null ? 'unknown' : acknowledgedItems.has(itemId) ? 'acknowledged' : 'pending',
        });
        if (execution === 'Retrying') execution = 'Running';
        entries.push({ ...base, kind: 'toolResult', key });
        break;
      }
      case 'tool.failed': {
        const { payload } = event;
        const key = callKey(payload.callId, payload.attempt);
        noteIds(payload.threadId, payload.turnId);
        if (calls.get(key)?.resultSeq != null) break;
        if (!calls.has(key)) {
          calls.set(key, orphanCall(key, event, payload.name));
          entries.push({ ...base, kind: 'toolCall', key });
        }
        patchCall(key, { status: 'failed', error: payload.error, elapsedMs: payload.elapsedMs, resultSeq: event.seq, resultAt: event.at });
        entries.push({ ...base, kind: 'toolResult', key });
        break;
      }
      case 'runtime.message': {
        const { payload } = event;
        noteIds(payload.threadId, payload.turnId);
        const key = outputKey(payload.threadId, payload.turnId, payload.itemId);
        const previous = outputs.get(key);
        if (previous?.overflowed) break;
        // Incomplete output appends; complete output replaces the item's buffer.
        const text = previous && payload.partial ? previous.text + payload.text : payload.text;
        const next: OutputEntry = {
          ...base,
          kind: 'output',
          key,
          threadId: payload.threadId,
          turnId: payload.turnId,
          itemId: payload.itemId,
          text,
          complete: !payload.partial,
          overflowed: text.length > RUNTIME_MESSAGE_MAX_CHARS,
        };
        outputs.set(key, next);
        if (previous) entries[entries.findIndex((e) => e.kind === 'output' && e.key === key)] = { ...next, seq: previous.seq, at: previous.at };
        else entries.push(next);
        break;
      }
      case 'runtime.completed': {
        const { payload } = event;
        noteIds(payload.threadId, payload.turnId);
        execution = payload.status === 'completed' ? 'Completed' : payload.status === 'interrupted' ? 'Cancelled' : 'Failed';
        if (payload.status === 'interrupted') cancelRunning((c) => c.turnId === payload.turnId);
        entries.push({ ...base, kind: 'turn', payload });
        break;
      }
      case 'context.committed':
        hypotheses = novelLabel(event.payload.graph);
        break;
      case 'search.completed':
        latestSearch = event.payload;
        entries.push({ ...base, kind: 'decision', search: event.payload, hypotheses });
        break;
      case 'activity.published':
        entries.push({ ...base, kind: 'activity', payload: event.payload });
        break;
      case 'outcome.committed':
        entries.push({ ...base, kind: 'outcome', payload: event.payload });
        break;
      case 'memory.retrieved':
        entries.push({ ...base, kind: 'memory', payload: event.payload });
        break;
      case 'operation.failed': {
        const { code } = event.payload;
        if (code === 'RUNTIME_DISCONNECTED') connection = 'Disconnected';
        else if (code === 'AUTH_REQUIRED') connection = 'Authentication required';
        else if (connection === 'Starting') connection = 'Failed';
        execution = 'Failed';
        entries.push({ ...base, kind: 'failed', payload: event.payload });
        break;
      }
      case 'operation.cancelled':
        execution = 'Cancelled';
        cancelRunning((c) => c.operationId === event.payload.operationId);
        entries.push({ ...base, kind: 'cancelled', payload: event.payload });
        break;
      case 'turn.steered':
        noteIds(event.payload.threadId, event.payload.expectedTurnId);
        execution = 'Running';
        entries.push({ ...base, kind: 'steered', payload: event.payload });
        break;
      case 'voice.delegated':
        entries.push({ ...base, kind: 'voiceDelegated', payload: event.payload });
        break;
      case 'voice.commentary':
        entries.push({ ...base, kind: 'voiceCommentary', payload: event.payload });
        break;
      case 'notification.queued':
      case 'notification.sent':
      case 'notification.opened':
        entries.push({ ...base, kind: 'notification', stage: event.type.slice('notification.'.length) as 'queued' | 'sent' | 'opened', payload: event.payload });
        break;
      case 'state.committed':
      case 'graph.updated':
      case 'search.started':
        break;
      default:
        assertNever(event);
    }
  }
  return { entries, calls, connection, execution, threadId, turnId, latestSearch, hypotheses, hiddenCount };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled event ${JSON.stringify(value)}`);
}

// A result saved without a visible request still gets its call card; its arguments were not recorded.
function orphanCall(key: string, event: RunEvent & { type: 'tool.completed' | 'tool.failed' }, name: string): ToolInvocation {
  const { payload } = event;
  return {
    key,
    callId: payload.callId,
    attempt: payload.attempt,
    threadId: payload.threadId,
    turnId: payload.turnId,
    itemId: payload.itemId,
    serverRequestId: payload.serverRequestId,
    operationId: null,
    name,
    arguments: undefined,
    startedSeq: event.seq,
    startedAt: event.at,
    status: 'running',
    resultSeq: null,
    resultAt: null,
    result: null,
    error: null,
    elapsedMs: null,
    acknowledgement: 'unknown',
  };
}

// ---------------------------------------------------------------------------------------------
// Cards for the remaining entries.

const time = (iso: string) => new Date(iso).toISOString().slice(11, 19);

function Facts({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="insp-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function DecisionBody({ search, hypotheses }: { search: SearchResult; hypotheses: readonly string[] }) {
  const { decision } = search;
  const label = decision.basis === 'default' ? INSPECTOR_LABELS.defaultDecision : decision.basis === 'policy' ? INSPECTOR_LABELS.policyDecision : null;
  return (
    <>
      <p className="insp-summary">
        {label ? <strong>{label}</strong> : <strong>{decision.basis === 'evidence' ? 'Evidence from comparable cases' : 'Clarification first'}</strong>}
      </p>
      <Facts
        items={[
          ['Action', decision.strategy],
          ['Template', decision.templateId],
          ['Basis', decision.basis],
          ['Evidence IDs', decision.evidenceIds.length ? decision.evidenceIds.join(', ') : 'None'],
          ...(hypotheses.length ? [['Hypothesis', hypotheses.join(', ')] as const] : []),
        ]}
      />
      <p>{redactText(decision.reason)}</p>
      {decision.basis === 'evidence' ? (
        <ul className="insp-groups" aria-label="Strategy groups">
          {decision.groups.map((g) => (
            <li key={g.strategy}>
              {g.strategy}: {g.independent} of {g.total} independent
            </li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

function OutputCard({ entry }: { entry: OutputEntry }) {
  const status = entry.overflowed ? INSPECTOR_LABELS.partialOutput : entry.complete ? 'Complete' : 'In progress';
  return (
    <Card title="OUTPUT → STUDENT" source="Observable agent output" tone={entry.overflowed ? 'bad' : 'idle'} status={status}>
      {entry.overflowed ? (
        <p className="insp-error" role="status">
          {INSPECTOR_LABELS.outputLimit}
        </p>
      ) : null}
      <pre className="insp-output" tabIndex={0} aria-label="Observable output">{redactText(entry.text)}</pre>
      {entry.overflowed ? <p className="insp-muted">{INSPECTOR_LABELS.outputLimitDetail}: more than {RUNTIME_MESSAGE_MAX_CHARS.toLocaleString('en-US')} characters in one item. The turn was interrupted.</p> : null}
      <dl className="insp-ids">
        <IdRow label="Item ID" value={entry.itemId} />
        <IdRow label="Turn ID" value={entry.turnId} />
      </dl>
    </Card>
  );
}

function EntryCard({ entry, model, runId, selectedKey, onSelect, onViewEvidence }: { entry: FeedEntry; model: InspectorModel; runId: string | null; selectedKey: string | null; onSelect: (key: string) => void; onViewEvidence: (call: SelectedCall) => void }) {
  switch (entry.kind) {
    case 'input':
      return (
        <Card title="INPUT" source="Application input">
          <Facts items={[['Time', time(entry.at)], ['Input type', 'Lesson transcript (local file)'], ['Size', `${entry.payload.bytes} bytes`], ['Content hash', <code key="h">{entry.payload.contentHash}</code>]]} />
        </Card>
      );
    case 'boundary':
      return (
        <Card title="RUNTIME BOUNDARY" source="Application check">
          <Facts
            items={[
              ['Sandbox', entry.payload.sandbox],
              ['Web search', entry.payload.webSearch],
              ['MCP servers', `${entry.payload.configuredMcpCount} configured, ${entry.payload.disabledMcpCount} disabled, ${entry.payload.enabledMcpTools} tools enabled`],
              ['Disabled features', entry.payload.disabledFeatures.join(', ') || 'None'],
            ]}
          />
          <p className="insp-muted">Model-facing restrictions only; not operating-system isolation.</p>
        </Card>
      );
    case 'task':
      return (
        <Card title="TASK" source="Application instructions">
          <Facts items={[['Phase', entry.payload.phase], ['Model', entry.payload.model], ['Prompt hash', <code key="p">{entry.payload.promptHash}</code>]]} />
          <details className="insp-json">
            <summary>Submitted instructions</summary>
            <pre tabIndex={0} aria-label="Submitted instructions">{redactText(entry.payload.instructions)}</pre>
          </details>
          <JsonDetails label="Input" value={entry.payload.input} />
          <dl className="insp-ids"><IdRow label="Thread ID" value={entry.payload.threadId} /></dl>
        </Card>
      );
    case 'progress':
      return (
        <Card title="RUNTIME ITEM" source="Codex event" status={entry.payload.lifecycle}>
          <p className="insp-summary"><strong>{entry.payload.type}</strong></p>
          <dl className="insp-ids">
            <IdRow label="Item ID" value={entry.payload.id} />
            <IdRow label="Turn ID" value={entry.payload.turnId} />
          </dl>
        </Card>
      );
    case 'toolCall': {
      const call = model.calls.get(entry.key);
      return call ? <ToolCallCard call={call} runId={runId} selected={selectedKey === call.key} onSelect={onSelect} onViewEvidence={onViewEvidence} /> : null;
    }
    case 'toolResult': {
      const call = model.calls.get(entry.key);
      return call ? <ToolResultCard call={call} /> : null;
    }
    case 'output':
      return <OutputCard entry={entry} />;
    case 'turn':
      return (
        <Card title="TURN" source="Codex event" tone={entry.payload.status === 'completed' ? 'ok' : 'bad'} status={entry.payload.status}>
          <dl className="insp-ids"><IdRow label="Turn ID" value={entry.payload.turnId} /></dl>
        </Card>
      );
    case 'decision':
      return (
        <Card title="DECISION" source="Application decision">
          <DecisionBody search={entry.search} hypotheses={entry.hypotheses} />
        </Card>
      );
    case 'activity':
      return (
        <Card title="OUTPUT → STUDENT" source="Application activity" tone="ok" status="Published">
          <p className="insp-summary"><strong>{entry.payload.activity.title}</strong></p>
          <Facts items={[['Kind', entry.payload.activity.kind], ['Template', entry.payload.activity.templateId], ['Revision', String(entry.payload.activity.revision)], ['Decision summary', redactText(entry.payload.activity.decisionSummary)]]} />
          <JsonDetails label="Activity" value={entry.payload.activity} />
        </Card>
      );
    case 'outcome':
      return (
        <Card title="OUTCOME" source="Application result" tone="ok" status="Committed">
          <Facts items={[['Outcome', entry.payload.outcome], ['Strategy', entry.payload.strategy], ['Case', entry.payload.persistedCaseId]]} />
        </Card>
      );
    case 'memory':
      return (
        <Card title="MEMORY" source="Application memory">
          <Facts items={[['Concepts', entry.payload.conceptIds.join(', ')], ['Cases', String(entry.payload.caseIds.length)]]} />
        </Card>
      );
    case 'failed':
      return (
        <Card title="OPERATION FAILED" source="Application error" tone="bad" status="Failed">
          <p className="insp-error" role="status">{entry.payload.code}: {redactText(entry.payload.message)}</p>
        </Card>
      );
    case 'cancelled':
      return (
        <Card title="OPERATION CANCELLED" source="Application operation" tone="warn" status="Cancelled">
          <Facts items={[['Reason', entry.payload.reason === 'superseded' ? 'Superseded by a newer explanation' : 'Stopped'], ['Operation', entry.payload.operationId], ['Explanation revision', String(entry.payload.explanationRevision)]]} />
          <p className="insp-muted">Work saved before the cancellation stays visible.</p>
        </Card>
      );
    case 'steered':
      return (
        <Card title="TURN STEERED" source="Codex event" tone="warn" status="Steered">
          <Facts items={[['Active turn', entry.payload.expectedTurnId], ['Operation', entry.payload.operationId], ['Explanation revision', String(entry.payload.explanationRevision)]]} />
        </Card>
      );
    case 'voiceDelegated':
      return (
        <Card title="VOICE" source="GPT-Live delegation" status="Delegated">
          <Facts items={[['Live session', entry.payload.liveSessionId], ['Delegation', entry.payload.delegationId], ['Offset', `${entry.payload.offsetMs} ms`]]} />
        </Card>
      );
    case 'voiceCommentary':
      return (
        <Card title="VOICE" source="GPT-Live commentary" status="Sent">
          <p>{redactText(entry.payload.text)}</p>
        </Card>
      );
    case 'notification':
      return (
        <Card title={INSPECTOR_LABELS.simulatorNotification.toUpperCase()} source="Notification transport" status={entry.stage}>
          <Facts items={[['Notification', entry.payload.notificationId], ['Activity', entry.payload.activityId]]} />
        </Card>
      );
    default:
      return assertNever(entry);
  }
}

// ---------------------------------------------------------------------------------------------
// The view.

export type TraceSource = 'live' | 'replay' | 'fixture';
const SOURCE_LABEL: Record<TraceSource, string> = { live: 'Live', replay: 'Replay', fixture: 'Fixture' };
const FEED_LABEL: Record<RunView['status'], string> = { loading: 'Loading', live: 'Event feed live', reconnecting: 'Reconnecting', failed: 'Event feed failed' };

export type InspectorViewProps = {
  runId: string | null;
  studentId: string | null;
  runtimeName: string | null;
  source: TraceSource;
  feedStatus: RunView['status'];
  lastSeq: number;
  events: readonly RunEvent[];
  rejectedCount?: number;
  onViewEvidence: (call: SelectedCall) => void;
  onStartNewRun?: () => void;
  startingNewRun?: boolean;
  startNewRunError?: string | null;
};

type Pane = 'evidence' | 'decision' | 'details';
const PANES: readonly { id: Pane; label: string }[] = [
  { id: 'evidence', label: 'Selected evidence' },
  { id: 'decision', label: 'Decision' },
  { id: 'details', label: 'Details' },
];

export function InspectorView(props: InspectorViewProps) {
  const { runId, source, events, onViewEvidence } = props;
  const model = useMemo(() => buildInspectorModel(events), [events]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>('evidence');
  const latestCall = [...model.calls.values()].at(-1) ?? null;
  const selected = (selectedKey ? model.calls.get(selectedKey) : null) ?? latestCall;

  return (
    <div className="inspector" data-source={source}>
      <header className="insp-header">
        <h1>{INSPECTOR_LABELS.title}</h1>
        <dl className="insp-chips">
          <Chip label="Runtime" value={props.runtimeName ?? INSPECTOR_LABELS.notAssigned} />
          <Chip label="Connection" value={model.connection} />
          <Chip label="Execution" value={model.execution} />
        </dl>
        <span className="insp-badge" data-source={source}>{SOURCE_LABEL[source]}</span>
        <span className="insp-poll" role="status">{FEED_LABEL[props.feedStatus]} · through event {props.lastSeq}</span>
      </header>
      <dl className="insp-ids insp-ids-bar" aria-label="Execution identifiers">
        <IdRow label="Run ID" value={runId} />
        <IdRow label="Student session ID" value={props.studentId} />
        <IdRow label="Thread ID" value={model.threadId} />
        <IdRow label="Turn ID" value={model.turnId} />
      </dl>
      {source === 'fixture' ? <p className="insp-banner" role="note">Fixture trace: events built for this story, not a run.</p> : null}
      {props.rejectedCount ? <p className="insp-banner" role="note">{props.rejectedCount} unreadable {props.rejectedCount === 1 ? 'event was' : 'events were'} not shown.</p> : null}
      <div className="insp-body">
        <main className="insp-feed" aria-label="Execution feed">
          {model.entries.length === 0 ? <p className="insp-empty">No execution events yet.</p> : null}
          {model.entries.map((entry) => (
            <EntryCard key={`${entry.seq}-${entry.kind}`} entry={entry} model={model} runId={runId} selectedKey={selected?.key ?? null} onSelect={setSelectedKey} onViewEvidence={onViewEvidence} />
          ))}
          {model.execution === 'Failed' && props.onStartNewRun ? (
            <section className="insp-final" aria-label="Run failed">
              <p>This run ended with an error. The failed cards above stay on this run.</p>
              <button type="button" className="insp-action" onClick={props.onStartNewRun} disabled={props.startingNewRun} aria-busy={props.startingNewRun}>
                {STUDENT_COPY.startNewRun}
              </button>
              {props.startNewRunError ? <p className="insp-error" role="alert">{props.startNewRunError}</p> : null}
            </section>
          ) : null}
        </main>
        <aside className="insp-panel" aria-label="Evidence panel">
          <div role="group" aria-label="Panel" className="insp-panes">
            {PANES.map((p) => (
              <button key={p.id} type="button" aria-pressed={pane === p.id} onClick={() => setPane(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          {pane === 'evidence' ? <EvidencePane call={selected} runId={runId} onViewEvidence={onViewEvidence} /> : null}
          {pane === 'decision' ? <DecisionPane model={model} /> : null}
          {pane === 'details' ? <DetailsPane model={model} rejectedCount={props.rejectedCount ?? 0} /> : null}
        </aside>
      </div>
    </div>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <div className="insp-chip">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function EvidencePane({ call, runId, onViewEvidence }: { call: ToolInvocation | null; runId: string | null; onViewEvidence: (call: SelectedCall) => void }) {
  if (!call) return <p className="insp-empty">No tool call to show yet.</p>;
  const refs = call.result ? evidenceReferences(call.result) : null;
  return (
    <section aria-label="Selected evidence">
      <h2>{call.name}</h2>
      <p className="insp-summary">Attempt {call.attempt} · {call.status === 'running' ? INSPECTOR_LABELS.waitingForResult : call.status === 'completed' ? 'Result saved' : call.status}</p>
      {refs ? (
        <Facts items={[['Cases', refs.caseIds.join(', ') || 'None'], ['Nodes', refs.nodeIds.join(', ') || 'None'], ['Edges', refs.edgeIds.join(', ') || 'None']]} />
      ) : (
        <p className="insp-muted">Evidence appears here after the result is saved.</p>
      )}
      <dl className="insp-ids" aria-label="Call identifiers">
        <IdRow label="Call ID" value={call.callId} full />
        <IdRow label="Item ID" value={call.itemId} full />
        <IdRow label="Transport request ID" value={call.serverRequestId} full />
        <IdRow label="Thread ID" value={call.threadId} full />
        <IdRow label="Turn ID" value={call.turnId} full />
      </dl>
      {runId !== null && refs && call.status === 'completed' ? <HandoffPreview runId={runId} call={call} onViewEvidence={onViewEvidence} /> : null}
    </section>
  );
}

function HandoffPreview({ runId, call, onViewEvidence }: { runId: string; call: ToolInvocation; onViewEvidence: (call: SelectedCall) => void }) {
  const handoff = selectedCallFor(runId, call);
  if (!handoff) return null;
  return (
    <button type="button" className="insp-action" onClick={() => onViewEvidence(handoff)}>
      {INSPECTOR_LABELS.viewEvidence}: {call.name}
    </button>
  );
}

function DecisionPane({ model }: { model: InspectorModel }) {
  if (!model.latestSearch) return <p className="insp-empty">No decision has been saved yet.</p>;
  return (
    <section aria-label="Decision">
      <DecisionBody search={model.latestSearch} hypotheses={model.hypotheses} />
    </section>
  );
}

function DetailsPane({ model, rejectedCount }: { model: InspectorModel; rejectedCount: number }) {
  return (
    <section aria-label="Details">
      <Facts
        items={[
          ['Tool attempts', String(model.calls.size)],
          ['Cards', String(model.entries.length)],
          ['Items not shown', String(model.hiddenCount + rejectedCount)],
        ]}
      />
      <p className="insp-muted">Reasoning and unrecognized runtime items are never shown; only their count is kept.</p>
      <JsonDetails label="Attempts" value={[...model.calls.values()].map(({ key, status, resultSeq }) => ({ key, status, resultSeq }))} />
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// The route: loads the run snapshot, polls events and starts a replacement run on request.

function useBootstrap() {
  const [state, setState] = useState<{ runtime: string | null; nonce: string | null }>({ runtime: null, nonce: null });
  useEffect(() => {
    const controller = new AbortController();
    fetch(routePath('bootstrap'), { signal: controller.signal, headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) return;
        const parsed = BootstrapSchema.safeParse(await response.json());
        if (parsed.success) setState({ runtime: parsed.data.runtime, nonce: parsed.data.nonce });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  return state;
}

export type InspectorPageProps = {
  runId: string;
  onViewEvidence: (call: SelectedCall) => void;
  onNewRun?: (runId: string) => void;
};

export function InspectorPage({ runId, onViewEvidence, onNewRun }: InspectorPageProps) {
  const store = useMemo(() => createEventStore(runId), [runId]);
  useEffect(() => {
    store.start();
    return () => store.stop();
  }, [store]);
  const view = useRunEvents(store);
  const bootstrap = useBootstrap();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const startNewRun = async () => {
    if (!bootstrap.nonce) return setStartError('The session is not ready. Try again in a moment.');
    setStarting(true);
    setStartError(null);
    try {
      const response = await fetch(routePath('createRun'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', [SESSION_HEADER]: bootstrap.nonce },
        body: JSON.stringify(ROUTES.createRun.request.parse({})),
      });
      if (!response.ok) throw new Error(`The server answered HTTP ${response.status}`);
      const created = RunSnapshotSchema.parse(await response.json());
      onNewRun?.(created.id);
    } catch (error) {
      setStartError(error instanceof Error ? redactText(error.message) : 'The new run could not be started.');
    } finally {
      setStarting(false);
    }
  };

  return (
    <InspectorView
      runId={runId}
      studentId={view.run?.studentId ?? null}
      runtimeName={bootstrap.runtime}
      source="live"
      feedStatus={view.status}
      lastSeq={view.lastSeq}
      events={view.events}
      onViewEvidence={onViewEvidence}
      onStartNewRun={() => void startNewRun()}
      startingNewRun={starting}
      startNewRunError={startError ?? (view.status === 'failed' ? view.error : null)}
    />
  );
}

// Mounted at /inspector?runId=...
export function InspectorRoute({ onViewEvidence }: { onViewEvidence: (call: SelectedCall) => void }) {
  const runId = new URLSearchParams(window.location.search).get('runId');
  if (!runId) {
    return (
      <div className="inspector">
        <header className="insp-header"><h1>{INSPECTOR_LABELS.title}</h1></header>
        <p className="insp-empty">Open this page with a run: /inspector?runId=…</p>
      </div>
    );
  }
  return <InspectorPage runId={runId} onViewEvidence={onViewEvidence} onNewRun={(id) => window.location.assign(`/inspector?runId=${encodeURIComponent(id)}`)} />;
}
