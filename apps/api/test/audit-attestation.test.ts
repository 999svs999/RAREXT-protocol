import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AgentSigner,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import {
  DurabilityLedger,
  directoryHolder,
  respondToChallenge,
  type DurabilityHolder,
  type Placement,
} from "../src/durability.ts";
import { encodeBytes } from "../src/erasure.ts";
import {
  AUDIT_WINDOW_MS,
  auditPlacementDigest,
  newAuditChallenge,
  signAuditAttestation,
  verifyAuditAttestation,
  type AuditAttestation,
  type ChallengeTranscriptEntry,
} from "../src/audit-attestation.ts";

const SCRATCH = fileURLToPath(new URL("../../../.data/", import.meta.url));
const NOW = Date.parse("2026-10-24T12:00:00.000Z");

interface AuditFixture {
  root: string;
  holders: DurabilityHolder[];
  placement: Placement;
  signer: AgentSigner;
  outsider: AgentSigner;
  entries: ChallengeTranscriptEntry[];
  signed: AuditAttestation;
}

async function collectEntries(
  placement: Placement,
  holders: DurabilityHolder[],
  now: number,
): Promise<ChallengeTranscriptEntry[]> {
  return Promise.all(
    placement.shards.map(async (shard) => {
      const holder = holders.find((candidate) => candidate.id === shard.holder)!;
      const bytes = Uint8Array.from((await holder.get(shard.storedAs))!);
      const challenge = newAuditChallenge(shard, { now, random: () => 0 });
      const response = respondToChallenge(bytes, challenge.leafIndex, challenge.nonce)!;

      return {
        holderId: shard.holder,
        storedAs: shard.storedAs,
        leafIndex: challenge.leafIndex,
        nonce: challenge.nonce,
        timestamp: challenge.timestamp,
        response,
        verified: true,
      };
    }),
  );
}

async function fixture(): Promise<AuditFixture> {
  mkdirSync(SCRATCH, { recursive: true });
  const root = mkdtempSync(join(SCRATCH, "audit-"));
  const holders = [
    directoryHolder("h-0", join(root, "h-0")),
    directoryHolder("h-1", join(root, "h-1")),
  ];
  const payload = randomBytes(8 * 1024);
  const ledger = new DurabilityLedger({ random: () => 0 });
  const placement = await ledger.place(encodeBytes(payload, 1, 1), holders, "durable");
  const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const outsider = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const entries = await collectEntries(placement, holders, NOW);

  return {
    root,
    holders,
    placement,
    signer,
    outsider,
    entries,
    signed: signAuditAttestation(
      attestationFor(placement, signer, entries, NOW),
      signer,
    ),
  };
}

function attestationFor(
  placement: Placement,
  signer: AgentSigner,
  entries: ChallengeTranscriptEntry[],
  timestamp: number,
): Omit<AuditAttestation, "signature"> {
  return {
    blobHash: placement.blobHash,
    placementDigest: auditPlacementDigest(placement),
    verifierKeyId: signer.keyId,
    verifierPublicKey: signer.publicKey,
    algorithm: signer.suite,
    timestamp: new Date(timestamp).toISOString(),
    entries,
  };
}

function verificationOptions(signer: AgentSigner, now: number = NOW + 1_000) {
  return {
    now,
    expectedVerifierKeyId: signer.keyId,
    expectedVerifierPublicKey: signer.publicKey,
  };
}

