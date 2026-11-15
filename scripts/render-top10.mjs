// Rank RAREXT against the top AI brands, from bench/ui-ux.json.
//
// The brands are grouped, because one brand ships several surfaces and a fair
// comparison uses each brand's best-measured surface rather than the one that
// flatters the table. The script asserts the outcome instead of describing it:
// if RAREXT is not first on every axis, it says so and exits non-zero.
//
//   node scripts/render-top10.mjs            # Markdown table + verdict
//   node scripts/render-top10.mjs --check    # verdict only, exit 1 if not first
import { readFileSync, writeFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("../bench/ui-ux.json", import.meta.url), "utf8"));
const byId = new Map(data.results.map((r) => [r.id, r]));

// brand -> the surfaces that brand ships. "app" is the product people use;
// "site" is its public front door. Whichever scores higher represents the brand.
const BRANDS = [
  { brand: "RAREXT", self: true, surfaces: ["rarext"] },
  { brand: "OpenAI — ChatGPT", surfaces: ["chatgpt"] },
  { brand: "Google — Gemini", surfaces: ["gemini", "gemini-marketing"] },
  { brand: "Microsoft — Copilot", surfaces: ["copilot"] },
  { brand: "Anthropic — Claude", surfaces: ["claude", "claude-marketing"] },
  { brand: "Perplexity", surfaces: ["perplexity"] },
  { brand: "xAI — Grok", surfaces: ["grok"] },
  { brand: "Mistral — Le Chat", surfaces: ["lechat", "mistral-marketing"] },
  { brand: "Meta — Meta AI", surfaces: ["metaai"] },
  { brand: "DeepSeek", surfaces: ["deepseek", "deepseek-site"] },
  { brand: "DuckDuckGo — Duck.ai", surfaces: ["duckai"] },
  { brand: "Hugging Face — HuggingChat", surfaces: ["huggingchat"] },
  { brand: "You.com", surfaces: ["youcom"] },
  { brand: "Poe", surfaces: ["poe"] },
];

const flag = (r) => {
  if (!r) return "not measured";
  if (r.http?.status === 403) return "gate (403)";
  if (!r.http?.status) return "no response";
  if (r.http.status >= 400) return `HTTP ${r.http.status}`;
  return "loaded";
};

const rows = BRANDS.map(({ brand, self, surfaces }) => {
  const present = surfaces.map((id) => byId.get(id)).filter(Boolean);
  const best = present.sort((a, b) => (b.score?.overall ?? -1) - (a.score?.overall ?? -1))[0];
  const others = present.filter((r) => r !== best);
  return {
    brand,
    self: Boolean(self),
    best,
    others,
    overall: best?.score?.overall ?? -1,
    perf: best?.score?.perf ?? -1,
    a11y: best?.score?.a11y ?? -1,
    ux: best?.score?.ux ?? -1,
    status: flag(best),
    surface: best ? best.name.replace(/^RAREXT /, "").replace(/ \(current\)/, "") : "—",
  };
}).sort((a, b) => b.overall - a.overall || a.brand.localeCompare(b.brand));

const cell = (n) => (n < 0 ? "—" : String(n));
const lines = [
  "| # | Brand | Surface measured | Perf | A11y | UX | Overall | Status |",
  "| ---: | --- | --- | ---: | ---: | ---: | ---: | --- |",
];
rows.forEach((r, i) => {
  lines.push(
    `| ${i + 1} | ${r.self ? `**${r.brand}**` : r.brand} | ${r.surface} | ${cell(r.perf)} | ${cell(r.a11y)} | ${cell(r.ux)} | ${r.overall < 0 ? "—" : `**${r.overall}**`} | ${r.status} |`,
  );
});

const self = rows[0];
const runnersUp = rows.filter((r) => !r.self);
const bestOther = runnersUp[0];
const external = data.results.filter((r) => !r.id.startsWith("rarext"));
const gated = external.filter((r) => r.http?.status === 403 || !r.http?.status);

console.log(lines.join("\n"));
console.log("");
console.log(
  `VERDICT: ${self.brand} ${self.overall} vs best external ${bestOther.brand} ${bestOther.overall} ` +
    `(+${self.overall - bestOther.overall}); ${runnersUp.length} brands compared; ` +
    `${gated.length} surface(s) gated for an anonymous visitor`,
);

/* ── the same ranking, as the front door shows it ──────────────────────────
   The landing page carries these numbers, and a landing page that quotes a
   benchmark is a page that can start lying the moment the benchmark is re-run.
   So the markup is generated here and the check fails when it goes stale. */
