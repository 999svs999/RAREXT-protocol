import { createHash } from "node:crypto";

import {
  canonicalize,
  findTask,
  score,
  validateCircuit,
} from "../../../../packages/core/src/index.ts";
import type {
  AdapterInfo,
  AdapterStatus,
  Circuit,
  DesignScore,
  SourceQuery,
  SourceResolution,
} from "../../../../packages/core/src/index.ts";

import { statusFor } from "./types.ts";
import type { RarextAdapter, IdentityLinkProof } from "./types.ts";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const MAX_SOURCE_BYTES = 1_000_000;

interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  description: string | null;
  default_branch: string;
  stargazers_count: number;
  license: { spdx_id: string | null } | null;
}

interface GitHubCommit {
  sha: string;
}

interface GitHubGist {
  owner?: { login?: string };
  files?: Record<string, { content?: string }>;
}

function token(): string | null {
  return process.env.GITHUB_TOKEN ?? null;
}

function headers(accept = "application/vnd.github+json"): Record<string, string> {
  const result: Record<string, string> = {
    accept,
    "user-agent": "rarext-source-adapter",
  };
  const auth = token();
  if (auth) result.authorization = `Bearer ${auth}`;
  return result;
}

function repoName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error("repo must be an owner/name GitHub repository");
  }
  return value;
}

function safePath(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error("path must be a string");

  const path = value.trim().replace(/^\/+/, "");

  if (!path || path.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("path must be a relative file path");
  }

  return path;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  accept?: string,
): Promise<Response> {
  const response = await fetchImpl(url, {
    headers: headers(accept),
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status}`);
  }

  return response;
}

async function json<T>(fetchImpl: typeof fetch, url: string): Promise<T> {
  return (await (await request(fetchImpl, url)).json()) as T;
}

function asCircuit(value: unknown): Circuit {
  if (typeof value !== "object" || value === null) {
    throw new Error("source file must contain a circuit object");
  }

  const record = value as Record<string, unknown>;

  if (!Array.isArray(record.components)) {
    throw new Error("source file must contain components");
  }

  return record as unknown as Circuit;
}

function sourceHash(circuit: Circuit): string {
  return createHash("sha256").update(canonicalize(circuit)).digest("hex");
}

export class GitHubSourceAdapter implements RarextAdapter {
  private readonly requestFetch: typeof fetch;

  constructor(requestFetch: typeof fetch = fetch) {
    this.requestFetch = requestFetch;
  }

  info(): AdapterInfo {
    return {
      id: "github",
      name: "GitHub",
      kind: "source",
      capabilities: ["source", "identity"],
      configured: true,
      status: "ready",
      description:
        "Resolve public repositories, pin exact commits, and import circuit files by path.",
      url: "https://github.com",
    };
  }

  async status(): Promise<AdapterStatus> {
    return statusFor(this.info(), {
      api: API,
      token: Boolean(token()),
      rateLimit: token() ? "authenticated" : "public",
    });
  }

  async resolveSource(query: SourceQuery): Promise<SourceResolution> {
    const repo = repoName(query.repo);
    const path = safePath(query.path);
    const repoInfo = await json<GitHubRepo>(this.requestFetch, `${API}/repos/${repo}`);
    const ref = query.ref?.trim() || repoInfo.default_branch;
    const commit = await json<GitHubCommit>(
      this.requestFetch,
      `${API}/repos/${repo}/commits/${encodeURIComponent(ref)}`,
    );

    const source = {
      kind: "github" as const,
      repo,
      url: repoInfo.html_url,
      ref,
      path,
      commit: commit.sha,
      license: repoInfo.license?.spdx_id ?? null,
    };

    let circuit: Circuit | null = null;
    let circuitHash: string | null = null;
    let taskScore: DesignScore | null = null;

    if (path) {
      const response = await request(
        this.requestFetch,
        `${RAW}/${repo}/${commit.sha}/${encodePath(path)}`,
        "text/plain",
      );
      const text = await response.text();

      if (text.length > MAX_SOURCE_BYTES) {
        throw new Error("source file is too large");
      }

      try {
        const parsed: unknown = JSON.parse(text);
        const candidate = asCircuit(parsed);
        validateCircuit(candidate);
        circuit = candidate;
        circuitHash = sourceHash(candidate);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`could not read circuit at ${path}: ${message}`);
      }
    }

    if (query.taskId) {
      const task = findTask(query.taskId);

      if (!task) throw new Error(`unknown task: ${query.taskId}`);
      if (circuit) taskScore = score(circuit, task);
    }

    return {
      source,
      title: repoInfo.name,
      description: repoInfo.description,
      stars: repoInfo.stargazers_count,
      circuit,
      circuitHash,
      score: taskScore,
    };
  }

  async verifyIdentityLink(proof: IdentityLinkProof): Promise<void> {
    const username = proof.externalId;

    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(username)) {
      throw new Error("externalId must be a GitHub username");
    }

    let url: URL;

    try {
      url = new URL(proof.proofUrl);
    } catch {
      throw new Error("proofUrl must be a valid URL");
    }

    if (url.protocol !== "https:") {
      throw new Error("proofUrl must use https");
    }

    const segments = url.pathname.split("/").filter(Boolean);
    let owner: string | null = null;
    let content = "";

    if (url.hostname === "api.github.com" && segments[0] === "gists") {
      const gist = await json<GitHubGist>(this.requestFetch, url.toString());
      owner = gist.owner?.login ?? null;
      content = Object.values(gist.files ?? {})
        .map((file) => file.content ?? "")
        .join("\n");
    } else if (
      url.hostname === "gist.githubusercontent.com" &&
      segments.length >= 3
    ) {
      owner = segments[0] ?? null;
      content = await (
        await request(this.requestFetch, url.toString(), "text/plain")
      ).text();
    } else if (
      url.hostname === "raw.githubusercontent.com" &&
      segments.length >= 2
    ) {
      owner = segments[0] ?? null;
      content = await (
        await request(this.requestFetch, url.toString(), "text/plain")
      ).text();
    } else {
      throw new Error(
        "proofUrl must be a public GitHub gist or raw.githubusercontent.com file",
      );
    }

    if (!owner || owner.toLowerCase() !== username.toLowerCase()) {
      throw new Error("proofUrl is not owned by the claimed GitHub account");
    }

    const marker = [
      "rarext.identity-link.v1",
      `handle=${proof.handle}`,
      `network=github`,
      `externalId=${username}`,
      `nonce=${proof.nonce}`,
    ].join("\n");

    if (!content.includes(marker)) {
      throw new Error("proof content does not contain the identity-link marker");
    }
  }
}
