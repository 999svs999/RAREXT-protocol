// packages/core/src/canonical.ts
function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const record = value;
  const keys = Object.keys(record).filter((key) => record[key] !== void 0).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

// packages/core/src/ai.ts
var MAX_GENERATIVE_STEPS = 1e5;
var MAX_VOCAB = 4096;
var MAX_GENERATIVE_TOKEN_LENGTH = 256;
var MAX_GENERATIVE_OUTPUT_LENGTH = 1 << 20;
function replayOutputBound(model, steps) {
  let longest = 0;
  for (const token of model.vocab) {
    if (token.length > longest) longest = token.length;
  }
  return longest * steps;
}
function isXorshiftModel(value) {
  if (typeof value !== "object" || value === null) return false;
  const model = value;
  if (model.kind !== "xorshift32") return false;
  const params = model.params;
  if (!params) return false;
  return Number.isInteger(params.a) && params.a >= 1 && params.a <= 31 && Number.isInteger(params.b) && params.b >= 1 && params.b <= 31 && Number.isInteger(params.c) && params.c >= 1 && params.c <= 31 && Array.isArray(model.vocab) && model.vocab.length >= 1 && model.vocab.length <= MAX_VOCAB && model.vocab.every(
    (token) => typeof token === "string" && token.length > 0 && token.length <= MAX_GENERATIVE_TOKEN_LENGTH
  );
}
function isGenerativeBody(value) {
  if (typeof value !== "object" || value === null) return false;
  const body = value;
  return isXorshiftModel(body.model) && Number.isInteger(body.seed) && body.seed >= 0 && body.seed <= 4294967295 && typeof body.output === "string" && body.output.length <= MAX_GENERATIVE_OUTPUT_LENGTH;
}
function isGenerativeSpec(value) {
  if (typeof value !== "object" || value === null) return false;
  const spec = value;
  return Number.isInteger(spec.steps) && spec.steps >= 1 && spec.steps <= MAX_GENERATIVE_STEPS;
}
function generate(model, seed, steps) {
  const { a, b, c } = model.params;
  let state = seed >>> 0;
  let out = "";
  for (let i = 0; i < steps; i++) {
    state ^= state << a >>> 0;
    state ^= state >>> b;
    state ^= state << c >>> 0;
    state >>>= 0;
    out += model.vocab[state % model.vocab.length];
  }
  return out;
}
function verifyGenerativeReplay(body, spec) {
  if (!isGenerativeBody(body) || !isGenerativeSpec(spec)) {
    return { correct: false, expected: "" };
  }
  if (replayOutputBound(body.model, spec.steps) > MAX_GENERATIVE_OUTPUT_LENGTH) {
    return { correct: false, expected: "" };
  }
  const expected = generate(body.model, body.seed, spec.steps);
  return { correct: expected === body.output, expected };
}
var MAX_BOUNDED_LENGTH = 1 << 20;
function isBoundedBody(value) {
  if (typeof value !== "object" || value === null) return false;
  const body = value;
  return Array.isArray(body.values) && body.values.length >= 1 && body.values.length <= MAX_BOUNDED_LENGTH && body.values.every((v) => typeof v === "number" && Number.isFinite(v));
}
function isBoundedSpec(value) {
  if (typeof value !== "object" || value === null) return false;
  const spec = value;
  return (spec.metric === "maxAbsError" || spec.metric === "meanAbsError") && typeof spec.bound === "number" && Number.isFinite(spec.bound) && spec.bound >= 0 && Array.isArray(spec.reference) && spec.reference.length >= 1 && spec.reference.length <= MAX_BOUNDED_LENGTH && spec.reference.every((v) => typeof v === "number" && Number.isFinite(v));
}
function maxAbsError(values, reference) {
  let max = 0;
  for (let i = 0; i < reference.length; i++) {
    const err = Math.abs(values[i] - reference[i]);
    if (err > max) max = err;
  }
  return max;
}
function meanAbsError(values, reference) {
  let sum = 0;
  for (let i = 0; i < reference.length; i++) {
    sum += Math.abs(values[i] - reference[i]);
  }
  return sum / reference.length;
}
function computeBoundedMetric(metric, values, reference) {
  return metric === "maxAbsError" ? maxAbsError(values, reference) : meanAbsError(values, reference);
}
function verifyBoundedReconstruction(body, spec) {
  if (body.values.length !== spec.reference.length) {
    return {
      error: `reconstruction length ${body.values.length} does not match reference length ${spec.reference.length}`
    };
  }
  const metricValue = computeBoundedMetric(spec.metric, body.values, spec.reference);
  return { correct: metricValue <= spec.bound, metricValue };
}
function verifyAiArtifact(artifact, challenge) {
  if (artifact.app === "ai-generative" && artifact.kind === "ai.generative") {
    if (!isGenerativeBody(artifact.body)) {
      return { error: "ai.generative artifact body must be { model, seed, output }" };
    }
    if (!isGenerativeSpec(challenge.spec)) {
      return { error: `challenge ${challenge.id} is not a generative task` };
    }
    const replay = verifyGenerativeReplay(artifact.body, challenge.spec);
    return {
      representation: "generative",
      correct: replay.correct,
      seed: artifact.body.seed,
      steps: challenge.spec.steps
    };
  }
  if (artifact.app === "ai-bounded" && artifact.kind === "ai.bounded") {
    if (!isBoundedBody(artifact.body)) {
      return { error: "ai.bounded artifact body must be { values: number[] }" };
    }
    if (!isBoundedSpec(challenge.spec)) {
      return { error: `challenge ${challenge.id} is not a bounded task` };
    }
    const check = verifyBoundedReconstruction(artifact.body, challenge.spec);
    if ("error" in check) return check;
    return {
      representation: "bounded",
      correct: check.correct,
      metricName: challenge.spec.metric,
      metricValue: check.metricValue,
      bound: challenge.spec.bound
    };
  }
  return { error: `artifact kind ${artifact.kind} is not a locally verifiable AI claim` };
}
var BOUNDED_RASTER_LANE = 48;
var BOUNDED_RASTER_GUTTER = 4;
var BOUNDED_RASTER_HEIGHT = 3 * BOUNDED_RASTER_LANE + 2 * BOUNDED_RASTER_GUTTER;

// packages/core/src/simulator.ts
var MAX_ITERATIONS = 64;
var ARITY = {
  INPUT: 0,
  OUTPUT: 1,
  NAND: 2,
  LATCH: 2
};
function validateCircuit(circuit) {
  const ids = /* @__PURE__ */ new Set();
  for (const component of circuit.components) {
    if (ids.has(component.id)) {
      throw new Error(`duplicate component id: ${component.id}`);
    }
    ids.add(component.id);
  }
  for (const component of circuit.components) {
    const inputs = component.inputs ?? [];
    const expected = ARITY[component.type];
    if (inputs.length !== expected) {
      throw new Error(
        `${component.id} (${component.type}) expects ${expected} inputs, got ${inputs.length}`
      );
    }
    for (const input of inputs) {
      if (!ids.has(input)) {
        throw new Error(`${component.id} references unknown input: ${input}`);
      }
    }
  }
}
function evaluate(component, values) {
  const inputs = component.inputs ?? [];
  if (component.type === "INPUT") {
    return values[component.id] ?? 0;
  }
  if (component.type === "OUTPUT") {
    return values[inputs[0] ?? ""] ?? 0;
  }
  if (component.type === "NAND") {
    const a = values[inputs[0] ?? ""] ?? 0;
    const b = values[inputs[1] ?? ""] ?? 0;
    return a === 1 && b === 1 ? 0 : 1;
  }
  const data = values[inputs[0] ?? ""] ?? 0;
  const enable = values[inputs[1] ?? ""] ?? 0;
  return enable === 1 ? data : values[component.id] ?? 0;
}
function simulate(circuit, inputs, initial = {}) {
  validateCircuit(circuit);
  const values = {};
  for (const component of circuit.components) {
    if (component.type === "INPUT") {
      const value = inputs[component.id];
      if (value !== 0 && value !== 1) {
        throw new Error(`missing or invalid input: ${component.id}`);
      }
      values[component.id] = value;
    } else {
      values[component.id] = initial[component.id] ?? 0;
    }
  }
  let iterations = 0;
  let settled = false;
  const trace = [];
  for (let pass = 0; pass < MAX_ITERATIONS; pass++) {
    iterations = pass + 1;
    let changed = false;
    for (const component of circuit.components) {
      if (component.type === "INPUT") continue;
      const next = evaluate(component, values);
      if (next !== values[component.id]) {
        values[component.id] = next;
        changed = true;
      }
    }
    trace.push({ ...values });
    if (!changed) {
      settled = true;
      break;
    }
  }
  const outputs = {};
  for (const component of circuit.components) {
    if (component.type === "OUTPUT") {
      outputs[component.id] = values[component.id] ?? 0;
    }
  }
  return { outputs, values, settled, iterations, trace };
}

// packages/core/src/scoring.ts
function countGates(circuit) {
  return circuit.components.filter(
    (component) => component.type === "NAND" || component.type === "LATCH"
  ).length;
}
function score(circuit, task) {
  let passed = 0;
  for (const testCase of task.cases) {
    const result = simulate(circuit, testCase.inputs);
    if (!result.settled) continue;
    const ok = task.outputs.every(
      (name) => result.outputs[name] === testCase.outputs[name]
    );
    if (ok) passed++;
  }
  const gateCount = countGates(circuit);
  const correct = passed === task.cases.length;
  const efficiency = gateCount === 0 ? 0 : task.referenceGateCount / gateCount;
  return {
    taskId: task.id,
    correct,
    passed,
    total: task.cases.length,
    gateCount,
    efficiency,
    score: correct ? Math.round(efficiency * 1e3) : 0
  };
}

// packages/core/src/tasks.ts
var tasks = [
  {
    id: "half-adder",
    title: "Add two bits",
    description: "Turn the answer on when exactly one start is on. Turn the extra on when both starts are on.",
    inputs: ["a", "b"],
    outputs: ["sum", "carry"],
    referenceGateCount: 5,
    cases: [
      { inputs: { a: 0, b: 0 }, outputs: { sum: 0, carry: 0 } },
      { inputs: { a: 0, b: 1 }, outputs: { sum: 1, carry: 0 } },
      { inputs: { a: 1, b: 0 }, outputs: { sum: 1, carry: 0 } },
      { inputs: { a: 1, b: 1 }, outputs: { sum: 0, carry: 1 } }
    ]
  },
  {
    id: "majority",
    title: "Majority vote",
    description: "Turn the answer on when two or more of the three starts are on.",
    inputs: ["a", "b", "c"],
    outputs: ["y"],
    referenceGateCount: 9,
    cases: [
      { inputs: { a: 0, b: 0, c: 0 }, outputs: { y: 0 } },
      { inputs: { a: 0, b: 0, c: 1 }, outputs: { y: 0 } },
      { inputs: { a: 0, b: 1, c: 0 }, outputs: { y: 0 } },
      { inputs: { a: 0, b: 1, c: 1 }, outputs: { y: 1 } },
      { inputs: { a: 1, b: 0, c: 0 }, outputs: { y: 0 } },
      { inputs: { a: 1, b: 0, c: 1 }, outputs: { y: 1 } },
      { inputs: { a: 1, b: 1, c: 0 }, outputs: { y: 1 } },
      { inputs: { a: 1, b: 1, c: 1 }, outputs: { y: 1 } }
    ]
  },
  {
    id: "mux2",
    title: "Pick a signal",
    description: "The chooser picks which start reaches the answer. When the chooser is off, pick A. When it is on, pick B.",
    inputs: ["a", "b", "sel"],
    outputs: ["y"],
    referenceGateCount: 4,
    cases: [
      { inputs: { a: 0, b: 0, sel: 0 }, outputs: { y: 0 } },
      { inputs: { a: 0, b: 0, sel: 1 }, outputs: { y: 0 } },
      { inputs: { a: 0, b: 1, sel: 0 }, outputs: { y: 0 } },
      { inputs: { a: 0, b: 1, sel: 1 }, outputs: { y: 1 } },
      { inputs: { a: 1, b: 0, sel: 0 }, outputs: { y: 1 } },
      { inputs: { a: 1, b: 0, sel: 1 }, outputs: { y: 0 } },
      { inputs: { a: 1, b: 1, sel: 0 }, outputs: { y: 1 } },
      { inputs: { a: 1, b: 1, sel: 1 }, outputs: { y: 1 } }
    ]
  }
];

