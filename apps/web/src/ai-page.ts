import { STARTER_MODEL, STARTER_SEED, STARTER_STEPS, checkClaim, runCommittedModel } from "./ai.ts";

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
