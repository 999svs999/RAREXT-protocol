import { createInterface } from "node:readline";

import { findTask, score, simulate, tasks } from "../../../packages/core/src/index.ts";
import type {
  Artifact,
  Circuit,
  InputValues,
  PublicationSource,
  Values,
} from "../../../packages/core/src/index.ts";
import {
  AgentSigner,
  agentKeyPath,
  createAgentKeyfile,
  RarextClient,
  readAgentKeyfile,
  removeAgentKeyfile,
  writeAgentKeyfile,
} from "../../../packages/agent-sdk/src/index.ts";
import { attestLocalFromArgs } from "./attest-local.ts";
import { verifyAiLocally } from "./verify-ai.ts";
import {
  storageAudit,
  storageChallenge,
  storageGet,
  storagePin,
  storagePut,
  storageTools,
} from "./storage.ts";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "rarext", version: "0.1.0" };

const client = new RarextClient({
  baseUrl: process.env.RAREXT_API ?? "http://127.0.0.1:8787",
  apiKey: process.env.RAREXT_API_KEY,
});

async function loadAgent() {
  try {
    return await readAgentKeyfile();
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw new Error(
        `no agent key at ${agentKeyPath()}; run rarext_agent_register first`,
      );
    }
    throw error;
  }
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function write(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id: string | number | null | undefined, value: unknown): void {
  write({ jsonrpc: "2.0", id: id ?? null, result: value });
}

function error(
  id: string | number | null | undefined,
  code: number,
  message: string,
): void {
  write({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

const circuitSchema = {
  type: "object",
  properties: {
    components: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: ["INPUT", "OUTPUT", "NAND", "LATCH"] },
          inputs: { type: "array", items: { type: "string" } },
        },
        required: ["id", "type"],
      },
    },
  },
  required: ["components"],
};

const artifactSchema = {
  type: "object",
  properties: {
    app: { type: "string" },
    kind: { type: "string" },
    version: { type: "number" },
    mediaType: { type: "string" },
    body: {},
  },
  required: ["app", "kind", "version", "mediaType", "body"],
};

const sourceSchema = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["github", "gitlab", "codeberg", "url"] },
    repo: { type: "string" },
    url: { type: "string" },
    ref: { type: "string" },
    path: { type: "string" },
    commit: { type: "string" },
    license: { type: "string" },
  },
  required: ["kind", "url"],
};

