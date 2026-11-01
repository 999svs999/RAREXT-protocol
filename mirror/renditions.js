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
function formatRarextUri(uri) {
  const query = uri.query === void 0 ? "" : `?${uri.query}`;
  if (uri.authority === void 0 && (uri.path === void 0 || uri.path.length === 0)) {
    return `${RAREXT_URI_SCHEME}:${uri.root}${query}`;
  }
  const authority = uri.authority ?? "";
  const path = uri.path === void 0 || uri.path.length === 0 ? "" : `/${uri.path.map(encodeURIComponent).join("/")}`;
  return `${RAREXT_URI_SCHEME}:${authority}${path}@${uri.root}${query}`;
}
function urlForRarextUri(uri, scheme = "https") {
  if (uri.authority === void 0) return null;
  const path = uri.path === void 0 || uri.path.length === 0 ? "" : `/${uri.path.map(encodeURIComponent).join("/")}`;
  const query = uri.query === void 0 ? "" : `?${uri.query}`;
  return `${scheme}://${uri.authority}${path}${query}`;
}

// packages/core/src/publications.ts
var PUBLICATION_ROOT_DOMAIN = "rarext.publication.root.v1";
var PUBLICATION_ROOT_FIELDS = {
  id: false,
  author: true,
  authorKey: true,
  delegatedBy: true,
  signatureAlgorithm: true,
  title: true,
  body: true,
  app: true,
  challengeId: true,
  artifact: true,
  taskId: true,
  circuit: true,
  visibility: true,
  artifactCommitment: true,
  parentId: true,
  source: true,
  createdAt: true,
  attestedAt: false,
  verified: true,
  signature: true,
  nonce: true,
  attestation: true,
  verification: true,
  attestationKeyId: false,
  attestationSignature: false,
  durability: false
};
var PUBLICATION_ROOT_EXCLUDED_FIELDS = Object.entries(
  PUBLICATION_ROOT_FIELDS
).filter(([, isContent]) => !isContent).map(([field]) => field).sort();
var PUBLICATION_ROOT_REQUIRED_FIELDS = [
  "author",
  "authorKey",
  "signatureAlgorithm",
  "title",
  "body",
  "app",
  "challengeId",
  "artifact",
  "taskId",
  "visibility",
  "artifactCommitment",
  "parentId",
  "source",
  "createdAt",
  "attestedAt",
  "verified",
  "signature",
  "nonce",
  "attestation"
];

// packages/core/src/anchors.ts
var ANCHOR_ROOT_DOMAIN = "rarext.anchor.root.v1";
var ANCHOR_ROOT_FIELDS = {
  id: false,
  root: true,
  publicationIds: true,
  leafCount: true,
  leafVersion: true,
  createdAt: false,
  adapter: true,
  reference: true,
  receipts: true
};
var ANCHOR_ROOT_EXCLUDED_FIELDS = Object.entries(ANCHOR_ROOT_FIELDS).filter(([, isContent]) => !isContent).map(([field]) => field).sort();
var ANCHOR_ROOT_REQUIRED_FIELDS = [
  "id",
  "root",
  "publicationIds",
  "leafCount",
  "createdAt",
  "adapter",
  "reference",
  "receipts"
];

// packages/core/src/digest.ts
function toHex(bytes) {
  let output = "";
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, "0");
  }
  return output;
}
function sha256Hex(sha256, value) {
  return toHex(sha256(new TextEncoder().encode(value)));
}

// packages/core/src/merkle.ts
function nextLevel(level, sha256) {
  const next = [];
  for (let index = 0; index < level.length; index += 2) {
    next.push(sha256Hex(sha256, level[index] + (level[index + 1] ?? level[index])));
  }
  return next;
}
function merkleRoot(leaves, sha256) {
  if (leaves.length === 0) {
    return sha256Hex(sha256, "");
  }
  let level = [...leaves];
  while (level.length > 1) {
    level = nextLevel(level, sha256);
  }
  return level[0];
}

