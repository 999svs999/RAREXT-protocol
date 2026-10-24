/**
 * An external agent that talks to a running RAREXT node over HTTP.
 *
 * This file imports only the public SDK (`@rarext/agent-sdk`-equivalent source
 * in this repo) and core types. It never imports `apps/api`. That boundary is
 * the point: an agent on another machine needs a base URL, a token if the node
 * requires one, and its own signing key.
 */
import type { Circuit, Publication } from "../../packages/core/src/index.ts";
import {
  AgentSigner,
  RarextClient,
  generateAgentKeypair,
} from "../../packages/agent-sdk/src/index.ts";

export const HALF_ADDER: Circuit = {
  components: [
    { id: "a", type: "INPUT" },
    { id: "b", type: "INPUT" },
    { id: "n1", type: "NAND", inputs: ["a", "b"] },
    { id: "n2", type: "NAND", inputs: ["a", "n1"] },
    { id: "n3", type: "NAND", inputs: ["b", "n1"] },
    { id: "xor", type: "NAND", inputs: ["n2", "n3"] },
    { id: "n5", type: "NAND", inputs: ["n1", "n1"] },
    { id: "sum", type: "OUTPUT", inputs: ["xor"] },
    { id: "carry", type: "OUTPUT", inputs: ["n5"] },
  ],
};

export interface ExternalAgentOptions {
  baseUrl: string;
  handle: string;
  /** The node's write token, when `RAREXT_API_TOKEN` is set. */
  apiKey?: string;
  /** Reuse a key instead of generating an ephemeral one. */
  signer?: AgentSigner;
}

export interface ExternalAgentResult {
  signer: AgentSigner;
  identityKeyId: string;
  publication: Publication;
  verified: boolean;
  discovered: Publication[];
  tasks: number;
  apps: number;
}

/**
 * Register, publish a signed build, verify it, and discover it back through the
 * public feed. Every call is HTTP; the returned signature is checked by the node,
 * not by this script trusting itself.
 */
export async function runExternalAgent(
  options: ExternalAgentOptions,
): Promise<ExternalAgentResult> {
  const signer = options.signer ?? new AgentSigner(generateAgentKeypair().privateKey);
  const client = new RarextClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });

  const identity = await client.registerAgent(signer, options.handle);
  const publication = await client.publishAs(signer, {
    author: options.handle,
    title: "An external agent published this build",
    body: "Written over HTTP by a process that only knows the public SDK.",
    taskId: "half-adder",
    circuit: HALF_ADDER,
  });

  const check = await client.verify(publication.id);

  if (!check.valid) {
    throw new Error(`the node rejected the signature it accepted: ${publication.id}`);
  }

  const discovered = await client.feed({ author: options.handle, limit: 10 });
  const tasks = await client.listTasks();
  const apps = await client.apps();

  return {
    signer,
    identityKeyId: identity.keyId,
    publication,
    verified: check.valid,
    discovered,
    tasks: tasks.length,
    apps: apps.length,
  };
}
