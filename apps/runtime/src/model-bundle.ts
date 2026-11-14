import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import type { KeyObject, JsonWebKey } from "node:crypto";
import { closeSync, openSync, readSync, statSync, writeSync } from "node:fs";

import { canonicalize } from "../../../packages/core/src/canonical.ts";
import { publicKeyId, verifyPayload } from "../../../packages/agent-sdk/src/index.ts";
import { verifyImageManifest } from "./image-manifest.ts";
import type { ImageManifest, IsolationClass } from "./image-manifest.ts";
import type { RootChain } from "./root-chain.ts";
import type { SignatureSuite } from "../../../packages/core/src/types.ts";
import {
  issueProviderCertificate,
  providerCertificatePayload,
  verifyCertificateChain,
} from "./certificates.ts";
import type { ProviderCertificate } from "./certificates.ts";
import { canonicalDigest, sha256Hex } from "./digest.ts";
import type { ApiShape, EngineName, ModelRef } from "./types.ts";

// The certificate primitives live in `certificates.ts` so the image manifest's
// chain and the machine quote's chain share one verifier; they are re-exported
// here for the callers that already import them from the bundle module.
export { issueProviderCertificate, providerCertificatePayload };
export type { ProviderCertificate };

/**
 * A model that lives on RAREXT.
 *
 * The weights are not a URL and not a vendor id: they are a list of
 * content-addressed blobs. Anyone who holds those blobs can rebuild the exact
 * model file and check it against the bytes the publisher committed. A provider
 * card names the bundle, the provider that serves it, and the endpoint; the
 * runtime refuses a card whose bundle does not hash to the model it claims.
 */
export const MODEL_BUNDLE_KIND = "rarext.model-bundle.v1";
export const MODEL_PROVIDER_KIND = "rarext.model-provider.v1";

/**
 * The engine ARTIFACT a bundle commits, when the engine is RAREXT's own. This
 * makes the engine part of the model's content identity: the bundle names the
 * exact artifact digest, runtime, and the registry manifest that carries its
 * shard list, so a provider can fetch and verify the engine without being told
 * out of band which one to run. A substituted engine is a different bundle.
 */
export interface EngineArtifactRef {
  /** The engine bundle's id (name@version). */
  id: string;
  name: string;
  engineVersion: string;
  /** How the artifact is executed. */
  runtime: string;
  /** `sha256:<hex>` of the reassembled engine artifact. */
  artifactDigest: string;
  /** sha256 hex of the canonical engine-bundle manifest stored on RAREXT. */
  manifestHash: string;
}

/** The execution classes a provider can serve. */
export type ExecutionRef =
  | {
      /** Inference runs in the provider process from committed model bytes. */
      kind: "native";
      /** The committed model class (v1: the deterministic xorshift32 class). */
      modelClass: "xorshift32";
      /** Default token count when a request names none. */
      defaultSteps: number;
    }
  | {
      /** A serving engine on the provider's machine loads the fetched model. */
      kind: "engine";
      engine: EngineName;
      /** Engine-native name the provider creates from the fetched weights. */
      engineModel: string | null;
      /** Present when the engine itself is a RAREXT artifact this bundle names. */
      artifact?: EngineArtifactRef | null;
    };

export interface BundleShard {
  index: number;
  /** sha256 hex of this shard's bytes. */
  hash: string;
  size: number;
}

/** The one sealed-shard scheme: AES-256-GCM, one key per bundle. */
export const SEAL_SCHEME = "aes-256-gcm";

/**
 * A sealed bundle. The shards on RAREXT are ciphertext, so the store — and
 * anyone reading the blobs — never holds the weights. The plaintext model
 * identity is still committed: `model.weightsDigest` and `model.sizeBytes` are
 * the plaintext's, and only a holder of the key can produce bytes that match
 * them. `keyCommitment` lets a provider check it was given the right key
 * without the key ever appearing in the manifest.
 */
/** How the data key is wrapped to an enclave's public key, when it is. */
export interface BundleKeyWrap {
  scheme: "rsa-oaep-sha256";
  /** Base64 RSA-OAEP(data key). Only the enclave's private key unwraps it. */
  wrappedKey: string;
}

export interface BundleSealing {
  scheme: typeof SEAL_SCHEME;
  /** sha256 of the 32-byte key. */
  keyCommitment: string;
  /**
   * Present when the data key is wrapped to an enclave's public key. Then the
   * RAREXT blobs AND the manifest are useless to anyone but the enclave: the
   * serving provider holds ciphertext and a wrapped key it cannot open, and the
   * enclave decrypts in its own process, so the operator never sees plaintext.
   */
  wrap?: BundleKeyWrap;
}

export interface ModelBundle {
  kind: typeof MODEL_BUNDLE_KIND;
  version: 1;
  id: string;
  model: ModelRef;
  execution: ExecutionRef;
  /** Every shard, in file order. */
  shards: BundleShard[];
  /** Sum of the SHARD bytes: plaintext size for an open bundle, ciphertext for a sealed one. */
  totalBytes: number;
  /** Commitment over the shard list (index, hash, size). */
  shardsRoot: string;
  /** Present when the shards are ciphertext and the model is opened with a key. */
  sealing?: BundleSealing;
  createdAt: string;
  /** sha256 over the canonical bundle with this field absent. */
  digest: string;
}

export const PROVIDER_MACHINE_KIND = "rarext.provider-machine.v1";

/**
 * A provider's machine identity. `machine` names the box (a host fingerprint,
 * or an operator's own id); `measurement` is a digest over what the provider
 * says it is running on. For a declared machine this is a hash of the id; a TEE
 * deployment would put the enclave measurement here. The value is only as
 * trustworthy as the key that signs the card — it proves the OPERATOR claims
 * these machines are distinct, not that they are physically so.
 */
export interface ProviderQuote {
  /** Base64 signature over the covered fields, by the leaf/attestation key. */
  signature: string;
  /** The leaf key that made the quote. */
  publicKey: unknown;
  suite: string;
  /**
   * Certificates from the leaf up to (but not including) the trust anchor. The
   * last certificate's issuer is the root; a deployment pins the root's key id.
   */
  chain?: ProviderCertificate[];
  /**
   * An append-only root rotation/revocation chain from the pinned anchor to the
   * root that issued `chain`. A verifier follows it to learn the CURRENT root
   * and which roots are revoked, so a quote rooted at a retired root is refused
   * as stale instead of being silently accepted under a static anchor.
   */
  rootChain?: RootChain;
}

export interface ProviderIndependence {
  kind: typeof PROVIDER_MACHINE_KIND;
  machine: string;
  measurement: string;
  /**
   * What produced the measurement. "software-image" today (a digest of the
   * declared machine and image); a TEE deployment names its enclave kind
   * ("sgx", "sev-snp", …) and puts the enclave measurement above.
   */
  scheme?: string;
  issuedAt: string;
  /**
   * The measurement of the code the enclave is RUNNING. A deployment pins it, so
   * an enclave that runs different code is refused — the code identity is checked,
   * not claimed. For a hardware enclave this is the image measurement; here it is
   * a digest of the runtime's own source.
   */
  code?: string;
  /**
   * A vendor-signed image manifest vouching for `code`. When present, the code
   * digest is bound to the vendor's signature, so a deployment that pins the
   * vendor accepts the image only if it is the signed one.
   */
  image?: ImageManifest;
  /**
   * The memory-isolation capability the provider claims for its running image.
   * `host-root-excluded` asserts the host root cannot read the process's memory;
   * a software-only process must NOT claim it. Covered by the quote, so the
   * capability is signed by the leaf key, and a deployment can require it.
   */
  isolation?: IsolationClass;
  /**
   * The digest of the enclave's ENCRYPTION public key, when the provider serves
   * one. Bound by the quote, so a caller can check that the key it seals a prompt
   * to is the key the attested enclave holds — a substituted key is refused.
   */
  enclaveKey?: string;
  /**
   * The verifier's freshness nonce, when the attestation is challenged. A quote
   * binds the nonce it was made for, so a replayed (stale) attestation — one made
   * for an earlier nonce — is refused.
   */
  challenge?: string;
  /**
   * A signed quote over the fields above. The provider's card signature proves
   * the OPERATOR claims this machine; this quote, signed by a vendor key the
   * deployment pins, is what lets a verifier check the claim instead of
   * believing the operator. A forged or unverifiable quote is refused.
   */
  quote?: ProviderQuote;
}

