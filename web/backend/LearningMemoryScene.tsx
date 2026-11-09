// The Learning memory scene: one SVG of this learner's graph beside every other learner's memory.
// Every other learner is a fixed tile and never moves; a search only changes brightness, lights the
// matched edges of the admitted cases and lifts those cases out. Replay and live runs render through
// this same component, so only the source chip differs.
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { indexCorpus } from './event-projection.js';
import { buildInspectorModel } from './Inspector.js';
import { type Corpus, useCorpus, useLiveRun } from './server-adapter.js';
import { type SelectedCall, selectedCallFor } from './ToolCard.js';
import '../styles/backend-scene.css';
import { type ConceptLink, type CurriculumConcept, type LearningCase, type Problem } from '@core/domain';
import { ACTIVITY_COPY } from '@core/copy';
import { ADMISSION_MIN_SCORE, ADMISSION_TOP_MARGIN } from '@core/search';
import { type BranchLayout, branchLayout, type Extent, extentOf, FIELD, fieldLayout, GLYPH_UNIT, HUB, ME, personalRow, type Placement, RESULT_X, SLOT, sortLearners, SPINE, STAGE, TRUNK_X, ZONE, zoneLayout } from './branch-layout.js';
import { hypothesisLabels, liftedCaseIds, litEdgeIds, memoryHighlight, type ProjectionSnapshot, type ViewEvent, visibleScores } from './event-projection.js';
import {
  CORPUS_MISMATCH,
  fieldCaption,
  fromCases,
  groupLabel,
  MISSING_RUN,
  NOT_SAVED_SUFFIX,
  OPERATION_COPY,
  otherLearnersSummary,
  type RawLine,
  rawLine,
  SCENE_COPY,
  selectedHeading,
  sharedConcept,
  solvedAloneLater,
  SOURCE_LABEL,
  type SourceKind,
  STRATEGY_NAME,
} from './learning-copy.js';

// What the operator or the live follower has shown so far, on top of what the projection accepted:
// `lifted` once the admitted cases leave the field, `chosen` once the winning group is marked.
export type Reveal = 'none' | 'lifted' | 'chosen';

