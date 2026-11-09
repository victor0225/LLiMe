import type { ErrorBody, ToolName, ToolSuccess } from '@core/domain';
import { type ReactNode, useState } from 'react';

// Presentation labels of the execution inspector. They are not runtime events.
export const INSPECTOR_LABELS = {
  title: 'Codex Execution Inspector',
  notAssigned: 'Not assigned',
  notApplicable: 'Not applicable',
  waitingForResult: 'Waiting for result',
  viewEvidence: 'View evidence',
  savedAckPending: 'Saved · runtime acknowledgement pending',
  savedAcknowledged: 'Saved · runtime acknowledged',
  saved: 'Saved',
  defaultDecision: 'Default, no comparable evidence',
  policyDecision: 'Policy: fair second try',
  outputLimit: 'Output limit reached. See failure details.',
  outputLimitDetail: 'Output limit exceeded',
  partialOutput: 'Partial observable output',
  simulatorNotification: 'Simulator notification',
  redacted: '[redacted]',
  copy: 'Copy',
  copied: 'Copied',
} as const;

export const TOOL_STATUS_LABEL = { running: 'Running', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled' } as const;
export type ToolStatus = keyof typeof TOOL_STATUS_LABEL;

// One tool invocation as the saved events describe it. A bounded retry is a separate attempt of the
// same runtime call, so (callId, attempt) is the identity.
export type ToolInvocation = {
  key: string;
  callId: string;
  attempt: number;
  threadId: string;
  turnId: string;
  itemId: string | null;
  serverRequestId: string | number | null;
  operationId: string | null;
  name: string;
  arguments: unknown;
  startedSeq: number;
  startedAt: string;
  status: ToolStatus;
  resultSeq: number | null;
  resultAt: string | null;
  result: ToolSuccess | null;
  error: ErrorBody | null;
  elapsedMs: number | null;
  // `unknown` when the call has no runtime item to correlate with.
  acknowledgement: 'acknowledged' | 'pending' | 'unknown';
};

// What a selected call hands to the graph view: its identity plus the record IDs its saved result returned.
export type SelectedCall = {
  runId: string;
  callId: string;
  attempt: number;
  toolName: ToolName;
  itemId: string | null;
  caseIds: string[];
  nodeIds: string[];
  edgeIds: string[];
};

const unique = (ids: readonly string[]) => [...new Set(ids)];

export function evidenceReferences(result: ToolSuccess): Pick<SelectedCall, 'caseIds' | 'nodeIds' | 'edgeIds'> {
  switch (result.tool) {
    case 'get_personal_memory':
      return { caseIds: unique(result.data.cases.map((c) => c.caseId)), nodeIds: unique(result.data.cases.flatMap((c) => c.nodeIds)), edgeIds: [] };
    case 'search_learning_cases': {
      const { contextCommit, search } = result.data;
      return {
        caseIds: unique([contextCommit.caseId, ...search.candidates.map((c) => c.id), ...search.admitted.map((c) => c.caseId)]),
        nodeIds: unique([...contextCommit.nodeIds, ...search.candidates.flatMap((c) => c.matchedCandidateNodeIds)]),
        edgeIds: unique([...contextCommit.edgeIds, ...search.admitted.flatMap((c) => c.matchedEdgeIds)]),
      };
    }
    case 'publish_activity':
      return { caseIds: unique(result.data.activity.evidenceIds), nodeIds: [], edgeIds: [] };
    case 'commit_episode':
      return { caseIds: [result.data.caseId], nodeIds: [], edgeIds: [] };
    case 'assess_attempt':
      return { caseIds: [], nodeIds: [], edgeIds: [] };
  }
}

// The graph can open only a call whose result was saved and that returned something to show.
export function selectedCallFor(runId: string, call: ToolInvocation): SelectedCall | null {
  if (!call.result) return null;
  const refs = evidenceReferences(call.result);
  if (refs.caseIds.length + refs.nodeIds.length + refs.edgeIds.length === 0) return null;
  return { runId, callId: call.callId, attempt: call.attempt, toolName: call.result.tool, itemId: call.itemId, ...refs };
}

// ---------------------------------------------------------------------------------------------
// Display redaction. The server removes secrets before persisting an event; the browser removes them
// again so a payload that slipped through, or a stored fixture, can never put one on screen.

const SECRET_KEY = /authori[sz]ation|cookie|api[-_]?key|secret|password|passwd|credential|bearer|private[-_]?key|(access|refresh|id|auth|session)[-_]?token|^token$|e-?mail|workspace[-_]?id/i;
const REASONING_KEY = /reasoning|chain[-_]?of[-_]?thought|thinking|^thoughts?$/i;
const HOME_PREFIX = /(?:\/Users|\/home)\/[^/\s"']+|[A-Za-z]:\\Users\\[^\\\s"']+/g;
const SECRET_TEXT = /\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}|([?&](?:token|code|key|access_token|id_token)=)[^&\s"']+/gi;

export function redactText(text: string): string {
  return text.replace(HOME_PREFIX, '~').replace(SECRET_TEXT, (match, query: string | undefined) => (query ? `${query}${INSPECTOR_LABELS.redacted}` : INSPECTOR_LABELS.redacted));
}

// Hidden-reasoning fields are dropped, secret-named fields are masked, and every string is scrubbed.
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (REASONING_KEY.test(key)) continue;
    out[key] = SECRET_KEY.test(key) ? INSPECTOR_LABELS.redacted : redactValue(inner);
  }
  return out;
}