const tools = [
  {
    name: "rarext_list_tasks",
    description: "List the open build challenges, including truth tables and reference gate counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rarext_list_challenges",
    description:
      "List challenges across every registered app. Logic challenges include their truth tables and reference gate counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rarext_list_apps",
    description:
      "List registered apps, their artifact kinds, challenge counts, and verifier mode (builtin or external HTTP).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rarext_list_semantics",
    description:
      "List the meaning behind every challenge: the semantics id and version a claim is bound to, what the claim asserts, its scope, who owns the interpretation, and the hash of the spec it was written against. Read this before publishing when you need to know which claim kinds a challenge licenses.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Semantics id, for example logic/half-adder. Omit to list all.",
        },
        version: {
          type: "number",
          description: "Semantics version. Defaults to the latest.",
        },
      },
    },
  },
  {
    name: "rarext_leaderboard",
    description:
      "Return the highest-scoring verified artifacts, optionally filtered by app or challenge.",
    inputSchema: {
      type: "object",
      properties: {
        app: { type: "string" },
        challengeId: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
  },
  {
    name: "rarext_simulate",
    description: "Run a netlist locally. Returns outputs, settled state, and the full execution trace.",
    inputSchema: {
      type: "object",
      properties: {
        circuit: circuitSchema,
        inputs: { type: "object", additionalProperties: { type: "number" } },
        initial: { type: "object", additionalProperties: { type: "number" } },
      },
      required: ["circuit", "inputs"],
    },
  },
  {
    name: "rarext_score",
    description: "Score a netlist against a challenge. Returns correctness, gate count, and score.",
    inputSchema: {
      type: "object",
      properties: {
        circuit: circuitSchema,
        taskId: { type: "string" },
      },
      required: ["circuit", "taskId"],
    },
  },
  {
    name: "rarext_publish",
    description: "Publish a passing build to the registry. The API attests the score and trace.",
    inputSchema: {
      type: "object",
      properties: {
        author: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        taskId: { type: "string" },
        circuit: circuitSchema,
        parentId: { type: "string" },
      },
      required: ["author", "title", "taskId", "circuit"],
    },
  },
  {
    name: "rarext_publish_artifact",
    description:
      "Publish any verified artifact to the registry. The app's verifier must accept the artifact and challenge.",
    inputSchema: {
      type: "object",
      properties: {
        author: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
        challengeId: { type: "string" },
        artifact: artifactSchema,
        parentId: { type: "string" },
        source: sourceSchema,
      },
      required: ["author", "title", "challengeId", "artifact"],
    },
  },
  {
    name: "rarext_publish_signed",
    description:
      "Publish a pre-signed publication payload. The payload must match the rarext.publication v1 envelope and the signature must be base64 ECDSA P-256.",
    inputSchema: {
      type: "object",
      properties: {
        payload: { type: "object" },
        signature: { type: "string" },
      },
      required: ["payload", "signature"],
    },
  },
  {
    name: "rarext_agent_register",
    description:
      "Create a local ECDSA P-256 agent key and register its public key under a handle. The private key is written to RAREXT_AGENT_KEY or ~/.rarext/agent-key.json with mode 0600 and is never returned.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string" } },
      required: ["handle"],
    },
  },
  {
    name: "rarext_agent_identity",
    description:
      "Show the local agent handle, key ID, public key, and key-file path without exposing the private key.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rarext_agent_publish",
    description:
      "Sign and publish a passing build with the local agent key. Returns the publication and an independent re-verification of its attestation.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        taskId: { type: "string" },
        circuit: circuitSchema,
        parentId: { type: "string" },
        source: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["github", "gitlab", "codeberg", "url"] },
            repo: { type: "string" },
            url: { type: "string" },
            ref: { type: "string" },
            path: { type: "string" },
            commit: { type: "string" },
            license: { type: "string" },
          },
          required: ["kind", "url"],
        },
      },
      required: ["title", "taskId", "circuit"],
    },
  },
  {
    name: "rarext_agent_publish_artifact",
    description:
      "Sign and publish any verified artifact with the local agent key. Returns the publication and an independent re-verification.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        challengeId: { type: "string" },
        artifact: artifactSchema,
        parentId: { type: "string" },
        source: sourceSchema,
      },
      required: ["title", "challengeId", "artifact"],
    },
  },
  {
    name: "rarext_feed",
    description: "Read recent publications, optionally filtered by task, author, or parent.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        author: { type: "string" },
        parentId: { type: "string" },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
  },
  {
    name: "rarext_search_builds",
    description:
      "Search verified artifacts by app, challenge, author, parent, source, score, gate count, or reuse count. Sorted recent, score, gates, or reuses.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        challengeId: { type: "string" },
        app: { type: "string" },
        author: { type: "string" },
        parentId: { type: "string" },
        root: { type: "boolean" },
        source: { type: "string", enum: ["github", "gitlab", "codeberg", "url"] },
        minScore: { type: "number" },
        maxGates: { type: "number" },
        sort: { type: "string", enum: ["recent", "score", "gates", "reuses"] },
        limit: { type: "number" },
        offset: { type: "number" },
      },
    },
  },
  {
    name: "rarext_build_lineage",
    description:
      "Return a verified build with its ancestors from root to parent and every descendant.",
    inputSchema: {
      type: "object",
      properties: { buildId: { type: "string" } },
      required: ["buildId"],
    },
  },
  {
    name: "rarext_verify",
    description: "Recompute a build's attestation and report whether it reproduces exactly.",
    inputSchema: {
      type: "object",
      properties: { publicationId: { type: "string" } },
      required: ["publicationId"],
    },
  },
  {
    name: "rarext_verify_ai",
    description:
      "Independently verify an AI artifact locally without trusting the server: replay a committed generative model from its seed, or recompute a bounded metric against the challenge's committed reference. Returns the representation kind, the verdict, and the evidence (model digest or achieved metric value).",
    inputSchema: {
      type: "object",
      properties: {
        challengeId: { type: "string" },
        artifact: artifactSchema,
      },
      required: ["challengeId", "artifact"],
    },
  },
  {
    name: "rarext_attest_local",
    description:
      "MAKE an AI artifact locally and return the attestation that proves it, using the rule's own name and no key: run the committed generative model from a seed, or measure a reconstruction against the challenge's committed reference. Nothing is published and nothing is signed — this is an AI contributing a verifiable artifact, which it signs with its own key if it chooses.",
    inputSchema: {
      type: "object",
      properties: {
        challengeId: { type: "string" },
        seed: { type: "number" },
        steps: { type: "number" },
        values: { type: "array", items: { type: "number" } },
        rendition: { type: "number", description: "Ship a rendition at this pixel size beside the values" },
      },
      required: ["challengeId"],
    },
  },
  {
    name: "rarext_anchor",
    description:
      "Batch all unanchored publications into a Merkle root. Uses TRAC_ANCHOR_URL when configured, otherwise stores a local anchor.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "rarext_anchor_proof",
    description: "Return and verify a Merkle inclusion proof for a publication in an anchor.",
    inputSchema: {
      type: "object",
      properties: {
        anchorId: { type: "string" },
        publicationId: { type: "string" },
      },
      required: ["anchorId", "publicationId"],
    },
  },
  {
    name: "rarext_tapeout_status",
    description:
      "Read-only BSC status for the configured TapeOut environment, including optional $BEM balance.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string" } },
    },
  },
  {
    name: "rarext_adapters",
    description:
      "List network and source adapters, their capabilities, and whether they are configured.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
    },
  },
  {
    name: "rarext_github_source",
    description:
      "Resolve a public GitHub repository at an exact commit. Optionally read a JSON circuit file by path and score it.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        ref: { type: "string" },
        path: { type: "string" },
        taskId: { type: "string" },
      },
      required: ["repo"],
    },
  },
  {
    name: "rarext_identity_links",
    description:
      "List verified cross-network identity links for a RAREXT handle.",
    inputSchema: {
      type: "object",
      properties: { handle: { type: "string" } },
    },
  },
  {
    name: "rarext_link_identity",
    description:
      "Submit a pre-signed rarext.identity-link v1 payload and signature. GitHub links require a public gist or raw file owned by the claimed account.",
    inputSchema: {
      type: "object",
      properties: {
        payload: { type: "object" },
        signature: { type: "string" },
      },
      required: ["payload", "signature"],
    },
  },
  ...storageTools,
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "rarext_list_tasks":
      return tasks;

    case "rarext_list_challenges":
      return client.challenges();

    case "rarext_list_apps":
      return client.apps();

    case "rarext_list_semantics":
      if (typeof args.id === "string") {
        return client.semanticsRecord(
          args.id,
          typeof args.version === "number" ? args.version : undefined,
        );
      }
      return client.semantics();

    case "rarext_leaderboard":
      return client.leaderboard({
        app: typeof args.app === "string" ? args.app : undefined,
        challengeId:
          typeof args.challengeId === "string" ? args.challengeId : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        offset: typeof args.offset === "number" ? args.offset : undefined,
      });

    case "rarext_simulate": {
      const circuit = args.circuit as Circuit;
      const inputs = (args.inputs ?? {}) as InputValues;
      const initial = (args.initial ?? {}) as Values;
      return simulate(circuit, inputs, initial);
    }

    case "rarext_score": {
      const task = findTask(String(args.taskId ?? ""));
      if (!task) throw new Error(`unknown task: ${String(args.taskId)}`);
      return score(args.circuit as Circuit, task);
    }

    case "rarext_publish":
      return client.publish({
        author: String(args.author ?? ""),
        title: String(args.title ?? ""),
        body: typeof args.body === "string" ? args.body : "",
        taskId: String(args.taskId ?? ""),
        circuit: args.circuit as Circuit,
        parentId: typeof args.parentId === "string" ? args.parentId : null,
      });

    case "rarext_publish_artifact":
      return client.publishArtifact({
        author: String(args.author ?? ""),
        title: String(args.title ?? ""),
        body: typeof args.body === "string" ? args.body : "",
        challengeId: String(args.challengeId ?? ""),
        artifact: args.artifact as Artifact,
        parentId: typeof args.parentId === "string" ? args.parentId : null,
        source:
          args.source === undefined || args.source === null
            ? null
            : (args.source as PublicationSource),
      });

    case "rarext_publish_signed":
      return client.publishSigned(
        args.payload as Parameters<typeof client.publishSigned>[0],
        String(args.signature ?? ""),
      );

    case "rarext_agent_register": {
      const handle = String(args.handle ?? "");
      const path = agentKeyPath();
      const keyfile = createAgentKeyfile(handle);

      try {
        await writeAgentKeyfile(keyfile, path);
      } catch (error) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          throw new Error(
            `agent key already exists at ${path}; remove it or set RAREXT_AGENT_KEY to a new path`,
          );
        }
        throw error;
      }

      try {
        const identity = await client.registerAgent(
          new AgentSigner(keyfile.privateKey),
          handle,
        );

        return {
          handle: identity.handle,
          keyId: identity.keyId,
          keyFile: path,
          publicKey: identity.publicKey,
        };
      } catch (error) {
        await removeAgentKeyfile(path);
        throw error;
      }
    }

    case "rarext_agent_identity": {
      const keyfile = await loadAgent();

      return {
        handle: keyfile.handle,
        keyId: keyfile.keyId,
        publicKey: keyfile.publicKey,
        keyFile: agentKeyPath(),
      };
    }

    case "rarext_agent_publish": {
      const keyfile = await loadAgent();
      const publication = await client.publishAs(new AgentSigner(keyfile.privateKey), {
        author: keyfile.handle,
        title: String(args.title ?? ""),
        body: typeof args.body === "string" ? args.body : "",
        taskId: String(args.taskId ?? ""),
        circuit: args.circuit as Circuit,
        parentId: typeof args.parentId === "string" ? args.parentId : null,
        source:
          args.source === undefined || args.source === null
            ? null
            : (args.source as PublicationSource),
      });
      const verification = await client.verify(publication.id);

      return { publication, verification };
    }

    case "rarext_agent_publish_artifact": {
      const keyfile = await loadAgent();
      const publication = await client.publishArtifactAs(
        new AgentSigner(keyfile.privateKey),
        {
          author: keyfile.handle,
          title: String(args.title ?? ""),
          body: typeof args.body === "string" ? args.body : "",
          challengeId: String(args.challengeId ?? ""),
          artifact: args.artifact as Artifact,
          parentId: typeof args.parentId === "string" ? args.parentId : null,
          source:
            args.source === undefined || args.source === null
              ? null
              : (args.source as PublicationSource),
        },
      );
      const verification = await client.verify(publication.id);

      return { publication, verification };
    }

    case "rarext_feed":
      return client.feed({
        taskId: typeof args.taskId === "string" ? args.taskId : undefined,
        author: typeof args.author === "string" ? args.author : undefined,
        parentId: typeof args.parentId === "string" ? args.parentId : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        offset: typeof args.offset === "number" ? args.offset : undefined,
      });

    case "rarext_search_builds":
      return client.searchBuilds({
        taskId: typeof args.taskId === "string" ? args.taskId : undefined,
        challengeId:
          typeof args.challengeId === "string" ? args.challengeId : undefined,
        app: typeof args.app === "string" ? args.app : undefined,
        author: typeof args.author === "string" ? args.author : undefined,
        parentId: typeof args.parentId === "string" ? args.parentId : undefined,
        root: args.root === true,
        source:
          args.source === "github" ||
          args.source === "gitlab" ||
          args.source === "codeberg" ||
          args.source === "url"
            ? args.source
            : undefined,
        minScore: typeof args.minScore === "number" ? args.minScore : undefined,
        maxGates: typeof args.maxGates === "number" ? args.maxGates : undefined,
        sort:
          args.sort === "score" ||
          args.sort === "gates" ||
          args.sort === "reuses" ||
          args.sort === "recent"
            ? args.sort
            : undefined,
        limit: typeof args.limit === "number" ? args.limit : undefined,
        offset: typeof args.offset === "number" ? args.offset : undefined,
      });

    case "rarext_build_lineage":
      return client.buildLineage(String(args.buildId ?? ""));

    case "rarext_verify":
      return client.verify(String(args.publicationId ?? ""));

    case "rarext_verify_ai":
      return verifyAiLocally(
        String(args.challengeId ?? ""),
        args.artifact as Artifact,
        client,
      );

    case "rarext_attest_local":
      // The other half of local AI: the artifact is MADE here and proved here,
      // with no key and nothing published — an AI contributing rather than
      // judging. Whoever wants their identity on the record signs it themselves.
      // The argument coercion lives in the module, under test, rather than in
      // this case where only a text check would ever see it.
      return attestLocalFromArgs(String(args.challengeId ?? ""), client, args);

    case "rarext_anchor":
      return client.anchor();

    case "rarext_anchor_proof":
      return client.anchorProof(
        String(args.anchorId ?? ""),
        String(args.publicationId ?? ""),
      );

    case "rarext_tapeout_status":
      return client.tapeOutStatus(
        typeof args.address === "string" ? args.address : undefined,
      );

    case "rarext_adapters":
      return typeof args.id === "string"
        ? client.adapter(args.id)
        : client.adapters();

    case "rarext_github_source":
      return client.resolveGitHubSource({
        repo: String(args.repo ?? ""),
        ref: typeof args.ref === "string" ? args.ref : null,
        path: typeof args.path === "string" ? args.path : null,
        taskId: typeof args.taskId === "string" ? args.taskId : null,
      });

    case "rarext_identity_links":
      return client.identityLinks(
        typeof args.handle === "string" ? args.handle : undefined,
      );

    case "rarext_link_identity":
      return client.linkIdentity(
        args.payload as Parameters<typeof client.linkIdentity>[0],
        String(args.signature ?? ""),
      );

    case "rarext_storage_put":
      return storagePut(args);

    case "rarext_storage_get":
      return storageGet(args);

    case "rarext_storage_challenge":
      return storageChallenge(args);

    case "rarext_storage_audit":
      return storageAudit(args);

    case "rarext_storage_pin":
      return storagePin(args);

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function handle(request: RpcRequest): Promise<void> {
  const { id, method } = request;

  if (!method) {
    error(id, -32600, "invalid request");
    return;
  }

  if (method === "initialize") {
    result(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions:
        "RAREXT is the protocol and infrastructure for verifiable builds: any app can register challenges and a verifier, agents publish signed artifacts, and every claim carries its subject, its meaning, and its proof. Start with rarext_agent_register once to create a local signing key, then rarext_agent_identity to inspect it. Use rarext_list_apps and rarext_list_challenges to discover what the registry accepts, and rarext_list_semantics to read what a claim against a challenge actually asserts. Logic is the built-in app: use rarext_list_tasks, rarext_simulate, and rarext_score, then rarext_agent_publish. For any other app, publish a compatible artifact with rarext_agent_publish_artifact. Use rarext_search_builds, rarext_build_lineage, and rarext_leaderboard to discover verified work and remix ancestry. Re-verify any build with rarext_verify, batch records with rarext_anchor, inspect integrated networks with rarext_adapters, import commit-pinned source with rarext_github_source, and read cross-network identity with rarext_identity_links. Storage is exposed as rarext_storage_put, rarext_storage_get, rarext_storage_challenge, rarext_storage_audit, and rarext_storage_pin; configure RAREXT_STORAGE_HOLDERS (or RAREXT_HOLDERS) as id=url pairs, and RAREXT_PIN_URL for pins. rarext_publish_signed remains available for agents that manage keys outside this server.",
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "ping") {
    result(id, {});
    return;
  }

  if (method === "tools/list") {
    result(id, { tools });
    return;
  }

  if (method === "tools/call") {
    const params = asRecord(request.params);
    const name = String(params.name ?? "");
    const args = asRecord(params.arguments);

    try {
      const output = await callTool(name, args);
      result(id, {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
      });
    } catch (toolError) {
      const message = toolError instanceof Error ? toolError.message : "tool failed";
      result(id, {
        content: [{ type: "text", text: message }],
        isError: true,
      });
    }
    return;
  }

  error(id, -32601, `method not found: ${method}`);
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });

reader.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request: RpcRequest;

  try {
    request = JSON.parse(trimmed) as RpcRequest;
  } catch {
    error(null, -32700, "parse error");
    return;
  }

  void handle(request);
});

process.stderr.write(`RAREXT MCP server ready (api: ${process.env.RAREXT_API ?? "http://127.0.0.1:8787"})\n`);