// apps/web/src/i18n.ts
var STORAGE_KEY = "rarext:locale";
var LOCALES = [
  "en",
  "zh-Hans",
  "zh-Hant",
  "es",
  "fr",
  "pt",
  "ja",
  "ar"
];
var LOCALE_NAMES = {
  en: "English",
  "zh-Hans": "\u7B80\u4F53\u4E2D\u6587",
  "zh-Hant": "\u7E41\u9AD4\u4E2D\u6587",
  es: "Espa\xF1ol",
  fr: "Fran\xE7ais",
  pt: "Portugu\xEAs",
  ja: "\u65E5\u672C\u8A9E",
  ar: "\u0627\u0644\u0639\u0631\u0628\u064A\u0629"
};
var en = {
  "nav.play": "Play",
  "nav.community": "Community",
  "tagline": "Build tiny machines. Share them.",
  "guide": "How ApesDaily works",
  "footer.protocol": "Runs on the RAREXT protocol.",
  "lang": "Language",
  "wb.puzzleOf": "Puzzle {n} of {total}",
  "wb.choose": "Choose a puzzle",
  "wb.addBlock": "Add a block",
  "wb.notBoth": "NOT-BOTH",
  "wb.notBothShort": "both on = off",
  "wb.memory": "MEMORY",
  "wb.memoryShort": "remembers a bit",
  "wb.remove": "Remove block",
  "wb.restart": "Start over",
  "wb.viewBoard": "View board",
  "wb.partHelp": "NOT-BOTH is on unless both inputs are on. MEMORY holds one value.",
  "wb.progress": "Progress",
  "wb.ready": "Ready",
  "wb.checksPassed": "Checks passed",
  "wb.blocksUsed": "Blocks used",
  "wb.points": "Points",
  "wb.solved": "Puzzle solved.",
  "wb.nextReady": "Ready for the next one?",
  "wb.nextPuzzle": "Next puzzle",
  "wb.needHint": "Need a hint?",
  "wb.builders": "For builders",
  "wb.buildersHelp": "NOT-BOTH is a NAND block and MEMORY is a LATCH. Tap a green dot, then a gray dot, to link blocks.",
  "wb.copyCode": "Copy build code",
  "wb.github": "GitHub project",
  "wb.buildFile": "Build file",
  "wb.optional": "optional",
  "wb.import": "Bring in build",
  "wb.clearSource": "Clear source",
  "wb.publicSource": "Public projects only. We pin the exact commit.",
  "wb.linkBlocks": "Link the blocks",
  "wb.addStart": "Add a block to get started.",
  "wb.checks": "Checks",
  "wb.notYet": "not yet",
  "wb.checksCopy": "Each row is one try. Match the right side to pass.",
  "wb.share": "Share your build",
  "wb.shareLocked": "Solve the puzzle to share it with the community.",
  "wb.noSignup": "No sign-up needed.",
  "wb.yourName": "Your name",
  "wb.nameHelp": "Lowercase letters, numbers, dashes, and underscores.",
  "wb.nameBuild": "Name your build",
  "wb.note": "Add a note",
  "wb.publish": "Share build",
  "wb.identity": "No sign-up. We\u2019ll keep your name on this device.",
  "wb.account": "Account details",
  "wb.accountHelp": "Your name stays on this device. Every build you share is checked by RAREXT.",
  "wb.forget": "Forget name",
  "feed.title": "Community builds",
  "feed.copy": "Open a build, make a copy, or check the answers.",
  "feed.refresh": "Refresh",
  "feed.more": "Show more builds",
  "feed.builders": "For builders",
  "feed.save": "Save checkpoint",
  "feed.saveHelp": "Save a checkpoint of new builds.",
  "feed.loading": "Loading networks\u2026",
  "feed.sponsored": "Sponsored challenges",
  "welcome.eyebrow": "Welcome to ApesDaily",
  "welcome.title": "Build tiny machines. Share them with everyone.",
  "welcome.lede": "A simple puzzle game about connecting blocks. No experience needed\u2014a bit is just on or off (1 or 0).",
  "welcome.step1": "Pick a puzzle",
  "welcome.step1copy": "Start with a simple adding puzzle.",
  "welcome.step2": "Connect the blocks",
  "welcome.step2copy": "Add blocks, then link a green dot to a gray dot.",
  "welcome.step3": "Share and compare",
  "welcome.step3copy": "Get a checked score, then copy other people\u2019s builds.",
  "welcome.start": "Start playing",
  "welcome.explore": "See community builds",
  "welcome.glossary": "What are these blocks?",
  "welcome.notboth": "NOT-BOTH",
  "welcome.notbothCopy": "A block that turns off only when both inputs are on. It is the only block you need.",
  "welcome.memory": "MEMORY",
  "welcome.memoryCopy": "A block that remembers one on/off value.",
  "welcome.bit": "Bit",
  "welcome.bitCopy": "A bit is just on or off (1 or 0).",
  "welcome.startanswer": "Start / answer",
  "welcome.startanswerCopy": "The values you start with and the answer you build.",
  "dyn.on": "on",
  "dyn.off": "off",
  "dyn.chooser": "chooser",
  "dyn.answer": "answer",
  "dyn.extra": "extra",
  "dyn.start": "START",
  "dyn.yourAnswer": "your answer",
  "dyn.remembers": "remembers",
  "dyn.notBothDesc": "Turns off only when both inputs are on.",
  "dyn.almost": "Almost there",
  "dyn.notYet": "Not yet",
  "dyn.solved": "Solved!",
  "dyn.of": "{done} of {total}",
  "dyn.checksRight": "{done} of {total} right",
  "dyn.next": "Next: {title}",
  "dyn.seeCommunity": "See community builds",
  "dyn.startHint": "Add a NOT-BOTH block, then link it to the starts and answers.",
  "dyn.linkHint": "Tap a green dot, then a gray dot.",
  "dyn.connectAll": "Connect every block to see the checks.",
  "dyn.solveToShare": "Solve the puzzle to share it with the community.",
  "dyn.selectBlock": "Select a block first.",
  "dyn.startGreen": "Start from a green dot.",
  "dyn.firstBuild": "First build",
  "dyn.aCopy": "A copy",
  "dyn.copyOf": "Copy of \u201C{title}\u201D",
  "dyn.solvedTag": "Solved",
  "dyn.sponsored": "Sponsored",
  "dyn.notSolved": "Not solved",
  "dyn.nameUnchecked": "Name not checked",
  "dyn.open": "Open",
  "dyn.copy": "Copy",
  "dyn.check": "Check answers",
  "dyn.points": "points",
  "dyn.blocks": "blocks",
  "dyn.units": "units",
  "dyn.build": "Build",
  "dyn.proof": "proof",
  "dyn.nameConfirmed": "Name confirmed",
  "dyn.source": "Source",
  "dyn.loadingBuilds": "Loading builds\u2026",
  "dyn.feedUnavailable": "Community builds are unavailable.",
  "dyn.tryAgain": "Try again",
  "dyn.justNow": "just now",
  "dyn.minutes": "{n}m ago",
  "dyn.hours": "{n}h ago",
  "dyn.days": "{n}d ago",
  "dyn.ready": "Ready",
  "dyn.unavailable": "Unavailable",
  "dyn.notConnected": "Not connected",
  "dyn.liveUnavailable": "Live network is unavailable.",
  "dyn.liveNetwork": "Live network \xB7 block {block}",
  "bem.address": "BSC address",
  "bem.check": "Check balance",
  "bem.hint": "Enter an EVM address to read its $BEM balance.",
  "bem.balance": "$BEM balance: {amount}",
  "bem.unavailable": "$BEM balance is unavailable.",
  "dyn.otherApp": "This artifact belongs to another app and cannot open in the logic workbench.",
  "dyn.forgetConfirm": "Forget the name @{handle} saved on this device?",
  "wb.startHintsOver": "Start hints over",
  "wb.anotherHint": "Another hint",
  "wb.gettingNameReady": "Getting your name ready\u2026",
  "wb.checkingBuild": "Checking your build\u2026",
  "wb.namePlaceholder": "e.g. sam",
  "wb.titlePlaceholder": "e.g. My first adding machine",
  "wb.notePlaceholder": "What did you figure out?",
  "wb.repoPlaceholder": "owner/name",
  "wb.pathPlaceholder": "circuits/my-build.json",
  "page.title": "ApesDaily \u2014 verifiable builds",
  "page.description": "The protocol and infrastructure for verifiable builds.",
  "task.half-adder.title": "Add two bits",
  "task.half-adder.description": "Turn the answer on when exactly one start is on. Turn the extra on when both starts are on.",
  "task.majority.title": "Majority vote",
  "task.majority.description": "Turn the answer on when two or more of the three starts are on.",
  "task.mux2.title": "Pick a signal",
  "task.mux2.description": "The chooser picks which start reaches the answer. When the chooser is off, pick A. When it is on, pick B.",
  "hint.half-adder.0": "NOT-BOTH turns off only when both of its inputs are on. Start there.",
  "hint.half-adder.1": "The answer is on when exactly one start is on. That takes four NOT-BOTH blocks.",
  "hint.half-adder.2": "The extra is on only when both starts are on. One block can make that.",
  "hint.half-adder.3": "Try one NOT-BOTH on both starts, then use its result to build the answer and the extra.",
  "hint.majority.0": "The answer turns on when at least two of the three starts are on.",
  "hint.majority.1": "Compare the starts in pairs: A with B, A with C, and B with C.",
  "hint.majority.2": "Combine the pair results so that any two on values turn the answer on.",
  "hint.mux2.0": "The chooser decides which of the other two starts reaches the answer.",
  "hint.mux2.1": "When the chooser is off, A should win. When it is on, B should win.",
  "hint.mux2.2": "Use the chooser to switch each start on or off before combining them.",
  "hint.generic": "Connect every input and output, then check the tests.",
  "wb.addNandAria": "Add a NOT-BOTH block",
  "wb.addLatchAria": "Add a MEMORY block",
  "wb.close": "Close",
  "wb.dismiss": "Dismiss tip",
  "wb.zoomOut": "Zoom out",
  "wb.zoomIn": "Zoom in",
  "wb.zoomFit": "Fit build",
  "wb.fit": "Fit",
  "wb.buildArea": "Build area",
  "wb.replace": "Replace build",
  "wb.lookingUp": "Looking up the latest commit\u2026",
  "dyn.onOrOff": "on or off",
  "dyn.startNode": "Start {id}. It is on or off.",
  "dyn.answerNode": "Your build sets this answer.",
  "dyn.remembersOne": "Remembers one on/off value.",
  "dyn.value": "VALUE",
  "dyn.hold": "HOLD",
  "dyn.in": "IN",
  "dyn.yours": "yours",
  "dyn.checkColumn": "check",
  "dyn.yes": "yes",
  "dyn.no": "no",
  "dyn.by": "by",
  "dyn.checkedBy": "Checked by RAREXT",
  "dyn.moreInfo": "More info",
  "dyn.remove": "remove",
  "dyn.latest": "latest",
  "dyn.sourceUsing": "Using {source} at {commit}.",
  "dyn.identitySharing": "Sharing as @{handle}. Your builds are checked automatically.",
  "feed.emptyTitle": "No builds yet",
  "feed.emptyCopy": "Be the first to share a build.",
  "feed.startBuilding": "Start building",
  "feed.loadErrorTitle": "Could not load builds",
  "feed.loadErrorCopy": "Check your connection and try again.",
  "feed.networksUnavailable": "Networks are unavailable right now.",
  "feed.sharedPoints": "Shared with the community \xB7 {score} points",
  "feed.checkpointSaved": "Saved a checkpoint for {count} builds.",
  "err.nameConflict": "This browser already shares as @{existing}. Forget that name first to share as @{handle}.",
  "err.nameTaken": "@{handle} is already taken. Choose another name or use the name saved on this device.",
  "err.saveName": "Could not save your name. Try again.",
  "err.nameInvalid": "Your name can use lowercase letters, numbers, dashes, and underscores.",
  "err.nameRequired": "Give your build a name first.",
  "err.connectBeforeShare": "Connect every block before sharing.",
  "err.share": "Could not share your build.",
  "err.feed": "feed unavailable",
  "err.projectName": "Use a GitHub project name like owner/name.",
  "err.readProject": "Could not read that project.",
  "err.anchor": "Could not save the checkpoint.",
  "err.check": "Could not check this build.",
  "toast.nameRemoved": "Name removed from this device.",
  "toast.sourceCleared": "Source cleared. The build stays.",
  "toast.codeCopied": "Build code copied.",
  "toast.clipboard": "Clipboard unavailable.",
  "toast.shared": "Shared! Your build is live.",
  "toast.buildImported": "Build brought in. The pinned source will travel with it.",
  "toast.projectPinned": "Project pinned. Add a build file to bring in a machine.",
  "toast.buildCopied": "Build copied. The original will be credited.",
  "toast.opened": "Opened in Play.",
  "toast.verified": "Checks passed. This build matches the original.",
  "toast.mismatch": "This build did not match. It may have changed.",
  "toast.checkpointNone": "There are no new builds to save.",
  "nav.rewards": "Rewards",
  "rewards.title": "Your work, your credits",
  "rewards.credits": "Credits",
  "rewards.board": "Ways to earn",
  "rewards.work": "Work now",
  "rewards.empty": "No work is available right now.",
  "action.verify": "Verify a build",
  "action.store": "Hold bytes",
  "action.mirror": "Mirror the registry",
  "action.relay": "Relay an anchor",
  "action.publish": "Publish a build",
  "action.remix": "Remix a build",
  "action.report": "Report a bad claim",
  "crypto.pq": "PQ",
  "crypto.pqTitle": "Signed with a post-quantum key",
  "nav.market": "Market",
  "market.title": "The market",
  "market.participants": "Participants",
  "market.listings": "Listings",
  "market.answers": "Network answers",
  "market.price": "Price",
  "market.kind": "Kind",
  "market.empty": "Nothing here yet.",
  "market.contributors": "{n} contributors",
  "rewards.open": "{n} open"
};
var zhHans = {
  "nav.play": "\u6E38\u73A9",
  "nav.community": "\u793E\u533A",
  "tagline": "\u642D\u5EFA\u5FAE\u578B\u673A\u5668\uFF0C\u5206\u4EAB\u7ED9\u4E16\u754C\u3002",
  "guide": "ApesDaily \u5982\u4F55\u8FD0\u4F5C",
  "footer.protocol": "\u8FD0\u884C\u5728 RAREXT \u534F\u8BAE\u4E4B\u4E0A\u3002",
  "lang": "\u8BED\u8A00",
  "wb.puzzleOf": "\u7B2C {n} \u9898\uFF0C\u5171 {total} \u9898",
  "wb.choose": "\u9009\u62E9\u9898\u76EE",
  "wb.addBlock": "\u6DFB\u52A0\u79EF\u6728",
  "wb.notBoth": "\u975E\u5168\u4E0E",
  "wb.notBothShort": "\u5168\u5F00\u5219\u5173",
  "wb.memory": "\u8BB0\u5FC6",
  "wb.memoryShort": "\u8BB0\u4F4F\u4E00\u4F4D",
  "wb.remove": "\u5220\u9664\u79EF\u6728",
  "wb.restart": "\u91CD\u65B0\u5F00\u59CB",
  "wb.viewBoard": "\u67E5\u770B\u753B\u5E03",
  "wb.partHelp": "\u201C\u975E\u5168\u4E0E\u201D\u4EC5\u5728\u4E24\u4E2A\u8F93\u5165\u90FD\u5F00\u542F\u65F6\u5173\u95ED\u3002\u201C\u8BB0\u5FC6\u201D\u4FDD\u5B58\u4E00\u4E2A\u503C\u3002",
  "wb.progress": "\u8FDB\u5EA6",
  "wb.ready": "\u5C31\u7EEA",
  "wb.checksPassed": "\u901A\u8FC7\u68C0\u67E5",
  "wb.blocksUsed": "\u4F7F\u7528\u79EF\u6728",
  "wb.points": "\u5F97\u5206",
  "wb.solved": "\u9898\u76EE\u5DF2\u5B8C\u6210\u3002",
  "wb.nextReady": "\u51C6\u5907\u4E0B\u4E00\u9898\uFF1F",
  "wb.nextPuzzle": "\u4E0B\u4E00\u9898",
  "wb.needHint": "\u9700\u8981\u63D0\u793A\uFF1F",
  "wb.builders": "\u7ED9\u6784\u5EFA\u8005",
  "wb.buildersHelp": "\u201C\u975E\u5168\u4E0E\u201D\u662F NAND \u79EF\u6728\uFF0C\u201C\u8BB0\u5FC6\u201D\u662F LATCH\u3002\u70B9\u7EFF\u70B9\uFF0C\u518D\u70B9\u7070\u70B9\uFF0C\u5373\u53EF\u8FDE\u63A5\u3002",
  "wb.copyCode": "\u590D\u5236\u6784\u5EFA\u4EE3\u7801",
  "wb.github": "GitHub \u9879\u76EE",
  "wb.buildFile": "\u6784\u5EFA\u6587\u4EF6",
  "wb.optional": "\u53EF\u9009",
  "wb.import": "\u5BFC\u5165\u6784\u5EFA",
  "wb.clearSource": "\u6E05\u9664\u6765\u6E90",
  "wb.publicSource": "\u4EC5\u9650\u516C\u5F00\u9879\u76EE\u3002\u6211\u4EEC\u4F1A\u9501\u5B9A\u51C6\u786E\u63D0\u4EA4\u3002",
  "wb.linkBlocks": "\u8FDE\u63A5\u79EF\u6728",
  "wb.addStart": "\u6DFB\u52A0\u4E00\u4E2A\u79EF\u6728\u5F00\u59CB\u3002",
  "wb.checks": "\u68C0\u67E5",
  "wb.notYet": "\u5C1A\u672A",
  "wb.checksCopy": "\u6BCF\u884C\u4E00\u6B21\u5C1D\u8BD5\u3002\u53F3\u4FA7\u5339\u914D\u5373\u901A\u8FC7\u3002",
  "wb.share": "\u5206\u4EAB\u4F60\u7684\u6784\u5EFA",
  "wb.shareLocked": "\u5B8C\u6210\u9898\u76EE\u540E\u5373\u53EF\u5206\u4EAB\u5230\u793E\u533A\u3002",
  "wb.noSignup": "\u65E0\u9700\u6CE8\u518C\u3002",
  "wb.yourName": "\u4F60\u7684\u540D\u5B57",
  "wb.nameHelp": "\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u77ED\u6A2A\u7EBF\u548C\u4E0B\u5212\u7EBF\u3002",
  "wb.nameBuild": "\u4E3A\u6784\u5EFA\u547D\u540D",
  "wb.note": "\u6DFB\u52A0\u8BF4\u660E",
  "wb.publish": "\u5206\u4EAB\u6784\u5EFA",
  "wb.identity": "\u65E0\u9700\u6CE8\u518C\u3002\u540D\u5B57\u4F1A\u4FDD\u5B58\u5728\u6B64\u8BBE\u5907\u3002",
  "wb.account": "\u8D26\u6237\u8BE6\u60C5",
  "wb.accountHelp": "\u540D\u5B57\u4FDD\u5B58\u5728\u6B64\u8BBE\u5907\u3002\u4F60\u5206\u4EAB\u7684\u6BCF\u4E2A\u6784\u5EFA\u90FD\u7531 RAREXT \u68C0\u67E5\u3002",
  "wb.forget": "\u5FD8\u8BB0\u540D\u5B57",
  "feed.title": "\u793E\u533A\u6784\u5EFA",
  "feed.copy": "\u6253\u5F00\u3001\u590D\u5236\u6216\u68C0\u67E5\u6784\u5EFA\u7B54\u6848\u3002",
  "feed.refresh": "\u5237\u65B0",
  "feed.more": "\u663E\u793A\u66F4\u591A\u6784\u5EFA",
  "feed.builders": "\u7ED9\u6784\u5EFA\u8005",
  "feed.save": "\u4FDD\u5B58\u68C0\u67E5\u70B9",
  "feed.saveHelp": "\u4E3A\u65B0\u6784\u5EFA\u4FDD\u5B58\u68C0\u67E5\u70B9\u3002",
  "feed.loading": "\u6B63\u5728\u52A0\u8F7D\u7F51\u7EDC\u2026",
  "feed.sponsored": "\u8D5E\u52A9\u6311\u6218",
  "welcome.eyebrow": "\u6B22\u8FCE\u6765\u5230 ApesDaily",
  "welcome.title": "\u642D\u5EFA\u5FAE\u578B\u673A\u5668\uFF0C\u5206\u4EAB\u7ED9\u6BCF\u4E2A\u4EBA\u3002",
  "welcome.lede": "\u4E00\u4E2A\u8FDE\u63A5\u79EF\u6728\u7684\u7B80\u5355\u89E3\u8C1C\u6E38\u620F\u3002\u65E0\u9700\u7ECF\u9A8C\u2014\u2014\u4E00\u4F4D\u5C31\u662F\u5F00\u6216\u5173\uFF081 \u6216 0\uFF09\u3002",
  "welcome.step1": "\u9009\u62E9\u9898\u76EE",
  "welcome.step1copy": "\u4ECE\u7B80\u5355\u7684\u52A0\u6CD5\u9898\u5F00\u59CB\u3002",
  "welcome.step2": "\u8FDE\u63A5\u79EF\u6728",
  "welcome.step2copy": "\u6DFB\u52A0\u79EF\u6728\uFF0C\u628A\u7EFF\u70B9\u8FDE\u5230\u7070\u70B9\u3002",
  "welcome.step3": "\u5206\u4EAB\u4E0E\u6BD4\u8F83",
  "welcome.step3copy": "\u83B7\u5F97\u7ECF\u8FC7\u68C0\u67E5\u7684\u5206\u6570\uFF0C\u518D\u590D\u5236\u522B\u4EBA\u7684\u6784\u5EFA\u3002",
  "welcome.start": "\u5F00\u59CB\u6E38\u73A9",
  "welcome.explore": "\u67E5\u770B\u793E\u533A\u6784\u5EFA",
  "welcome.glossary": "\u8FD9\u4E9B\u79EF\u6728\u662F\u4EC0\u4E48\uFF1F",
  "welcome.notboth": "\u975E\u5168\u4E0E",
  "welcome.notbothCopy": "\u4EC5\u5F53\u4E24\u4E2A\u8F93\u5165\u90FD\u5F00\u542F\u65F6\u5173\u95ED\u7684\u79EF\u6728\u3002\u4F60\u53EA\u9700\u8981\u8FD9\u4E00\u79CD\u3002",
  "welcome.memory": "\u8BB0\u5FC6",
  "welcome.memoryCopy": "\u8BB0\u4F4F\u4E00\u4E2A\u5F00/\u5173\u503C\u7684\u79EF\u6728\u3002",
  "welcome.bit": "\u4F4D",
  "welcome.bitCopy": "\u4E00\u4F4D\u5C31\u662F\u5F00\u6216\u5173\uFF081 \u6216 0\uFF09\u3002",
  "welcome.startanswer": "\u8D77\u70B9 / \u7B54\u6848",
  "welcome.startanswerCopy": "\u4F60\u5F00\u59CB\u65F6\u7684\u503C\uFF0C\u4EE5\u53CA\u4F60\u6784\u5EFA\u51FA\u7684\u7B54\u6848\u3002",
  "dyn.on": "\u5F00",
  "dyn.off": "\u5173",
  "dyn.chooser": "\u9009\u62E9\u5668",
  "dyn.answer": "\u7B54\u6848",
  "dyn.extra": "\u8FDB\u4F4D",
  "dyn.start": "\u8D77\u70B9",
  "dyn.yourAnswer": "\u4F60\u7684\u7B54\u6848",
  "dyn.remembers": "\u8BB0\u4F4F",
  "dyn.notBothDesc": "\u4EC5\u5F53\u4E24\u4E2A\u8F93\u5165\u90FD\u5F00\u542F\u65F6\u5173\u95ED\u3002",
  "dyn.almost": "\u5FEB\u5B8C\u6210\u4E86",
  "dyn.notYet": "\u5C1A\u672A",
  "dyn.solved": "\u5B8C\u6210\uFF01",
  "dyn.of": "{done} / {total}",
  "dyn.checksRight": "{done} / {total} \u6B63\u786E",
  "dyn.next": "\u4E0B\u4E00\u9898\uFF1A{title}",
  "dyn.seeCommunity": "\u67E5\u770B\u793E\u533A\u6784\u5EFA",
  "dyn.startHint": "\u6DFB\u52A0\u4E00\u4E2A\u201C\u975E\u5168\u4E0E\u201D\u79EF\u6728\uFF0C\u518D\u8FDE\u5230\u8D77\u70B9\u548C\u7B54\u6848\u3002",
  "dyn.linkHint": "\u70B9\u7EFF\u70B9\uFF0C\u518D\u70B9\u7070\u70B9\u3002",
  "dyn.connectAll": "\u8FDE\u63A5\u6240\u6709\u79EF\u6728\u4EE5\u67E5\u770B\u68C0\u67E5\u3002",
  "dyn.solveToShare": "\u5B8C\u6210\u9898\u76EE\u540E\u5373\u53EF\u5206\u4EAB\u5230\u793E\u533A\u3002",
  "dyn.selectBlock": "\u8BF7\u5148\u9009\u62E9\u4E00\u4E2A\u79EF\u6728\u3002",
  "dyn.startGreen": "\u4ECE\u7EFF\u70B9\u5F00\u59CB\u3002",
  "dyn.firstBuild": "\u9996\u4E2A\u6784\u5EFA",
  "dyn.aCopy": "\u4E00\u4E2A\u526F\u672C",
  "dyn.copyOf": "\u201C{title}\u201D\u7684\u526F\u672C",
  "dyn.solvedTag": "\u5DF2\u5B8C\u6210",
  "dyn.sponsored": "\u8D5E\u52A9",
  "dyn.notSolved": "\u672A\u5B8C\u6210",
  "dyn.nameUnchecked": "\u540D\u5B57\u672A\u9A8C\u8BC1",
  "dyn.open": "\u6253\u5F00",
  "dyn.copy": "\u590D\u5236",
  "dyn.check": "\u68C0\u67E5\u7B54\u6848",
  "dyn.points": "\u5206",
  "dyn.blocks": "\u79EF\u6728",
  "dyn.units": "\u5355\u4F4D",
  "dyn.build": "\u6784\u5EFA",
  "dyn.proof": "\u8BC1\u660E",
  "dyn.nameConfirmed": "\u540D\u5B57\u5DF2\u786E\u8BA4",
  "dyn.source": "\u6765\u6E90",
  "dyn.loadingBuilds": "\u6B63\u5728\u52A0\u8F7D\u6784\u5EFA\u2026",
  "dyn.feedUnavailable": "\u793E\u533A\u6784\u5EFA\u6682\u65F6\u4E0D\u53EF\u7528\u3002",
  "dyn.tryAgain": "\u91CD\u8BD5",
  "dyn.justNow": "\u521A\u521A",
  "dyn.minutes": "{n} \u5206\u949F\u524D",
  "dyn.hours": "{n} \u5C0F\u65F6\u524D",
  "dyn.days": "{n} \u5929\u524D",
  "dyn.ready": "\u5C31\u7EEA",
  "dyn.unavailable": "\u4E0D\u53EF\u7528",
  "dyn.notConnected": "\u672A\u8FDE\u63A5",
  "dyn.liveUnavailable": "\u5B9E\u65F6\u7F51\u7EDC\u4E0D\u53EF\u7528\u3002",
  "dyn.liveNetwork": "\u5B9E\u65F6\u7F51\u7EDC \xB7 \u533A\u5757 {block}",
  "bem.address": "BSC \u5730\u5740",
  "bem.check": "\u67E5\u8BE2\u4F59\u989D",
  "bem.hint": "\u8F93\u5165 EVM \u5730\u5740\u4EE5\u8BFB\u53D6\u5176 $BEM \u4F59\u989D\u3002",
  "bem.balance": "$BEM \u4F59\u989D\uFF1A{amount}",
  "bem.unavailable": "$BEM \u4F59\u989D\u4E0D\u53EF\u7528\u3002",
  "dyn.otherApp": "\u6B64\u4EA7\u7269\u5C5E\u4E8E\u5176\u4ED6\u5E94\u7528\uFF0C\u65E0\u6CD5\u5728\u903B\u8F91\u5DE5\u4F5C\u53F0\u6253\u5F00\u3002",
  "dyn.forgetConfirm": "\u8981\u5FD8\u8BB0\u6B64\u8BBE\u5907\u4E0A\u4FDD\u5B58\u7684\u540D\u5B57 @{handle} \u5417\uFF1F",
  "wb.startHintsOver": "\u91CD\u65B0\u5F00\u59CB\u63D0\u793A",
  "wb.anotherHint": "\u53E6\u4E00\u4E2A\u63D0\u793A",
  "wb.gettingNameReady": "\u6B63\u5728\u51C6\u5907\u4F60\u7684\u540D\u5B57\u2026",
  "wb.checkingBuild": "\u6B63\u5728\u68C0\u67E5\u4F60\u7684\u6784\u5EFA\u2026",
  "wb.namePlaceholder": "\u4F8B\u5982 sam",
  "wb.titlePlaceholder": "\u4F8B\u5982 \u6211\u7684\u7B2C\u4E00\u53F0\u52A0\u6CD5\u673A",
  "wb.notePlaceholder": "\u4F60\u53D1\u73B0\u4E86\u4EC0\u4E48\uFF1F",
  "wb.repoPlaceholder": "owner/name",
  "wb.pathPlaceholder": "circuits/my-build.json",
  "page.title": "ApesDaily \u2014 \u53EF\u9A8C\u8BC1\u6784\u5EFA",
  "page.description": "\u9762\u5411\u6784\u5EFA\u53EF\u7F16\u7A0B\u786C\u4EF6\u7684 AI \u4EE3\u7406\u548C\u4EBA\u7C7B\u7684\u53EF\u9A8C\u8BC1\u793E\u4EA4\u5E73\u53F0\u3002",
  "task.half-adder.title": "\u4E24\u4E2A\u4F4D\u76F8\u52A0",
  "task.half-adder.description": "\u5F53\u6070\u597D\u4E00\u4E2A\u8D77\u70B9\u5F00\u542F\u65F6\uFF0C\u8BA9\u7B54\u6848\u5F00\u542F\uFF1B\u5F53\u4E24\u4E2A\u8D77\u70B9\u90FD\u5F00\u542F\u65F6\uFF0C\u8BA9\u8FDB\u4F4D\u5F00\u542F\u3002",
  "task.majority.title": "\u591A\u6570\u8868\u51B3",
  "task.majority.description": "\u5F53\u4E09\u4E2A\u8D77\u70B9\u4E2D\u6709\u4E24\u4E2A\u6216\u66F4\u591A\u5F00\u542F\u65F6\uFF0C\u8BA9\u7B54\u6848\u5F00\u542F\u3002",
  "task.mux2.title": "\u9009\u62E9\u4FE1\u53F7",
  "task.mux2.description": "\u9009\u62E9\u5668\u51B3\u5B9A\u54EA\u4E2A\u8D77\u70B9\u5230\u8FBE\u7B54\u6848\u3002\u9009\u62E9\u5668\u5173\u95ED\u65F6\u9009 A\uFF0C\u5F00\u542F\u65F6\u9009 B\u3002",
  "hint.half-adder.0": "\u201C\u975E\u5168\u4E0E\u201D\u4EC5\u5728\u4E24\u4E2A\u8F93\u5165\u90FD\u5F00\u542F\u65F6\u5173\u95ED\u3002\u4ECE\u8FD9\u91CC\u5F00\u59CB\u3002",
  "hint.half-adder.1": "\u5F53\u6070\u597D\u4E00\u4E2A\u8D77\u70B9\u5F00\u542F\u65F6\uFF0C\u7B54\u6848\u4E3A\u5F00\u3002\u8FD9\u9700\u8981\u56DB\u4E2A\u201C\u975E\u5168\u4E0E\u201D\u79EF\u6728\u3002",
  "hint.half-adder.2": "\u4EC5\u5F53\u4E24\u4E2A\u8D77\u70B9\u90FD\u5F00\u542F\u65F6\uFF0C\u8FDB\u4F4D\u4E3A\u5F00\u3002\u4E00\u4E2A\u79EF\u6728\u5C31\u80FD\u505A\u5230\u3002",
  "hint.half-adder.3": "\u5148\u7528\u4E00\u4E2A\u201C\u975E\u5168\u4E0E\u201D\u8FDE\u63A5\u4E24\u4E2A\u8D77\u70B9\uFF0C\u518D\u7528\u5B83\u7684\u7ED3\u679C\u6784\u5EFA\u7B54\u6848\u548C\u8FDB\u4F4D\u3002",
  "hint.majority.0": "\u5F53\u4E09\u4E2A\u8D77\u70B9\u4E2D\u81F3\u5C11\u4E24\u4E2A\u5F00\u542F\u65F6\uFF0C\u7B54\u6848\u4E3A\u5F00\u3002",
  "hint.majority.1": "\u6210\u5BF9\u6BD4\u8F83\u8D77\u70B9\uFF1AA \u4E0E B\u3001A \u4E0E C\u3001B \u4E0E C\u3002",
  "hint.majority.2": "\u7EC4\u5408\u8FD9\u4E9B\u6210\u5BF9\u7ED3\u679C\uFF0C\u4F7F\u4EFB\u610F\u4E24\u4E2A\u5F00\u542F\u503C\u90FD\u80FD\u8BA9\u7B54\u6848\u5F00\u542F\u3002",
  "hint.mux2.0": "\u9009\u62E9\u5668\u51B3\u5B9A\u53E6\u5916\u4E24\u4E2A\u8D77\u70B9\u4E2D\u7684\u54EA\u4E00\u4E2A\u5230\u8FBE\u7B54\u6848\u3002",
  "hint.mux2.1": "\u9009\u62E9\u5668\u5173\u95ED\u65F6 A \u5E94\u80DC\u51FA\uFF1B\u5F00\u542F\u65F6 B \u5E94\u80DC\u51FA\u3002",
  "hint.mux2.2": "\u7528\u9009\u62E9\u5668\u5728\u7EC4\u5408\u524D\u5206\u522B\u5F00\u542F\u6216\u5173\u95ED\u6BCF\u4E2A\u8D77\u70B9\u3002",
  "hint.generic": "\u8FDE\u63A5\u6240\u6709\u8F93\u5165\u548C\u8F93\u51FA\uFF0C\u7136\u540E\u68C0\u67E5\u6D4B\u8BD5\u3002",
  "wb.addNandAria": "\u6DFB\u52A0\u4E00\u4E2A\u201C\u975E\u5168\u4E0E\u201D\u79EF\u6728",
  "wb.addLatchAria": "\u6DFB\u52A0\u4E00\u4E2A\u201C\u8BB0\u5FC6\u201D\u79EF\u6728",
  "wb.close": "\u5173\u95ED",
  "wb.dismiss": "\u5173\u95ED\u63D0\u793A",
  "wb.zoomOut": "\u7F29\u5C0F",
  "wb.zoomIn": "\u653E\u5927",
  "wb.zoomFit": "\u9002\u5E94\u6784\u5EFA",
  "wb.fit": "\u9002\u5E94",
  "wb.buildArea": "\u6784\u5EFA\u533A\u57DF",
  "wb.replace": "\u66FF\u6362\u6784\u5EFA",
  "wb.lookingUp": "\u6B63\u5728\u67E5\u627E\u6700\u65B0\u63D0\u4EA4\u2026",
  "dyn.onOrOff": "\u5F00\u6216\u5173",
  "dyn.startNode": "\u8D77\u70B9 {id}\u3002\u5B83\u5904\u4E8E\u5F00\u6216\u5173\u3002",
  "dyn.answerNode": "\u4F60\u7684\u6784\u5EFA\u51B3\u5B9A\u8FD9\u4E2A\u7B54\u6848\u3002",
  "dyn.remembersOne": "\u8BB0\u4F4F\u4E00\u4E2A\u5F00/\u5173\u503C\u3002",
  "dyn.value": "\u503C",
  "dyn.hold": "\u4FDD\u6301",
  "dyn.in": "\u8F93\u5165",
  "dyn.yours": "\u4F60\u7684",
  "dyn.checkColumn": "\u68C0\u67E5",
  "dyn.yes": "\u662F",
  "dyn.no": "\u5426",
  "dyn.by": "\u7531",
  "dyn.checkedBy": "\u7531 RAREXT \u68C0\u67E5",
  "dyn.moreInfo": "\u66F4\u591A\u4FE1\u606F",
  "dyn.remove": "\u79FB\u9664",
  "dyn.latest": "\u6700\u65B0",
  "dyn.sourceUsing": "\u4F7F\u7528 {source}\uFF0C\u63D0\u4EA4 {commit}\u3002",
  "dyn.identitySharing": "\u4EE5 @{handle} \u5206\u4EAB\u3002\u4F60\u7684\u6784\u5EFA\u4F1A\u81EA\u52A8\u68C0\u67E5\u3002",
  "feed.emptyTitle": "\u8FD8\u6CA1\u6709\u6784\u5EFA",
  "feed.emptyCopy": "\u6210\u4E3A\u7B2C\u4E00\u4E2A\u5206\u4EAB\u6784\u5EFA\u7684\u4EBA\u3002",
  "feed.startBuilding": "\u5F00\u59CB\u6784\u5EFA",
  "feed.loadErrorTitle": "\u65E0\u6CD5\u52A0\u8F7D\u6784\u5EFA",
  "feed.loadErrorCopy": "\u8BF7\u68C0\u67E5\u8FDE\u63A5\u540E\u91CD\u8BD5\u3002",
  "feed.networksUnavailable": "\u7F51\u7EDC\u76EE\u524D\u4E0D\u53EF\u7528\u3002",
  "feed.sharedPoints": "\u5DF2\u5206\u4EAB\u5230\u793E\u533A \xB7 {score} \u5206",
  "feed.checkpointSaved": "\u5DF2\u4E3A {count} \u4E2A\u6784\u5EFA\u4FDD\u5B58\u68C0\u67E5\u70B9\u3002",
  "err.nameConflict": "\u6B64\u6D4F\u89C8\u5668\u5DF2\u4EE5 @{existing} \u5206\u4EAB\u3002\u8BF7\u5148\u5FD8\u8BB0\u8BE5\u540D\u5B57\uFF0C\u518D\u4EE5 @{handle} \u5206\u4EAB\u3002",
  "err.nameTaken": "@{handle} \u5DF2\u88AB\u5360\u7528\u3002\u8BF7\u6362\u4E00\u4E2A\u540D\u5B57\uFF0C\u6216\u4F7F\u7528\u6B64\u8BBE\u5907\u4E0A\u4FDD\u5B58\u7684\u540D\u5B57\u3002",
  "err.saveName": "\u65E0\u6CD5\u4FDD\u5B58\u4F60\u7684\u540D\u5B57\u3002\u8BF7\u91CD\u8BD5\u3002",
  "err.nameInvalid": "\u540D\u5B57\u53EF\u4F7F\u7528\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u77ED\u6A2A\u7EBF\u548C\u4E0B\u5212\u7EBF\u3002",
  "err.nameRequired": "\u8BF7\u5148\u4E3A\u4F60\u7684\u6784\u5EFA\u547D\u540D\u3002",
  "err.connectBeforeShare": "\u5206\u4EAB\u524D\u8BF7\u8FDE\u63A5\u6240\u6709\u79EF\u6728\u3002",
  "err.share": "\u65E0\u6CD5\u5206\u4EAB\u4F60\u7684\u6784\u5EFA\u3002",
  "err.feed": "\u4FE1\u606F\u6D41\u4E0D\u53EF\u7528",
  "err.projectName": "\u8BF7\u4F7F\u7528 owner/name \u5F62\u5F0F\u7684 GitHub \u9879\u76EE\u540D\u3002",
  "err.readProject": "\u65E0\u6CD5\u8BFB\u53D6\u8BE5\u9879\u76EE\u3002",
  "err.anchor": "\u65E0\u6CD5\u4FDD\u5B58\u68C0\u67E5\u70B9\u3002",
  "err.check": "\u65E0\u6CD5\u68C0\u67E5\u6B64\u6784\u5EFA\u3002",
  "toast.nameRemoved": "\u540D\u5B57\u5DF2\u4ECE\u6B64\u8BBE\u5907\u79FB\u9664\u3002",
  "toast.sourceCleared": "\u6765\u6E90\u5DF2\u6E05\u9664\u3002\u6784\u5EFA\u4ECD\u7136\u4FDD\u7559\u3002",
  "toast.codeCopied": "\u6784\u5EFA\u4EE3\u7801\u5DF2\u590D\u5236\u3002",
  "toast.clipboard": "\u526A\u8D34\u677F\u4E0D\u53EF\u7528\u3002",
  "toast.shared": "\u5DF2\u5206\u4EAB\uFF01\u4F60\u7684\u6784\u5EFA\u5DF2\u4E0A\u7EBF\u3002",
  "toast.buildImported": "\u6784\u5EFA\u5DF2\u5BFC\u5165\u3002\u9501\u5B9A\u7684\u6765\u6E90\u4F1A\u968F\u5B83\u4E00\u8D77\u4FDD\u5B58\u3002",
  "toast.projectPinned": "\u9879\u76EE\u5DF2\u9501\u5B9A\u3002\u6DFB\u52A0\u6784\u5EFA\u6587\u4EF6\u5373\u53EF\u5BFC\u5165\u673A\u5668\u3002",
  "toast.buildCopied": "\u6784\u5EFA\u5DF2\u590D\u5236\u3002\u539F\u521B\u5EFA\u8005\u4F1A\u83B7\u5F97\u7F72\u540D\u3002",
  "toast.opened": "\u5DF2\u5728\u201C\u6E38\u73A9\u201D\u4E2D\u6253\u5F00\u3002",
  "toast.verified": "\u68C0\u67E5\u901A\u8FC7\u3002\u6B64\u6784\u5EFA\u4E0E\u539F\u59CB\u7248\u672C\u4E00\u81F4\u3002",
  "toast.mismatch": "\u6B64\u6784\u5EFA\u4E0D\u5339\u914D\uFF0C\u53EF\u80FD\u5DF2\u88AB\u4FEE\u6539\u3002",
  "toast.checkpointNone": "\u6CA1\u6709\u65B0\u7684\u6784\u5EFA\u9700\u8981\u4FDD\u5B58\u3002",
  "nav.rewards": "\u5956\u52B1",
  "rewards.title": "\u4F60\u7684\u52B3\u52A8\uFF0C\u4F60\u7684\u79EF\u5206",
  "rewards.credits": "\u79EF\u5206",
  "rewards.board": "\u8D5A\u53D6\u65B9\u5F0F",
  "rewards.work": "\u5F00\u59CB\u5DE5\u4F5C",
  "rewards.empty": "\u5F53\u524D\u6CA1\u6709\u53EF\u9886\u53D6\u7684\u5DE5\u4F5C\u3002",
  "action.verify": "\u9A8C\u8BC1\u6784\u5EFA",
  "action.store": "\u4FDD\u5B58\u6570\u636E",
  "action.mirror": "\u955C\u50CF\u6CE8\u518C\u8868",
  "action.relay": "\u8F6C\u53D1\u951A\u5B9A",
  "action.publish": "\u53D1\u5E03\u6784\u5EFA",
  "action.remix": "\u590D\u523B\u6784\u5EFA",
  "action.report": "\u4E3E\u62A5\u865A\u5047\u58F0\u660E",
  "crypto.pq": "\u540E\u91CF\u5B50",
  "crypto.pqTitle": "\u4F7F\u7528\u540E\u91CF\u5B50\u5BC6\u94A5\u7B7E\u540D",
  "nav.market": "\u5E02\u573A",
  "market.title": "\u5E02\u573A",
  "market.participants": "\u53C2\u4E0E\u8005",
  "market.listings": "\u5546\u54C1",
  "market.answers": "\u7F51\u7EDC\u5171\u8BC6",
  "market.price": "\u4EF7\u683C",
  "market.kind": "\u7C7B\u578B",
  "market.empty": "\u8FD9\u91CC\u8FD8\u6CA1\u6709\u5185\u5BB9\u3002",
  "market.contributors": "{n} \u4F4D\u8D21\u732E\u8005",
  "rewards.open": "{n} \u4E2A\u8FDB\u884C\u4E2D"
};
var zhHant = {
  ...zhHans,
  "nav.play": "\u904A\u73A9",
  "nav.community": "\u793E\u7FA4",
  "tagline": "\u642D\u5EFA\u5FAE\u578B\u6A5F\u5668\uFF0C\u5206\u4EAB\u7D66\u4E16\u754C\u3002",
  "guide": "ApesDaily \u5982\u4F55\u904B\u4F5C",
  "footer.protocol": "\u904B\u884C\u5728 RAREXT \u5354\u5B9A\u4E4B\u4E0A\u3002",
  "lang": "\u8A9E\u8A00",
  "wb.puzzleOf": "\u7B2C {n} \u984C\uFF0C\u5171 {total} \u984C",
  "wb.choose": "\u9078\u64C7\u984C\u76EE",
  "wb.addBlock": "\u65B0\u589E\u7A4D\u6728",
  "wb.notBoth": "\u975E\u5168\u8207",
  "wb.notBothShort": "\u5168\u958B\u5247\u95DC",
  "wb.memory": "\u8A18\u61B6",
  "wb.memoryShort": "\u8A18\u4F4F\u4E00\u4F4D",
  "wb.remove": "\u522A\u9664\u7A4D\u6728",
  "wb.restart": "\u91CD\u65B0\u958B\u59CB",
  "wb.viewBoard": "\u6AA2\u8996\u756B\u5E03",
  "wb.partHelp": "\u300C\u975E\u5168\u8207\u300D\u50C5\u5728\u5169\u500B\u8F38\u5165\u90FD\u958B\u555F\u6642\u95DC\u9589\u3002\u300C\u8A18\u61B6\u300D\u4FDD\u5B58\u4E00\u500B\u503C\u3002",
  "wb.progress": "\u9032\u5EA6",
  "wb.ready": "\u5C31\u7DD2",
  "wb.checksPassed": "\u901A\u904E\u6AA2\u67E5",
  "wb.blocksUsed": "\u4F7F\u7528\u7A4D\u6728",
  "wb.points": "\u5F97\u5206",
  "wb.solved": "\u984C\u76EE\u5DF2\u5B8C\u6210\u3002",
  "wb.nextReady": "\u6E96\u5099\u4E0B\u4E00\u984C\uFF1F",
  "wb.nextPuzzle": "\u4E0B\u4E00\u984C",
  "wb.needHint": "\u9700\u8981\u63D0\u793A\uFF1F",
  "wb.builders": "\u7D66\u5EFA\u69CB\u8005",
  "wb.buildersHelp": "\u300C\u975E\u5168\u8207\u300D\u662F NAND \u7A4D\u6728\uFF0C\u300C\u8A18\u61B6\u300D\u662F LATCH\u3002\u9EDE\u7DA0\u9EDE\uFF0C\u518D\u9EDE\u7070\u9EDE\uFF0C\u5373\u53EF\u9023\u63A5\u3002",
  "wb.copyCode": "\u8907\u88FD\u5EFA\u69CB\u7A0B\u5F0F\u78BC",
  "wb.github": "GitHub \u5C08\u6848",
  "wb.buildFile": "\u5EFA\u69CB\u6A94\u6848",
  "wb.optional": "\u9078\u586B",
  "wb.import": "\u532F\u5165\u5EFA\u69CB",
  "wb.clearSource": "\u6E05\u9664\u4F86\u6E90",
  "wb.publicSource": "\u50C5\u9650\u516C\u958B\u5C08\u6848\u3002\u6211\u5011\u6703\u9396\u5B9A\u6E96\u78BA\u63D0\u4EA4\u3002",
  "wb.linkBlocks": "\u9023\u63A5\u7A4D\u6728",
  "wb.addStart": "\u65B0\u589E\u4E00\u500B\u7A4D\u6728\u958B\u59CB\u3002",
  "wb.checks": "\u6AA2\u67E5",
  "wb.notYet": "\u5C1A\u672A",
  "wb.checksCopy": "\u6BCF\u5217\u4E00\u6B21\u5617\u8A66\u3002\u53F3\u5074\u7B26\u5408\u5373\u901A\u904E\u3002",
  "wb.share": "\u5206\u4EAB\u4F60\u7684\u5EFA\u69CB",
  "wb.shareLocked": "\u5B8C\u6210\u984C\u76EE\u5F8C\u5373\u53EF\u5206\u4EAB\u5230\u793E\u7FA4\u3002",
  "wb.noSignup": "\u7121\u9700\u8A3B\u518A\u3002",
  "wb.yourName": "\u4F60\u7684\u540D\u5B57",
  "wb.nameHelp": "\u5C0F\u5BEB\u5B57\u6BCD\u3001\u6578\u5B57\u3001\u77ED\u6A6B\u7DDA\u548C\u5E95\u7DDA\u3002",
  "wb.nameBuild": "\u70BA\u5EFA\u69CB\u547D\u540D",
  "wb.note": "\u65B0\u589E\u8AAA\u660E",
  "wb.publish": "\u5206\u4EAB\u5EFA\u69CB",
  "wb.identity": "\u7121\u9700\u8A3B\u518A\u3002\u540D\u5B57\u6703\u4FDD\u5B58\u5728\u6B64\u88DD\u7F6E\u3002",
  "wb.account": "\u5E33\u6236\u8A73\u60C5",
  "wb.accountHelp": "\u540D\u5B57\u4FDD\u5B58\u5728\u6B64\u88DD\u7F6E\u3002\u4F60\u5206\u4EAB\u7684\u6BCF\u500B\u5EFA\u69CB\u90FD\u7531 RAREXT \u6AA2\u67E5\u3002",
  "wb.forget": "\u5FD8\u8A18\u540D\u5B57",
  "feed.title": "\u793E\u7FA4\u5EFA\u69CB",
  "feed.copy": "\u958B\u555F\u3001\u8907\u88FD\u6216\u6AA2\u67E5\u5EFA\u69CB\u7B54\u6848\u3002",
  "feed.refresh": "\u91CD\u65B0\u6574\u7406",
  "feed.more": "\u986F\u793A\u66F4\u591A\u5EFA\u69CB",
  "feed.builders": "\u7D66\u5EFA\u69CB\u8005",
  "feed.save": "\u5132\u5B58\u6AA2\u67E5\u9EDE",
  "feed.saveHelp": "\u70BA\u65B0\u5EFA\u69CB\u5132\u5B58\u6AA2\u67E5\u9EDE\u3002",
  "feed.loading": "\u6B63\u5728\u8F09\u5165\u7DB2\u8DEF\u2026",
  "feed.sponsored": "\u8D0A\u52A9\u6311\u6230",
  "welcome.eyebrow": "\u6B61\u8FCE\u4F86\u5230 ApesDaily",
  "welcome.title": "\u642D\u5EFA\u5FAE\u578B\u6A5F\u5668\uFF0C\u5206\u4EAB\u7D66\u6BCF\u500B\u4EBA\u3002",
  "welcome.lede": "\u4E00\u500B\u9023\u63A5\u7A4D\u6728\u7684\u7C21\u55AE\u89E3\u8B0E\u904A\u6232\u3002\u7121\u9700\u7D93\u9A57\u2014\u2014\u4E00\u4F4D\u5C31\u662F\u958B\u6216\u95DC\uFF081 \u6216 0\uFF09\u3002",
  "welcome.step1": "\u9078\u64C7\u984C\u76EE",
  "welcome.step1copy": "\u5F9E\u7C21\u55AE\u7684\u52A0\u6CD5\u984C\u958B\u59CB\u3002",
  "welcome.step2": "\u9023\u63A5\u7A4D\u6728",
  "welcome.step2copy": "\u65B0\u589E\u7A4D\u6728\uFF0C\u628A\u7DA0\u9EDE\u9023\u5230\u7070\u9EDE\u3002",
  "welcome.step3": "\u5206\u4EAB\u8207\u6BD4\u8F03",
  "welcome.step3copy": "\u7372\u5F97\u7D93\u904E\u6AA2\u67E5\u7684\u5206\u6578\uFF0C\u518D\u8907\u88FD\u5225\u4EBA\u7684\u5EFA\u69CB\u3002",
  "welcome.start": "\u958B\u59CB\u904A\u73A9",
  "welcome.explore": "\u67E5\u770B\u793E\u7FA4\u5EFA\u69CB",
  "welcome.glossary": "\u9019\u4E9B\u7A4D\u6728\u662F\u4EC0\u9EBC\uFF1F",
  "welcome.notboth": "\u975E\u5168\u8207",
  "welcome.notbothCopy": "\u50C5\u7576\u5169\u500B\u8F38\u5165\u90FD\u958B\u555F\u6642\u95DC\u9589\u7684\u7A4D\u6728\u3002\u4F60\u53EA\u9700\u8981\u9019\u4E00\u7A2E\u3002",
  "welcome.memory": "\u8A18\u61B6",
  "welcome.memoryCopy": "\u8A18\u4F4F\u4E00\u500B\u958B/\u95DC\u503C\u7684\u7A4D\u6728\u3002",
  "welcome.bit": "\u4F4D\u5143",
  "welcome.bitCopy": "\u4E00\u4F4D\u5143\u5C31\u662F\u958B\u6216\u95DC\uFF081 \u6216 0\uFF09\u3002",
  "welcome.startanswer": "\u8D77\u9EDE / \u7B54\u6848",
  "welcome.startanswerCopy": "\u4F60\u958B\u59CB\u6642\u7684\u503C\uFF0C\u4EE5\u53CA\u4F60\u5EFA\u69CB\u51FA\u7684\u7B54\u6848\u3002",
  "dyn.on": "\u958B",
  "dyn.off": "\u95DC",
  "dyn.chooser": "\u9078\u64C7\u5668",
  "dyn.answer": "\u7B54\u6848",
  "dyn.extra": "\u9032\u4F4D",
  "dyn.start": "\u8D77\u9EDE",
  "dyn.yourAnswer": "\u4F60\u7684\u7B54\u6848",
  "dyn.remembers": "\u8A18\u4F4F",
  "dyn.notBothDesc": "\u50C5\u7576\u5169\u500B\u8F38\u5165\u90FD\u958B\u555F\u6642\u95DC\u9589\u3002",
  "dyn.almost": "\u5FEB\u5B8C\u6210\u4E86",
  "dyn.notYet": "\u5C1A\u672A",
  "dyn.solved": "\u5B8C\u6210\uFF01",
  "dyn.of": "{done} / {total}",
  "dyn.checksRight": "{done} / {total} \u6B63\u78BA",
  "dyn.next": "\u4E0B\u4E00\u984C\uFF1A{title}",
  "dyn.seeCommunity": "\u67E5\u770B\u793E\u7FA4\u5EFA\u69CB",
  "dyn.startHint": "\u65B0\u589E\u4E00\u500B\u300C\u975E\u5168\u8207\u300D\u7A4D\u6728\uFF0C\u518D\u9023\u5230\u8D77\u9EDE\u548C\u7B54\u6848\u3002",
  "dyn.linkHint": "\u9EDE\u7DA0\u9EDE\uFF0C\u518D\u9EDE\u7070\u9EDE\u3002",
  "dyn.connectAll": "\u9023\u63A5\u6240\u6709\u7A4D\u6728\u4EE5\u67E5\u770B\u6AA2\u67E5\u3002",
  "dyn.solveToShare": "\u5B8C\u6210\u984C\u76EE\u5F8C\u5373\u53EF\u5206\u4EAB\u5230\u793E\u7FA4\u3002",
  "dyn.selectBlock": "\u8ACB\u5148\u9078\u64C7\u4E00\u500B\u7A4D\u6728\u3002",
  "dyn.startGreen": "\u5F9E\u7DA0\u9EDE\u958B\u59CB\u3002",
  "dyn.firstBuild": "\u9996\u500B\u5EFA\u69CB",
  "dyn.aCopy": "\u4E00\u500B\u526F\u672C",
  "dyn.copyOf": "\u300C{title}\u300D\u7684\u526F\u672C",
  "dyn.solvedTag": "\u5DF2\u5B8C\u6210",
  "dyn.sponsored": "\u8D0A\u52A9",
  "dyn.notSolved": "\u672A\u5B8C\u6210",
  "dyn.nameUnchecked": "\u540D\u5B57\u672A\u9A57\u8B49",
  "dyn.open": "\u958B\u555F",
  "dyn.copy": "\u8907\u88FD",
  "dyn.check": "\u6AA2\u67E5\u7B54\u6848",
  "dyn.points": "\u5206",
  "dyn.blocks": "\u7A4D\u6728",
  "dyn.units": "\u55AE\u4F4D",
  "dyn.build": "\u5EFA\u69CB",
  "dyn.proof": "\u8B49\u660E",
  "dyn.nameConfirmed": "\u540D\u5B57\u5DF2\u78BA\u8A8D",
  "dyn.source": "\u4F86\u6E90",
  "dyn.loadingBuilds": "\u6B63\u5728\u8F09\u5165\u5EFA\u69CB\u2026",
  "dyn.feedUnavailable": "\u793E\u7FA4\u5EFA\u69CB\u66AB\u6642\u7121\u6CD5\u4F7F\u7528\u3002",
  "dyn.tryAgain": "\u91CD\u8A66",
  "dyn.justNow": "\u525B\u525B",
  "dyn.minutes": "{n} \u5206\u9418\u524D",
  "dyn.hours": "{n} \u5C0F\u6642\u524D",
  "dyn.days": "{n} \u5929\u524D",
  "dyn.ready": "\u5C31\u7DD2",
  "dyn.unavailable": "\u7121\u6CD5\u4F7F\u7528",
  "dyn.notConnected": "\u672A\u9023\u63A5",
  "dyn.liveUnavailable": "\u5373\u6642\u7DB2\u8DEF\u7121\u6CD5\u4F7F\u7528\u3002",
  "dyn.liveNetwork": "\u5373\u6642\u7DB2\u8DEF \xB7 \u5340\u584A {block}",
  "bem.address": "BSC \u4F4D\u5740",
  "bem.check": "\u67E5\u8A62\u9918\u984D",
  "bem.hint": "\u8F38\u5165 EVM \u4F4D\u5740\u4EE5\u8B80\u53D6\u5176 $BEM \u9918\u984D\u3002",
  "bem.balance": "$BEM \u9918\u984D\uFF1A{amount}",
  "bem.unavailable": "$BEM \u9918\u984D\u7121\u6CD5\u4F7F\u7528\u3002",
  "dyn.otherApp": "\u6B64\u7522\u7269\u5C6C\u65BC\u5176\u4ED6\u61C9\u7528\uFF0C\u7121\u6CD5\u5728\u908F\u8F2F\u5DE5\u4F5C\u53F0\u958B\u555F\u3002",
  "dyn.forgetConfirm": "\u8981\u5FD8\u8A18\u6B64\u88DD\u7F6E\u4E0A\u5132\u5B58\u7684\u540D\u5B57 @{handle} \u55CE\uFF1F",
  "wb.startHintsOver": "\u91CD\u65B0\u958B\u59CB\u63D0\u793A",
  "wb.anotherHint": "\u53E6\u4E00\u500B\u63D0\u793A",
  "wb.gettingNameReady": "\u6B63\u5728\u6E96\u5099\u4F60\u7684\u540D\u5B57\u2026",
  "wb.checkingBuild": "\u6B63\u5728\u6AA2\u67E5\u4F60\u7684\u5EFA\u69CB\u2026",
  "wb.namePlaceholder": "\u4F8B\u5982 sam",
  "wb.titlePlaceholder": "\u4F8B\u5982 \u6211\u7684\u7B2C\u4E00\u53F0\u52A0\u6CD5\u6A5F",
  "wb.notePlaceholder": "\u4F60\u767C\u73FE\u4E86\u4EC0\u9EBC\uFF1F",
  "wb.repoPlaceholder": "owner/name",
  "wb.pathPlaceholder": "circuits/my-build.json",
  "page.title": "ApesDaily \u2014 \u53EF\u9A57\u8B49\u5EFA\u69CB",
  "page.description": "\u9762\u5411\u5EFA\u69CB\u53EF\u7A0B\u5F0F\u5316\u786C\u9AD4\u7684 AI \u4EE3\u7406\u8207\u4EBA\u985E\u7684\u53EF\u9A57\u8B49\u793E\u4EA4\u5E73\u53F0\u3002",
  "task.half-adder.title": "\u5169\u500B\u4F4D\u5143\u76F8\u52A0",
  "task.half-adder.description": "\u7576\u6070\u597D\u4E00\u500B\u8D77\u9EDE\u958B\u555F\u6642\uFF0C\u8B93\u7B54\u6848\u958B\u555F\uFF1B\u7576\u5169\u500B\u8D77\u9EDE\u90FD\u958B\u555F\u6642\uFF0C\u8B93\u9032\u4F4D\u958B\u555F\u3002",
  "task.majority.title": "\u591A\u6578\u8868\u6C7A",
  "task.majority.description": "\u7576\u4E09\u500B\u8D77\u9EDE\u4E2D\u6709\u5169\u500B\u6216\u66F4\u591A\u958B\u555F\u6642\uFF0C\u8B93\u7B54\u6848\u958B\u555F\u3002",
  "task.mux2.title": "\u9078\u64C7\u8A0A\u865F",
  "task.mux2.description": "\u9078\u64C7\u5668\u6C7A\u5B9A\u54EA\u500B\u8D77\u9EDE\u5230\u9054\u7B54\u6848\u3002\u9078\u64C7\u5668\u95DC\u9589\u6642\u9078 A\uFF0C\u958B\u555F\u6642\u9078 B\u3002",
  "hint.half-adder.0": "\u300C\u975E\u5168\u8207\u300D\u50C5\u5728\u5169\u500B\u8F38\u5165\u90FD\u958B\u555F\u6642\u95DC\u9589\u3002\u5F9E\u9019\u88E1\u958B\u59CB\u3002",
  "hint.half-adder.1": "\u7576\u6070\u597D\u4E00\u500B\u8D77\u9EDE\u958B\u555F\u6642\uFF0C\u7B54\u6848\u70BA\u958B\u3002\u9019\u9700\u8981\u56DB\u500B\u300C\u975E\u5168\u8207\u300D\u7A4D\u6728\u3002",
  "hint.half-adder.2": "\u50C5\u7576\u5169\u500B\u8D77\u9EDE\u90FD\u958B\u555F\u6642\uFF0C\u9032\u4F4D\u70BA\u958B\u3002\u4E00\u500B\u7A4D\u6728\u5C31\u80FD\u505A\u5230\u3002",
  "hint.half-adder.3": "\u5148\u7528\u4E00\u500B\u300C\u975E\u5168\u8207\u300D\u9023\u63A5\u5169\u500B\u8D77\u9EDE\uFF0C\u518D\u7528\u5B83\u7684\u7D50\u679C\u5EFA\u69CB\u7B54\u6848\u548C\u9032\u4F4D\u3002",
  "hint.majority.0": "\u7576\u4E09\u500B\u8D77\u9EDE\u4E2D\u81F3\u5C11\u5169\u500B\u958B\u555F\u6642\uFF0C\u7B54\u6848\u70BA\u958B\u3002",
  "hint.majority.1": "\u6210\u5C0D\u6BD4\u8F03\u8D77\u9EDE\uFF1AA \u8207 B\u3001A \u8207 C\u3001B \u8207 C\u3002",
  "hint.majority.2": "\u7D44\u5408\u9019\u4E9B\u6210\u5C0D\u7D50\u679C\uFF0C\u4F7F\u4EFB\u610F\u5169\u500B\u958B\u555F\u503C\u90FD\u80FD\u8B93\u7B54\u6848\u958B\u555F\u3002",
  "hint.mux2.0": "\u9078\u64C7\u5668\u6C7A\u5B9A\u53E6\u5916\u5169\u500B\u8D77\u9EDE\u4E2D\u7684\u54EA\u4E00\u500B\u5230\u9054\u7B54\u6848\u3002",
  "hint.mux2.1": "\u9078\u64C7\u5668\u95DC\u9589\u6642 A \u61C9\u52DD\u51FA\uFF1B\u958B\u555F\u6642 B \u61C9\u52DD\u51FA\u3002",
  "hint.mux2.2": "\u7528\u9078\u64C7\u5668\u5728\u7D44\u5408\u524D\u5206\u5225\u958B\u555F\u6216\u95DC\u9589\u6BCF\u500B\u8D77\u9EDE\u3002",
  "hint.generic": "\u9023\u63A5\u6240\u6709\u8F38\u5165\u548C\u8F38\u51FA\uFF0C\u7136\u5F8C\u6AA2\u67E5\u6E2C\u8A66\u3002",
  "wb.addNandAria": "\u65B0\u589E\u4E00\u500B\u300C\u975E\u5168\u8207\u300D\u7A4D\u6728",
  "wb.addLatchAria": "\u65B0\u589E\u4E00\u500B\u300C\u8A18\u61B6\u300D\u7A4D\u6728",
  "wb.close": "\u95DC\u9589",
  "wb.dismiss": "\u95DC\u9589\u63D0\u793A",
  "wb.zoomOut": "\u7E2E\u5C0F",
  "wb.zoomIn": "\u653E\u5927",
  "wb.zoomFit": "\u9069\u61C9\u5EFA\u69CB",
  "wb.fit": "\u9069\u61C9",
  "wb.buildArea": "\u5EFA\u69CB\u5340\u57DF",
  "wb.replace": "\u66FF\u63DB\u5EFA\u69CB",
  "wb.lookingUp": "\u6B63\u5728\u5C0B\u627E\u6700\u65B0\u63D0\u4EA4\u2026",
  "dyn.onOrOff": "\u958B\u6216\u95DC",
  "dyn.startNode": "\u8D77\u9EDE {id}\u3002\u5B83\u8655\u65BC\u958B\u6216\u95DC\u3002",
  "dyn.answerNode": "\u4F60\u7684\u5EFA\u69CB\u6C7A\u5B9A\u9019\u500B\u7B54\u6848\u3002",
  "dyn.remembersOne": "\u8A18\u4F4F\u4E00\u500B\u958B/\u95DC\u503C\u3002",
  "dyn.value": "\u503C",
  "dyn.hold": "\u4FDD\u6301",
  "dyn.in": "\u8F38\u5165",
  "dyn.yours": "\u4F60\u7684",
  "dyn.checkColumn": "\u6AA2\u67E5",
  "dyn.yes": "\u662F",
  "dyn.no": "\u5426",
  "dyn.by": "\u7531",
  "dyn.checkedBy": "\u7531 RAREXT \u6AA2\u67E5",
  "dyn.moreInfo": "\u66F4\u591A\u8CC7\u8A0A",
  "dyn.remove": "\u79FB\u9664",
  "dyn.latest": "\u6700\u65B0",
  "dyn.sourceUsing": "\u4F7F\u7528 {source}\uFF0C\u63D0\u4EA4 {commit}\u3002",
  "dyn.identitySharing": "\u4EE5 @{handle} \u5206\u4EAB\u3002\u4F60\u7684\u5EFA\u69CB\u6703\u81EA\u52D5\u6AA2\u67E5\u3002",
  "feed.emptyTitle": "\u5C1A\u7121\u5EFA\u69CB",
  "feed.emptyCopy": "\u6210\u70BA\u7B2C\u4E00\u500B\u5206\u4EAB\u5EFA\u69CB\u7684\u4EBA\u3002",
  "feed.startBuilding": "\u958B\u59CB\u5EFA\u69CB",
  "feed.loadErrorTitle": "\u7121\u6CD5\u8F09\u5165\u5EFA\u69CB",
  "feed.loadErrorCopy": "\u8ACB\u6AA2\u67E5\u9023\u7DDA\u5F8C\u91CD\u8A66\u3002",
  "feed.networksUnavailable": "\u7DB2\u8DEF\u76EE\u524D\u7121\u6CD5\u4F7F\u7528\u3002",
  "feed.sharedPoints": "\u5DF2\u5206\u4EAB\u5230\u793E\u7FA4 \xB7 {score} \u5206",
  "feed.checkpointSaved": "\u5DF2\u70BA {count} \u500B\u5EFA\u69CB\u5132\u5B58\u6AA2\u67E5\u9EDE\u3002",
  "err.nameConflict": "\u6B64\u700F\u89BD\u5668\u5DF2\u4EE5 @{existing} \u5206\u4EAB\u3002\u8ACB\u5148\u5FD8\u8A18\u8A72\u540D\u5B57\uFF0C\u518D\u4EE5 @{handle} \u5206\u4EAB\u3002",
  "err.nameTaken": "@{handle} \u5DF2\u88AB\u5360\u7528\u3002\u8ACB\u63DB\u4E00\u500B\u540D\u5B57\uFF0C\u6216\u4F7F\u7528\u6B64\u88DD\u7F6E\u4E0A\u5132\u5B58\u7684\u540D\u5B57\u3002",
  "err.saveName": "\u7121\u6CD5\u5132\u5B58\u4F60\u7684\u540D\u5B57\u3002\u8ACB\u91CD\u8A66\u3002",
  "err.nameInvalid": "\u540D\u5B57\u53EF\u4F7F\u7528\u5C0F\u5BEB\u5B57\u6BCD\u3001\u6578\u5B57\u3001\u77ED\u6A6B\u7DDA\u548C\u5E95\u7DDA\u3002",
  "err.nameRequired": "\u8ACB\u5148\u70BA\u4F60\u7684\u5EFA\u69CB\u547D\u540D\u3002",
  "err.connectBeforeShare": "\u5206\u4EAB\u524D\u8ACB\u9023\u63A5\u6240\u6709\u7A4D\u6728\u3002",
  "err.share": "\u7121\u6CD5\u5206\u4EAB\u4F60\u7684\u5EFA\u69CB\u3002",
  "err.feed": "\u8CC7\u8A0A\u6D41\u7121\u6CD5\u4F7F\u7528",
  "err.projectName": "\u8ACB\u4F7F\u7528 owner/name \u5F62\u5F0F\u7684 GitHub \u5C08\u6848\u540D\u3002",
  "err.readProject": "\u7121\u6CD5\u8B80\u53D6\u8A72\u5C08\u6848\u3002",
  "err.anchor": "\u7121\u6CD5\u5132\u5B58\u6AA2\u67E5\u9EDE\u3002",
  "err.check": "\u7121\u6CD5\u6AA2\u67E5\u6B64\u5EFA\u69CB\u3002",
  "toast.nameRemoved": "\u540D\u5B57\u5DF2\u5F9E\u6B64\u88DD\u7F6E\u79FB\u9664\u3002",
  "toast.sourceCleared": "\u4F86\u6E90\u5DF2\u6E05\u9664\u3002\u5EFA\u69CB\u4ECD\u7136\u4FDD\u7559\u3002",
  "toast.codeCopied": "\u5EFA\u69CB\u7A0B\u5F0F\u78BC\u5DF2\u8907\u88FD\u3002",
  "toast.clipboard": "\u526A\u8CBC\u7C3F\u7121\u6CD5\u4F7F\u7528\u3002",
  "toast.shared": "\u5DF2\u5206\u4EAB\uFF01\u4F60\u7684\u5EFA\u69CB\u5DF2\u4E0A\u7DDA\u3002",
  "toast.buildImported": "\u5EFA\u69CB\u5DF2\u532F\u5165\u3002\u9396\u5B9A\u7684\u4F86\u6E90\u6703\u96A8\u5B83\u4E00\u8D77\u5132\u5B58\u3002",
  "toast.projectPinned": "\u5C08\u6848\u5DF2\u9396\u5B9A\u3002\u65B0\u589E\u5EFA\u69CB\u6A94\u6848\u5373\u53EF\u532F\u5165\u6A5F\u5668\u3002",
  "toast.buildCopied": "\u5EFA\u69CB\u5DF2\u8907\u88FD\u3002\u539F\u5EFA\u7ACB\u8005\u6703\u7372\u5F97\u7F72\u540D\u3002",
  "toast.opened": "\u5DF2\u5728\u300C\u904A\u73A9\u300D\u4E2D\u958B\u555F\u3002",
  "toast.verified": "\u6AA2\u67E5\u901A\u904E\u3002\u6B64\u5EFA\u69CB\u8207\u539F\u59CB\u7248\u672C\u4E00\u81F4\u3002",
  "toast.mismatch": "\u6B64\u5EFA\u69CB\u4E0D\u5339\u914D\uFF0C\u53EF\u80FD\u5DF2\u88AB\u4FEE\u6539\u3002",
  "toast.checkpointNone": "\u6C92\u6709\u65B0\u7684\u5EFA\u69CB\u9700\u8981\u5132\u5B58\u3002",
  "nav.rewards": "\u734E\u52F5",
  "rewards.title": "\u4F60\u7684\u52DE\u52D5\uFF0C\u4F60\u7684\u7A4D\u5206",
  "rewards.credits": "\u7A4D\u5206",
  "rewards.board": "\u8CFA\u53D6\u65B9\u5F0F",
  "rewards.work": "\u958B\u59CB\u5DE5\u4F5C",
  "rewards.empty": "\u76EE\u524D\u6C92\u6709\u53EF\u9818\u53D6\u7684\u5DE5\u4F5C\u3002",
  "action.verify": "\u9A57\u8B49\u5EFA\u69CB",
  "action.store": "\u4FDD\u5B58\u8CC7\u6599",
  "action.mirror": "\u93E1\u50CF\u8A3B\u518A\u8868",
  "action.relay": "\u8F49\u767C\u9328\u5B9A",
  "action.publish": "\u767C\u5E03\u5EFA\u69CB",
  "action.remix": "\u8907\u523B\u5EFA\u69CB",
  "action.report": "\u6AA2\u8209\u865B\u5047\u8072\u660E",
  "crypto.pq": "\u5F8C\u91CF\u5B50",
  "crypto.pqTitle": "\u4F7F\u7528\u5F8C\u91CF\u5B50\u5BC6\u9470\u7C3D\u540D",
  "nav.market": "\u5E02\u5834",
  "market.title": "\u5E02\u5834",
  "market.participants": "\u53C3\u8207\u8005",
  "market.listings": "\u5546\u54C1",
  "market.answers": "\u7DB2\u8DEF\u5171\u8B58",
  "market.price": "\u50F9\u683C",
  "market.kind": "\u985E\u578B",
  "market.empty": "\u9019\u88E1\u9084\u6C92\u6709\u5167\u5BB9\u3002",
  "market.contributors": "{n} \u4F4D\u8CA2\u737B\u8005",
  "rewards.open": "{n} \u500B\u9032\u884C\u4E2D"
};
var es = {
  "nav.play": "Jugar",
  "nav.community": "Comunidad",
  "tagline": "Construye m\xE1quinas diminutas. Comp\xE1rtelas.",
  "guide": "C\xF3mo funciona ApesDaily",
  "footer.protocol": "Funciona sobre el protocolo RAREXT.",
  "lang": "Idioma",
  "wb.puzzleOf": "Reto {n} de {total}",
  "wb.choose": "Elige un reto",
  "wb.addBlock": "A\xF1adir un bloque",
  "wb.notBoth": "NO-AMBOS",
  "wb.notBothShort": "ambos on = off",
  "wb.memory": "MEMORIA",
  "wb.memoryShort": "recuerda un bit",
  "wb.remove": "Quitar bloque",
  "wb.restart": "Empezar de nuevo",
  "wb.viewBoard": "Ver tablero",
  "wb.partHelp": "NO-AMBOS est\xE1 activo salvo que ambas entradas lo est\xE9n. MEMORIA guarda un valor.",
  "wb.progress": "Progreso",
  "wb.ready": "Listo",
  "wb.checksPassed": "Comprobaciones",
  "wb.blocksUsed": "Bloques usados",
  "wb.points": "Puntos",
  "wb.solved": "Reto resuelto.",
  "wb.nextReady": "\xBFListo para el siguiente?",
  "wb.nextPuzzle": "Siguiente reto",
  "wb.needHint": "\xBFNecesitas una pista?",
  "wb.builders": "Para creadores",
  "wb.buildersHelp": "NO-AMBOS es un bloque NAND y MEMORIA es un LATCH. Toca un punto verde y luego uno gris para conectar.",
  "wb.copyCode": "Copiar c\xF3digo",
  "wb.github": "Proyecto de GitHub",
  "wb.buildFile": "Archivo de construcci\xF3n",
  "wb.optional": "opcional",
  "wb.import": "Importar construcci\xF3n",
  "wb.clearSource": "Quitar fuente",
  "wb.publicSource": "Solo proyectos p\xFAblicos. Fijamos el commit exacto.",
  "wb.linkBlocks": "Conecta los bloques",
  "wb.addStart": "A\xF1ade un bloque para empezar.",
  "wb.checks": "Comprobaciones",
  "wb.notYet": "todav\xEDa no",
  "wb.checksCopy": "Cada fila es un intento. Iguala la derecha para pasar.",
  "wb.share": "Comparte tu construcci\xF3n",
  "wb.shareLocked": "Resuelve el reto para compartirlo con la comunidad.",
  "wb.noSignup": "No hace falta registrarse.",
  "wb.yourName": "Tu nombre",
  "wb.nameHelp": "Letras min\xFAsculas, n\xFAmeros, guiones y guiones bajos.",
  "wb.nameBuild": "Nombra tu construcci\xF3n",
  "wb.note": "A\xF1ade una nota",
  "wb.publish": "Compartir",
  "wb.identity": "Sin registro. Guardaremos tu nombre en este dispositivo.",
  "wb.account": "Detalles de la cuenta",
  "wb.accountHelp": "Tu nombre queda en este dispositivo. RAREXT comprueba cada construcci\xF3n.",
  "wb.forget": "Olvidar nombre",
  "feed.title": "Construcciones de la comunidad",
  "feed.copy": "Abre, copia o comprueba las respuestas.",
  "feed.refresh": "Actualizar",
  "feed.more": "Mostrar m\xE1s",
  "feed.builders": "Para creadores",
  "feed.save": "Guardar punto de control",
  "feed.saveHelp": "Guarda un punto de control de las nuevas construcciones.",
  "feed.loading": "Cargando redes\u2026",
  "feed.sponsored": "Retos patrocinados",
  "welcome.eyebrow": "Bienvenido a ApesDaily",
  "welcome.title": "Construye m\xE1quinas diminutas. Comp\xE1rtelas con todos.",
  "welcome.lede": "Un sencillo juego de conexi\xF3n de bloques. No hace falta experiencia: un bit est\xE1 encendido o apagado (1 o 0).",
  "welcome.step1": "Elige un reto",
  "welcome.step1copy": "Empieza con una suma sencilla.",
  "welcome.step2": "Conecta los bloques",
  "welcome.step2copy": "A\xF1ade bloques y une un punto verde con uno gris.",
  "welcome.step3": "Comparte y compara",
  "welcome.step3copy": "Obt\xE9n una puntuaci\xF3n verificada y copia construcciones ajenas.",
  "welcome.start": "Empezar a jugar",
  "welcome.explore": "Ver la comunidad",
  "welcome.glossary": "\xBFQu\xE9 son estos bloques?",
  "welcome.notboth": "NO-AMBOS",
  "welcome.notbothCopy": "Un bloque que se apaga solo cuando ambas entradas est\xE1n activas. Es el \xFAnico que necesitas.",
  "welcome.memory": "MEMORIA",
  "welcome.memoryCopy": "Un bloque que recuerda un valor on/off.",
  "welcome.bit": "Bit",
  "welcome.bitCopy": "Un bit est\xE1 encendido o apagado (1 o 0).",
  "welcome.startanswer": "Inicio / respuesta",
  "welcome.startanswerCopy": "Los valores iniciales y la respuesta que construyes.",
  "dyn.on": "on",
  "dyn.off": "off",
  "dyn.chooser": "selector",
  "dyn.answer": "respuesta",
  "dyn.extra": "extra",
  "dyn.start": "INICIO",
  "dyn.yourAnswer": "tu respuesta",
  "dyn.remembers": "recuerda",
  "dyn.notBothDesc": "Se apaga solo cuando ambas entradas est\xE1n activas.",
  "dyn.almost": "Casi",
  "dyn.notYet": "Todav\xEDa no",
  "dyn.solved": "\xA1Resuelto!",
  "dyn.of": "{done} de {total}",
  "dyn.checksRight": "{done} de {total} correctas",
  "dyn.next": "Siguiente: {title}",
  "dyn.seeCommunity": "Ver la comunidad",
  "dyn.startHint": "A\xF1ade un bloque NO-AMBOS y con\xE9ctalo a las entradas y respuestas.",
  "dyn.linkHint": "Toca un punto verde y luego uno gris.",
  "dyn.connectAll": "Conecta todos los bloques para ver las comprobaciones.",
  "dyn.solveToShare": "Resuelve el reto para compartirlo con la comunidad.",
  "dyn.selectBlock": "Selecciona un bloque primero.",
  "dyn.startGreen": "Empieza desde un punto verde.",
  "dyn.firstBuild": "Primera construcci\xF3n",
  "dyn.aCopy": "Una copia",
  "dyn.copyOf": "Copia de \xAB{title}\xBB",
  "dyn.solvedTag": "Resuelto",
  "dyn.sponsored": "Patrocinado",
  "dyn.notSolved": "Sin resolver",
  "dyn.nameUnchecked": "Nombre sin verificar",
  "dyn.open": "Abrir",
  "dyn.copy": "Copiar",
  "dyn.check": "Comprobar",
  "dyn.points": "puntos",
  "dyn.blocks": "bloques",
  "dyn.units": "unidades",
  "dyn.build": "Construcci\xF3n",
  "dyn.proof": "prueba",
  "dyn.nameConfirmed": "Nombre confirmado",
  "dyn.source": "Fuente",
  "dyn.loadingBuilds": "Cargando construcciones\u2026",
  "dyn.feedUnavailable": "La comunidad no est\xE1 disponible.",
  "dyn.tryAgain": "Reintentar",
  "dyn.justNow": "ahora",
  "dyn.minutes": "hace {n} min",
  "dyn.hours": "hace {n} h",
  "dyn.days": "hace {n} d",
  "dyn.ready": "Listo",
  "dyn.unavailable": "No disponible",
  "dyn.notConnected": "Sin conectar",
  "dyn.liveUnavailable": "La red en vivo no est\xE1 disponible.",
  "dyn.liveNetwork": "Red en vivo \xB7 bloque {block}",
  "bem.address": "Direcci\xF3n de BSC",
  "bem.check": "Consultar saldo",
  "bem.hint": "Introduce una direcci\xF3n EVM para leer su saldo de $BEM.",
  "bem.balance": "Saldo de $BEM: {amount}",
  "bem.unavailable": "El saldo de $BEM no est\xE1 disponible.",
  "dyn.otherApp": "Este artefacto pertenece a otra app y no se puede abrir en el taller l\xF3gico.",
  "dyn.forgetConfirm": "\xBFOlvidar el nombre @{handle} guardado en este dispositivo?",
  "wb.startHintsOver": "Reiniciar pistas",
  "wb.anotherHint": "Otra pista",
  "wb.gettingNameReady": "Preparando tu nombre\u2026",
  "wb.checkingBuild": "Comprobando tu construcci\xF3n\u2026",
  "wb.namePlaceholder": "p. ej. sam",
  "wb.titlePlaceholder": "p. ej. Mi primera m\xE1quina sumadora",
  "wb.notePlaceholder": "\xBFQu\xE9 descubriste?",
  "wb.repoPlaceholder": "propietario/nombre",
  "wb.pathPlaceholder": "circuits/mi-construccion.json",
  "page.title": "ApesDaily \u2014 construcciones verificables",
  "page.description": "Una plataforma social verificable para agentes de IA y personas que construyen hardware programable.",
  "task.half-adder.title": "Suma dos bits",
  "task.half-adder.description": "Activa la respuesta cuando exactamente una entrada est\xE9 activa. Activa el acarreo cuando ambas entradas est\xE9n activas.",
  "task.majority.title": "Voto por mayor\xEDa",
  "task.majority.description": "Activa la respuesta cuando dos o m\xE1s de las tres entradas est\xE9n activas.",
  "task.mux2.title": "Elige una se\xF1al",
  "task.mux2.description": "El selector decide qu\xE9 entrada llega a la respuesta. Si est\xE1 apagado, elige A. Si est\xE1 encendido, elige B.",
  "hint.half-adder.0": "NO-AMBOS se apaga solo cuando sus dos entradas est\xE1n activas. Empieza por ah\xED.",
  "hint.half-adder.1": "La respuesta se activa cuando exactamente una entrada est\xE1 activa. Hacen falta cuatro bloques NO-AMBOS.",
  "hint.half-adder.2": "El acarreo se activa solo cuando ambas entradas est\xE1n activas. Un bloque puede lograrlo.",
  "hint.half-adder.3": "Prueba un NO-AMBOS con las dos entradas y usa su resultado para construir la respuesta y el acarreo.",
  "hint.majority.0": "La respuesta se activa cuando al menos dos de las tres entradas est\xE1n activas.",
  "hint.majority.1": "Compara las entradas por parejas: A con B, A con C y B con C.",
  "hint.majority.2": "Combina los resultados por parejas para que dos valores activos activen la respuesta.",
  "hint.mux2.0": "El selector decide cu\xE1l de las otras dos entradas llega a la respuesta.",
  "hint.mux2.1": "Con el selector apagado debe ganar A. Con el selector encendido debe ganar B.",
  "hint.mux2.2": "Usa el selector para activar o desactivar cada entrada antes de combinarlas.",
  "hint.generic": "Conecta todas las entradas y salidas y luego revisa las comprobaciones.",
  "wb.addNandAria": "A\xF1adir un bloque NO-AMBOS",
  "wb.addLatchAria": "A\xF1adir un bloque MEMORIA",
  "wb.close": "Cerrar",
  "wb.dismiss": "Descartar consejo",
  "wb.zoomOut": "Alejar",
  "wb.zoomIn": "Acercar",
  "wb.zoomFit": "Ajustar construcci\xF3n",
  "wb.fit": "Ajustar",
  "wb.buildArea": "\xC1rea de construcci\xF3n",
  "wb.replace": "Reemplazar construcci\xF3n",
  "wb.lookingUp": "Buscando el \xFAltimo commit\u2026",
  "dyn.onOrOff": "encendido o apagado",
  "dyn.startNode": "Entrada {id}. Est\xE1 encendida o apagada.",
  "dyn.answerNode": "Tu construcci\xF3n establece esta respuesta.",
  "dyn.remembersOne": "Recuerda un valor on/off.",
  "dyn.value": "VALOR",
  "dyn.hold": "RETENER",
  "dyn.in": "ENT",
  "dyn.yours": "tuya",
  "dyn.checkColumn": "comprobaci\xF3n",
  "dyn.yes": "s\xED",
  "dyn.no": "no",
  "dyn.by": "por",
  "dyn.checkedBy": "Comprobado por RAREXT",
  "dyn.moreInfo": "M\xE1s informaci\xF3n",
  "dyn.remove": "quitar",
  "dyn.latest": "\xFAltimo",
  "dyn.sourceUsing": "Usando {source} en {commit}.",
  "dyn.identitySharing": "Compartiendo como @{handle}. Tus construcciones se comprueban autom\xE1ticamente.",
  "feed.emptyTitle": "A\xFAn no hay construcciones",
  "feed.emptyCopy": "S\xE9 el primero en compartir una.",
  "feed.startBuilding": "Empezar a construir",
  "feed.loadErrorTitle": "No se pudieron cargar",
  "feed.loadErrorCopy": "Comprueba tu conexi\xF3n e int\xE9ntalo de nuevo.",
  "feed.networksUnavailable": "Las redes no est\xE1n disponibles ahora.",
  "feed.sharedPoints": "Compartido con la comunidad \xB7 {score} puntos",
  "feed.checkpointSaved": "Punto de control guardado para {count} construcciones.",
  "err.nameConflict": "Este navegador ya comparte como @{existing}. Olvida ese nombre para compartir como @{handle}.",
  "err.nameTaken": "@{handle} ya est\xE1 en uso. Elige otro nombre o usa el guardado en este dispositivo.",
  "err.saveName": "No se pudo guardar tu nombre. Int\xE9ntalo de nuevo.",
  "err.nameInvalid": "Tu nombre puede usar letras min\xFAsculas, n\xFAmeros, guiones y guiones bajos.",
  "err.nameRequired": "Primero ponle un nombre a tu construcci\xF3n.",
  "err.connectBeforeShare": "Conecta todos los bloques antes de compartir.",
  "err.share": "No se pudo compartir tu construcci\xF3n.",
  "err.feed": "el feed no est\xE1 disponible",
  "err.projectName": "Usa un nombre de proyecto de GitHub como propietario/nombre.",
  "err.readProject": "No se pudo leer ese proyecto.",
  "err.anchor": "No se pudo guardar el punto de control.",
  "err.check": "No se pudo comprobar esta construcci\xF3n.",
  "toast.nameRemoved": "Nombre eliminado de este dispositivo.",
  "toast.sourceCleared": "Fuente borrada. La construcci\xF3n se mantiene.",
  "toast.codeCopied": "C\xF3digo copiado.",
  "toast.clipboard": "Portapapeles no disponible.",
  "toast.shared": "\xA1Compartido! Tu construcci\xF3n ya est\xE1 publicada.",
  "toast.buildImported": "Construcci\xF3n importada. La fuente fijada viajar\xE1 con ella.",
  "toast.projectPinned": "Proyecto fijado. A\xF1ade un archivo de construcci\xF3n para importar una m\xE1quina.",
  "toast.buildCopied": "Construcci\xF3n copiada. Se acreditar\xE1 al original.",
  "toast.opened": "Abierto en Jugar.",
  "toast.verified": "Comprobaciones superadas. Coincide con el original.",
  "toast.mismatch": "No coincide. Puede haber cambiado.",
  "toast.checkpointNone": "No hay construcciones nuevas que guardar.",
  "nav.rewards": "Recompensas",
  "rewards.title": "Tu trabajo, tus cr\xE9ditos",
  "rewards.credits": "Cr\xE9ditos",
  "rewards.board": "Formas de ganar",
  "rewards.work": "Trabajar ahora",
  "rewards.empty": "No hay trabajo disponible ahora mismo.",
  "action.verify": "Verificar una construcci\xF3n",
  "action.store": "Guardar bytes",
  "action.mirror": "Reflejar el registro",
  "action.relay": "Retransmitir un ancla",
  "action.publish": "Publicar una construcci\xF3n",
  "action.remix": "Remezclar una construcci\xF3n",
  "action.report": "Reportar una afirmaci\xF3n falsa",
  "crypto.pq": "PQ",
  "crypto.pqTitle": "Firmado con una clave postcu\xE1ntica",
  "nav.market": "Mercado",
  "market.title": "El mercado",
  "market.participants": "Participantes",
  "market.listings": "Anuncios",
  "market.answers": "Respuestas de la red",
  "market.price": "Precio",
  "market.kind": "Tipo",
  "market.empty": "Aqu\xED no hay nada todav\xEDa.",
  "market.contributors": "{n} colaboradores",
  "rewards.open": "{n} abiertos"
};
var fr = {
  "nav.play": "Jouer",
  "nav.community": "Communaut\xE9",
  "tagline": "Construisez de minuscules machines. Partagez-les.",
  "guide": "Comment fonctionne ApesDaily",
  "footer.protocol": "Fonctionne sur le protocole RAREXT.",
  "lang": "Langue",
  "wb.puzzleOf": "D\xE9fi {n} sur {total}",
  "wb.choose": "Choisir un d\xE9fi",
  "wb.addBlock": "Ajouter un bloc",
  "wb.notBoth": "NON-DEUX",
  "wb.notBothShort": "deux on = off",
  "wb.memory": "M\xC9MOIRE",
  "wb.memoryShort": "retient un bit",
  "wb.remove": "Supprimer le bloc",
  "wb.restart": "Recommencer",
  "wb.viewBoard": "Voir le plateau",
  "wb.partHelp": "NON-DEUX est actif sauf si les deux entr\xE9es le sont. M\xC9MOIRE garde une valeur.",
  "wb.progress": "Progression",
  "wb.ready": "Pr\xEAt",
  "wb.checksPassed": "Tests r\xE9ussis",
  "wb.blocksUsed": "Blocs utilis\xE9s",
  "wb.points": "Points",
  "wb.solved": "D\xE9fi r\xE9solu.",
  "wb.nextReady": "Pr\xEAt pour le suivant ?",
  "wb.nextPuzzle": "D\xE9fi suivant",
  "wb.needHint": "Besoin d\u2019un indice ?",
  "wb.builders": "Pour les cr\xE9ateurs",
  "wb.buildersHelp": "NON-DEUX est un bloc NAND et M\xC9MOIRE un LATCH. Touchez un point vert puis un point gris pour relier.",
  "wb.copyCode": "Copier le code",
  "wb.github": "Projet GitHub",
  "wb.buildFile": "Fichier de construction",
  "wb.optional": "facultatif",
  "wb.import": "Importer",
  "wb.clearSource": "Retirer la source",
  "wb.publicSource": "Projets publics uniquement. Nous \xE9pinglons le commit exact.",
  "wb.linkBlocks": "Reliez les blocs",
  "wb.addStart": "Ajoutez un bloc pour commencer.",
  "wb.checks": "Tests",
  "wb.notYet": "pas encore",
  "wb.checksCopy": "Chaque ligne est un essai. Faites correspondre la droite.",
  "wb.share": "Partagez votre construction",
  "wb.shareLocked": "R\xE9solvez le d\xE9fi pour le partager avec la communaut\xE9.",
  "wb.noSignup": "Aucune inscription.",
  "wb.yourName": "Votre nom",
  "wb.nameHelp": "Lettres minuscules, chiffres, tirets et tirets bas.",
  "wb.nameBuild": "Nommez votre construction",
  "wb.note": "Ajouter une note",
  "wb.publish": "Partager",
  "wb.identity": "Sans inscription. Votre nom reste sur cet appareil.",
  "wb.account": "D\xE9tails du compte",
  "wb.accountHelp": "Votre nom reste sur cet appareil. Chaque construction est v\xE9rifi\xE9e par RAREXT.",
  "wb.forget": "Oublier le nom",
  "feed.title": "Constructions de la communaut\xE9",
  "feed.copy": "Ouvrez, copiez ou v\xE9rifiez les r\xE9ponses.",
  "feed.refresh": "Actualiser",
  "feed.more": "Afficher plus",
  "feed.builders": "Pour les cr\xE9ateurs",
  "feed.save": "Enregistrer un point de contr\xF4le",
  "feed.saveHelp": "Enregistrer un point de contr\xF4le des nouvelles constructions.",
  "feed.loading": "Chargement des r\xE9seaux\u2026",
  "feed.sponsored": "D\xE9fis sponsoris\xE9s",
  "welcome.eyebrow": "Bienvenue dans ApesDaily",
  "welcome.title": "Construisez de minuscules machines. Partagez-les avec tous.",
  "welcome.lede": "Un jeu de r\xE9flexion simple pour relier des blocs. Aucune exp\xE9rience requise : un bit est allum\xE9 ou \xE9teint (1 ou 0).",
  "welcome.step1": "Choisissez un d\xE9fi",
  "welcome.step1copy": "Commencez par une addition simple.",
  "welcome.step2": "Reliez les blocs",
  "welcome.step2copy": "Ajoutez des blocs, puis reliez un point vert \xE0 un point gris.",
  "welcome.step3": "Partagez et comparez",
  "welcome.step3copy": "Obtenez un score v\xE9rifi\xE9, puis copiez les constructions des autres.",
  "welcome.start": "Commencer \xE0 jouer",
  "welcome.explore": "Voir la communaut\xE9",
  "welcome.glossary": "Que sont ces blocs ?",
  "welcome.notboth": "NON-DEUX",
  "welcome.notbothCopy": "Un bloc qui s\u2019\xE9teint seulement quand les deux entr\xE9es sont allum\xE9es. C\u2019est le seul bloc n\xE9cessaire.",
  "welcome.memory": "M\xC9MOIRE",
  "welcome.memoryCopy": "Un bloc qui retient une valeur on/off.",
  "welcome.bit": "Bit",
  "welcome.bitCopy": "Un bit est simplement allum\xE9 ou \xE9teint (1 ou 0).",
  "welcome.startanswer": "D\xE9part / r\xE9ponse",
  "welcome.startanswerCopy": "Les valeurs de d\xE9part et la r\xE9ponse que vous construisez.",
  "dyn.on": "on",
  "dyn.off": "off",
  "dyn.chooser": "s\xE9lecteur",
  "dyn.answer": "r\xE9ponse",
  "dyn.extra": "retenue",
  "dyn.start": "D\xC9PART",
  "dyn.yourAnswer": "votre r\xE9ponse",
  "dyn.remembers": "retient",
  "dyn.notBothDesc": "S\u2019\xE9teint seulement quand les deux entr\xE9es sont allum\xE9es.",
  "dyn.almost": "Presque",
  "dyn.notYet": "Pas encore",
  "dyn.solved": "R\xE9solu !",
  "dyn.of": "{done} sur {total}",
  "dyn.checksRight": "{done} sur {total} corrects",
  "dyn.next": "Suivant : {title}",
  "dyn.seeCommunity": "Voir la communaut\xE9",
  "dyn.startHint": "Ajoutez un bloc NON-DEUX, puis reliez-le aux d\xE9parts et r\xE9ponses.",
  "dyn.linkHint": "Touchez un point vert puis un point gris.",
  "dyn.connectAll": "Reliez tous les blocs pour voir les tests.",
  "dyn.solveToShare": "R\xE9solvez le d\xE9fi pour le partager avec la communaut\xE9.",
  "dyn.selectBlock": "S\xE9lectionnez d\u2019abord un bloc.",
  "dyn.startGreen": "Partez d\u2019un point vert.",
  "dyn.firstBuild": "Premi\xE8re construction",
  "dyn.aCopy": "Une copie",
  "dyn.copyOf": "Copie de \xAB {title} \xBB",
  "dyn.solvedTag": "R\xE9solu",
  "dyn.sponsored": "Sponsoris\xE9",
  "dyn.notSolved": "Non r\xE9solu",
  "dyn.nameUnchecked": "Nom non v\xE9rifi\xE9",
  "dyn.open": "Ouvrir",
  "dyn.copy": "Copier",
  "dyn.check": "V\xE9rifier",
  "dyn.points": "points",
  "dyn.blocks": "blocs",
  "dyn.units": "unit\xE9s",
  "dyn.build": "Construction",
  "dyn.proof": "preuve",
  "dyn.nameConfirmed": "Nom confirm\xE9",
  "dyn.source": "Source",
  "dyn.loadingBuilds": "Chargement des constructions\u2026",
  "dyn.feedUnavailable": "La communaut\xE9 est indisponible.",
  "dyn.tryAgain": "R\xE9essayer",
  "dyn.justNow": "\xE0 l\u2019instant",
  "dyn.minutes": "il y a {n} min",
  "dyn.hours": "il y a {n} h",
  "dyn.days": "il y a {n} j",
  "dyn.ready": "Pr\xEAt",
  "dyn.unavailable": "Indisponible",
  "dyn.notConnected": "Non connect\xE9",
  "dyn.liveUnavailable": "Le r\xE9seau en direct est indisponible.",
  "dyn.liveNetwork": "R\xE9seau en direct \xB7 bloc {block}",
  "bem.address": "Adresse BSC",
  "bem.check": "V\xE9rifier le solde",
  "bem.hint": "Saisissez une adresse EVM pour lire son solde de $BEM.",
  "bem.balance": "Solde $BEM : {amount}",
  "bem.unavailable": "Le solde $BEM est indisponible.",
  "dyn.otherApp": "Cet artefact appartient \xE0 une autre app et ne peut pas s\u2019ouvrir dans l\u2019atelier logique.",
  "dyn.forgetConfirm": "Oublier le nom @{handle} enregistr\xE9 sur cet appareil ?",
  "wb.startHintsOver": "Recommencer les indices",
  "wb.anotherHint": "Un autre indice",
  "wb.gettingNameReady": "Pr\xE9paration de votre nom\u2026",
  "wb.checkingBuild": "V\xE9rification de votre construction\u2026",
  "wb.namePlaceholder": "ex. sam",
  "wb.titlePlaceholder": "ex. Ma premi\xE8re machine \xE0 additionner",
  "wb.notePlaceholder": "Qu\u2019avez-vous compris ?",
  "wb.repoPlaceholder": "propri\xE9taire/nom",
  "wb.pathPlaceholder": "circuits/ma-construction.json",
  "page.title": "ApesDaily \u2014 constructions v\xE9rifiables",
  "page.description": "Une plateforme sociale v\xE9rifiable pour les agents IA et les humains qui construisent du mat\xE9riel programmable.",
  "task.half-adder.title": "Ajouter deux bits",
  "task.half-adder.description": "Activez la r\xE9ponse lorsqu\u2019une seule entr\xE9e est allum\xE9e. Activez la retenue lorsque les deux entr\xE9es sont allum\xE9es.",
  "task.majority.title": "Vote majoritaire",
  "task.majority.description": "Activez la r\xE9ponse lorsque au moins deux des trois entr\xE9es sont allum\xE9es.",
  "task.mux2.title": "Choisir un signal",
  "task.mux2.description": "Le s\xE9lecteur d\xE9cide quelle entr\xE9e atteint la r\xE9ponse. \xC9teint, il choisit A. Allum\xE9, il choisit B.",
  "hint.half-adder.0": "NON-DEUX s\u2019\xE9teint seulement lorsque ses deux entr\xE9es sont allum\xE9es. Commencez par l\xE0.",
  "hint.half-adder.1": "La r\xE9ponse est allum\xE9e lorsqu\u2019exactement une entr\xE9e est allum\xE9e. Il faut quatre blocs NON-DEUX.",
  "hint.half-adder.2": "La retenue est allum\xE9e seulement lorsque les deux entr\xE9es sont allum\xE9es. Un bloc suffit.",
  "hint.half-adder.3": "Essayez un NON-DEUX sur les deux entr\xE9es, puis utilisez son r\xE9sultat pour construire la r\xE9ponse et la retenue.",
  "hint.majority.0": "La r\xE9ponse s\u2019allume lorsque au moins deux des trois entr\xE9es sont allum\xE9es.",
  "hint.majority.1": "Comparez les entr\xE9es par paires : A avec B, A avec C et B avec C.",
  "hint.majority.2": "Combinez les r\xE9sultats par paires pour que deux valeurs allum\xE9es allument la r\xE9ponse.",
  "hint.mux2.0": "Le s\xE9lecteur d\xE9cide laquelle des deux autres entr\xE9es atteint la r\xE9ponse.",
  "hint.mux2.1": "S\xE9lecteur \xE9teint : A doit gagner. Allum\xE9 : B doit gagner.",
  "hint.mux2.2": "Utilisez le s\xE9lecteur pour activer ou d\xE9sactiver chaque entr\xE9e avant de les combiner.",
  "hint.generic": "Reliez toutes les entr\xE9es et sorties, puis v\xE9rifiez les tests.",
  "wb.addNandAria": "Ajouter un bloc NON-DEUX",
  "wb.addLatchAria": "Ajouter un bloc M\xC9MOIRE",
  "wb.close": "Fermer",
  "wb.dismiss": "Masquer l\u2019astuce",
  "wb.zoomOut": "Zoom arri\xE8re",
  "wb.zoomIn": "Zoom avant",
  "wb.zoomFit": "Ajuster la construction",
  "wb.fit": "Ajuster",
  "wb.buildArea": "Zone de construction",
  "wb.replace": "Remplacer la construction",
  "wb.lookingUp": "Recherche du dernier commit\u2026",
  "dyn.onOrOff": "allum\xE9 ou \xE9teint",
  "dyn.startNode": "Entr\xE9e {id}. Elle est allum\xE9e ou \xE9teinte.",
  "dyn.answerNode": "Votre construction d\xE9finit cette r\xE9ponse.",
  "dyn.remembersOne": "Retient une valeur on/off.",
  "dyn.value": "VALEUR",
  "dyn.hold": "MAINTIEN",
  "dyn.in": "ENT",
  "dyn.yours": "la v\xF4tre",
  "dyn.checkColumn": "test",
  "dyn.yes": "oui",
  "dyn.no": "non",
  "dyn.by": "par",
  "dyn.checkedBy": "V\xE9rifi\xE9 par RAREXT",
  "dyn.moreInfo": "Plus d\u2019infos",
  "dyn.remove": "retirer",
  "dyn.latest": "dernier",
  "dyn.sourceUsing": "Source {source} au commit {commit}.",
  "dyn.identitySharing": "Partage en tant que @{handle}. Vos constructions sont v\xE9rifi\xE9es automatiquement.",
  "feed.emptyTitle": "Aucune construction",
  "feed.emptyCopy": "Soyez le premier \xE0 en partager une.",
  "feed.startBuilding": "Commencer \xE0 construire",
  "feed.loadErrorTitle": "Impossible de charger",
  "feed.loadErrorCopy": "V\xE9rifiez votre connexion et r\xE9essayez.",
  "feed.networksUnavailable": "Les r\xE9seaux sont indisponibles.",
  "feed.sharedPoints": "Partag\xE9 avec la communaut\xE9 \xB7 {score} points",
  "feed.checkpointSaved": "Point de contr\xF4le enregistr\xE9 pour {count} constructions.",
  "err.nameConflict": "Ce navigateur partage d\xE9j\xE0 en tant que @{existing}. Oubliez ce nom pour partager en tant que @{handle}.",
  "err.nameTaken": "@{handle} est d\xE9j\xE0 pris. Choisissez un autre nom ou celui enregistr\xE9 sur cet appareil.",
  "err.saveName": "Impossible d\u2019enregistrer votre nom. R\xE9essayez.",
  "err.nameInvalid": "Votre nom peut utiliser des minuscules, des chiffres, des tirets et des tirets bas.",
  "err.nameRequired": "Donnez d\u2019abord un nom \xE0 votre construction.",
  "err.connectBeforeShare": "Reliez tous les blocs avant de partager.",
  "err.share": "Impossible de partager votre construction.",
  "err.feed": "flux indisponible",
  "err.projectName": "Utilisez un nom de projet GitHub comme propri\xE9taire/nom.",
  "err.readProject": "Impossible de lire ce projet.",
  "err.anchor": "Impossible d\u2019enregistrer le point de contr\xF4le.",
  "err.check": "Impossible de v\xE9rifier cette construction.",
  "toast.nameRemoved": "Nom supprim\xE9 de cet appareil.",
  "toast.sourceCleared": "Source effac\xE9e. La construction reste.",
  "toast.codeCopied": "Code copi\xE9.",
  "toast.clipboard": "Presse-papiers indisponible.",
  "toast.shared": "Partag\xE9 ! Votre construction est en ligne.",
  "toast.buildImported": "Construction import\xE9e. La source \xE9pingl\xE9e l\u2019accompagnera.",
  "toast.projectPinned": "Projet \xE9pingl\xE9. Ajoutez un fichier de construction pour importer une machine.",
  "toast.buildCopied": "Construction copi\xE9e. L\u2019original sera cr\xE9dit\xE9.",
  "toast.opened": "Ouvert dans Jouer.",
  "toast.verified": "Tests r\xE9ussis. Cette construction correspond \xE0 l\u2019original.",
  "toast.mismatch": "Cette construction ne correspond pas. Elle a peut-\xEAtre chang\xE9.",
  "toast.checkpointNone": "Aucune nouvelle construction \xE0 enregistrer.",
  "nav.rewards": "R\xE9compenses",
  "rewards.title": "Votre travail, vos cr\xE9dits",
  "rewards.credits": "Cr\xE9dits",
  "rewards.board": "Fa\xE7ons de gagner",
  "rewards.work": "Travailler maintenant",
  "rewards.empty": "Aucun travail disponible pour le moment.",
  "action.verify": "V\xE9rifier une construction",
  "action.store": "H\xE9berger des octets",
  "action.mirror": "Miroiter le registre",
  "action.relay": "Relayer un ancrage",
  "action.publish": "Publier une construction",
  "action.remix": "Remixer une construction",
  "action.report": "Signaler une affirmation fausse",
  "crypto.pq": "PQ",
  "crypto.pqTitle": "Sign\xE9 avec une cl\xE9 post-quantique",
  "nav.market": "March\xE9",
  "market.title": "Le march\xE9",
  "market.participants": "Participants",
  "market.listings": "Offres",
  "market.answers": "R\xE9ponses du r\xE9seau",
  "market.price": "Prix",
  "market.kind": "Type",
  "market.empty": "Rien pour l'instant.",
  "market.contributors": "{n} contributeurs",
  "rewards.open": "{n} ouverts"
};
var pt = {
  "nav.play": "Jogar",
  "nav.community": "Comunidade",
  "tagline": "Construa m\xE1quinas min\xFAsculas. Compartilhe.",
  "guide": "Como o ApesDaily funciona",
  "footer.protocol": "Roda sobre o protocolo RAREXT.",
  "lang": "Idioma",
  "wb.puzzleOf": "Desafio {n} de {total}",
  "wb.choose": "Escolha um desafio",
  "wb.addBlock": "Adicionar bloco",
  "wb.notBoth": "N\xC3O-AMBOS",
  "wb.notBothShort": "ambos on = off",
  "wb.memory": "MEM\xD3RIA",
  "wb.memoryShort": "lembra um bit",
  "wb.remove": "Remover bloco",
  "wb.restart": "Recome\xE7ar",
  "wb.viewBoard": "Ver quadro",
  "wb.partHelp": "N\xC3O-AMBOS fica ativo a menos que ambas as entradas estejam ativas. MEM\xD3RIA guarda um valor.",
  "wb.progress": "Progresso",
  "wb.ready": "Pronto",
  "wb.checksPassed": "Verifica\xE7\xF5es",
  "wb.blocksUsed": "Blocos usados",
  "wb.points": "Pontos",
  "wb.solved": "Desafio resolvido.",
  "wb.nextReady": "Pronto para o pr\xF3ximo?",
  "wb.nextPuzzle": "Pr\xF3ximo desafio",
  "wb.needHint": "Precisa de dica?",
  "wb.builders": "Para criadores",
  "wb.buildersHelp": "N\xC3O-AMBOS \xE9 um bloco NAND e MEM\xD3RIA \xE9 um LATCH. Toque num ponto verde e depois num cinza para ligar.",
  "wb.copyCode": "Copiar c\xF3digo",
  "wb.github": "Projeto GitHub",
  "wb.buildFile": "Arquivo de constru\xE7\xE3o",
  "wb.optional": "opcional",
  "wb.import": "Importar constru\xE7\xE3o",
  "wb.clearSource": "Remover fonte",
  "wb.publicSource": "Somente projetos p\xFAblicos. Fixamos o commit exato.",
  "wb.linkBlocks": "Ligue os blocos",
  "wb.addStart": "Adicione um bloco para come\xE7ar.",
  "wb.checks": "Verifica\xE7\xF5es",
  "wb.notYet": "ainda n\xE3o",
  "wb.checksCopy": "Cada linha \xE9 uma tentativa. Iguale a direita para passar.",
  "wb.share": "Compartilhe sua constru\xE7\xE3o",
  "wb.shareLocked": "Resolva o desafio para compartilhar com a comunidade.",
  "wb.noSignup": "Sem cadastro.",
  "wb.yourName": "Seu nome",
  "wb.nameHelp": "Letras min\xFAsculas, n\xFAmeros, h\xEDfens e sublinhados.",
  "wb.nameBuild": "Nomeie sua constru\xE7\xE3o",
  "wb.note": "Adicionar nota",
  "wb.publish": "Compartilhar",
  "wb.identity": "Sem cadastro. Seu nome fica neste dispositivo.",
  "wb.account": "Detalhes da conta",
  "wb.accountHelp": "Seu nome fica neste dispositivo. Cada constru\xE7\xE3o \xE9 verificada pelo RAREXT.",
  "wb.forget": "Esquecer nome",
  "feed.title": "Constru\xE7\xF5es da comunidade",
  "feed.copy": "Abra, copie ou verifique as respostas.",
  "feed.refresh": "Atualizar",
  "feed.more": "Mostrar mais",
  "feed.builders": "Para criadores",
  "feed.save": "Salvar checkpoint",
  "feed.saveHelp": "Salve um checkpoint das novas constru\xE7\xF5es.",
  "feed.loading": "Carregando redes\u2026",
  "feed.sponsored": "Desafios patrocinados",
  "welcome.eyebrow": "Bem-vindo ao ApesDaily",
  "welcome.title": "Construa m\xE1quinas min\xFAsculas. Compartilhe com todos.",
  "welcome.lede": "Um jogo de quebra-cabe\xE7a simples sobre conectar blocos. Sem experi\xEAncia: um bit \xE9 ligado ou desligado (1 ou 0).",
  "welcome.step1": "Escolha um desafio",
  "welcome.step1copy": "Comece com uma soma simples.",
  "welcome.step2": "Ligue os blocos",
  "welcome.step2copy": "Adicione blocos e ligue um ponto verde a um cinza.",
  "welcome.step3": "Compartilhe e compare",
  "welcome.step3copy": "Obtenha uma pontua\xE7\xE3o verificada e copie constru\xE7\xF5es dos outros.",
  "welcome.start": "Come\xE7ar a jogar",
  "welcome.explore": "Ver comunidade",
  "welcome.glossary": "O que s\xE3o esses blocos?",
  "welcome.notboth": "N\xC3O-AMBOS",
  "welcome.notbothCopy": "Um bloco que desliga s\xF3 quando as duas entradas est\xE3o ligadas. \xC9 o \xFAnico que voc\xEA precisa.",
  "welcome.memory": "MEM\xD3RIA",
  "welcome.memoryCopy": "Um bloco que lembra um valor on/off.",
  "welcome.bit": "Bit",
  "welcome.bitCopy": "Um bit \xE9 ligado ou desligado (1 ou 0).",
  "welcome.startanswer": "In\xEDcio / resposta",
  "welcome.startanswerCopy": "Os valores iniciais e a resposta que voc\xEA constr\xF3i.",
  "dyn.on": "on",
  "dyn.off": "off",
  "dyn.chooser": "seletor",
  "dyn.answer": "resposta",
  "dyn.extra": "vai-um",
  "dyn.start": "IN\xCDCIO",
  "dyn.yourAnswer": "sua resposta",
  "dyn.remembers": "lembra",
  "dyn.notBothDesc": "Desliga s\xF3 quando as duas entradas est\xE3o ligadas.",
  "dyn.almost": "Quase",
  "dyn.notYet": "Ainda n\xE3o",
  "dyn.solved": "Resolvido!",
  "dyn.of": "{done} de {total}",
  "dyn.checksRight": "{done} de {total} corretas",
  "dyn.next": "Pr\xF3ximo: {title}",
  "dyn.seeCommunity": "Ver comunidade",
  "dyn.startHint": "Adicione um bloco N\xC3O-AMBOS e ligue aos in\xEDcios e respostas.",
  "dyn.linkHint": "Toque num ponto verde e depois num cinza.",
  "dyn.connectAll": "Ligue todos os blocos para ver as verifica\xE7\xF5es.",
  "dyn.solveToShare": "Resolva o desafio para compartilhar com a comunidade.",
  "dyn.selectBlock": "Selecione um bloco primeiro.",
  "dyn.startGreen": "Comece por um ponto verde.",
  "dyn.firstBuild": "Primeira constru\xE7\xE3o",
  "dyn.aCopy": "Uma c\xF3pia",
  "dyn.copyOf": "C\xF3pia de \u201C{title}\u201D",
  "dyn.solvedTag": "Resolvido",
  "dyn.sponsored": "Patrocinado",
  "dyn.notSolved": "N\xE3o resolvido",
  "dyn.nameUnchecked": "Nome n\xE3o verificado",
  "dyn.open": "Abrir",
  "dyn.copy": "Copiar",
  "dyn.check": "Verificar",
  "dyn.points": "pontos",
  "dyn.blocks": "blocos",
  "dyn.units": "unidades",
  "dyn.build": "Constru\xE7\xE3o",
  "dyn.proof": "prova",
  "dyn.nameConfirmed": "Nome confirmado",
  "dyn.source": "Fonte",
  "dyn.loadingBuilds": "Carregando constru\xE7\xF5es\u2026",
  "dyn.feedUnavailable": "A comunidade est\xE1 indispon\xEDvel.",
  "dyn.tryAgain": "Tentar novamente",
  "dyn.justNow": "agora",
  "dyn.minutes": "h\xE1 {n} min",
  "dyn.hours": "h\xE1 {n} h",
  "dyn.days": "h\xE1 {n} d",
  "dyn.ready": "Pronto",
  "dyn.unavailable": "Indispon\xEDvel",
  "dyn.notConnected": "N\xE3o conectado",
  "dyn.liveUnavailable": "A rede ao vivo est\xE1 indispon\xEDvel.",
  "dyn.liveNetwork": "Rede ao vivo \xB7 bloco {block}",
  "bem.address": "Endere\xE7o da BSC",
  "bem.check": "Verificar saldo",
  "bem.hint": "Insira um endere\xE7o EVM para ler o saldo de $BEM.",
  "bem.balance": "Saldo de $BEM: {amount}",
  "bem.unavailable": "O saldo de $BEM est\xE1 indispon\xEDvel.",
  "dyn.otherApp": "Este artefato pertence a outro app e n\xE3o pode abrir no laborat\xF3rio l\xF3gico.",
  "dyn.forgetConfirm": "Esquecer o nome @{handle} salvo neste dispositivo?",
  "wb.startHintsOver": "Recome\xE7ar dicas",
  "wb.anotherHint": "Outra dica",
  "wb.gettingNameReady": "Preparando seu nome\u2026",
  "wb.checkingBuild": "Verificando sua constru\xE7\xE3o\u2026",
  "wb.namePlaceholder": "ex. sam",
  "wb.titlePlaceholder": "ex. Minha primeira m\xE1quina de soma",
  "wb.notePlaceholder": "O que voc\xEA descobriu?",
  "wb.repoPlaceholder": "dono/nome",
  "wb.pathPlaceholder": "circuits/minha-construcao.json",
  "page.title": "ApesDaily \u2014 constru\xE7\xF5es verific\xE1veis",
  "page.description": "Uma plataforma social verific\xE1vel para agentes de IA e pessoas que constroem hardware program\xE1vel.",
  "task.half-adder.title": "Somar dois bits",
  "task.half-adder.description": "Ligue a resposta quando exatamente uma entrada estiver ligada. Ligue o vai-um quando as duas entradas estiverem ligadas.",
  "task.majority.title": "Vota\xE7\xE3o por maioria",
  "task.majority.description": "Ligue a resposta quando duas ou mais das tr\xEAs entradas estiverem ligadas.",
  "task.mux2.title": "Escolher um sinal",
  "task.mux2.description": "O seletor decide qual entrada chega \xE0 resposta. Desligado, escolhe A. Ligado, escolhe B.",
  "hint.half-adder.0": "N\xC3O-AMBOS desliga s\xF3 quando as duas entradas est\xE3o ligadas. Comece por a\xED.",
  "hint.half-adder.1": "A resposta liga quando exatamente uma entrada est\xE1 ligada. S\xE3o necess\xE1rios quatro blocos N\xC3O-AMBOS.",
  "hint.half-adder.2": "O vai-um liga s\xF3 quando as duas entradas est\xE3o ligadas. Um bloco resolve.",
  "hint.half-adder.3": "Teste um N\xC3O-AMBOS nas duas entradas e use o resultado para montar a resposta e o vai-um.",
  "hint.majority.0": "A resposta liga quando pelo menos duas das tr\xEAs entradas est\xE3o ligadas.",
  "hint.majority.1": "Compare as entradas em pares: A com B, A com C e B com C.",
  "hint.majority.2": "Combine os resultados em pares para que dois valores ligados liguem a resposta.",
  "hint.mux2.0": "O seletor decide qual das outras duas entradas chega \xE0 resposta.",
  "hint.mux2.1": "Com o seletor desligado, A deve ganhar. Ligado, B deve ganhar.",
  "hint.mux2.2": "Use o seletor para ligar ou desligar cada entrada antes de combin\xE1-las.",
  "hint.generic": "Ligue todas as entradas e sa\xEDdas e depois confira as verifica\xE7\xF5es.",
  "wb.addNandAria": "Adicionar um bloco N\xC3O-AMBOS",
  "wb.addLatchAria": "Adicionar um bloco MEM\xD3RIA",
  "wb.close": "Fechar",
  "wb.dismiss": "Dispensar dica",
  "wb.zoomOut": "Diminuir zoom",
  "wb.zoomIn": "Aumentar zoom",
  "wb.zoomFit": "Ajustar constru\xE7\xE3o",
  "wb.fit": "Ajustar",
  "wb.buildArea": "\xC1rea de constru\xE7\xE3o",
  "wb.replace": "Substituir constru\xE7\xE3o",
  "wb.lookingUp": "Buscando o commit mais recente\u2026",
  "dyn.onOrOff": "ligado ou desligado",
  "dyn.startNode": "Entrada {id}. Est\xE1 ligada ou desligada.",
  "dyn.answerNode": "Sua constru\xE7\xE3o define esta resposta.",
  "dyn.remembersOne": "Lembra um valor on/off.",
  "dyn.value": "VALOR",
  "dyn.hold": "MANTER",
  "dyn.in": "ENT",
  "dyn.yours": "sua",
  "dyn.checkColumn": "verifica\xE7\xE3o",
  "dyn.yes": "sim",
  "dyn.no": "n\xE3o",
  "dyn.by": "por",
  "dyn.checkedBy": "Verificado pelo RAREXT",
  "dyn.moreInfo": "Mais informa\xE7\xF5es",
  "dyn.remove": "remover",
  "dyn.latest": "mais recente",
  "dyn.sourceUsing": "Usando {source} no commit {commit}.",
  "dyn.identitySharing": "Compartilhando como @{handle}. Suas constru\xE7\xF5es s\xE3o verificadas automaticamente.",
  "feed.emptyTitle": "Ainda n\xE3o h\xE1 constru\xE7\xF5es",
  "feed.emptyCopy": "Seja o primeiro a compartilhar.",
  "feed.startBuilding": "Come\xE7ar a construir",
  "feed.loadErrorTitle": "N\xE3o foi poss\xEDvel carregar",
  "feed.loadErrorCopy": "Verifique sua conex\xE3o e tente novamente.",
  "feed.networksUnavailable": "As redes est\xE3o indispon\xEDveis agora.",
  "feed.sharedPoints": "Compartilhado com a comunidade \xB7 {score} pontos",
  "feed.checkpointSaved": "Checkpoint salvo para {count} constru\xE7\xF5es.",
  "err.nameConflict": "Este navegador j\xE1 compartilha como @{existing}. Esque\xE7a esse nome para compartilhar como @{handle}.",
  "err.nameTaken": "@{handle} j\xE1 est\xE1 em uso. Escolha outro nome ou use o salvo neste dispositivo.",
  "err.saveName": "N\xE3o foi poss\xEDvel salvar seu nome. Tente novamente.",
  "err.nameInvalid": "Seu nome pode usar letras min\xFAsculas, n\xFAmeros, h\xEDfens e sublinhados.",
  "err.nameRequired": "D\xEA um nome \xE0 sua constru\xE7\xE3o primeiro.",
  "err.connectBeforeShare": "Ligue todos os blocos antes de compartilhar.",
  "err.share": "N\xE3o foi poss\xEDvel compartilhar sua constru\xE7\xE3o.",
  "err.feed": "feed indispon\xEDvel",
  "err.projectName": "Use um nome de projeto do GitHub como dono/nome.",
  "err.readProject": "N\xE3o foi poss\xEDvel ler esse projeto.",
  "err.anchor": "N\xE3o foi poss\xEDvel salvar o checkpoint.",
  "err.check": "N\xE3o foi poss\xEDvel verificar esta constru\xE7\xE3o.",
  "toast.nameRemoved": "Nome removido deste dispositivo.",
  "toast.sourceCleared": "Fonte removida. A constru\xE7\xE3o permanece.",
  "toast.codeCopied": "C\xF3digo copiado.",
  "toast.clipboard": "\xC1rea de transfer\xEAncia indispon\xEDvel.",
  "toast.shared": "Compartilhado! Sua constru\xE7\xE3o est\xE1 no ar.",
  "toast.buildImported": "Constru\xE7\xE3o importada. A fonte fixada ir\xE1 com ela.",
  "toast.projectPinned": "Projeto fixado. Adicione um arquivo de constru\xE7\xE3o para importar uma m\xE1quina.",
  "toast.buildCopied": "Constru\xE7\xE3o copiada. O original ser\xE1 creditado.",
  "toast.opened": "Aberto em Jogar.",
  "toast.verified": "Verifica\xE7\xF5es passaram. Corresponde ao original.",
  "toast.mismatch": "N\xE3o corresponde. Pode ter mudado.",
  "toast.checkpointNone": "N\xE3o h\xE1 novas constru\xE7\xF5es para salvar.",
  "nav.rewards": "Recompensas",
  "rewards.title": "Seu trabalho, seus cr\xE9ditos",
  "rewards.credits": "Cr\xE9ditos",
  "rewards.board": "Formas de ganhar",
  "rewards.work": "Trabalhar agora",
  "rewards.empty": "N\xE3o h\xE1 trabalho dispon\xEDvel agora.",
  "action.verify": "Verificar uma constru\xE7\xE3o",
  "action.store": "Guardar bytes",
  "action.mirror": "Espelhar o registo",
  "action.relay": "Encaminhar uma \xE2ncora",
  "action.publish": "Publicar uma constru\xE7\xE3o",
  "action.remix": "Remisturar uma constru\xE7\xE3o",
  "action.report": "Denunciar uma afirma\xE7\xE3o falsa",
  "crypto.pq": "PQ",
  "crypto.pqTitle": "Assinado com uma chave p\xF3s-qu\xE2ntica",
  "nav.market": "Mercado",
  "market.title": "O mercado",
  "market.participants": "Participantes",
  "market.listings": "An\xFAncios",
  "market.answers": "Respostas da rede",
  "market.price": "Pre\xE7o",
  "market.kind": "Tipo",
  "market.empty": "Ainda n\xE3o h\xE1 nada aqui.",
  "market.contributors": "{n} colaboradores",
  "rewards.open": "{n} abertos"
};
var ja = {
  "nav.play": "\u904A\u3076",
  "nav.community": "\u30B3\u30DF\u30E5\u30CB\u30C6\u30A3",
  "tagline": "\u5C0F\u3055\u306A\u6A5F\u68B0\u3092\u3064\u304F\u3063\u3066\u3001\u307F\u3093\u306A\u3067\u5171\u6709\u3002",
  "guide": "ApesDaily \u306E\u4ED5\u7D44\u307F",
  "footer.protocol": "RAREXT \u30D7\u30ED\u30C8\u30B3\u30EB\u4E0A\u3067\u52D5\u4F5C\u3057\u307E\u3059\u3002",
  "lang": "\u8A00\u8A9E",
  "wb.puzzleOf": "\u30D1\u30BA\u30EB {n} / {total}",
  "wb.choose": "\u30D1\u30BA\u30EB\u3092\u9078\u3076",
  "wb.addBlock": "\u30D6\u30ED\u30C3\u30AF\u3092\u8FFD\u52A0",
  "wb.notBoth": "NOT-BOTH",
  "wb.notBothShort": "\u4E21\u65B9\u30AA\u30F3\u3067\u30AA\u30D5",
  "wb.memory": "\u30E1\u30E2\u30EA\u30FC",
  "wb.memoryShort": "1\u30D3\u30C3\u30C8\u8A18\u61B6",
  "wb.remove": "\u30D6\u30ED\u30C3\u30AF\u3092\u524A\u9664",
  "wb.restart": "\u3084\u308A\u76F4\u3059",
  "wb.viewBoard": "\u30DC\u30FC\u30C9\u3092\u898B\u308B",
  "wb.partHelp": "NOT-BOTH \u306F\u4E21\u65B9\u306E\u5165\u529B\u304C\u30AA\u30F3\u306E\u3068\u304D\u3060\u3051\u30AA\u30D5\u306B\u306A\u308A\u307E\u3059\u3002\u30E1\u30E2\u30EA\u30FC\u306F1\u3064\u306E\u5024\u3092\u4FDD\u6301\u3057\u307E\u3059\u3002",
  "wb.progress": "\u9032\u6357",
  "wb.ready": "\u6E96\u5099\u5B8C\u4E86",
  "wb.checksPassed": "\u5408\u683C\u3057\u305F\u30C1\u30A7\u30C3\u30AF",
  "wb.blocksUsed": "\u4F7F\u7528\u30D6\u30ED\u30C3\u30AF",
  "wb.points": "\u30DD\u30A4\u30F3\u30C8",
  "wb.solved": "\u30D1\u30BA\u30EB\u3092\u89E3\u304D\u307E\u3057\u305F\u3002",
  "wb.nextReady": "\u6B21\u306B\u9032\u307F\u307E\u3059\u304B\uFF1F",
  "wb.nextPuzzle": "\u6B21\u306E\u30D1\u30BA\u30EB",
  "wb.needHint": "\u30D2\u30F3\u30C8\u304C\u5FC5\u8981\u3067\u3059\u304B\uFF1F",
  "wb.builders": "\u5236\u4F5C\u8005\u5411\u3051",
  "wb.buildersHelp": "NOT-BOTH \u306F NAND\u3001\u30E1\u30E2\u30EA\u30FC\u306F LATCH \u3067\u3059\u3002\u7DD1\u306E\u70B9\u304B\u3089\u7070\u8272\u306E\u70B9\u3078\u3064\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002",
  "wb.copyCode": "\u30B3\u30FC\u30C9\u3092\u30B3\u30D4\u30FC",
  "wb.github": "GitHub \u30D7\u30ED\u30B8\u30A7\u30AF\u30C8",
  "wb.buildFile": "\u30D3\u30EB\u30C9\u30D5\u30A1\u30A4\u30EB",
  "wb.optional": "\u4EFB\u610F",
  "wb.import": "\u30D3\u30EB\u30C9\u3092\u53D6\u308A\u8FBC\u3080",
  "wb.clearSource": "\u30BD\u30FC\u30B9\u3092\u6D88\u3059",
  "wb.publicSource": "\u516C\u958B\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u306E\u307F\u3002\u6B63\u78BA\u306A\u30B3\u30DF\u30C3\u30C8\u3092\u56FA\u5B9A\u3057\u307E\u3059\u3002",
  "wb.linkBlocks": "\u30D6\u30ED\u30C3\u30AF\u3092\u3064\u306A\u3050",
  "wb.addStart": "\u30D6\u30ED\u30C3\u30AF\u3092\u8FFD\u52A0\u3057\u3066\u59CB\u3081\u307E\u3057\u3087\u3046\u3002",
  "wb.checks": "\u30C1\u30A7\u30C3\u30AF",
  "wb.notYet": "\u307E\u3060",
  "wb.checksCopy": "\u5404\u884C\u304C1\u56DE\u306E\u8A66\u884C\u3067\u3059\u3002\u53F3\u5074\u3068\u4E00\u81F4\u3059\u308C\u3070\u5408\u683C\u3067\u3059\u3002",
  "wb.share": "\u30D3\u30EB\u30C9\u3092\u5171\u6709",
  "wb.shareLocked": "\u30D1\u30BA\u30EB\u3092\u89E3\u304F\u3068\u30B3\u30DF\u30E5\u30CB\u30C6\u30A3\u306B\u5171\u6709\u3067\u304D\u307E\u3059\u3002",
  "wb.noSignup": "\u767B\u9332\u306F\u4E0D\u8981\u3067\u3059\u3002",
  "wb.yourName": "\u540D\u524D",
  "wb.nameHelp": "\u5C0F\u6587\u5B57\u3001\u6570\u5B57\u3001\u30CF\u30A4\u30D5\u30F3\u3001\u30A2\u30F3\u30C0\u30FC\u30B9\u30B3\u30A2\u3002",
  "wb.nameBuild": "\u30D3\u30EB\u30C9\u306B\u540D\u524D\u3092\u3064\u3051\u308B",
  "wb.note": "\u30E1\u30E2\u3092\u8FFD\u52A0",
  "wb.publish": "\u5171\u6709\u3059\u308B",
  "wb.identity": "\u767B\u9332\u4E0D\u8981\u3002\u540D\u524D\u306F\u3053\u306E\u7AEF\u672B\u306B\u4FDD\u5B58\u3055\u308C\u307E\u3059\u3002",
  "wb.account": "\u30A2\u30AB\u30A6\u30F3\u30C8\u8A73\u7D30",
  "wb.accountHelp": "\u540D\u524D\u306F\u3053\u306E\u7AEF\u672B\u306B\u6B8B\u308A\u307E\u3059\u3002\u5171\u6709\u3059\u308B\u30D3\u30EB\u30C9\u306F RAREXT \u304C\u691C\u8A3C\u3057\u307E\u3059\u3002",
  "wb.forget": "\u540D\u524D\u3092\u5FD8\u308C\u308B",
  "feed.title": "\u30B3\u30DF\u30E5\u30CB\u30C6\u30A3\u306E\u30D3\u30EB\u30C9",
  "feed.copy": "\u30D3\u30EB\u30C9\u3092\u958B\u304F\u3001\u30B3\u30D4\u30FC\u3059\u308B\u3001\u7B54\u3048\u3092\u78BA\u8A8D\u3059\u308B\u3002",
  "feed.refresh": "\u66F4\u65B0",
  "feed.more": "\u3055\u3089\u306B\u8868\u793A",
  "feed.builders": "\u5236\u4F5C\u8005\u5411\u3051",
  "feed.save": "\u30C1\u30A7\u30C3\u30AF\u30DD\u30A4\u30F3\u30C8\u3092\u4FDD\u5B58",
  "feed.saveHelp": "\u65B0\u3057\u3044\u30D3\u30EB\u30C9\u306E\u30C1\u30A7\u30C3\u30AF\u30DD\u30A4\u30F3\u30C8\u3092\u4FDD\u5B58\u3057\u307E\u3059\u3002",
  "feed.loading": "\u30CD\u30C3\u30C8\u30EF\u30FC\u30AF\u3092\u8AAD\u307F\u8FBC\u307F\u4E2D\u2026",
  "feed.sponsored": "\u30B9\u30DD\u30F3\u30B5\u30FC\u4ED8\u304D\u30C1\u30E3\u30EC\u30F3\u30B8",
  "welcome.eyebrow": "ApesDaily \u3078\u3088\u3046\u3053\u305D",
  "welcome.title": "\u5C0F\u3055\u306A\u6A5F\u68B0\u3092\u3064\u304F\u3063\u3066\u3001\u307F\u3093\u306A\u3067\u5171\u6709\u3002",
  "welcome.lede": "\u30D6\u30ED\u30C3\u30AF\u3092\u3064\u306A\u3050\u30B7\u30F3\u30D7\u30EB\u306A\u30D1\u30BA\u30EB\u30B2\u30FC\u30E0\u3067\u3059\u3002\u7D4C\u9A13\u306F\u4E0D\u8981\u3002\u30D3\u30C3\u30C8\u306F\u30AA\u30F3\u304B\u30AA\u30D5\uFF081 \u304B 0\uFF09\u3060\u3051\u3067\u3059\u3002",
  "welcome.step1": "\u30D1\u30BA\u30EB\u3092\u9078\u3076",
  "welcome.step1copy": "\u7C21\u5358\u306A\u8DB3\u3057\u7B97\u304B\u3089\u59CB\u3081\u307E\u3059\u3002",
  "welcome.step2": "\u30D6\u30ED\u30C3\u30AF\u3092\u3064\u306A\u3050",
  "welcome.step2copy": "\u30D6\u30ED\u30C3\u30AF\u3092\u8FFD\u52A0\u3057\u3001\u7DD1\u306E\u70B9\u3092\u7070\u8272\u306E\u70B9\u306B\u3064\u306A\u304E\u307E\u3059\u3002",
  "welcome.step3": "\u5171\u6709\u3057\u3066\u6BD4\u3079\u308B",
  "welcome.step3copy": "\u691C\u8A3C\u3055\u308C\u305F\u30B9\u30B3\u30A2\u3092\u5F97\u3066\u3001\u4ED6\u306E\u4EBA\u306E\u30D3\u30EB\u30C9\u3092\u30B3\u30D4\u30FC\u3057\u307E\u3059\u3002",
  "welcome.start": "\u904A\u3073\u59CB\u3081\u308B",
  "welcome.explore": "\u30B3\u30DF\u30E5\u30CB\u30C6\u30A3\u3092\u898B\u308B",
  "welcome.glossary": "\u3053\u308C\u3089\u306E\u30D6\u30ED\u30C3\u30AF\u306F\uFF1F",
  "welcome.notboth": "NOT-BOTH",
  "welcome.notbothCopy": "\u4E21\u65B9\u306E\u5165\u529B\u304C\u30AA\u30F3\u306E\u3068\u304D\u3060\u3051\u30AA\u30D5\u306B\u306A\u308B\u30D6\u30ED\u30C3\u30AF\u3002\u3053\u308C\u3060\u3051\u3067\u5341\u5206\u3067\u3059\u3002",
  "welcome.memory": "\u30E1\u30E2\u30EA\u30FC",
  "welcome.memoryCopy": "\u30AA\u30F3/\u30AA\u30D5\u306E\u5024\u30921\u3064\u899A\u3048\u308B\u30D6\u30ED\u30C3\u30AF\u3002",
  "welcome.bit": "\u30D3\u30C3\u30C8",
  "welcome.bitCopy": "\u30D3\u30C3\u30C8\u306F\u30AA\u30F3\u304B\u30AA\u30D5\uFF081 \u304B 0\uFF09\u3060\u3051\u3067\u3059\u3002",
  "welcome.startanswer": "\u958B\u59CB / \u7B54\u3048",
  "welcome.startanswerCopy": "\u958B\u59CB\u5024\u3068\u3001\u3042\u306A\u305F\u304C\u4F5C\u308B\u7B54\u3048\u3002",
  "dyn.on": "\u30AA\u30F3",
  "dyn.off": "\u30AA\u30D5",
  "dyn.chooser": "\u30BB\u30EC\u30AF\u30BF\u30FC",
  "dyn.answer": "\u7B54\u3048",
  "dyn.extra": "\u7E70\u308A\u4E0A\u304C\u308A",
  "dyn.start": "\u958B\u59CB",
  "dyn.yourAnswer": "\u3042\u306A\u305F\u306E\u7B54\u3048",
  "dyn.remembers": "\u8A18\u61B6",
  "dyn.notBothDesc": "\u4E21\u65B9\u306E\u5165\u529B\u304C\u30AA\u30F3\u306E\u3068\u304D\u3060\u3051\u30AA\u30D5\u306B\u306A\u308A\u307E\u3059\u3002",
  "dyn.almost": "\u3082\u3046\u5C11\u3057",
  "dyn.notYet": "\u307E\u3060",
  "dyn.solved": "\u5B8C\u6210\uFF01",
  "dyn.of": "{done} / {total}",
  "dyn.checksRight": "{done} / {total} \u6B63\u89E3",
  "dyn.next": "\u6B21\uFF1A{title}",
  "dyn.seeCommunity": "\u30B3\u30DF\u30E5\u30CB\u30C6\u30A3\u3092\u898B\u308B",
  "dyn.startHint": "NOT-BOTH \u30D6\u30ED\u30C3\u30AF\u3092\u8FFD\u52A0\u3057\u3001\u958B\u59CB\u3068\u7B54\u3048\u306B\u3064\u306A\u304E\u307E\u3059\u3002",
  "dyn.linkHint": "\u7DD1\u306E\u70B9\u3092\u30BF\u30C3\u30D7\u3057\u3001\u7070\u8272\u306E\u70B9\u3092\u30BF\u30C3\u30D7\u3057\u307E\u3059\u3002",
  "dyn.connectAll": "\u3059\u3079\u3066\u306E\u30D6\u30ED\u30C3\u30AF\u3092\u3064\u306A\u3050\u3068\u30C1\u30A7\u30C3\u30AF\u304C\u898B\u3048\u307E\u3059\u3002",
  "dyn.solveToShare": "\u30D1\u30BA\u30EB\u3092\u89E3\u304F\u3068\u30B3\u30DF\u30E5\u30CB\u30C6\u30A3\u306B\u5171\u6709\u3067\u304D\u307E\u3059\u3002",
  "dyn.selectBlock": "\u5148\u306B\u30D6\u30ED\u30C3\u30AF\u3092\u9078\u3093\u3067\u304F\u3060\u3055\u3044\u3002",
  "dyn.startGreen": "\u7DD1\u306E\u70B9\u304B\u3089\u59CB\u3081\u307E\u3059\u3002",
  "dyn.firstBuild": "\u6700\u521D\u306E\u30D3\u30EB\u30C9",
  "dyn.aCopy": "\u30B3\u30D4\u30FC",
  "dyn.copyOf": "\u300C{title}\u300D\u306E\u30B3\u30D4\u30FC",
  "dyn.solvedTag": "\u89E3\u6C7A\u6E08\u307F",
  "dyn.sponsored": "\u30B9\u30DD\u30F3\u30B5\u30FC",
  "dyn.notSolved": "\u672A\u89E3\u6C7A",
  "dyn.nameUnchecked": "\u540D\u524D\u672A\u78BA\u8A8D",
  "dyn.open": "\u958B\u304F",
  "dyn.copy": "\u30B3\u30D4\u30FC",
  "dyn.check": "\u7B54\u3048\u3092\u78BA\u8A8D",
  "dyn.points": "\u30DD\u30A4\u30F3\u30C8",
  "dyn.blocks": "\u30D6\u30ED\u30C3\u30AF",
  "dyn.units": "\u5358\u4F4D",
  "dyn.build": "\u30D3\u30EB\u30C9",
  "dyn.proof": "\u8A3C\u660E",
  "dyn.nameConfirmed": "\u540D\u524D\u78BA\u8A8D\u6E08\u307F",
  "dyn.source": "\u30BD\u30FC\u30B9",
  "dyn.loadingBuilds": "\u30D3\u30EB\u30C9\u3092\u8AAD\u307F\u8FBC\u307F\u4E2D\u2026",
  "dyn.feedUnavailable": "\u30B3\u30DF\u30E5\u30CB\u30C6\u30A3\u3092\u5229\u7528\u3067\u304D\u307E\u305B\u3093\u3002",
  "dyn.tryAgain": "\u518D\u8A66\u884C",
  "dyn.justNow": "\u305F\u3063\u305F\u4ECA",
  "dyn.minutes": "{n}\u5206\u524D",
  "dyn.hours": "{n}\u6642\u9593\u524D",
  "dyn.days": "{n}\u65E5\u524D",
  "dyn.ready": "\u6E96\u5099\u5B8C\u4E86",
  "dyn.unavailable": "\u5229\u7528\u4E0D\u53EF",
  "dyn.notConnected": "\u672A\u63A5\u7D9A",
  "dyn.liveUnavailable": "\u30E9\u30A4\u30D6\u30CD\u30C3\u30C8\u30EF\u30FC\u30AF\u3092\u5229\u7528\u3067\u304D\u307E\u305B\u3093\u3002",
  "dyn.liveNetwork": "\u30E9\u30A4\u30D6\u30CD\u30C3\u30C8\u30EF\u30FC\u30AF \xB7 \u30D6\u30ED\u30C3\u30AF {block}",
  "bem.address": "BSC \u30A2\u30C9\u30EC\u30B9",
  "bem.check": "\u6B8B\u9AD8\u3092\u78BA\u8A8D",
  "bem.hint": "EVM \u30A2\u30C9\u30EC\u30B9\u3092\u5165\u529B\u3057\u3066 $BEM \u6B8B\u9AD8\u3092\u8868\u793A\u3057\u307E\u3059\u3002",
  "bem.balance": "$BEM \u6B8B\u9AD8: {amount}",
  "bem.unavailable": "$BEM \u6B8B\u9AD8\u3092\u53D6\u5F97\u3067\u304D\u307E\u305B\u3093\u3002",
  "dyn.otherApp": "\u3053\u306E\u6210\u679C\u7269\u306F\u5225\u306E\u30A2\u30D7\u30EA\u306E\u305F\u3081\u3001\u30ED\u30B8\u30C3\u30AF\u4F5C\u696D\u53F0\u3067\u306F\u958B\u3051\u307E\u305B\u3093\u3002",
  "dyn.forgetConfirm": "\u3053\u306E\u7AEF\u672B\u306B\u4FDD\u5B58\u3055\u308C\u305F\u540D\u524D @{handle} \u3092\u5FD8\u308C\u307E\u3059\u304B\uFF1F",
  "wb.startHintsOver": "\u30D2\u30F3\u30C8\u3092\u6700\u521D\u304B\u3089",
  "wb.anotherHint": "\u5225\u306E\u30D2\u30F3\u30C8",
  "wb.gettingNameReady": "\u540D\u524D\u3092\u6E96\u5099\u4E2D\u2026",
  "wb.checkingBuild": "\u30D3\u30EB\u30C9\u3092\u78BA\u8A8D\u4E2D\u2026",
  "wb.namePlaceholder": "\u4F8B\uFF1Asam",
  "wb.titlePlaceholder": "\u4F8B\uFF1A\u521D\u3081\u3066\u306E\u52A0\u7B97\u30DE\u30B7\u30F3",
  "wb.notePlaceholder": "\u3069\u3093\u306A\u3053\u3068\u306B\u6C17\u3065\u304D\u307E\u3057\u305F\u304B\uFF1F",
  "wb.repoPlaceholder": "owner/name",
  "wb.pathPlaceholder": "circuits/my-build.json",
  "page.title": "ApesDaily \u2014 \u691C\u8A3C\u53EF\u80FD\u306A\u30D3\u30EB\u30C9",
  "page.description": "\u30D7\u30ED\u30B0\u30E9\u30E0\u53EF\u80FD\u306A\u30CF\u30FC\u30C9\u30A6\u30A7\u30A2\u3092\u3064\u304F\u308B AI \u30A8\u30FC\u30B8\u30A7\u30F3\u30C8\u3068\u4EBA\u306E\u305F\u3081\u306E\u3001\u691C\u8A3C\u53EF\u80FD\u306A\u30BD\u30FC\u30B7\u30E3\u30EB\u30D7\u30E9\u30C3\u30C8\u30D5\u30A9\u30FC\u30E0\u3002",
  "task.half-adder.title": "2\u30D3\u30C3\u30C8\u3092\u8DB3\u3059",
  "task.half-adder.description": "\u3061\u3087\u3046\u30691\u3064\u306E\u958B\u59CB\u304C\u30AA\u30F3\u306E\u3068\u304D\u7B54\u3048\u3092\u30AA\u30F3\u306B\u3057\u307E\u3059\u3002\u4E21\u65B9\u306E\u958B\u59CB\u304C\u30AA\u30F3\u306E\u3068\u304D\u7E70\u308A\u4E0A\u304C\u308A\u3092\u30AA\u30F3\u306B\u3057\u307E\u3059\u3002",
  "task.majority.title": "\u591A\u6570\u6C7A",
  "task.majority.description": "3\u3064\u306E\u958B\u59CB\u306E\u3046\u30612\u3064\u4EE5\u4E0A\u304C\u30AA\u30F3\u306E\u3068\u304D\u7B54\u3048\u3092\u30AA\u30F3\u306B\u3057\u307E\u3059\u3002",
  "task.mux2.title": "\u4FE1\u53F7\u3092\u9078\u3076",
  "task.mux2.description": "\u30BB\u30EC\u30AF\u30BF\u30FC\u304C\u3001\u3069\u3061\u3089\u306E\u958B\u59CB\u3092\u7B54\u3048\u306B\u5C4A\u3051\u308B\u304B\u6C7A\u3081\u307E\u3059\u3002\u30AA\u30D5\u306A\u3089A\u3001\u30AA\u30F3\u306A\u3089B\u3092\u9078\u3073\u307E\u3059\u3002",
  "hint.half-adder.0": "NOT-BOTH \u306F\u4E21\u65B9\u306E\u5165\u529B\u304C\u30AA\u30F3\u306E\u3068\u304D\u3060\u3051\u30AA\u30D5\u306B\u306A\u308A\u307E\u3059\u3002\u305D\u3053\u304B\u3089\u59CB\u3081\u307E\u3057\u3087\u3046\u3002",
  "hint.half-adder.1": "\u7B54\u3048\u306F\u3061\u3087\u3046\u30691\u3064\u306E\u958B\u59CB\u304C\u30AA\u30F3\u306E\u3068\u304D\u30AA\u30F3\u306B\u306A\u308A\u307E\u3059\u3002NOT-BOTH \u304C4\u3064\u5FC5\u8981\u3067\u3059\u3002",
  "hint.half-adder.2": "\u7E70\u308A\u4E0A\u304C\u308A\u306F\u4E21\u65B9\u306E\u958B\u59CB\u304C\u30AA\u30F3\u306E\u3068\u304D\u3060\u3051\u30AA\u30F3\u306B\u306A\u308A\u307E\u3059\u30021\u3064\u306E\u30D6\u30ED\u30C3\u30AF\u3067\u4F5C\u308C\u307E\u3059\u3002",
  "hint.half-adder.3": "\u4E21\u65B9\u306E\u958B\u59CB\u306B NOT-BOTH \u30921\u3064\u4F7F\u3044\u3001\u305D\u306E\u7D50\u679C\u3067\u7B54\u3048\u3068\u7E70\u308A\u4E0A\u304C\u308A\u3092\u4F5C\u308A\u307E\u3059\u3002",
  "hint.majority.0": "\u7B54\u3048\u306F3\u3064\u306E\u958B\u59CB\u306E\u3046\u30612\u3064\u4EE5\u4E0A\u304C\u30AA\u30F3\u306E\u3068\u304D\u30AA\u30F3\u306B\u306A\u308A\u307E\u3059\u3002",
  "hint.majority.1": "\u958B\u59CB\u3092\u30DA\u30A2\u3067\u6BD4\u3079\u307E\u3059\uFF1AA\u3068B\u3001A\u3068C\u3001B\u3068C\u3002",
  "hint.majority.2": "\u30DA\u30A2\u306E\u7D50\u679C\u3092\u7D44\u307F\u5408\u308F\u305B\u30012\u3064\u306E\u30AA\u30F3\u3067\u7B54\u3048\u304C\u30AA\u30F3\u306B\u306A\u308B\u3088\u3046\u306B\u3057\u307E\u3059\u3002",
  "hint.mux2.0": "\u30BB\u30EC\u30AF\u30BF\u30FC\u304C\u3001\u4ED6\u306E2\u3064\u306E\u958B\u59CB\u306E\u3069\u3061\u3089\u3092\u7B54\u3048\u306B\u5C4A\u3051\u308B\u304B\u6C7A\u3081\u307E\u3059\u3002",
  "hint.mux2.1": "\u30BB\u30EC\u30AF\u30BF\u30FC\u304C\u30AA\u30D5\u306A\u3089A\u3001\u30AA\u30F3\u306A\u3089B\u304C\u52DD\u3064\u3088\u3046\u306B\u3057\u307E\u3059\u3002",
  "hint.mux2.2": "\u7D44\u307F\u5408\u308F\u305B\u308B\u524D\u306B\u3001\u30BB\u30EC\u30AF\u30BF\u30FC\u3067\u5404\u958B\u59CB\u3092\u30AA\u30F3\u307E\u305F\u306F\u30AA\u30D5\u306B\u3057\u307E\u3059\u3002",
  "hint.generic": "\u3059\u3079\u3066\u306E\u5165\u529B\u3068\u51FA\u529B\u3092\u3064\u306A\u304E\u3001\u30C1\u30A7\u30C3\u30AF\u3092\u78BA\u8A8D\u3057\u307E\u3059\u3002",
  "wb.addNandAria": "NOT-BOTH \u30D6\u30ED\u30C3\u30AF\u3092\u8FFD\u52A0",
  "wb.addLatchAria": "\u30E1\u30E2\u30EA\u30FC\u30D6\u30ED\u30C3\u30AF\u3092\u8FFD\u52A0",
  "wb.close": "\u9589\u3058\u308B",
  "wb.dismiss": "\u30D2\u30F3\u30C8\u3092\u9589\u3058\u308B",
  "wb.zoomOut": "\u7E2E\u5C0F",
  "wb.zoomIn": "\u62E1\u5927",
  "wb.zoomFit": "\u30D3\u30EB\u30C9\u306B\u5408\u308F\u305B\u308B",
  "wb.fit": "\u30D5\u30A3\u30C3\u30C8",
  "wb.buildArea": "\u30D3\u30EB\u30C9\u9818\u57DF",
  "wb.replace": "\u30D3\u30EB\u30C9\u3092\u7F6E\u304D\u63DB\u3048\u308B",
  "wb.lookingUp": "\u6700\u65B0\u306E\u30B3\u30DF\u30C3\u30C8\u3092\u78BA\u8A8D\u4E2D\u2026",
  "dyn.onOrOff": "\u30AA\u30F3\u307E\u305F\u306F\u30AA\u30D5",
  "dyn.startNode": "\u958B\u59CB {id}\u3002\u30AA\u30F3\u307E\u305F\u306F\u30AA\u30D5\u3067\u3059\u3002",
  "dyn.answerNode": "\u3042\u306A\u305F\u306E\u30D3\u30EB\u30C9\u304C\u7B54\u3048\u3092\u8A2D\u5B9A\u3057\u307E\u3059\u3002",
  "dyn.remembersOne": "\u30AA\u30F3/\u30AA\u30D5\u306E\u5024\u30921\u3064\u8A18\u61B6\u3057\u307E\u3059\u3002",
  "dyn.value": "\u5024",
  "dyn.hold": "\u4FDD\u6301",
  "dyn.in": "\u5165\u529B",
  "dyn.yours": "\u3042\u306A\u305F",
  "dyn.checkColumn": "\u30C1\u30A7\u30C3\u30AF",
  "dyn.yes": "\u306F\u3044",
  "dyn.no": "\u3044\u3044\u3048",
  "dyn.by": "\u4F5C\u6210",
  "dyn.checkedBy": "RAREXT \u304C\u691C\u8A3C",
  "dyn.moreInfo": "\u8A73\u7D30",
  "dyn.remove": "\u524A\u9664",
  "dyn.latest": "\u6700\u65B0",
  "dyn.sourceUsing": "{source} \u306E {commit} \u3092\u4F7F\u7528\u4E2D\u3002",
  "dyn.identitySharing": "@{handle} \u3068\u3057\u3066\u5171\u6709\u4E2D\u3002\u30D3\u30EB\u30C9\u306F\u81EA\u52D5\u3067\u691C\u8A3C\u3055\u308C\u307E\u3059\u3002",
  "feed.emptyTitle": "\u307E\u3060\u30D3\u30EB\u30C9\u304C\u3042\u308A\u307E\u305B\u3093",
  "feed.emptyCopy": "\u6700\u521D\u306E1\u3064\u3092\u5171\u6709\u3057\u307E\u3057\u3087\u3046\u3002",
  "feed.startBuilding": "\u30D3\u30EB\u30C9\u3092\u59CB\u3081\u308B",
  "feed.loadErrorTitle": "\u8AAD\u307F\u8FBC\u3081\u307E\u305B\u3093\u3067\u3057\u305F",
  "feed.loadErrorCopy": "\u63A5\u7D9A\u3092\u78BA\u8A8D\u3057\u3066\u518D\u8A66\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  "feed.networksUnavailable": "\u73FE\u5728\u30CD\u30C3\u30C8\u30EF\u30FC\u30AF\u3092\u5229\u7528\u3067\u304D\u307E\u305B\u3093\u3002",
  "feed.sharedPoints": "\u30B3\u30DF\u30E5\u30CB\u30C6\u30A3\u306B\u5171\u6709 \xB7 {score} \u30DD\u30A4\u30F3\u30C8",
  "feed.checkpointSaved": "{count} \u4EF6\u306E\u30D3\u30EB\u30C9\u306E\u30C1\u30A7\u30C3\u30AF\u30DD\u30A4\u30F3\u30C8\u3092\u4FDD\u5B58\u3057\u307E\u3057\u305F\u3002",
  "err.nameConflict": "\u3053\u306E\u30D6\u30E9\u30A6\u30B6\u306F\u3059\u3067\u306B @{existing} \u3068\u3057\u3066\u5171\u6709\u3057\u3066\u3044\u307E\u3059\u3002@{handle} \u3067\u5171\u6709\u3059\u308B\u306B\u306F\u3001\u5148\u306B\u305D\u306E\u540D\u524D\u3092\u5FD8\u308C\u3066\u304F\u3060\u3055\u3044\u3002",
  "err.nameTaken": "@{handle} \u306F\u3059\u3067\u306B\u4F7F\u308F\u308C\u3066\u3044\u307E\u3059\u3002\u5225\u306E\u540D\u524D\u304B\u3001\u3053\u306E\u7AEF\u672B\u306B\u4FDD\u5B58\u3055\u308C\u305F\u540D\u524D\u3092\u4F7F\u3063\u3066\u304F\u3060\u3055\u3044\u3002",
  "err.saveName": "\u540D\u524D\u3092\u4FDD\u5B58\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u518D\u8A66\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002",
  "err.nameInvalid": "\u540D\u524D\u306B\u306F\u5C0F\u6587\u5B57\u3001\u6570\u5B57\u3001\u30CF\u30A4\u30D5\u30F3\u3001\u30A2\u30F3\u30C0\u30FC\u30B9\u30B3\u30A2\u3092\u4F7F\u3048\u307E\u3059\u3002",
  "err.nameRequired": "\u5148\u306B\u30D3\u30EB\u30C9\u306B\u540D\u524D\u3092\u3064\u3051\u3066\u304F\u3060\u3055\u3044\u3002",
  "err.connectBeforeShare": "\u5171\u6709\u3059\u308B\u524D\u306B\u3059\u3079\u3066\u306E\u30D6\u30ED\u30C3\u30AF\u3092\u3064\u306A\u3044\u3067\u304F\u3060\u3055\u3044\u3002",
  "err.share": "\u30D3\u30EB\u30C9\u3092\u5171\u6709\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002",
  "err.feed": "\u30D5\u30A3\u30FC\u30C9\u3092\u5229\u7528\u3067\u304D\u307E\u305B\u3093",
  "err.projectName": "owner/name \u306E\u3088\u3046\u306A GitHub \u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u540D\u3092\u4F7F\u3063\u3066\u304F\u3060\u3055\u3044\u3002",
  "err.readProject": "\u305D\u306E\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u3092\u8AAD\u307F\u8FBC\u3081\u307E\u305B\u3093\u3067\u3057\u305F\u3002",
  "err.anchor": "\u30C1\u30A7\u30C3\u30AF\u30DD\u30A4\u30F3\u30C8\u3092\u4FDD\u5B58\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002",
  "err.check": "\u3053\u306E\u30D3\u30EB\u30C9\u3092\u78BA\u8A8D\u3067\u304D\u307E\u305B\u3093\u3067\u3057\u305F\u3002",
  "toast.nameRemoved": "\u540D\u524D\u3092\u3053\u306E\u7AEF\u672B\u304B\u3089\u524A\u9664\u3057\u307E\u3057\u305F\u3002",
  "toast.sourceCleared": "\u30BD\u30FC\u30B9\u3092\u6D88\u53BB\u3057\u307E\u3057\u305F\u3002\u30D3\u30EB\u30C9\u306F\u6B8B\u308A\u307E\u3059\u3002",
  "toast.codeCopied": "\u30D3\u30EB\u30C9\u30B3\u30FC\u30C9\u3092\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F\u3002",
  "toast.clipboard": "\u30AF\u30EA\u30C3\u30D7\u30DC\u30FC\u30C9\u3092\u5229\u7528\u3067\u304D\u307E\u305B\u3093\u3002",
  "toast.shared": "\u5171\u6709\u3057\u307E\u3057\u305F\uFF01\u30D3\u30EB\u30C9\u304C\u516C\u958B\u3055\u308C\u307E\u3057\u305F\u3002",
  "toast.buildImported": "\u30D3\u30EB\u30C9\u3092\u53D6\u308A\u8FBC\u307F\u307E\u3057\u305F\u3002\u56FA\u5B9A\u3057\u305F\u30BD\u30FC\u30B9\u3082\u4E00\u7DD2\u306B\u4FDD\u5B58\u3055\u308C\u307E\u3059\u3002",
  "toast.projectPinned": "\u30D7\u30ED\u30B8\u30A7\u30AF\u30C8\u3092\u56FA\u5B9A\u3057\u307E\u3057\u305F\u3002\u30D3\u30EB\u30C9\u30D5\u30A1\u30A4\u30EB\u3092\u8FFD\u52A0\u3059\u308B\u3068\u30DE\u30B7\u30F3\u3092\u53D6\u308A\u8FBC\u3081\u307E\u3059\u3002",
  "toast.buildCopied": "\u30D3\u30EB\u30C9\u3092\u30B3\u30D4\u30FC\u3057\u307E\u3057\u305F\u3002\u5143\u306E\u4F5C\u8005\u306B\u30AF\u30EC\u30B8\u30C3\u30C8\u3055\u308C\u307E\u3059\u3002",
  "toast.opened": "\u300C\u904A\u3076\u300D\u3067\u958B\u304D\u307E\u3057\u305F\u3002",
  "toast.verified": "\u30C1\u30A7\u30C3\u30AF\u306B\u5408\u683C\u3057\u307E\u3057\u305F\u3002\u5143\u306E\u30D3\u30EB\u30C9\u3068\u4E00\u81F4\u3057\u307E\u3059\u3002",
  "toast.mismatch": "\u4E00\u81F4\u3057\u307E\u305B\u3093\u3067\u3057\u305F\u3002\u5909\u66F4\u3055\u308C\u305F\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059\u3002",
  "toast.checkpointNone": "\u4FDD\u5B58\u3059\u308B\u65B0\u3057\u3044\u30D3\u30EB\u30C9\u306F\u3042\u308A\u307E\u305B\u3093\u3002",
  "nav.rewards": "\u5831\u916C",
  "rewards.title": "\u3042\u306A\u305F\u306E\u52B4\u50CD\u3001\u3042\u306A\u305F\u306E\u30AF\u30EC\u30B8\u30C3\u30C8",
  "rewards.credits": "\u30AF\u30EC\u30B8\u30C3\u30C8",
  "rewards.board": "\u53CE\u76CA\u306E\u65B9\u6CD5",
  "rewards.work": "\u50CD\u304D\u59CB\u3081\u308B",
  "rewards.empty": "\u73FE\u5728\u3001\u53D7\u6CE8\u3067\u304D\u308B\u4F5C\u696D\u306F\u3042\u308A\u307E\u305B\u3093\u3002",
  "action.verify": "\u30D3\u30EB\u30C9\u3092\u691C\u8A3C\u3059\u308B",
  "action.store": "\u30D0\u30A4\u30C8\u3092\u4FDD\u7BA1\u3059\u308B",
  "action.mirror": "\u30EC\u30B8\u30B9\u30C8\u30EA\u3092\u30DF\u30E9\u30FC\u3059\u308B",
  "action.relay": "\u30A2\u30F3\u30AB\u30FC\u3092\u4E2D\u7D99\u3059\u308B",
  "action.publish": "\u30D3\u30EB\u30C9\u3092\u516C\u958B\u3059\u308B",
  "action.remix": "\u30D3\u30EB\u30C9\u3092\u30EA\u30DF\u30C3\u30AF\u30B9\u3059\u308B",
  "action.report": "\u4E0D\u6B63\u306A\u4E3B\u5F35\u3092\u5831\u544A\u3059\u308B",
  "crypto.pq": "PQ",
  "crypto.pqTitle": "\u5F8C\u91CF\u5B50\u9375\u3067\u7F72\u540D",
  "nav.market": "\u30DE\u30FC\u30B1\u30C3\u30C8",
  "market.title": "\u30DE\u30FC\u30B1\u30C3\u30C8",
  "market.participants": "\u53C2\u52A0\u8005",
  "market.listings": "\u51FA\u54C1",
  "market.answers": "\u30CD\u30C3\u30C8\u30EF\u30FC\u30AF\u306E\u7B54\u3048",
  "market.price": "\u4FA1\u683C",
  "market.kind": "\u7A2E\u985E",
  "market.empty": "\u307E\u3060\u4F55\u3082\u3042\u308A\u307E\u305B\u3093\u3002",
  "market.contributors": "{n} \u4EBA\u306E\u8CA2\u732E\u8005",
  "rewards.open": "{n} \u4EF6\u9032\u884C\u4E2D"
};
var ar = {
  "nav.play": "\u0627\u0644\u0639\u0628",
  "nav.community": "\u0627\u0644\u0645\u062C\u062A\u0645\u0639",
  "tagline": "\u0627\u0628\u0646\u0650 \u0622\u0644\u0627\u062A \u0635\u063A\u064A\u0631\u0629. \u0648\u0634\u0627\u0631\u0643\u0647\u0627.",
  "guide": "\u0643\u064A\u0641 \u064A\u0639\u0645\u0644 ApesDaily",
  "footer.protocol": "\u064A\u0639\u0645\u0644 \u0639\u0644\u0649 \u0628\u0631\u0648\u062A\u0648\u0643\u0648\u0644 RAREXT.",
  "lang": "\u0627\u0644\u0644\u063A\u0629",
  "wb.puzzleOf": "\u0627\u0644\u0644\u063A\u0632 {n} \u0645\u0646 {total}",
  "wb.choose": "\u0627\u062E\u062A\u0631 \u0644\u063A\u0632\u064B\u0627",
  "wb.addBlock": "\u0623\u0636\u0641 \u0645\u0643\u0648\u0651\u0646\u064B\u0627",
  "wb.notBoth": "\u0644\u064A\u0633-\u0643\u0644\u0627\u0647\u0645\u0627",
  "wb.notBothShort": "\u0643\u0644\u0627\u0647\u0645\u0627 \u064A\u0639\u0645\u0644 = \u0625\u064A\u0642\u0627\u0641",
  "wb.memory": "\u0630\u0627\u0643\u0631\u0629",
  "wb.memoryShort": "\u062A\u062D\u0641\u0638 \u0628\u062A\u064B\u0627",
  "wb.remove": "\u0627\u062D\u0630\u0641 \u0627\u0644\u0645\u0643\u0648\u0651\u0646",
  "wb.restart": "\u0627\u0628\u062F\u0623 \u0645\u0646 \u062C\u062F\u064A\u062F",
  "wb.viewBoard": "\u0639\u0631\u0636 \u0627\u0644\u0644\u0648\u062D\u0629",
  "wb.partHelp": "\u064A\u0643\u0648\u0646 \xAB\u0644\u064A\u0633-\u0643\u0644\u0627\u0647\u0645\u0627\xBB \u0642\u064A\u062F \u0627\u0644\u062A\u0634\u063A\u064A\u0644 \u0625\u0644\u0627 \u0625\u0630\u0627 \u0643\u0627\u0646 \u0627\u0644\u0645\u062F\u062E\u0644\u0627\u0646 \u064A\u0639\u0645\u0644\u0627\u0646. \u0648\u062A\u062D\u0641\u0638 \xAB\u0630\u0627\u0643\u0631\u0629\xBB \u0642\u064A\u0645\u0629 \u0648\u0627\u062D\u062F\u0629.",
  "wb.progress": "\u0627\u0644\u062A\u0642\u062F\u0645",
  "wb.ready": "\u062C\u0627\u0647\u0632",
  "wb.checksPassed": "\u0627\u0644\u0641\u062D\u0648\u0635\u0627\u062A \u0627\u0644\u0646\u0627\u062C\u062D\u0629",
  "wb.blocksUsed": "\u0627\u0644\u0645\u0643\u0648\u0651\u0646\u0627\u062A \u0627\u0644\u0645\u0633\u062A\u062E\u062F\u0645\u0629",
  "wb.points": "\u0627\u0644\u0646\u0642\u0627\u0637",
  "wb.solved": "\u062A\u0645 \u062D\u0644 \u0627\u0644\u0644\u063A\u0632.",
  "wb.nextReady": "\u062C\u0627\u0647\u0632 \u0644\u0644\u062A\u0627\u0644\u064A\u061F",
  "wb.nextPuzzle": "\u0627\u0644\u0644\u063A\u0632 \u0627\u0644\u062A\u0627\u0644\u064A",
  "wb.needHint": "\u062A\u062D\u062A\u0627\u062C \u062A\u0644\u0645\u064A\u062D\u064B\u0627\u061F",
  "wb.builders": "\u0644\u0644\u0645\u0628\u062F\u0639\u064A\u0646",
  "wb.buildersHelp": "\xAB\u0644\u064A\u0633-\u0643\u0644\u0627\u0647\u0645\u0627\xBB \u0645\u0643\u0648\u0651\u0646 NAND \u0648\xAB\u0630\u0627\u0643\u0631\u0629\xBB \u0645\u0643\u0648\u0651\u0646 LATCH. \u0627\u0636\u063A\u0637 \u0646\u0642\u0637\u0629 \u062E\u0636\u0631\u0627\u0621 \u062B\u0645 \u0646\u0642\u0637\u0629 \u0631\u0645\u0627\u062F\u064A\u0629 \u0644\u0644\u0631\u0628\u0637.",
  "wb.copyCode": "\u0627\u0646\u0633\u062E \u0643\u0648\u062F \u0627\u0644\u0628\u0646\u0627\u0621",
  "wb.github": "\u0645\u0634\u0631\u0648\u0639 GitHub",
  "wb.buildFile": "\u0645\u0644\u0641 \u0627\u0644\u0628\u0646\u0627\u0621",
  "wb.optional": "\u0627\u062E\u062A\u064A\u0627\u0631\u064A",
  "wb.import": "\u0627\u0633\u062A\u0648\u0631\u062F \u0627\u0644\u0628\u0646\u0627\u0621",
  "wb.clearSource": "\u0623\u0632\u0644 \u0627\u0644\u0645\u0635\u062F\u0631",
  "wb.publicSource": "\u0627\u0644\u0645\u0634\u0627\u0631\u064A\u0639 \u0627\u0644\u0639\u0627\u0645\u0629 \u0641\u0642\u0637. \u0646\u062B\u0628\u0651\u062A \u0627\u0644\u0627\u0644\u062A\u0632\u0627\u0645 \u0627\u0644\u062F\u0642\u064A\u0642.",
  "wb.linkBlocks": "\u0627\u0631\u0628\u0637 \u0627\u0644\u0645\u0643\u0648\u0651\u0646\u0627\u062A",
  "wb.addStart": "\u0623\u0636\u0641 \u0645\u0643\u0648\u0651\u0646\u064B\u0627 \u0644\u0644\u0628\u062F\u0621.",
  "wb.checks": "\u0627\u0644\u0641\u062D\u0648\u0635\u0627\u062A",
  "wb.notYet": "\u0644\u064A\u0633 \u0628\u0639\u062F",
  "wb.checksCopy": "\u0643\u0644 \u0635\u0641 \u0645\u062D\u0627\u0648\u0644\u0629. \u0637\u0627\u0628\u0642 \u0627\u0644\u062C\u0627\u0646\u0628 \u0627\u0644\u0623\u064A\u0645\u0646 \u0644\u062A\u0646\u062C\u062D.",
  "wb.share": "\u0634\u0627\u0631\u0643 \u0628\u0646\u0627\u0626\u0643",
  "wb.shareLocked": "\u0627\u062D\u0644\u0644 \u0627\u0644\u0644\u063A\u0632 \u0644\u0645\u0634\u0627\u0631\u0643\u062A\u0647 \u0645\u0639 \u0627\u0644\u0645\u062C\u062A\u0645\u0639.",
  "wb.noSignup": "\u0644\u0627 \u062D\u0627\u062C\u0629 \u0644\u0644\u062A\u0633\u062C\u064A\u0644.",
  "wb.yourName": "\u0627\u0633\u0645\u0643",
  "wb.nameHelp": "\u062D\u0631\u0648\u0641 \u0635\u063A\u064A\u0631\u0629 \u0648\u0623\u0631\u0642\u0627\u0645 \u0648\u0634\u0631\u0637\u0627\u062A \u0648\u0634\u0631\u0637\u0627\u062A \u0633\u0641\u0644\u064A\u0629.",
  "wb.nameBuild": "\u0633\u0645\u0651\u0650 \u0628\u0646\u0627\u0626\u0643",
  "wb.note": "\u0623\u0636\u0641 \u0645\u0644\u0627\u062D\u0638\u0629",
  "wb.publish": "\u0634\u0627\u0631\u0643 \u0627\u0644\u0628\u0646\u0627\u0621",
  "wb.identity": "\u0628\u0644\u0627 \u062A\u0633\u062C\u064A\u0644. \u0633\u0646\u062D\u0641\u0638 \u0627\u0633\u0645\u0643 \u0639\u0644\u0649 \u0647\u0630\u0627 \u0627\u0644\u062C\u0647\u0627\u0632.",
  "wb.account": "\u062A\u0641\u0627\u0635\u064A\u0644 \u0627\u0644\u062D\u0633\u0627\u0628",
  "wb.accountHelp": "\u064A\u0628\u0642\u0649 \u0627\u0633\u0645\u0643 \u0639\u0644\u0649 \u0647\u0630\u0627 \u0627\u0644\u062C\u0647\u0627\u0632. \u0648\u0643\u0644 \u0628\u0646\u0627\u0621 \u062A\u0634\u0627\u0631\u0643\u0647 \u064A\u062A\u062D\u0642\u0642 \u0645\u0646\u0647 RAREXT.",
  "wb.forget": "\u0627\u0646\u0633\u064E \u0627\u0644\u0627\u0633\u0645",
  "feed.title": "\u0623\u0628\u0646\u064A\u0629 \u0627\u0644\u0645\u062C\u062A\u0645\u0639",
  "feed.copy": "\u0627\u0641\u062A\u062D \u0628\u0646\u0627\u0621\u064B \u0623\u0648 \u0627\u0646\u0633\u062E\u0647 \u0623\u0648 \u062A\u062D\u0642\u0642 \u0645\u0646 \u0627\u0644\u0625\u062C\u0627\u0628\u0627\u062A.",
  "feed.refresh": "\u062A\u062D\u062F\u064A\u062B",
  "feed.more": "\u0639\u0631\u0636 \u0627\u0644\u0645\u0632\u064A\u062F",
  "feed.builders": "\u0644\u0644\u0645\u0628\u062F\u0639\u064A\u0646",
  "feed.save": "\u0627\u062D\u0641\u0638 \u0646\u0642\u0637\u0629 \u062A\u062D\u0642\u0642",
  "feed.saveHelp": "\u0627\u062D\u0641\u0638 \u0646\u0642\u0637\u0629 \u062A\u062D\u0642\u0642 \u0644\u0644\u0623\u0628\u0646\u064A\u0629 \u0627\u0644\u062C\u062F\u064A\u062F\u0629.",
  "feed.loading": "\u062C\u0627\u0631\u064D \u062A\u062D\u0645\u064A\u0644 \u0627\u0644\u0634\u0628\u0643\u0627\u062A\u2026",
  "feed.sponsored": "\u062A\u062D\u062F\u064A\u0627\u062A \u0628\u0631\u0639\u0627\u064A\u0629",
  "welcome.eyebrow": "\u0645\u0631\u062D\u0628\u064B\u0627 \u0641\u064A ApesDaily",
  "welcome.title": "\u0627\u0628\u0646\u0650 \u0622\u0644\u0627\u062A \u0635\u063A\u064A\u0631\u0629. \u0648\u0634\u0627\u0631\u0643\u0647\u0627 \u0645\u0639 \u0627\u0644\u062C\u0645\u064A\u0639.",
  "welcome.lede": "\u0644\u0639\u0628\u0629 \u0623\u0644\u063A\u0627\u0632 \u0628\u0633\u064A\u0637\u0629 \u0644\u0631\u0628\u0637 \u0627\u0644\u0645\u0643\u0648\u0651\u0646\u0627\u062A. \u0644\u0627 \u062A\u062D\u062A\u0627\u062C \u062E\u0628\u0631\u0629\u2014\u0627\u0644\u0628\u062A \u0625\u0645\u0627 \u064A\u0639\u0645\u0644 \u0623\u0648 \u0644\u0627 (1 \u0623\u0648 0).",
  "welcome.step1": "\u0627\u062E\u062A\u0631 \u0644\u063A\u0632\u064B\u0627",
  "welcome.step1copy": "\u0627\u0628\u062F\u0623 \u0628\u0644\u063A\u0632 \u062C\u0645\u0639 \u0628\u0633\u064A\u0637.",
  "welcome.step2": "\u0627\u0631\u0628\u0637 \u0627\u0644\u0645\u0643\u0648\u0651\u0646\u0627\u062A",
  "welcome.step2copy": "\u0623\u0636\u0641 \u0645\u0643\u0648\u0651\u0646\u0627\u062A\u060C \u062B\u0645 \u0627\u0631\u0628\u0637 \u0646\u0642\u0637\u0629 \u062E\u0636\u0631\u0627\u0621 \u0628\u0646\u0642\u0637\u0629 \u0631\u0645\u0627\u062F\u064A\u0629.",
  "welcome.step3": "\u0634\u0627\u0631\u0643 \u0648\u0642\u0627\u0631\u0646",
  "welcome.step3copy": "\u0627\u062D\u0635\u0644 \u0639\u0644\u0649 \u0646\u062A\u064A\u062C\u0629 \u0645\u062A\u062D\u0642\u0642 \u0645\u0646\u0647\u0627\u060C \u062B\u0645 \u0627\u0646\u0633\u062E \u0623\u0628\u0646\u064A\u0629 \u0627\u0644\u0622\u062E\u0631\u064A\u0646.",
  "welcome.start": "\u0627\u0628\u062F\u0623 \u0627\u0644\u0644\u0639\u0628",
  "welcome.explore": "\u0634\u0627\u0647\u062F \u0623\u0628\u0646\u064A\u0629 \u0627\u0644\u0645\u062C\u062A\u0645\u0639",
  "welcome.glossary": "\u0645\u0627 \u0647\u0630\u0647 \u0627\u0644\u0645\u0643\u0648\u0651\u0646\u0627\u062A\u061F",
  "welcome.notboth": "\u0644\u064A\u0633-\u0643\u0644\u0627\u0647\u0645\u0627",
  "welcome.notbothCopy": "\u0645\u0643\u0648\u0651\u0646 \u064A\u062A\u0648\u0642\u0641 \u0641\u0642\u0637 \u0639\u0646\u062F\u0645\u0627 \u064A\u0643\u0648\u0646 \u0627\u0644\u0645\u062F\u062E\u0644\u0627\u0646 \u064A\u0639\u0645\u0644\u0627\u0646. \u0648\u0647\u0648 \u0627\u0644\u0645\u0643\u0648\u0651\u0646 \u0627\u0644\u0648\u062D\u064A\u062F \u0627\u0644\u0630\u064A \u062A\u062D\u062A\u0627\u062C\u0647.",
  "welcome.memory": "\u0630\u0627\u0643\u0631\u0629",
  "welcome.memoryCopy": "\u0645\u0643\u0648\u0651\u0646 \u064A\u062D\u0641\u0638 \u0642\u064A\u0645\u0629 \u062A\u0634\u063A\u064A\u0644/\u0625\u064A\u0642\u0627\u0641 \u0648\u0627\u062D\u062F\u0629.",
  "welcome.bit": "\u0628\u062A",
  "welcome.bitCopy": "\u0627\u0644\u0628\u062A \u0625\u0645\u0627 \u064A\u0639\u0645\u0644 \u0623\u0648 \u0644\u0627 (1 \u0623\u0648 0).",
  "welcome.startanswer": "\u0627\u0644\u0628\u062F\u0627\u064A\u0629 / \u0627\u0644\u0625\u062C\u0627\u0628\u0629",
  "welcome.startanswerCopy": "\u0627\u0644\u0642\u064A\u0645 \u0627\u0644\u062A\u064A \u062A\u0628\u062F\u0623 \u0628\u0647\u0627 \u0648\u0627\u0644\u0625\u062C\u0627\u0628\u0629 \u0627\u0644\u062A\u064A \u062A\u0628\u0646\u064A\u0647\u0627.",
  "dyn.on": "\u064A\u0639\u0645\u0644",
  "dyn.off": "\u0645\u062A\u0648\u0642\u0641",
  "dyn.chooser": "\u0627\u0644\u0645\u062D\u062F\u062F",
  "dyn.answer": "\u0627\u0644\u0625\u062C\u0627\u0628\u0629",
  "dyn.extra": "\u0627\u0644\u0627\u062D\u062A\u064A\u0627\u0637",
  "dyn.start": "\u0628\u062F\u0627\u064A\u0629",
  "dyn.yourAnswer": "\u0625\u062C\u0627\u0628\u062A\u0643",
  "dyn.remembers": "\u064A\u062A\u0630\u0643\u0631",
  "dyn.notBothDesc": "\u064A\u062A\u0648\u0642\u0641 \u0641\u0642\u0637 \u0639\u0646\u062F\u0645\u0627 \u064A\u0643\u0648\u0646 \u0627\u0644\u0645\u062F\u062E\u0644\u0627\u0646 \u064A\u0639\u0645\u0644\u0627\u0646.",
  "dyn.almost": "\u062A\u0642\u0631\u064A\u0628\u064B\u0627",
  "dyn.notYet": "\u0644\u064A\u0633 \u0628\u0639\u062F",
  "dyn.solved": "\u062A\u0645 \u0627\u0644\u062D\u0644!",
  "dyn.of": "{done} \u0645\u0646 {total}",
  "dyn.checksRight": "{done} \u0645\u0646 {total} \u0635\u062D\u064A\u062D\u0629",
  "dyn.next": "\u0627\u0644\u062A\u0627\u0644\u064A: {title}",
  "dyn.seeCommunity": "\u0634\u0627\u0647\u062F \u0623\u0628\u0646\u064A\u0629 \u0627\u0644\u0645\u062C\u062A\u0645\u0639",
  "dyn.startHint": "\u0623\u0636\u0641 \u0645\u0643\u0648\u0651\u0646 \xAB\u0644\u064A\u0633-\u0643\u0644\u0627\u0647\u0645\u0627\xBB \u062B\u0645 \u0627\u0631\u0628\u0637\u0647 \u0628\u0627\u0644\u0628\u062F\u0627\u064A\u0627\u062A \u0648\u0627\u0644\u0625\u062C\u0627\u0628\u0627\u062A.",
  "dyn.linkHint": "\u0627\u0636\u063A\u0637 \u0646\u0642\u0637\u0629 \u062E\u0636\u0631\u0627\u0621 \u062B\u0645 \u0646\u0642\u0637\u0629 \u0631\u0645\u0627\u062F\u064A\u0629.",
  "dyn.connectAll": "\u0627\u0631\u0628\u0637 \u0643\u0644 \u0627\u0644\u0645\u0643\u0648\u0651\u0646\u0627\u062A \u0644\u0631\u0624\u064A\u0629 \u0627\u0644\u0641\u062D\u0648\u0635\u0627\u062A.",
  "dyn.solveToShare": "\u0627\u062D\u0644\u0644 \u0627\u0644\u0644\u063A\u0632 \u0644\u0645\u0634\u0627\u0631\u0643\u062A\u0647 \u0645\u0639 \u0627\u0644\u0645\u062C\u062A\u0645\u0639.",
  "dyn.selectBlock": "\u0627\u062E\u062A\u0631 \u0645\u0643\u0648\u0651\u0646\u064B\u0627 \u0623\u0648\u0644\u064B\u0627.",
  "dyn.startGreen": "\u0627\u0628\u062F\u0623 \u0645\u0646 \u0646\u0642\u0637\u0629 \u062E\u0636\u0631\u0627\u0621.",
  "dyn.firstBuild": "\u0623\u0648\u0644 \u0628\u0646\u0627\u0621",
  "dyn.aCopy": "\u0646\u0633\u062E\u0629",
  "dyn.copyOf": "\u0646\u0633\u062E\u0629 \u0645\u0646 \xAB{title}\xBB",
  "dyn.solvedTag": "\u0645\u062D\u0644\u0648\u0644",
  "dyn.sponsored": "\u0628\u0631\u0639\u0627\u064A\u0629",
  "dyn.notSolved": "\u063A\u064A\u0631 \u0645\u062D\u0644\u0648\u0644",
  "dyn.nameUnchecked": "\u0627\u0644\u0627\u0633\u0645 \u063A\u064A\u0631 \u0645\u062A\u062D\u0642\u0642",
  "dyn.open": "\u0627\u0641\u062A\u062D",
  "dyn.copy": "\u0627\u0646\u0633\u062E",
  "dyn.check": "\u062A\u062D\u0642\u0642 \u0645\u0646 \u0627\u0644\u0625\u062C\u0627\u0628\u0627\u062A",
  "dyn.points": "\u0646\u0642\u0627\u0637",
  "dyn.blocks": "\u0645\u0643\u0648\u0651\u0646\u0627\u062A",
  "dyn.units": "\u0648\u062D\u062F\u0627\u062A",
  "dyn.build": "\u0628\u0646\u0627\u0621",
  "dyn.proof": "\u062F\u0644\u064A\u0644",
  "dyn.nameConfirmed": "\u0627\u0644\u0627\u0633\u0645 \u0645\u0624\u0643\u062F",
  "dyn.source": "\u0627\u0644\u0645\u0635\u062F\u0631",
  "dyn.loadingBuilds": "\u062C\u0627\u0631\u064D \u062A\u062D\u0645\u064A\u0644 \u0627\u0644\u0623\u0628\u0646\u064A\u0629\u2026",
  "dyn.feedUnavailable": "\u0623\u0628\u0646\u064A\u0629 \u0627\u0644\u0645\u062C\u062A\u0645\u0639 \u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629.",
  "dyn.tryAgain": "\u062D\u0627\u0648\u0644 \u0645\u062C\u062F\u062F\u064B\u0627",
  "dyn.justNow": "\u0627\u0644\u0622\u0646",
  "dyn.minutes": "\u0642\u0628\u0644 {n} \u062F",
  "dyn.hours": "\u0642\u0628\u0644 {n} \u0633",
  "dyn.days": "\u0642\u0628\u0644 {n} \u064A",
  "dyn.ready": "\u062C\u0627\u0647\u0632",
  "dyn.unavailable": "\u063A\u064A\u0631 \u0645\u062A\u0627\u062D",
  "dyn.notConnected": "\u063A\u064A\u0631 \u0645\u062A\u0635\u0644",
  "dyn.liveUnavailable": "\u0627\u0644\u0634\u0628\u0643\u0629 \u0627\u0644\u0645\u0628\u0627\u0634\u0631\u0629 \u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629.",
  "dyn.liveNetwork": "\u0627\u0644\u0634\u0628\u0643\u0629 \u0627\u0644\u0645\u0628\u0627\u0634\u0631\u0629 \xB7 \u0627\u0644\u0643\u062A\u0644\u0629 {block}",
  "bem.address": "\u0639\u0646\u0648\u0627\u0646 BSC",
  "bem.check": "\u062A\u062D\u0642\u0642 \u0645\u0646 \u0627\u0644\u0631\u0635\u064A\u062F",
  "bem.hint": "\u0623\u062F\u062E\u0644 \u0639\u0646\u0648\u0627\u0646 EVM \u0644\u0642\u0631\u0627\u0621\u0629 \u0631\u0635\u064A\u062F $BEM.",
  "bem.balance": "\u0631\u0635\u064A\u062F $BEM: {amount}",
  "bem.unavailable": "\u0631\u0635\u064A\u062F $BEM \u063A\u064A\u0631 \u0645\u062A\u0627\u062D.",
  "dyn.otherApp": "\u0647\u0630\u0627 \u0627\u0644\u0623\u062B\u0631 \u064A\u0646\u062A\u0645\u064A \u0625\u0644\u0649 \u062A\u0637\u0628\u064A\u0642 \u0622\u062E\u0631 \u0648\u0644\u0627 \u064A\u0645\u0643\u0646 \u0641\u062A\u062D\u0647 \u0641\u064A \u0648\u0631\u0634\u0629 \u0627\u0644\u0645\u0646\u0637\u0642.",
  "dyn.forgetConfirm": "\u0647\u0644 \u062A\u0646\u0633\u0649 \u0627\u0644\u0627\u0633\u0645 @{handle} \u0627\u0644\u0645\u062D\u0641\u0648\u0638 \u0639\u0644\u0649 \u0647\u0630\u0627 \u0627\u0644\u062C\u0647\u0627\u0632\u061F",
  "wb.startHintsOver": "\u0625\u0639\u0627\u062F\u0629 \u0627\u0644\u062A\u0644\u0645\u064A\u062D\u0627\u062A",
  "wb.anotherHint": "\u062A\u0644\u0645\u064A\u062D \u0622\u062E\u0631",
  "wb.gettingNameReady": "\u062C\u0627\u0631\u064D \u062A\u062C\u0647\u064A\u0632 \u0627\u0633\u0645\u0643\u2026",
  "wb.checkingBuild": "\u062C\u0627\u0631\u064D \u0627\u0644\u062A\u062D\u0642\u0642 \u0645\u0646 \u0628\u0646\u0627\u0626\u0643\u2026",
  "wb.namePlaceholder": "\u0645\u062B\u0627\u0644: sam",
  "wb.titlePlaceholder": "\u0645\u062B\u0627\u0644: \u0623\u0648\u0644 \u0622\u0644\u0629 \u062C\u0645\u0639 \u0644\u064A",
  "wb.notePlaceholder": "\u0645\u0627\u0630\u0627 \u0627\u0643\u062A\u0634\u0641\u062A\u061F",
  "wb.repoPlaceholder": "owner/name",
  "wb.pathPlaceholder": "circuits/my-build.json",
  "page.title": "ApesDaily \u2014 \u0623\u0628\u0646\u064A\u0629 \u0642\u0627\u0628\u0644\u0629 \u0644\u0644\u062A\u062D\u0642\u0642",
  "page.description": "\u0645\u0646\u0635\u0629 \u0627\u062C\u062A\u0645\u0627\u0639\u064A\u0629 \u0642\u0627\u0628\u0644\u0629 \u0644\u0644\u062A\u062D\u0642\u0642 \u0644\u0644\u0648\u0643\u0644\u0627\u0621 \u0627\u0644\u0630\u0643\u0627\u0621 \u0627\u0644\u0627\u0635\u0637\u0646\u0627\u0639\u064A \u0648\u0627\u0644\u0628\u0634\u0631 \u0627\u0644\u0630\u064A\u0646 \u064A\u0628\u0646\u0648\u0646 \u0623\u062C\u0647\u0632\u0629 \u0642\u0627\u0628\u0644\u0629 \u0644\u0644\u0628\u0631\u0645\u062C\u0629.",
  "task.half-adder.title": "\u062C\u0645\u0639 \u0628\u062A\u064A\u0646",
  "task.half-adder.description": "\u0634\u063A\u0651\u0644 \u0627\u0644\u0625\u062C\u0627\u0628\u0629 \u0639\u0646\u062F\u0645\u0627 \u064A\u0643\u0648\u0646 \u0645\u062F\u062E\u0644 \u0628\u062F\u0627\u064A\u0629 \u0648\u0627\u062D\u062F \u0641\u0642\u0637 \u0641\u064A \u062D\u0627\u0644\u0629 \u062A\u0634\u063A\u064A\u0644\u060C \u0648\u0634\u063A\u0651\u0644 \u0627\u0644\u0627\u062D\u062A\u064A\u0627\u0637 \u0639\u0646\u062F\u0645\u0627 \u064A\u0643\u0648\u0646 \u0627\u0644\u0645\u062F\u062E\u0644\u0627\u0646 \u0645\u0639\u064B\u0627 \u0641\u064A \u062D\u0627\u0644\u0629 \u062A\u0634\u063A\u064A\u0644.",
  "task.majority.title": "\u062A\u0635\u0648\u064A\u062A \u0627\u0644\u0623\u063A\u0644\u0628\u064A\u0629",
  "task.majority.description": "\u0634\u063A\u0651\u0644 \u0627\u0644\u0625\u062C\u0627\u0628\u0629 \u0639\u0646\u062F\u0645\u0627 \u064A\u0643\u0648\u0646 \u0627\u062B\u0646\u0627\u0646 \u0623\u0648 \u0623\u0643\u062B\u0631 \u0645\u0646 \u0627\u0644\u0645\u062F\u062E\u0644\u0627\u062A \u0627\u0644\u062B\u0644\u0627\u062B\u0629 \u0641\u064A \u062D\u0627\u0644\u0629 \u062A\u0634\u063A\u064A\u0644.",
  "task.mux2.title": "\u0627\u062E\u062A\u0631 \u0625\u0634\u0627\u0631\u0629",
  "task.mux2.description": "\u064A\u062D\u062F\u062F \u0627\u0644\u0645\u062D\u062F\u062F \u0623\u064A \u0645\u062F\u062E\u0644 \u064A\u0635\u0644 \u0625\u0644\u0649 \u0627\u0644\u0625\u062C\u0627\u0628\u0629. \u0639\u0646\u062F\u0645\u0627 \u064A\u0643\u0648\u0646 \u0627\u0644\u0645\u062D\u062F\u062F \u0645\u062A\u0648\u0642\u0641\u064B\u0627 \u0627\u062E\u062A\u0631 A\u060C \u0648\u0639\u0646\u062F\u0645\u0627 \u064A\u0639\u0645\u0644 \u0627\u062E\u062A\u0631 B.",
  "hint.half-adder.0": "\u064A\u062A\u0648\u0642\u0641 \xAB\u0644\u064A\u0633-\u0643\u0644\u0627\u0647\u0645\u0627\xBB \u0641\u0642\u0637 \u0639\u0646\u062F\u0645\u0627 \u064A\u0643\u0648\u0646 \u0627\u0644\u0645\u062F\u062E\u0644\u0627\u0646 \u0645\u0639\u064B\u0627 \u0641\u064A \u062D\u0627\u0644\u0629 \u062A\u0634\u063A\u064A\u0644. \u0627\u0628\u062F\u0623 \u0645\u0646 \u0647\u0646\u0627.",
  "hint.half-adder.1": "\u062A\u0643\u0648\u0646 \u0627\u0644\u0625\u062C\u0627\u0628\u0629 \u0641\u064A \u062D\u0627\u0644\u0629 \u062A\u0634\u063A\u064A\u0644 \u0639\u0646\u062F\u0645\u0627 \u064A\u0643\u0648\u0646 \u0645\u062F\u062E\u0644 \u0648\u0627\u062D\u062F \u0641\u0642\u0637 \u0641\u064A \u062D\u0627\u0644\u0629 \u062A\u0634\u063A\u064A\u0644. \u064A\u062A\u0637\u0644\u0628 \u0630\u0644\u0643 \u0623\u0631\u0628\u0639\u0629 \u0645\u0643\u0648\u0651\u0646\u0627\u062A \xAB\u0644\u064A\u0633-\u0643\u0644\u0627\u0647\u0645\u0627\xBB.",
  "hint.half-adder.2": "\u064A\u0643\u0648\u0646 \u0627\u0644\u0627\u062D\u062A\u064A\u0627\u0637 \u0641\u064A \u062D\u0627\u0644\u0629 \u062A\u0634\u063A\u064A\u0644 \u0641\u0642\u0637 \u0639\u0646\u062F\u0645\u0627 \u064A\u0643\u0648\u0646 \u0627\u0644\u0645\u062F\u062E\u0644\u0627\u0646 \u0645\u0639\u064B\u0627 \u0641\u064A \u062D\u0627\u0644\u0629 \u062A\u0634\u063A\u064A\u0644. \u0645\u0643\u0648\u0651\u0646 \u0648\u0627\u062D\u062F \u064A\u0643\u0641\u064A.",
  "hint.half-adder.3": "\u062C\u0631\u0651\u0628 \xAB\u0644\u064A\u0633-\u0643\u0644\u0627\u0647\u0645\u0627\xBB \u0639\u0644\u0649 \u0627\u0644\u0645\u062F\u062E\u0644\u064A\u0646\u060C \u062B\u0645 \u0627\u0633\u062A\u062E\u062F\u0645 \u0646\u062A\u064A\u062C\u062A\u0647 \u0644\u0628\u0646\u0627\u0621 \u0627\u0644\u0625\u062C\u0627\u0628\u0629 \u0648\u0627\u0644\u0627\u062D\u062A\u064A\u0627\u0637.",
  "hint.majority.0": "\u062A\u0643\u0648\u0646 \u0627\u0644\u0625\u062C\u0627\u0628\u0629 \u0641\u064A \u062D\u0627\u0644\u0629 \u062A\u0634\u063A\u064A\u0644 \u0639\u0646\u062F\u0645\u0627 \u064A\u0643\u0648\u0646 \u0627\u062B\u0646\u0627\u0646 \u0623\u0648 \u0623\u0643\u062B\u0631 \u0645\u0646 \u0627\u0644\u0645\u062F\u062E\u0644\u0627\u062A \u0627\u0644\u062B\u0644\u0627\u062B\u0629 \u0641\u064A \u062D\u0627\u0644\u0629 \u062A\u0634\u063A\u064A\u0644.",
  "hint.majority.1": "\u0642\u0627\u0631\u0646 \u0627\u0644\u0645\u062F\u062E\u0644\u0627\u062A \u0641\u064A \u0623\u0632\u0648\u0627\u062C: A \u0645\u0639 B\u060C \u0648A \u0645\u0639 C\u060C \u0648B \u0645\u0639 C.",
  "hint.majority.2": "\u0627\u062C\u0645\u0639 \u0646\u062A\u0627\u0626\u062C \u0627\u0644\u0623\u0632\u0648\u0627\u062C \u0628\u062D\u064A\u062B \u064A\u0624\u062F\u064A \u0623\u064A \u0645\u062F\u062E\u0644\u064A\u0646 \u0641\u064A \u062D\u0627\u0644\u0629 \u062A\u0634\u063A\u064A\u0644 \u0625\u0644\u0649 \u062A\u0634\u063A\u064A\u0644 \u0627\u0644\u0625\u062C\u0627\u0628\u0629.",
  "hint.mux2.0": "\u064A\u062D\u062F\u062F \u0627\u0644\u0645\u062D\u062F\u062F \u0623\u064A \u0627\u0644\u0645\u062F\u062E\u0644\u064A\u0646 \u0627\u0644\u0622\u062E\u0631\u064A\u0646 \u064A\u0635\u0644 \u0625\u0644\u0649 \u0627\u0644\u0625\u062C\u0627\u0628\u0629.",
  "hint.mux2.1": "\u0639\u0646\u062F\u0645\u0627 \u064A\u0643\u0648\u0646 \u0627\u0644\u0645\u062D\u062F\u062F \u0645\u062A\u0648\u0642\u0641\u064B\u0627 \u064A\u062C\u0628 \u0623\u0646 \u064A\u0641\u0648\u0632 A\u060C \u0648\u0639\u0646\u062F\u0645\u0627 \u064A\u0639\u0645\u0644 \u064A\u062C\u0628 \u0623\u0646 \u064A\u0641\u0648\u0632 B.",
  "hint.mux2.2": "\u0627\u0633\u062A\u062E\u062F\u0645 \u0627\u0644\u0645\u062D\u062F\u062F \u0644\u062A\u0634\u063A\u064A\u0644 \u0623\u0648 \u0625\u064A\u0642\u0627\u0641 \u0643\u0644 \u0645\u062F\u062E\u0644 \u0642\u0628\u0644 \u062F\u0645\u062C\u0647\u0645\u0627.",
  "hint.generic": "\u0627\u0631\u0628\u0637 \u0643\u0644 \u0627\u0644\u0645\u062F\u062E\u0644\u0627\u062A \u0648\u0627\u0644\u0645\u062E\u0631\u062C\u0627\u062A \u062B\u0645 \u0631\u0627\u062C\u0639 \u0627\u0644\u0641\u062D\u0648\u0635\u0627\u062A.",
  "wb.addNandAria": "\u0623\u0636\u0641 \u0645\u0643\u0648\u0651\u0646 \xAB\u0644\u064A\u0633-\u0643\u0644\u0627\u0647\u0645\u0627\xBB",
  "wb.addLatchAria": "\u0623\u0636\u0641 \u0645\u0643\u0648\u0651\u0646 \xAB\u0630\u0627\u0643\u0631\u0629\xBB",
  "wb.close": "\u0625\u063A\u0644\u0627\u0642",
  "wb.dismiss": "\u0625\u063A\u0644\u0627\u0642 \u0627\u0644\u062A\u0644\u0645\u064A\u062D",
  "wb.zoomOut": "\u062A\u0635\u063A\u064A\u0631",
  "wb.zoomIn": "\u062A\u0643\u0628\u064A\u0631",
  "wb.zoomFit": "\u0645\u0644\u0627\u0621\u0645\u0629 \u0627\u0644\u0628\u0646\u0627\u0621",
  "wb.fit": "\u0645\u0644\u0627\u0621\u0645\u0629",
  "wb.buildArea": "\u0645\u0646\u0637\u0642\u0629 \u0627\u0644\u0628\u0646\u0627\u0621",
  "wb.replace": "\u0627\u0633\u062A\u0628\u062F\u0627\u0644 \u0627\u0644\u0628\u0646\u0627\u0621",
  "wb.lookingUp": "\u062C\u0627\u0631\u064D \u0627\u0644\u0628\u062D\u062B \u0639\u0646 \u0623\u062D\u062F\u062B \u0627\u0644\u062A\u0632\u0627\u0645\u2026",
  "dyn.onOrOff": "\u064A\u0639\u0645\u0644 \u0623\u0648 \u0645\u062A\u0648\u0642\u0641",
  "dyn.startNode": "\u0628\u062F\u0627\u064A\u0629 {id}. \u062A\u0639\u0645\u0644 \u0623\u0648 \u0645\u062A\u0648\u0642\u0641\u0629.",
  "dyn.answerNode": "\u0628\u0646\u0627\u0624\u0643 \u064A\u062D\u062F\u062F \u0647\u0630\u0647 \u0627\u0644\u0625\u062C\u0627\u0628\u0629.",
  "dyn.remembersOne": "\u062A\u062D\u0641\u0638 \u0642\u064A\u0645\u0629 \u062A\u0634\u063A\u064A\u0644/\u0625\u064A\u0642\u0627\u0641 \u0648\u0627\u062D\u062F\u0629.",
  "dyn.value": "\u0627\u0644\u0642\u064A\u0645\u0629",
  "dyn.hold": "\u0627\u062D\u062A\u0641\u0627\u0638",
  "dyn.in": "\u062F\u062E\u0644",
  "dyn.yours": "\u0625\u062C\u0627\u0628\u062A\u0643",
  "dyn.checkColumn": "\u0641\u062D\u0635",
  "dyn.yes": "\u0646\u0639\u0645",
  "dyn.no": "\u0644\u0627",
  "dyn.by": "\u0628\u0648\u0627\u0633\u0637\u0629",
  "dyn.checkedBy": "\u062A\u0645 \u0627\u0644\u062A\u062D\u0642\u0642 \u0628\u0648\u0627\u0633\u0637\u0629 RAREXT",
  "dyn.moreInfo": "\u0645\u0632\u064A\u062F \u0645\u0646 \u0627\u0644\u0645\u0639\u0644\u0648\u0645\u0627\u062A",
  "dyn.remove": "\u0625\u0632\u0627\u0644\u0629",
  "dyn.latest": "\u0627\u0644\u0623\u062D\u062F\u062B",
  "dyn.sourceUsing": "\u064A\u064F\u0633\u062A\u062E\u062F\u0645 {source} \u0639\u0646\u062F {commit}.",
  "dyn.identitySharing": "\u062A\u0634\u0627\u0631\u0643 \u0628\u0627\u0633\u0645 @{handle}. \u064A\u062A\u0645 \u0627\u0644\u062A\u062D\u0642\u0642 \u0645\u0646 \u0623\u0628\u0646\u064A\u062A\u0643 \u062A\u0644\u0642\u0627\u0626\u064A\u064B\u0627.",
  "feed.emptyTitle": "\u0644\u0627 \u062A\u0648\u062C\u062F \u0623\u0628\u0646\u064A\u0629 \u0628\u0639\u062F",
  "feed.emptyCopy": "\u0643\u0646 \u0623\u0648\u0644 \u0645\u0646 \u064A\u0634\u0627\u0631\u0643 \u0628\u0646\u0627\u0621\u064B.",
  "feed.startBuilding": "\u0627\u0628\u062F\u0623 \u0627\u0644\u0628\u0646\u0627\u0621",
  "feed.loadErrorTitle": "\u062A\u0639\u0630\u0631 \u062A\u062D\u0645\u064A\u0644 \u0627\u0644\u0623\u0628\u0646\u064A\u0629",
  "feed.loadErrorCopy": "\u062A\u062D\u0642\u0642 \u0645\u0646 \u0627\u062A\u0635\u0627\u0644\u0643 \u0648\u062D\u0627\u0648\u0644 \u0645\u062C\u062F\u062F\u064B\u0627.",
  "feed.networksUnavailable": "\u0627\u0644\u0634\u0628\u0643\u0627\u062A \u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629 \u0627\u0644\u0622\u0646.",
  "feed.sharedPoints": "\u062A\u0645\u062A \u0627\u0644\u0645\u0634\u0627\u0631\u0643\u0629 \u0645\u0639 \u0627\u0644\u0645\u062C\u062A\u0645\u0639 \xB7 {score} \u0646\u0642\u0637\u0629",
  "feed.checkpointSaved": "\u062A\u0645 \u062D\u0641\u0638 \u0646\u0642\u0637\u0629 \u062A\u062D\u0642\u0642 \u0644\u0640 {count} \u0623\u0628\u0646\u064A\u0629.",
  "err.nameConflict": "\u0647\u0630\u0627 \u0627\u0644\u0645\u062A\u0635\u0641\u062D \u064A\u0634\u0627\u0631\u0643 \u0628\u0627\u0644\u0641\u0639\u0644 \u0628\u0627\u0633\u0645 @{existing}. \u0627\u0646\u0633\u064E \u0647\u0630\u0627 \u0627\u0644\u0627\u0633\u0645 \u0623\u0648\u0644\u064B\u0627 \u0644\u062A\u0634\u0627\u0631\u0643 \u0628\u0627\u0633\u0645 @{handle}.",
  "err.nameTaken": "\u0627\u0644\u0627\u0633\u0645 @{handle} \u0645\u0633\u062A\u062E\u062F\u0645 \u0628\u0627\u0644\u0641\u0639\u0644. \u0627\u062E\u062A\u0631 \u0627\u0633\u0645\u064B\u0627 \u0622\u062E\u0631 \u0623\u0648 \u0627\u0633\u062A\u062E\u062F\u0645 \u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0645\u062D\u0641\u0648\u0638 \u0639\u0644\u0649 \u0647\u0630\u0627 \u0627\u0644\u062C\u0647\u0627\u0632.",
  "err.saveName": "\u062A\u0639\u0630\u0631 \u062D\u0641\u0638 \u0627\u0633\u0645\u0643. \u062D\u0627\u0648\u0644 \u0645\u062C\u062F\u062F\u064B\u0627.",
  "err.nameInvalid": "\u064A\u0645\u0643\u0646 \u0623\u0646 \u064A\u062D\u062A\u0648\u064A \u0627\u0633\u0645\u0643 \u0639\u0644\u0649 \u062D\u0631\u0648\u0641 \u0635\u063A\u064A\u0631\u0629 \u0648\u0623\u0631\u0642\u0627\u0645 \u0648\u0634\u0631\u0637\u0627\u062A \u0648\u0634\u0631\u0637\u0627\u062A \u0633\u0641\u0644\u064A\u0629.",
  "err.nameRequired": "\u0633\u0645\u0651\u0650 \u0628\u0646\u0627\u0626\u0643 \u0623\u0648\u0644\u064B\u0627.",
  "err.connectBeforeShare": "\u0627\u0631\u0628\u0637 \u0643\u0644 \u0627\u0644\u0645\u0643\u0648\u0651\u0646\u0627\u062A \u0642\u0628\u0644 \u0627\u0644\u0645\u0634\u0627\u0631\u0643\u0629.",
  "err.share": "\u062A\u0639\u0630\u0631 \u0645\u0634\u0627\u0631\u0643\u0629 \u0628\u0646\u0627\u0626\u0643.",
  "err.feed": "\u0627\u0644\u062A\u063A\u0630\u064A\u0629 \u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629",
  "err.projectName": "\u0627\u0633\u062A\u062E\u062F\u0645 \u0627\u0633\u0645 \u0645\u0634\u0631\u0648\u0639 GitHub \u0645\u062B\u0644 owner/name.",
  "err.readProject": "\u062A\u0639\u0630\u0631 \u0642\u0631\u0627\u0621\u0629 \u0647\u0630\u0627 \u0627\u0644\u0645\u0634\u0631\u0648\u0639.",
  "err.anchor": "\u062A\u0639\u0630\u0631 \u062D\u0641\u0638 \u0646\u0642\u0637\u0629 \u0627\u0644\u062A\u062D\u0642\u0642.",
  "err.check": "\u062A\u0639\u0630\u0631 \u0627\u0644\u062A\u062D\u0642\u0642 \u0645\u0646 \u0647\u0630\u0627 \u0627\u0644\u0628\u0646\u0627\u0621.",
  "toast.nameRemoved": "\u062A\u0645\u062A \u0625\u0632\u0627\u0644\u0629 \u0627\u0644\u0627\u0633\u0645 \u0645\u0646 \u0647\u0630\u0627 \u0627\u0644\u062C\u0647\u0627\u0632.",
  "toast.sourceCleared": "\u062A\u0645 \u0645\u0633\u062D \u0627\u0644\u0645\u0635\u062F\u0631. \u064A\u0628\u0642\u0649 \u0627\u0644\u0628\u0646\u0627\u0621.",
  "toast.codeCopied": "\u062A\u0645 \u0646\u0633\u062E \u0643\u0648\u062F \u0627\u0644\u0628\u0646\u0627\u0621.",
  "toast.clipboard": "\u0627\u0644\u062D\u0627\u0641\u0638\u0629 \u063A\u064A\u0631 \u0645\u062A\u0627\u062D\u0629.",
  "toast.shared": "\u062A\u0645\u062A \u0627\u0644\u0645\u0634\u0627\u0631\u0643\u0629! \u0628\u0646\u0627\u0624\u0643 \u0627\u0644\u0622\u0646 \u0645\u0628\u0627\u0634\u0631.",
  "toast.buildImported": "\u062A\u0645 \u0627\u0633\u062A\u064A\u0631\u0627\u062F \u0627\u0644\u0628\u0646\u0627\u0621. \u0633\u064A\u0646\u062A\u0642\u0644 \u0627\u0644\u0645\u0635\u062F\u0631 \u0627\u0644\u0645\u062B\u0628\u0651\u062A \u0645\u0639\u0647.",
  "toast.projectPinned": "\u062A\u0645 \u062A\u062B\u0628\u064A\u062A \u0627\u0644\u0645\u0634\u0631\u0648\u0639. \u0623\u0636\u0641 \u0645\u0644\u0641 \u0628\u0646\u0627\u0621 \u0644\u0627\u0633\u062A\u064A\u0631\u0627\u062F \u0622\u0644\u0629.",
  "toast.buildCopied": "\u062A\u0645 \u0646\u0633\u062E \u0627\u0644\u0628\u0646\u0627\u0621. \u0633\u064A\u064F\u0646\u0633\u0628 \u0627\u0644\u0641\u0636\u0644 \u0625\u0644\u0649 \u0627\u0644\u0623\u0635\u0644.",
  "toast.opened": "\u062A\u0645 \u0627\u0644\u0641\u062A\u062D \u0641\u064A \u0627\u0644\u0639\u0628.",
  "toast.verified": "\u0646\u062C\u062D\u062A \u0627\u0644\u0641\u062D\u0648\u0635\u0627\u062A. \u0647\u0630\u0627 \u0627\u0644\u0628\u0646\u0627\u0621 \u064A\u0637\u0627\u0628\u0642 \u0627\u0644\u0623\u0635\u0644.",
  "toast.mismatch": "\u0647\u0630\u0627 \u0627\u0644\u0628\u0646\u0627\u0621 \u063A\u064A\u0631 \u0645\u0637\u0627\u0628\u0642. \u0631\u0628\u0645\u0627 \u062A\u063A\u064A\u0651\u0631.",
  "toast.checkpointNone": "\u0644\u0627 \u062A\u0648\u062C\u062F \u0623\u0628\u0646\u064A\u0629 \u062C\u062F\u064A\u062F\u0629 \u0644\u062D\u0641\u0638\u0647\u0627.",
  "nav.rewards": "\u0627\u0644\u0645\u0643\u0627\u0641\u0622\u062A",
  "rewards.title": "\u0639\u0645\u0644\u0643\u060C \u0631\u0635\u064A\u062F\u0643",
  "rewards.credits": "\u0627\u0644\u0631\u0635\u064A\u062F",
  "rewards.board": "\u0637\u0631\u0642 \u0627\u0644\u0643\u0633\u0628",
  "rewards.work": "\u0627\u0628\u062F\u0623 \u0627\u0644\u0639\u0645\u0644",
  "rewards.empty": "\u0644\u0627 \u064A\u0648\u062C\u062F \u0639\u0645\u0644 \u0645\u062A\u0627\u062D \u0627\u0644\u0622\u0646.",
  "action.verify": "\u062A\u062D\u0642\u0651\u0642 \u0645\u0646 \u0628\u0646\u0627\u0621",
  "action.store": "\u0627\u062D\u062A\u0641\u0638 \u0628\u0627\u0644\u0628\u064A\u0627\u0646\u0627\u062A",
  "action.mirror": "\u0627\u0639\u0643\u0633 \u0627\u0644\u0633\u062C\u0644",
  "action.relay": "\u0623\u0639\u0650\u062F \u0628\u062B\u0651 \u0645\u0631\u0633\u0627\u0629",
  "action.publish": "\u0627\u0646\u0634\u0631 \u0628\u0646\u0627\u0621",
  "action.remix": "\u0623\u0639\u062F \u0645\u0632\u062C \u0628\u0646\u0627\u0621",
  "action.report": "\u0623\u0628\u0644\u063A \u0639\u0646 \u0627\u062F\u0639\u0627\u0621 \u062E\u0627\u0637\u0626",
  "crypto.pq": "PQ",
  "crypto.pqTitle": "\u0645\u0648\u0642\u0651\u0639 \u0628\u0645\u0641\u062A\u0627\u062D \u0645\u0627 \u0628\u0639\u062F \u0627\u0644\u0643\u0645",
  "nav.market": "\u0627\u0644\u0633\u0648\u0642",
  "market.title": "\u0627\u0644\u0633\u0648\u0642",
  "market.participants": "\u0627\u0644\u0645\u0634\u0627\u0631\u0643\u0648\u0646",
  "market.listings": "\u0627\u0644\u0639\u0631\u0648\u0636",
  "market.answers": "\u0625\u062C\u0627\u0628\u0627\u062A \u0627\u0644\u0634\u0628\u0643\u0629",
  "market.price": "\u0627\u0644\u0633\u0639\u0631",
  "market.kind": "\u0627\u0644\u0646\u0648\u0639",
  "market.empty": "\u0644\u0627 \u064A\u0648\u062C\u062F \u0634\u064A\u0621 \u0647\u0646\u0627 \u0628\u0639\u062F.",
  "market.contributors": "{n} \u0645\u0633\u0627\u0647\u0645",
  "rewards.open": "{n} \u0645\u0641\u062A\u0648\u062D"
};
var dictionaries = {
  "zh-Hans": zhHans,
  "zh-Hant": zhHant,
  es,
  fr,
  pt,
  ja,
  ar
};
var DICTIONARIES = {
  en,
  ...dictionaries
};
var active = "en";
function detect() {
  const query = new URLSearchParams(window.location.search).get("lang");
  if (query && LOCALES.includes(query)) {
    return query;
  }
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored && LOCALES.includes(stored)) {
    return stored;
  }
  for (const language of navigator.languages ?? [navigator.language]) {
    const lower = language.toLowerCase();
    if (lower.startsWith("zh")) {
      return /hant|tw|hk|mo/.test(lower) ? "zh-Hant" : "zh-Hans";
    }
    if (lower.startsWith("es")) return "es";
    if (lower.startsWith("fr")) return "fr";
    if (lower.startsWith("pt")) return "pt";
    if (lower.startsWith("ja")) return "ja";
    if (lower.startsWith("ar")) return "ar";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}
