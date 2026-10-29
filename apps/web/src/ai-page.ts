import { renderBoundedPicture,
  renderProofPicture,
  sha256Bytes,
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
    const rasterBytes = renderProofPicture(proof.body, RENDITION_SIZE);
    drawRaster(picture, rasterBytes, RENDITION_SIZE, RENDITION_SIZE);
    lastRasterDigest = await sha256Bytes(rasterBytes);
    refreshPictureNote();
    evidencePre.textContent = JSON.stringify(
      {
        artifact: { app: "ai-generative", kind: "ai.generative", version: 1, mediaType: "application/json", body: proof.body },
        steps: proof.steps,
        modelDigest: proof.modelDigest,
        traceHash: proof.traceHash,
        artifactHash: proof.artifactHash,
        // The page's own measurement of the picture it drew: these bytes, this size.
        // It is NOT the artifact's media (this run has no PNG), and the note below
        // refers to this field rather than to a media block that is not there.
        rendition: { size: RENDITION_SIZE, raster: lastRasterDigest },
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
  /** What the published generative edition recorded, so the note can be a comparison, not a claim. */
  published: { raster?: string; size?: number };
  reference: number[];
  metric: "maxAbsError" | "meanAbsError";
  bound: number;
  /** The published rendition's own shape, read from the artifact — not invented here. */
  rendition: { width?: number; height?: number; rule?: string };
}

async function loadBoundedFixture(): Promise<BoundedFixture | null> {
  try {
    const response = await fetch("./bundle.json", { cache: "no-cache" });
    if (!response.ok) return null;
    const bundle = (await response.json()) as {
      publications?: Array<{
        app?: string;
        challengeId?: string;
        artifact?: {
          body?: {
            media?: { width?: number; height?: number; rule?: string; raster?: string; size?: number };
          };
        };
      }>;
      challenges?: Array<{ id?: string; spec?: { metric?: string; bound?: number; reference?: number[] } }>;
    };
    const published = bundle.publications?.find((entry) => entry.app === "ai-bounded");
    const challenge = bundle.challenges?.find((entry) => entry.id === published?.challengeId);
    const spec = challenge?.spec;

    // The generative edition's raster is read FIRST and independently of the lossy
    // half: the two representations are separate publications, and the picture note
    // must not go quiet because the bounded one is missing. (Reading it from the
    // bounded publication drew the picture but could never say it was the published
    // one — caught by loading this page in a browser, not by the type checker.)
    const generative = bundle.publications?.find((entry) => entry.app === "ai-generative");
    const genMedia = generative?.artifact?.body?.media ?? {};
    publishedRendition = genMedia.raster ? { raster: genMedia.raster, size: genMedia.size } : null;
    refreshPictureNote();

    if (!spec?.reference || !spec.metric || typeof spec.bound !== "number") return null;
    const media = published?.artifact?.body?.media ?? {};
    return {
      published: { raster: genMedia.raster, size: genMedia.size },
      reference: spec.reference,
      metric: spec.metric as "maxAbsError" | "meanAbsError",
      bound: spec.bound,
      rendition: { width: media.width, height: media.height, rule: media.rule },
    };
  } catch {
    return null;
  }
}

/** Paint a raw RGB raster — the rendering IS the evidence, so it is not decoded from a file. */
function drawRaster(canvas: HTMLCanvasElement, raster: Uint8Array, width: number, height: number): void {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  const image = context.createImageData(width, height);
  for (let pixel = 0; pixel < width * height; pixel++) {
    image.data[pixel * 4] = raster[pixel * 3] ?? 0;
    image.data[pixel * 4 + 1] = raster[pixel * 3 + 1] ?? 0;
    image.data[pixel * 4 + 2] = raster[pixel * 3 + 2] ?? 0;
    image.data[pixel * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

const picture = $("picture") as HTMLCanvasElement;
const pictureNote = $("picture-note");
const RENDITION_SIZE = 64; // the size the published rendition uses; a raster digest is size-specific
let lastRasterDigest: string | null = null;
let publishedRendition: { raster?: string; size?: number } | null = null;

/**
 * Say what the picture IS. With the published edition beside the page this is a
 * comparison, not an assertion: the visitor can see that the digest the evidence
 * records is the picture drawn above, or that this run's seed produced a different
 * one. With no bundle to compare against it claims nothing.
 */
function refreshPictureNote(): void {
  if (lastRasterDigest === null) return;
  const published = publishedRendition;
  if (published?.raster && published.size === RENDITION_SIZE) {
    pictureNote.textContent =
      published.raster === lastRasterDigest
        ? "This is the PUBLISHED raster — the rendition.raster digest in the evidence below is these exact bytes."
        : "This run's picture. Its digest differs from the published raster because the seed differs; the picture is still a function of the seed, not beside it.";
    return;
  }
  pictureNote.textContent =
    "This run's picture, re-derived from the model and seed above — the rendition.raster digest in the evidence below is these bytes.";
}

const boundedPicture = $("bounded-picture") as HTMLCanvasElement;
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
      // A refused reconstruction must not leave the PREVIOUS picture looking like it
      // belongs to what was just pasted: the canvas is evidence too.
      boundedPicture.width = 0;
      return;
    }
    boundedResult.textContent = claim.correct
      ? `WITHIN the bound: ${boundedFixture.metric} = ${claim.metricValue} (bound ${boundedFixture.bound}). The claim is true by recomputation.`
      : `OUTSIDE the bound: ${boundedFixture.metric} = ${claim.metricValue} (bound ${boundedFixture.bound}). The claim is false, and no signature can make it true.`;
    drawRaster(
      boundedPicture,
      renderBoundedPicture(boundedFixture.reference, parsed, boundedFixture.rendition),
      boundedFixture.rendition.width ?? boundedFixture.reference.length,
      boundedFixture.rendition.height ?? 152,
    );
    void runBoundedProof(boundedFixture.reference, parsed, boundedFixture.metric, boundedFixture.bound).then((proof) => {
      boundedEvidence.textContent = JSON.stringify(proof, null, 2);
    });
  } catch (error) {
    boundedResult.textContent = error instanceof Error ? error.message : String(error);
  }
});
