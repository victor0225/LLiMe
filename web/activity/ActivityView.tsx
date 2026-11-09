// Host for accepted generated activities. It re-validates the stored spec against the activity's own
// stored context, mounts it through the json-render React renderer over the shared catalog, and
// acknowledges rendering only after the workspace controls are actually in the document.
import { Component, createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import type { Spec } from '@json-render/core';
import { defineRegistry, JSONUIProvider, Renderer } from '@json-render/react';
import { STUDENT_COPY } from '@core/copy';
import type { Activity, ActivityComponent, ActivitySpec, AnyAttempt, Attempt } from '@core/domain';
import type { RunSnapshot } from '@core/events';
import { type ActivityRenderedCommand, HTTP_STATUS } from '@core/routes';
import { activityCatalog, activityContextOf, ActivityValidationError, countHelpers, validateActivity } from '@core/ui/activity-catalog';
import { type EventStore, RunRequestError } from '../lib/event-store';
import { MakeTenWorkspace, type MakeTenSpecProps } from '../student/MakeTenWorkspace';
import '../styles/make-ten.css';

// The activity whose controls mounted. The receipt adds the command ID, the voice session and the
// run revision when it is sent.
export type RenderTarget = Pick<ActivityRenderedCommand, 'activityId' | 'activityRevision' | 'specHash'>;
// The activity a submitted attempt belongs to, so the queue can drop it if that activity changed.
export type SubmitTarget = Pick<ActivityRenderedCommand, 'activityId' | 'activityRevision'>;

// The number-line workspace mounted for a NumberLine spec. The marker and counter are support-only:
// the marker never selects the start for the child.
export type NumberLineSlotProps = {
  start: number;
  addend: number;
  startMarker: number | null;
  showJumpCount: boolean;
  // Help the accepted spec displays; sent with the attempt (the server derives it again).
  hints: number;
  draftKey: string;
  onSubmit: (attempt: Attempt) => void;
};
export type NumberLineSlot = ComponentType<NumberLineSlotProps>;

export type ActivityViewProps = {
  // The run's current activity with its accepted spec and stored hash, or null when there is none.
  activity: Activity | null;
  // The run's event store; render receipts go through its single mutation queue.
  store: EventStore;
  // The live voice session to name in the receipt, or null without one.
  voiceSessionId: string | null;
  numberLine: NumberLineSlot;
  onSubmit: (target: SubmitTarget, attempt: AnyAttempt) => void;
};

type Accepted = { activity: Activity; spec: ActivitySpec; renderSpec: Spec; key: string; hints: number };
// `seen` is the last activity received, so a re-render with the same record changes nothing.
type HostState = { seen: Activity | null; current: Accepted | null; previous: Accepted | null; failed: boolean };

type MountedActivity = Accepted & { numberLine: NumberLineSlot; reportMounted: () => void; submit: (attempt: AnyAttempt) => void };

type Workspace = Extract<ActivityComponent, { type: 'NumberLine' | 'MakeTenWorkspace' }>;
type StartMarker = Extract<ActivityComponent, { type: 'StartMarker' }>;

const isWorkspace = (component: ActivityComponent): component is Workspace => component.type === 'NumberLine' || component.type === 'MakeTenWorkspace';
const isStartMarker = (component: ActivityComponent): component is StartMarker => component.type === 'StartMarker';

const keyOf = (activity: Activity) => `${activity.id}:${activity.revision}`;

// The catalog's fixed layout as a json-render element tree: the one workspace is the root and any
// support helpers hang under it. Helpers configure the workspace and draw nothing themselves.
function renderSpecOf(spec: ActivitySpec): Spec {
  const workspace = spec.components.find(isWorkspace);
  if (workspace === undefined) throw new ActivityValidationError('Exactly one workspace');
  const helpers = spec.components.filter((component) => component !== workspace);
  const elements: Spec['elements'] = { [workspace.id]: { type: workspace.type, props: workspace.props, children: helpers.map((helper) => helper.id) } };
  for (const helper of helpers) elements[helper.id] = { type: helper.type, props: helper.props, children: [] };
  return { root: workspace.id, elements };
}

// An incoming activity replaces the one on screen only if it is newer, carries its stored hash and
// its spec passes the same validation the server applied before publication.
function accept(activity: Activity, current: Accepted | null): Accepted | null {
  if (activity.specHash === null) return null;
  if (current !== null && activity.revision <= current.activity.revision) return null;
  try {
    const spec = validateActivity(activity.activitySpec, activityContextOf(activity));
    return { activity, spec, renderSpec: renderSpecOf(spec), key: keyOf(activity), hints: countHelpers(spec) };
  } catch (error) {
    if (error instanceof ActivityValidationError) return null;
    throw error;
  }
}

const sameRecord = (a: Activity, b: Activity) => a.id === b.id && a.revision === b.revision && a.specHash === b.specHash;

function receive(state: HostState, activity: Activity | null): HostState {
  if (activity === null) return { seen: null, current: null, previous: null, failed: false };
  if (state.current !== null && sameRecord(state.current.activity, activity)) return { ...state, seen: activity };
  const next = accept(activity, state.current);
  if (next === null) return { ...state, seen: activity, failed: true };
  return { seen: activity, current: next, previous: state.current, failed: false };
}

const isCurrentTarget = (run: RunSnapshot, target: RenderTarget) =>
  !run.stopped && run.activity !== null && run.activity.id === target.activityId && run.activity.revision === target.activityRevision && run.activity.specHash === target.specHash;

// Queued behind any pending mutation for the run. The body is built only when the request goes out,
// with the latest run revision, and is dropped if the run has moved on to another activity.
function sendRenderReceipt(store: EventStore, target: RenderTarget, voiceSessionId: string | null, retryOnConflict = true): void {
  const receipt = (run: RunSnapshot) =>
    isCurrentTarget(run, target) ? { type: 'activity_rendered' as const, commandId: crypto.randomUUID(), voiceSessionId, expectedRunRevision: run.revision, ...target } : null;
  store.sendRunCommand('voiceCommand', receipt).catch((error: unknown) => {
    // A conflict means this page was behind and the queue has refreshed the run: one retry with a new
    // command ID either still matches the current activity or is dropped.
    if (retryOnConflict && error instanceof RunRequestError && error.status === HTTP_STATUS.conflict) {
      sendRenderReceipt(store, target, voiceSessionId, false);
      return;
    }
    // Without a receipt no activity speech starts; the controls keep working, so this is only reported.
    console.warn('The activity render receipt was not saved', error);
  });
}

const EMPTY_HOST: HostState = { seen: null, current: null, previous: null, failed: false };

const MountedActivityContext = createContext<MountedActivity | null>(null);

function useMountedActivity(): MountedActivity {
  const mounted = useContext(MountedActivityContext);
  if (mounted === null) throw new Error('A catalog component rendered outside ActivityView');
  return mounted;
}

// Runs after the workspace subtree committed. The renderer drops a subtree whose component throws,
// so this effect never runs for controls that failed to mount.
function useReportMounted(mounted: MountedActivity): void {
  const { reportMounted } = mounted;
  useEffect(() => reportMounted(), [reportMounted]);
}

function MountedMakeTen({ props }: { props: MakeTenSpecProps }): ReactNode {
  const mounted = useMountedActivity();
  useReportMounted(mounted);
  return <MakeTenWorkspace spec={props} hints={mounted.hints} draftKey={mounted.key} onSubmit={mounted.submit} />;
}

function MountedNumberLine({ props }: { props: { start: number; addend: number } }): ReactNode {
  const mounted = useMountedActivity();
  useReportMounted(mounted);
  const NumberLine = mounted.numberLine;
  const marker = mounted.spec.components.find(isStartMarker);
  const showJumpCount = mounted.spec.components.some((component) => component.type === 'JumpCounter');
  return <NumberLine start={props.start} addend={props.addend} startMarker={marker?.props.value ?? null} showJumpCount={showJumpCount} hints={mounted.hints} draftKey={mounted.key} onSubmit={mounted.submit} />;
}

const { registry } = defineRegistry(activityCatalog, {
  components: {
    MakeTenWorkspace: ({ props }) => <MountedMakeTen props={props} />,
    NumberLine: ({ props }) => <MountedNumberLine props={props} />,
    // Marker and counter are read by the number line they target.
    StartMarker: () => null,
    JumpCounter: () => null,
  },
});

// Catches a failure outside any single catalog element (the renderer itself). Rendering nothing means
// no workspace reports mounting, which the host treats as a failed render.
class RenderBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function ActivityView({ activity, store, voiceSessionId, numberLine, onSubmit }: ActivityViewProps): ReactNode {
  const [state, setState] = useState<HostState>(() => receive(EMPTY_HOST, activity));
  if (activity !== state.seen) setState(receive(state, activity));
  const titleId = useId();
  const mountedKey = useRef<string | null>(null);
  const acknowledged = useRef(new Set<string>());
  const { current } = state;

  const mounted = useMemo<MountedActivity | null>(() => {
    if (current === null) return null;
    const { activity: shown } = current;
    return {
      ...current,
      numberLine,
      reportMounted: () => {
        mountedKey.current = current.key;
        // One receipt per activity revision, however often the controls re-render or remount.
        if (acknowledged.current.has(current.key)) return;
        acknowledged.current.add(current.key);
        sendRenderReceipt(store, { activityId: shown.id, activityRevision: shown.revision, specHash: shown.specHash }, voiceSessionId);
      },
      submit: (attempt) => onSubmit({ activityId: shown.id, activityRevision: shown.revision }, attempt),
    };
  }, [current, numberLine, store, voiceSessionId, onSubmit]);

  // Child effects run before this one, so a current activity that never reported mounting failed to
  // render: keep the last activity that did mount, show the recovery line and send no receipt.
  useEffect(() => {
    if (current === null || mountedKey.current === current.key) return;
    setState((latest) => (latest.current?.key === current.key ? { ...latest, current: latest.previous, previous: null, failed: true } : latest));
  }, [current]);

  return (
    <div className="activity-view">
      {state.failed ? (
        <p className="p-status activity-failed" data-tone="error" role="status">
          {STUDENT_COPY.activityOpenFailed}
        </p>
      ) : null}
      {current !== null && mounted !== null ? (
        <article className="activity-card" aria-labelledby={titleId} data-activity-id={current.activity.id} data-activity-revision={current.activity.revision}>
          <h2 id={titleId} className="activity-title">
            {current.activity.title}
          </h2>
          <p className="activity-problem">{current.activity.body}</p>
          <MountedActivityContext.Provider value={mounted}>
            <RenderBoundary key={current.key}>
              <JSONUIProvider registry={registry}>
                <Renderer spec={current.renderSpec} registry={registry} />
              </JSONUIProvider>
            </RenderBoundary>
          </MountedActivityContext.Provider>
        </article>
      ) : null}
    </div>
  );
}
