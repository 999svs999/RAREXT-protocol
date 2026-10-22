import {
  canonicalize,
  countGates,
  score,
  simulate,
  tasks,
} from "../../../packages/core/src/index.ts";
import type {
  Anchor,
  Circuit,
  Component,
  ComponentType,
  Publication,
  AdapterInfo,
  Challenge,
  PublicationPayload,
  PublicationSource,
  Semantics,
  SourceResolution,
  Task,
} from "../../../packages/core/src/index.ts";
import { initI18n, localeTag, t } from "./i18n.ts";
import { runWork, type WorkBoard } from "./work.ts";

const NODE_WIDTH = 144;
const NODE_HEIGHT = 64;
const SVG_WIDTH = 1000;
const SVG_HEIGHT = 640;
const PAGE_SIZE = 10;
const STORAGE_PREFIX = "rarext:circuit:";
const DRAFT_PREFIX = "rarext:draft:";
const HANDLE_KEY = "rarext:handle";
const IDENTITY_KEY = "rarext:identity:v1";
const WELCOME_KEY = "rarext:welcomed:v1";
const CANVAS_HELP_KEY = "rarext:canvas-help-dismissed:v1";

const HINTS: Record<string, string[]> = {
  "half-adder": [
    "NOT-BOTH turns off only when both of its inputs are on. Start there.",
    "The answer is on when exactly one start is on. That takes four NOT-BOTH blocks.",
    "The extra is on only when both starts are on. One block can make that.",
    "Try one NOT-BOTH on both starts, then use its result to build the answer and the extra.",
  ],
  majority: [
    "The answer turns on when at least two of the three starts are on.",
    "Compare the starts in pairs: A with B, A with C, and B with C.",
    "Combine the pair results so that any two on values turn the answer on.",
  ],
  mux2: [
    "The chooser decides which of the other two starts reaches the answer.",
    "When the chooser is off, A should win. When it is on, B should win.",
    "Use the chooser to switch each start on or off before combining them.",
  ],
};

const ARITY: Record<ComponentType, number> = {
  INPUT: 0,
  OUTPUT: 1,
  NAND: 2,
  LATCH: 2,
};

interface UiNode {
  id: string;
  type: ComponentType;
  x: number;
  y: number;
  inputs: string[];
}

interface CaseResult {
  inputValues: string[];
  expectedValues: string[];
  actualValues: string[];
  pass: boolean;
}

interface Evaluation {
  cases: CaseResult[];
  design: ReturnType<typeof score> | null;
  error: string | null;
}

interface DragState {
  id: string;
  dx: number;
  dy: number;
}

interface PanState {
  pointerId: number;
  startX: number;
  startY: number;
  viewX: number;
  viewY: number;
}

interface PinchState {
  distance: number;
  midX: number;
  midY: number;
}

interface StoredIdentity {
  handle: string;
  keyId: string;
  publicKey: JsonWebKey;
  privateKey: JsonWebKey;
}

interface Draft {
  title: string;
  body: string;
  parentId: string | null;
  remixSourceTitle: string | null;
  source: PublicationSource | null;
}

function el<T extends Element = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element: ${id}`);
  return element as unknown as T;
}

const svg = el<SVGSVGElement>("canvas");
const taskSelect = el<HTMLSelectElement>("task-select");
const taskDescription = el("task-description");
const taskProgress = el("task-progress");
const challengeDots = el("challenge-dots");
const truthTable = el("truth-table");
const testSummary = el("test-summary");
const scoreStatus = el("score-status");
const scoreCases = el("score-cases");
const scoreGates = el("score-gates");
const scoreValue = el("score-value");
const scoreMeter = el("score-meter");
const scoreMeterBar = el("score-meter-bar");
const checkMeter = el("check-meter");
const checkMeterBar = el("check-meter-bar");
const shareLocked = el("share-locked");
const shareSection = el("share-section");
const shareLockedCopy = el("share-locked-copy");
const hintButton = el<HTMLButtonElement>("hint-button");
const hintBox = el("hint-box");
const nextStepPanel = el("next-step");
const nextPuzzleButton = el<HTMLButtonElement>("next-puzzle");
const canvasHelp = el("canvas-help");
const canvasHelpText = el("canvas-help-text");
const dismissCanvasHelpButton = el<HTMLButtonElement>("dismiss-canvas-help");
const viewBoardButton = el<HTMLButtonElement>("view-board");
const welcomeEl = el("welcome");
const welcomeCloseButton = el<HTMLButtonElement>("welcome-close");
const welcomeStartButton = el<HTMLButtonElement>("welcome-start");
const welcomeExploreButton = el<HTMLButtonElement>("welcome-explore");
const openGuideButton = el<HTMLButtonElement>("open-guide");
const authorInput = el<HTMLInputElement>("author");
const titleInput = el<HTMLInputElement>("title");
const bodyInput = el<HTMLTextAreaElement>("body");
const publishStatus = el("publish-status");
const feedEl = el("feed");
const toastEl = el("toast");
const remixBanner = el("remix-banner");
const remixTitle = el("remix-title");
const identityStatus = el("identity-status");
const resetIdentityButton = el<HTMLButtonElement>("reset-identity");
const loadMoreButton = el<HTMLButtonElement>("load-more");
const rewardsTotal = el("rewards-total");
const rewardsActions = el("rewards-actions");
const rewardsOrders = el("rewards-orders");
const rewardsWork = el<HTMLButtonElement>("rewards-work");
const marketParticipants = el("market-participants");
const marketListings = el("market-listings");
const marketAnswers = el("market-answers");
const anchorFeedButton = el<HTMLButtonElement>("anchor-feed");
const chainStatus = el("chain-status");
const adapterList = el("adapter-list");
const sourceRepoInput = el<HTMLInputElement>("source-repo");
const sourcePathInput = el<HTMLInputElement>("source-path");
const importSourceButton = el<HTMLButtonElement>("import-source");
const clearSourceButton = el<HTMLButtonElement>("clear-source");
const sourceStatus = el("source-status");

let nodes: UiNode[] = [];
let taskId = tasks[0]?.id ?? "";
let selectedId: string | null = null;
let pendingSource: string | null = null;
let parentId: string | null = null;
let remixSourceTitle: string | null = null;
let source: PublicationSource | null = null;
let drag: DragState | null = null;
let pan: PanState | null = null;
let pinch: PinchState | null = null;
let feedItems: Publication[] = [];
let appNames: Record<string, string> = {};
let challengeTitles: Record<string, string> = {};
let feedOffset = 0;
let feedHasMore = false;
let toastTimer: number | undefined;
let hintIndex = 0;
let view = { x: 0, y: 0, w: SVG_WIDTH };

const touchPoints = new Map<number, { x: number; y: number }>();

/**
 * A mirror ships the registry as a bundle, so the workbench keeps working with
 * the operator offline. When a bundle is present the read paths are answered
 * from it; writes still need a live registry.
 */
interface MirrorBundle {
  manifest: {
    root: string;
    leafVersion: number;
    anchorId: string | null;
    createdAt: string;
    counts: Record<string, number>;
  };
  publications: Publication[];
  challenges: (Challenge & { semanticsBinding?: string })[];
  semantics: (Semantics & { semanticsHash?: string })[];
}

declare global {
  interface Window {
    __RAREXT_BUNDLE__?: MirrorBundle;
  }
}

function mirrorResponse(path: string): unknown {
  const bundle = window.__RAREXT_BUNDLE__;
  if (!bundle) return null;

  const url = new URL(path, "https://mirror.invalid");
  const publications = [...bundle.publications].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  if (url.pathname === "/v1/feed" || url.pathname === "/v1/artifacts") {
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const offset = Number(url.searchParams.get("offset") ?? "0");
    return publications.slice(offset, offset + limit);
  }

  if (url.pathname === "/v1/challenges") return bundle.challenges;
  if (url.pathname === "/v1/semantics") return bundle.semantics;

  if (url.pathname === "/v1/apps") {
    return bundle.challenges.map((challenge) => ({
      id: challenge.app,
      name: challenge.app,
      version: "1",
      description: challenge.description,
      artifactKinds: [],
      challengeCount: 1,
      verifier: "builtin",
      configured: true,
      url: null,
    }));
  }

  if (url.pathname === "/v1/adapters") return [];
  if (url.pathname === "/v1/tapeout/status") {
    return { configured: false, chainId: null, blockNumber: null };
  }

  return null;
}

async function apiGet(path: string): Promise<unknown> {
  const mirrored = mirrorResponse(path);
  if (mirrored !== null) return mirrored;

  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return response.json();
}

function currentTask(): Task {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("unknown task");
  return task;
}

function taskTitleFor(task: Task): string {
  return t(`task.${task.id}.title`, {}, task.title);
}

function taskDescriptionFor(task: Task): string {
  return t(`task.${task.id}.description`, {}, task.description);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function displayName(id: string): string {
  if (id === "sel") return t("dyn.chooser");
  if (id === "sum" || id === "y") return t("dyn.answer");
  if (id === "carry") return t("dyn.extra");
  if (id === "a" || id === "b" || id === "c") return id.toUpperCase();
  return id;
}

function bitName(value: string): string {
  if (value === "1") return t("dyn.on");
  if (value === "0") return t("dyn.off");
  return value;
}

function bitCell(value: string): string {
  const state = value === "1" ? "on" : value === "0" ? "off" : "unknown";
  return `<td><span class="bit ${state}">${escapeHtml(bitName(value))}</span></td>`;
}

function shortHash(hash: string): string {
  return hash.length <= 20 ? hash : `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function isComponentType(value: unknown): value is ComponentType {
  return value === "INPUT" || value === "OUTPUT" || value === "NAND" || value === "LATCH";
}