/** The exact fields a vendor quote covers — everything but the quote itself. */
export function providerQuotePayload(independence: ProviderIndependence): {
  kind: string;
  scheme: string;
  machine: string;
  measurement: string;
  issuedAt: string;
  isolation?: IsolationClass;
  code?: string;
  image?: ImageManifest;
  enclaveKey?: string;
  challenge?: string;
} {
  return {
    kind: independence.kind,
    scheme: independence.scheme ?? "",
    machine: independence.machine,
    measurement: independence.measurement,
    issuedAt: independence.issuedAt,
    ...(independence.isolation === undefined ? {} : { isolation: independence.isolation }),
    ...(independence.code === undefined ? {} : { code: independence.code }),
    ...(independence.image === undefined ? {} : { image: independence.image }),
    ...(independence.enclaveKey === undefined ? {} : { enclaveKey: independence.enclaveKey }),
    ...(independence.challenge === undefined ? {} : { challenge: independence.challenge }),
  };
}

/**
 * Verify an independence quote under its own public key, returning the vendor
 * key id when it holds. This is self-consistency (the quote is what it says);
 * checking it against the DEPLOYMENT's pinned vendor key is a further step the
 * verifier and gateway perform.
 */
export function verifyProviderQuote(independence: unknown): string | null {
  if (!isRecord(independence)) return null;
  const quote = independence.quote;
  if (!isRecord(quote) || typeof quote.signature !== "string" || !isRecord(quote.publicKey)) {
    return null;
  }
  const payload = providerQuotePayload(independence as unknown as ProviderIndependence);
  try {
    const ok = verifyPayload(
      quote.publicKey as unknown as JsonWebKey,
      payload,
      quote.signature,
      typeof quote.suite === "string" ? (quote.suite as SignatureSuite) : undefined,
    );
    if (!ok) return null;
    return publicKeyId(quote.publicKey as unknown as JsonWebKey);
  } catch {
    return null;
  }
}

/**
 * Verify a quote AND its chain of trust, returning the ROOT key id the chain
 * terminates at. The chain walk lives in `certificates.ts`, shared with the image
 * manifest's chain, so "the chain must reach the pinned root" is one function.
 */
export function verifyProviderChain(independence: unknown): string | null {
  if (!isRecord(independence)) return null;
  const quote = independence.quote;
  if (!isRecord(quote) || typeof quote.signature !== "string" || !isRecord(quote.publicKey)) {
    return null;
  }
  const payload = providerQuotePayload(independence as unknown as ProviderIndependence);
  return verifyCertificateChain({
    leafPublicKey: quote.publicKey,
    payload,
    signature: quote.signature,
    suite: typeof quote.suite === "string" ? quote.suite : undefined,
    chain: quote.chain,
  });
}

/**
 * The length of a quote's certificate chain, or -1 if the chain does not verify.
 * A chain of zero means the leaf is its own root; a deployment that requires a
 * hardware-rooted attestation demands a minimum depth so a bare leaf cannot pass.
 */
export function providerChainDepth(independence: unknown): number {
  if (verifyProviderChain(independence) === null) return -1;
  const quote = (independence as { quote?: { chain?: unknown[] } }).quote;
  return Array.isArray(quote?.chain) ? quote.chain.length : 0;
}

/**
 * The boot stages a VALID certificate chain names, from the leaf up. A
 * measured-boot chain records "app" → "os" → "firmware"; a deployment that
 * requires those stages refuses a quote whose chain omits any of them, so a leaf
 * signed outside the measured boot cannot pass as hardware-rooted.
 */
export function providerBootStages(independence: unknown): string[] {
  if (verifyProviderChain(independence) === null) return [];
  const quote = (independence as { quote?: { chain?: unknown[] } }).quote;
  const chain = Array.isArray(quote?.chain) ? quote.chain : [];
  return chain
    .map((entry) => (isRecord(entry) && typeof entry.stage === "string" ? entry.stage : null))
    .filter((stage): stage is string => stage !== null);
}

/**
 * The measured value each boot stage carries, from a VALID chain. A deployment
 * pins the measurements it approves; a chain whose firmware/OS/app measurement is
 * not the pinned one is refused, so the stage NAMES become checked values.
 */
export function providerStageMeasurements(independence: unknown): Record<string, string> {
  if (verifyProviderChain(independence) === null) return {};
  const quote = (independence as { quote?: { chain?: unknown[] } }).quote;
  const chain = Array.isArray(quote?.chain) ? quote.chain : [];
  const measurements: Record<string, string> = {};
  for (const entry of chain) {
    if (isRecord(entry) && typeof entry.stage === "string" && typeof entry.measurement === "string") {
      measurements[entry.stage] = entry.measurement;
    }
  }
  return measurements;
}

export interface ProviderCard {
  kind: typeof MODEL_PROVIDER_KIND;
  version: 1;
  id: string;
  /** Where the provider answers, normalized without a trailing slash. */
  endpoint: string;
  bundle: {
    id: string;
    digest: string;
    shardsRoot: string;
    weightsDigest: string;
    shardCount: number;
    totalBytes: number;
    /** True when the shards are ciphertext and the provider opened them with a key. */
    sealed?: boolean;
    /** sha256 of the canonical bundle bytes, so a reader can fetch the manifest itself. */
    manifestHash: string;
  };
  model: ModelRef;
  execution: ExecutionRef;
  provider: {
    handle: string | null;
    keyId: string | null;
    publicKey?: unknown;
    suite?: string;
  };
  apis: ApiShape[];
  /**
   * The machine the provider attests it runs on. Covered by the card signature,
   * which is the operator's own key: the machine identity is bound to the key
   * that signs for it. A deployment can require a quorum over distinct
   * machines, so two keys on one box are not two independent answers.
   */
  independence?: ProviderIndependence;
  createdAt: string;
  /**
   * The provider's own signature over the card, when it has an identity. It
   * covers every field except `digest` and itself. A card without one is still
   * self-digested; a card with one proves the operator controls the key it
   * names, which is what makes the quorum's operator identities more than
   * labels.
   */
  signature?: string;
  /** sha256 over the canonical card with `digest` and `signature` absent. */
  digest: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** The commitment over the shard list. Order is part of the commitment. */
export function bundleShardsRoot(shards: BundleShard[]): string {
  return createHash("sha256")
    .update(
      canonicalize(
        shards.map((shard) => ({
          index: shard.index,
          hash: shard.hash,
          size: shard.size,
        })),
      ),
    )
    .digest("hex");
}

export function modelWeightsDigest(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

export function bundleDigest(bundle: Omit<ModelBundle, "digest"> | ModelBundle): string {
  const { digest: _digest, ...rest } = bundle as ModelBundle;
  return canonicalDigest(rest);
}

export function bundleManifestBytes(bundle: ModelBundle): Buffer {
  return Buffer.from(canonicalize(bundle), "utf8");
}

export function bundleManifestHash(bundle: ModelBundle): string {
  return sha256Hex(bundleManifestBytes(bundle));
}

export function chunkModelBytes(bytes: Uint8Array, chunkBytes = DEFAULT_CHUNK_BYTES): Buffer[] {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1) {
    throw new Error("chunkBytes must be a positive integer");
  }
  if (bytes.length === 0) throw new Error("a model cannot be empty");

  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    chunks.push(Buffer.from(bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length))));
  }
  return chunks;
}

