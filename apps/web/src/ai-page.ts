import {
  STARTER_MODEL,
  STARTER_SEED,
  STARTER_STEPS,
  checkBoundedClaim,
  checkClaim,
  runBoundedProof,
  runCommittedModel,
} from "./ai.ts";

/**
 * The page half of the browser AI proof: DOM wiring only, so the module it calls
 * stays importable by tests without a document.
 */

const $ = (id: string): HTMLElement => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found;
};

const seedInput = $("seed") as HTMLInputElement;
const stepsInput = $("steps") as HTMLInputElement;
const outputPre = $("output") as HTMLPreElement;
const evidencePre = $("evidence") as HTMLPreElement;
const verdict = $("verdict");

const claimInput = $("claim") as HTMLTextAreaElement;
const checkResult = $("check-result");

seedInput.value = String(STARTER_SEED);
stepsInput.value = String(STARTER_STEPS);

async function run(): Promise<void> {
  const seed = Number(seedInput.value);
  const steps = Number(stepsInput.value);

  try {
    const started = performance.now();
    const { output, proof } = await runCommittedModel(STARTER_MODEL, seed, steps);
    const took = Math.round(performance.now() - started);

    outputPre.textContent = output;
    evidencePre.textContent = JSON.stringify(
      {
        artifact: { app: "ai-generative", kind: "ai.generative", version: 1, mediaType: "application/json", body: proof.body },
        steps: proof.steps,
        modelDigest: proof.modelDigest,
        traceHash: proof.traceHash,
        artifactHash: proof.artifactHash,
        correct: proof.correct,
      },
      null,
      2,
    );
    verdict.textContent = proof.correct
      ? `Ran here in ${took} ms. The replay agrees — this output is the committed model's, and anyone can recompute it.`
      : `Ran here in ${took} ms, and the replay DISAGREES with the run. That is a bug worth reporting.`;
    checkResult.textContent = "";
  } catch (error) {
    outputPre.textContent = "";
    evidencePre.textContent = "";
    verdict.textContent = error instanceof Error ? error.message : String(error);
  }
}

$("run").addEventListener("click", () => void run());

$("check").addEventListener("click", () => {
  const claimed = claimInput.value.trim();
  if (!claimed) {
    checkResult.textContent = "Paste a claimed output to check.";
    return;
  }
  const result = checkClaim(STARTER_MODEL, Number(seedInput.value), claimed, Number(stepsInput.value));
  checkResult.textContent = result.correct
    ? "MATCHES the committed model. The claim is true by recomputation — no signature needed to know the model produced it."
    : `DOES NOT MATCH. The committed model produces ${result.expected.length} tokens that differ from this claim.`;
});

void run();

/**
 * The lossy half of the page. The reference is not hardcoded: it is read from the
 * bundle BESIDE the page (the mirror serves one), so the page cannot drift from
 * the artifact it is talking about — and if the bundle is not there, it says so
 * instead of inventing a reference.
 */
interface BoundedFixture {
  reference: number[];
  metric: "maxAbsError" | "meanAbsError";
  bound: number;
}

async function loadBoundedFixture(): Promise<BoundedFixture | null> {
  try {
    const response = await fetch("./bundle.json", { cache: "no-cache" });
    if (!response.ok) return null;
    const bundle = (await response.json()) as {
      publications?: Array<{ app?: string; challengeId?: string }>;
      challenges?: Array<{ id?: string; spec?: { metric?: string; bound?: number; reference?: number[] } }>;
    };
    const published = bundle.publications?.find((entry) => entry.app === "ai-bounded");
    const challenge = bundle.challenges?.find((entry) => entry.id === published?.challengeId);
    const spec = challenge?.spec;
    if (!spec?.reference || !spec.metric || typeof spec.bound !== "number") return null;
    return { reference: spec.reference, metric: spec.metric as "maxAbsError" | "meanAbsError", bound: spec.bound };
  } catch {
    return null;
  }
}

const boundedInput = $("reconstruction") as HTMLTextAreaElement;
const boundedResult = $("bounded-result");
const boundedEvidence = $("bounded-evidence") as HTMLPreElement;
const boundedFixture = await loadBoundedFixture();

if (!boundedFixture) {
  boundedResult.textContent =
    "This page is not beside a mirror bundle, so there is no committed reference to measure against. Open it from the published mirror.";
} else {
  boundedResult.textContent = `Committed reference loaded from the bundle beside this page: ${boundedFixture.reference.length} values, ${boundedFixture.metric} within ${boundedFixture.bound}.`;
  boundedInput.placeholder = `e.g. ${boundedFixture.reference.slice(0, 4).join(", ")}, …`;
}

$("check-bounded").addEventListener("click", () => {
  if (!boundedFixture) return;
  const parsed = boundedInput.value
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)
    .map(Number);
  if (parsed.length === 0 || parsed.some((value) => !Number.isFinite(value))) {
    boundedResult.textContent = "Paste numbers (comma or space separated) to measure.";
    return;
  }

  try {
    const claim = checkBoundedClaim(boundedFixture.reference, parsed, boundedFixture.metric, boundedFixture.bound);
    if (claim.error) {
      boundedResult.textContent = claim.error;
      boundedEvidence.textContent = "";
      return;
    }
    boundedResult.textContent = claim.correct
      ? `WITHIN the bound: ${boundedFixture.metric} = ${claim.metricValue} (bound ${boundedFixture.bound}). The claim is true by recomputation.`
      : `OUTSIDE the bound: ${boundedFixture.metric} = ${claim.metricValue} (bound ${boundedFixture.bound}). The claim is false, and no signature can make it true.`;
    void runBoundedProof(boundedFixture.reference, parsed, boundedFixture.metric, boundedFixture.bound).then((proof) => {
      boundedEvidence.textContent = JSON.stringify(proof, null, 2);
    });
  } catch (error) {
    boundedResult.textContent = error instanceof Error ? error.message : String(error);
  }
});