function isUiNode(value: unknown): value is UiNode {
  if (typeof value !== "object" || value === null) return false;
  const node = value as UiNode;
  return (
    typeof node.id === "string" &&
    isComponentType(node.type) &&
    typeof node.x === "number" &&
    typeof node.y === "number" &&
    Array.isArray(node.inputs) &&
    node.inputs.every((input) => typeof input === "string")
  );
}

function defaultNodes(task: Task): UiNode[] {
  const result: UiNode[] = [];
  const inputOffset = ((task.inputs.length - 1) * 110) / 2;
  const outputOffset = ((task.outputs.length - 1) * 110) / 2;

  task.inputs.forEach((id, index) => {
    result.push({
      id,
      type: "INPUT",
      x: 60,
      y: 250 - inputOffset + index * 110,
      inputs: [],
    });
  });

  task.outputs.forEach((id, index) => {
    result.push({
      id,
      type: "OUTPUT",
      x: SVG_WIDTH - NODE_WIDTH - 60,
      y: 250 - outputOffset + index * 110,
      inputs: [""],
    });
  });

  return result;
}

function nodesFromCircuit(circuit: Circuit): UiNode[] {
  const byId = new Map(circuit.components.map((component) => [component.id, component]));
  const memo = new Map<string, number>();
  const visiting = new Set<string>();

  const depthOf = (component: Component): number => {
    const cached = memo.get(component.id);
    if (cached !== undefined) return cached;

    if (component.type === "INPUT") {
      memo.set(component.id, 0);
      return 0;
    }

    if (visiting.has(component.id)) return 0;

    visiting.add(component.id);
    const sources = component.inputs ?? [];
    const depth =
      1 +
      Math.max(
        0,
        ...sources.map((id) => {
          const source = byId.get(id);
          return source ? depthOf(source) : 0;
        }),
      );

    visiting.delete(component.id);
    memo.set(component.id, depth);
    return depth;
  };

  const gates = circuit.components.filter(
    (component) => component.type === "NAND" || component.type === "LATCH",
  );
  const columns = new Map<number, Component[]>();

  for (const gate of gates) {
    const depth = Math.max(1, depthOf(gate));
    const column = columns.get(depth) ?? [];
    column.push(gate);
    columns.set(depth, column);
  }

  const maxDepth = Math.max(1, ...columns.keys());
  const outputX = Math.min(
    SVG_WIDTH - NODE_WIDTH - 60,
    Math.max(700, 300 + maxDepth * 165),
  );

  const place = (component: Component, x: number, y: number): UiNode => ({
    id: component.id,
    type: component.type,
    x,
    y,
    inputs: Array.from(
      { length: ARITY[component.type] },
      (_, index) => component.inputs?.[index] ?? "",
    ),
  });

  const inputs = circuit.components.filter((component) => component.type === "INPUT");
  const outputs = circuit.components.filter((component) => component.type === "OUTPUT");
  const inputOffset = ((inputs.length - 1) * 110) / 2;
  const outputOffset = ((outputs.length - 1) * 110) / 2;
  const result: UiNode[] = [];

  inputs.forEach((component, index) => {
    result.push(place(component, 60, 250 - inputOffset + index * 110));
  });

  for (const [depth, column] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    const offset = ((column.length - 1) * 110) / 2;
    column.forEach((component, index) => {
      result.push(
        place(component, 300 + (depth - 1) * 165, 250 - offset + index * 110),
      );
    });
  }

  outputs.forEach((component, index) => {
    result.push(place(component, outputX, 250 - outputOffset + index * 110));
  });

  return result;
}

function saveNodes(): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + taskId, JSON.stringify(nodes));
  } catch {
    return;
  }
}

function loadNodes(task: Task): UiNode[] {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + task.id);
    if (!raw) return defaultNodes(task);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isUiNode)) return defaultNodes(task);
    return parsed;
  } catch {
    return defaultNodes(task);
  }
}

function saveDraft(): void {
  try {
    const draft: Draft = {
      title: titleInput.value,
      body: bodyInput.value,
      parentId,
      remixSourceTitle,
      source,
    };
    localStorage.setItem(DRAFT_PREFIX + taskId, JSON.stringify(draft));
  } catch {
    return;
  }
}

function loadDraft(id: string): Draft {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + id);
    if (!raw) {
      return { title: "", body: "", parentId: null, remixSourceTitle: null, source: null };
    }

    const parsed = JSON.parse(raw) as Partial<Draft>;

    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
      parentId: typeof parsed.parentId === "string" ? parsed.parentId : null,
      remixSourceTitle:
        typeof parsed.remixSourceTitle === "string" ? parsed.remixSourceTitle : null,
      source: isPublicationSource(parsed.source) ? parsed.source : null,
    };
  } catch {
    return { title: "", body: "", parentId: null, remixSourceTitle: null, source: null };
  }
}

function isPublicationSource(value: unknown): value is PublicationSource {
  if (!value || typeof value !== "object") return false;
  const source = value as Partial<PublicationSource>;
  return (
    (source.kind === "github" ||
      source.kind === "gitlab" ||
      source.kind === "codeberg" ||
      source.kind === "url") &&
    typeof source.url === "string" &&
    typeof source.commit === "string"
  );
}

function loadStoredIdentity(): StoredIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredIdentity>;

    if (
      typeof parsed.handle !== "string" ||
      typeof parsed.keyId !== "string" ||
      typeof parsed.publicKey !== "object" ||
      typeof parsed.privateKey !== "object"
    ) {
      return null;
    }

    return {
      handle: parsed.handle,
      keyId: parsed.keyId,
      publicKey: parsed.publicKey as JsonWebKey,
      privateKey: parsed.privateKey as JsonWebKey,
    };
  } catch {
    return null;
  }
}

function renderIdentityStatus(): void {
  const identity = loadStoredIdentity();

  if (!identity) {
    identityStatus.textContent = t("wb.identity");
    resetIdentityButton.classList.add("hidden");
    return;
  }

  identityStatus.textContent = t("dyn.identitySharing", { handle: identity.handle });
  resetIdentityButton.classList.remove("hidden");
}

function buildCircuit(): Circuit {
  return {
    components: nodes.map((node) =>
      node.type === "INPUT"
        ? { id: node.id, type: node.type }
        : { id: node.id, type: node.type, inputs: [...node.inputs] },
    ),
  };
}

function isComplete(): boolean {
  const ids = new Set(nodes.map((node) => node.id));

  return nodes.every((node) => {
    if (node.inputs.length !== ARITY[node.type]) return false;
    return node.inputs.every((input) => input !== "" && ids.has(input));
  });
}