const SEAL_KEY_BYTES = 32;
const SEAL_NONCE_BYTES = 12;
const SEAL_TAG_BYTES = 16;

/** A fresh 32-byte seal key. The caller is responsible for delivering it. */
export function generateSealKey(): Buffer {
  return randomBytes(SEAL_KEY_BYTES);
}

export function sealKeyCommitment(key: Uint8Array): string {
  return sha256Hex(key);
}

/**
 * One shard: a random 96-bit nonce, the AES-256-GCM ciphertext, and the tag.
 * Sealing each shard independently means a provider opens the shards it holds
 * rather than the whole file at once, and a corrupted shard fails its own tag
 * before any plaintext is trusted.
 */
function sealChunk(plain: Uint8Array, key: Uint8Array): Buffer {
  const nonce = randomBytes(SEAL_NONCE_BYTES);
  const cipher = createCipheriv(SEAL_SCHEME, key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]);
}

function openChunk(sealed: Uint8Array, key: Uint8Array): Buffer {
  if (sealed.length < SEAL_NONCE_BYTES + SEAL_TAG_BYTES) {
    throw new Error("a sealed shard is shorter than its nonce and tag");
  }
  const nonce = sealed.subarray(0, SEAL_NONCE_BYTES);
  const tag = sealed.subarray(sealed.length - SEAL_TAG_BYTES);
  const ciphertext = sealed.subarray(SEAL_NONCE_BYTES, sealed.length - SEAL_TAG_BYTES);
  const decipher = createDecipheriv(SEAL_SCHEME, key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export interface BuildBundleInput {
  bytes: Uint8Array;
  model: ModelRef;
  execution: ExecutionRef;
  id?: string;
  createdAt?: string;
  chunkBytes?: number;
  /** When given (32 bytes), the shards are ciphertext and the bundle is sealed. */
  sealKey?: Uint8Array;
  /**
   * When given with `sealKey`, the data key is wrapped to this RSA public key
   * (an enclave's), so only the enclave can open the model.
   */
  wrapPublicKey?: KeyObject | string;
}

/**
 * Split a model file into shards and commit it. The digest is computed from the
 * bytes here, never copied from the caller; a caller that supplies a different
 * `weightsDigest` or `sizeBytes` is refused rather than allowed to relabel the
 * model.
 */
export function buildModelBundle(input: BuildBundleInput): {
  bundle: ModelBundle;
  chunks: Buffer[];
} {
  if (input.bytes.length === 0) throw new Error("a model cannot be empty");

  const digest = modelWeightsDigest(input.bytes);
  if (input.model.sizeBytes !== null && input.model.sizeBytes !== input.bytes.length) {
    throw new Error(
      `model.sizeBytes is ${input.model.sizeBytes} but the file is ${input.bytes.length} bytes`,
    );
  }
  if (input.model.weightsDigest !== null && input.model.weightsDigest !== digest) {
    throw new Error(
      `model.weightsDigest ${input.model.weightsDigest} does not match the file digest ${digest}`,
    );
  }

  const plaintextChunks = chunkModelBytes(input.bytes, input.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  let sealing: BundleSealing | undefined;
  let chunks = plaintextChunks;
  if (input.sealKey !== undefined) {
    if (input.sealKey.length !== SEAL_KEY_BYTES) {
      throw new Error(`a seal key must be ${SEAL_KEY_BYTES} bytes`);
    }
    sealing = { scheme: SEAL_SCHEME, keyCommitment: sealKeyCommitment(input.sealKey) };
    if (input.wrapPublicKey !== undefined) {
      // Wrap the data key to the enclave: only its private key can open the
      // model, so a provider with the manifest holds ciphertext it cannot read.
      const wrappedKey = publicEncrypt(
        { key: input.wrapPublicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        input.sealKey,
      ).toString("base64");
      sealing = { ...sealing, wrap: { scheme: "rsa-oaep-sha256", wrappedKey } };
    }
    chunks = plaintextChunks.map((chunk) => sealChunk(chunk, input.sealKey!));
  }

  const shards: BundleShard[] = chunks.map((chunk, index) => ({
    index,
    hash: sha256Hex(chunk),
    size: chunk.length,
  }));

  const id = input.id ?? input.model.id;
  const partial = {
    kind: MODEL_BUNDLE_KIND,
    version: 1,
    id,
    // The model identity is the PLAINTEXT's: sizeBytes and weightsDigest describe
    // the file a holder of the key reconstructs, not the ciphertext on the wire.
    model: {
      ...input.model,
      sizeBytes: input.bytes.length,
      weightsDigest: digest,
    },
    execution: input.execution,
    shards,
    totalBytes: chunks.reduce((total, chunk) => total + chunk.length, 0),
    shardsRoot: bundleShardsRoot(shards),
    ...(sealing === undefined ? {} : { sealing }),
    createdAt: input.createdAt ?? new Date().toISOString(),
  } satisfies Omit<ModelBundle, "digest">;

  return { bundle: { ...partial, digest: bundleDigest(partial) }, chunks };
}

/**
 * Build a bundle for a container ON DISK without holding it.
 *
 * `buildModelBundle` hashes the whole buffer and copies every shard, so a 6.5 GiB
 * container would need 13 GiB of memory to bundle. This streams the file: the
 * weights digest is folded in as it is read, one shard is hashed at a time, and
 * the shard bytes are read on demand by `readShard` (which `uploadBundleFromFile`
 * uses). The resulting bundle is identical to `buildModelBundle`'s for the same
 * bytes and chunk size.
 */
export function buildModelBundleFromFile(input: {
  path: string;
  model: ModelRef;
  execution: ExecutionRef;
  chunkBytes?: number;
  createdAt?: string;
  id?: string;
}): { bundle: ModelBundle; readShard: (index: number) => Buffer; close: () => void } {
  const fd = openSync(input.path, "r");
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    closeSync(fd);
  };
  try {
    const size = statSync(input.path).size;
    if (size === 0) throw new Error("a model cannot be empty");
    const chunkBytes = input.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    const whole = createHash("sha256");
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, size));
    const shards: BundleShard[] = [];
    let index = 0;
    let offset = 0;
    while (offset < size) {
      const want = Math.min(chunkBytes, size - offset);
      const read = readSync(fd, buffer, 0, want, offset);
      if (read !== want) throw new Error(`short read at ${offset}: ${read} of ${want} bytes`);
      const slice = buffer.subarray(0, read);
      whole.update(slice);
      shards.push({ index, hash: sha256Hex(slice), size: read });
      offset += read;
      index += 1;
    }
    const digest = `sha256:${whole.digest("hex")}`;
    if (input.model.weightsDigest !== null && input.model.weightsDigest !== digest) {
      throw new Error(
        `model.weightsDigest ${input.model.weightsDigest} does not match the file digest ${digest}`,
      );
    }
    const partial = {
      kind: MODEL_BUNDLE_KIND,
      version: 1,
      id: input.id ?? input.model.id,
      model: { ...input.model, sizeBytes: size, weightsDigest: digest },
      execution: input.execution,
      shards,
      totalBytes: size,
      shardsRoot: bundleShardsRoot(shards),
      createdAt: input.createdAt ?? new Date().toISOString(),
    } satisfies Omit<ModelBundle, "digest">;
    // The descriptor stays open for `readShard`, so the caller owns the close.
    return {
      bundle: { ...partial, digest: bundleDigest(partial) },
      readShard: (which: number): Buffer => {
        const shard = shards[which];
        if (shard === undefined) throw new Error(`no shard ${which}`);
        const out = Buffer.allocUnsafe(shard.size);
        const at = shards.slice(0, which).reduce((total, item) => total + item.size, 0);
        const got = readSync(fd, out, 0, shard.size, at);
        if (got !== shard.size) throw new Error(`short read of shard ${which}`);
        return out;
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * Upload a bundle whose shards live in a file, one at a time. The same
 * verification as `uploadBundle`: the registry must store each shard under the
 * committed hash.
 */
export async function uploadBundleFromFile(input: {
  registry: string;
  bundle: ModelBundle;
  readShard: (index: number) => Buffer;
  fetchImpl?: typeof fetch;
}): Promise<UploadedBundle> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const registry = normalizeBase(input.registry);
  const shardHashes: string[] = [];
  for (let index = 0; index < input.bundle.shards.length; index += 1) {
    const shard = input.bundle.shards[index]!;
    const chunk = input.readShard(index);
    const response = await fetchImpl(`${registry}/v1/blobs/raw`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-rarext-hash": shard.hash,
        "x-rarext-media-type": "application/octet-stream",
      },
      body: Buffer.from(chunk) as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new Error(`registry refused shard ${index}: HTTP ${response.status} ${await response.text()}`);
    }
    const record = (await response.json()) as { hash?: unknown };
    if (record.hash !== shard.hash) {
      throw new Error(`registry stored shard ${index} as ${String(record.hash)}, expected ${shard.hash}`);
    }
    shardHashes.push(shard.hash);
  }
  const manifest = bundleManifestBytes(input.bundle);
  const manifestHash = sha256Hex(manifest);
  const response = await fetchImpl(`${registry}/v1/blobs/raw`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-rarext-hash": manifestHash,
      "x-rarext-media-type": "application/vnd.rarext.model-bundle+json",
    },
    body: manifest as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`registry refused the manifest: HTTP ${response.status} ${await response.text()}`);
  }
  return { manifestHash, shardHashes };
}

const EXECUTION_KINDS = new Set(["native", "engine"]);
const ENGINE_NAMES = new Set<EngineName>([
  "rarext",
  "ollama",
  "strata",
  "freetoken",
  "openai-compatible",
  "anthropic",
]);

export function executionProblems(execution: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(execution)) return ["execution must be an object"];
  if (typeof execution.kind !== "string" || !EXECUTION_KINDS.has(execution.kind)) {
    errors.push("execution.kind must be native or engine");
    return errors;
  }

  if (execution.kind === "native") {
    if (execution.modelClass !== "xorshift32") {
      errors.push('execution.modelClass must be "xorshift32"');
    }
    if (
      !Number.isSafeInteger(execution.defaultSteps) ||
      (execution.defaultSteps as number) < 1 ||
      (execution.defaultSteps as number) > 4096
    ) {
      errors.push("execution.defaultSteps must be an integer between 1 and 4096");
    }
  } else {
    if (typeof execution.engine !== "string" || !ENGINE_NAMES.has(execution.engine as EngineName)) {
      errors.push(`execution.engine must be one of ${[...ENGINE_NAMES].join(", ")}`);
    }
    if (execution.engineModel !== null && typeof execution.engineModel !== "string") {
      errors.push("execution.engineModel must be a string or null");
    }
    if (execution.artifact !== undefined && execution.artifact !== null) {
      errors.push(...engineArtifactProblems(execution.artifact));
    }
  }
  return errors;
}

