import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  AgentSigner,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import {
  DurabilityLedger,
  directoryHolder,
  respondToChallenge,
} from "../src/durability.ts";
import { encodeBytes } from "../src/erasure.ts";
import { sha256Bytes } from "../src/storage.ts";
import {
  signAuditAttestation,
  verifyAuditAttestation,
  type ChallengeTranscriptEntry,
} from "../src/audit-attestation.ts";

test("independent storage audit attestations verify challenge transcripts and reject forgeries", async () => {
  const root = mkdtempSync(join(tmpdir(), "rarext-audit-"));
  const holders = [
    directoryHolder("h-0", join(root, "h-0")),
    directoryHolder("h-1", join(root, "h-1")),
  ];

  try {
    const payload = randomBytes(8 * 1024);
    const ledger = new DurabilityLedger({ random: () => 0 });
    const placement = await ledger.place(encodeBytes(payload, 1, 1), holders, "durable");

    const signer = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);

    const entries: ChallengeTranscriptEntry[] = [];
    for (const shard of placement.shards) {
      const holder = holders.find((h) => h.id === shard.holder)!;
      const bytes = Uint8Array.from((await holder.get(shard.storedAs))!);
      const nonce = "audit-nonce-1";
      const leafIndex = 0;
      const response = respondToChallenge(bytes, leafIndex, nonce)!;

      entries.push({
        holderId: shard.holder,
        storedAs: shard.storedAs,
        leafIndex,
        nonce,
        timestamp: new Date().toISOString(),
        response,
        verified: true,
      });
    }

    const attestationInput = {
      blobHash: placement.blobHash,
      placementDigest: createHash("sha256").update(Buffer.from(JSON.stringify(placement))).digest("hex"),
      verifierKeyId: signer.keyId,
      verifierPublicKey: signer.publicKey,
      algorithm: signer.suite,
      timestamp: new Date().toISOString(),
      entries,
    };

    const signed = signAuditAttestation(attestationInput, signer);

    // 1. Valid signed audit attestation passes verification
    const res1 = verifyAuditAttestation(signed, placement);
    assert.equal(res1.ok, true);

    // 2. Tampered transcript response fails verification
    const tampered = {
      ...signed,
      entries: signed.entries.map((e, i) =>
        i === 0
          ? {
              ...e,
              response: {
                ...e.response,
                bytes: Buffer.from("forged").toString("base64"),
              },
            }
          : e
      ),
    };
    const res2 = verifyAuditAttestation(tampered, placement);
    assert.equal(res2.ok, false);

    // 3. Forged signature fails verification
    const forged = {
      ...signed,
      signature: "A".repeat(88),
    };
    const res3 = verifyAuditAttestation(forged, placement);
    assert.equal(res3.ok, false);

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