function evaluateCircuit(): Evaluation {
  const task = currentTask();

  if (!isComplete()) {
    return { cases: [], design: null, error: t("dyn.connectAll") };
  }

  try {
    const circuit = buildCircuit();
    const design = score(circuit, task);

    const cases = task.cases.map((testCase) => {
      const result = simulate(circuit, testCase.inputs);
      const pass =
        result.settled &&
        task.outputs.every((name) => result.outputs[name] === testCase.outputs[name]);

      return {
        inputValues: task.inputs.map((name) => String(testCase.inputs[name])),
        expectedValues: task.outputs.map((name) => String(testCase.outputs[name])),
        actualValues: result.settled
          ? task.outputs.map((name) => String(result.outputs[name] ?? "?"))
          : task.outputs.map(() => "—"),
        pass,
      };
    });

    return { cases, design, error: null };
  } catch (error) {
    return {
      cases: [],
      design: null,
      error: error instanceof Error ? error.message : "simulation failed",
    };
  }
}

function inputPortPosition(node: UiNode, index: number): { x: number; y: number } {
  const count = Math.max(ARITY[node.type], 1);
  return {
    x: node.x,
    y: node.y + (NODE_HEIGHT * (index + 1)) / (count + 1),
  };
}

function outputPortPosition(node: UiNode): { x: number; y: number } {
  return { x: node.x + NODE_WIDTH, y: node.y + NODE_HEIGHT / 2 };
}

function containerAspect(): number {
  const rect = svg.getBoundingClientRect();

  if (rect.width > 0 && rect.height > 0) {
    return rect.width / rect.height;
  }

  return SVG_WIDTH / SVG_HEIGHT;
}

function viewHeight(): number {
  return view.w / containerAspect();
}

function applyView(): void {
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${viewHeight()}`);
}

function fitView(): void {
  if (nodes.length === 0) {
    view = { x: 0, y: 0, w: SVG_WIDTH };
    applyView();
    return;
  }

  const minX = Math.min(...nodes.map((node) => node.x)) - 70;
  const maxX = Math.max(...nodes.map((node) => node.x + NODE_WIDTH)) + 70;
  const minY = Math.min(...nodes.map((node) => node.y)) - 60;
  const maxY = Math.max(...nodes.map((node) => node.y + NODE_HEIGHT)) + 60;
  const aspect = containerAspect();
  const mobile = window.matchMedia("(max-width: 1080px)").matches;
  const contentWidth = Math.max(maxX - minX, (maxY - minY) * aspect);
  const minWidth = mobile ? 620 : 900;
  const width = mobile
    ? Math.max(minWidth, Math.min(contentWidth, 1000))
    : Math.min(Math.max(contentWidth, minWidth), 1300);
  const height = width / aspect;

  view = {
    x: (minX + maxX) / 2 - width / 2,
    y: (minY + maxY) / 2 - height / 2,
    w: width,
  };
  applyView();
}

function zoomAt(point: { x: number; y: number }, factor: number): void {
  const nextWidth = Math.min(1600, Math.max(320, view.w / factor));
  const ratio = nextWidth / view.w;

  view.x = point.x - (point.x - view.x) * ratio;
  view.y = point.y - (point.y - view.y) * ratio;
  view.w = nextWidth;
  applyView();
}

function zoomBy(factor: number): void {
  zoomAt(
    { x: view.x + view.w / 2, y: view.y + viewHeight() / 2 },
    factor,
  );
}

function renderCanvas(): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parts: string[] = [];

  parts.push(`<defs>
    <pattern id="grid-minor" width="20" height="20" patternUnits="userSpaceOnUse">
      <path d="M 20 0 L 0 0 0 20" fill="none" class="grid-minor" />
    </pattern>
    <pattern id="grid-major" width="100" height="100" patternUnits="userSpaceOnUse">
      <rect width="100" height="100" fill="url(#grid-minor)" />
      <path d="M 100 0 L 0 0 0 100" fill="none" class="grid-major" />
    </pattern>
  </defs>`);
  parts.push(
    `<rect x="-4000" y="-4000" width="8000" height="8000" fill="url(#grid-major)" />`,
  );

  for (const node of nodes) {
    for (let index = 0; index < node.inputs.length; index++) {
      const source = byId.get(node.inputs[index] ?? "");
      if (!source || source.type === "OUTPUT") continue;

      const from = outputPortPosition(source);
      const to = inputPortPosition(node, index);
      const bend = Math.max(40, Math.abs(to.x - from.x) / 2);
      const path = `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
      parts.push(`<path class="wire-under" d="${path}" />`);
      parts.push(`<path class="wire" d="${path}" />`);
    }
  }

  for (const node of nodes) {
    const selected = node.id === selectedId ? " selected" : "";
    const typeClass = node.type.toLowerCase();
    const pending = pendingSource === node.id ? " pending" : "";
    const portCount = ARITY[node.type];
    const label =
      node.type === "INPUT"
        ? `${t("dyn.start")} ${displayName(node.id).toUpperCase()}`
        : node.type === "OUTPUT"
          ? displayName(node.id).toUpperCase()
          : node.type === "LATCH"
            ? t("wb.memory")
            : t("wb.notBoth");
    const sublabel =
      node.type === "INPUT"
        ? t("dyn.onOrOff")
        : node.type === "OUTPUT"
          ? t("dyn.yourAnswer")
          : node.type === "LATCH"
            ? t("dyn.remembers")
            : t("wb.notBothShort");
    const description =
      node.type === "INPUT"
        ? t("dyn.startNode", { id: displayName(node.id) })
        : node.type === "OUTPUT"
          ? t("dyn.answerNode", { id: displayName(node.id) })
          : node.type === "LATCH"
            ? t("dyn.remembersOne")
            : t("dyn.notBothDesc");

    parts.push(
      `<g class="node ${typeClass}${selected}" data-node="${escapeHtml(node.id)}" transform="translate(${node.x}, ${node.y})">`,
    );
    parts.push(`<title>${escapeHtml(description)}</title>`);
    parts.push(
      `<rect class="node-body" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="12" />`,
    );
    parts.push(
      `<line class="node-gloss" x1="15" y1="0.8" x2="${NODE_WIDTH - 15}" y2="0.8" />`,
    );
    parts.push(
      `<text class="label" x="20" y="27">${escapeHtml(label)}</text>`,
    );
    parts.push(
      `<text class="id" x="20" y="45">${escapeHtml(sublabel)}</text>`,
    );

    for (let index = 0; index < portCount; index++) {
      const position = inputPortPosition({ ...node, x: 0, y: 0 }, index);
      const label =
        node.type === "LATCH"
          ? index === 0
            ? t("dyn.value")
            : t("dyn.hold")
          : node.type === "OUTPUT"
            ? t("dyn.in")
            : String.fromCharCode(65 + index);
      parts.push(
        `<text class="arity" x="${position.x - 8}" y="${position.y + 3.5}" text-anchor="end">${escapeHtml(label)}</text>`,
        `<circle class="port in" cx="${position.x}" cy="${position.y}" r="5" data-port="in" data-node="${escapeHtml(node.id)}" data-index="${index}" />`,
      );
    }

    if (node.type !== "OUTPUT") {
      parts.push(
        `<circle class="port out${pending}" cx="${NODE_WIDTH}" cy="${NODE_HEIGHT / 2}" r="6" data-port="out" data-node="${escapeHtml(node.id)}" />`,
      );
    }

    parts.push("</g>");
  }

  parts.push(`<path class="wire-ghost" id="wire-ghost" d="" />`);

  svg.innerHTML = parts.join("");
}

function updateGhostWire(point: { x: number; y: number } | null): void {
  const ghost = svg.querySelector("#wire-ghost");
  if (!(ghost instanceof SVGPathElement)) return;

  const source = pendingSource ? nodeById(pendingSource) : undefined;
  if (!source || !point) {
    ghost.setAttribute("d", "");
    return;
  }

  const from = outputPortPosition(source);
  const bend = Math.max(40, Math.abs(point.x - from.x) / 2);
  ghost.setAttribute(
    "d",
    `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${point.x - bend} ${point.y}, ${point.x} ${point.y}`,
  );
}

function setMeter(meter: HTMLElement, ratio: number, state: "ok" | "bad" | "idle"): void {
  meter.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  meter.className = `meter-fill ${state}`;
}