const ENGINE_ARTIFACT_RUNTIMES = new Set([
  "rarext.native-engine.node-cjs.v1",
  "rarext.gguf-engine.node-cjs.v1",
  "rarext.wasm-engine.wasm.v1",
  "rarext.worker-engine.node-cjs.v1",
]);

function engineArtifactProblems(value: unknown): string[] {
  if (!isRecord(value)) return ["execution.artifact must be an object or null"];
  const errors: string[] = [];
  for (const key of ["id", "name", "engineVersion", "runtime"] as const) {
    if (typeof value[key] !== "string" || (value[key] as string).length === 0) {
      errors.push(`execution.artifact.${key} must be a non-empty string`);
    }
  }
  if (typeof value.runtime === "string" && !ENGINE_ARTIFACT_RUNTIMES.has(value.runtime)) {
    errors.push("execution.artifact.runtime is not a known engine runtime");
  }
  if (typeof value.artifactDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.artifactDigest)) {
    errors.push("execution.artifact.artifactDigest must be sha256:<hex>");
  }
  if (typeof value.manifestHash !== "string" || !/^[0-9a-f]{64}$/.test(value.manifestHash)) {
    errors.push("execution.artifact.manifestHash must be a sha256 hex digest");
  }
  return errors;
}

function modelProblems(model: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(model)) return ["model must be an object"];
  if (typeof model.id !== "string" || model.id.length === 0) errors.push("model.id must be a non-empty string");
  if (typeof model.weightsDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(model.weightsDigest)) {
    errors.push("model.weightsDigest must be sha256:<64 hex>");
  }
  if (!Number.isSafeInteger(model.sizeBytes) || (model.sizeBytes as number) < 1) {
    errors.push("model.sizeBytes must be a positive integer");
  }
  return errors;
}