export interface LearningMemorySceneProps {
  readonly snapshot: ProjectionSnapshot;
  readonly reveal: Reveal;
  readonly rawEvent: ViewEvent | null;
  // Recorded agent text shown in place of an event line, for replays whose agent input is a recording.
  readonly recordedLine?: RawLine | null;
  readonly source: SourceKind;
  // The pinned corpus the search ran over; tiles and branches are drawn from it.
  readonly cases: readonly LearningCase[];
  // The problem the child is working on, for the next-step wording.
  readonly problem?: Problem | null;
  // Today's lesson, shown beside the recalled memory before the search.
  readonly lessonText?: string | null;
  // The call opened from the inspector: its cases are outlined wherever they appear.
  readonly selectedCall?: SelectedCall | null;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const TYPE_ORDER = ['Concept', 'Attempt', 'Observation', 'Explanation', 'Hypothesis'] as const;
type SpineType = (typeof TYPE_ORDER)[number];

// The stem of a sentence the child said is wrapped to this many characters per line, at most three lines.
const QUOTE_WRAP = 28;
const NEXT_STEP_WRAP = 24;
const QUOTE_MAX_LINES = 3;
// Field brightness follows similarity: opacity = FLOOR + (1 - FLOOR) * score^BRIGHTNESS_POWER.
export const BRIGHTNESS_POWER = 1.5;
// Lifted cases leave the field one after another so the motion reads as a group, not a jump.
const LIFT_STAGGER_MS = 10;

const humanize = (id: string) => {
  const spaced = id.replaceAll('_', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (`${line} ${word}`.trim().length > max && line) {
      lines.push(line);
      line = word;
    } else line = `${line} ${word}`.trim();
  }
  if (line) lines.push(line);
  return lines;
}

function quoted(text: string): string[] {
  const lines = wrap(text, QUOTE_WRAP);
  if (lines.length === 0) return [];
  lines[0] = `“${lines[0]}`;
  lines[lines.length - 1] += '”';
  return lines.length > QUOTE_MAX_LINES ? [...lines.slice(0, QUOTE_MAX_LINES - 1), `${lines[QUOTE_MAX_LINES - 1]} …`] : lines;
}

// ---------------------------------------------------------------------------------------------
// A branch: lines and dots from its typed structure. Drawn once; the wrapper carries all state.

interface Shape {
  readonly layout: BranchLayout;
  readonly extent: Extent;
}

const shapeOfCase = (c: Pick<LearningCase, 'nodes' | 'edges'>): Shape => {
  const layout = branchLayout(c, { withResult: true });
  return { layout, extent: extentOf(layout) };
};

const GlyphBody = memo(function GlyphBody({ shape, lit }: { shape: Shape; lit: ReadonlySet<string> }) {
  const { layout } = shape;
  const litNodes = new Set<string>();
  for (const e of layout.edges) if (lit.has(e.id)) (litNodes.add(e.from), litNodes.add(e.to));
  const at = (id: string) => layout.pos.get(id);
  const line = (e: (typeof layout.edges)[number]) => {
    const a = at(e.from);
    const b = at(e.to);
    return a && b ? <line key={e.id} x1={a.x * GLYPH_UNIT} y1={a.y * GLYPH_UNIT} x2={b.x * GLYPH_UNIT} y2={b.y * GLYPH_UNIT} className={lit.has(e.id) ? 'lit' : undefined} data-edge-id={lit.has(e.id) ? e.id : undefined} vectorEffect="non-scaling-stroke" /> : null;
  };
  return (
    <>
      <g className="ctx">
        {layout.edges.filter((e) => e.stage === 'context').map(line)}
        {layout.nodes
          .filter((p) => p.node.stage === 'context')
          .map((p) => (
            <circle key={p.node.id} cx={p.x * GLYPH_UNIT} cy={p.y * GLYPH_UNIT} r={p.node.type === 'Hypothesis' ? 7 : 6} className={[p.node.type === 'Hypothesis' ? 'hyp' : '', litNodes.has(p.node.id) ? 'lit' : ''].join(' ').trim() || undefined} />
          ))}
      </g>
      <g className="res">
        {layout.edges.filter((e) => e.stage === 'result').map(line)}
        {layout.nodes
          .filter((p) => p.node.stage === 'result')
          .map((p) => {
            const x = p.x * GLYPH_UNIT;
            const y = p.y * GLYPH_UNIT;
            if (p.node.type === 'Intervention') return <rect key={p.node.id} x={x - 6} y={y - 6} width={12} height={12} className="i-mark" />;
            return (
              <g key={p.node.id} className="o-mark" data-outcome={p.node.meaning}>
                <circle cx={x} cy={y} r={7} />
                {p.node.meaning !== 'independent' && <path d={`M${x - 4} ${y - 4} l8 8 m0 -8 l-8 8`} />}
              </g>
            );
          })}
      </g>
    </>
  );
});

interface GlyphProps {
  readonly shape: Shape;
  readonly caseId: string;
  readonly at: Placement;
  readonly lit: ReadonlySet<string>;
  readonly flags: string;
  readonly similarity: number | null;
  readonly delayMs: number;
}

function Glyph({ shape, caseId, at, lit, flags, similarity, delayMs }: GlyphProps) {
  const style = { transform: `translate(${at.x}px, ${at.y}px) scale(${at.s})`, transitionDelay: `${delayMs}ms`, '--sim': similarity === null ? '0' : similarity.toFixed(3) } as CSSProperties;
  return (
    <g className={`glyph ${flags}`} data-case-id={caseId} style={style}>
      <GlyphBody shape={shape} lit={lit} />
    </g>
  );
}

// ---------------------------------------------------------------------------------------------
// Derived data. Everything geometric comes from counts and shapes, nothing from scores.

const sortByTime = (a: LearningCase, b: LearningCase) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

function useCorpusLayout(cases: readonly LearningCase[], personalId: string | null, concept: string | null) {
  return useMemo(() => {
    const shapes = new Map(cases.map((c) => [c.id, shapeOfCase(c)]));
    const others = cases.filter((c) => c.studentId !== personalId && c.concept === concept);
    const learners = sortLearners(others.map((c) => c.studentId));
    const groups = learners.map((id) => ({
      id,
      cases: others.filter((c) => c.studentId === id).sort(sortByTime).map((c) => ({ id: c.id, extent: shapes.get(c.id)?.extent ?? { w: 0, h: 0 } })),
    }));
    const mine = cases.filter((c) => c.studentId === personalId).sort(sortByTime);
    return { shapes, others, learners, field: fieldLayout(groups), mine };
  }, [cases, personalId, concept]);
}

function studentOf(snapshot: ProjectionSnapshot, byId: ReadonlyMap<string, LearningCase>): string | null {
  if (snapshot.graph) return snapshot.graph.studentId;
  const first = snapshot.memory?.caseIds[0];
  return first ? (byId.get(first)?.studentId ?? null) : null;
}

function todayConcept(snapshot: ProjectionSnapshot): string | null {
  return snapshot.graph?.concept ?? snapshot.memory?.summaries.find((s) => s.link === 'today')?.conceptId ?? null;
}

function operationText(snapshot: ProjectionSnapshot, reveal: Reveal): string {
  const { graph, outcome, search } = snapshot;
  if (snapshot.status === 'error') return OPERATION_COPY.interrupted;
  if (outcome) return (outcome.outcome === 'independent' ? OPERATION_COPY.solvedAlone : OPERATION_COPY.notYetSolved) + (outcome.saved ? ` ${SCENE_COPY.addedToMemory}.` : '');
  if (search && reveal === 'chosen') return OPERATION_COPY.choosing;
  if (search && reveal === 'lifted') return OPERATION_COPY.helped;
  if (search) return OPERATION_COPY.found;
  if (snapshot.searching) return OPERATION_COPY.searching;
  if (graph?.nodes.some((n) => n.type === 'Hypothesis')) return OPERATION_COPY.possible;
  if (graph?.nodes.some((n) => n.type === 'Explanation')) return OPERATION_COPY.reading;
  if (graph) return OPERATION_COPY.listening;
  return OPERATION_COPY.recalling;
}

function nextStepWords(snapshot: ProjectionSnapshot, problem: Problem | null | undefined): string {
  const decision = snapshot.search?.decision;
  const strategy = snapshot.outcome?.strategy ?? decision?.strategy;
  if (!strategy) return '';
  if (decision && problem && decision.strategy === strategy && decision.templateId !== 'invitation_addition') return ACTIVITY_COPY[decision.templateId](problem).title;
  return STRATEGY_NAME[strategy];
}

// ---------------------------------------------------------------------------------------------
// The scene.

export function LearningMemoryScene({ snapshot, reveal, rawEvent, recordedLine, source, cases, problem, lessonText, selectedCall }: LearningMemorySceneProps) {
  const byId = useMemo(() => new Map(cases.map((c) => [c.id, c])), [cases]);
  const personalId = studentOf(snapshot, byId);
  const concept = todayConcept(snapshot);
  const { shapes, others, learners, field, mine } = useCorpusLayout(cases, personalId, concept);

  const { search, graph, outcome } = snapshot;
  const hasGraph = graph !== null;
  const scores = useMemo(() => visibleScores(snapshot), [snapshot]);
  const lifted = useMemo(() => liftedCaseIds(snapshot), [snapshot]);
  const admittedById = useMemo(() => new Map((search?.admitted ?? []).map((a) => [a.caseId, a])), [search]);
  const litByCase = useMemo(() => new Map((search?.admitted ?? []).map((a) => [a.caseId, new Set(a.matchedEdgeIds)])), [search]);
  const decision = search?.decision ?? null;
  const showLifted = search !== null && reveal !== 'none';
  const chosen = search !== null && reveal === 'chosen';

  // Zone: the admitted cases grouped as the decision grouped them, winning group first.
  const zone = useMemo(() => {
    if (!search || !showLifted) return null;
    const groups = search.decision.groups.map((g) => ({ strategy: g.strategy, ids: search.admitted.filter((a) => a.strategy === g.strategy && shapes.has(a.caseId)).map((a) => a.caseId) }));
    return zoneLayout(groups, (id) => shapes.get(id)?.extent ?? { w: 0, h: 0 });
  }, [search, showLifted, shapes]);

  // This learner's own row: earlier situations, then the newly committed one.
  const freshShape = useMemo(() => (outcome && graph ? shapeOfCase(graph) : null), [outcome, graph]);
  const row = useMemo(() => personalRow([...mine.map((c) => shapes.get(c.id)?.extent ?? { w: 0, h: 0 }), ...(freshShape ? [freshShape.extent] : [])]), [mine, shapes, freshShape]);
  const recalled = useMemo(() => new Set(memoryHighlight(snapshot).caseIds), [snapshot]);
  const picked = useMemo(() => new Set(selectedCall?.caseIds ?? []), [selectedCall]);

  const spine = useMemo(() => {
    const present = new Set(graph?.nodes.map((n) => n.type));
    const text = (type: string) => graph?.nodes.find((n) => n.type === type);
    const explanation = text('Explanation');
    const said = explanation && graph ? explanation.sourceIds.map((id) => graph.sources.find((s) => s.id === id)?.text).filter((t): t is string => Boolean(t)).join(' ') : '';
    const observation = text('Observation');
    const hypothesis = hypothesisLabels(snapshot)[0];
    return {
      present,
      concept: humanize(graph?.concept ?? concept ?? ''),
      attempt: problem ? `${problem.lhs} + ${problem.rhs} on the number line` : SCENE_COPY.attemptFallback,
      observation: observation ? [humanize(observation.meaning)] : [SCENE_COPY.observationFallback],
      said: quoted(said),
      hypothesis: hypothesis ? wrap(hypothesis.label, QUOTE_WRAP) : [],
      novel: hypothesis?.isNovel ?? false,
    };
  }, [graph, concept, problem, snapshot]);

  // The query nodes and edges the decision's evidence matched: read from the candidates the event carries.
  const usedQueryNodes = useMemo(() => {
    const evidence = new Set(decision?.evidenceIds ?? []);
    return new Set(search?.candidates.filter((c) => evidence.has(c.id)).flatMap((c) => c.matchedQueryNodeIds) ?? []);
  }, [search, decision]);
  const nodeUsed = (type: SpineType) => Boolean(graph?.nodes.some((n) => n.type === type && usedQueryNodes.has(n.id)));

  const line = recordedLine ?? rawLine(rawEvent, snapshot.addedNodeTypes);
  const strategy = outcome?.strategy ?? decision?.strategy ?? null;
  const filled = outcome !== null || (decision !== null && chosen);
  const group = decision && strategy ? decision.groups.find((g) => g.strategy === strategy) : undefined;
  const borrowed = decision?.basis === 'evidence' && group !== undefined && strategy !== 'clarify';
  const words = nextStepWords(snapshot, problem);
  const nextLines = wrap(words, NEXT_STEP_WRAP);
  const operation = operationText(snapshot, reveal);
  const sourceText = SOURCE_LABEL[source] + (outcome && !outcome.saved ? NOT_SAVED_SUFFIX : '');
  // The cutoff the search applied, from its own constants and the top score it reported; admission itself is read, never redone.
  const topScore = search?.scores[0]?.[1] ?? 0;
  const admittedFloor = Math.max(ADMISSION_MIN_SCORE, topScore - ADMISSION_TOP_MARGIN);
  const winnerBox = chosen && zone && decision ? zone.labels.find((l) => l.strategy === decision.strategy) : undefined;

  const step = outcome ? 'outcome' : chosen ? 6 : showLifted ? 5 : search ? 4 : graph?.nodes.some((n) => n.type === 'Hypothesis') ? 3 : graph?.nodes.some((n) => n.type === 'Explanation') ? 2 : graph ? 1 : 0;

  const spineY: Record<SpineType, number> = { Concept: SPINE.attempt - 62, Attempt: SPINE.attempt, Observation: SPINE.attempt + SPINE.step, Explanation: SPINE.attempt + SPINE.step * 2, Hypothesis: SPINE.attempt + SPINE.step * 3 };
  const spineText: Record<SpineType, { kind: string; lines: readonly string[] }> = {
    Concept: { kind: SCENE_COPY.concept, lines: [spine.concept] },
    Attempt: { kind: SCENE_COPY.attempt, lines: [spine.attempt] },
    Observation: { kind: SCENE_COPY.observation, lines: spine.observation },
    Explanation: { kind: SCENE_COPY.whatTheChildSaid, lines: spine.said },
    Hypothesis: { kind: SCENE_COPY.possibleReason, lines: spine.hypothesis },
  };
  const spineEdges: readonly { key: string; from: SpineType; to: SpineType; suggests?: boolean }[] = [
    { key: 'TARGETS', from: 'Concept', to: 'Attempt' },
    { key: 'OBSERVED', from: 'Attempt', to: 'Observation' },
    { key: 'EXPLAINED_BY', from: 'Observation', to: 'Explanation' },
    { key: 'SUPPORTS', from: 'Explanation', to: 'Hypothesis', suggests: true },
  ];

  const ariaLabel = `${SCENE_COPY.title}. ${SCENE_COPY.otherLearners}: ${otherLearnersSummary(others.length, learners.length)}. ${operation}. Next step: ${filled ? words : 'not chosen'}. Outcome: ${outcome ? outcome.outcome : 'pending, not checked'}. ${line.type} ${line.fields.join(' ')}`;

  return (
    <div className="learning-memory" data-step={step} data-reveal={reveal} data-state={snapshot.status} data-source={source}>
      <header className="lm-header">
        <strong className="lm-brand">llime</strong>
        <span className="lm-operation">{operation}</span>
        <span className="lm-source">{sourceText}</span>
      </header>
      <div className="lm-stage">
        <svg viewBox={`0 0 ${STAGE.width} ${STAGE.height}`} className="lm-svg" role="img" aria-label={ariaLabel}>
          {/* ① This learner */}
          <g className="one">
            <text x={ME.x} y={26} className="lm-h lm-title">{SCENE_COPY.title}</text>
            <path d={`M${ME.x} ${ME.y} V ${SPINE.attempt} H ${SPINE.x - 10}`} className="had" />
            <path d={row.busPath} className="own-bus" />
            <circle cx={ME.x} cy={ME.y} r={8} className="student me" />
            <text x={ME.x + 18} y={ME.y + 7} className="lm-h">{SCENE_COPY.student}</text>
            {outcome && <text x={row.endX} y={ME.y + 6} className="lm-kind accent">{SCENE_COPY.newSituation}</text>}
            {concept && <path d={`M${SPINE.x + 292} ${SPINE.attempt - 62} H ${HUB.x - 60} L ${HUB.x - 9} ${HUB.y + 4}`} className="instance" />}
            <g className={`bracket${snapshot.searching || search ? ' shown' : ''}`}>
              <rect x={70} y={SPINE.attempt - 92} width={394} height={SPINE.step * 3 + 150} rx={10} />
              <text x={90} y={SPINE.attempt + SPINE.step * 3 + 86} className="lm-kind accent">{SCENE_COPY.usedToSearch}</text>
            </g>
            <g className="spine">
              {spineEdges.map((e) => {
                const shown = spine.present.has(e.from) && spine.present.has(e.to);
                const used = usedQueryNodes.size > 0 && nodeUsed(e.from) && nodeUsed(e.to);
                return <line key={e.key} x1={SPINE.x} y1={spineY[e.from]} x2={SPINE.x} y2={spineY[e.to]} className={['q-edge', shown ? 'shown' : '', e.suggests ? 'suggests' : '', used ? 'used' : ''].join(' ').trim()} />;
              })}
              <text x={SPINE.x - 12} y={SPINE.attempt + SPINE.step * 2.55} textAnchor="end" className={`lm-kind suggests-label${spine.present.has('Hypothesis') ? ' shown' : ''}`}>{SCENE_COPY.suggests}</text>
              {TYPE_ORDER.map((type) => {
                const y = spineY[type];
                const copy = spineText[type];
                const isConcept = type === 'Concept';
                return (
                  <g key={type} className={['q-node', spine.present.has(type) ? 'shown' : '', nodeUsed(type) ? 'used' : ''].join(' ').trim()} data-type={type} data-novel={type === 'Hypothesis' && spine.novel ? 'true' : undefined}>
                    <circle cx={SPINE.x} cy={y} r={type === 'Hypothesis' ? 10 : 9} />
                    <text x={SPINE.x + 22} y={y + (isConcept ? 5 : -8)} className="lm-kind">{copy.kind}</text>
                    {isConcept ? <text x={SPINE.x + 22 + copy.kind.length * 12 + 10} y={y + 5} className="lm-value small">{copy.lines[0]}</text> : copy.lines.map((l, i) => <text key={l} x={SPINE.x + 22} y={y + 16 + i * 24} className="lm-value">{l}</text>)}
                  </g>
                );
              })}
            </g>
            {/* Result column: Attempt, next step, outcome. */}
            <g className="result">
              <path d={`M${SPINE.x + 9} ${SPINE.attempt - 4} C ${SPINE.x + 20} ${SPINE.attempt - 32}, ${SPINE.x + 40} ${SPINE.attempt - 32}, ${SPINE.x + 80} ${SPINE.attempt - 32} L ${RESULT_X - 20} ${SPINE.attempt - 32} Q ${RESULT_X} ${SPINE.attempt - 32} ${RESULT_X} ${SPINE.attempt - 12} L ${RESULT_X} ${SLOT.intervention - 18}`} className={`r-edge follow${filled && !outcome ? ' proposed' : ''}${outcome ? ' committed' : ''}`} />
              <line x1={RESULT_X} y1={SLOT.intervention + 18} x2={RESULT_X} y2={SLOT.outcome - 18} className={`r-edge evaluate${outcome ? ' committed' : ''}`} />
              <g className={`slot intervention${filled ? ' filled' : ''}`}>
                <rect x={RESULT_X - 18} y={SLOT.intervention - 18} width={36} height={36} rx={4} />
                {!filled && <text x={RESULT_X} y={SLOT.intervention + 7} textAnchor="middle" className="slot-q">?</text>}
              </g>
              <g className={`slot outcome${outcome ? ' filled' : ''}`} data-outcome={outcome?.outcome ?? ''}>
                <rect x={RESULT_X - 18} y={SLOT.outcome - 18} width={36} height={36} rx={18} />
                {!outcome && <text x={RESULT_X} y={SLOT.outcome + 7} textAnchor="middle" className="slot-q">?</text>}
                {outcome && <path className="slot-mark" d={outcome.outcome === 'independent' ? `M${RESULT_X - 8} ${SLOT.outcome} l5.5 5.5 l10 -11` : `M${RESULT_X - 7} ${SLOT.outcome - 7} l14 14 m0 -14 l-14 14`} />}
              </g>
              <g className="next-step-text">
                {filled ? (
                  <>
                    <text x={RESULT_X + 30} y={SLOT.intervention - 26} className="lm-kind accent">{outcome ? SCENE_COPY.used : borrowed && group ? fromCases(group.total) : decision?.strategy === 'clarify' ? SCENE_COPY.askTheChild : SCENE_COPY.nextStep}</text>
                    {nextLines.map((l, i) => <text key={l} x={RESULT_X + 30} y={SLOT.intervention + 8 + i * 24} className="lm-value strong">{l}</text>)}
                    {!outcome && <text x={RESULT_X + 30} y={SLOT.intervention + 8 + nextLines.length * 24 + 12} className="lm-kind">{borrowed && group ? solvedAloneLater(group.independent, group.total) : SCENE_COPY.noComparableCase}</text>}
                  </>
                ) : (
                  <>
                    <text x={RESULT_X + 30} y={SLOT.intervention - 8} className="lm-kind">{SCENE_COPY.nextStep}</text>
                    <text x={RESULT_X + 30} y={SLOT.intervention + 16} className="lm-value muted">{SCENE_COPY.nextStepNotChosen}</text>
                  </>
                )}
              </g>
              <g className="outcome-text">
                <text x={RESULT_X + 30} y={SLOT.outcome - 8} className="lm-kind">{SCENE_COPY.outcomeLabel}</text>
                <text x={RESULT_X + 30} y={SLOT.outcome + 16} className={`lm-value${outcome ? ' strong' : ' muted'}`}>{outcome ? (outcome.outcome === 'independent' ? SCENE_COPY.solvedAlone : SCENE_COPY.notYet) : filled ? SCENE_COPY.outcomePending : SCENE_COPY.outcomeNotChecked}</text>
                {outcome && <text x={RESULT_X + 30} y={SLOT.outcome + 40} className="lm-kind">{SCENE_COPY.retentionPending}</text>}
                {outcome && <text x={RESULT_X + 30} y={SLOT.outcome + 64} className="lm-kind">{outcome.saved ? SCENE_COPY.addedToMemory : SCENE_COPY.localPreview}</text>}
              </g>
            </g>
            {/* Selected cases, grouped as the decision grouped them. */}
            <g className="zone">
              {search && showLifted && <text x={ZONE.x} y={ZONE.y} className="lm-kind accent">{selectedHeading(search.admitted.length, admittedFloor)}</text>}
              {zone && decision && decision.groups.map((g) => {
                const label = zone.labels.find((l) => l.strategy === g.strategy);
                if (!label) return null;
                const isChosen = chosen && g.strategy === decision.strategy;
                return <text key={g.strategy} x={ZONE.x} y={label.y} className={`lm-value small${isChosen ? ' strong accent-fill' : ' muted'}`}>{groupLabel(g.strategy, g.independent, g.total)}</text>;
              })}
              {winnerBox && <rect x={ZONE.x - 8} y={winnerBox.top - 2} width={ZONE.w + 8} height={winnerBox.bottom - winnerBox.top + 4} rx={4} className="won" />}
            </g>
            <g className="flows">
              {chosen && !outcome && borrowed && winnerBox && <path d={`M${ZONE.x - 8} ${(winnerBox.top + winnerBox.bottom) / 2} H ${TRUNK_X} V ${SLOT.intervention} H ${RESULT_X - 20}`} className="flow trunk" />}
            </g>
          </g>

          {/* Concept hierarchy recalled before the child's own graph exists. */}
          {!hasGraph && snapshot.memory && <ConceptLinks links={snapshot.memory.links} />}
          {!hasGraph && lessonText && <LessonPanel text={lessonText} />}

          {/* ② Every other learner: fixed tiles, fixed places. */}
          <g className="two">
            <text x={FIELD.x - 8} y={26} className="lm-h">{SCENE_COPY.otherLearners}</text>
            <text x={FIELD.x - 8} y={66} className="lm-value small">{otherLearnersSummary(others.length, learners.length)}</text>
            <text x={FIELD.x - 8} y={92} className="lm-kind">{search ? fieldCaption(search.admitted.length) : SCENE_COPY.tileCaption}</text>
            <g className="tree">{field.busPaths.map((d) => <path key={d} d={d} className="bus" />)}</g>
            <circle cx={HUB.x} cy={HUB.y} r={8} className="hub" />
            {concept && <text x={HUB.x + 16} y={HUB.y + 6} className="lm-kind">{sharedConcept(concept)}</text>}
            <g className="tiles">
              {field.tiles.map((t) => <rect key={t.learnerId} x={t.x} y={t.y} width={t.w} height={t.h} rx={3} className="tile" />)}
              {field.tiles.map((t) => <circle key={`s_${t.learnerId}`} cx={t.studentX} cy={t.studentY} r={2.6} className="student" />)}
            </g>
            <g className="owns">
              {others.map((c) => {
                const place = field.placements.get(c.id);
                return place ? <line key={c.id} x1={place.fromX} y1={place.fromY} x2={place.x} y2={place.y} className={`own${showLifted && admittedById.has(c.id) ? ' gone' : ''}`} /> : null;
              })}
            </g>
          </g>

          {/* Branches: other learners' situations, this learner's earlier ones and the new one. */}
          <g className="glyphs">
            {others.map((c) => {
              const shape = shapes.get(c.id);
              const rest = field.placements.get(c.id);
              if (!shape || !rest) return null;
              const row_ = admittedById.get(c.id);
              const place = (showLifted ? zone?.placements.get(c.id) : undefined) ?? rest;
              const isLifted = place !== rest;
              const score = scores.get(c.id);
              const lostOut = isLifted && chosen && row_ !== undefined && decision !== null && row_.strategy !== decision.strategy;
              const flags = ['ranked', score !== undefined ? 'scored' : '', row_ ? 'above' : '', isLifted ? 'lifted open' : '', lostOut ? 'lost' : '', picked.has(c.id) ? 'picked' : ''].filter(Boolean).join(' ');
              return <Glyph key={c.id} caseId={c.id} shape={shape} at={place} lit={litByCase.get(c.id) ?? EMPTY_SET} flags={flags} similarity={score === undefined ? null : score ** BRIGHTNESS_POWER} delayMs={isLifted ? lifted.indexOf(c.id) * LIFT_STAGGER_MS : 0} />;
            })}
            {mine.map((c, k) => {
              const shape = shapes.get(c.id);
              const at = row.placements[k];
              return shape && at ? <Glyph key={c.id} caseId={c.id} shape={shape} at={at} lit={EMPTY_SET} flags={`mine open${recalled.has(c.id) ? ' recalled' : ''}${picked.has(c.id) ? ' picked' : ''}`} similarity={null} delayMs={0} /> : null;
            })}
            {freshShape && graph && row.placements[mine.length] && <Glyph key="fresh" caseId={graph.id} shape={freshShape} at={row.placements[mine.length] ?? { x: ME.row.x, y: ME.row.y, s: 1 }} lit={EMPTY_SET} flags="mine open fresh" similarity={null} delayMs={0} />}
          </g>
        </svg>
      </div>
      <div className="lm-raw" tabIndex={0} role="log" aria-label="Agent output" aria-live="polite">
        <b>{line.type}</b>
        <code>{line.fields.join(' · ')}</code>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Opening view pieces.

const CURRICULUM_PLACE: Readonly<Record<CurriculumConcept, { x: number; y: number }>> = {
  subtraction: { x: 150, y: 260 },
  addition: { x: 400, y: 260 },
  subtraction_within_20: { x: 150, y: 430 },
  addition_within_20: { x: 400, y: 430 },
};

// The records the memory read returned, as the hierarchy they describe: scopes under their concept and
// the one similar relation between the two concepts.
function ConceptLinks({ links }: { links: readonly ConceptLink[] }) {
  const ends = [...new Set(links.flatMap((l) => [l.from, l.to]))];
  return (
    <g className="concept-links">
      {links.map((l) => {
        const a = CURRICULUM_PLACE[l.from];
        const b = CURRICULUM_PLACE[l.to];
        return (
          <g key={`${l.from}>${l.to}`} className={`concept-link ${l.kind}`} data-kind={l.kind}>
            <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            <text x={(a.x + b.x) / 2 + (l.kind === 'subconcept' ? 14 : 0)} y={(a.y + b.y) / 2 - (l.kind === 'similar' ? 12 : 0)} textAnchor={l.kind === 'similar' ? 'middle' : 'start'} className="lm-kind accent">{l.kind === 'similar' ? 'similar' : 'scope of'}</text>
          </g>
        );
      })}
      {ends.map((id) => {
        const p = CURRICULUM_PLACE[id];
        return (
          <g key={id} className="concept-node">
            <circle cx={p.x} cy={p.y} r={9} />
            <text x={p.x} y={p.y + 32} textAnchor="middle" className="lm-value small">{humanize(id)}</text>
          </g>
        );
      })}
    </g>
  );
}

const LESSON_PANEL = { x: 520, y: 150, w: 290, lines: 14, wrap: 30 } as const;

function LessonPanel({ text }: { text: string }) {
  const lines = wrap(text.replace(/\s+/g, ' '), LESSON_PANEL.wrap).slice(0, LESSON_PANEL.lines);
  return (
    <g className="lesson-panel">
      <text x={LESSON_PANEL.x} y={LESSON_PANEL.y - 26} className="lm-kind">TODAY’S LESSON</text>
      {lines.map((l, i) => <text key={`${i}${l}`} x={LESSON_PANEL.x} y={LESSON_PANEL.y + i * 24} className="lm-value small muted">{l}</text>)}
    </g>
  );
}

// ---------------------------------------------------------------------------------------------
// Live pacing: the scene reveals a finished search in two beats so the lift is seen, not missed.

const REVEAL_BEAT_MS = 1400;

export function useRevealPacing(snapshot: ProjectionSnapshot, reducedMotion: boolean): Reveal {
  // A snapshot that already holds a result (a refresh) shows its final state at once.
  const [reveal, setReveal] = useState<Reveal>(snapshot.search ? 'chosen' : 'none');
  const searchKey = snapshot.search ? `${snapshot.search.queryId}:${snapshot.search.rankingHash}` : null;
  const shown = useRef(searchKey);
  useEffect(() => {
    if (searchKey === shown.current) return;
    shown.current = searchKey;
    if (searchKey === null) return setReveal('none');
    if (reducedMotion) return setReveal('chosen');
    setReveal('none');
    const lift = setTimeout(() => setReveal('lifted'), REVEAL_BEAT_MS);
    const choose = setTimeout(() => setReveal('chosen'), REVEAL_BEAT_MS * 2);
    return () => (clearTimeout(lift), clearTimeout(choose));
  }, [searchKey, reducedMotion]);
  return reveal;
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia(REDUCED_MOTION).matches);
  useEffect(() => {
    const query = window.matchMedia(REDUCED_MOTION);
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

// The scene for one live run. It reads only this app's polling routes and the bundled corpus.
// `call` names a saved tool call to highlight, as handed over by the inspector.
export function LiveBackendScene({ runId, call }: { runId: string; call?: { callId: string; attempt: number } | null }) {
  const { corpus, error } = useCorpus();
  const index = useMemo(() => (corpus ? indexCorpus(corpus.cases) : null), [corpus]);
  if (error) return <p role="alert">{error}</p>;
  if (!corpus || !index) return null;
  return <LiveRunView runId={runId} corpus={corpus} index={index} call={call ?? null} />;
}

function LiveRunView({ runId, corpus, index, call }: { runId: string; corpus: Corpus; index: ReturnType<typeof indexCorpus>; call: { callId: string; attempt: number } | null }) {
  const { snapshot, raw, problem, lessonText, corpusHash, events } = useLiveRun(runId, index);
  const reveal = useRevealPacing(snapshot, usePrefersReducedMotion());
  const selectedCall = useMemo(() => {
    if (!call) return null;
    const invocation = buildInspectorModel(events).calls.get(`${call.callId}#${call.attempt}`);
    return invocation ? selectedCallFor(runId, invocation) : null;
  }, [call, events, runId]);
  // The run pinned a corpus by hash; drawing its result over a different one would show cases that were not searched.
  if (corpusHash !== null && corpusHash !== corpus.corpusHash) return <p role="alert">{CORPUS_MISMATCH}</p>;
  return <LearningMemoryScene snapshot={snapshot} reveal={reveal} rawEvent={raw} source="live" cases={corpus.cases} problem={problem} lessonText={lessonText} selectedCall={selectedCall} />;
}

// The page behind /backend?runId=<run id>&call=<call id>&attempt=<n>.
export function BackendSurface({ runId }: { runId: string | null }) {
  const params = new URLSearchParams(window.location.search);
  const callId = params.get('call');
  const attempt = Number(params.get('attempt') ?? 1);
  if (!runId) return <p role="alert">{MISSING_RUN}</p>;
  return <LiveBackendScene runId={runId} call={callId ? { callId, attempt: Number.isInteger(attempt) && attempt > 0 ? attempt : 1 } : null} />;
}
