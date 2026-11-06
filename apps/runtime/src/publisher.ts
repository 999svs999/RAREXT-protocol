import {
  AgentSigner,
  RarextClient,
  generateAgentKeypair,
} from "../../../packages/agent-sdk/src/index.ts";
import type { Publication } from "../../../packages/core/src/index.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeJsonFile } from "./ledger.ts";
import type { DeploymentCommitment, ModelRunBody } from "./types.ts";
import { MODEL_RUN_APP, MODEL_RUN_ARTIFACT_KIND } from "./types.ts";

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