/** Validate a bundle read from a file, a registry, or a provider. */
export function verifyModelBundle(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["bundle must be an object"];
  if (value.kind !== MODEL_BUNDLE_KIND) errors.push(`bundle.kind must be "${MODEL_BUNDLE_KIND}"`);
  if (value.version !== 1) errors.push("bundle.version must be 1");
  if (typeof value.id !== "string" || value.id.length === 0) errors.push("bundle.id must be a non-empty string");
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    errors.push("bundle.createdAt must be an ISO timestamp");
  }
  errors.push(...modelProblems(value.model));
  errors.push(...executionProblems(value.execution));

  if (!Array.isArray(value.shards) || value.shards.length === 0) {
    errors.push("bundle.shards must be a non-empty array");
  } else {
    let total = 0;
    value.shards.forEach((raw, index) => {
      if (!isRecord(raw)) {
        errors.push(`bundle.shards[${index}] must be an object`);
        return;
      }
      if (raw.index !== index) errors.push(`bundle.shards[${index}].index must be ${index}`);
      if (typeof raw.hash !== "string" || !HEX64.test(raw.hash)) {
        errors.push(`bundle.shards[${index}].hash must be a sha256 hex digest`);
      }
      if (!Number.isSafeInteger(raw.size) || (raw.size as number) < 1) {
        errors.push(`bundle.shards[${index}].size must be a positive integer`);
      } else {
        total += raw.size as number;
      }
    });

    if (Number.isSafeInteger(value.totalBytes) && value.totalBytes !== total) {
      errors.push(`bundle.totalBytes is ${value.totalBytes} but the shards sum to ${total}`);
    }
    if (typeof value.shardsRoot === "string" && value.shardsRoot !== bundleShardsRoot(value.shards as BundleShard[])) {
      errors.push("bundle.shardsRoot does not match the shard list");
    }
  }

  if (value.sealing !== undefined) {
    if (!isRecord(value.sealing)) {
      errors.push("bundle.sealing must be an object");
    } else {
      if (value.sealing.scheme !== SEAL_SCHEME) {
        errors.push(`bundle.sealing.scheme must be "${SEAL_SCHEME}"`);
      }
      if (typeof value.sealing.keyCommitment !== "string" || !HEX64.test(value.sealing.keyCommitment)) {
        errors.push("bundle.sealing.keyCommitment must be a sha256 hex digest");
      }
      if (value.sealing.wrap !== undefined) {
        if (!isRecord(value.sealing.wrap)) {
          errors.push("bundle.sealing.wrap must be an object");
        } else {
          if (value.sealing.wrap.scheme !== "rsa-oaep-sha256") {
            errors.push('bundle.sealing.wrap.scheme must be "rsa-oaep-sha256"');
          }
          if (
            typeof value.sealing.wrap.wrappedKey !== "string" ||
            value.sealing.wrap.wrappedKey.length === 0
          ) {
            errors.push("bundle.sealing.wrap.wrappedKey must be a base64 string");
          }
        }
      }
      // A sealed bundle's shards are ciphertext, so each holds at least a nonce
      // and a tag more than its plaintext; a "sealed" bundle that is not bigger
      // than its plaintext cannot be a real ciphertext.
      if (isRecord(value.model) && Number.isSafeInteger(value.model.sizeBytes)) {
        const shardCount = Array.isArray(value.shards) ? value.shards.length : 0;
        const cipherOverhead = shardCount * (SEAL_NONCE_BYTES + SEAL_TAG_BYTES);
        if (
          Number.isSafeInteger(value.totalBytes) &&
          (value.totalBytes as number) < (value.model.sizeBytes as number) + cipherOverhead
        ) {
          errors.push("bundle.totalBytes is too small for a sealed bundle of that model");
        }
      }
    }
  }

  if (typeof value.digest !== "string" || !HEX64.test(value.digest)) {
    errors.push("bundle.digest must be a sha256 hex digest");
  } else if (value.digest !== bundleDigest(value as unknown as ModelBundle)) {
    errors.push("bundle.digest does not match the canonical bundle");
  }

  return unique(errors);
}

/**
 * Verify fetched shard bytes against the shard list and the model identity.
 *
 * For an open bundle the shards ARE the file, so the whole-file digest is
 * checked directly. For a sealed bundle the shards are ciphertext: their
 * hashes and sizes are checked against the commitment, and the plaintext
 * digest is checked only when a key is supplied — a reader without the key can
 * still prove the ciphertext is the committed ciphertext.
 */
export function verifyBundleChunks(
  bundle: ModelBundle,
  chunks: Uint8Array[],
  sealKey?: Uint8Array,
): { ok: boolean; errors: string[]; bytes: Buffer } {
  const errors: string[] = [];

  if (chunks.length !== bundle.shards.length) {
    errors.push(`expected ${bundle.shards.length} shards, got ${chunks.length}`);
  }

  for (let index = 0; index < Math.min(chunks.length, bundle.shards.length); index++) {
    const shard = bundle.shards[index]!;
    const chunk = chunks[index]!;
    if (chunk.length !== shard.size) {
      errors.push(`shard ${index} is ${chunk.length} bytes, expected ${shard.size}`);
    }
    const hash = sha256Hex(chunk);
    if (hash !== shard.hash) {
      errors.push(`shard ${index} hashes to ${hash}, expected ${shard.hash}`);
    }
  }

  const ciphertext = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  if (ciphertext.length !== bundle.totalBytes) {
    errors.push(`reassembled ${ciphertext.length} bytes, expected ${bundle.totalBytes}`);
  }

  if (bundle.sealing !== undefined) {
    if (sealKey === undefined) {
      return { ok: errors.length === 0, errors, bytes: ciphertext };
    }
    if (sealKeyCommitment(sealKey) !== bundle.sealing.keyCommitment) {
      errors.push("the seal key does not match the bundle's key commitment");
      return { ok: false, errors, bytes: ciphertext };
    }
    let plaintext: Buffer;
    try {
      plaintext = Buffer.concat(
        chunks.map((chunk) => openChunk(Buffer.from(chunk), sealKey)),
      );
    } catch {
      errors.push("a sealed shard did not authenticate under the key");
      return { ok: false, errors, bytes: ciphertext };
    }
    if (plaintext.length !== bundle.model.sizeBytes) {
      errors.push(`opened ${plaintext.length} bytes, expected ${bundle.model.sizeBytes}`);
    }
    const digest = modelWeightsDigest(plaintext);
    if (digest !== bundle.model.weightsDigest) {
      errors.push(`opened model hashes to ${digest}, expected ${bundle.model.weightsDigest}`);
    }
    return { ok: errors.length === 0, errors, bytes: plaintext };
  }

  const digest = modelWeightsDigest(ciphertext);
  if (digest !== bundle.model.weightsDigest) {
    errors.push(`reassembled model hashes to ${digest}, expected ${bundle.model.weightsDigest}`);
  }

  return { ok: errors.length === 0, errors, bytes: ciphertext };
}

export function reassembleChunks(chunks: Uint8Array[]): Buffer {
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

// ---------------------------------------------------------------------------
// Registry transport
// ---------------------------------------------------------------------------

function normalizeBase(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * The registries to try, primary first, de-duplicated. A bundle is
 * content-addressed, so its shards and manifest are the same bytes wherever they
 * are mirrored; naming more than one means no single registry is a hard
 * dependency for serving a model.
 */
function registryBases(input: { registry?: string; registries?: readonly string[] }): string[] {
  const list = [
    ...(input.registries ?? []),
    ...(input.registry === undefined ? [] : [input.registry]),
  ];
  const bases = [
    ...new Set(list.map((entry) => normalizeBase(entry)).filter((entry) => entry !== "")),
  ];
  if (bases.length === 0) throw new Error("at least one registry is required");
  return bases;
}

/**
 * Fetch one shard from the first registry that serves bytes matching the
 * commitment. A registry that is down, missing the shard, or serving the wrong
 * bytes is skipped; the fetch fails only when every registry fails, naming what
 * each did.
 */
async function fetchShard(
  registries: readonly string[],
  shard: BundleShard,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const attempts: string[] = [];
  for (const base of registries) {
    try {
      const response = await fetchImpl(`${base}/v1/blobs/${shard.hash}/raw`);
      if (!response.ok) {
        attempts.push(`${base}: HTTP ${response.status}`);
        continue;
      }
      const chunk = Buffer.from(await response.arrayBuffer());
      if (chunk.length !== shard.size || sha256Hex(chunk) !== shard.hash) {
        attempts.push(`${base}: bytes do not match the commitment`);
        continue;
      }
      return chunk;
    } catch (error) {
      attempts.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(
    `shard ${shard.index} (${shard.hash}) failed verification or is missing from every registry: ` +
      `${attempts.join("; ")}`,
  );
}

export interface UploadBundleInput {
  registry: string;
  bundle: ModelBundle;
  chunks: Uint8Array[];
  fetchImpl?: typeof fetch;
}

export interface UploadedBundle {
  manifestHash: string;
  shardHashes: string[];
}

/**
 * Store every shard and the bundle manifest itself as RAREXT blobs. The shard
 * hash is sent with the bytes, so the node checks the content address instead
 * of believing the uploader.
 */
export async function uploadBundle(input: UploadBundleInput): Promise<UploadedBundle> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const registry = normalizeBase(input.registry);
  const shardHashes: string[] = [];

  for (let index = 0; index < input.chunks.length; index++) {
    const chunk = input.chunks[index]!;
    const shard = input.bundle.shards[index]!;
    const response = await fetchImpl(`${registry}/v1/blobs/raw`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-rarext-hash": shard.hash,
        "x-rarext-media-type": "application/octet-stream",
      },
      body: Buffer.from(chunk) as unknown as BodyInit,
    });
    if (!response.ok) {
      throw new Error(
        `registry refused shard ${index}: HTTP ${response.status} ${await response.text()}`,
      );
    }
    const record = (await response.json()) as { hash?: unknown };
    if (record.hash !== shard.hash) {
      throw new Error(`registry stored shard ${index} as ${String(record.hash)}, expected ${shard.hash}`);
    }
    shardHashes.push(shard.hash);
  }

  const manifest = bundleManifestBytes(input.bundle);
  const manifestHash = sha256Hex(manifest);
  const response = await fetchImpl(`${registry}/v1/blobs/raw`, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      "x-rarext-hash": manifestHash,
      "x-rarext-media-type": "application/vnd.rarext.model-bundle+json",
    },
    body: manifest as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`registry refused the bundle manifest: HTTP ${response.status} ${await response.text()}`);
  }

  return { manifestHash, shardHashes };
}

