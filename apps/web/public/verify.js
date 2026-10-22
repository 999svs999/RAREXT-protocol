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

// packages/core/src/leaf.ts
var PUBLICATION_LEAF_VERSION = 3;
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
    attestation: {
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
    }
  };
  if (version < 3) {
    return { leafVersion: 2, ...base };
  }
  return {
    leafVersion: 3,
    ...base,
    signatureAlgorithm: publication.signatureAlgorithm,
    cryptoProfile: publication.attestation.cryptoProfile
  };
}

// apps/web/src/verify.ts
async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function hashPair(left, right) {
  return left + right;
}
function merkleRoot(leaves) {
  if (leaves.length === 0) return "";
  if (leaves.length === 1) return leaves[0];
  let level = [...leaves];
  while (level.length > 1) {
    const next = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(hashPair(level[index], level[index + 1] ?? level[index]));
    }
    level = next;
  }
  return level[0];
}
async function verifyBundle(bundle) {
  const leaves = [];
  for (const publication of bundle.publications) {
    leaves.push(
      await sha256Hex(
        canonicalize(leafPayload(publication, bundle.manifest.leafVersion))
      )
    );
  }
  const computedRoot = merkleRoot(leaves);
  const listed = bundle.manifest.publications.map((entry) => entry.leaf);
  const listMatches = JSON.stringify(listed) === JSON.stringify(leaves);
  if (computedRoot !== bundle.manifest.root) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the publications in this bundle do not rebuild the anchored root"
    };
  }
  if (!listMatches) {
    return {
      valid: false,
      root: bundle.manifest.root,
      computedRoot,
      publications: leaves.length,
      reason: "the manifest leaf list does not match the publications"
    };
  }
  return {
    valid: true,
    root: bundle.manifest.root,
    computedRoot,
    publications: leaves.length,
    reason: null
  };
}
export {
  verifyBundle
};
//# sourceMappingURL=verify.js.map
