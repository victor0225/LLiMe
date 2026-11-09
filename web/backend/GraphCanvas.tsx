// The 3D evidence graph. The Three.js scene is built once in an effect and updated in place: React state
// holds only the camera mode, and props change colours and visibility, never positions. Positions come from
// each learner's place in the sorted corpus and each branch's typed structure, so they are stable between
// runs and cannot influence retrieval.
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { LearningCase, NodeType, ToolName } from '@core/domain';
import { branchLayout, type BranchLayout, sortLearners } from './branch-layout.js';
import { liftedCaseIds, litEdgeIds, type ProjectionSnapshot } from './event-projection.js';
import { hypothesisText } from './learning-copy.js';
import type { Reveal } from './LearningMemoryScene.js';

// The inspector's selected call. The canvas highlights these IDs and never derives them.
export interface SelectedCall {
  readonly callId: string;
  readonly name: ToolName;
  readonly caseIds: readonly string[];
  readonly nodeIds: readonly string[];
}

export interface DisposalReport {
  readonly geometriesBefore: number;
  readonly geometriesAfter: number;
  readonly disposedGeometries: number;
  readonly disposedMaterials: number;
  readonly disposedTextures: number;
  readonly rendererDisposed: boolean;
}

export interface GraphCanvasProps {
  readonly snapshot: ProjectionSnapshot;
  readonly cases: readonly LearningCase[];
  readonly reveal: Reveal;
  readonly selectedCall?: SelectedCall | null;
  // Start in the static camera; the person can still switch. Defaults to the system reduced-motion setting.
  readonly staticCamera?: boolean;
  // Called once on unmount with what was released, so a test can see nothing is left on the GPU.
  readonly onDisposed?: (report: DisposalReport) => void;
}

const COLORS = {
  ground: 0x141a22,
  dim: 0x3d4955,
  muted: 0x7d8b99,
  ink: 0xe9eef3,
  accent: 0xff9d45,
  recalled: 0xffc58f,
} as const;

// One branch unit in world units, and the spacing of learners' cells in the field.
const UNIT = 1.1;
const CELL = 30;
const FOCAL_ORIGIN = new THREE.Vector3(-46, 14, 0);
const MINE_ORIGIN = new THREE.Vector3(-46, 14, -44);
// A small seeded depth offset per learner keeps the field from reading as a flat grid, and never changes.
const SEED_DEPTH = 7;
const LABEL_CANVAS = { width: 512, height: 96, font: '600 38px system-ui, sans-serif', world: { w: 14, h: 2.6 } } as const;
const CAMERA_PRESET = { position: new THREE.Vector3(-8, 38, 118), target: new THREE.Vector3(-6, -14, 0) } as const;
const AUTO_ROTATE_SPEED = 0.35;

// Deterministic 32-bit hash and generator, so a learner's depth offset depends only on the learner's ID.
const hash32 = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};
const unitFrom = (text: string) => (hash32(text) % 10000) / 10000;

type Spot = { readonly x: number; readonly y: number; readonly z: number };

interface BranchNode {
  readonly id: string;
  readonly caseId: string;
  readonly type: NodeType;
  readonly stage: 'context' | 'result';
  readonly at: Spot;
}
interface BranchEdge {
  readonly id: string;
  readonly caseId: string;
  readonly stage: 'context' | 'result';
  readonly a: Spot;
  readonly b: Spot;
}

function place(layout: BranchLayout, origin: Spot, scale = 1): { nodes: (Pick<BranchNode, 'id' | 'type' | 'stage' | 'at'>)[]; edges: (Pick<BranchEdge, 'id' | 'stage' | 'a' | 'b'>)[] } {
  const spot = (x: number, y: number): Spot => ({ x: origin.x + x * UNIT * scale, y: origin.y - y * UNIT * scale, z: origin.z });
  return {
    nodes: layout.nodes.map((p) => ({ id: p.node.id, type: p.node.type, stage: p.node.stage, at: spot(p.x, p.y) })),
    edges: layout.edges.flatMap((e) => {
      const a = layout.pos.get(e.from);
      const b = layout.pos.get(e.to);
      return a && b ? [{ id: e.id, stage: e.stage, a: spot(a.x, a.y), b: spot(b.x, b.y) }] : [];
    }),
  };
}