// packages/core/src/credits.ts
var CREDIT_ROOT_DOMAIN = "rarext.credit.root.v1";
var CREDIT_ROOT_FIELDS = {
  keyId: true,
  action: true,
  bounty: true,
  challengeId: true,
  artifactHash: true,
  at: true
};
var CREDIT_ROOT_EXCLUDED_FIELDS = Object.entries(CREDIT_ROOT_FIELDS).filter(([, isContent]) => !isContent).map(([field]) => field).sort();
var CREDIT_ROOT_REQUIRED_FIELDS = Object.keys(CREDIT_ROOT_FIELDS).sort();
function creditRoot(record, hash) {
  const covered = {};
  const source = record;
  for (const [field, isContent] of Object.entries(CREDIT_ROOT_FIELDS)) {
    if (!isContent) continue;
    const value = source[field];
    if (value !== void 0) covered[field] = value;
  }
  return hash(`${CREDIT_ROOT_DOMAIN}
${canonicalize(covered)}`);
}
function creditLeaf(record, hash) {
  return hash(`rarext.credit.leaf.v1
${creditRoot(record, hash)}`);
}
function creditLedgerRoot(records, hash) {
  const leaves = records.map((record) => creditLeaf(record, hash)).sort();
  return merkleRoot(leaves, bytesHashOf(hash));
}
function bytesHashOf(hash) {
  return (bytes) => {
    const digest = hash(bytes);
    if (!/^[0-9a-f]{64}$/i.test(digest)) {
      throw new Error("the injected hash must return a 64-hex digest");
    }
    const out = new Uint8Array(32);
    for (let index = 0; index < 32; index += 1) {
      out[index] = Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
    }
    return out;
  };
}
var RECEIPT_ACTS = ["participate", "anchor"];
function creditStatement(keyId, records) {
  const mine = records.filter((record) => record.keyId === keyId);
  let earned = 0;
  let spent = 0;
  let weight = 0;
  for (const record of mine) {
    if (record.bounty > 0) earned += record.bounty;
    else if (record.bounty < 0) spent -= record.bounty;
    weight += record.bounty;
  }
  const holds = RECEIPT_ACTS.map((act) => {
    const receipts = mine.filter((record) => record.action === act);
    if (receipts.length === 0) return null;
    const roots = [...new Set(receipts.map((record) => record.artifactHash))].sort();
    return { act, receipts: receipts.length, roots };
  }).filter((entry) => entry !== null);
  return { keyId, credits: { earned, spent, net: earned - spent }, holds, weight };
}

// packages/core/src/records.ts
function recordRootPreimages(document) {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return [];
  const record = document;
  const preimages = [];
  const preimageFor = (domain, fields) => {
    const covered = {};
    for (const [field, isContent] of Object.entries(fields)) {
      if (!isContent) continue;
      const value = record[field];
      if (value !== void 0) covered[field] = value;
    }
    return `${domain}
${canonicalize(covered)}`;
  };
  if (PUBLICATION_ROOT_REQUIRED_FIELDS.every((field) => record[field] !== void 0)) {
    preimages.push({ kind: "publication", preimage: preimageFor(PUBLICATION_ROOT_DOMAIN, PUBLICATION_ROOT_FIELDS) });
  }
  if (ANCHOR_ROOT_REQUIRED_FIELDS.every((field) => record[field] !== void 0)) {
    preimages.push({ kind: "anchor", preimage: preimageFor(ANCHOR_ROOT_DOMAIN, ANCHOR_ROOT_FIELDS) });
  }
  if (CREDIT_ROOT_REQUIRED_FIELDS.every((field) => record[field] !== void 0)) {
    preimages.push({ kind: "credit", preimage: preimageFor(CREDIT_ROOT_DOMAIN, CREDIT_ROOT_FIELDS) });
  }
  return preimages;
}