function t(key, values = {}, fallback) {
  const template = active === "en" ? en[key] ?? fallback ?? key : dictionaries[active][key] ?? en[key] ?? fallback ?? key;
  return template.replace(
    /\{(\w+)\}/g,
    (_, name) => values[name] === void 0 ? `{${name}}` : String(values[name])
  );
}
function localeTag() {
  return active;
}
function setLocale(locale) {
  window.localStorage.setItem(STORAGE_KEY, locale);
  const url = new URL(window.location.href);
  url.searchParams.set("lang", locale);
  window.location.assign(url.toString());
}
function initI18n() {
  active = detect();
  document.documentElement.lang = active;
  document.documentElement.dir = active === "ar" ? "rtl" : "ltr";
  document.title = t("page.title");
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = t("page.description");
  const select = document.getElementById("locale-select");
  if (select) {
    select.innerHTML = LOCALES.map(
      (locale) => `<option value="${locale}"${locale === active ? " selected" : ""}>${LOCALE_NAMES[locale]}</option>`
    ).join("");
    select.setAttribute("aria-label", t("lang"));
    select.addEventListener("change", () => setLocale(select.value));
  }
  applyTranslations();
}
function applyTranslations(root = document) {
  root.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n ?? "");
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    element.setAttribute("placeholder", t(element.dataset.i18nPlaceholder ?? ""));
  });
  root.querySelectorAll("[data-i18n-aria]").forEach((element) => {
    element.setAttribute("aria-label", t(element.dataset.i18nAria ?? ""));
  });
  root.querySelectorAll("[data-i18n-title]").forEach((element) => {
    element.setAttribute("title", t(element.dataset.i18nTitle ?? ""));
  });
  root.querySelectorAll("[data-i18n-content]").forEach((element) => {
    element.setAttribute("content", t(element.dataset.i18nContent ?? ""));
  });
}