export interface FetchBundleInput {
  /** The primary registry. */
  registry?: string;
  /** Mirrors to fall back to, so one registry outage does not stop a provider. */
  registries?: string[];
  bundle: ModelBundle;
  fetchImpl?: typeof fetch;
  onShard?: (index: number, size: number) => void;
  /** Required to open a sealed bundle; ignored for an open one. */
  sealKey?: Uint8Array;
}

/**
 * Fetch every shard and verify the whole file before returning it.
 *
 * The file is written once into a buffer of the committed size and the digest
 * is folded in as each shard arrives. A large model is therefore held once, not
 * once as chunks and again as a concatenation.
 */
export async function fetchBundleChunks(input: FetchBundleInput): Promise<{
  bytes: Buffer;
}> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const registries = registryBases(input);
  const sealed = input.bundle.sealing !== undefined;
  const chunks: Buffer[] = [];
  const bytes = sealed ? null : Buffer.allocUnsafe(input.bundle.totalBytes);
  const whole = createHash("sha256");
  let offset = 0;

  for (const shard of input.bundle.shards) {
    const chunk = await fetchShard(registries, shard, fetchImpl);
    if (offset + chunk.length > input.bundle.totalBytes) {
      throw new Error(
        `shard ${shard.index} overruns the committed total of ${input.bundle.totalBytes} bytes`,
      );
    }
    if (bytes === null) chunks.push(chunk);
    else chunk.copy(bytes, offset);
    offset += chunk.length;
    whole.update(chunk);
    input.onShard?.(shard.index, chunk.length);
  }

  if (offset !== input.bundle.totalBytes) {
    throw new Error(`reassembled ${offset} bytes, expected ${input.bundle.totalBytes}`);
  }

  // An open bundle's shards ARE the file; verify the whole-file digest directly.
  if (bytes !== null) {
    const digest = `sha256:${whole.digest("hex")}`;
    if (digest !== input.bundle.model.weightsDigest) {
      throw new Error(
        `reassembled model hashes to ${digest}, expected ${input.bundle.model.weightsDigest}`,
      );
    }
    return { bytes };
  }

  // A sealed bundle's shards are ciphertext. Opening happens here, in memory, and
  // the plaintext is verified against the committed model identity before it is
  // returned — the caller never has to trust the key or the transport.
  const sealKey = input.sealKey;
  if (sealKey === undefined) {
    throw new Error("this model bundle is sealed; a seal key is required to open it");
  }
  if (sealKeyCommitment(sealKey) !== input.bundle.sealing!.keyCommitment) {
    throw new Error("the seal key does not match the bundle's key commitment");
  }
  const plaintext = Buffer.concat(chunks.map((chunk) => openChunk(chunk, sealKey)));
  if (plaintext.length !== input.bundle.model.sizeBytes) {
    throw new Error(`opened ${plaintext.length} bytes, expected ${input.bundle.model.sizeBytes}`);
  }
  const digest = modelWeightsDigest(plaintext);
  if (digest !== input.bundle.model.weightsDigest) {
    throw new Error(
      `opened model hashes to ${digest}, expected ${input.bundle.model.weightsDigest}`,
    );
  }

  return { bytes: plaintext };
}

/**
 * Fetch every shard, verify the whole file, and write it to `path` — one shard
 * resident at a time. This is the streaming counterpart of
 * `fetchBundleChunks`: a provider can serve a container larger than its memory
 * by verifying it to disk and then reading the rows it needs on demand. A
 * sealed bundle is refused, because opening it happens in memory.
 */