// packages/core/src/state-archive.ts
var STATE_ARCHIVE_DOMAIN = "rarext.state-archive.v1";
var STATE_ARCHIVE_GENESIS_ROOT = "0".repeat(64);
function stateArchivePreimage(archive) {
  const covered = {
    previousStateRoot: archive.previousStateRoot,
    anchorRoot: archive.anchorRoot,
    proposals: archive.proposals,
    votes: archive.votes,
    credits: archive.credits,
    admissions: archive.admissions,
    at: archive.at
  };
  return `${STATE_ARCHIVE_DOMAIN}
${canonicalize(covered)}`;
}

// packages/core/src/ai.ts
var MAX_VOCAB = 4096;
var MAX_GENERATIVE_TOKEN_LENGTH = 256;
var MAX_GENERATIVE_OUTPUT_LENGTH = 1 << 20;
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
var MAX_BOUNDED_LENGTH = 1 << 20;
var RASTER_RULE = "xorshift32-image-v1";
var MAX_RASTER_SIZE = 512;
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

// packages/core/src/registries.ts
function parseRegistrySeedList(value) {
  const list = Array.isArray(value) ? value : typeof value === "object" && value !== null && "registries" in value ? value.registries : null;
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry;
    if (typeof record.id !== "string" || typeof record.url !== "string") return null;
    return {
      id: record.id,
      url: record.url,
      operator: typeof record.operator === "string" ? record.operator : "",
      chains: Array.isArray(record.chains) ? record.chains.filter((chain) => typeof chain === "string") : [],
      note: typeof record.note === "string" ? record.note : null,
      seed: typeof record.seed === "string" ? record.seed : null
    };
  }).filter((entry) => entry !== null);
}
function registryListDigestSource(entries) {
  return canonicalize(
    entries.map((entry) => ({
      id: entry.id,
      url: entry.url,
      operator: entry.operator,
      chains: entry.chains,
      note: entry.note,
      seed: entry.seed
    }))
  );
}
var FEDERATION_APP = "federation";
var REGISTRY_LIST_COMMITMENT_KIND = "registry-list-commitment";
function parseFederationCommitmentArtifact(artifact) {
  if (artifact.app !== FEDERATION_APP) return null;
  if (artifact.kind !== REGISTRY_LIST_COMMITMENT_KIND) return null;
  const raw = artifact.body;
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { listUrl, digest, generatedAt } = parsed;
  if (typeof listUrl !== "string" || listUrl.length === 0) return null;
  if (typeof digest !== "string" || digest.length === 0) return null;
  return { listUrl, digest, generatedAt: typeof generatedAt === "string" ? generatedAt : "" };
}

// packages/core/src/semantics.ts
var SEMANTICS_APP = "rarext-semantics";
var SEMANTICS_COMMITMENT_KIND = "semantics-commitment";
function parseSemanticsCommitmentArtifact(artifact) {
  if (artifact.app !== SEMANTICS_APP || artifact.kind !== SEMANTICS_COMMITMENT_KIND) return null;
  if (typeof artifact.body !== "string") return null;
  try {
    const parsed = JSON.parse(artifact.body);
    if (typeof parsed.digests !== "object" || parsed.digests === null) return null;
    const digests = {};
    for (const [key, value] of Object.entries(parsed.digests)) {
      if (typeof value !== "string") return null;
      digests[key] = value;
    }
    return { digests };
  } catch {
    return null;
  }
}
function semanticsKey(record) {
  return `${record.id}@${record.version}`;
}
function semanticsCommitmentHolds(commitment, records, digestOf) {
  const missing = [];
  let matched = 0;
  for (const record of records) {
    const key = semanticsKey(record);
    if (commitment.digests[key] === digestOf(record)) matched += 1;
    else missing.push(key);
  }
  return { committed: Object.keys(commitment.digests).length, matched, missing };
}
function bundleSemanticsCommitment(bundle) {
  for (const publication of bundle.publications ?? []) {
    const parsed = parseSemanticsCommitmentArtifact(publication?.artifact ?? {});
    if (parsed) return parsed;
  }
  return null;
}

