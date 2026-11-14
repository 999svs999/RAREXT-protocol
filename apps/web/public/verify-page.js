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

// packages/core/src/rarext-uri.ts
var RAREXT_URI_SCHEME = "rarext";
var HEX64 = /^[0-9a-f]{64}$/;
function parseRarextUri(text) {
  if (typeof text !== "string") {
    return { ok: false, reason: "a RAREXT reference must be a string" };
  }
  const colon = text.indexOf(":");
  if (colon < 0) {
    return { ok: false, reason: `a RAREXT reference starts with ${RAREXT_URI_SCHEME}: \u2014 ${JSON.stringify(text)} has no scheme` };
  }
  const scheme = text.slice(0, colon).toLowerCase();
  if (scheme !== RAREXT_URI_SCHEME) {
    return { ok: false, reason: `${JSON.stringify(scheme)} is not a RAREXT reference (expected ${RAREXT_URI_SCHEME}:)` };
  }
  let body = text.slice(colon + 1);
  if (body.startsWith("//")) body = body.slice(2);
  let query;
  const question = body.indexOf("?");
  if (question >= 0) {
    query = body.slice(question + 1);
    body = body.slice(0, question);
  }
  if (body.length === 0) {
    return { ok: false, reason: "a RAREXT reference must name an object or a root" };
  }
  const bare = body.toLowerCase();
  if (HEX64.test(bare)) {
    return { ok: true, uri: { root: bare, ...query === void 0 ? {} : { query } } };
  }
  const at = body.lastIndexOf("@");
  if (at < 0) {
    return {
      ok: false,
      reason: "a RAREXT reference carries the root it commits to (rarext:<authority>/<path>@<64-hex root>); without one it is a name you have to trust"
    };
  }
  const root = body.slice(at + 1).toLowerCase();
  if (!HEX64.test(root)) {
    return { ok: false, reason: `the root in ${JSON.stringify(body.slice(at))} must be a 64-hex digest` };
  }
  const located = body.slice(0, at);
  const segments = located.split("/");
  const authority = (segments.shift() ?? "").trim().toLowerCase().replace(/\.$/, "");
  const path = [];
  for (const segment of segments) {
    if (segment.length === 0) {
      return { ok: false, reason: `the path in ${JSON.stringify(located)} has an empty segment` };
    }
    if (segment === "." || segment === "..") {
      return { ok: false, reason: `the path in ${JSON.stringify(located)} contains ${JSON.stringify(segment)}, which points somewhere else` };
    }
    path.push(decodeURIComponent(segment));
  }
  if (authority.length === 0 && path.length === 0) {
    return { ok: false, reason: "a reference with no location must be a bare root" };
  }
  return {
    ok: true,
    uri: {
      ...authority.length === 0 ? {} : { authority },
      ...path.length === 0 ? {} : { path },
      root,
      ...query === void 0 ? {} : { query }
    }
  };
}
function urlForRarextUri(uri, scheme = "https") {
  if (uri.authority === void 0) return null;
  const path = uri.path === void 0 || uri.path.length === 0 ? "" : `/${uri.path.map(encodeURIComponent).join("/")}`;
  const query = uri.query === void 0 ? "" : `?${uri.query}`;
  return `${scheme}://${uri.authority}${path}${query}`;
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
function generateTokens(model, seed, steps) {
  const { a, b, c } = model.params;
  let state = seed >>> 0;
  const tokens = [];
  for (let i = 0; i < steps; i++) {
    state ^= state << a >>> 0;
    state ^= state >>> b;
    state ^= state << c >>> 0;
    state >>>= 0;
    tokens.push(state % model.vocab.length);
  }
  return tokens;
}
function generate(model, seed, steps) {
  return generateTokens(model, seed, steps).map((token) => model.vocab[token]).join("");
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
var RASTER_RULE = "xorshift32-image-v1";
var MAX_RASTER_SIZE = 512;
function isGenerativeMedia(value) {
  if (typeof value !== "object" || value === null) return false;
  const media = value;
  return media.mediaType === "image/png" && media.rule === RASTER_RULE && typeof media.blob === "string" && /^[0-9a-f]{64}$/.test(media.blob) && typeof media.raster === "string" && /^[0-9a-f]{64}$/.test(media.raster) && Number.isInteger(media.size) && media.size >= 1 && media.size <= MAX_RASTER_SIZE && Number.isInteger(media.bytes) && media.bytes >= 1;
}
function renderRaster(model, seed, size) {
  if (!isXorshiftModel(model)) throw new Error("renderRaster: malformed model");
  if (!Number.isInteger(size) || size < 1 || size > MAX_RASTER_SIZE) {
    throw new Error(`renderRaster: size must be 1..${MAX_RASTER_SIZE}`);
  }
  const { a, b, c } = model.params;
  let state = seed >>> 0;
  const out = new Uint8Array(size * size * 3);
  for (let i = 0; i < out.length; i++) {
    state ^= state << a >>> 0;
    state ^= state >>> b;
    state ^= state << c >>> 0;
    state >>>= 0;
    out[i] = state & 255;
  }
  return out;
}
var BOUNDED_RASTER_RULE = "bounded-strip-v1";
var BOUNDED_RASTER_SCALE = 16;
var BOUNDED_RASTER_LANE = 48;
var BOUNDED_RASTER_GUTTER = 4;
var BOUNDED_RASTER_GAIN = 32;
var MAX_BOUNDED_RASTER_WIDTH = 4096;
function isBoundedMedia(value) {
  if (typeof value !== "object" || value === null) return false;
  const media = value;
  return media.mediaType === "image/png" && media.rule === BOUNDED_RASTER_RULE && typeof media.blob === "string" && /^[0-9a-f]{64}$/.test(media.blob) && typeof media.raster === "string" && /^[0-9a-f]{64}$/.test(media.raster) && Number.isInteger(media.width) && media.width >= 1 && media.width <= MAX_BOUNDED_RASTER_WIDTH && Number.isInteger(media.height) && media.height >= 1 && media.height <= MAX_BOUNDED_RASTER_WIDTH && Number.isInteger(media.bytes) && media.bytes >= 1;
}
var BOUNDED_RASTER_HEIGHT = 3 * BOUNDED_RASTER_LANE + 2 * BOUNDED_RASTER_GUTTER;
function renderBoundedRaster(reference, reconstruction, width, height = BOUNDED_RASTER_HEIGHT) {
  if (!Array.isArray(reference) || reference.length < 1) {
    throw new Error("renderBoundedRaster: reference must be a non-empty array");
  }
  if (!Array.isArray(reconstruction) || reconstruction.length !== reference.length) {
    throw new Error("renderBoundedRaster: reconstruction must match the reference length");
  }
  if (reference.length > MAX_BOUNDED_RASTER_WIDTH) {
    throw new Error(`renderBoundedRaster: at most ${MAX_BOUNDED_RASTER_WIDTH} values`);
  }
  const w = width ?? reference.length * BOUNDED_RASTER_SCALE;
  if (!Number.isInteger(w) || w < 1 || w > MAX_BOUNDED_RASTER_WIDTH) {
    throw new Error(`renderBoundedRaster: width must be 1..${MAX_BOUNDED_RASTER_WIDTH}`);
  }
  if (!Number.isInteger(height) || height < 1 || height > MAX_BOUNDED_RASTER_WIDTH) {
    throw new Error(`renderBoundedRaster: height must be 1..${MAX_BOUNDED_RASTER_WIDTH}`);
  }
  const raster = new Uint8Array(w * height * 3);
  const lane = BOUNDED_RASTER_LANE;
  const gutter = BOUNDED_RASTER_GUTTER;
  const laneStarts = [0, lane + gutter, 2 * (lane + gutter)];
  for (let x = 0; x < w; x++) {
    const index = Math.min(
      reference.length - 1,
      Math.floor(x * reference.length / w)
    );
    const grey = clampByte(reference[index]);
    const reconstructionGrey = clampByte(reconstruction[index]);
    const error = clampByte(Math.abs(reference[index] - reconstruction[index]) * BOUNDED_RASTER_GAIN);
    for (let y = 0; y < height; y++) {
      const offset = (y * w + x) * 3;
      let r = 0;
      let g = 0;
      let b = 0;
      if (y < lane) {
        r = g = b = grey;
      } else if (y < lane + gutter) {
      } else if (y < laneStarts[1] + lane) {
        r = g = b = reconstructionGrey;
      } else if (y < laneStarts[1] + lane + gutter) {
      } else if (y < laneStarts[2] + lane) {
        r = error;
      }
      raster[offset] = r;
      raster[offset + 1] = g;
      raster[offset + 2] = b;
    }
  }
  return raster;
}
function clampByte(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
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
async function sha256BytesHex(bytes) {
  const view = new Uint8Array(bytes.length);
  view.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view);
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
async function mediaFor(publication, spec, blobBytes, representation) {
  const body = publication.artifact?.body;
  if (!body) return null;
  let raster = null;
  let geometry = {
    size: null,
    width: null,
    height: null
  };
  let media = null;
  if (typeof body.seed === "number" && isGenerativeMedia(body.media)) {
    media = body.media;
    geometry = { size: body.media.size, width: body.media.size, height: body.media.size };
    try {
      raster = renderRaster(
        body.model,
        body.seed,
        body.media.size
      );
    } catch {
      raster = null;
    }
  } else if (isBoundedMedia(body.media)) {
    media = body.media;
    geometry = { size: null, width: body.media.width, height: body.media.height };
    const reference = spec?.reference;
    if (Array.isArray(reference) && Array.isArray(body.values)) {
      try {
        raster = renderBoundedRaster(
          reference,
          body.values,
          body.media.width,
          body.media.height
        );
      } catch {
        raster = null;
      }
    }
  }
  if (!media) {
    if (body.media !== void 0 && body.media !== null) {
      const shape = typeof body.media === "object" ? body.media : {};
      const rule = typeof shape.rule === "string" ? shape.rule : "an unknown rule";
      return {
        blob: "",
        raster: "",
        size: null,
        width: null,
        height: null,
        reDerived: null,
        matches: null,
        blobMatches: null,
        unverifiable: true,
        reason: `declared a ${representation ?? "unknown"} rendition under ${rule} that this reader cannot check`
      };
    }
    return null;
  }
  let reDerived = null;
  if (raster) {
    try {
      reDerived = await sha256BytesHex(raster);
    } catch {
      reDerived = null;
    }
  }
  let blobMatches = null;
  if (blobBytes) {
    blobMatches = await sha256BytesHex(blobBytes) === media.blob;
  }
  return {
    blob: media.blob,
    raster: media.raster,
    size: geometry.size,
    width: geometry.width,
    height: geometry.height,
    reDerived,
    matches: reDerived === null ? null : reDerived === media.raster,
    blobMatches,
    unverifiable: null,
    reason: null
  };
}
function base64ToBytes(value) {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return void 0;
  }
}
async function aiClaimsFor(bundle, challenges, media) {
  const committed = bundle.manifest.leafVersion >= 4;
  const claims = [];
  for (const publication of bundle.publications) {
    const attestation = publication.attestation;
    const representation = committed ? attestation.representation ?? null : null;
    const spec = challenges?.[publication.challengeId];
    const bound = typeof spec?.bound === "number" ? spec.bound : null;
    const metricValue = committed && typeof attestation.metricValue === "number" ? attestation.metricValue : null;
    const local = committed ? localAiCheck(publication, spec) : null;
    let mediaEvidence = null;
    if (committed) {
      const body = publication.artifact?.body;
      if (body?.media !== void 0 && body?.media !== null) {
        const hash = body.media.blob;
        const encoded = typeof hash === "string" ? media?.[hash] : void 0;
        const bytes = typeof encoded === "string" ? base64ToBytes(encoded) : void 0;
        mediaEvidence = await mediaFor(
          publication,
          spec,
          bytes,
          representation
        );
      }
    }
    claims.push({
      publicationId: publication.id,
      representation,
      correct: committed && attestation.correct === true,
      metricName: committed ? attestation.metricName ?? null : null,
      metricValue,
      bound,
      withinBound: representation === "bounded" && metricValue !== null && bound !== null ? metricValue <= bound : null,
      local,
      media: mediaEvidence
    });
  }
  return claims;
}
async function verifyBundle(bundle, challenges, pinnedRoot, media) {
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
      aiClaims: await aiClaimsFor(bundle, challenges, media)
    };
  }
  if (!listMatches) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the manifest leaf list does not match the publications",
      aiClaims: await aiClaimsFor(bundle, challenges, media)
    };
  }
  if (pinnedRoot && computedRoot !== pinnedRoot) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the bundle root does not match the pinned chain root",
      aiClaims: await aiClaimsFor(bundle, challenges, media)
    };
  }
  return {
    valid: true,
    root: bundle.manifest.root,
    computedRoot,
    publications: leaves.length,
    reason: null,
    aiClaims: await aiClaimsFor(bundle, challenges, media)
  };
}

