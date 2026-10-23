import type { ErasureShard } from "../../api/src/erasure.ts";
import { decodeBytes, encodeBytes, verifyShard } from "../../api/src/erasure.ts";
import {
  DurabilityLedger,
  httpHolder,
  type DurabilityHolder,
  type DurabilityTier,
  type Placement,
} from "../../api/src/durability.ts";
import { parseHolderSpec } from "../../api/src/holders.ts";
import {
  asSignedPlacement,
  signPlacement,
  verifyPlacement,
  type SignedPlacement,
} from "../../api/src/placements.ts";
import { cidV1Raw } from "../../api/src/adapters/content.ts";
import { AgentSigner, readAgentKeyfile } from "../../../packages/agent-sdk/src/index.ts";
import {
  decryptSealedPayload,
  encryptSealedPayload,
  sealedEnvelope,
  sealedMetadata,
} from "../../api/src/sealed-encryption.ts";

const DEFAULT_API = "http://127.0.0.1:8787";
const DEFAULT_PIN = "http://127.0.0.1:9700";
const ledger = new DurabilityLedger();

function apiBase(): string {
  return (process.env.RAREXT_API ?? DEFAULT_API).replace(/\/+$/, "");
}

function holderSpec(): string {
  return process.env.RAREXT_STORAGE_HOLDERS ?? process.env.RAREXT_HOLDERS ?? "";
}

function holderToken(): string | undefined {
  return process.env.RAREXT_HOLDER_TOKEN || undefined;
}

function sealedSecret(required: boolean): string | undefined {
  const secret = process.env.RAREXT_SEALED_SECRET;

  if (!required) return secret || undefined;

  if (!secret) {
    throw new Error("this blob is sealed; set RAREXT_SEALED_SECRET to encrypt or decrypt it");
  }

  if (secret.length < 16) {
    throw new Error("RAREXT_SEALED_SECRET must be at least 16 characters");
  }

  return secret;
}

function storageHolders(): DurabilityHolder[] {
  return parseHolderSpec(holderSpec()).map((entry) =>
    httpHolder(entry.id, entry.url, { token: holderToken(), timeoutMs: 60_000 }),
  );
}

function maxBytes(): number {
  const configured = Number(process.env.RAREXT_STORAGE_MAX_BYTES ?? 8 * 1024 * 1024);

  if (!Number.isFinite(configured) || configured <= 0) return 8 * 1024 * 1024;

  return Math.min(Math.floor(configured), 32 * 1024 * 1024);
}

async function loadSigner(): Promise<AgentSigner> {
  try {
    const keyfile = await readAgentKeyfile();
    return new AgentSigner(keyfile.privateKey);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new Error("no agent key; call rarext_agent_register before rarext_storage_put");
    }
    throw error;
  }
}