// apps/web/src/ai.ts
function federationFromBundle(bundle) {
  for (const publication of bundle.publications ?? []) {
    if (publication.artifact?.kind !== REGISTRY_LIST_COMMITMENT_KIND) continue;
    const body = parseFederationCommitmentArtifact(publication.artifact);
    if (!body) continue;
    return { listUrl: body.listUrl, digest: body.digest };
  }
  return null;
}
async function sha256Hex2(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function sha256Bytes(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function renderProofPicture(body, size) {
  if (body.media?.rule && body.media.rule !== RASTER_RULE) {
    throw new Error(`renderProofPicture: this page does not implement the rendition rule ${String(body.media.rule)}`);
  }
  return renderRaster(body.model, body.seed, size);
}
function renderBoundedPicture(reference, values, size = {}) {
  if (size.rule && size.rule !== BOUNDED_RASTER_RULE) {
    throw new Error(`renderBoundedPicture: this page does not implement the rendition rule ${size.rule}`);
  }
  return renderBoundedRaster(reference, values, size.width, size.height ?? BOUNDED_RASTER_HEIGHT);
}
async function verifyPublishedRendition(input) {
  const media = input.body?.media;
  const recorded = typeof media?.raster === "string" ? media.raster : "";
  if (!recorded) return { recorded: "", derived: null, matches: false, reason: "the artifact records no raster" };
  try {
    let raster;
    if (media.rule === RASTER_RULE) {
      if (!input.body?.model || typeof input.body.seed !== "number" || typeof media.size !== "number") {
        return { recorded, derived: null, matches: false, reason: "the artifact does not carry a usable model, seed and size" };
      }
      raster = renderRaster(input.body.model, input.body.seed, media.size);
    } else if (media.rule === BOUNDED_RASTER_RULE) {
      const reference = input.challenge?.spec?.reference;
      if (!Array.isArray(reference) || !Array.isArray(input.body?.values)) {
        return { recorded, derived: null, matches: false, reason: "the artifact's challenge does not carry the committed reference" };
      }
      raster = renderBoundedRaster(
        reference,
        input.body.values,
        media.width,
        media.height ?? BOUNDED_RASTER_HEIGHT
      );
    } else {
      return { recorded, derived: null, matches: false, reason: `this page does not implement the rule ${String(media.rule)}` };
    }
    const derived = await sha256Bytes(raster);
    return { recorded, derived, matches: derived === recorded };
  } catch (error) {
    return {
      recorded,
      derived: null,
      matches: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
async function semanticsCommitmentHolds2(bundle, sha256) {
  const commitment = bundleSemanticsCommitment(bundle);
  if (!commitment) return null;
  const records = bundle.semantics ?? [];
  const digests = {};
  for (const record of records) {
    digests[semanticsKey(record)] = await semanticsRecordDigestAsync(record, sha256);
  }
  return semanticsCommitmentHolds(commitment, records, (record) => digests[semanticsKey(record)]);
}
async function semanticsRecordDigestAsync(record, sha256) {
  return await sha256(canonicalize(record));
}
export {
  creditLedgerRoot,
  creditStatement,
  federationFromBundle,
  formatRarextUri,
  parseRarextUri,
  parseRegistrySeedList,
  recordRootPreimages,
  registryListDigestSource,
  renderBoundedPicture,
  renderProofPicture,
  semanticsCommitmentHolds2 as semanticsCommitmentHolds,
  sha256Bytes,
  sha256Hex2 as sha256Hex,
  stateArchivePreimage,
  urlForRarextUri,
  verifyPublishedRendition
};
//# sourceMappingURL=renditions.js.map
