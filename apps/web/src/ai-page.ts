import { verifyPublishedBoundedRendition, fixtureFromBundle,
  renderBoundedPicture,
  renderProofPicture,
  sha256Bytes,
  type PublishedFixture,
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
async function loadFixture(): Promise<PublishedFixture | null> {
  try {
    const response = await fetch("./bundle.json", { cache: "no-cache" });
    if (!response.ok) return null;
    const parsed = fixtureFromBundle(await response.json());
    publishedRendition = parsed?.picture.raster ? { raster: parsed.picture.raster, size: parsed.picture.size } : null;
    refreshPictureNote();
    return parsed;
  } catch {
    return null;
  }
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

const boundedPicture = $("bounded-picture") as HTMLCanvasElement;
const boundedInput = $("reconstruction") as HTMLTextAreaElement;
const boundedResult = $("bounded-result");
const boundedEvidence = $("bounded-evidence") as HTMLPreElement;
const fixture = await loadFixture();

if (!fixture?.lossy) {
  boundedResult.textContent =
    "This page is not beside a mirror bundle, so there is no committed reference to measure against. Open it from the published mirror.";
} else {
  boundedResult.textContent = `Committed reference loaded from the bundle beside this page: ${fixture.lossy.reference.length} values, ${fixture.lossy.metric} within ${fixture.lossy.bound}.`;
  boundedInput.placeholder = `e.g. ${fixture.lossy.reference.slice(0, 4).join(", ")}, …`;

  // Verify the PUBLISHED claim before the visitor does anything: the registry's own
  // reconstruction, measured against the committed reference and re-rendered to the digest
  // the publication recorded. Clicking still checks a paste of your own; this checks theirs.
  const published = fixture.lossy;
  void verifyPublishedBoundedRendition(published).then((checked) => {
    if (!checked) return;
    boundedResult.textContent = checked.within
      ? `The PUBLISHED reconstruction measures ${published.metric} = ${checked.metricValue} within the bound ${published.bound} — recomputed here${
          checked.renditionMatches === null
            ? ""
            : checked.renditionMatches
              ? ", and its values re-render to the digest the publication recorded."
              : ", but its values do NOT re-render to the digest the publication recorded."
        }`
      : `The PUBLISHED reconstruction measures ${published.metric} = ${checked.metricValue}, OUTSIDE the bound ${published.bound}. The claim is false here, and no signature can make it true.`;
    if (checked.renditionMatches === false) boundedResult.classList.add("bad");
    if (published.values) {
      drawRaster(
        boundedPicture,
        renderBoundedPicture(published.reference, published.values, published.rendition as never),
        published.rendition.width ?? published.reference.length,
        published.rendition.height ?? 152,
      );
    }
  });
}

$("check-bounded").addEventListener("click", () => {
  if (!fixture?.lossy) return;
  const parsed = boundedInput.value
    .split(/[\s,]+/)
    .filter((token) => token.length > 0)
    .map(Number);
  if (parsed.length === 0 || parsed.some((value) => !Number.isFinite(value))) {
    boundedResult.textContent = "Paste numbers (comma or space separated) to measure.";
    return;
  }

  try {
    const claim = checkBoundedClaim(fixture.lossy.reference, parsed, fixture.lossy.metric, fixture.lossy.bound);
    if (claim.error) {
      boundedResult.textContent = claim.error;
      boundedEvidence.textContent = "";
      // A refused reconstruction must not leave the PREVIOUS picture looking like it
      // belongs to what was just pasted: the canvas is evidence too.
      boundedPicture.width = 0;
      return;
    }
    boundedResult.textContent = claim.correct
      ? `WITHIN the bound: ${fixture.lossy.metric} = ${claim.metricValue} (bound ${fixture.lossy.bound}). The claim is true by recomputation.`
      : `OUTSIDE the bound: ${fixture.lossy.metric} = ${claim.metricValue} (bound ${fixture.lossy.bound}). The claim is false, and no signature can make it true.`;
    drawRaster(
      boundedPicture,
      renderBoundedPicture(fixture.lossy.reference, parsed, fixture.lossy.rendition),
      fixture.lossy.rendition.width ?? fixture.lossy.reference.length,
      fixture.lossy.rendition.height ?? 152,
    );
    void runBoundedProof(fixture.lossy.reference, parsed, fixture.lossy.metric, fixture.lossy.bound).then((proof) => {
      boundedEvidence.textContent = JSON.stringify(proof, null, 2);
    });
  } catch (error) {
    boundedResult.textContent = error instanceof Error ? error.message : String(error);
  }
});
