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
function isXorshiftModel(value) {
  if (typeof value !== "object" || value === null) return false;
  const model = value;
  if (model.kind !== "xorshift32") return false;
  const params = model.params;
  if (!params) return false;
  return Number.isInteger(params.a) && params.a >= 1 && params.a <= 31 && Number.isInteger(params.b) && params.b >= 1 && params.b <= 31 && Number.isInteger(params.c) && params.c >= 1 && params.c <= 31 && Array.isArray(model.vocab) && model.vocab.length >= 1 && model.vocab.length <= MAX_VOCAB && model.vocab.every((token) => typeof token === "string" && token.length > 0);
}
function isGenerativeBody(value) {
  if (typeof value !== "object" || value === null) return false;
  const body = value;
  return isXorshiftModel(body.model) && Number.isInteger(body.seed) && body.seed >= 0 && body.seed <= 4294967295 && typeof body.output === "string";
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

// packages/core/src/leaf.ts
var PUBLICATION_LEAF_VERSION = 4;
function leafPayload(publication, version = PUBLICATION_LEAF_VERSION) {
  if (version < 2) {
    return {
      id: publication.id,
      author: publication.author,
      authorKey: publication.authorKey,
      taskId: publication.taskId,
      circuitHash: publication.attestation.circuitHash,
      traceHash: publication.attestation.traceHash,
      score: publication.attestation.score,
      gateCount: publication.attestation.gateCount,
      createdAt: publication.createdAt
    };
  }
  const attestation = {
    circuitHash: publication.attestation.circuitHash,
    traceHash: publication.attestation.traceHash,
    correct: publication.attestation.correct,
    score: publication.attestation.score,
    gateCount: publication.attestation.gateCount,
    semanticsId: publication.attestation.semanticsId,
    semanticsVersion: publication.attestation.semanticsVersion,
    semanticsHash: publication.attestation.semanticsHash,
    claimKind: publication.attestation.claimKind,
    scope: publication.attestation.scope,
    verifierHash: publication.attestation.verifierHash
  };
  const base = {
    id: publication.id,
    author: publication.author,
    authorKey: publication.authorKey,
    title: publication.title,
    body: publication.body,
    app: publication.app,
    challengeId: publication.challengeId,
    taskId: publication.taskId,
    artifact: publication.artifact,
    circuit: publication.circuit ?? null,
    parentId: publication.parentId,
    source: publication.source,
    createdAt: publication.createdAt,
    nonce: publication.nonce,
    signature: publication.signature,
    attestation
  };
  if (version < 3) {
    return { leafVersion: 2, ...base };
  }
  const extended = {
    ...base,
    signatureAlgorithm: publication.signatureAlgorithm,
    cryptoProfile: publication.attestation.cryptoProfile
  };
  if (version === 3) {
    return { leafVersion: 3, ...extended };
  }
  const evidence = {};
  if (publication.attestation.representation !== void 0) {
    evidence.representation = publication.attestation.representation;
  }
  if (publication.attestation.metricName !== void 0) {
    evidence.metricName = publication.attestation.metricName;
  }
  if (publication.attestation.metricValue !== void 0) {
    evidence.metricValue = publication.attestation.metricValue;
  }
  return {
    leafVersion: 4,
    ...extended,
    attestation: { ...attestation, ...evidence }
  };
}

// apps/web/src/verify.ts
async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function hashPair(left, right) {
  return sha256Hex(left + right);
}
async function merkleRoot(leaves) {
  if (leaves.length === 0) return "";
  if (leaves.length === 1) return leaves[0];
  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(
        await hashPair(level[index], level[index + 1] ?? level[index])
      );
    }
    level = next;
  }
  return level[0];
}
function localAiCheck(publication, spec) {
  if (!spec) return null;
  const representation = publication.attestation.representation;
  if (representation === "generative") {
    if (typeof spec.steps !== "number") return null;
    const challenge = {
      id: publication.challengeId,
      app: publication.app,
      title: "",
      description: "",
      version: 1,
      spec: { steps: spec.steps },
      semanticsId: "",
      semanticsVersion: 1,
      createdAt: ""
    };
    const result = verifyAiArtifact(publication.artifact, challenge);
    if ("error" in result) return null;
    return { correct: result.correct === true };
  }
  if (representation === "bounded") {
    if (spec.metric !== "maxAbsError" && spec.metric !== "meanAbsError" || !Array.isArray(spec.reference) || typeof spec.bound !== "number") {
      return null;
    }
    const challenge = {
      id: publication.challengeId,
      app: publication.app,
      title: "",
      description: "",
      version: 1,
      spec: {
        metric: spec.metric,
        bound: spec.bound,
        reference: spec.reference
      },
      semanticsId: "",
      semanticsVersion: 1,
      createdAt: ""
    };
    const result = verifyAiArtifact(publication.artifact, challenge);
    if ("error" in result) return null;
    return {
      correct: result.correct === true,
      metricValue: typeof result.metricValue === "number" ? result.metricValue : void 0
    };
  }
  return null;
}
function aiClaimsFor(bundle, challenges) {
  return bundle.publications.map((publication) => {
    const attestation = publication.attestation;
    const representation = attestation.representation ?? null;
    const spec = challenges?.[publication.challengeId];
    const bound = typeof spec?.bound === "number" ? spec.bound : null;
    const metricValue = typeof attestation.metricValue === "number" ? attestation.metricValue : null;
    const local = localAiCheck(publication, spec);
    return {
      publicationId: publication.id,
      representation,
      correct: attestation.correct === true,
      metricName: attestation.metricName ?? null,
      metricValue,
      bound,
      withinBound: representation === "bounded" && metricValue !== null && bound !== null ? metricValue <= bound : null,
      local
    };
  });
}
async function verifyBundle(bundle, challenges) {
  const leaves = [];
  for (const publication of bundle.publications) {
    leaves.push(
      await sha256Hex(
        canonicalize(leafPayload(publication, bundle.manifest.leafVersion))
      )
    );
  }
  const computedRoot = await merkleRoot(leaves);
  const listed = bundle.manifest.publications.map((entry) => entry.leaf);
  const listMatches = JSON.stringify(listed) === JSON.stringify(leaves);
  if (computedRoot !== bundle.manifest.root) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the publications in this bundle do not rebuild the anchored root",
      aiClaims: aiClaimsFor(bundle, challenges)
    };
  }
  if (!listMatches) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the manifest leaf list does not match the publications",
      aiClaims: aiClaimsFor(bundle, challenges)
    };
  }
  return {
    valid: true,
    root: bundle.manifest.root,
    computedRoot,
    publications: leaves.length,
    reason: null,
    aiClaims: aiClaimsFor(bundle, challenges)
  };
}
export {
  verifyBundle
};
//# sourceMappingURL=verify.js.map