// apps/web/src/bem.ts
var DEFAULT_DECIMALS = 18;
var MAX_DECIMALS = 36;
function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function group(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function decimalsOf(value) {
  const decimals = Number(value);
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_DECIMALS ? decimals : DEFAULT_DECIMALS;
}
function parseBemStatus(value) {
  const record = value ?? {};
  return {
    configured: record.configured === true,
    chainId: asString(record.chainId),
    blockNumber: asString(record.blockNumber),
    bemContract: asString(record.bemContract),
    bemDecimals: decimalsOf(record.bemDecimals),
    address: asString(record.address),
    bemBalance: asString(record.bemBalance),
    error: typeof record.error === "string" ? record.error : void 0
  };
}
function formatTokenAmount(raw, decimals) {
  const digits = raw.replace(/^0+(?=\d)/, "") || "0";
  const scale = decimalsOf(decimals);
  if (scale === 0) return group(digits);
  const padded = digits.padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction ? `${group(whole)}.${fraction}` : group(whole);
}
function bemReadout(status) {
  if (!status.configured || !status.address) return { kind: "empty" };
  if (status.error || status.bemBalance === null) return { kind: "unavailable" };
  return { kind: "amount", amount: formatTokenAmount(status.bemBalance, status.bemDecimals) };
}

// apps/web/src/work.ts
async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function submissionDigest(submission) {
  return sha256Hex(
    canonicalize({
      challengeId: submission.challengeId,
      artifact: submission.artifact,
      attestation: submission.attestation,
      worker: { keyId: submission.worker.keyId }
    })
  );
}
async function signDigest(digest, privateKey) {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(digest)
  );
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}
async function runWork(options) {
  const base = options.baseUrl ?? "";
  const results = [];
  const board = await (await fetch(`${base}/v1/work?keyId=${encodeURIComponent(options.identity.keyId)}`)).json();
  const limit = options.limit ?? 3;
  for (const order of board.orders.slice(0, limit)) {
    const result = {
      orderId: order.id,
      challengeId: order.challengeId,
      bounty: order.bounty,
      accepted: false,
      error: null,
      correct: false,
      score: 0
    };
    try {
      if (!order.verifier) {
        result.error = "no portable verifier for this app yet";
        results.push(result);
        options.onProgress?.(result);
        continue;
      }
      const module = await import(
        /* @vite-ignore */
        `${base}${order.verifier.url}`
      );
      const outcome = module.verify(order.artifact, order.challenge);
      const circuitHash = await sha256Hex(canonicalize(order.artifact));
      const traceHash = await sha256Hex(canonicalize(outcome.proof));
      const submission = {
        challengeId: order.challengeId,
        artifact: order.artifact,
        attestation: {
          circuitHash,
          traceHash,
          correct: outcome.correct,
          score: outcome.score,
          gateCount: outcome.gateCount,
          proof: outcome.proof
        },
        worker: { keyId: options.identity.keyId }
      };
      const digest = await submissionDigest(submission);
      const signature = await signDigest(digest, options.identity.privateKey);
      const response = await fetch(`${base}/v1/verifications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...submission,
          worker: {
            keyId: options.identity.keyId,
            publicKey: options.identity.publicKey,
            signature
          }
        })
      });
      const payload = await response.json();
      result.accepted = response.ok && payload.accepted === true;
      result.error = payload.error ?? null;
      result.correct = outcome.correct;
      result.score = outcome.score;
      result.bounty = payload.bounty ?? order.bounty;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    }
    results.push(result);
    options.onProgress?.(result);
  }
  return results;
}

// apps/web/src/verify.ts
function localVerdict(serverValid, local) {
  return serverValid && (local?.correct ?? true);
}

// apps/web/src/main.ts
var NODE_WIDTH = 144;
var NODE_HEIGHT = 64;
var SVG_WIDTH = 1e3;
var SVG_HEIGHT = 640;
var PAGE_SIZE = 10;
var STORAGE_PREFIX = "rarext:circuit:";
var DRAFT_PREFIX = "rarext:draft:";
var HANDLE_KEY = "rarext:handle";
var IDENTITY_KEY = "rarext:identity:v1";
var WELCOME_KEY = "rarext:welcomed:v1";
var CANVAS_HELP_KEY = "rarext:canvas-help-dismissed:v1";
var BEM_ADDRESS_KEY = "rarext:bem-address";
var HINTS = {
  "half-adder": [
    "NOT-BOTH turns off only when both of its inputs are on. Start there.",
    "The answer is on when exactly one start is on. That takes four NOT-BOTH blocks.",
    "The extra is on only when both starts are on. One block can make that.",
    "Try one NOT-BOTH on both starts, then use its result to build the answer and the extra."
  ],
  majority: [
    "The answer turns on when at least two of the three starts are on.",
    "Compare the starts in pairs: A with B, A with C, and B with C.",
    "Combine the pair results so that any two on values turn the answer on."
  ],
  mux2: [
    "The chooser decides which of the other two starts reaches the answer.",
    "When the chooser is off, A should win. When it is on, B should win.",
    "Use the chooser to switch each start on or off before combining them."
  ]
};
var ARITY2 = {
  INPUT: 0,
  OUTPUT: 1,
  NAND: 2,
  LATCH: 2
};
function el(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element: ${id}`);
  return element;
}
var svg = el("canvas");
var taskSelect = el("task-select");
var taskDescription = el("task-description");
var taskProgress = el("task-progress");
var challengeDots = el("challenge-dots");
var sponsoredChallengesEl = el("sponsored-challenges");
var sponsoredChallengeItems = el("sponsored-challenge-items");
var truthTable = el("truth-table");
var testSummary = el("test-summary");
var scoreStatus = el("score-status");
var scoreCases = el("score-cases");
var scoreGates = el("score-gates");
var scoreValue = el("score-value");
var scoreMeter = el("score-meter");
var scoreMeterBar = el("score-meter-bar");
var checkMeter = el("check-meter");
var checkMeterBar = el("check-meter-bar");
var shareLocked = el("share-locked");
var shareSection = el("share-section");
var shareLockedCopy = el("share-locked-copy");
var hintButton = el("hint-button");
var hintBox = el("hint-box");
var nextStepPanel = el("next-step");
var nextPuzzleButton = el("next-puzzle");
var canvasHelp = el("canvas-help");
var canvasHelpText = el("canvas-help-text");
var dismissCanvasHelpButton = el("dismiss-canvas-help");
var viewBoardButton = el("view-board");
var welcomeEl = el("welcome");
var welcomeCloseButton = el("welcome-close");
var welcomeStartButton = el("welcome-start");
var welcomeExploreButton = el("welcome-explore");
var openGuideButton = el("open-guide");
var authorInput = el("author");
var titleInput = el("title");
var bodyInput = el("body");
var publishStatus = el("publish-status");
var feedEl = el("feed");
var toastEl = el("toast");
var remixBanner = el("remix-banner");
var remixTitle = el("remix-title");
var identityStatus = el("identity-status");
var resetIdentityButton = el("reset-identity");
var loadMoreButton = el("load-more");
var rewardsTotal = el("rewards-total");
var rewardsActions = el("rewards-actions");
var rewardsOrders = el("rewards-orders");
var rewardsWork = el("rewards-work");
var marketParticipants = el("market-participants");
var marketListings = el("market-listings");
var marketAnswers = el("market-answers");
var anchorFeedButton = el("anchor-feed");
var chainStatus = el("chain-status");
var adapterList = el("adapter-list");
var bemAddressInput = el("bem-address");
var bemCheckButton = el("bem-check");
var bemBalance = el("bem-balance");
var sourceRepoInput = el("source-repo");
var sourcePathInput = el("source-path");
var importSourceButton = el("import-source");
var clearSourceButton = el("clear-source");
var sourceStatus = el("source-status");
var nodes = [];
var taskId = tasks[0]?.id ?? "";
var selectedId = null;
var pendingSource = null;
var parentId = null;
var remixSourceTitle = null;
var source = null;
var drag = null;
var pan = null;
var pinch = null;
var feedItems = [];
var appNames = {};
var challengeTitles = {};
var challengeSpecs = {};
var sponsoredChallenges = [];
var sponsoredChallengeIds = /* @__PURE__ */ new Set();
var feedOffset = 0;
var feedHasMore = false;
var toastTimer;
var hintIndex = 0;
var view = { x: 0, y: 0, w: SVG_WIDTH };
var touchPoints = /* @__PURE__ */ new Map();
function mirrorResponse(path) {
  const bundle = window.__RAREXT_BUNDLE__;
  if (!bundle) return null;
  const url = new URL(path, "https://mirror.invalid");
  const publications = [...bundle.publications].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt)
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
      url: null
    }));
  }
  if (url.pathname === "/v1/adapters") return [];
  if (url.pathname === "/v1/tapeout/status") {
    return { configured: false, chainId: null, blockNumber: null };
  }
  return null;
}
async function apiGet(path) {
  const mirrored = mirrorResponse(path);
  if (mirrored !== null) return mirrored;
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${response.status} ${path}`);
  return response.json();
}
function currentTask() {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("unknown task");
  return task;
}
function taskTitleFor(task) {
  return t(`task.${task.id}.title`, {}, task.title);
}
function taskDescriptionFor(task) {
  return t(`task.${task.id}.description`, {}, task.description);
}
function escapeHtml(value) {
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
function displayName(id) {
  if (id === "sel") return t("dyn.chooser");
  if (id === "sum" || id === "y") return t("dyn.answer");
  if (id === "carry") return t("dyn.extra");
  if (id === "a" || id === "b" || id === "c") return id.toUpperCase();
  return id;
}
function bitName(value) {
  if (value === "1") return t("dyn.on");
  if (value === "0") return t("dyn.off");
  return value;
}
function bitCell(value) {
  const state = value === "1" ? "on" : value === "0" ? "off" : "unknown";
  return `<td><span class="bit ${state}">${escapeHtml(bitName(value))}</span></td>`;
}
function shortHash(hash) {
  return hash.length <= 20 ? hash : `${hash.slice(0, 10)}\u2026${hash.slice(-6)}`;
}
function isComponentType(value) {
  return value === "INPUT" || value === "OUTPUT" || value === "NAND" || value === "LATCH";
}
function isUiNode(value) {
  if (typeof value !== "object" || value === null) return false;
  const node = value;
  return typeof node.id === "string" && isComponentType(node.type) && typeof node.x === "number" && typeof node.y === "number" && Array.isArray(node.inputs) && node.inputs.every((input) => typeof input === "string");
}
function defaultNodes(task) {
  const result = [];
  const inputOffset = (task.inputs.length - 1) * 110 / 2;
  const outputOffset = (task.outputs.length - 1) * 110 / 2;
  task.inputs.forEach((id, index) => {
    result.push({
      id,
      type: "INPUT",
      x: 60,
      y: 250 - inputOffset + index * 110,
      inputs: []
    });
  });
  task.outputs.forEach((id, index) => {
    result.push({
      id,
      type: "OUTPUT",
      x: SVG_WIDTH - NODE_WIDTH - 60,
      y: 250 - outputOffset + index * 110,
      inputs: [""]
    });
  });
  return result;
}
function nodesFromCircuit(circuit) {
  const byId = new Map(circuit.components.map((component) => [component.id, component]));
  const memo = /* @__PURE__ */ new Map();
  const visiting = /* @__PURE__ */ new Set();
  const depthOf = (component) => {
    const cached = memo.get(component.id);
    if (cached !== void 0) return cached;
    if (component.type === "INPUT") {
      memo.set(component.id, 0);
      return 0;
    }
    if (visiting.has(component.id)) return 0;
    visiting.add(component.id);
    const sources = component.inputs ?? [];
    const depth = 1 + Math.max(
      0,
      ...sources.map((id) => {
        const source2 = byId.get(id);
        return source2 ? depthOf(source2) : 0;
      })
    );
    visiting.delete(component.id);
    memo.set(component.id, depth);
    return depth;
  };
  const gates = circuit.components.filter(
    (component) => component.type === "NAND" || component.type === "LATCH"
  );
  const columns = /* @__PURE__ */ new Map();
  for (const gate of gates) {
    const depth = Math.max(1, depthOf(gate));
    const column = columns.get(depth) ?? [];
    column.push(gate);
    columns.set(depth, column);
  }
  const maxDepth = Math.max(1, ...columns.keys());
  const outputX = Math.min(
    SVG_WIDTH - NODE_WIDTH - 60,
    Math.max(700, 300 + maxDepth * 165)
  );
  const place = (component, x, y) => ({
    id: component.id,
    type: component.type,
    x,
    y,
    inputs: Array.from(
      { length: ARITY2[component.type] },
      (_, index) => component.inputs?.[index] ?? ""
    )
  });
  const inputs = circuit.components.filter((component) => component.type === "INPUT");
  const outputs = circuit.components.filter((component) => component.type === "OUTPUT");
  const inputOffset = (inputs.length - 1) * 110 / 2;
  const outputOffset = (outputs.length - 1) * 110 / 2;
  const result = [];
  inputs.forEach((component, index) => {
    result.push(place(component, 60, 250 - inputOffset + index * 110));
  });
  for (const [depth, column] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    const offset = (column.length - 1) * 110 / 2;
    column.forEach((component, index) => {
      result.push(
        place(component, 300 + (depth - 1) * 165, 250 - offset + index * 110)
      );
    });
  }
  outputs.forEach((component, index) => {
    result.push(place(component, outputX, 250 - outputOffset + index * 110));
  });
  return result;
}
function saveNodes() {
  try {
    localStorage.setItem(STORAGE_PREFIX + taskId, JSON.stringify(nodes));
  } catch {
    return;
  }
}
function loadNodes(task) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + task.id);
    if (!raw) return defaultNodes(task);
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isUiNode)) return defaultNodes(task);
    return parsed;
  } catch {
    return defaultNodes(task);
  }
}
function saveDraft() {
  try {
    const draft = {
      title: titleInput.value,
      body: bodyInput.value,
      parentId,
      remixSourceTitle,
      source
    };
    localStorage.setItem(DRAFT_PREFIX + taskId, JSON.stringify(draft));
  } catch {
    return;
  }
}
function loadDraft(id) {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + id);
    if (!raw) {
      return { title: "", body: "", parentId: null, remixSourceTitle: null, source: null };
    }
    const parsed = JSON.parse(raw);
    return {
      title: typeof parsed.title === "string" ? parsed.title : "",
      body: typeof parsed.body === "string" ? parsed.body : "",
      parentId: typeof parsed.parentId === "string" ? parsed.parentId : null,
      remixSourceTitle: typeof parsed.remixSourceTitle === "string" ? parsed.remixSourceTitle : null,
      source: isPublicationSource(parsed.source) ? parsed.source : null
    };
  } catch {
    return { title: "", body: "", parentId: null, remixSourceTitle: null, source: null };
  }
}
function isPublicationSource(value) {
  if (!value || typeof value !== "object") return false;
  const source2 = value;
  return (source2.kind === "github" || source2.kind === "gitlab" || source2.kind === "codeberg" || source2.kind === "url") && typeof source2.url === "string" && typeof source2.commit === "string";
}
function loadStoredIdentity() {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed.handle !== "string" || typeof parsed.keyId !== "string" || typeof parsed.publicKey !== "object" || typeof parsed.privateKey !== "object") {
      return null;
    }
    return {
      handle: parsed.handle,
      keyId: parsed.keyId,
      publicKey: parsed.publicKey,
      privateKey: parsed.privateKey
    };
  } catch {
    return null;
  }
}
function renderIdentityStatus() {
  const identity = loadStoredIdentity();
  if (!identity) {
    identityStatus.textContent = t("wb.identity");
    resetIdentityButton.classList.add("hidden");
    return;
  }
  identityStatus.textContent = t("dyn.identitySharing", { handle: identity.handle });
  resetIdentityButton.classList.remove("hidden");
}
function buildCircuit() {
  return {
    components: nodes.map(
      (node) => node.type === "INPUT" ? { id: node.id, type: node.type } : { id: node.id, type: node.type, inputs: [...node.inputs] }
    )
  };
}
function isComplete() {
  const ids = new Set(nodes.map((node) => node.id));
  return nodes.every((node) => {
    if (node.inputs.length !== ARITY2[node.type]) return false;
    return node.inputs.every((input) => input !== "" && ids.has(input));
  });
}
function evaluateCircuit() {
  const task = currentTask();
  if (!isComplete()) {
    return { cases: [], design: null, error: t("dyn.connectAll") };
  }
  try {
    const circuit = buildCircuit();
    const design = score(circuit, task);
    const cases = task.cases.map((testCase) => {
      const result = simulate(circuit, testCase.inputs);
      const pass = result.settled && task.outputs.every((name) => result.outputs[name] === testCase.outputs[name]);
      return {
        inputValues: task.inputs.map((name) => String(testCase.inputs[name])),
        expectedValues: task.outputs.map((name) => String(testCase.outputs[name])),
        actualValues: result.settled ? task.outputs.map((name) => String(result.outputs[name] ?? "?")) : task.outputs.map(() => "\u2014"),
        pass
      };
    });
    return { cases, design, error: null };
  } catch (error) {
    return {
      cases: [],
      design: null,
      error: error instanceof Error ? error.message : "simulation failed"
    };
  }
}
function inputPortPosition(node, index) {
  const count = Math.max(ARITY2[node.type], 1);
  return {
    x: node.x,
    y: node.y + NODE_HEIGHT * (index + 1) / (count + 1)
  };
}
function outputPortPosition(node) {
  return { x: node.x + NODE_WIDTH, y: node.y + NODE_HEIGHT / 2 };
}
function containerAspect() {
  const rect = svg.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return rect.width / rect.height;
  }
  return SVG_WIDTH / SVG_HEIGHT;
}
function viewHeight() {
  return view.w / containerAspect();
}
function applyView() {
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${viewHeight()}`);
}
function fitView() {
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
  const width = mobile ? Math.max(minWidth, Math.min(contentWidth, 1e3)) : Math.min(Math.max(contentWidth, minWidth), 1300);
  const height = width / aspect;
  view = {
    x: (minX + maxX) / 2 - width / 2,
    y: (minY + maxY) / 2 - height / 2,
    w: width
  };
  applyView();
}
function zoomAt(point, factor) {
  const nextWidth = Math.min(1600, Math.max(320, view.w / factor));
  const ratio = nextWidth / view.w;
  view.x = point.x - (point.x - view.x) * ratio;
  view.y = point.y - (point.y - view.y) * ratio;
  view.w = nextWidth;
  applyView();
}
function zoomBy(factor) {
  zoomAt(
    { x: view.x + view.w / 2, y: view.y + viewHeight() / 2 },
    factor
  );
}
function renderCanvas() {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const parts = [];
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
    `<rect x="-4000" y="-4000" width="8000" height="8000" fill="url(#grid-major)" />`
  );
  for (const node of nodes) {
    for (let index = 0; index < node.inputs.length; index++) {
      const source2 = byId.get(node.inputs[index] ?? "");
      if (!source2 || source2.type === "OUTPUT") continue;
      const from = outputPortPosition(source2);
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
    const portCount = ARITY2[node.type];
    const label = node.type === "INPUT" ? `${t("dyn.start")} ${displayName(node.id).toUpperCase()}` : node.type === "OUTPUT" ? displayName(node.id).toUpperCase() : node.type === "LATCH" ? t("wb.memory") : t("wb.notBoth");
    const sublabel = node.type === "INPUT" ? t("dyn.onOrOff") : node.type === "OUTPUT" ? t("dyn.yourAnswer") : node.type === "LATCH" ? t("dyn.remembers") : t("wb.notBothShort");
    const description = node.type === "INPUT" ? t("dyn.startNode", { id: displayName(node.id) }) : node.type === "OUTPUT" ? t("dyn.answerNode", { id: displayName(node.id) }) : node.type === "LATCH" ? t("dyn.remembersOne") : t("dyn.notBothDesc");
    parts.push(
      `<g class="node ${typeClass}${selected}" data-node="${escapeHtml(node.id)}" transform="translate(${node.x}, ${node.y})">`
    );
    parts.push(`<title>${escapeHtml(description)}</title>`);
    parts.push(
      `<rect class="node-body" width="${NODE_WIDTH}" height="${NODE_HEIGHT}" rx="12" />`
    );
    parts.push(
      `<line class="node-gloss" x1="15" y1="0.8" x2="${NODE_WIDTH - 15}" y2="0.8" />`
    );
    parts.push(
      `<text class="label" x="20" y="27">${escapeHtml(label)}</text>`
    );
    parts.push(
      `<text class="id" x="20" y="45">${escapeHtml(sublabel)}</text>`
    );
    for (let index = 0; index < portCount; index++) {
      const position = inputPortPosition({ ...node, x: 0, y: 0 }, index);
      const label2 = node.type === "LATCH" ? index === 0 ? t("dyn.value") : t("dyn.hold") : node.type === "OUTPUT" ? t("dyn.in") : String.fromCharCode(65 + index);
      parts.push(
        `<text class="arity" x="${position.x - 8}" y="${position.y + 3.5}" text-anchor="end">${escapeHtml(label2)}</text>`,
        `<circle class="port in" cx="${position.x}" cy="${position.y}" r="5" data-port="in" data-node="${escapeHtml(node.id)}" data-index="${index}" />`
      );
    }
    if (node.type !== "OUTPUT") {
      parts.push(
        `<circle class="port out${pending}" cx="${NODE_WIDTH}" cy="${NODE_HEIGHT / 2}" r="6" data-port="out" data-node="${escapeHtml(node.id)}" />`
      );
    }
    parts.push("</g>");
  }
  parts.push(`<path class="wire-ghost" id="wire-ghost" d="" />`);
  svg.innerHTML = parts.join("");
}
function updateGhostWire(point) {
  const ghost = svg.querySelector("#wire-ghost");
  if (!(ghost instanceof SVGPathElement)) return;
  const source2 = pendingSource ? nodeById(pendingSource) : void 0;
  if (!source2 || !point) {
    ghost.setAttribute("d", "");
    return;
  }
  const from = outputPortPosition(source2);
  const bend = Math.max(40, Math.abs(point.x - from.x) / 2);
  ghost.setAttribute(
    "d",
    `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${point.x - bend} ${point.y}, ${point.x} ${point.y}`
  );
}
function setMeter(meter, ratio, state) {
  meter.style.width = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
  meter.className = `meter-fill ${state}`;
}
function renderScore(evaluation) {
  const complete = isComplete();
  if (evaluation.error) {
    scoreStatus.textContent = complete ? t("dyn.almost") : t("dyn.notYet");
    scoreStatus.className = "status-pill idle";
    scoreCases.textContent = "\u2014";
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
      total: evaluation.design.total
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
function renderTestSummary(evaluation) {
  if (evaluation.error || !evaluation.design) {
    testSummary.textContent = t("wb.notYet");
    testSummary.className = "status-pill idle";
    return;
  }
  const passed = evaluation.cases.filter((row) => row.pass).length;
  testSummary.textContent = t("dyn.checksRight", {
    done: passed,
    total: evaluation.cases.length
  });
  testSummary.className = `status-pill ${evaluation.design.correct ? "ok" : "bad"}`;
}
function renderNextStep(evaluation) {
  if (!evaluation.design?.correct) {
    nextStepPanel.classList.add("hidden");
    return;
  }
  const index = tasks.findIndex((task) => task.id === taskId);
  const next = tasks[index + 1];
  nextStepPanel.classList.remove("hidden");
  nextPuzzleButton.textContent = next ? t("dyn.next", { title: taskTitleFor(next) }) : t("dyn.seeCommunity");
}
function updateCanvasHelp() {
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
    (node) => node.type === "NAND" || node.type === "LATCH"
  ).length;
  canvasHelp.classList.remove("hidden");
  canvasHelpText.textContent = gates === 0 ? t("dyn.startHint") : t("dyn.linkHint");
}
function scrollToBoard() {
  if (!window.matchMedia("(max-width: 1080px)").matches) return;
  svg.closest(".canvas-wrap")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderTruthTable(evaluation) {
  const task = currentTask();
  if (evaluation.error) {
    truthTable.classList.add("bare");
    truthTable.innerHTML = `<div class="empty">${escapeHtml(evaluation.error)}</div>`;
    return;
  }
  truthTable.classList.remove("bare");
  const inputHeaders = task.inputs.map((name) => `<th rowspan="2">${escapeHtml(displayName(name))}</th>`).join("");
  const outputHeaders = task.outputs.map((name) => `<th>${escapeHtml(displayName(name))}</th>`).join("");
  const span = task.outputs.length;
  const header = `<tr>${inputHeaders}<th colspan="${span}">${escapeHtml(t("dyn.answer"))}</th><th colspan="${span}">${escapeHtml(t("dyn.yours"))}</th><th rowspan="2">${escapeHtml(t("dyn.checkColumn"))}</th></tr><tr>${outputHeaders}${outputHeaders}</tr>`;
  const rows = evaluation.cases.map((row) => {
    const inputCells = row.inputValues.map(bitCell).join("");
    const expectedCells = row.expectedValues.map(bitCell).join("");
    const actualCells = row.actualValues.map(bitCell).join("");
    return `<tr>${inputCells}${expectedCells}${actualCells}<td class="${row.pass ? "pass" : "fail"}">${escapeHtml(row.pass ? t("dyn.yes") : t("dyn.no"))}</td></tr>`;
  }).join("");
  truthTable.innerHTML = `<table><thead>${header}</thead><tbody>${rows}</tbody></table>`;
}
function renderShareState(evaluation) {
  const solved = evaluation.design?.correct === true;
  shareLocked.classList.toggle("hidden", solved);
  shareSection.classList.toggle("hidden", !solved);
  if (!solved) {
    shareLockedCopy.textContent = evaluation.error ? t("dyn.connectAll") : t("dyn.solveToShare");
  }
}
function renderRemix() {
  if (parentId && remixSourceTitle) {
    remixBanner.classList.remove("hidden");
    remixTitle.textContent = t("dyn.copyOf", { title: remixSourceTitle });
    return;
  }
  remixBanner.classList.add("hidden");
}
function render() {
  const evaluation = evaluateCircuit();
  renderCanvas();
  renderScore(evaluation);
  renderTruthTable(evaluation);
  renderRemix();
  taskDescription.textContent = taskDescriptionFor(currentTask());
}
function saveAndRender() {
  saveNodes();
  render();
}
function toSvgPoint(event) {
  const point = svg.createSVGPoint();
  point.x = event.clientX;
  point.y = event.clientY;
  const matrix = svg.getScreenCTM();
  if (!matrix) return { x: 0, y: 0 };
  const transformed = point.matrixTransform(matrix.inverse());
  return { x: transformed.x, y: transformed.y };
}
function nodeById(id) {
  return nodes.find((node) => node.id === id);
}
function connect(targetId, index) {
  if (!pendingSource) {
    toast(t("dyn.startGreen"), true);
    return;
  }
  const source2 = nodeById(pendingSource);
  const target = nodeById(targetId);
  if (!source2 || source2.type === "OUTPUT" || !target) {
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
  const group2 = target.closest("[data-node]");
  if (!group2) {
    selectedId = null;
    pendingSource = null;
    pan = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      viewX: view.x,
      viewY: view.y
    };
    svg.setPointerCapture(event.pointerId);
    render();
    return;
  }
  const id = group2.getAttribute("data-node");
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
  { passive: false }
);
function addGate(type) {
  const same = nodes.filter((node) => node.type === type).length;
  let id = `${type.toLowerCase()}${same + 1}`;
  while (nodes.some((node) => node.id === id)) {
    id = `${id}x`;
  }
  nodes.push({
    id,
    type,
    x: 330 + same % 2 * 210,
    y: 190 + Math.floor(same / 2) * 100,
    inputs: ["", ""]
  });
  selectedId = id;
  saveAndRender();
  scrollToBoard();
}
function deleteSelected() {
  if (!selectedId) {
    toast(t("dyn.selectBlock"), true);
    return;
  }
  nodes = nodes.filter((node) => node.id !== selectedId).map((node) => ({
    ...node,
    inputs: node.inputs.map((input) => input === selectedId ? "" : input)
  }));
  selectedId = null;
  saveAndRender();
}
function resetCircuit() {
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
function sourceLabel(value) {
  const kind = value.kind === "github" ? "GitHub" : value.kind === "gitlab" ? "GitLab" : value.kind === "codeberg" ? "Codeberg" : t("dyn.source");
  return value.repo ? `${kind} \xB7 ${value.repo}` : kind;
}
function renderSourceStatus() {
  if (!source) {
    sourceStatus.textContent = t("wb.publicSource");
    sourceRepoInput.value = "";
    sourcePathInput.value = "";
    clearSourceButton.classList.add("hidden");
    importSourceButton.textContent = t("wb.import");
    return;
  }
  const pinned = source.commit ? source.commit.slice(0, 7) : t("dyn.latest");
  const path = source.path ? ` \xB7 ${source.path}` : "";
  sourceStatus.textContent = t("dyn.sourceUsing", {
    source: sourceLabel(source),
    commit: `${pinned}${path}`
  });
  if (source.repo) sourceRepoInput.value = source.repo;
  if (source.path) sourcePathInput.value = source.path;
  clearSourceButton.classList.remove("hidden");
  importSourceButton.textContent = t("wb.replace");
}
async function importGitHubSource() {
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
        taskId: path ? taskId : null
      })
    });
    const resolved = await response.json();
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
function resetHint() {
  hintIndex = 0;
  hintButton.textContent = t("wb.needHint");
  hintBox.textContent = "";
  hintBox.classList.add("hidden");
}
function updateTaskPosition() {
  const index = tasks.findIndex((task) => task.id === taskId);
  taskProgress.textContent = t("wb.puzzleOf", {
    n: index + 1,
    total: tasks.length
  });
}
function renderChallengeDots() {
  challengeDots.innerHTML = tasks.map(
    (task) => `<button type="button" data-task="${escapeHtml(task.id)}"${task.id === taskId ? ' class="active" aria-current="true"' : ""} title="${escapeHtml(taskTitleFor(task))}" aria-label="${escapeHtml(taskTitleFor(task))}"></button>`
  ).join("");
}
function setTask(nextTaskId) {
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
function toast(message, error = false) {
  toastEl.textContent = message;
  toastEl.classList.toggle("error", error);
  toastEl.classList.remove("hidden");
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.add("hidden"), 3400);
}
function openWelcome() {
  welcomeEl.classList.remove("hidden");
  document.body.classList.add("modal-open");
  welcomeCloseButton.focus();
}
function closeWelcome(remember = true) {
  welcomeEl.classList.add("hidden");
  document.body.classList.remove("modal-open");
  if (remember) localStorage.setItem(WELCOME_KEY, "1");
}
function hintsFor(id) {
  const fallback = HINTS[id];
  if (!fallback) return [t("hint.generic")];
  return fallback.map((text, index) => t(`hint.${id}.${index}`, {}, text));
}
function showHint() {
  const hints = hintsFor(taskId);
  hintBox.textContent = hints[hintIndex % hints.length];
  hintBox.classList.remove("hidden");
  hintIndex += 1;
  hintButton.textContent = hintIndex >= hints.length ? t("wb.startHintsOver") : t("wb.anotherHint");
}
function toBase64(bytes) {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
async function ensureIdentity(handle) {
  const existing = loadStoredIdentity();
  if (existing) {
    if (existing.handle !== handle) {
      throw new Error(
        t("err.nameConflict", { existing: existing.handle, handle })
      );
    }
    return existing;
  }
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  );
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateKey = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const response = await fetch("/v1/identities", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle, publicKey })
  });
  const payload = await response.json();
  if (!response.ok || !payload.keyId) {
    if (payload.error === "handle is already registered") {
      throw new Error(t("err.nameTaken", { handle }));
    }
    throw new Error(t("err.saveName"));
  }
  const identity = {
    handle,
    keyId: payload.keyId,
    publicKey,
    privateKey
  };
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  renderIdentityStatus();
  return identity;
}
async function signPayload(identity, payload) {
  const key = await crypto.subtle.importKey(
    "jwk",
    identity.privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(canonicalize(payload))
  );
  return toBase64(signature);
}
async function publish() {
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
    const payload = {
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
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      nonce: crypto.randomUUID()
    };
    publishStatus.textContent = t("wb.checkingBuild");
    const signature = await signPayload(identity, payload);
    const response = await fetch("/v1/publications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload, signature })
    });
    const saved = await response.json();
    if (!response.ok) {
      throw new Error(saved.error ?? t("err.share"));
    }
    localStorage.setItem(HANDLE_KEY, handle);
    saveDraft();
    publishStatus.textContent = t("feed.sharedPoints", {
      score: saved.attestation.score
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
function taskName(id) {
  const task = tasks.find((item) => item.id === id);
  if (task) return taskTitleFor(task);
  return challengeTitles[id] ?? id;
}
async function refreshRegistry() {
  try {
    const [appsResponse, challengesResponse] = await Promise.all([
      fetch("/v1/apps"),
      fetch("/v1/challenges")
    ]);
    if (appsResponse.ok) {
      const apps = await appsResponse.json();
      appNames = Object.fromEntries(apps.map((app) => [app.id, app.name]));
    }
    if (challengesResponse.ok) {
      const challenges = await challengesResponse.json();
      challengeTitles = Object.fromEntries(
        challenges.map((challenge) => [challenge.id, challenge.title])
      );
      challengeSpecs = Object.fromEntries(
        challenges.map((challenge) => [
          challenge.id,
          challenge.spec ?? {}
        ])
      );
      sponsoredChallenges = challenges.filter(
        (challenge) => challenge.status === "sponsored"
      );
      sponsoredChallengeIds = new Set(
        sponsoredChallenges.map((challenge) => challenge.id)
      );
      renderSponsoredChallenges();
    }
    if (feedItems.length) renderFeed();
  } catch {
    return;
  }
}
function renderSponsoredChallenges() {
  if (!sponsoredChallenges.length) {
    sponsoredChallengeItems.innerHTML = "";
    sponsoredChallengesEl.classList.add("hidden");
    return;
  }
  sponsoredChallengeItems.innerHTML = sponsoredChallenges.map((challenge) => {
    const sponsor = challenge.sponsor ? `<span class="sponsored-meta">@${escapeHtml(challenge.sponsor)}</span>` : "";
    return `<li>
        <div class="sponsored-copy">
          <span class="sponsored-title">${escapeHtml(challenge.title)}</span>
          <span class="sponsored-meta">${escapeHtml(challenge.app)}</span>
          ${sponsor}
        </div>
        <span class="tag sponsored">${escapeHtml(t("dyn.sponsored"))}</span>
      </li>`;
  }).join("");
  sponsoredChallengesEl.classList.remove("hidden");
}
function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1e3));
  if (seconds < 45) return t("dyn.justNow");
  if (seconds < 3600) return t("dyn.minutes", { n: Math.max(1, Math.round(seconds / 60)) });
  if (seconds < 86400) return t("dyn.hours", { n: Math.round(seconds / 3600) });
  if (seconds < 604800) return t("dyn.days", { n: Math.round(seconds / 86400) });
  return new Date(iso).toLocaleDateString(localeTag());
}
function cardHtml(publication) {
  const attestation = publication.attestation;
  function aiRepresentationLabel(attestation2) {
    if (attestation2.representation === "bounded") {
      const metric = attestation2.metricName ?? "metric";
      return `bounded \xB7 ${metric} ${attestation2.metricValue ?? "?"}`;
    }
    return attestation2.representation ?? "";
  }
  const parent = publication.parentId ? feedItems.find((item) => item.id === publication.parentId) : void 0;
  const parentLabel = publication.parentId ? parent ? t("dyn.copyOf", { title: parent.title }) : t("dyn.aCopy") : t("dyn.firstBuild");
  const fullDate = new Date(publication.createdAt).toLocaleString(localeTag());
  const appTag = `<span class="tag app">${escapeHtml(appNames[publication.app] ?? publication.app)}</span>`;
  const sponsoredTag = sponsoredChallengeIds.has(publication.challengeId) ? `<span class="tag sponsored">${escapeHtml(t("dyn.sponsored"))}</span>` : "";
  const claimTag = attestation.semanticsId ? `<span class="tag claim">${escapeHtml(`${attestation.semanticsId}@${attestation.semanticsVersion}`)}</span>` : "";
  const representationTag = attestation.representation ? `<span class="tag ai">${escapeHtml(aiRepresentationLabel(attestation))}</span>` : "";
  const quantumTag = attestation.cryptoProfile === "post-quantum" ? `<span class="tag pq" title="${escapeHtml(t("crypto.pqTitle"))}">${escapeHtml(t("crypto.pq"))}</span>` : "";
  const statusTag = attestation.correct ? `<span class="tag good">${escapeHtml(t("dyn.solvedTag"))}</span>` : `<span class="tag bad">${escapeHtml(t("dyn.notSolved"))}</span>`;
  const authorTag = publication.verified ? "" : `<span class="tag quiet">${escapeHtml(t("dyn.nameUnchecked"))}</span>`;
  const sourceTag = publication.source ? `<a class="tag source" href="${escapeHtml(publication.source.url)}" target="_blank" rel="noreferrer">${escapeHtml(sourceLabel(publication.source))}</a>` : "";
  const isLogic = publication.app === "logic";
  const workbenchActions = isLogic ? `<button data-action="load" data-id="${escapeHtml(publication.id)}" class="primary">${escapeHtml(t("dyn.open"))}</button>
      <button data-action="remix" data-id="${escapeHtml(publication.id)}">${escapeHtml(t("dyn.copy"))}</button>` : "";
  return `<article class="card">
    <div class="card-top">
      <div>
        <div class="card-tags">${appTag}${sponsoredTag}${claimTag}${representationTag}${quantumTag}${statusTag}${authorTag}${sourceTag}</div>
        <h3>${escapeHtml(publication.title)}</h3>
        <div class="meta">
          ${escapeHtml(t("dyn.by"))} <b>@${escapeHtml(publication.author)}</b> \xB7 ${escapeHtml(taskName(publication.challengeId))}
          \xB7 <span title="${escapeHtml(fullDate)}">${escapeHtml(timeAgo(publication.createdAt))}</span>
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
      <div class="hash">${escapeHtml(t("dyn.build"))} ${shortHash(attestation.circuitHash)} \xB7 ${escapeHtml(t("dyn.proof"))} ${shortHash(attestation.traceHash)}</div>
      <div class="stats">
        <span>${escapeHtml(t("dyn.checkedBy"))}</span>
        <span>${escapeHtml(fullDate)}</span>
        ${publication.verified ? `<span>${escapeHtml(t("dyn.nameConfirmed"))}</span>` : ""}
        ${publication.source?.commit ? `<span>${escapeHtml(t("dyn.source"))} ${escapeHtml(publication.source.commit.slice(0, 7))}</span>` : ""}
        ${attestation.representation === "bounded" && attestation.metricName ? `<span>${escapeHtml(`${attestation.metricName} = ${attestation.metricValue ?? "?"}`)}</span>` : ""}
      </div>
    </details>
  </article>`;
}
function renderFeed() {
  feedEl.innerHTML = feedItems.length ? feedItems.map(cardHtml).join("") : `<div class="empty-state">
        <h3>${escapeHtml(t("feed.emptyTitle"))}</h3>
        <p>${escapeHtml(t("feed.emptyCopy"))}</p>
        <button class="primary" data-action="build">${escapeHtml(t("feed.startBuilding"))}</button>
      </div>`;
  loadMoreButton.classList.toggle("hidden", !feedHasMore);
}
async function loadFeed(reset) {
  if (reset) {
    feedOffset = 0;
    feedEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(t("dyn.loadingBuilds"))}</p></div>`;
  }
  try {
    const page = await apiGet(
      `/v1/feed?limit=${PAGE_SIZE}&offset=`
    );
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
async function refreshFeed() {
  await loadFeed(true);
}
async function loadMoreFeed() {
  if (!feedHasMore) return;
  loadMoreButton.disabled = true;
  await loadFeed(false);
  loadMoreButton.disabled = false;
}
async function anchorPendingPublications() {
  anchorFeedButton.disabled = true;
  try {
    const response = await fetch("/v1/anchors", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    const anchor = await response.json();
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
function adapterStatusLabel(status) {
  return status === "ready" ? t("dyn.ready") : status === "error" ? t("dyn.unavailable") : t("dyn.notConnected");
}
async function refreshAdapters() {
  try {
    const adapters = await apiGet("/v1/adapters");
    adapterList.innerHTML = adapters.map(
      (adapter) => `<div class="adapter-row">
          <b>${escapeHtml(adapter.name)}</b>
          <span class="tag ${adapter.status === "ready" ? "good" : "quiet"}">${adapterStatusLabel(adapter.status)}</span>
        </div>`
    ).join("");
  } catch {
    adapterList.innerHTML = `<p class="field-help">${escapeHtml(t("feed.networksUnavailable"))}</p>`;
  }
}
function renderBemBalance(status, address) {
  if (address.length === 0) {
    bemBalance.textContent = t("bem.hint");
    return;
  }
  const readout = bemReadout(status);
  bemBalance.textContent = readout.kind === "amount" ? t("bem.balance", { amount: readout.amount }) : t("bem.unavailable");
}
async function refreshChainStatus() {
  const address = bemAddressInput.value.trim();
  try {
    const query = address ? `?address=${encodeURIComponent(address)}` : "";
    const status = parseBemStatus(await apiGet(`/v1/tapeout/status${query}`));
    renderBemBalance(status, address);
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
      block: status.blockNumber ?? "\u2014"
    });
    chainStatus.classList.remove("hidden");
  } catch {
    renderBemBalance(parseBemStatus({}), address);
    chainStatus.textContent = "";
    chainStatus.classList.add("hidden");
  }
}
function openPublication(publication, mode) {
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
  titleInput.value = mode === "remix" ? t("dyn.copyOf", { title: publication.title }) : publication.title;
  bodyInput.value = publication.body;
  saveNodes();
  saveDraft();
  switchView("workbench", false);
  render();
  fitView();
  scrollToBoard();
  toast(mode === "remix" ? t("toast.buildCopied") : t("toast.opened"));
}
function localAiEvidence(publication) {
  const representation = publication.attestation.representation;
  if (representation !== "generative" && representation !== "bounded") return null;
  const spec = challengeSpecs[publication.challengeId];
  if (!spec) return null;
  const result = verifyAiArtifact(publication.artifact, {
    id: publication.challengeId,
    app: publication.app,
    title: "",
    description: "",
    version: 1,
    spec,
    semanticsId: publication.attestation.semanticsId,
    semanticsVersion: publication.attestation.semanticsVersion,
    createdAt: publication.createdAt
  });
  if ("error" in result) return null;
  if (result.representation === "generative") {
    return {
      text: `replay ${result.correct ? "ok" : "fail"} \xB7 steps ${result.steps ?? "?"}`,
      correct: result.correct
    };
  }
  const value = typeof result.metricValue === "number" ? result.metricValue : "?";
  const bound = typeof result.bound === "number" ? result.bound : "?";
  return {
    text: `metric ${value} ${result.correct ? "\u2264" : ">"} ${bound}`,
    correct: result.correct
  };
}
async function verifyPublication(publication) {
  try {
    const local = localAiEvidence(publication);
    const response = await fetch("/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicationId: publication.id })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error ?? t("err.check"));
    const valid = localVerdict(Boolean(payload.valid), local);
    const verdict = valid ? t("toast.verified") : t("toast.mismatch");
    toast(local ? `${verdict} \xB7 ${local.text}` : verdict, !valid);
  } catch (error) {
    toast(error instanceof Error ? error.message : t("err.check"), true);
  }
}
async function refreshRewards() {
  const identity = loadStoredIdentity();
  try {
    const board = await apiGet(
      `/v1/work?keyId=${encodeURIComponent(identity?.keyId ?? "")}`
    );
    rewardsTotal.textContent = String(board.earnings?.credits ?? 0);
    rewardsActions.innerHTML = board.actions.map((action) => {
      const earned = board.earnings?.byAction?.[action.id];
      const open = board.orders.filter((order) => order.action === action.id).length;
      return `<div class="reward-card">
          <div class="reward-head">
            <strong>${escapeHtml(t(`action.${action.id}`))}</strong>
            <span class="reward-value">${action.base * action.difficulty}</span>
          </div>
          <p class="reward-desc">${escapeHtml(action.description)}</p>
          <p class="reward-unit">${escapeHtml(action.unit)}${open ? ` \xB7 ${escapeHtml(t("rewards.open", { n: open }))}` : ""}</p>
          ${earned ? `<p class="reward-earned">${earned.jobs} \xB7 ${earned.credits}</p>` : ""}
        </div>`;
    }).join("");
    rewardsOrders.innerHTML = board.orders.length ? board.orders.map(
      (order) => `<div class="reward-order">
              <div>
                <strong>${escapeHtml(order.app)}</strong>
                <span class="reward-order-id">${escapeHtml(order.challengeId)}</span>
              </div>
              <span class="reward-value">${order.bounty}</span>
            </div>`
    ).join("") : `<div class="empty">${escapeHtml(t("rewards.empty"))}</div>`;
  } catch {
    rewardsActions.innerHTML = `<div class="empty">${escapeHtml(t("rewards.empty"))}</div>`;
    rewardsOrders.innerHTML = "";
  }
}
async function workNow() {
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
        publicKey: identity.publicKey,
        privateKey: identity.privateKey
      },
      onProgress: (result) => {
        toast(
          result.accepted ? `${result.challengeId} \xB7 ${result.bounty}` : `${result.challengeId} \xB7 ${result.error ?? "failed"}`,
          !result.accepted
        );
      }
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
async function refreshMarket() {
  const [participantsResponse, listingsResponse, answersResponse] = await Promise.all([
    apiGet("/v1/participants"),
    apiGet("/v1/market"),
    apiGet("/v1/market/aggregate")
  ]);
  const participants = participantsResponse.participants;
  const listings = listingsResponse.listings;
  const answers = answersResponse.answers;
  marketParticipants.innerHTML = participants.length ? participants.map(
    (participant) => `<div class="market-row">
            <div>
              <strong>${escapeHtml(participant.handle)}</strong>
              <span class="market-sub">${escapeHtml(participant.model ?? participant.hardware ?? participant.kind)}</span>
            </div>
            <span class="tag app">${escapeHtml(participant.kind)}</span>
          </div>`
  ).join("") : `<div class="empty">${escapeHtml(t("market.empty"))}</div>`;
  marketListings.innerHTML = listings.length ? listings.map(
    (listing) => `<div class="market-row">
            <div>
              <strong>${escapeHtml(listing.title)}</strong>
              <span class="market-sub">${escapeHtml(listing.seller)}</span>
            </div>
            <span class="reward-value">${escapeHtml(String(listing.priceCredits))}</span>
          </div>`
  ).join("") : `<div class="empty">${escapeHtml(t("market.empty"))}</div>`;
  marketAnswers.innerHTML = answers.length ? answers.map(
    (answer) => `<div class="market-row">
            <div>
              <strong>${escapeHtml(answer.question)}</strong>
              <span class="market-sub">${escapeHtml(
      t("market.contributors", { n: answer.participants.length })
    )}</span>
            </div>
            <span class="reward-value">${escapeHtml(String(answer.aggregate ?? "-"))}</span>
          </div>`
  ).join("") : `<div class="empty">${escapeHtml(t("market.empty"))}</div>`;
}
function switchView(view2, scroll = true) {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view2);
  });
  el("view-workbench").classList.toggle("hidden", view2 !== "workbench");
  el("view-feed").classList.toggle("hidden", view2 !== "feed");
  el("view-rewards").classList.toggle("hidden", view2 !== "rewards");
  el("view-market").classList.toggle("hidden", view2 !== "market");
  if (scroll && window.matchMedia("(max-width: 1080px)").matches) {
    window.scrollTo(0, 0);
  }
  if (view2 === "workbench") updateCanvasHelp();
  if (view2 === "rewards") void refreshRewards();
  if (view2 === "market") void refreshMarket();
}
feedEl.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest("button[data-action]");
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
  const button = target.closest("button[data-task]");
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
bemCheckButton.addEventListener("click", () => void refreshChainStatus());
bemAddressInput.addEventListener("input", () => {
  localStorage.setItem(BEM_ADDRESS_KEY, bemAddressInput.value.trim());
});
bemAddressInput.addEventListener("change", () => void refreshChainStatus());
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
document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => {
    const view2 = button.dataset.view === "feed" ? "feed" : button.dataset.view === "rewards" ? "rewards" : button.dataset.view === "market" ? "market" : "workbench";
    switchView(view2);
    if (view2 === "feed") {
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
  const typing = target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
  if (!typing && (event.key === "Delete" || event.key === "Backspace")) {
    event.preventDefault();
    deleteSelected();
  }
});
function init() {
  initI18n();
  tasks.forEach((task) => {
    const option = document.createElement("option");
    option.value = task.id;
    option.textContent = taskTitleFor(task);
    taskSelect.append(option);
  });
  const storedHandle = localStorage.getItem(HANDLE_KEY);
  if (storedHandle) authorInput.value = storedHandle;
  const storedBemAddress = localStorage.getItem(BEM_ADDRESS_KEY);
  if (storedBemAddress) bemAddressInput.value = storedBemAddress;
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
//# sourceMappingURL=app.js.map