function renderScore(evaluation: Evaluation): void {
  const complete = isComplete();

  if (evaluation.error) {
    scoreStatus.textContent = complete ? t("dyn.almost") : t("dyn.notYet");
    scoreStatus.className = "status-pill idle";
    scoreCases.textContent = "—";
    scoreGates.textContent = String(countGates(buildCircuit()));
    scoreValue.textContent = "0";
    scoreValue.className = "score-number idle";
    setMeter(scoreMeter, 0, "idle");
    setMeter(checkMeter, 0, "idle");
    scoreMeterBar.classList.add("hidden");
    checkMeterBar.classList.add("hidden");
  } else if (evaluation.design) {
    const correct = evaluation.design.correct;
    const ratio = evaluation.design.passed / Math.max(1, evaluation.design.total);
    scoreStatus.textContent = correct ? t("dyn.solved") : t("dyn.notYet");
    scoreStatus.className = `status-pill ${correct ? "ok" : "bad"}`;
    scoreCases.textContent = t("dyn.of", {
      done: evaluation.design.passed,
      total: evaluation.design.total,
    });
    scoreGates.textContent = String(evaluation.design.gateCount);
    scoreValue.textContent = String(evaluation.design.score);
    scoreValue.className = `score-number ${correct ? "ok" : "bad"}`;
    setMeter(scoreMeter, ratio, correct ? "ok" : "bad");
    setMeter(checkMeter, ratio, correct ? "ok" : "bad");
    scoreMeterBar.classList.remove("hidden");
    checkMeterBar.classList.remove("hidden");
  }

  renderTestSummary(evaluation);
  renderNextStep(evaluation);
  renderShareState(evaluation);
  updateCanvasHelp();
}

function renderTestSummary(evaluation: Evaluation): void {
  if (evaluation.error || !evaluation.design) {
    testSummary.textContent = t("wb.notYet");
    testSummary.className = "status-pill idle";
    return;
  }

  const passed = evaluation.cases.filter((row) => row.pass).length;
  testSummary.textContent = t("dyn.checksRight", {
    done: passed,
    total: evaluation.cases.length,
  });
  testSummary.className = `status-pill ${evaluation.design.correct ? "ok" : "bad"}`;
}

function renderNextStep(evaluation: Evaluation): void {
  if (!evaluation.design?.correct) {
    nextStepPanel.classList.add("hidden");
    return;
  }

  const index = tasks.findIndex((task) => task.id === taskId);
  const next = tasks[index + 1];

  nextStepPanel.classList.remove("hidden");
  nextPuzzleButton.textContent = next
    ? t("dyn.next", { title: taskTitleFor(next) })
    : t("dyn.seeCommunity");
}

function updateCanvasHelp(): void {
  if (localStorage.getItem(CANVAS_HELP_KEY) === "1") {
    canvasHelp.classList.add("hidden");
    return;
  }

  const wired = nodes.some((node) => node.inputs.some((input) => input !== ""));
  if (wired) {
    canvasHelp.classList.add("hidden");
    return;
  }

  const gates = nodes.filter(
    (node) => node.type === "NAND" || node.type === "LATCH",
  ).length;

  canvasHelp.classList.remove("hidden");
  canvasHelpText.textContent =
    gates === 0 ? t("dyn.startHint") : t("dyn.linkHint");
}

function scrollToBoard(): void {
  if (!window.matchMedia("(max-width: 1080px)").matches) return;
  svg.closest(".canvas-wrap")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderTruthTable(evaluation: Evaluation): void {
  const task = currentTask();

  if (evaluation.error) {
    truthTable.classList.add("bare");
    truthTable.innerHTML = `<div class="empty">${escapeHtml(evaluation.error)}</div>`;
    return;
  }

  truthTable.classList.remove("bare");

  const inputHeaders = task.inputs
    .map((name) => `<th rowspan="2">${escapeHtml(displayName(name))}</th>`)
    .join("");
  const outputHeaders = task.outputs
    .map((name) => `<th>${escapeHtml(displayName(name))}</th>`)
    .join("");
  const span = task.outputs.length;

  const header = `<tr>${inputHeaders}<th colspan="${span}">${escapeHtml(t("dyn.answer"))}</th><th colspan="${span}">${escapeHtml(t("dyn.yours"))}</th><th rowspan="2">${escapeHtml(t("dyn.checkColumn"))}</th></tr><tr>${outputHeaders}${outputHeaders}</tr>`;

  const rows = evaluation.cases
    .map((row) => {
      const inputCells = row.inputValues.map(bitCell).join("");
      const expectedCells = row.expectedValues.map(bitCell).join("");
      const actualCells = row.actualValues.map(bitCell).join("");

      return `<tr>${inputCells}${expectedCells}${actualCells}<td class="${row.pass ? "pass" : "fail"}">${escapeHtml(row.pass ? t("dyn.yes") : t("dyn.no"))}</td></tr>`;
    })
    .join("");

  truthTable.innerHTML = `<table><thead>${header}</thead><tbody>${rows}</tbody></table>`;
}

function renderShareState(evaluation: Evaluation): void {
  const solved = evaluation.design?.correct === true;

  shareLocked.classList.toggle("hidden", solved);
  shareSection.classList.toggle("hidden", !solved);

  if (!solved) {
    shareLockedCopy.textContent = evaluation.error
      ? t("dyn.connectAll")
      : t("dyn.solveToShare");
  }
}

function renderRemix(): void {
  if (parentId && remixSourceTitle) {
    remixBanner.classList.remove("hidden");
    remixTitle.textContent = t("dyn.copyOf", { title: remixSourceTitle });
    return;
  }

  remixBanner.classList.add("hidden");
}

function render(): void {
  const evaluation = evaluateCircuit();
  renderCanvas();
  renderScore(evaluation);
  renderTruthTable(evaluation);
  renderRemix();
  taskDescription.textContent = taskDescriptionFor(currentTask());
}

function saveAndRender(): void {
  saveNodes();
  render();
}

function toSvgPoint(event: { clientX: number; clientY: number }): {
  x: number;
  y: number;
} {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const matrix = svg.getScreenCTM();
  if (!matrix) return { x: 0, y: 0 };
  const transformed = point.matrixTransform(matrix.inverse());
  return { x: transformed.x, y: transformed.y };
}

function nodeById(id: string): UiNode | undefined {
  return nodes.find((node) => node.id === id);
}

function connect(targetId: string, index: number): void {
  if (!pendingSource) {
    toast(t("dyn.startGreen"), true);
    return;
  }

  const source = nodeById(pendingSource);
  const target = nodeById(targetId);

  if (!source || source.type === "OUTPUT" || !target) {
    pendingSource = null;
    render();
    return;
  }

  if (index < 0 || index >= target.inputs.length) return;

  target.inputs[index] = pendingSource;
  pendingSource = null;
  saveAndRender();
}

svg.addEventListener("pointerdown", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;

  if (event.pointerType === "touch") {
    touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (touchPoints.size === 2) {
      pinch = null;
      drag = null;
      pan = null;
      return;
    }

    if (pinch) return;
  }

  const port = target.closest("[data-port]");
  if (port) {
    event.preventDefault();
    const nodeId = port.getAttribute("data-node");
    const kind = port.getAttribute("data-port");
    if (!nodeId) return;

    if (kind === "out") {
      pendingSource = pendingSource === nodeId ? null : nodeId;
      render();
      return;
    }

    const index = Number(port.getAttribute("data-index") ?? "-1");
    connect(nodeId, index);
    return;
  }

  const group = target.closest("[data-node]");
  if (!group) {
    selectedId = null;
    pendingSource = null;
    pan = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: view.x,
      viewY: view.y,
    };
    svg.setPointerCapture(event.pointerId);
    render();
    return;
  }

  const id = group.getAttribute("data-node");
  if (!id) return;

  selectedId = id;
  const node = nodeById(id);
  if (!node) return;

  const point = toSvgPoint(event);
  drag = { id, dx: point.x - node.x, dy: point.y - node.y };
  svg.setPointerCapture(event.pointerId);
  render();
});

