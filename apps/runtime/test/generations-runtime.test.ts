import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeployment,
  commitDeployment,
  parseGenerationSpec,
  validateDeployment,
} from "../src/manifest.ts";
import type { EngineProbe } from "../src/types.ts";

const FIXED = "2026-01-01T00:00:00.000Z";

const model = () => ({
  id: "qwen2.5:0.5b",
  family: "qwen2",
  parameters: "494M",
  quantization: "Q4_K_M",
  format: "gguf",
  sizeBytes: null,
  weightsDigest: null,
  contextLength: null,
});

const probe = (): EngineProbe => ({
  engine: { name: "rarext", version: "1", endpoint: "http://127.0.0.1:11434", digest: null },
  model: model(),
  apis: ["openai"],
  models: [model()],
});

test("a --generation spec names all four axes and only declared rungs", () => {
  const parsed = parseGenerationSpec("network=5G,model=1G,web=web5,protocol=gen-6");
  assert.deepEqual(parsed, { network: "5G", model: "1G", web: "web5", protocol: "gen-6" });

  assert.throws(() => parseGenerationSpec("network=5G,model=1G,web=web5"), /missing protocol/);
  assert.throws(() => parseGenerationSpec("network=5G,model=9G,web=web5,protocol=gen-6"), /not a declared model generation/);
  assert.throws(() => parseGenerationSpec("transport=5G,model=1G,web=web5,protocol=gen-6"), /axis must be one of/);
  assert.throws(() => parseGenerationSpec("network,model=1G,web=web5,protocol=gen-6"), /axis=id/);
});

test("a deployment can commit a declared generation, and only a declared one", () => {
  const committed = commitDeployment(
    buildDeployment({
      probe: probe(),
      generation: parseGenerationSpec("network=5G,model=1G,web=web4,protocol=gen-4"),
      createdAt: FIXED,
    }),
  );
  assert.deepEqual(validateDeployment(committed), []);
  assert.equal(committed.generation?.model, "1G");

  const unknown = { ...committed, generation: { ...committed.generation, network: "9G" } };
  const problems = validateDeployment(unknown);
  assert.ok(problems.some((error) => error.includes("generation.network")), problems.join("; "));

  const wrongShape = { ...committed, generation: "6G" };
  assert.ok(validateDeployment(wrongShape).some((error) => error.includes("generation must be an object")));
});

test("the generation is folded into the deployment digest, and omitting it changes nothing else", () => {
  const withGeneration = commitDeployment(
    buildDeployment({
      probe: probe(),
      generation: parseGenerationSpec("network=5G,model=1G,web=web5,protocol=gen-6"),
      createdAt: FIXED,
    }),
  );
  const without = commitDeployment(buildDeployment({ probe: probe(), createdAt: FIXED }));

  assert.notEqual(withGeneration.digest, without.digest, "the generation is part of the commitment");
  assert.equal("generation" in without, false, "an omitted generation is absent, not null");

  // Same generation, same bytes: the digest is stable.
  const again = commitDeployment(
    buildDeployment({
      probe: probe(),
      generation: parseGenerationSpec("network=5G,model=1G,web=web5,protocol=gen-6"),
      createdAt: FIXED,
    }),
  );
  assert.equal(again.digest, withGeneration.digest);
});
