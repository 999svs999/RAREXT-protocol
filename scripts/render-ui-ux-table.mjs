// Render the benchmark table for docs/UI-UX-BENCHMARK.md from the raw JSON.
// Run after `npm run bench:ui`; it prints Markdown, it does not rewrite the doc.
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("../bench/ui-ux.json", import.meta.url), "utf8"));
const rows = data.results;

const fmt = (n) => (n === null || n === undefined ? "—" : String(Math.round(n)));
const flag = (r) => {
  if (r.refused) return "refused";
  if (r.http?.status >= 400) return `HTTP ${r.http.status}`;
  return "loaded";
};

const lines = [];
lines.push("| App | Status | Perf | A11y | UX | Overall | TTFB | LCP | CLS | Bytes | Requests | 3rd-party hosts |");
lines.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const r of rows) {
  const m = r.desktop?.metrics ?? {};
  const s = r.score;
  lines.push(
    `| ${r.name} | ${flag(r)} | ${s ? s.perf : "—"} | ${s ? s.a11y : "—"} | ${s ? s.ux : "—"} | ${
      s ? `**${s.overall}**` : "—"
    } | ${fmt(m.ttfb)} ms | ${fmt(m.lcp)} ms | ${fmt(m.cls)} | ${fmt((m.transferBytes ?? 0) / 1024)} KB | ${fmt(
      m.resources,
    )} | ${fmt(m.thirdPartyHosts)} |`,
  );
}
console.log(lines.join("\n"));
