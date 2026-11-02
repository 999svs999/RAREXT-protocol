// The FUTURISTIC brand page, in ONE place.
//
// This is the face of FUTURISTIC on RAREXT: the brand's own gallery of what it
// actually published — every one-line prompt, every platform, every run — under
// the brand's identity, with the mirror's Merkle root recomputed in the reader's
// browser. No horse, no ApesDaily chrome: FUTURISTIC has its own skin.
//
// The page is self-contained: it imports the mirror's own verify.js (the same
// verifier the verify page runs) and renders the futuristic-video publications
// from an inline bundle. The bundle is injected at build time by the caller.

export function futuristicGalleryPage(bundle) {
  const root = bundle.manifest.root;
  const publications = (bundle.publications ?? []).filter(
    (p) => p.artifact?.app === "futuristic-video",
  );
  const count = publications.length;
  const cards = publications
    .map((p) => futuristicCard(p))
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>FUTURISTIC — published on RAREXT</title>
    <meta name="description" content="FUTURISTIC's published record on RAREXT: every one-line prompt, every platform, every run — anchored and verifiable." />
    <link rel="icon" href="./favicon.svg" type="image/svg+xml" />
    <style>
      html { color-scheme: dark; }
      * { box-sizing: border-box; }
      body { margin: 0; padding: 0 0 64px; background: #05070c; color: #e8eefc;
             font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
             background-image:
               radial-gradient(1200px 500px at 70% -10%, rgba(64,120,255,.14), transparent 60%),
               radial-gradient(900px 400px at 10% 110%, rgba(0,229,255,.08), transparent 60%);
             background-attachment: fixed; }
      :focus-visible { outline: 2px solid #53c7ff; outline-offset: 2px; }
      .wrap { max-width: 880px; margin: 0 auto; padding: 0 20px; }
      header { padding: 56px 0 8px; }
      .mark { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
      h1 { margin: 0; font-size: 34px; letter-spacing: .34em; font-weight: 700;
           background: linear-gradient(92deg, #7fd4ff 0%, #b48cff 55%, #53ffc5 100%);
           -webkit-background-clip: text; background-clip: text; color: transparent; }
      .tagline { margin: 10px 0 0; color: #8fa3c4; font-size: 13px; letter-spacing: .08em; }
      .address { margin-top: 22px; padding: 12px 14px; border: 1px solid #1c2740;
                 border-radius: 10px; background: rgba(10,16,30,.72); font-size: 12px;
                 word-break: break-all; color: #9db4da; }
      .address b { color: #cfe0ff; font-weight: 600; }
      .chip { display: inline-block; margin-top: 14px; padding: 5px 12px; border-radius: 999px;
              border: 1px solid #1f4d3a; color: #57e8a9; font-size: 11px; letter-spacing: .12em; }
      .chip.bad { border-color: #5d2430; color: #ff7d90; }
      h2 { font-size: 12px; letter-spacing: .3em; color: #6d84ab; margin: 44px 0 16px;
           text-transform: uppercase; }
      .card { border: 1px solid #17223c; border-radius: 12px; padding: 16px 18px;
              margin: 0 0 14px; background: rgba(9,14,27,.8); }
      .card h3 { margin: 0 0 6px; font-size: 15px; color: #dfe9ff; font-weight: 600; }
      .prompt { margin: 8px 0; color: #9fd8ff; font-size: 13px; }
      .prompt::before { content: "“"; color: #4d6fa8; } .prompt::after { content: "”"; color: #4d6fa8; }
      .meta { color: #66799c; font-size: 11px; margin: 6px 0 10px; word-break: break-all; }
      .chips { display: flex; gap: 8px; flex-wrap: wrap; }
      .chips a, .chips span { display: inline-block; padding: 3px 10px; border-radius: 999px;
              border: 1px solid #24334f; font-size: 11px; color: #a9bce0; text-decoration: none; }
      .chips a:hover { border-color: #53c7ff; color: #cfeaff; }
      .chips .yt { border-color: #4d2a30; color: #ff9d9d; }
      footer { margin-top: 52px; padding-top: 18px; border-top: 1px solid #141d33;
               color: #5d7194; font-size: 11px; letter-spacing: .06em; }
      footer a { color: #8fb8e8; text-decoration: none; }
      @media (max-width: 560px) { header { padding-top: 34px; } h1 { font-size: 24px; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <div class="mark"><h1>FUTURISTIC</h1></div>
        <p class="tagline">One-line prompts. No edits, no qualifiers. Published forever.</p>
        <div class="address"><b>rarext:futuristic@</b>${root}</div>
        <span id="status" class="chip" role="status" aria-live="polite">VERIFYING…</span>
      </header>

      <h2>Published record — ${count} run${count === 1 ? "" : "s"}</h2>
      <section id="gallery">
${cards}
      </section>

      <footer>
        Anchored on RAREXT — the record survives the operator. Recompute the root yourself:
        <a href="./verify.html?root=${root}">run the pinned verifier</a> ·
        <a href="./bundle.json">bundle.json</a> ·
        <a href="https://www.youtube.com/@futuristiclive">@futuristiclive</a>
      </footer>
    </div>
    <script type="module">
      import { verifyBundle } from "./verify.js";
      const status = document.getElementById("status");
      async function check(attempt) {
        try {
          const res = await fetch("./bundle.json", { cache: "no-store" });
          if (!res.ok) throw new Error("bundle fetch " + res.status);
          const verdict = await verifyBundle(await res.json());
          if (verdict.valid) {
            status.textContent = "ROOT VERIFIED · ${root.slice(0, 12)}…";
            status.classList.remove("bad");
          } else if (attempt < 2) {
            // A fresh deploy can serve a stale cached bundle for a moment;
            // retry before declaring anything.
            setTimeout(() => check(attempt + 1), 3000);
          } else {
            status.textContent = "ROOT MISMATCH — " + (verdict.reason ?? "no reason given");
            status.classList.add("bad");
          }
        } catch (error) {
          status.textContent = "VERIFY FAILED: " + (error?.message ?? error);
          status.classList.add("bad");
        }
      }
      check(0);
    </script>
  </body>
</html>
`;
}

function futuristicCard(publication) {
  const body = publication.artifact?.body ?? {};
  const platforms = Array.isArray(body.platforms) ? body.platforms : [];
  const chips = platforms
    .map((p) => {
      if (p.platform === "youtube" && p.id) {
        return `<a class="yt" href="https://youtu.be/${p.id}" rel="noopener">YouTube ▸</a>`;
      }
      if (p.url) {
        return `<a href="${p.url}" rel="noopener">${escapeHtml(p.platform)} ▸</a>`;
      }
      return `<span>${escapeHtml(p.platform)}: ${escapeHtml(String(p.id ?? ""))}</span>`;
    })
    .join("\n        ");
  const r2 = body.video?.r2_url
    ? `\n        <a href="${body.video.r2_url}" rel="noopener">R2 ▸</a>`
    : "";
  const seconds = typeof body.duration_s === "number" ? `${body.duration_s.toFixed(2)}s` : "?";
  return `    <article class="card">
      <h3>${escapeHtml(publication.title ?? body.run_id ?? "run")}</h3>
      <p class="prompt">${escapeHtml(body.prompt ?? "")}</p>
      <p class="meta">run ${escapeHtml(body.run_id ?? "?")} · ${escapeHtml(body.model ?? "?")} · ${seconds} · ${platforms.length} platform${platforms.length === 1 ? "" : "s"}</p>
      <div class="chips">
        ${chips}${r2}
      </div>
    </article>`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&" + "amp;")
    .replaceAll("<", "&" + "lt;")
    .replaceAll(">", "&" + "gt;")
    .replaceAll('"', "&" + "quot;")
    .replaceAll("'", "&#" + "39;");
}