export async function fetchBundleChunksToFile(
  input: FetchBundleInput & { path: string },
): Promise<{ bytes: number; digest: string; path: string }> {
  if (input.bundle.sealing !== undefined) {
    throw new Error("a sealed bundle cannot be streamed: it must be opened in memory");
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const registries = registryBases(input);
  const whole = createHash("sha256");
  const fd = openSync(input.path, "w");
  let offset = 0;
  try {
    for (const shard of input.bundle.shards) {
      const chunk = await fetchShard(registries, shard, fetchImpl);
      if (offset + chunk.length > input.bundle.totalBytes) {
        throw new Error(
          `shard ${shard.index} overruns the committed total of ${input.bundle.totalBytes} bytes`,
        );
      }
      let written = 0;
      while (written < chunk.length) {
        written += writeSync(fd, chunk, written, chunk.length - written, offset + written);
      }
      offset += chunk.length;
      whole.update(chunk);
      input.onShard?.(shard.index, chunk.length);
    }
  } finally {
    closeSync(fd);
  }
  if (offset !== input.bundle.totalBytes) {
    throw new Error(`reassembled ${offset} bytes, expected ${input.bundle.totalBytes}`);
  }
  const digest = `sha256:${whole.digest("hex")}`;
  if (digest !== input.bundle.model.weightsDigest) {
    throw new Error(
      `reassembled model hashes to ${digest}, expected ${input.bundle.model.weightsDigest}`,
    );
  }
  return { bytes: offset, digest, path: input.path };
}

/**
 * A bounded, memory-mapped-style reader over a file: `readAt(offset, length)`
 * allocates only what it returns, so an engine reading it never holds the whole
 * container. This is what a streaming provider hands to the engine artifact.
 */
export function fileReader(path: string): {
  readAt: (offset: number, length: number) => Uint8Array;
  sizeBytes: number;
  close: () => void;
} {
  const fd = openSync(path, "r");
  const sizeBytes = statSync(path).size;
  return {
    readAt: (offset: number, length: number): Uint8Array => {
      const want = Math.max(0, Math.min(length, sizeBytes - offset));
      if (want === 0) return new Uint8Array(0);
      const buffer = Buffer.allocUnsafe(want);
      const read = readSync(fd, buffer, 0, want, offset);
      return new Uint8Array(buffer.buffer, buffer.byteOffset, read);
    },
    sizeBytes,
    close: () => closeSync(fd),
  };
}

/**
 * Open the data key of a bundle sealed to an enclave, using the enclave's RSA
 * private key. Enforces the bundle's key commitment, so a wrapped key that does
 * not unwrap to the committed key is refused.
 */
export function unwrapSealKey(bundle: ModelBundle, privateKey: KeyObject | string): Buffer {
  const wrap = bundle.sealing?.wrap;
  if (wrap === undefined) {
    throw new Error("this bundle is not sealed to an enclave key; there is nothing to unwrap");
  }
  let key: Buffer;
  try {
    key = privateDecrypt(
      { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
      Buffer.from(wrap.wrappedKey, "base64"),
    );
  } catch {
    throw new Error("the enclave key does not unwrap this bundle's data key");
  }
  if (key.length !== SEAL_KEY_BYTES || sealKeyCommitment(key) !== bundle.sealing!.keyCommitment) {
    throw new Error("the unwrapped data key does not match the bundle's key commitment");
  }
  return key;
}

/**
 * Fetch a sealed bundle's shards as CIPHERTEXT and verify them against the
 * commitment, WITHOUT a key. This is what a forwarding provider can prove: it
 * holds and serves the committed ciphertext, but cannot open it.
 */
export async function fetchBundleCiphertext(input: {
  registry?: string;
  registries?: string[];
  bundle: ModelBundle;
  fetchImpl?: typeof fetch;
  onShard?: (index: number, size: number) => void;
}): Promise<{ bytes: Buffer }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const registries = registryBases(input);
  if (input.bundle.sealing === undefined) {
    throw new Error("fetchBundleCiphertext is only for a sealed bundle");
  }
  const chunks: Buffer[] = [];
  for (const shard of input.bundle.shards) {
    const chunk = await fetchShard(registries, shard, fetchImpl);
    chunks.push(chunk);
    input.onShard?.(shard.index, chunk.length);
  }
  const check = verifyBundleChunks(input.bundle, chunks);
  if (!check.ok) throw new Error(check.errors.join("; "));
  return { bytes: check.bytes };
}

/** Fetch the bundle manifest by its content address and verify it. */
export async function fetchBundleManifest(input: {
  registry?: string;
  registries?: string[];
  manifestHash: string;
  fetchImpl?: typeof fetch;
}): Promise<ModelBundle> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const registries = registryBases(input);
  let bytes: Buffer | null = null;
  const attempts: string[] = [];
  for (const base of registries) {
    try {
      const response = await fetchImpl(`${base}/v1/blobs/${input.manifestHash}/raw`);
      if (!response.ok) {
        attempts.push(`${base}: HTTP ${response.status}`);
        continue;
      }
      const candidate = Buffer.from(await response.arrayBuffer());
      if (sha256Hex(candidate) !== input.manifestHash) {
        attempts.push(`${base}: bytes do not match the content address`);
        continue;
      }
      bytes = candidate;
      break;
    } catch (error) {
      attempts.push(`${base}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (bytes === null) {
    throw new Error(
      `bundle manifest ${input.manifestHash} is unavailable from every registry: ${attempts.join("; ")}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("bundle manifest is not valid JSON");
  }
  const errors = verifyModelBundle(value);
  if (errors.length > 0) {
    throw new Error(`bundle manifest is invalid: ${errors.join("; ")}`);
  }
  return value as unknown as ModelBundle;
}

// ---------------------------------------------------------------------------
// Provider cards
// ---------------------------------------------------------------------------

export interface BuildProviderCardInput {
  bundle: ModelBundle;
  manifestHash: string;
  endpoint: string;
  provider?: ProviderCard["provider"];
  independence?: ProviderCard["independence"];
  apis?: ApiShape[];
  id?: string;
  createdAt?: string;
  /** Sign every field except digest and signature; the key id must match. */
  sign?: (payload: Omit<ProviderCard, "digest" | "signature">) => string;
}

export function providerCardDigest(card: Omit<ProviderCard, "digest"> | ProviderCard): string {
  const { digest: _digest, signature: _signature, ...rest } = card as ProviderCard;
  return canonicalDigest(rest);
}

/** What a provider signs: every card field except the digest and signature. */
export function providerCardPayload(card: ProviderCard): Omit<ProviderCard, "digest" | "signature"> {
  const { digest: _digest, signature: _signature, ...rest } = card;
  return rest;
}

export function buildProviderCard(input: BuildProviderCardInput): ProviderCard {
  const partial = {
    kind: MODEL_PROVIDER_KIND,
    version: 1,
    id: input.id ?? `${input.bundle.id}-provider`,
    endpoint: normalizeBase(input.endpoint),
    bundle: {
      id: input.bundle.id,
      digest: input.bundle.digest,
      shardsRoot: input.bundle.shardsRoot,
      weightsDigest: input.bundle.model.weightsDigest!,
      shardCount: input.bundle.shards.length,
      totalBytes: input.bundle.totalBytes,
      ...(input.bundle.sealing === undefined ? {} : { sealed: true }),
      manifestHash: input.manifestHash,
    },
    model: input.bundle.model,
    execution: input.bundle.execution,
    provider: input.provider ?? { handle: null, keyId: null },
    ...(input.independence === undefined ? {} : { independence: input.independence }),
    apis: input.apis ?? (["openai"] as ApiShape[]),
    createdAt: input.createdAt ?? new Date().toISOString(),
  } satisfies Omit<ProviderCard, "digest" | "signature">;

  const digest = providerCardDigest(partial);
  const signature = input.sign?.(partial);
  return signature === undefined
    ? { ...partial, digest }
    : { ...partial, digest, signature };
}

export function verifyProviderCard(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["provider card must be an object"];
  if (value.kind !== MODEL_PROVIDER_KIND) errors.push(`provider card kind must be "${MODEL_PROVIDER_KIND}"`);
  if (value.version !== 1) errors.push("provider card version must be 1");
  if (typeof value.id !== "string" || value.id.length === 0) errors.push("provider card id must be non-empty");
  if (typeof value.endpoint !== "string" || !/^https?:\/\//.test(value.endpoint)) {
    errors.push("provider card endpoint must be an http(s) URL");
  }

  const bundle = isRecord(value.bundle) ? value.bundle : null;
  if (bundle === null) {
    errors.push("provider card bundle must be an object");
  } else {
    if (typeof bundle.id !== "string" || bundle.id.length === 0) errors.push("bundle.id must be non-empty");
    if (typeof bundle.digest !== "string" || !HEX64.test(bundle.digest)) errors.push("bundle.digest must be sha256 hex");
    if (typeof bundle.shardsRoot !== "string" || !HEX64.test(bundle.shardsRoot)) {
      errors.push("bundle.shardsRoot must be sha256 hex");
    }
    if (typeof bundle.manifestHash !== "string" || !HEX64.test(bundle.manifestHash)) {
      errors.push("bundle.manifestHash must be sha256 hex");
    }
    if (typeof bundle.weightsDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(bundle.weightsDigest)) {
      errors.push("bundle.weightsDigest must be sha256:<64 hex>");
    }
    if (!Number.isSafeInteger(bundle.shardCount) || (bundle.shardCount as number) < 1) {
      errors.push("bundle.shardCount must be a positive integer");
    }
    if (!Number.isSafeInteger(bundle.totalBytes) || (bundle.totalBytes as number) < 1) {
      errors.push("bundle.totalBytes must be a positive integer");
    }
    if (bundle.sealed !== undefined && typeof bundle.sealed !== "boolean") {
      errors.push("bundle.sealed must be a boolean when present");
    }
  }

  errors.push(...modelProblems(value.model));
  errors.push(...executionProblems(value.execution));

  if (bundle !== null && isRecord(value.model)) {
    if (value.model.weightsDigest !== bundle.weightsDigest) {
      errors.push("model.weightsDigest does not match bundle.weightsDigest");
    }
  }

  if (!Array.isArray(value.apis) || value.apis.length === 0) {
    errors.push("provider card apis must be a non-empty array");
  } else if (!value.apis.every((api) => api === "openai" || api === "anthropic")) {
    errors.push("provider card apis entries must be openai or anthropic");
  }

  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    errors.push("provider card createdAt must be an ISO timestamp");
  }

  const provider = isRecord(value.provider) ? value.provider : null;
  if (provider === null) {
    errors.push("provider card provider must be an object");
  } else {
    if (provider.handle !== null && typeof provider.handle !== "string") {
      errors.push("provider card provider.handle must be a string or null");
    }
    if (provider.keyId !== null && typeof provider.keyId !== "string") {
      errors.push("provider card provider.keyId must be a string or null");
    }
    if (provider.publicKey !== undefined) {
      if (!isRecord(provider.publicKey)) {
        errors.push("provider card provider.publicKey must be a JWK object");
      }
      if (provider.suite !== "ecdsa-p256" && provider.suite !== "ml-dsa-44" && provider.suite !== "ml-dsa-65") {
        errors.push("provider card provider.suite must name a signature suite");
      }
      if (typeof provider.keyId !== "string" || provider.keyId.length === 0) {
        errors.push("a signed provider card must name its provider.keyId");
      }
      if (typeof value.signature !== "string") {
        errors.push("a provider card with a publicKey must carry a signature");
      } else if (isRecord(provider.publicKey)) {
        // The operator's own key covers the same bytes the digest covers, so a
        // card cannot be re-signed by a publisher claiming someone else's key.
        let verified = false;
        try {
          verified = verifyPayload(
            provider.publicKey as unknown as JsonWebKey,
            providerCardPayload(value as unknown as ProviderCard),
            value.signature,
            provider.suite as SignatureSuite,
          );
        } catch {
          verified = false;
        }
        if (!verified) errors.push("provider card signature does not verify");
      }
    } else if (value.signature !== undefined) {
      errors.push("provider card signature requires provider.publicKey");
    }
  }

  if (value.independence !== undefined) {
    if (!isRecord(value.independence)) {
      errors.push("provider card independence must be an object");
    } else {
      if (value.independence.kind !== PROVIDER_MACHINE_KIND) {
        errors.push(`provider card independence.kind must be "${PROVIDER_MACHINE_KIND}"`);
      }
      if (
        typeof value.independence.machine !== "string" ||
        value.independence.machine.length === 0
      ) {
        errors.push("provider card independence.machine must be a non-empty string");
      }
      if (
        typeof value.independence.measurement !== "string" ||
        !HEX64.test(value.independence.measurement)
      ) {
        errors.push("provider card independence.measurement must be a sha256 hex digest");
      }
      if (
        value.independence.scheme !== undefined &&
        (typeof value.independence.scheme !== "string" || value.independence.scheme.length === 0)
      ) {
        errors.push("provider card independence.scheme must be a non-empty string when present");
      }
      if (
        value.independence.isolation !== undefined &&
        value.independence.isolation !== "host-root-excluded"
      ) {
        errors.push(
          'provider card independence.isolation must be "host-root-excluded" when present',
        );
      }
      if (
        typeof value.independence.issuedAt !== "string" ||
        Number.isNaN(Date.parse(value.independence.issuedAt))
      ) {
        errors.push("provider card independence.issuedAt must be an ISO timestamp");
      }
      if (
        value.independence.code !== undefined &&
        (typeof value.independence.code !== "string" || !HEX64.test(value.independence.code))
      ) {
        errors.push("provider card independence.code must be a sha256 hex digest when present");
      }
      if (
        value.independence.enclaveKey !== undefined &&
        (typeof value.independence.enclaveKey !== "string" || !HEX64.test(value.independence.enclaveKey))
      ) {
        errors.push("provider card independence.enclaveKey must be a sha256 hex digest when present");
      }
      if (value.independence.image !== undefined) {
        const info = verifyImageManifest(value.independence.image);
        if (info === null) {
          errors.push("provider card independence.image must be a vendor-signed image manifest");
        } else if (
          typeof value.independence.code === "string" &&
          info.image !== value.independence.code
        ) {
          errors.push("provider card independence.image does not vouch for the attested code");
        } else if (
          info.isolation !== null &&
          value.independence.isolation !== info.isolation
        ) {
          errors.push(
            "provider card independence.isolation does not match its vendor-signed image manifest",
          );
        }
      }
      if (value.independence.quote !== undefined) {
        const quote = value.independence.quote;
        if (
          !isRecord(quote) ||
          typeof quote.signature !== "string" ||
          !isRecord(quote.publicKey) ||
          typeof quote.suite !== "string"
        ) {
          errors.push(
            "provider card independence.quote must carry a signature, a publicKey, and a suite",
          );
        } else if (verifyProviderChain(value.independence) === null) {
          errors.push("provider card independence.quote does not verify, or its chain of trust is broken");
        }
      }
    }
  }

  if (typeof value.digest !== "string" || !HEX64.test(value.digest)) {
    errors.push("provider card digest must be sha256 hex");
  } else if (value.digest !== providerCardDigest(value as unknown as ProviderCard)) {
    errors.push("provider card digest does not match the canonical card");
  }

  return unique(errors);
}

/** Fetch a provider card and verify its self-digest before reading any field. */
export async function fetchProviderCard(input: {
  endpoint: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ProviderCard> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = normalizeBase(input.endpoint);
  const response = await fetchImpl(`${endpoint}/v1/provider-card`, {
    signal: AbortSignal.timeout(input.timeoutMs ?? 15_000),
  });
  if (!response.ok) {
    throw new Error(`provider card at ${endpoint} returned HTTP ${response.status}`);
  }
  const value: unknown = await response.json();
  const errors = verifyProviderCard(value);
  if (errors.length > 0) {
    throw new Error(`provider card at ${endpoint} is invalid: ${errors.join("; ")}`);
  }
  return value as unknown as ProviderCard;
}

/**
 * Check the card against a bundle manifest fetched independently from the
 * registry. Without this the card's bundle fields are only self-consistent.
 */
export function crossCheckProviderCard(
  card: ProviderCard,
  bundle: ModelBundle,
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (bundle.id !== card.bundle.id) {
    errors.push(`bundle id ${bundle.id} does not match the card (${card.bundle.id})`);
  }
  if (bundle.digest !== card.bundle.digest) {
    errors.push(`bundle digest ${bundle.digest} does not match the card (${card.bundle.digest})`);
  }
  if (bundle.shardsRoot !== card.bundle.shardsRoot) {
    errors.push("bundle shardsRoot does not match the card");
  }
  if (bundle.model.weightsDigest !== card.bundle.weightsDigest) {
    errors.push("bundle weightsDigest does not match the card");
  }
  if (bundle.shards.length !== card.bundle.shardCount) {
    errors.push("bundle shardCount does not match the card");
  }
  if (bundle.totalBytes !== card.bundle.totalBytes) {
    errors.push("bundle totalBytes does not match the card");
  }
  if (bundleManifestHash(bundle) !== card.bundle.manifestHash) {
    errors.push("bundle manifestHash does not match the card");
  }
  if (bundle.model.id !== card.model.id) {
    errors.push("bundle model id does not match the card");
  }
  if (canonicalize(bundle.execution) !== canonicalize(card.execution)) {
    errors.push("bundle execution class does not match the card");
  }

  return { ok: errors.length === 0, errors };
}