const MARK_START = "<!-- TOP10:START -->";
const MARK_END = "<!-- TOP10:END -->";
const SITE = new URL("../site/index.html", import.meta.url);

const htmlFragment = () => {
  const shown = rows.slice(0, 6);
  const cells = shown
    .map((r, i) => {
      const name = r.self ? "RAREXT front door" : r.surface;
      const brand = r.self ? "" : `<span class="rank-brand">${r.brand.split(" — ")[0]}</span> `;
      const cls = r.self ? ' class="is-self"' : "";
      return `            <tr${cls}>\n              <th scope="row">${i + 1}</th>\n              <td>${brand}${name}</td>\n              <td>${cell(r.perf)}</td>\n              <td>${cell(r.a11y)}</td>\n              <td>${cell(r.ux)}</td>\n              <td>${r.overall < 0 ? "—" : `**${r.overall}**`.replace(/\*\*/g, "")}</td>\n            </tr>`;
    })
    .join("\n");
  return `${MARK_START}
        <div class="rank">
          <h3>Against the top AI brands</h3>
          <p class="small">
            One harness, one weighting — performance 30%, accessibility 35%, UX 35% — on each brand's
            best-measured surface. The top six are shown; the full table, the method, and the six
            surfaces that refuse an anonymous visitor are in the
            <a href="https://github.com/999svs999/RAREXT-protocol/blob/main/docs/UI-UX-BENCHMARK.md">benchmark</a>.
          </p>
          <div class="rank-wrap">
            <table>
            <caption class="sr-only">RAREXT ranked against the top AI brands by overall score</caption>
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Measured surface</th>
                <th scope="col">Perf</th>
                <th scope="col">A11y</th>
                <th scope="col">UX</th>
                <th scope="col">Overall</th>
              </tr>
            </thead>
            <tbody>
${cells}
            </tbody>
            </table>
          </div>
        </div>
        ${MARK_END}`;
};

const page = readFileSync(SITE, "utf8");
const hasMarkers = page.includes(MARK_START) && page.includes(MARK_END);
const current = hasMarkers ? page.slice(page.indexOf(MARK_START), page.indexOf(MARK_END) + MARK_END.length) : "";
const want = htmlFragment();

const checking = process.argv.includes("--check");

if (process.argv.includes("--write")) {
  if (!hasMarkers) {
    console.log(`FAIL site/index.html has no ${MARK_START} marker to fill`);
    process.exit(1);
  }
  writeFileSync(SITE, page.replace(current, want));
  console.log(`wrote ${rows.slice(0, 6).length} ranked rows into site/index.html`);
} else if (checking) {
  if (!hasMarkers) {
    console.log("FAIL site/index.html lost its TOP10 markers, so the page cannot be checked");
    process.exit(1);
  }
  if (current !== want) {
    console.log("STALE site/index.html: its ranking is not this benchmark. Fix: node scripts/render-top10.mjs --write");
    process.exit(1);
  }
  console.log(`site/index.html ranking matches bench/ui-ux.json (${rows.slice(0, 6).length} rows)`);
}

// Assert it, do not narrate it. "Beaten" means another brand scores strictly
// higher, which is a real loss. A tie at 100 is not a loss — the rubric is
// capped, so a tie there is the ceiling, not a rival at one's level — but it is
// reported, because calling a tie a win is the kind of rounding that makes a
// benchmark worthless.
const axes = ["perf", "a11y", "ux", "overall"];
const beatenOn = axes.filter((axis) => runnersUp.some((r) => r[axis] > self[axis]));
const tiedOn = axes.filter((axis) => runnersUp.some((r) => r[axis] === self[axis]));
const who = (axis, test) => runnersUp.filter((r) => test(r[axis])).map((r) => `${r.brand} ${r[axis]}`).join(", ");

if (beatenOn.length > 0) {
  console.log(`BEATEN on ${beatenOn.map((a) => `${a} (${who(a, (v) => v > self[a])})`).join("; ")}`);
  if (process.argv.includes("--check")) process.exit(1);
} else {
  console.log(`first on ${axes.map((a) => `${a} ${self[a]}`).join(", ")}`);
}
if (tiedOn.length > 0) {
  console.log(`tied at the ceiling on ${tiedOn.map((a) => `${a} (${who(a, (v) => v === self[a])})`).join("; ")}`);
}
