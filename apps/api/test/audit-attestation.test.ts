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
