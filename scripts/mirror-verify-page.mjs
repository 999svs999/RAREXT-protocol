// The mirror's proof page, in ONE place.
//
// It had two implementations — one inside build-mirror.mjs (the local dev tree)
// and one inside publish-ai-proof.mjs (the published tree) — which looked like
// twins and drifted the moment either was touched: a failover fix landed in the
// dev copy while the published page kept fetching a single ./bundle.json, and
// nothing failed, because both pages were "generated correctly" by their own
// generator.
//
// Both generators now call mirrorVerifyPage({ title, heading }), and claim:check
// asserts they do and that neither keeps a private copy of the page.

export function mirrorVerifyPage({ title, heading }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { margin: 0; padding: 40px; background: #080a0e; color: #e3eaf3;
             font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      h1 { font-size: 20px; margin: 0 0 18px; }
      h2 { font-size: 14px; margin: 26px 0 8px; color: #9fb0c3; }
      .row { display: flex; justify-content: space-between; gap: 20px;
             padding: 8px 0; border-bottom: 1px solid #1b222c; font-size: 13px; }
      .ok { color: #6ff0c4; } .bad { color: #ff7d90; } .dim { color: #6c7a8b; }
      button { margin-top: 18px; padding: 8px 14px; border-radius: 7px;
               border: 1px solid #2d3846; background: #141922; color: #e3eaf3;
               font: inherit; cursor: pointer; }
      code { word-break: break-all; }
    </style>
  </head>
  <body>
    <h1>${heading}</h1>
    <div id="out"></div>
    <button id="check">Re-verify</button>
    <script type="module">
      import { verifyBundle } from "./verify.js";
      import {
        semanticsCommitmentHolds,
        sha256Hex,
        federationFromBundle,
        parseRegistrySeedList,
        registryListDigestSource,
      } from "./renditions.js";
      const out = document.getElementById("out");

      // The same cap every client path shares (MAX_BUNDLE_RESPONSE_BYTES in
      // @rarext/core): honest bundles are ~21 KiB and grow with publications;
      // a response larger than 8 MiB is refused before it is read, so a
      // hostile mirror cannot hand every visitor a giant allocation.
      const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

      const htmlRow = (label, value, cls) =>
        '<div class="row"><span class="dim">' + label + '</span><span class="' + (cls ?? "") + '">' + value + "</span></div>";

      // Read the body through the cap: refuse a declared Content-Length above
      // MAX_BUNDLE_BYTES before reading, and count bytes while reading so the
      // cap holds even when the header is absent or lying.
      async function readCapped(response) {
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > MAX_BUNDLE_BYTES) {
          if (response.body && response.body.cancel) { try { await response.body.cancel(); } catch (error) { /* the refusal stands either way */ } }
          throw new Error("declares " + declared + " bytes, above the " + MAX_BUNDLE_BYTES + " byte cap");
        }
        if (!response.body || !response.body.getReader) return null; // no stream: the caller falls back
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const step = await reader.read();
          if (step.done) break;
          total += step.value.byteLength;
          if (total > MAX_BUNDLE_BYTES) {
            try { await reader.cancel(); } catch (error) { /* the refusal stands either way */ }
            throw new Error("streamed past the " + MAX_BUNDLE_BYTES + " byte cap (at least " + total + " bytes)");
          }
          chunks.push(step.value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return new TextDecoder().decode(bytes);
      }

      // Fail over between copies the way a client should: this mirror's own
      // bundle, then the sibling registry copy (whichever relative form this
      // tree is published in), then whatever the seed names. A candidate is
      // accepted only if it verifies AND rebuilds the pinned root — a tampered
      // copy fails the first test, and a copy of a DIFFERENT bundle fails the
      // second. Every rejection is kept, and the page says which location the
      // copy it verified actually came from.
      //
      // This loop is the ONE deliberate exception to the shared verification
      // sequence: the API's bundleFromSeed, the SDK's findVerifiedBundle, and
      // verify-seed-mirrors.mjs all delegate the order -- bytes, CID pin,
      // shape, pinned root, refusals -- to verifyCandidates in @rarext/core.
      // It does not stay a loop out of neglect: core's sequence and shape
      // check consume the caller's sha256 SYNCHRONOUSLY, and the only digest a
      // browser has is WebCrypto's crypto.subtle.digest, which is
      // asynchronous. Forking a second, async copy of the sequence into core
      // would recreate exactly the drift this unit closed, so the page keeps
      // this loop and the constraint instead. claim-check guards the
      // exception: it fails if this loop starts re-implementing the shared
      // sequence's wording (the CID pin) or if a caller stops delegating.
      async function loadBundle(pinned) {
        const candidates = ["./bundle.json", "../registry/bundle.json", "../bundle.json"];
        for (const seedUrl of ["./seed.json", "../registry/seed.json"]) {
          try {
            const seed = await (await fetch(seedUrl)).json();
            if (typeof seed.bundle === "string") candidates.push(seed.bundle);
            for (const mirror of seed.mirrors ?? []) if (mirror && mirror.bundle) candidates.push(mirror.bundle);
          } catch (error) { /* no seed reachable from here; the relative copies still apply */ }
        }
        const seen = new Set();
        const refusals = [];
        for (const url of candidates) {
          if (seen.has(url)) continue;
          seen.add(url);
          try {
            const response = await fetch(url);
            if (!response.ok) { refusals.push(url + ": HTTP " + response.status); continue; }
            const text = await readCapped(response);
            const value = JSON.parse(text === null ? await response.text() : text);
            const probe = await verifyBundle(value, undefined, pinned ?? undefined);
            if (!probe.valid) { refusals.push(url + ": " + (probe.reason ?? "does not verify")); continue; }
            return { bundle: value, source: url, refusals: refusals };
          } catch (error) {
            refusals.push(url + ": " + (error && error.message ? error.message : "unreachable"));
          }
        }
        return { bundle: null, source: null, refusals: refusals };
      }

      async function run() {
        const blobFile = await fetch("./blobs.json").then((response) => response.ok ? response.json() : { blobs: [] });
        const requested = new URLSearchParams(location.search).get("root");
        const pinned = requested && /^[0-9a-f]{64}$/.test(requested) ? requested : null;
        const loaded = await loadBundle(pinned);
        const bundle = loaded.bundle;

        if (!bundle) {
          out.innerHTML = htmlRow("No copy verified", "every location this page could reach was rejected or unreachable", "bad")
            + loaded.refusals.map((refusal) => htmlRow("Tried", "<code>" + refusal + "</code>", "dim")).join("");
          return;
        }

        // The bundle carries every challenge spec, so this page can replay the
        // generative claims and recompute the bounded metrics itself. The
        // mirror's inline blobs let it check the rendition bytes as well.
        const challenges = Object.fromEntries(
          (bundle.challenges ?? []).map((challenge) => [challenge.id, challenge.spec ?? {}]),
        );
        const media = Object.fromEntries(
          (Array.isArray(blobFile.blobs) ? blobFile.blobs : [])
            .filter((blob) => typeof blob.hash === "string" && typeof blob.content === "string")
            .map((blob) => [blob.hash, blob.content]),
        );
        const result = await verifyBundle(bundle, challenges, pinned ?? undefined, media);

        const sourceRow = htmlRow(
          "Served from",
          "<code>" + loaded.source + "</code>",
          loaded.refusals.length ? "" : "dim",
        );
        const rejectedRows = loaded.refusals.map((refusal) => htmlRow("Rejected", "<code>" + refusal + "</code>", "dim"));
        const pinRow = pinned
          ? htmlRow("Pinned chain root", "<code>" + pinned + "</code>", result.valid ? "ok" : "bad")
          : htmlRow("Pinned chain root", "not supplied (open with ?root=...)", "dim");

        const sections = [sourceRow]
          .concat(rejectedRows)
          .concat([
            htmlRow("Publications", String(result.publications)),
            htmlRow("Anchored root", "<code>" + result.root + "</code>"),
            htmlRow("Recomputed root", "<code>" + result.computedRoot + "</code>"),
            pinRow,
            htmlRow("This copy is faithful", result.valid ? "yes" : "no", result.valid ? "ok" : "bad"),
            result.reason ? htmlRow("Why not", result.reason, "bad") : "",
          ]);

        // The registry anchors its MEANINGS, and a page whose job is "is this copy
        // faithful" should say so rather than leave the newest property to a different
        // page. Recomputed here from the records the bundle carries.
        const semantics = await semanticsCommitmentHolds(bundle, sha256Hex);
        sections.push("<h2>Meanings — anchored</h2>");
        if (!semantics) {
          sections.push(htmlRow("Semantics commitment", "this registry records none", "dim"));
        } else {
          const matched = semantics.missing.length === 0;
          sections.push(htmlRow(
            "Committed records",
            semantics.matched + " of " + semantics.committed + " digest(s) match the records this copy carries",
            matched ? "ok" : "bad",
          ));
          if (!matched) sections.push(htmlRow("Unmatched", semantics.missing.join(", "), "bad"));
        }

        // The FEDERATION commitment: which registries this bundle says exist, and whether the
        // list published beside it is the one committed to. The digest is recomputed here from
        // the canonical source core owns, so this is a verification, not a display.
        const federation = federationFromBundle(bundle);
        sections.push("<h2>Federation — the registries this bundle commits to</h2>");
        if (!federation) {
          sections.push(htmlRow("Federation commitment", "this bundle records none", "dim"));
        } else {
          let list = null;
          let listSource = federation.listUrl;
          try {
            const response = await fetch(federation.listUrl, { cache: "no-cache" });
            if (!response.ok) throw new Error("HTTP " + response.status);
            list = parseRegistrySeedList(await response.json());
          } catch {
            try {
              const response = await fetch("../seed.json", { cache: "no-cache" });
              if (!response.ok) throw new Error("HTTP " + response.status);
              listSource = "../seed.json (the copy beside this page)";
              list = parseRegistrySeedList(await response.json());
            } catch {
              sections.push(htmlRow("Seed list", "could not be fetched from " + federation.listUrl, "bad"));
            }
          }
          if (list) {
            const digest = await sha256Hex(registryListDigestSource(list));
            const matches = digest === federation.digest;
            sections.push(
              htmlRow(
                "Committed digest",
                federation.digest.slice(0, 24) + "\u2026",
                matches ? "ok" : "bad",
              ),
            );
            sections.push(
              htmlRow(
                "Seed list at " + listSource,
                matches ? "digest MATCHES the commitment" : "digest DOES NOT match the commitment",
                matches ? "ok" : "bad",
              ),
            );
            for (const entry of list) {
              sections.push(
                htmlRow(
                  "Registry " + entry.id,
                  entry.operator + " \u00b7 " + entry.url + " \u00b7 chains: " + entry.chains.join(", "),
                ),
              );
            }
          }
        }

        const ai = (result.aiClaims ?? []).filter((claim) => claim.representation);
        if (ai.length) {
          sections.push("<h2>AI claims — verified in your browser</h2>");
          for (const claim of ai) {
            const title = (bundle.publications.find((pub) => pub.id === claim.publicationId) ?? {}).title ?? claim.publicationId;
            sections.push(htmlRow(title.slice(0, 60), "representation: " + claim.representation, "dim"));
            if (claim.representation === "bounded") {
              sections.push(htmlRow(
                "committed metric",
                claim.metricName + " = " + claim.metricValue + " (bound " + claim.bound + ")",
                claim.withinBound === false ? "bad" : "ok",
              ));
            }
            if (claim.local) {
              let detail = "local check: " + (claim.local.correct ? "PASSES" : "FAILS");
              if (claim.local.metricValue !== undefined) {
                const committed = claim.metricValue;
                const agrees = committed === null || committed === claim.local.metricValue;
                detail += " · recomputed metric " + claim.local.metricValue +
                  (agrees ? " (matches attestation)" : " (MISMATCHES attested " + committed + ")");
                sections.push(htmlRow(title.slice(0, 60), detail, agrees ? "ok" : "bad"));
              } else {
                sections.push(htmlRow(title.slice(0, 60), detail, claim.local.correct ? "ok" : "bad"));
              }
            } else {
              sections.push(htmlRow(title.slice(0, 60), "local check: not run (spec unavailable)", "dim"));
            }
            if (claim.media) {
              sections.push(htmlRow(
                "rendition",
                claim.media.matches === true
                  ? "raster re-derived from the commitment"
                  : claim.media.matches === false ? "raster MISMATCH" : "not checked",
                claim.media.matches === true ? "ok" : "bad",
              ));
              if (claim.media.blobMatches !== null && claim.media.blobMatches !== undefined) {
                sections.push(htmlRow(
                  "rendition bytes",
                  claim.media.blobMatches ? "blob digest matches the mirror copy" : "blob MISMATCH",
                  claim.media.blobMatches ? "ok" : "bad",
                ));
              }
            }
          }
        }

        out.innerHTML = sections.join("");
      }

      document.getElementById("check").addEventListener("click", run);
      run();
    </script>
  </body>
</html>
`;
}
