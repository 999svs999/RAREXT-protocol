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
