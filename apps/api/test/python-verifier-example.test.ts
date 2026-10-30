import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import type { Artifact, Challenge } from "../../../packages/core/src/index.ts";
import { canonicalize } from "../../../packages/core/src/index.ts";
import { createVerifierRegistry } from "../src/verifiers.ts";

/**
 * The Python verifier example, gated.
 *
 * docs/APP-PROTOCOL.md points readers at examples/python-verifier as the minimal echo app:
 * the worked example of a service in ANOTHER RUNTIME joining the protocol without changing its
 * runtime. Its README's publish step had gone stale and nothing noticed, because no gate ever
 * ran the example — the external-verifier protocol is tested against a fixture, and the example
 * itself was decoration. This runs the real service, in the runtime its README says.
 *
 * The decisive assertion is the NEGATIVE one: the verdict must carry the digest the Python
 * process computes, so killing the service must break the verification. A verdict produced by a
 * local rule instead of by the service would pass a positive-only test and fail this one.
 */
const EXAMPLE = "examples/python-verifier";

function exampleConfig(port: number) {
  const raw = JSON.parse(readFileSync(`${EXAMPLE}/verifiers.json`, "utf8")) as {
    verifiers: Array<{ app: string; url: string; artifactKinds: string[] }>;
  };
  assert.equal(raw.verifiers.length, 1, "the example registers exactly one verifier");
  const [entry] = raw.verifiers;
  // The example pins 9100 so its README works as written; the test moves it to a free port and
  // says so, rather than fighting whatever else is on 9100.
  assert.match(entry!.url, /^http:\/\/127\.0\.0\.1:\d+\/verify$/, "the example's URL shape");
  return {
    app: entry!.app,
    artifactKinds: entry!.artifactKinds,
    url: `http://127.0.0.1:${port}/verify`,
    exampleUrl: entry!.url,
  };
}

const challenge: Challenge = {
  id: "echo-1",
  app: "echo-lab",
  title: "Echo a signal",
  description: "Return a deterministic proof for the submitted signal.",
  version: 1,
  spec: { kind: "echo" },
  semanticsId: "echo-lab/echo-1",
  semanticsVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const artifact: Artifact = {
  app: "echo-lab",
  kind: "echo.signal",
  version: 1,
  mediaType: "application/json",
  body: { value: 42 },
};

/** What the Python service's own canonical() + sha256 must produce for this body. */
async function freePort(): Promise<number> {
  const server = createServer(() => undefined);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function startPython(port: number) {
  const child = spawn("python3", ["verifier.py"], {
    cwd: EXAMPLE,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  // Readiness: the handler answers whatever it is asked, so any HTTP status means it is up.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`python verifier exited ${child.exitCode}: ${stderr}`);
    try {
      await fetch(`http://127.0.0.1:${port}/verify`, { method: "POST", body: "{}" });
      return child;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  child.kill("SIGKILL");
  throw new Error(`python verifier never answered on ${port}: ${stderr}`);
}

test("the python verifier example answers, its own proof binds into the attestation, and it stops when it stops", async (t) => {
  const probe = spawn("python3", ["--version"]);
  const [code] = (await once(probe, "exit")) as [number];
  if (code !== 0) {
    t.skip("python3 is not available, so the cross-runtime example cannot be exercised here");
    return;
  }

  const port = await freePort();
  const config = exampleConfig(port);
  const python = await startPython(port);

  try {
    const registry = createVerifierRegistry(fetch, null, { configs: [config] });

    const verdict = await registry.verify(artifact, challenge);

    // The verdict says, in its own data, that the HTTP verifier produced it.
    assert.equal(verdict.verifier, "http:echo-lab", "the verdict must name the external verifier");
    assert.equal(verdict.correct, true, "the python service verified the artifact");
    assert.equal(verdict.score, 100, "the score is the service's own");

    // THE EVIDENCE IS BOUND. An attestation's traceHash is sha256 over the proof the verifier
    // returned, so the expected value is fetched from the RUNNING SERVICE rather than written
    // down here: ask the Python verifier the same question and hash its own answer. A hardcoded
    // digest would only prove the two agreed once, on the day it was pasted.
    const answered = await fetch(`http://127.0.0.1:${port}/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ artifact, challenge }),
    });
    assert.equal(answered.status, 200, "the service answers the same question directly");
    const payload = (await answered.json()) as { proof?: unknown; correct?: unknown };
    assert.ok(payload.proof !== undefined, "the service returns a proof");
    assert.equal(
      verdict.traceHash,
      createHash("sha256").update(canonicalize(payload.proof)).digest("hex"),
      "the attestation's trace hash must be the hash of the PROOF THE SERVICE RETURNED",
    );

    // The negative half: with the service gone the same verification must fail. A verdict from
    // a local rule would survive this, so surviving it would mean nothing here was external.
    python.kill("SIGKILL");
    await once(python, "exit");
    await assert.rejects(() => registry.verify(artifact, challenge), Error);
  } finally {
    if (python.exitCode === null) python.kill("SIGKILL");
  }
});