// apps/web/src/verify-page.ts
var MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
var HEX642 = /^[0-9a-f]{64}$/;
var SAME_ORIGIN_CANDIDATES = ["./bundle.json", "../registry/bundle.json", "../bundle.json"];
function resolveInput(raw, pageUrl) {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "Paste a RAREXT link or a 64-character code to check." };
  if (/^https?:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text, pageUrl);
    } catch {
      return { ok: false, reason: `${JSON.stringify(text)} does not look like a web address.` };
    }
    const requested = url.searchParams.get("root");
    const pinnedRoot = requested !== null && HEX642.test(requested.toLowerCase()) ? requested.toLowerCase() : null;
    const candidate = url.pathname.endsWith("bundle.json") ? url.href : new URL("bundle.json", url.href).href;
    return {
      ok: true,
      resolved: {
        pinnedRoot,
        candidates: [candidate],
        understood: `A copy at ${url.host}` + (pinnedRoot === null ? "" : `, pinned to ${pinnedRoot.slice(0, 12)}\u2026`)
      }
    };
  }
  if (HEX642.test(text.toLowerCase())) {
    return {
      ok: true,
      resolved: {
        pinnedRoot: text.toLowerCase(),
        candidates: SAME_ORIGIN_CANDIDATES,
        understood: `An object named by its code (${text.slice(0, 12)}\u2026); checking the copies on this page.`
      }
    };
  }
  if (/^rarext:/i.test(text)) {
    const parsed = parseRarextUri(text);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    const base = urlForRarextUri(parsed.uri, pageUrl.startsWith("http:") ? "http" : "https");
    const candidates = base === null ? SAME_ORIGIN_CANDIDATES : [base.endsWith("bundle.json") ? base : `${base.replace(/\/$/, "")}/bundle.json`];
    return {
      ok: true,
      resolved: {
        pinnedRoot: parsed.uri.root,
        candidates,
        understood: base === null ? `An object named by its code (${parsed.uri.root.slice(0, 12)}\u2026); checking the copies on this page.` : `A copy at ${parsed.uri.authority}, pinned to ${parsed.uri.root.slice(0, 12)}\u2026`
      }
    };
  }
  return {
    ok: false,
    reason: "That is not something we can check. Paste a RAREXT link (rarext:host/path@code), a web address, or a 64-character code."
  };
}
function describeVerdict(result, pinnedRoot, publications, source, refusals) {
  if (result === null) {
    return {
      tone: "unreachable",
      headline: "We could not check this copy.",
      sentence: "Every place we looked was unreachable or refused to hand over the bytes. That is not proof of a problem \u2014 only that this page could not see the copy.",
      facts: refusals.map((refusal, index) => ({ label: `Tried (${index + 1})`, value: refusal }))
    };
  }
  if (result.valid) {
    return {
      tone: "ok",
      headline: "This copy is honest.",
      sentence: `Its ${result.publications} item${result.publications === 1 ? "" : "s"} rebuild the exact code the network agreed on. Nothing here has been added, changed, or removed.`,
      facts: [
        { label: "Code this copy rebuilds to", value: result.root },
        { label: "Code we computed ourselves", value: result.computedRoot },
        { label: "Items checked", value: String(result.publications) },
        ...source === null ? [] : [{ label: "Read from", value: source }],
        ...pinnedRoot === null ? [] : [{ label: "You asked for", value: pinnedRoot }]
      ]
    };
  }
  const selfConsistent = result.root === result.computedRoot;
  const differentObject = selfConsistent && pinnedRoot !== null && result.root !== pinnedRoot;
  return {
    tone: "bad",
    headline: differentObject ? "This is a different object than you asked for." : "This copy has been altered.",
    sentence: differentObject ? "The copy is self-consistent, but it is not the object your link named. Something in the chain pointed at the wrong thing." : "The items inside do not rebuild the code this copy claims. Do not trust its contents.",
    facts: [
      { label: "Code this copy claims", value: result.root },
      { label: "Code we computed ourselves", value: result.computedRoot },
      { label: "Why not", value: result.reason ?? "the roots differ" },
      ...source === null ? [] : [{ label: "Read from", value: source }],
      ...pinnedRoot === null ? [] : [{ label: "You asked for", value: pinnedRoot }]
    ]
  };
}
async function readCapped(response) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BUNDLE_BYTES) {
    throw new Error(`declares ${declared} bytes, above the ${MAX_BUNDLE_BYTES} byte cap`);
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BUNDLE_BYTES) {
    throw new Error(`is larger than the ${MAX_BUNDLE_BYTES} byte cap`);
  }
  return text;
}
async function checkCopy(resolved, fetchImpl = fetch) {
  const refusals = [];
  for (const url of resolved.candidates) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        refusals.push(`${url} \u2014 answered ${response.status}`);
        continue;
      }
      const bundle = JSON.parse(await readCapped(response));
      const challenges = Object.fromEntries(
        (bundle.challenges ?? []).map((challenge) => [
          challenge.id,
          challenge.spec ?? {}
        ])
      );
      const result = await verifyBundle(bundle, challenges, resolved.pinnedRoot ?? void 0);
      if (!result.valid) {
        refusals.push(`${url} \u2014 ${result.reason ?? "did not verify"}`);
        return { verdict: describeVerdict(result, resolved.pinnedRoot, result.publications, url, refusals), publications: result.publications };
      }
      return {
        verdict: describeVerdict(result, resolved.pinnedRoot, result.publications, url, refusals),
        publications: result.publications
      };
    } catch (error) {
      refusals.push(`${url} \u2014 ${error instanceof Error ? error.message : "unreachable"}`);
    }
  }
  return { verdict: describeVerdict(null, resolved.pinnedRoot, 0, null, refusals), publications: 0 };
}
function render(verdict) {
  const panel = document.getElementById("verdict");
  if (panel === null) return;
  panel.dataset.tone = verdict.tone;
  panel.setAttribute("role", "status");
  const glyph = verdict.tone === "ok" ? "\u2713" : verdict.tone === "bad" ? "!" : "?";
  const icon = document.getElementById("verdict-icon");
  if (icon !== null) {
    icon.textContent = glyph;
    icon.dataset.tone = verdict.tone;
  }
  const headline = document.getElementById("verdict-headline");
  if (headline !== null) headline.textContent = verdict.headline;
  const sentence = document.getElementById("verdict-sentence");
  if (sentence !== null) sentence.textContent = verdict.sentence;
  const facts = document.getElementById("verdict-facts");
  if (facts !== null) {
    facts.replaceChildren();
    for (const fact of verdict.facts) {
      const row = document.createElement("div");
      row.className = "fact";
      const label = document.createElement("span");
      label.textContent = fact.label;
      const value = document.createElement("code");
      value.textContent = fact.value;
      row.append(label, value);
      facts.append(row);
    }
  }
  panel.hidden = false;
}
function wire() {
  const form = document.getElementById("check-form");
  const input = document.getElementById("check-input");
  const note = document.getElementById("check-note");
  const button = document.getElementById("check-run");
  if (form === null || input === null || note === null || button === null) return;
  const params = new URLSearchParams(location.search);
  const preset = params.get("root");
  const ref = params.get("ref");
  if (ref !== null) input.value = ref;
  else if (preset !== null) input.value = preset;
  const run = async () => {
    const resolution = resolveInput(input.value, location.href);
    if (!resolution.ok) {
      note.textContent = resolution.reason;
      note.dataset.tone = "bad";
      return;
    }
    note.textContent = resolution.resolved.understood;
    note.dataset.tone = "ok";
    button.disabled = true;
    button.textContent = "Checking\u2026";
    try {
      const outcome = await checkCopy(resolution.resolved);
      render(outcome.verdict);
    } finally {
      button.disabled = false;
      button.textContent = "Check it";
    }
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void run();
  });
  if (preset !== null || ref !== null) void run();
}
if (typeof document !== "undefined" && typeof window !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
}
export {
  MAX_BUNDLE_BYTES,
  SAME_ORIGIN_CANDIDATES,
  checkCopy,
  describeVerdict,
  readCapped,
  resolveInput
};
//# sourceMappingURL=verify-page.js.map