// Field geometry: one cell per learner on a grid in the sorted corpus order; a learner's situations sit in
// rows inside the cell.
function fieldBranches(others: readonly LearningCase[]): { nodes: BranchNode[]; edges: BranchEdge[] } {
  const learners = sortLearners(others.map((c) => c.studentId));
  const cols = Math.max(1, Math.ceil(Math.sqrt(learners.length * 1.6)));
  const nodes: BranchNode[] = [];
  const edges: BranchEdge[] = [];
  learners.forEach((learner, index) => {
    const depth = (unitFrom(learner) - 0.5) * SEED_DEPTH;
    const cell = { x: 4 + (index % cols) * CELL, y: 0, z: 8 + Math.floor(index / cols) * -CELL * 0.8 + depth };
    others
      .filter((c) => c.studentId === learner)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .forEach((c, k) => {
        const origin = { x: cell.x + (k % 3) * 9, y: cell.y - Math.floor(k / 3) * 12, z: cell.z + (k % 3) * 1.2 };
        const laid = place(branchLayout(c, { withResult: true }), origin, 0.7);
        for (const n of laid.nodes) nodes.push({ ...n, caseId: c.id });
        for (const e of laid.edges) edges.push({ ...e, caseId: c.id });
      });
  });
  return { nodes, edges };
}

const hex = (value: number) => new THREE.Color(value);

// Everything the scene owns, so one call can release all of it.
class Disposables {
  readonly geometries = new Set<THREE.BufferGeometry>();
  readonly materials = new Set<THREE.Material>();
  readonly textures = new Set<THREE.Texture>();
  private counts = { geometries: 0, materials: 0, textures: 0 };

  geometry<T extends THREE.BufferGeometry>(g: T): T {
    this.geometries.add(g);
    return g;
  }
  material<T extends THREE.Material>(m: T): T {
    this.materials.add(m);
    return m;
  }
  texture<T extends THREE.Texture>(t: T): T {
    this.textures.add(t);
    return t;
  }
  release(): { geometries: number; materials: number; textures: number } {
    for (const g of this.geometries) (g.dispose(), this.counts.geometries++);
    for (const m of this.materials) (m.dispose(), this.counts.materials++);
    for (const t of this.textures) (t.dispose(), this.counts.textures++);
    this.geometries.clear();
    this.materials.clear();
    this.textures.clear();
    return this.counts;
  }
}

const NODE_SHAPE: Record<NodeType, 'sphere' | 'ring' | 'box' | 'octa'> = {
  Attempt: 'sphere',
  Concept: 'sphere',
  Observation: 'sphere',
  Explanation: 'sphere',
  Question: 'sphere',
  Retry: 'sphere',
  Hypothesis: 'ring',
  Intervention: 'box',
  Outcome: 'octa',
};

interface Controller {
  update: (props: GraphCanvasProps) => void;
  setStatic: (on: boolean) => void;
  resize: () => void;
  dispose: () => DisposalReport;
  nodeCount: () => number;
}