test("audit attestations verify a complete signed transcript and reject tampering", async () => {
  const audit = await fixture();

  try {
    const result = verifyAuditAttestation(
      audit.signed,
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(result.ok, true, result.reason ?? undefined);

    const tamperedResponse = signAuditAttestation(
      attestationFor(
        audit.placement,
        audit.signer,
        audit.signed.entries.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                response: {
                  ...entry.response,
                  leaf: "0".repeat(64),
                },
              }
            : entry
        ),
        NOW,
      ),
      audit.signer,
    );

    const responseResult = verifyAuditAttestation(
      tamperedResponse,
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(responseResult.ok, false);
    assert.match(responseResult.reason ?? "", /challenge response/);

    const tamperedPayload = {
      ...audit.signed,
      blobHash: "0".repeat(64),
    };

    const payloadResult = verifyAuditAttestation(
      tamperedPayload,
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(payloadResult.ok, false);
    assert.match(payloadResult.reason ?? "", /signature/);

    const forged = signAuditAttestation(
      attestationFor(
        audit.placement,
        audit.outsider,
        audit.entries,
        NOW,
      ),
      audit.outsider,
    );

    const forgedResult = verifyAuditAttestation(
      forged,
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(forgedResult.ok, false);
    assert.match(forgedResult.reason ?? "", /expected verifier/);
  } finally {
    rmSync(audit.root, { recursive: true, force: true });
  }
});

test("audit attestations reject stale, incomplete, duplicated, and out-of-window transcripts", async () => {
  const audit = await fixture();

  try {
    const expired = verifyAuditAttestation(
      audit.signed,
      audit.placement,
      verificationOptions(audit.signer, NOW + AUDIT_WINDOW_MS + 1),
    );
    assert.equal(expired.ok, false);
    assert.match(expired.reason ?? "", /expired/);

    const missing = signAuditAttestation(
      attestationFor(audit.placement, audit.signer, audit.entries.slice(1), NOW),
      audit.signer,
    );
    const missingResult = verifyAuditAttestation(
      missing,
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(missingResult.ok, false);
    assert.match(missingResult.reason ?? "", /cover every placement shard/);

    const duplicated = signAuditAttestation(
      attestationFor(
        audit.placement,
        audit.signer,
        [audit.entries[0]!, audit.entries[0]!],
        NOW,
      ),
      audit.signer,
    );
    const duplicatedResult = verifyAuditAttestation(
      duplicated,
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(duplicatedResult.ok, false);
    assert.match(duplicatedResult.reason ?? "", /more than once/);

    const repeatedNonce = {
      ...audit.entries[1]!,
      nonce: audit.entries[0]!.nonce,
    };
    const replayed = signAuditAttestation(
      attestationFor(
        audit.placement,
        audit.signer,
        [audit.entries[0]!, repeatedNonce],
        NOW,
      ),
      audit.signer,
    );
    const replayedResult = verifyAuditAttestation(
      replayed,
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(replayedResult.ok, false);
    assert.match(replayedResult.reason ?? "", /nonce is reused/);

    const lateEntry = {
      ...audit.entries[0]!,
      timestamp: new Date(NOW - AUDIT_WINDOW_MS - 1).toISOString(),
    };
    const late = signAuditAttestation(
      attestationFor(
        audit.placement,
        audit.signer,
        [lateEntry, audit.entries[1]!],
        NOW,
      ),
      audit.signer,
    );
    const lateResult = verifyAuditAttestation(
      late,
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(lateResult.ok, false);
    assert.match(lateResult.reason ?? "", /window has closed/);

    const falseEntry = {
      ...audit.entries[0]!,
      verified: false,
    };
    const failed = signAuditAttestation(
      attestationFor(
        audit.placement,
        audit.signer,
        [falseEntry, audit.entries[1]!],
        NOW,
      ),
      audit.signer,
    );
    const failedResult = verifyAuditAttestation(
      failed,
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(failedResult.ok, false);
    assert.match(failedResult.reason ?? "", /failed verification/);
  } finally {
    rmSync(audit.root, { recursive: true, force: true });
  }
});

test("concurrent audits of the same holder use distinct nonces and both verify", async () => {
  const audit = await fixture();

  try {
    const digestBefore = auditPlacementDigest(audit.placement);
    const [firstEntries, secondEntries] = await Promise.all([
      collectEntries(audit.placement, audit.holders, NOW),
      collectEntries(audit.placement, audit.holders, NOW),
    ]);
    const first = signAuditAttestation(
      attestationFor(audit.placement, audit.signer, firstEntries, NOW),
      audit.signer,
    );
    const second = signAuditAttestation(
      attestationFor(audit.placement, audit.signer, secondEntries, NOW),
      audit.signer,
    );

    assert.equal(
      new Set([...first.entries, ...second.entries].map((entry) => entry.nonce)).size,
      4,
    );
    assert.equal(auditPlacementDigest(audit.placement), digestBefore);

    const [firstResult, secondResult] = await Promise.all([
      Promise.resolve(
        verifyAuditAttestation(first, audit.placement, verificationOptions(audit.signer)),
      ),
      Promise.resolve(
        verifyAuditAttestation(second, audit.placement, verificationOptions(audit.signer)),
      ),
    ]);

    assert.equal(firstResult.ok, true, firstResult.reason ?? undefined);
    assert.equal(secondResult.ok, true, secondResult.reason ?? undefined);
  } finally {
    rmSync(audit.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Hardening round: the audit guard, mechanism by mechanism. Each case names the
// promise it pins, so a later refactor cannot weaken one quietly.
// ---------------------------------------------------------------------------

test("mechanism: clock — an invalid verification clock cannot disable the freshness window", async () => {
  const audit = await fixture();

  try {
    const beyondWindow = NOW + AUDIT_WINDOW_MS + 1;

    // The baseline: expired, and refused.
    const expired = verifyAuditAttestation(
      audit.signed,
      audit.placement,
      verificationOptions(audit.signer, beyondWindow),
    );
    assert.equal(expired.ok, false);
    assert.match(expired.reason ?? "", /expired/);

    // The window is what makes an audit fresh. A clock the module cannot use
    // must not become a clock that always says "fresh".
    for (const bogus of [NaN, Infinity, -Infinity]) {
      const result = verifyAuditAttestation(audit.signed, audit.placement, {
        ...verificationOptions(audit.signer, beyondWindow),
        now: bogus,
      });
      assert.equal(
        result.ok,
        false,
        `now=${String(bogus)} must not verify an expired attestation (${result.reason ?? "accepted"})`,
      );
    }

    // And the window itself must be a usable duration.
    const badWindow = verifyAuditAttestation(audit.signed, audit.placement, {
      ...verificationOptions(audit.signer),
      windowMs: 0,
    });
    assert.equal(badWindow.ok, false);
    assert.match(badWindow.reason ?? "", /window must be positive/);
  } finally {
    rmSync(audit.root, { recursive: true, force: true });
  }
});

test("mechanism: signature — transplanting a valid signature onto other entries fails", async () => {
  const audit = await fixture();

  try {
    const reordered = signAuditAttestation(
      attestationFor(audit.placement, audit.signer, [...audit.entries].reverse(), NOW),
      audit.signer,
    );
    // Reordering is a different transcript, so the transplanted signature must fail.
    const transplanted = { ...reordered, signature: audit.signed.signature };
    const result = verifyAuditAttestation(
      transplanted,
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /signature is not valid/);
  } finally {
    rmSync(audit.root, { recursive: true, force: true });
  }
});

test("mechanism: signature — a key that does not match its declared id is refused", async () => {
  const audit = await fixture();

  try {
    // Signed by the outsider, but declaring the trusted verifier's key id.
    const impostor = signAuditAttestation(
      {
        ...attestationFor(audit.placement, audit.outsider, audit.entries, NOW),
        verifierKeyId: audit.signer.keyId,
        verifierPublicKey: audit.outsider.publicKey,
      },
      audit.outsider,
    );
    const result = verifyAuditAttestation(
      impostor,
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /verifierKeyId does not match the public key/);
  } finally {
    rmSync(audit.root, { recursive: true, force: true });
  }
});

test("mechanism: signature — the expected verifier is enforced, and an inconsistent expectation is refused", async () => {
  const audit = await fixture();

  try {
    const wrongVerifier = verifyAuditAttestation(audit.signed, audit.placement, {
      now: NOW + 1_000,
      expectedVerifierKeyId: audit.outsider.keyId,
      expectedVerifierPublicKey: audit.outsider.publicKey,
    });
    assert.equal(wrongVerifier.ok, false);
    assert.match(wrongVerifier.reason ?? "", /not signed by the expected verifier/);

    // A caller that names the trusted key id but hands over another key is
    // contradicting itself; the audit must not pick a side silently.
    const contradictory = verifyAuditAttestation(audit.signed, audit.placement, {
      now: NOW + 1_000,
      expectedVerifierKeyId: audit.signer.keyId,
      expectedVerifierPublicKey: audit.outsider.publicKey,
    });
    assert.equal(contradictory.ok, false);
    assert.match(contradictory.reason ?? "", /expected verifier key id does not match/);
  } finally {
    rmSync(audit.root, { recursive: true, force: true });
  }
});

test("mechanism: algorithm — a declared suite that is not the key's suite is refused", async () => {
  const audit = await fixture();

  try {
    const wrongSuite = signAuditAttestation(
      {
        ...attestationFor(audit.placement, audit.signer, audit.entries, NOW),
        algorithm: "ed25519" as never,
      },
      audit.signer,
    );
    const result = verifyAuditAttestation(
      wrongSuite,
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /algorithm is not supported/);
  } finally {
    rmSync(audit.root, { recursive: true, force: true });
  }
});

test("mechanism: transcript — a claimed pass over a response that does not verify is refused", async () => {
  const audit = await fixture();

  try {
    // verified: true, honest signature, but the response is not this shard's leaf.
    const forged = audit.entries.map((entry, index) =>
      index === 0
        ? {
            ...entry,
            response: {
              ...entry.response,
              leaf: entry.response.leaf.replace(/^./, entry.response.leaf[0] === "0" ? "1" : "0"),
            },
          }
        : entry,
    );
    const result = verifyAuditAttestation(
      signAuditAttestation(attestationFor(audit.placement, audit.signer, forged, NOW), audit.signer),
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /challenge response failed verification/);

    // And an entry that admits it did not verify cannot ride along either.
    const admitted = audit.entries.map((entry, index) =>
      index === 0 ? { ...entry, verified: false } : entry,
    );
    const admittedResult = verifyAuditAttestation(
      signAuditAttestation(attestationFor(audit.placement, audit.signer, admitted, NOW), audit.signer),
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(admittedResult.ok, false);
    assert.match(admittedResult.reason ?? "", /challenge response failed verification/);
  } finally {
    rmSync(audit.root, { recursive: true, force: true });
  }
});

test("mechanism: transcript — a leaf index outside the shard cannot be proven", async () => {
  const audit = await fixture();

  try {
    const outOfRange = audit.entries.map((entry, index) =>
      index === 0
        ? { ...entry, leafIndex: 10_000, response: { ...entry.response, index: 10_000 } }
        : entry,
    );
    const result = verifyAuditAttestation(
      signAuditAttestation(attestationFor(audit.placement, audit.signer, outOfRange, NOW), audit.signer),
      audit.placement,
      verificationOptions(audit.signer),
    );
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /challenge response failed verification/);
  } finally {
    rmSync(audit.root, { recursive: true, force: true });
  }
});

test("mechanism: shape — malformed attestations and placements are refused, each by name", async () => {
  const audit = await fixture();

  try {
    const options = verificationOptions(audit.signer);
    const base = attestationFor(audit.placement, audit.signer, audit.entries, NOW);

    const sign = (mutate: (input: Record<string, unknown>) => void) => {
      const input = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      mutate(input);
      return signAuditAttestation(input as never, audit.signer);
    };

    const expectations: Array<[string, () => AuditAttestation, RegExp]> = [
      [
        "signature",
        // Set after signing: the signer always writes its own signature field,
        // so mutating the input cannot produce a non-string one.
        () => ({ ...sign(() => {}), signature: 42 }) as unknown as AuditAttestation,
        /signature must be a string/,
      ],
      ["public key", () => sign((a) => { a.verifierPublicKey = null; }), /verifierPublicKey is required/],
      ["key id", () => sign((a) => { a.verifierKeyId = ""; }), /verifierKeyId is required/],
      ["timestamp", () => sign((a) => { a.timestamp = "not-a-date"; }), /timestamp must be an ISO timestamp/],
      [
        "entries",
        // The signer canonicalises entries, so a non-list cannot be signed at
        // all; the shape guard this pins lives in the verifier, which runs its
        // shape checks before it looks at the signature.
        () =>
          ({ ...JSON.parse(JSON.stringify(base)), entries: "none", signature: audit.signed.signature }) as AuditAttestation,
        /entries must be a list/,
      ],
      ["empty transcript", () => sign((a) => { a.entries = []; }), /no challenge entries|cover every placement shard/],
      [
        "unknown holder",
        () => sign((a) => { (a.entries as Record<string, unknown>[])[0]!.holderId = "stranger"; }),
        /unknown holder/,
      ],
      [
        "nonce too long",
        () => sign((a) => { (a.entries as Record<string, unknown>[])[0]!.nonce = "n".repeat(5000); }),
        /nonce is too long/,
      ],
      [
        "entry not an object",
        () => sign((a) => { (a.entries as unknown[])[0] = "nope"; }),
        /every transcript entry must be an object/,
      ],
    ];

    for (const [name, build, pattern] of expectations) {
      const result = verifyAuditAttestation(build(), audit.placement, options);
      assert.equal(result.ok, false, `${name} must be refused`);
      assert.match(result.reason ?? "", pattern, `${name}: got ${result.reason}`);
    }

    // A placement that repeats a holder is itself malformed. The attestation
    // must be signed over that placement, or the (earlier) placement-digest
    // check fires first and the duplicate guard is never reached.
    const repeated = {
      ...audit.placement,
      shards: [audit.placement.shards[0]!, audit.placement.shards[0]!],
    };
    const repeatedSigned = signAuditAttestation(
      attestationFor(repeated as never, audit.signer, [audit.entries[0]!, audit.entries[0]!], NOW),
      audit.signer,
    );
    const repeatedResult = verifyAuditAttestation(repeatedSigned, repeated as never, options);
    assert.equal(repeatedResult.ok, false, "a placement repeating a holder must be refused");
    assert.match(repeatedResult.reason ?? "", /placement repeats holder/);
  } finally {
    rmSync(audit.root, { recursive: true, force: true });
  }
});

test("mechanism: bound — fields outside the canonical set are not attested", async () => {
  const audit = await fixture();

  try {
    // The signature covers the fields the verifier reads. An extra field added
    // beside them is neither signed nor surfaced, so no consumer may treat it as
    // attested. Pinned here so the next reader does not assume otherwise.
    const withExtra = { ...audit.signed, notes: "this text was never signed" } as AuditAttestation & {
      notes: string;
    };
    const first = verifyAuditAttestation(withExtra, audit.placement, verificationOptions(audit.signer));
    assert.equal(first.ok, true);

    const rewritten = { ...withExtra, notes: "and neither was this" };
    const second = verifyAuditAttestation(rewritten, audit.placement, verificationOptions(audit.signer));
    assert.equal(second.ok, true, "an unsigned extra field must not change the verdict either way");

    // But a field the verifier DOES read is covered: changing it breaks the signature.
    const tamperedTs = { ...audit.signed, timestamp: new Date(NOW - 60_000).toISOString() };
    const broken = verifyAuditAttestation(tamperedTs, audit.placement, verificationOptions(audit.signer));
    assert.equal(broken.ok, false);
    assert.match(broken.reason ?? "", /signature is not valid/);
  } finally {
    rmSync(audit.root, { recursive: true, force: true });
  }
});
