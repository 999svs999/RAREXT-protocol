import {
  AgentSigner,
  RarextClient,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import type { Publication } from "../../../packages/core/src/index.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonFile } from "./ledger.ts";
import type { ProviderCard } from "./model-bundle.ts";
import type { DeploymentCommitment, ModelRunBody } from "./types.ts";
import {
  MODEL_DEPLOYMENT_ARTIFACT_KIND,
  MODEL_PROVIDER_ARTIFACT_KIND,
  MODEL_RUN_APP,
  MODEL_RUN_ARTIFACT_KIND,
} from "./types.ts";

interface StoredIdentity {
  kind: "rarext.runtime-identity.v1";
  handle: string;
  privateKey: JsonWebKey;
  publicKey: JsonWebKey;
  createdAt: string;
}

export function challengeIdFor(manifest: DeploymentCommitment): string {
  return `model-run-${manifest.digest.slice(0, 16)}`;
}

/**
 * The bundle commitments a web4 deployment carries into its challenge. A
 * local or remote manifest has no bundle, so the challenge names none and the
 * verifier requires runs to omit `body.bundle`.
 */
function bundleSpec(labels: Record<string, string> | undefined): {
  bundleDigest?: string;
  shardsRoot?: string;
  manifestHash?: string;
} {
  if (
    labels?.execution !== "web4" ||
    typeof labels.bundle !== "string" ||
    typeof labels.shardsRoot !== "string" ||
    typeof labels.manifestHash !== "string"
  ) {
    return {};
  }
  return {
    bundleDigest: labels.bundle,
    shardsRoot: labels.shardsRoot,
    manifestHash: labels.manifestHash,
  };
}

/**
 * The response-agreement threshold a web4 deployment commits in its labels.
 * A missing label means one provider, which is the old behaviour; a run under
 * a higher threshold must carry matching quorum evidence.
 */
function quorumSpec(labels: Record<string, string> | undefined): number | undefined {
  if (labels?.quorum === undefined) return undefined;
  const value = Number(labels.quorum);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/**
 * The distinct operator identities a deployment committed. When present, the
 * challenge commits them too, so a run cannot claim agreement from several
 * endpoints run by one operator.
 */
function operatorsSpec(labels: Record<string, string> | undefined): string[] | undefined {
  if (labels?.operators === undefined) return undefined;
  const operators = labels.operators
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return operators.length === 0 ? undefined : operators;
}

/**
 * The credits each agreeing operator earns, when the deployment commits a
 * bounty. Payment is over distinct operators, so a bounty only makes sense
 * beside the quorum and operator commitments; a bounty without them pays nobody
 * and is not committed.
 */
/**
 * The machine identities a deployment committed, aligned index-for-index with
 * its operators. Machine independence needs both, so the set is only committed
 * when the label names them.
 */
function machinesSpec(labels: Record<string, string> | undefined): string[] | undefined {
  if (labels?.machines === undefined) return undefined;
  const machines = labels.machines
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return machines.length === 0 ? undefined : machines;
}

/**
 * Whether a deployment requires its quorum over distinct machines. Only
 * meaningful with committed operators and machines of matching length, so a
 * half-committed request is treated as absent rather than enforced vacuously.
 */
function independenceSpec(labels: Record<string, string> | undefined): "machine" | undefined {
  if (labels?.independence !== "machine") return undefined;
  const operators = operatorsSpec(labels);
  const machines = machinesSpec(labels);
  if (quorumSpec(labels) === undefined || operators === undefined || machines === undefined) {
    return undefined;
  }
  if (operators.length !== machines.length) return undefined;
  return "machine";
}

/**
 * The machine-measurement allowlist a deployment committed. Only meaningful
 * with a quorum of operators to check it against, so a half-committed list is
 * treated as absent rather than enforced vacuously.
 */
function measurementsSpec(labels: Record<string, string> | undefined): string[] | undefined {
  if (labels?.measurements === undefined) return undefined;
  if (quorumSpec(labels) === undefined || operatorsSpec(labels) === undefined) return undefined;
  const measurements = labels.measurements
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return measurements.length === 0 ? undefined : measurements;
}

/**
 * The vendor key whose machine quotes a deployment accepts. Needs a quorum of
 * operators to gate, so a half-committed pin is treated as absent.
 */
function teeVendorSpec(labels: Record<string, string> | undefined): string | undefined {
  const raw = labels?.teeVendor;
  if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) return undefined;
  if (quorumSpec(labels) === undefined || operatorsSpec(labels) === undefined) return undefined;
  return raw;
}

/**
 * The minimum certificate-chain depth a hardware-rooted deployment requires.
 * Only meaningful with a pinned vendor root, so it is committed beside one.
 */
function teeChainDepthSpec(labels: Record<string, string> | undefined): number | undefined {
  if (labels?.teeChainDepth === undefined) return undefined;
  if (teeVendorSpec(labels) === undefined) return undefined;
  const value = Number(labels.teeChainDepth);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/** The measured-boot stages a hardware-rooted deployment requires. */
function teeBootStagesSpec(labels: Record<string, string> | undefined): string[] | undefined {
  if (labels?.teeBootStages === undefined) return undefined;
  if (teeVendorSpec(labels) === undefined) return undefined;
  const stages = labels.teeBootStages.split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
  return stages.length === 0 ? undefined : stages;
}

/** The measurement a deployment approves for each boot stage. */
/** The vendor ROOT whose certificate chain over the enclave image a deployment requires. */
function teeSignedImageSpec(labels: Record<string, string> | undefined): string | undefined {
  const raw = labels?.teeSignedImage;
  if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) return undefined;
  if (teeVendorSpec(labels) === undefined) return undefined;
  return raw;
}

/** The minimum certificate-chain depth the enclave image manifest must present. */
function teeSignedImageDepthSpec(labels: Record<string, string> | undefined): number | undefined {
  if (labels?.teeSignedImageDepth === undefined) return undefined;
  if (teeSignedImageSpec(labels) === undefined) return undefined;
  const value = Number(labels.teeSignedImageDepth);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/** Whether a deployment requires every run to carry a valid decode trace. */
function requireTraceSpec(labels: Record<string, string> | undefined): true | undefined {
  return labels?.trace === "required" ? true : undefined;
}

/** Whether a deployment requires every run to be replayable. */
function requireReplaySpec(labels: Record<string, string> | undefined): true | undefined {
  return labels?.replay === "required" ? true : undefined;
}

/**
 * The determinism class a deployment commits. A class only means something with
 * the trace and replay requirements it is built on: without a committed trace
 * there is nothing to compare token-for-token, and without a replay envelope the
 * run is not reproducible. A half-committed class is treated as absent.
 */
function determinismSpec(
  labels: Record<string, string> | undefined,
): "deterministic-replay" | undefined {
  if (labels?.determinism !== "deterministic-replay") return undefined;
  if (labels.trace !== "required" || labels.replay !== "required") return undefined;
  return "deterministic-replay";
}

/** The measurement of the enclave's own code a deployment approves. */
function teeCodeMeasurementSpec(labels: Record<string, string> | undefined): string | undefined {
  const raw = labels?.teeCodeMeasurement;
  if (typeof raw !== "string" || !/^[0-9a-f]{64}$/.test(raw)) return undefined;
  if (teeVendorSpec(labels) === undefined) return undefined;
  return raw;
}

/** Whether a deployment requires fresh (nonce-challenged) attestations. */
function teeFreshnessSpec(labels: Record<string, string> | undefined): "challenge" | undefined {
  if (labels?.teeFreshness !== "challenge") return undefined;
  if (teeVendorSpec(labels) === undefined) return undefined;
  return "challenge";
}

/**
 * The root-rotation epoch a deployment has learned. When committed, every quote
 * must present a root chain from `teeVendor` that reaches at least this epoch and
 * terminates at the CURRENT root. Only meaningful with a pinned vendor root.
 */
function teeRootEpochSpec(labels: Record<string, string> | undefined): number | undefined {
  if (labels?.teeRootEpoch === undefined) return undefined;
  if (teeVendorSpec(labels) === undefined) return undefined;
  const value = Number(labels.teeRootEpoch);
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

function teeStageMeasurementsSpec(
  labels: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (labels?.teeStageMeasurements === undefined) return undefined;
  if (teeBootStagesSpec(labels) === undefined) return undefined;
  const record: Record<string, string> = {};
  for (const entry of labels.teeStageMeasurements.split(",")) {
    const [stage, measurement] = entry.split("=").map((part) => part.trim());
    if (stage === undefined || stage === "" || measurement === undefined || !/^[0-9a-f]{64}$/.test(measurement)) {
      return undefined;
    }
    record[stage] = measurement;
  }
  return Object.keys(record).length === 0 ? undefined : record;
}

function inferenceBountySpec(labels: Record<string, string> | undefined): number | undefined {
  if (labels?.bounty === undefined) return undefined;
  if (quorumSpec(labels) === undefined || operatorsSpec(labels) === undefined) return undefined;
  const value = Number(labels.bounty);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function challengeFor(manifest: DeploymentCommitment) {
  return {
    id: challengeIdFor(manifest),
    app: MODEL_RUN_APP,
    title: `Model runs on ${manifest.model.id}`,
    description:
      `Exact transcripts from deployment ${manifest.id} (${manifest.engine.name} serving ` +
      `${manifest.model.id}${manifest.model.quantization ? ` ${manifest.model.quantization}` : ""}). ` +
      "The challenge commits the deployment digest and the model's weight digest; the verifier recomputes every transcript digest.",
    version: 1,
    spec: {
      deploymentDigest: manifest.digest,
      modelId: manifest.model.id,
      weightsDigest: manifest.model.weightsDigest,
      engine: manifest.engine.name,
      // A web4 deployment commits the bundle its provider fetched; the run and
      // card verifier checks the same three commitments.
      ...bundleSpec(manifest.labels),
      ...(quorumSpec(manifest.labels) === undefined ? {} : { quorum: quorumSpec(manifest.labels) }),
      ...(operatorsSpec(manifest.labels) === undefined
        ? {}
        : { operators: operatorsSpec(manifest.labels) }),
      ...(inferenceBountySpec(manifest.labels) === undefined
        ? {}
        : { inferenceBounty: inferenceBountySpec(manifest.labels) }),
      ...(independenceSpec(manifest.labels) === undefined
        ? {}
        : {
            independence: independenceSpec(manifest.labels),
            machines: machinesSpec(manifest.labels),
          }),
      ...(measurementsSpec(manifest.labels) === undefined
        ? {}
        : { measurements: measurementsSpec(manifest.labels) }),
      // The engine pin: a run records it, and a replay checks the provider's
      // present engine against it. A web4 deployment pins the provider's engine
      // in a label; a probed deployment can carry it on the manifest engine.
      ...(() => {
        const fromLabel = manifest.labels?.engineFingerprint;
        if (typeof fromLabel === "string" && /^[0-9a-f]{64}$/.test(fromLabel)) {
          return { engineFingerprint: fromLabel };
        }
        return typeof manifest.engine.fingerprint === "string"
          ? { engineFingerprint: manifest.engine.fingerprint }
          : {};
      })(),
      // The pinned vendor key: every agreeing provider's machine quote must
      // verify under it.
      ...(teeVendorSpec(manifest.labels) === undefined
        ? {}
        : { teeVendor: teeVendorSpec(manifest.labels) }),
      ...(teeChainDepthSpec(manifest.labels) === undefined
        ? {}
        : { teeChainDepth: teeChainDepthSpec(manifest.labels) }),
      ...(teeBootStagesSpec(manifest.labels) === undefined
        ? {}
        : { teeBootStages: teeBootStagesSpec(manifest.labels) }),
      ...(teeStageMeasurementsSpec(manifest.labels) === undefined
        ? {}
        : { teeStageMeasurements: teeStageMeasurementsSpec(manifest.labels) }),
      ...(teeFreshnessSpec(manifest.labels) === undefined
        ? {}
        : { teeFreshness: teeFreshnessSpec(manifest.labels) }),
      ...(teeRootEpochSpec(manifest.labels) === undefined
        ? {}
        : { teeRootEpoch: teeRootEpochSpec(manifest.labels) }),
      ...(teeCodeMeasurementSpec(manifest.labels) === undefined
        ? {}
        : { teeCodeMeasurement: teeCodeMeasurementSpec(manifest.labels) }),
      ...(teeSignedImageSpec(manifest.labels) === undefined
        ? {}
        : { teeSignedImage: teeSignedImageSpec(manifest.labels) }),
      ...(teeSignedImageDepthSpec(manifest.labels) === undefined
        ? {}
        : { teeSignedImageDepth: teeSignedImageDepthSpec(manifest.labels) }),
      ...(requireTraceSpec(manifest.labels) === undefined
        ? {}
        : { requireTrace: requireTraceSpec(manifest.labels) }),
      ...(requireReplaySpec(manifest.labels) === undefined
        ? {}
        : { requireReplay: requireReplaySpec(manifest.labels) }),
      ...(determinismSpec(manifest.labels) === undefined
        ? {}
        : { determinism: determinismSpec(manifest.labels) }),
    },
    semanticsId: `ai-model-run/${challengeIdFor(manifest)}`,
    semanticsVersion: 1,
    createdAt: manifest.createdAt,
  };
}

export function challengesFile(manifest: DeploymentCommitment) {
  return { challenges: [challengeFor(manifest)] };
}

function loadIdentity(path: string, handle: string): { signer: AgentSigner; stored: StoredIdentity } {
  if (existsSync(path)) {
    const stored = JSON.parse(readFileSync(path, "utf8")) as StoredIdentity;
    return { signer: new AgentSigner(stored.privateKey), stored };
  }

  const keypair = generateAgentKeypair("ecdsa-p256");
  const stored: StoredIdentity = {
    kind: "rarext.runtime-identity.v1",
    handle,
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    createdAt: new Date().toISOString(),
  };
  writeJsonFile(path, stored, 0o600);
  return { signer: new AgentSigner(stored.privateKey), stored };
}

/**
 * Publishes run transcripts to a RAREXT registry under the runtime's own key.
 * The key is created once and persisted 0600 in the state directory; it is the
 * runtime's identity, not the model's.
 */
export class RuntimePublisher {
  readonly client: RarextClient;
  readonly signer: AgentSigner;
  readonly handle: string;
  readonly challengeId: string;

  private constructor(options: {
    client: RarextClient;
    signer: AgentSigner;
    handle: string;
    challengeId: string;
  }) {
    this.client = options.client;
    this.signer = options.signer;
    this.handle = options.handle;
    this.challengeId = options.challengeId;
  }

  static async open(options: {
    baseUrl: string;
    handle: string;
    stateDir: string;
    challengeId: string;
  }): Promise<RuntimePublisher> {
    const client = new RarextClient({ baseUrl: options.baseUrl });
    const { signer } = loadIdentity(join(options.stateDir, "runtime-identity.json"), options.handle);

    let registered = false;
    try {
      const existing = await client.identity(options.handle);
      registered = existing !== null && existing !== undefined;
    } catch {
      registered = false;
    }

    if (!registered) {
      await client.registerAgent(signer, options.handle);
    }

    return new RuntimePublisher({
      client,
      signer,
      handle: options.handle,
      challengeId: options.challengeId,
    });
  }

  /**
   * Publish the deployment commitment itself, under the same challenge as its
   * runs. The manifest is the model card: engine, model, quantization, weight
   * digest, hardware, and the digest every run cites.
   */
  async publishDeployment(manifest: DeploymentCommitment): Promise<Publication> {
    return this.client.publishArtifactAs(this.signer, {
      author: this.handle,
      title: `Deployment ${manifest.id} — ${manifest.model.id}`,
      body:
        `${manifest.engine.name}${manifest.engine.version ? ` ${manifest.engine.version}` : ""} serving ` +
        `${manifest.model.id}${manifest.model.quantization ? ` ${manifest.model.quantization}` : ""} on ` +
        `${manifest.hardware.backend}; deployment digest ${manifest.digest}.`,
      challengeId: this.challengeId,
      artifact: {
        app: MODEL_RUN_APP,
        kind: MODEL_DEPLOYMENT_ARTIFACT_KIND,
        version: 1,
        mediaType: "application/json",
        body: manifest,
      },
    });
  }

  /**
   * Publish a provider card under the model challenge. The card says which
   * bundle the provider fetched and where it serves it; deploy can then find
   * providers through the bundle instead of being told each URL by hand.
   */
  async publishProviderCard(card: ProviderCard): Promise<Publication> {
    return this.client.publishArtifactAs(this.signer, {
      author: this.handle,
      title: `Provider ${card.endpoint} — ${card.model.id}`,
      body:
        `serving bundle ${card.bundle.digest} (${card.bundle.shardCount} shards, ` +
        `${card.bundle.totalBytes} bytes) for model ${card.model.id} at ${card.endpoint}.`,
      challengeId: this.challengeId,
      artifact: {
        app: MODEL_RUN_APP,
        kind: MODEL_PROVIDER_ARTIFACT_KIND,
        version: 1,
        mediaType: "application/json",
        body: card,
      },
    });
  }

  async publish(body: ModelRunBody, manifest: DeploymentCommitment): Promise<Publication> {
    const short = body.response.digest.slice(0, 12);
    return this.client.publishArtifactAs(this.signer, {
      author: this.handle,
      title: `Model run ${short} — ${manifest.model.id}`,
      body:
        `${manifest.engine.name} ${manifest.model.id} on deployment ${manifest.id}; ` +
        `the response hashes to ${body.response.digest}.`,
      challengeId: this.challengeId,
      artifact: {
        app: MODEL_RUN_APP,
        kind: MODEL_RUN_ARTIFACT_KIND,
        version: 1,
        mediaType: "application/json",
        body,
      },
    });
  }
}