export const redactedJson = (value: unknown) => JSON.stringify(redactValue(value), null, 2) ?? 'undefined';

// ---------------------------------------------------------------------------------------------
// Shared card parts.

export function JsonDetails({ label, value }: { label: string; value: unknown }) {
  return (
    <details className="insp-json">
      <summary>{label}</summary>
      <pre tabIndex={0} aria-label={`${label} (sanitized JSON)`}>{redactedJson(value)}</pre>
    </details>
  );
}

const shortId = (id: string) => (id.length > 14 ? `…${id.slice(-10)}` : id);

export function IdRow({ label, value, full = false }: { label: string; value: string | number | null; full?: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = value === null ? null : String(value);
  const copy = () => {
    if (text === null) return;
    void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
  };
  return (
    <div className="insp-id">
      <dt>{label}</dt>
      <dd>
        {text === null ? (
          <span className="insp-muted">{INSPECTOR_LABELS.notAssigned}</span>
        ) : (
          <>
            <code title={text}>{full ? text : shortId(text)}</code>
            <button type="button" className="insp-copy" onClick={copy} aria-label={`${INSPECTOR_LABELS.copy} ${label}`}>
              {copied ? INSPECTOR_LABELS.copied : INSPECTOR_LABELS.copy}
            </button>
          </>
        )}
      </dd>
    </div>
  );
}

export function Card({ title, source, tone, status, children, selected, id }: { title: string; source: string; tone?: 'ok' | 'bad' | 'warn' | 'idle'; status?: string; children: ReactNode; selected?: boolean; id?: string }) {
  return (
    <article className="insp-card" data-tone={tone} data-selected={selected ? 'true' : undefined} id={id} aria-label={title}>
      <header>
        <h2>{title}</h2>
        <span className="insp-source">{source}</span>
        {status ? <span className="insp-status" data-tone={tone}>{status}</span> : null}
      </header>
      {children}
    </article>
  );
}

// ---------------------------------------------------------------------------------------------
// TOOL CALL and TOOL RESULT cards.

function requestIds(call: ToolInvocation) {
  return (
    <dl className="insp-ids">
      <IdRow label="Call ID" value={call.callId} />
      <IdRow label="Item ID" value={call.itemId} />
      <IdRow label="Transport request ID" value={call.serverRequestId} />
      <IdRow label="Thread ID" value={call.threadId} />
      <IdRow label="Turn ID" value={call.turnId} />
      <div className="insp-id">
        <dt>Attempt</dt>
        <dd>{call.attempt}</dd>
      </div>
    </dl>
  );
}

export function ToolCallCard({ call, runId, selected, onSelect, onViewEvidence }: { call: ToolInvocation; runId: string | null; selected: boolean; onSelect: (key: string) => void; onViewEvidence: (call: SelectedCall) => void }) {
  const handoff = runId === null ? null : selectedCallFor(runId, call);
  return (
    <Card title="TOOL CALL" source="Codex tool request" tone={call.status === 'completed' ? 'ok' : call.status === 'running' ? 'idle' : 'bad'} status={TOOL_STATUS_LABEL[call.status]} selected={selected} id={`call-${call.key}`}>
      <p className="insp-summary"><strong>{call.name}</strong></p>
      <JsonDetails label="Arguments" value={call.arguments === undefined ? null : call.arguments} />
      {requestIds(call)}
      <button type="button" className="insp-select" aria-pressed={selected} onClick={() => onSelect(call.key)}>
        {selected ? 'Selected' : 'Select call'}
      </button>
      {call.status === 'running' ? <WaitingForResult /> : null}
      {call.status === 'completed' && handoff ? (
        <button type="button" className="insp-action" onClick={() => onViewEvidence(handoff)}>
          {INSPECTOR_LABELS.viewEvidence}
        </button>
      ) : null}
    </Card>
  );
}

function savedLabel(call: ToolInvocation) {
  if (call.acknowledgement === 'pending') return INSPECTOR_LABELS.savedAckPending;
  if (call.acknowledgement === 'acknowledged') return INSPECTOR_LABELS.savedAcknowledged;
  return INSPECTOR_LABELS.saved;
}

// Exists only after the handler saved a result (or recorded a failure); an accepted request is not a result.
export function ToolResultCard({ call }: { call: ToolInvocation }) {
  return (
    <Card title="TOOL RESULT" source="Application tool result" tone={call.status === 'completed' ? 'ok' : 'bad'} status={call.status === 'completed' ? savedLabel(call) : TOOL_STATUS_LABEL[call.status]} id={`result-${call.key}`}>
      <p className="insp-summary">
        <strong>{call.name}</strong> · attempt {call.attempt}
        {call.elapsedMs === null ? null : <> · {Math.round(call.elapsedMs)} ms</>}
      </p>
      {call.error ? (
        <p className="insp-error" role="status">
          {call.error.code}: {redactText(call.error.message)}
        </p>
      ) : null}
      <JsonDetails label={call.error ? 'Error' : 'Result'} value={call.error ?? call.result} />
    </Card>
  );
}

// The call card's action while no result exists: it names what it waits for and does nothing.
function WaitingForResult() {
  return (
    <button type="button" className="insp-action" disabled>
      {INSPECTOR_LABELS.waitingForResult}
    </button>
  );
}