function createController(host: HTMLElement, initial: GraphCanvasProps, startStatic: boolean): Controller {
  const trash = new Disposables();
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(COLORS.ground);
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 600);
  camera.position.copy(CAMERA_PRESET.position);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(CAMERA_PRESET.target);
  controls.enableDamping = false;
  controls.update();

  let needsRender = true;
  let frame = 0;
  let disposed = false;
  const requestRender = () => {
    needsRender = true;
  };
  controls.addEventListener('change', requestRender);

  const others = initial.cases.filter((c) => c.studentId !== initial.snapshot.graph?.studentId);
  const field = fieldBranches(others);
  const nodeIndex = new Map<string, number>();
  const nodeIsResult: boolean[] = [];

  // Nodes: one instanced mesh per shape, all drawn once, each instance a fixed place.
  const meshes = new Map<'sphere' | 'ring' | 'box' | 'octa', { mesh: THREE.InstancedMesh; ids: string[] }>();
  const shapes: Record<'sphere' | 'ring' | 'box' | 'octa', THREE.BufferGeometry> = {
    sphere: trash.geometry(new THREE.SphereGeometry(0.55, 6, 4)),
    ring: trash.geometry(new THREE.TorusGeometry(0.6, 0.16, 4, 8)),
    box: trash.geometry(new THREE.BoxGeometry(1, 1, 1)),
    octa: trash.geometry(new THREE.OctahedronGeometry(0.75)),
  };
  const nodeMaterial = trash.material(new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const dummy = new THREE.Object3D();
  const baseColor = hex(COLORS.dim);
  const grouped = new Map<'sphere' | 'ring' | 'box' | 'octa', BranchNode[]>();
  for (const n of field.nodes) {
    const shape = NODE_SHAPE[n.type];
    grouped.set(shape, [...(grouped.get(shape) ?? []), n]);
  }
  const nodeSlots: { shape: 'sphere' | 'ring' | 'box' | 'octa'; slot: number; node: BranchNode }[] = [];
  for (const [shape, list] of grouped) {
    const mesh = new THREE.InstancedMesh(shapes[shape], nodeMaterial, list.length);
    list.forEach((n, slot) => {
      dummy.position.set(n.at.x, n.at.y, n.at.z);
      dummy.scale.setScalar(n.stage === 'result' ? 0 : 1);
      dummy.updateMatrix();
      mesh.setMatrixAt(slot, dummy.matrix);
      mesh.setColorAt(slot, baseColor);
      nodeIndex.set(n.id, nodeSlots.length);
      nodeIsResult.push(n.stage === 'result');
      nodeSlots.push({ shape, slot, node: n });
    });
    meshes.set(shape, { mesh, ids: list.map((n) => n.id) });
    scene.add(mesh);
  }

  // Edges: one line buffer with a colour per vertex, so lighting an edge changes two colours and nothing else.
  const edgePositions = new Float32Array(field.edges.length * 6);
  const edgeColors = new Float32Array(field.edges.length * 6);
  const edgeSlot = new Map<string, number>();
  const edgesOfCase = new Map<string, number[]>();
  field.edges.forEach((e, i) => {
    edgePositions.set([e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z], i * 6);
    edgeSlot.set(e.id, i);
    edgesOfCase.set(e.caseId, [...(edgesOfCase.get(e.caseId) ?? []), i]);
  });
  const edgeGeometry = trash.geometry(new THREE.BufferGeometry());
  edgeGeometry.setAttribute('position', new THREE.BufferAttribute(edgePositions, 3));
  const edgeColorAttribute = new THREE.BufferAttribute(edgeColors, 3);
  edgeGeometry.setAttribute('color', edgeColorAttribute);
  const edgeMaterial = trash.material(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }));
  const edgeLines = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  scene.add(edgeLines);

  const paintEdge = (slot: number, color: THREE.Color, visible: boolean) => {
    const rgb = visible ? color : new THREE.Color(0, 0, 0);
    edgeColors.set([rgb.r, rgb.g, rgb.b, rgb.r, rgb.g, rgb.b], slot * 6);
  };

  // The focal learner's own graph grows as events are accepted and is rebuilt whenever it changes.
  const focal = new THREE.Group();
  scene.add(focal);
  let focalTrash = new Disposables();
  let focalKey = '';
  const label = (text: string, at: Spot, tint: number) => {
    const canvas = document.createElement('canvas');
    canvas.width = LABEL_CANVAS.width;
    canvas.height = LABEL_CANVAS.height;
    const g = canvas.getContext('2d');
    if (g) {
      g.font = LABEL_CANVAS.font;
      g.fillStyle = `#${tint.toString(16).padStart(6, '0')}`;
      g.textBaseline = 'middle';
      g.fillText(text.length > 26 ? `${text.slice(0, 25)}…` : text, 8, LABEL_CANVAS.height / 2);
    }
    const texture = focalTrash.texture(new THREE.CanvasTexture(canvas));
    const sprite = new THREE.Sprite(focalTrash.material(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false })));
    sprite.scale.set(LABEL_CANVAS.world.w, LABEL_CANVAS.world.h, 1);
    sprite.position.set(at.x + LABEL_CANVAS.world.w / 2 + 2, at.y, at.z);
    return sprite;
  };
  const rebuildFocal = (props: GraphCanvasProps) => {
    const graph = props.snapshot.graph;
    const key = graph ? `${graph.id}:${graph.nodes.length}:${props.snapshot.search ? 's' : ''}:${props.selectedCall?.callId ?? ''}` : '';
    if (key === focalKey) return;
    focalKey = key;
    focal.clear();
    focalTrash.release();
    focalTrash = new Disposables();
    if (!graph) return;
    const laid = place(branchLayout(graph, { withResult: true }), FOCAL_ORIGIN, 3.2);
    const lit = props.snapshot.search ? new Set(props.snapshot.search.candidates.filter((c) => props.snapshot.search?.decision.evidenceIds.includes(c.id)).flatMap((c) => c.matchedQueryNodeIds)) : new Set<string>();
    const hypotheses = new Map(graph.nodes.filter((n) => n.type === 'Hypothesis').map((n) => [n.id, hypothesisText(n)]));
    for (const n of laid.nodes) {
      const shape = NODE_SHAPE[n.type];
      const geometry = focalTrash.geometry(shape === 'sphere' ? new THREE.SphereGeometry(1.1, 16, 12) : shape === 'ring' ? new THREE.TorusGeometry(1.2, 0.3, 8, 20) : shape === 'box' ? new THREE.BoxGeometry(2, 2, 2) : new THREE.OctahedronGeometry(1.4));
      const selected = props.selectedCall?.nodeIds.includes(n.id) ?? false;
      const color = selected || lit.has(n.id) || n.stage === 'result' ? COLORS.accent : COLORS.ink;
      const mesh = new THREE.Mesh(geometry, focalTrash.material(new THREE.MeshBasicMaterial({ color })));
      mesh.position.set(n.at.x, n.at.y, n.at.z);
      focal.add(mesh);
      focal.add(label(hypotheses.get(n.id) ?? `${n.type.toUpperCase()}`, n.at, n.type === 'Hypothesis' ? COLORS.muted : COLORS.ink));
    }
    const points = laid.edges.flatMap((e) => [new THREE.Vector3(e.a.x, e.a.y, e.a.z), new THREE.Vector3(e.b.x, e.b.y, e.b.z)]);
    const geometry = focalTrash.geometry(new THREE.BufferGeometry().setFromPoints(points));
    focal.add(new THREE.LineSegments(geometry, focalTrash.material(new THREE.LineBasicMaterial({ color: COLORS.ink }))));
  };

  // This learner's earlier situations, one place per situation, with the recalled ones accented.
  const mineGroup = new THREE.Group();
  scene.add(mineGroup);
  const mineTrash = new Disposables();
  const mine = initial.cases.filter((c) => c.studentId === initial.snapshot.graph?.studentId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const mineEdges: { caseId: string; slot: number }[] = [];
  const minePositions: number[] = [];
  mine.forEach((c, k) => {
    const laid = place(branchLayout(c, { withResult: true }), { x: MINE_ORIGIN.x + (k % 6) * 9, y: MINE_ORIGIN.y - Math.floor(k / 6) * 12, z: MINE_ORIGIN.z }, 0.7);
    for (const e of laid.edges) {
      mineEdges.push({ caseId: c.id, slot: minePositions.length / 6 });
      minePositions.push(e.a.x, e.a.y, e.a.z, e.b.x, e.b.y, e.b.z);
    }
  });
  const mineColors = new Float32Array(minePositions.length);
  const mineGeometry = mineTrash.geometry(new THREE.BufferGeometry());
  mineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(minePositions), 3));
  const mineColorAttribute = new THREE.BufferAttribute(mineColors, 3);
  mineGeometry.setAttribute('color', mineColorAttribute);
  mineGroup.add(new THREE.LineSegments(mineGeometry, mineTrash.material(new THREE.LineBasicMaterial({ vertexColors: true }))));

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = host;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    requestRender();
  };

  const setStatic = (on: boolean) => {
    controls.enableRotate = !on;
    controls.autoRotate = !on;
    controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
    if (on) {
      camera.position.copy(CAMERA_PRESET.position);
      controls.target.copy(CAMERA_PRESET.target);
    }
    controls.update();
    requestRender();
  };

  const update = (props: GraphCanvasProps) => {
    const lifted = new Set(props.reveal === 'none' ? [] : liftedCaseIds(props.snapshot));
    const lit = litEdgeIds(props.snapshot);
    const selectedCases = new Set(props.selectedCall?.caseIds ?? []);
    const scores = new Map(props.snapshot.search?.scores ?? []);
    const dim = hex(COLORS.dim);
    const accent = hex(COLORS.accent);
    const ink = hex(COLORS.ink);
    // Edges: dim by default, brighter with similarity, accent when the search lit them.
    for (const [caseId, slots] of edgesOfCase) {
      const score = scores.get(caseId);
      const base = score === undefined ? dim : dim.clone().lerp(ink, score ** 1.5 * 0.55);
      const isLifted = lifted.has(caseId);
      for (const slot of slots) {
        const e = field.edges[slot];
        if (!e) continue;
        const color = lit.has(e.id) || selectedCases.has(caseId) ? accent : base;
        paintEdge(slot, color, e.stage === 'context' || isLifted);
      }
    }
    edgeColorAttribute.needsUpdate = true;
    // Nodes: result nodes appear only on lifted cases; everything else keeps its place.
    for (const { shape, slot, node } of nodeSlots) {
      const entry = meshes.get(shape);
      if (!entry) continue;
      const isLifted = lifted.has(node.caseId);
      dummy.position.set(node.at.x, node.at.y, node.at.z);
      dummy.scale.setScalar(node.stage === 'result' && !isLifted ? 0 : 1);
      dummy.updateMatrix();
      entry.mesh.setMatrixAt(slot, dummy.matrix);
      entry.mesh.setColorAt(slot, selectedCases.has(node.caseId) || isLifted ? accent : dim);
    }
    for (const { mesh } of meshes.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    // This learner's earlier situations: the recalled ones are accented.
    const recalled = new Set(props.snapshot.memory?.caseIds ?? []);
    const muted = hex(COLORS.muted);
    const recalledColor = hex(COLORS.recalled);
    for (const { caseId, slot } of mineEdges) {
      const color = recalled.has(caseId) ? recalledColor : muted;
      mineColors.set([color.r, color.g, color.b, color.r, color.g, color.b], slot * 6);
    }
    mineColorAttribute.needsUpdate = true;
    rebuildFocal(props);
    requestRender();
  };

  const loop = () => {
    if (disposed) return;
    frame = requestAnimationFrame(loop);
    if (controls.autoRotate) controls.update();
    if (!needsRender) return;
    needsRender = false;
    renderer.render(scene, camera);
  };
  resize();
  setStatic(startStatic);
  update(initial);
  loop();

  return {
    update,
    setStatic,
    resize,
    nodeCount: () => nodeSlots.length,
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(frame);
      controls.removeEventListener('change', requestRender);
      controls.dispose();
      const geometriesBefore = renderer.info.memory.geometries;
      focal.clear();
      const released = [trash.release(), focalTrash.release(), mineTrash.release()];
      renderer.dispose();
      renderer.domElement.remove();
      return {
        geometriesBefore,
        geometriesAfter: renderer.info.memory.geometries,
        disposedGeometries: released.reduce((n, r) => n + r.geometries, 0),
        disposedMaterials: released.reduce((n, r) => n + r.materials, 0),
        disposedTextures: released.reduce((n, r) => n + r.textures, 0),
        rendererDisposed: true,
      };
    },
  };
}

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function GraphCanvas(props: GraphCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<Controller | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [isStatic, setIsStatic] = useState(() => props.staticCamera ?? prefersReducedMotion());
  const [failure, setFailure] = useState<string | null>(null);
  const [nodes, setNodes] = useState(0);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let made: Controller;
    try {
      made = createController(element, latest.current, isStatic);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The 3D view could not start');
      return;
    }
    controller.current = made;
    setNodes(made.nodeCount());
    const observer = new ResizeObserver(() => made.resize());
    observer.observe(element);
    return () => {
      observer.disconnect();
      controller.current = null;
      const report = made.dispose();
      latest.current.onDisposed?.(report);
    };
    // The scene is built once; props reach it through the update effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => controller.current?.update(props), [props.snapshot, props.reveal, props.selectedCall, props.cases]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => controller.current?.setStatic(isStatic), [isStatic]);

  if (failure) return <p role="alert" className="graph-failure">{`The 3D graph needs WebGL: ${failure}`}</p>;
  return (
    <div className="graph-canvas" data-nodes={nodes} data-camera={isStatic ? 'static' : 'orbit'}>
      <div ref={host} className="graph-canvas-host" role="img" aria-label="3D view of this student’s memory beside every other student’s synthetic memory" />
      <button type="button" className="graph-camera-toggle" aria-pressed={isStatic} onClick={() => setIsStatic((on) => !on)}>
        {isStatic ? 'Static camera' : 'Slow orbit'}
      </button>
    </div>
  );
}