async function limitedJson(
  response: Response,
  limit: number,
  what: string,
): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");

  if (declared > limit) throw new Error(`${what} response is too large`);
  const text = await response.text();

  if (Buffer.byteLength(text) > limit) throw new Error(`${what} response is too large`);

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${what} returned invalid JSON`);
  }
}

async function latestPlacement(blobHash: string): Promise<SignedPlacement | null> {
  const response = await fetch(
    `${apiBase()}/v1/placements/${encodeURIComponent(blobHash)}`,
    { signal: AbortSignal.timeout(15_000) },
  );

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`placement lookup failed: ${response.status}`);

  const value = await limitedJson(response, 2 * 1024 * 1024, "placement");
  const signed = asSignedPlacement(value);

  if (!signed) throw new Error("placement response is not a signed record");

  const verified = verifyPlacement(signed);

  if (!verified.ok) throw new Error(`placement record is invalid: ${verified.reason}`);
  if (signed.record.placement.blobHash !== blobHash) {
    throw new Error("placement response names another blob");
  }

  return signed;
}

function samePlacement(left: Placement, right: Placement): boolean {
  const fields = (placement: Placement) =>
    JSON.stringify({
      blobHash: placement.blobHash,
      dataShards: placement.dataShards,
      parityShards: placement.parityShards,
      length: placement.length,
      tier: placement.tier,
      required: placement.required,
      shards: placement.shards,
      sealed: placement.sealed ?? null,
    });

  return fields(left) === fields(right);
}

async function recordPlacement(
  signed: SignedPlacement,
): Promise<{ recorded: boolean; status: number; error?: string }> {
  const blobHash = signed.record.placement.blobHash;

  try {
    const existing = await latestPlacement(blobHash);

    if (existing) {
      if (samePlacement(existing.record.placement, signed.record.placement)) {
        return { recorded: true, status: 200 };
      }

      return {
        recorded: false,
        status: 409,
        error: "a different placement is already recorded for this blob",
      };
    }
  } catch (error) {
    if (!(error instanceof TypeError)) {
      return {
        recorded: false,
        status: 0,
        error: error instanceof Error ? error.message : "placement lookup failed",
      };
    }
  }

  try {
    const response = await fetch(`${apiBase()}/v1/placements`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed),
      signal: AbortSignal.timeout(20_000),
    });
    const value = await limitedJson(response, 16 * 1024, "placement registration").catch(() => null);

    if (!response.ok) {
      return {
        recorded: false,
        status: response.status,
        error:
          typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string"
            ? (value as { error: string }).error
            : `placement registration failed: ${response.status}`,
      };
    }

    return { recorded: true, status: response.status };
  } catch (error) {
    return {
      recorded: false,
      status: 0,
      error: error instanceof Error ? error.message : "placement registration failed",
    };
  }
}

function adoptSigned(ledger: DurabilityLedger, signed: SignedPlacement): Placement {
  const verified = verifyPlacement(signed);

  if (!verified.ok) throw new Error(`placement record is invalid: ${verified.reason}`);

  return ledger.adopt(structuredClone(signed.record.placement));
}

async function placementFor(
  ledger: DurabilityLedger,
  blobHash: string,
  supplied?: unknown,
): Promise<Placement> {
  if (supplied !== undefined && supplied !== null) {
    const signed = asSignedPlacement(supplied);

    if (!signed) throw new Error("placement must be a signed placement record");
    const placement = adoptSigned(ledger, signed);

    if (placement.blobHash !== blobHash) throw new Error("placement is for another blob");
    return placement;
  }

  const cached = ledger.get(blobHash);
  if (cached) return cached;

  const signed = await latestPlacement(blobHash);

  if (!signed) throw new Error(`no placement for ${blobHash}; pass the signed placement or put it first`);
  return adoptSigned(ledger, signed);
}

function holdersById(): Map<string, DurabilityHolder> {
  return new Map(storageHolders().map((holder) => [holder.id, holder]));
}

function asTier(value: unknown): DurabilityTier {
  if (value === "ephemeral" || value === "pinned" || value === "durable") return value;
  return "durable";
}

function integer(value: unknown, fallback: number, name: string, min: number, max: number): number {
  const number = value === undefined ? fallback : Number(value);

  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }

  return number;
}

export async function storagePut(args: Record<string, unknown>): Promise<unknown> {
  const content = args.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("content must be non-empty base64 text");
  }

  const encoded = Buffer.from(content, "base64");
  if (encoded.length === 0) throw new Error("content decoded to zero bytes");
  if (encoded.length > maxBytes()) throw new Error(`content exceeds ${maxBytes()} bytes`);

  const dataShards = integer(args.dataShards, 4, "dataShards", 1, 64);
  const parityShards = integer(args.parityShards, 2, "parityShards", 0, 64);

  if (dataShards + parityShards > 64) throw new Error("dataShards + parityShards must be at most 64");

  const tier = asTier(args.tier);
  const holders = storageHolders();

  if (holders.length < dataShards + parityShards) {
    throw new Error(
      `need ${dataShards + parityShards} holders for ${dataShards}+${parityShards}, have ${holders.length}; set RAREXT_STORAGE_HOLDERS`,
    );
  }

  const sealed = args.sealed === true;
  const secret = sealedSecret(sealed);
  const encrypted = sealed ? encryptSealedPayload(encoded, secret!) : null;
  const stored = encrypted ? encrypted.ciphertextBytes : encoded;
  const metadata = encrypted ? sealedMetadata(encrypted.envelope) : null;

  const shards = encodeBytes(stored, dataShards, parityShards);
  const placement = await ledger.place(
    shards,
    holders,
    tier,
    metadata ? { sealed: metadata } : {},
  );
  const signer = await loadSigner();
  const signed = signPlacement(placement, signer);
  const registration = await recordPlacement(signed);

  return {
    blobHash: placement.blobHash,
    bytes: encoded.length,
    storedBytes: stored.length,
    sealed,
    ...(metadata ? { sealedMetadata: metadata } : {}),
    code: `${dataShards}+${parityShards}`,
    tier,
    holders: placement.shards.map((shard) => ({
      index: shard.index,
      holder: shard.holder,
      size: shard.size,
      storedAs: shard.storedAs,
    })),
    placement: signed,
    registration,
  };
}

export async function storageGet(args: Record<string, unknown>): Promise<unknown> {
  const blobHash = String(args.blobHash ?? "");
  if (!/^[0-9a-f]{64}$/.test(blobHash)) throw new Error("blobHash must be a sha256 hex digest");

  const placement = await placementFor(ledger, blobHash, args.placement);
  const holders = holdersById();
  const verified: ErasureShard[] = [];
  const errors: { index: number; holder: string; error: string }[] = [];

  for (const shard of placement.shards) {
    const holder = holders.get(shard.holder);

    if (!holder) {
      errors.push({ index: shard.index, holder: shard.holder, error: "holder is not configured" });
      continue;
    }

    try {
      const bytes = await holder.get(shard.storedAs);

      if (!bytes) {
        errors.push({ index: shard.index, holder: shard.holder, error: "shard is missing" });
        continue;
      }

      const candidate: ErasureShard = {
        index: shard.index,
        dataShards: placement.dataShards,
        parityShards: placement.parityShards,
        length: placement.length,
        payloadDigest: placement.blobHash,
        bytes,
        digest: shard.digest,
      };

      if (!verifyShard(candidate)) {
        errors.push({ index: shard.index, holder: shard.holder, error: "shard digest does not match" });
        continue;
      }

      verified.push(candidate);
    } catch (error) {
      errors.push({
        index: shard.index,
        holder: shard.holder,
        error: error instanceof Error ? error.message : "read failed",
      });
    }
  }

  if (verified.length < placement.dataShards) {
    throw new Error(
      `only ${verified.length} of ${placement.dataShards} data shards are usable; ${JSON.stringify(errors)}`,
    );
  }

  const stored = decodeBytes(verified.slice(0, placement.dataShards));
  const content = placement.sealed
    ? decryptSealedPayload(sealedEnvelope(placement.sealed, stored), sealedSecret(true)!)
    : stored;

  return {
    blobHash,
    bytes: content.length,
    storedBytes: stored.length,
    sealed: placement.sealed !== undefined,
    content: Buffer.from(content).toString("base64"),
    shardsRead: placement.dataShards,
    errors,
  };
}

export async function storageChallenge(args: Record<string, unknown>): Promise<unknown> {
  const blobHash = String(args.blobHash ?? "");
  if (!/^[0-9a-f]{64}$/.test(blobHash)) throw new Error("blobHash must be a sha256 hex digest");

  const placement = await placementFor(ledger, blobHash, args.placement);
  const holders = storageHolders();
  const configured = new Set(holders.map((holder) => holder.id));
  const missing = placement.shards
    .filter((shard) => !configured.has(shard.holder))
    .map((shard) => shard.holder);

  if (missing.length > 0) {
    throw new Error(`holder set is missing: ${missing.join(", ")}`);
  }

  const outcomes = await ledger.challenge(blobHash, holders);

  return { blobHash, outcomes, audit: ledger.audit(blobHash) };
}

export async function storageAudit(args: Record<string, unknown>): Promise<unknown> {
  const blobHash = String(args.blobHash ?? "");
  if (!/^[0-9a-f]{64}$/.test(blobHash)) throw new Error("blobHash must be a sha256 hex digest");

  await placementFor(ledger, blobHash, args.placement);

  if (args.challenge === true) {
    const holders = storageHolders();
    await ledger.challenge(blobHash, holders);
  }

  return {
    blobHash,
    audit: ledger.audit(blobHash),
    note:
      args.challenge === true
        ? "fresh challenge performed"
        : "no challenge performed; call rarext_storage_challenge for a fresh audit",
  };
}

export async function storagePin(args: Record<string, unknown>): Promise<unknown> {
  const content = args.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new Error("content must be non-empty base64 text");
  }

  const bytes = Buffer.from(content, "base64");
  if (bytes.length === 0) throw new Error("content decoded to zero bytes");
  if (bytes.length > maxBytes()) throw new Error(`content exceeds ${maxBytes()} bytes`);

  const cid = cidV1Raw(bytes);

  if (args.cid !== undefined && args.cid !== cid) {
    throw new Error("cid does not match the content");
  }

  const raw = process.env.RAREXT_PIN_URL ?? DEFAULT_PIN;
  const url = raw.endsWith("/v1/pins") ? raw : `${raw.replace(/\/+$/, "")}/v1/pins`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(process.env.RAREXT_PIN_TOKEN
        ? { authorization: `Bearer ${process.env.RAREXT_PIN_TOKEN}` }
        : {}),
    },
    body: JSON.stringify({
      cid,
      content: bytes.toString("base64"),
      root: typeof args.root === "string" ? args.root : null,
      publicationIds: Array.isArray(args.publicationIds)
        ? args.publicationIds.filter((value): value is string => typeof value === "string")
        : [],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const value = await limitedJson(response, 1024 * 1024, "pin service").catch(() => null);

  if (!response.ok) {
    const message =
      typeof value === "object" && value !== null && typeof (value as { error?: unknown }).error === "string"
        ? (value as { error: string }).error
        : `pin service returned ${response.status}`;
    throw new Error(message);
  }

  return value;
}

export const storageTools = [
  {
    name: "rarext_storage_put",
    description:
      "Erasure-code base64 content, place the shards on the configured holders, sign the placement with the local agent key, and register it with the API. Set sealed:true to encrypt with HKDF-SHA256 + AES-256-GCM using RAREXT_SEALED_SECRET before erasure coding, so holders receive only ciphertext. Returns the signed placement; content is capped by RAREXT_STORAGE_MAX_BYTES.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Base64 bytes to store." },
        dataShards: { type: "number", description: "k, default 4." },
        parityShards: { type: "number", description: "m, default 2." },
        tier: { type: "string", enum: ["ephemeral", "pinned", "durable"] },
        sealed: {
          type: "boolean",
          description: "Encrypt before erasure coding with RAREXT_SEALED_SECRET (at least 16 characters).",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "rarext_storage_get",
    description:
      "Read a placed blob from the configured holders, verify each shard digest, reconstruct from k shards, and return base64 content plus any holder errors. A sealed blob is decrypted with RAREXT_SEALED_SECRET.",
    inputSchema: {
      type: "object",
      properties: {
        blobHash: { type: "string" },
        placement: { type: "object", description: "Optional signed placement record." },
      },
      required: ["blobHash"],
    },
  },
  {
    name: "rarext_storage_challenge",
    description:
      "Challenge every shard of a placed blob with a fresh nonce and leaf index, verify the Merkle proof, and return the audit. Requires RAREXT_STORAGE_HOLDERS or RAREXT_HOLDERS.",
    inputSchema: {
      type: "object",
      properties: {
        blobHash: { type: "string" },
        placement: { type: "object", description: "Optional signed placement record." },
      },
      required: ["blobHash"],
    },
  },
  {
    name: "rarext_storage_audit",
    description:
      "Return the live-holder audit for a placed blob. Pass challenge:true to run a fresh challenge first; without it, a new process reports unverified witnesses.",
    inputSchema: {
      type: "object",
      properties: {
        blobHash: { type: "string" },
        placement: { type: "object", description: "Optional signed placement record." },
        challenge: { type: "boolean" },
      },
      required: ["blobHash"],
    },
  },
  {
    name: "rarext_storage_pin",
    description:
      "Pin base64 content to the configured pinning service after computing its CIDv1. Returns the pin record; RAREXT_PIN_TOKEN is sent when set.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "Base64 bytes to pin." },
        cid: { type: "string", description: "Optional claimed CID; must match the bytes." },
        root: { type: "string" },
        publicationIds: { type: "array", items: { type: "string" } },
      },
      required: ["content"],
    },
  },
];