svg.addEventListener("pointermove", (event) => {
  if (event.pointerType === "touch" && touchPoints.has(event.pointerId)) {
    touchPoints.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (touchPoints.size >= 2) {
      const [first, second] = [...touchPoints.values()];
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const midX = (first.x + second.x) / 2;
      const midY = (first.y + second.y) / 2;

      if (!pinch) {
        pinch = { distance, midX, midY };
      } else {
        const factor = pinch.distance > 0 ? distance / pinch.distance : 1;
        zoomAt(toSvgPoint({ clientX: midX, clientY: midY }), factor);

        const rect = svg.getBoundingClientRect();
        const scale = view.w / Math.max(rect.width, 1);
        view.x -= (midX - pinch.midX) * scale;
        view.y -= (midY - pinch.midY) * scale;
        applyView();
        pinch = { distance, midX, midY };
      }
      return;
    }
  }

  if (drag) {
    const node = nodeById(drag.id);
    if (!node) return;

    const point = toSvgPoint(event);
    node.x = Math.max(0, Math.min(SVG_WIDTH - NODE_WIDTH, point.x - drag.dx));
    node.y = Math.max(0, Math.min(SVG_HEIGHT - NODE_HEIGHT, point.y - drag.dy));
    saveNodes();
    renderCanvas();
    return;
  }

  if (pendingSource) {
    updateGhostWire(toSvgPoint(event));
    return;
  }

  if (pan && event.pointerId === pan.pointerId) {
    const rect = svg.getBoundingClientRect();
    const scale = view.w / Math.max(rect.width, 1);
    view.x = pan.viewX - (event.clientX - pan.startX) * scale;
    view.y = pan.viewY - (event.clientY - pan.startY) * scale;
    applyView();
  }
});

svg.addEventListener("pointerup", (event) => {
  if (event.pointerType === "touch") {
    touchPoints.delete(event.pointerId);
    pinch = null;
  }

  if (drag) {
    drag = null;
    if (svg.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId);
    }
    saveAndRender();
    return;
  }

  if (pan) {
    pan = null;
    if (svg.hasPointerCapture(event.pointerId)) {
      svg.releasePointerCapture(event.pointerId);
    }
  }
});

svg.addEventListener("pointercancel", () => {
  drag = null;
  pan = null;
  pinch = null;
  touchPoints.clear();
});

svg.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    zoomAt(toSvgPoint(event), event.deltaY < 0 ? 1.12 : 0.89);
  },
  { passive: false },
);

function addGate(type: "NAND" | "LATCH"): void {
  const same = nodes.filter((node) => node.type === type).length;
  let id = `${type.toLowerCase()}${same + 1}`;

  while (nodes.some((node) => node.id === id)) {
    id = `${id}x`;
  }

  nodes.push({
    id,
    type,
    x: 330 + (same % 2) * 210,
    y: 190 + Math.floor(same / 2) * 100,
    inputs: ["", ""],
  });

  selectedId = id;
  saveAndRender();
  scrollToBoard();
}

function deleteSelected(): void {
  if (!selectedId) {
    toast(t("dyn.selectBlock"), true);
    return;
  }

  nodes = nodes
    .filter((node) => node.id !== selectedId)
    .map((node) => ({
      ...node,
      inputs: node.inputs.map((input) => (input === selectedId ? "" : input)),
    }));

  selectedId = null;
  saveAndRender();
}

function resetCircuit(): void {
  nodes = defaultNodes(currentTask());
  selectedId = null;
  pendingSource = null;
  parentId = null;
  remixSourceTitle = null;
  source = null;
  renderSourceStatus();
  saveDraft();
  saveAndRender();
  fitView();
}

function sourceLabel(value: PublicationSource): string {
  const kind =
    value.kind === "github"
      ? "GitHub"
      : value.kind === "gitlab"
        ? "GitLab"
        : value.kind === "codeberg"
          ? "Codeberg"
          : t("dyn.source");
  return value.repo ? `${kind} · ${value.repo}` : kind;
}

function renderSourceStatus(): void {
  if (!source) {
    sourceStatus.textContent = t("wb.publicSource");
    sourceRepoInput.value = "";
    sourcePathInput.value = "";
    clearSourceButton.classList.add("hidden");
    importSourceButton.textContent = t("wb.import");
    return;
  }

  const pinned = source.commit ? source.commit.slice(0, 7) : t("dyn.latest");
  const path = source.path ? ` · ${source.path}` : "";
  sourceStatus.textContent = t("dyn.sourceUsing", {
    source: sourceLabel(source),
    commit: `${pinned}${path}`,
  });
  if (source.repo) sourceRepoInput.value = source.repo;
  if (source.path) sourcePathInput.value = source.path;
  clearSourceButton.classList.remove("hidden");
  importSourceButton.textContent = t("wb.replace");
}

async function importGitHubSource(): Promise<void> {
  const repo = sourceRepoInput.value.trim();
  const path = sourcePathInput.value.trim();

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    toast(t("err.projectName"), true);
    return;
  }

  importSourceButton.disabled = true;
  sourceStatus.textContent = t("wb.lookingUp");

  try {
    const response = await fetch("/v1/sources/github/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo,
        path: path || null,
        taskId: path ? taskId : null,
      }),
    });
    const resolved = (await response.json()) as SourceResolution & { error?: string };

    if (!response.ok) {
      throw new Error(resolved.error ?? t("err.readProject"));
    }

    source = resolved.source;

    if (resolved.circuit) {
      nodes = nodesFromCircuit(resolved.circuit);
      selectedId = null;
      pendingSource = null;
      parentId = null;
      remixSourceTitle = null;
      saveNodes();
      resetHint();
      saveDraft();
      render();
      fitView();
      toast(t("toast.buildImported"));
    } else {
      saveDraft();
      renderSourceStatus();
      toast(t("toast.projectPinned"));
    }

    renderSourceStatus();
  } catch (error) {
    sourceStatus.textContent = t("wb.publicSource");
    toast(error instanceof Error ? error.message : t("err.readProject"), true);
  } finally {
    importSourceButton.disabled = false;
  }
}

function resetHint(): void {
  hintIndex = 0;
  hintButton.textContent = t("wb.needHint");
  hintBox.textContent = "";
  hintBox.classList.add("hidden");
}

function updateTaskPosition(): void {
  const index = tasks.findIndex((task) => task.id === taskId);
  taskProgress.textContent = t("wb.puzzleOf", {
    n: index + 1,
    total: tasks.length,
  });
}

function renderChallengeDots(): void {
  challengeDots.innerHTML = tasks
    .map(
      (task) =>
        `<button type="button" data-task="${escapeHtml(task.id)}"${
          task.id === taskId ? ' class="active" aria-current="true"' : ""
        } title="${escapeHtml(taskTitleFor(task))}" aria-label="${escapeHtml(taskTitleFor(task))}"></button>`,
    )
    .join("");
}

function setTask(nextTaskId: string): void {
  taskId = nextTaskId;
  taskSelect.value = nextTaskId;
  nodes = loadNodes(currentTask());
  selectedId = null;
  pendingSource = null;

  const draft = loadDraft(nextTaskId);
  titleInput.value = draft.title;
  bodyInput.value = draft.body;
  parentId = draft.parentId;
  remixSourceTitle = draft.remixSourceTitle;
  source = draft.source;
  renderSourceStatus();

  updateTaskPosition();
  renderChallengeDots();
  resetHint();
  render();
  fitView();
}

function toast(message: string, error = false): void {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", error);
  toastEl.classList.remove("hidden");

  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add("hidden"), 3400);
}

function openWelcome(): void {
  welcomeEl.classList.remove("hidden");
  document.body.classList.add("modal-open");
  welcomeCloseButton.focus();
}

function closeWelcome(remember = true): void {
  welcomeEl.classList.add("hidden");
  document.body.classList.remove("modal-open");
  if (remember) localStorage.setItem(WELCOME_KEY, "1");
}

function hintsFor(id: string): string[] {
  const fallback = HINTS[id];
  if (!fallback) return [t("hint.generic")];
  return fallback.map((text, index) => t(`hint.${id}.${index}`, {}, text));
}

function showHint(): void {
  const hints = hintsFor(taskId);
  hintBox.textContent = hints[hintIndex % hints.length];
  hintBox.classList.remove("hidden");
  hintIndex += 1;
  hintButton.textContent =
    hintIndex >= hints.length ? t("wb.startHintsOver") : t("wb.anotherHint");
}

function toBase64(bytes: ArrayBuffer): string {
  let binary = "";

  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

async function ensureIdentity(handle: string): Promise<StoredIdentity> {
  const existing = loadStoredIdentity();

  if (existing) {
    if (existing.handle !== handle) {
      throw new Error(
        t("err.nameConflict", { existing: existing.handle, handle }),
      );
    }

    return existing;
  }

  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );

  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);

  const response = await fetch("/v1/identities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, publicKey }),
  });

  const payload = (await response.json()) as { keyId?: string; error?: string };

  if (!response.ok || !payload.keyId) {
    if (payload.error === "handle is already registered") {
      throw new Error(t("err.nameTaken", { handle }));
    }
    throw new Error(t("err.saveName"));
  }

  const identity: StoredIdentity = {
    handle,
    keyId: payload.keyId,
    publicKey,
    privateKey,
  };

  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  renderIdentityStatus();
  return identity;
}

async function signPayload(
  identity: StoredIdentity,
  payload: PublicationPayload,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "jwk",
    identity.privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(canonicalize(payload)),
  );

  return toBase64(signature);
}

async function publish(): Promise<void> {
  const task = currentTask();

  if (!isComplete()) {
    toast(t("err.connectBeforeShare"), true);
    return;
  }

  const handle = authorInput.value.trim().toLowerCase();
  const title = titleInput.value.trim();
  const body = bodyInput.value.trim();

  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(handle)) {
    toast(t("err.nameInvalid"), true);
    return;
  }

  if (!title) {
    toast(t("err.nameRequired"), true);
    return;
  }

  publishStatus.textContent = t("wb.gettingNameReady");

  try {
    const identity = await ensureIdentity(handle);
    const payload: PublicationPayload = {
      kind: "rarext.publication",
      version: 1,
      author: handle,
      authorKey: identity.keyId,
      title,
      body,
      taskId: task.id,
      circuit: buildCircuit(),
      parentId,
      source,
      createdAt: new Date().toISOString(),
      nonce: crypto.randomUUID(),
    };

    publishStatus.textContent = t("wb.checkingBuild");
    const signature = await signPayload(identity, payload);

    const response = await fetch("/v1/publications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, signature }),
    });

    const saved = (await response.json()) as Publication & { error?: string };

    if (!response.ok) {
      throw new Error(saved.error ?? t("err.share"));
    }

    localStorage.setItem(HANDLE_KEY, handle);
    saveDraft();
    publishStatus.textContent = t("feed.sharedPoints", {
      score: saved.attestation.score,
    });
    toast(t("toast.shared"));
    await refreshFeed();
    switchView("feed");
  } catch (error) {
    const message = error instanceof Error ? error.message : t("err.share");
    publishStatus.textContent = message;
    toast(message, true);
  }
}

function taskName(id: string): string {
  const task = tasks.find((item) => item.id === id);
  if (task) return taskTitleFor(task);
  return challengeTitles[id] ?? id;
}

async function refreshRegistry(): Promise<void> {
  try {
    const [appsResponse, challengesResponse] = await Promise.all([
      fetch("/v1/apps"),
      fetch("/v1/challenges"),
    ]);

    if (appsResponse.ok) {
      const apps = (await appsResponse.json()) as AdapterInfo[];
      appNames = Object.fromEntries(apps.map((app) => [app.id, app.name]));
    }

    if (challengesResponse.ok) {
      const challenges = (await challengesResponse.json()) as Challenge[];
      challengeTitles = Object.fromEntries(
        challenges.map((challenge) => [challenge.id, challenge.title]),
      );
    }

    if (feedItems.length) renderFeed();
  } catch {
    return;
  }
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";

  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 45) return t("dyn.justNow");
  if (seconds < 3600) return t("dyn.minutes", { n: Math.max(1, Math.round(seconds / 60)) });
  if (seconds < 86400) return t("dyn.hours", { n: Math.round(seconds / 3600) });
  if (seconds < 604800) return t("dyn.days", { n: Math.round(seconds / 86400) });
  return new Date(iso).toLocaleDateString(localeTag());
}

function cardHtml(publication: Publication): string {
  const attestation = publication.attestation;
  const parent = publication.parentId
    ? feedItems.find((item) => item.id === publication.parentId)
    : undefined;
  const parentLabel = publication.parentId
    ? parent
      ? t("dyn.copyOf", { title: parent.title })
      : t("dyn.aCopy")
    : t("dyn.firstBuild");
  const fullDate = new Date(publication.createdAt).toLocaleString(localeTag());
  const appTag = `<span class="tag app">${escapeHtml(appNames[publication.app] ?? publication.app)}</span>`;
  const claimTag = attestation.semanticsId
    ? `<span class="tag claim">${escapeHtml(`${attestation.semanticsId}@${attestation.semanticsVersion}`)}</span>`
    : "";
  const quantumTag =
    attestation.cryptoProfile === "post-quantum"
      ? `<span class="tag pq" title="${escapeHtml(t("crypto.pqTitle"))}">${escapeHtml(t("crypto.pq"))}</span>`
      : "";
  const statusTag = attestation.correct
    ? `<span class="tag good">${escapeHtml(t("dyn.solvedTag"))}</span>`
    : `<span class="tag bad">${escapeHtml(t("dyn.notSolved"))}</span>`;
  const authorTag = publication.verified
    ? ""
    : `<span class="tag quiet">${escapeHtml(t("dyn.nameUnchecked"))}</span>`;
  const sourceTag = publication.source
    ? `<a class="tag source" href="${escapeHtml(publication.source.url)}" target="_blank" rel="noreferrer">${escapeHtml(sourceLabel(publication.source))}</a>`
    : "";
  const isLogic = publication.app === "logic";
  const workbenchActions = isLogic
    ? `<button data-action="load" data-id="${escapeHtml(publication.id)}" class="primary">${escapeHtml(t("dyn.open"))}</button>
      <button data-action="remix" data-id="${escapeHtml(publication.id)}">${escapeHtml(t("dyn.copy"))}</button>`
    : "";

  return `<article class="card">
    <div class="card-top">
      <div>
        <div class="card-tags">${appTag}${claimTag}${quantumTag}${statusTag}${authorTag}${sourceTag}</div>
        <h3>${escapeHtml(publication.title)}</h3>
        <div class="meta">
          ${escapeHtml(t("dyn.by"))} <b>@${escapeHtml(publication.author)}</b> · ${escapeHtml(taskName(publication.challengeId))}
          · <span title="${escapeHtml(fullDate)}">${escapeHtml(timeAgo(publication.createdAt))}</span>
        </div>
      </div>
      <div class="score-bubble"><strong>${attestation.score}</strong><span>${escapeHtml(t("dyn.points"))}</span></div>
    </div>
    ${publication.body ? `<p class="body">${escapeHtml(publication.body)}</p>` : ""}
    <div class="card-summary">
      <span>${attestation.gateCount} ${escapeHtml(isLogic ? t("dyn.blocks") : t("dyn.units"))}</span>
      <span>${escapeHtml(parentLabel)}</span>
    </div>
    <div class="actions">
      ${workbenchActions}
      <button data-action="verify" data-id="${escapeHtml(publication.id)}" class="ghost">${escapeHtml(t("dyn.check"))}</button>
    </div>
    <details class="advanced">
      <summary>${escapeHtml(t("dyn.moreInfo"))}</summary>
      <div class="hash">${escapeHtml(t("dyn.build"))} ${shortHash(attestation.circuitHash)} · ${escapeHtml(t("dyn.proof"))} ${shortHash(attestation.traceHash)}</div>
      <div class="stats">
        <span>${escapeHtml(t("dyn.checkedBy"))}</span>
        <span>${escapeHtml(fullDate)}</span>
        ${publication.verified ? `<span>${escapeHtml(t("dyn.nameConfirmed"))}</span>` : ""}
        ${publication.source?.commit ? `<span>${escapeHtml(t("dyn.source"))} ${escapeHtml(publication.source.commit.slice(0, 7))}</span>` : ""}
      </div>
    </details>
  </article>`;
}

function renderFeed(): void {
  feedEl.innerHTML = feedItems.length
    ? feedItems.map(cardHtml).join("")
    : `<div class="empty-state">
        <h3>${escapeHtml(t("feed.emptyTitle"))}</h3>
        <p>${escapeHtml(t("feed.emptyCopy"))}</p>
        <button class="primary" data-action="build">${escapeHtml(t("feed.startBuilding"))}</button>
      </div>`;

  loadMoreButton.classList.toggle("hidden", !feedHasMore);
}

async function loadFeed(reset: boolean): Promise<void> {
  if (reset) {
    feedOffset = 0;
    feedEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(t("dyn.loadingBuilds"))}</p></div>`;
  }

  try {
    const page = (await apiGet(
      `/v1/feed?limit=${PAGE_SIZE}&offset=`,
    )) as Publication[];
    feedItems = reset ? page : [...feedItems, ...page];
    feedOffset += page.length;
    feedHasMore = page.length === PAGE_SIZE;
    renderFeed();
  } catch (error) {
    const message = error instanceof Error ? error.message : t("err.feed");

    if (reset) {
      feedItems = [];
      feedHasMore = false;
      feedEl.innerHTML = `<div class="empty-state">
        <h3>${escapeHtml(t("feed.loadErrorTitle"))}</h3>
        <p>${escapeHtml(t("feed.loadErrorCopy"))}</p>
        <button data-action="retry">${escapeHtml(t("dyn.tryAgain"))}</button>
      </div>`;
      loadMoreButton.classList.add("hidden");
      return;
    }

    toast(message, true);
  }
}

async function refreshFeed(): Promise<void> {
  await loadFeed(true);
}

async function loadMoreFeed(): Promise<void> {
  if (!feedHasMore) return;
  loadMoreButton.disabled = true;
  await loadFeed(false);
  loadMoreButton.disabled = false;
}

async function anchorPendingPublications(): Promise<void> {
  anchorFeedButton.disabled = true;

  try {
    const response = await fetch("/v1/anchors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const anchor = (await response.json()) as Anchor & { error?: string };

    if (!response.ok) {
      if (response.status === 409) {
        toast(t("toast.checkpointNone"));
        return;
      }
      throw new Error(anchor.error ?? t("err.anchor"));
    }

    toast(t("feed.checkpointSaved", { count: anchor.leafCount }));
  } catch (error) {
    toast(error instanceof Error ? error.message : t("err.anchor"), true);
  } finally {
    anchorFeedButton.disabled = false;
  }
}

function adapterStatusLabel(status: AdapterInfo["status"]): string {
  return status === "ready"
    ? t("dyn.ready")
    : status === "error"
      ? t("dyn.unavailable")
      : t("dyn.notConnected");
}

async function refreshAdapters(): Promise<void> {
  try {
    const adapters = (await apiGet("/v1/adapters")) as AdapterInfo[];

    adapterList.innerHTML = adapters
      .map(
        (adapter) => `<div class="adapter-row">
          <b>${escapeHtml(adapter.name)}</b>
          <span class="tag ${adapter.status === "ready" ? "good" : "quiet"}">${adapterStatusLabel(adapter.status)}</span>
        </div>`,
      )
      .join("");
  } catch {
    adapterList.innerHTML = `<p class="field-help">${escapeHtml(t("feed.networksUnavailable"))}</p>`;
  }
}

async function refreshChainStatus(): Promise<void> {
  try {
    const status = (await apiGet("/v1/tapeout/status")) as {
      configured: boolean;
      chainId: string | null;
      blockNumber: string | null;
      error?: string;
    };

    if (!status.configured) {
      chainStatus.textContent = "";
      chainStatus.classList.add("hidden");
      return;
    }

    if (status.error) {
      chainStatus.textContent = t("dyn.liveUnavailable");
      chainStatus.classList.remove("hidden");
      return;
    }

    chainStatus.textContent = t("dyn.liveNetwork", {
      block: status.blockNumber ?? "—",
    });
    chainStatus.classList.remove("hidden");
  } catch {
    chainStatus.textContent = "";
    chainStatus.classList.add("hidden");
  }
}

function openPublication(publication: Publication, mode: "load" | "remix"): void {
  if (!publication.circuit) {
    toast(t("dyn.otherApp"));
    return;
  }

  taskId = publication.taskId;
  taskSelect.value = publication.taskId;
  nodes = nodesFromCircuit(publication.circuit);
  selectedId = null;
  pendingSource = null;
  parentId = mode === "remix" ? publication.id : null;
  remixSourceTitle = mode === "remix" ? publication.title : null;
  source = publication.source ?? null;
  renderSourceStatus();
  titleInput.value =
    mode === "remix"
      ? t("dyn.copyOf", { title: publication.title })
      : publication.title;
  bodyInput.value = publication.body;
  saveNodes();
  saveDraft();
  switchView("workbench", false);
  render();
  fitView();
  scrollToBoard();
  toast(mode === "remix" ? t("toast.buildCopied") : t("toast.opened"));
}

async function verifyPublication(publication: Publication): Promise<void> {
  try {
    const response = await fetch("/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicationId: publication.id }),
    });

    const payload = (await response.json()) as { valid?: boolean; error?: string };

    if (!response.ok) throw new Error(payload.error ?? t("err.check"));
    toast(payload.valid ? t("toast.verified") : t("toast.mismatch"), !payload.valid);
  } catch (error) {
    toast(error instanceof Error ? error.message : t("err.check"), true);
  }
}

async function refreshRewards(): Promise<void> {
  const identity = loadStoredIdentity();

  try {
    const board = (await apiGet(
      `/v1/work?keyId=${encodeURIComponent(identity?.keyId ?? "")}`,
    )) as WorkBoard;

    rewardsTotal.textContent = String(board.earnings?.credits ?? 0);

    rewardsActions.innerHTML = board.actions
      .map((action) => {
        const earned = board.earnings?.byAction?.[action.id];
        const open = board.orders.filter((order) => order.action === action.id).length;
        return `<div class="reward-card">
          <div class="reward-head">
            <strong>${escapeHtml(t(`action.${action.id}` as Parameters<typeof t>[0]))}</strong>
            <span class="reward-value">${action.base * action.difficulty}</span>
          </div>
          <p class="reward-desc">${escapeHtml(action.description)}</p>
          <p class="reward-unit">${escapeHtml(action.unit)}${open ? ` · ${escapeHtml(t("rewards.open", { n: open }))}` : ""}</p>
          ${
            earned
              ? `<p class="reward-earned">${earned.jobs} · ${earned.credits}</p>`
              : ""
          }
        </div>`;
      })
      .join("");

    rewardsOrders.innerHTML = board.orders.length
      ? board.orders
          .map(
            (order) => `<div class="reward-order">
              <div>
                <strong>${escapeHtml(order.app)}</strong>
                <span class="reward-order-id">${escapeHtml(order.challengeId)}</span>
              </div>
              <span class="reward-value">${order.bounty}</span>
            </div>`,
          )
          .join("")
      : `<div class="empty">${escapeHtml(t("rewards.empty"))}</div>`;
  } catch {
    rewardsActions.innerHTML = `<div class="empty">${escapeHtml(t("rewards.empty"))}</div>`;
    rewardsOrders.innerHTML = "";
  }
}

async function workNow(): Promise<void> {
  const identity = loadStoredIdentity();

  if (!identity) {
    toast(t("rewards.empty"), true);
    return;
  }

  rewardsWork.disabled = true;

  try {
    const results = await runWork({
      identity: {
        keyId: identity.keyId,
        publicKey: identity.publicKey as Record<string, string>,
        privateKey: identity.privateKey as Record<string, string>,
      },
      onProgress: (result) => {
        toast(
          result.accepted
            ? `${result.challengeId} · ${result.bounty}`
            : `${result.challengeId} · ${result.error ?? "failed"}`,
          !result.accepted,
        );
      },
    });

    const accepted = results.filter((result) => result.accepted).length;
    toast(`${accepted} / ${results.length}`);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), true);
  } finally {
    rewardsWork.disabled = false;
    await refreshRewards();
  }
}

async function refreshMarket(): Promise<void> {
  const [participantsResponse, listingsResponse, answersResponse] = await Promise.all([
    apiGet("/v1/participants"),
    apiGet("/v1/market"),
    apiGet("/v1/market/aggregate"),
  ]);

  const participants = (participantsResponse as {
    participants: {
      handle: string;
      kind: string;
      model: string | null;
      hardware: string | null;
      doesNotClaim: string[];
    }[];
  }).participants;

  const listings = (listingsResponse as {
    listings: { id: string; seller: string; title: string; priceCredits: number }[];
  }).listings;

  const answers = (answersResponse as {
    answers: {
      id: string;
      question: string;
      aggregate: number | null;
      participants: string[];
      contributions: number;
    }[];
  }).answers;

  marketParticipants.innerHTML = participants.length
    ? participants
        .map(
          (participant) => `<div class="market-row">
            <div>
              <strong>${escapeHtml(participant.handle)}</strong>
              <span class="market-sub">${escapeHtml(participant.model ?? participant.hardware ?? participant.kind)}</span>
            </div>
            <span class="tag app">${escapeHtml(participant.kind)}</span>
          </div>`,
        )
        .join("")
    : `<div class="empty">${escapeHtml(t("market.empty"))}</div>`;

  marketListings.innerHTML = listings.length
    ? listings
        .map(
          (listing) => `<div class="market-row">
            <div>
              <strong>${escapeHtml(listing.title)}</strong>
              <span class="market-sub">${escapeHtml(listing.seller)}</span>
            </div>
            <span class="reward-value">${escapeHtml(String(listing.priceCredits))}</span>
          </div>`,
        )
        .join("")
    : `<div class="empty">${escapeHtml(t("market.empty"))}</div>`;

  marketAnswers.innerHTML = answers.length
    ? answers
        .map(
          (answer) => `<div class="market-row">
            <div>
              <strong>${escapeHtml(answer.question)}</strong>
              <span class="market-sub">${escapeHtml(
                t("market.contributors", { n: answer.participants.length }),
              )}</span>
            </div>
            <span class="reward-value">${escapeHtml(String(answer.aggregate ?? "-"))}</span>
          </div>`,
        )
        .join("")
    : `<div class="empty">${escapeHtml(t("market.empty"))}</div>`;
}

function switchView(view: "workbench" | "feed" | "rewards" | "market", scroll = true): void {
  document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });

  el("view-workbench").classList.toggle("hidden", view !== "workbench");
  el("view-feed").classList.toggle("hidden", view !== "feed");
  el("view-rewards").classList.toggle("hidden", view !== "rewards");
  el("view-market").classList.toggle("hidden", view !== "market");

  if (scroll && window.matchMedia("(max-width: 1080px)").matches) {
    window.scrollTo(0, 0);
  }

  if (view === "workbench") updateCanvasHelp();
  if (view === "rewards") void refreshRewards();
  if (view === "market") void refreshMarket();
}

feedEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;

  const action = button.dataset.action;

  if (action === "build") {
    switchView("workbench");
    return;
  }

  if (action === "retry") {
    void refreshFeed();
    return;
  }

  const publication = feedItems.find((item) => item.id === button.dataset.id);
  if (!publication) return;

  if (action === "verify") {
    void verifyPublication(publication);
    return;
  }

  openPublication(publication, action === "remix" ? "remix" : "load");
});

taskSelect.addEventListener("change", () => setTask(taskSelect.value));
challengeDots.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>("button[data-task]");
  if (!button?.dataset.task) return;
  setTask(button.dataset.task);
});
el("add-nand").addEventListener("click", () => addGate("NAND"));
el("add-latch").addEventListener("click", () => addGate("LATCH"));
el("delete-node").addEventListener("click", deleteSelected);
el("reset-circuit").addEventListener("click", resetCircuit);
el("publish").addEventListener("click", () => void publish());
hintButton.addEventListener("click", showHint);
nextPuzzleButton.addEventListener("click", () => {
  const index = tasks.findIndex((task) => task.id === taskId);
  const next = tasks[index + 1];

  if (!next) {
    switchView("feed");
    void refreshFeed();
    void refreshChainStatus();
    return;
  }

  setTask(next.id);
  fitView();
});
dismissCanvasHelpButton.addEventListener("click", () => {
  localStorage.setItem(CANVAS_HELP_KEY, "1");
  canvasHelp.classList.add("hidden");
});
viewBoardButton.addEventListener("click", scrollToBoard);
openGuideButton.addEventListener("click", openWelcome);
welcomeCloseButton.addEventListener("click", () => closeWelcome());
welcomeStartButton.addEventListener("click", () => {
  closeWelcome();
  switchView("workbench");
  el("add-nand").focus();
});
welcomeExploreButton.addEventListener("click", () => {
  closeWelcome();
  switchView("feed");
  void refreshFeed();
  void refreshChainStatus();
  void refreshAdapters();
});
welcomeEl.addEventListener("click", (event) => {
  if (event.target === welcomeEl) closeWelcome();
});
rewardsWork.addEventListener("click", () => void workNow());
el("refresh-feed").addEventListener("click", () => {
  void refreshFeed();
  void refreshChainStatus();
  void refreshAdapters();
});
anchorFeedButton.addEventListener("click", () => void anchorPendingPublications());
loadMoreButton.addEventListener("click", () => void loadMoreFeed());
el("zoom-in").addEventListener("click", () => zoomBy(1.25));
el("zoom-out").addEventListener("click", () => zoomBy(0.8));
el("zoom-fit").addEventListener("click", () => fitView());
titleInput.addEventListener("input", saveDraft);
bodyInput.addEventListener("input", saveDraft);
authorInput.addEventListener("input", () => {
  localStorage.setItem(HANDLE_KEY, authorInput.value.trim().toLowerCase());
});
resetIdentityButton.addEventListener("click", () => {
  const identity = loadStoredIdentity();
  if (!identity) return;

  if (!window.confirm(t("dyn.forgetConfirm", { handle: identity.handle }))) {
    return;
  }

  localStorage.removeItem(IDENTITY_KEY);
  localStorage.removeItem(HANDLE_KEY);
  authorInput.value = "";
  renderIdentityStatus();
  toast(t("toast.nameRemoved"));
});
el("clear-remix").addEventListener("click", () => {
  parentId = null;
  remixSourceTitle = null;
  saveDraft();
  render();
});

importSourceButton.addEventListener("click", () => void importGitHubSource());
clearSourceButton.addEventListener("click", () => {
  source = null;
  sourceRepoInput.value = "";
  sourcePathInput.value = "";
  saveDraft();
  renderSourceStatus();
  toast(t("toast.sourceCleared"));
});

el("copy-json").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(buildCircuit(), null, 2));
    toast(t("toast.codeCopied"));
  } catch {
    toast(t("toast.clipboard"), true);
  }
});

document.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    const view =
      button.dataset.view === "feed"
        ? "feed"
        : button.dataset.view === "rewards"
          ? "rewards"
          : button.dataset.view === "market"
            ? "market"
            : "workbench";
    switchView(view);
    if (view === "feed") {
      void refreshFeed();
      void refreshChainStatus();
      void refreshAdapters();
      void refreshRegistry();
    }
  });
});

window.addEventListener("resize", applyView);

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !welcomeEl.classList.contains("hidden")) {
    closeWelcome();
    return;
  }

  const target = event.target;
  const typing =
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT");

  if (!typing && (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault();
    deleteSelected();
  }
});

function init(): void {
  initI18n();

  tasks.forEach((task) => {
    const option = document.createElement("option");
    option.value = task.id;
    option.textContent = taskTitleFor(task);
    taskSelect.append(option);
  });

  const storedHandle = localStorage.getItem(HANDLE_KEY);
  if (storedHandle) authorInput.value = storedHandle;

  const identity = loadStoredIdentity();
  if (identity) authorInput.value = identity.handle;

  renderIdentityStatus();
  setTask(tasks[0]?.id ?? "");
  void refreshFeed();
  void refreshChainStatus();
  void refreshAdapters();
  void refreshRegistry();

  if (localStorage.getItem(WELCOME_KEY) !== "1") {
    openWelcome();
  }
}

init();
