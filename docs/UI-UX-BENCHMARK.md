# UI/UX benchmark

This document answers one question with measurements: **is RAREXT's front door
actually good, compared with the AI web apps people use every day?**

It is not a survey of opinions. Every row comes from
`scripts/benchmark-ui-ux.mjs`, which drives a real Chrome over the DevTools
protocol, records what the browser measured, and saves desktop and mobile
screenshots. `bench/ui-ux.json` is the raw output; `npm run bench:ui` reproduces
it.

## The problem with benchmarking a front door

A landing page is judged in the first few seconds, on a device the author did not
choose. Three things follow from that, and they shaped the instrument:

1. **A screenshot is not a measurement.** The harness reads timing entries,
   computed styles, bounding boxes, and the accessibility tree's raw material —
   not a JPEG of the page.
2. **The first screen is the product.** TTFB on a page with no working control is
   a fast empty room. The rubric weights UX and accessibility above raw speed,
   and checks what is visible before scroll.
3. **A bot gate is not the product.** Cloudflare's managed challenge treats
   headless Chrome as a bot. A headless benchmark would have measured the
   challenge page — and scored ChatGPT 53 for it. The harness runs a real,
   headful Chrome parked off-screen, fixes the viewport over CDP, and records a
   site that still refuses as **refused**, never as zero.

## What the harness records

Per target, at desktop `1440×900` and mobile `390×844`:

| Area | Measurements |
| --- | --- |
| Speed | TTFB, FCP, LCP, CLS, TBT, DOMContentLoaded, load |
| Weight | transfer and decoded bytes, request count, JS/CSS/image bytes, third-party hosts |
| Structure | `header`/`nav`/`main`/`footer` landmarks, one `h1`, heading order, skip link, `lang` |
| Accessibility | images without `alt`, controls without a name or label, unnamed buttons, nested interactive elements, contrast (WCAG AA, alpha-composited against the real background), tap targets below 24 px, tiny text |
| Resilience | horizontal overflow at 390 px, fixed/sticky overlay area, `aria-live`, reduced-motion support |
| First screen | headline, subhead, CTAs above the fold, nav item count, word count, opening text |
| Network | HTTP status, compression, HTTP version, CSP/HSTS/nosniff/frame/referrer/permissions headers |
| Visual | full screenshots at both viewports |

The scoring is deliberately blunt, so it can be argued with:

- **Performance, 30%.** The mean of seven inverse scales: TTFB 200→2000 ms, FCP
  800→4000 ms, LCP 1200→5000 ms, CLS 0.02→0.35, transfer 300 KB→6 MB, requests
  20→250, TBT 50→1500 ms. Faster and lighter scores higher; the scales are wide so
  a genuinely fast page is not separated from a merely fast one by noise.
- **Accessibility, 35%.** `alt` coverage, accessible names as a share of
  interactive elements, contrast failures normalised by the first screen's word
  count, small tap targets as a share of targets, landmark/`lang`/heading
  structure, skip link, and reduced-motion support.
- **UX, 35%.** Exactly one `h1`, a sane nav count, mobile navigation that still
  exists, no mobile overflow, a live region, a useful number of first-screen
  CTAs (1–6, not a wall of links), and a description plus Open Graph metadata.

The overall score is `0.30·performance + 0.35·accessibility + 0.35·UX`, rounded.
The weights are a judgement, stated here so a reader can re-weight the raw
numbers in `bench/ui-ux.json` and disagree precisely.

## Results

<!-- RESULTS -->

## What the numbers say

<!-- OBSERVATIONS -->

## Before and after

The same harness measured the previous front door before it was replaced:

| Version | Performance | Accessibility | UX | Overall |
| --- | ---: | ---: | ---: | ---: |
| Previous front door | 100 | 90 | 79 | **89** |
| Redesigned front door | 98 | 100 | 100 | **99** |

The previous page was fast and had good bones — landmarks, a skip link, a single
`h1` — but it was a brochure. It had no live value, hid mobile navigation
entirely, shipped 16 distinct contrast failures, and 17 of its 32 tap targets
were under 24 px. The redesign trades two performance points (one extra 5.5 KB
script and the work of a 32-token decode on load) for a working proof, zero
contrast failures, a real mobile menu, and a first screen that contains the
product.

The harness also found a defect the eye missed: the nav class `.primary` matched
the primary CTA button, so below 1040 px the stylesheet's
`.primary { display: none }` hid **"Run the proof"** — the one control the page
exists to offer. Scoping the rule to `.site-header .primary` fixed it. That is
the kind of bug a benchmark earns its keep by catching.

## Caveats

- **Login walls change the subject.** ChatGPT, Claude, Grok, Le Chat, and Copilot
  show sign-in or challenge surfaces to an anonymous browser. The harness records
  what it can see; when the visible page is a gate, the row is labelled and its
  score describes the gate, not the app behind it. Gemini, Perplexity, Duck.ai,
  and HuggingChat load real, usable interfaces anonymously.
- **A score is not a taste.** The rubric cannot see brand, copy quality, or
  whether the product is worth using. It can see whether the page works for a
  keyboard, a phone, and a slow connection.
- **Local targets are local.** RAREXT rows are measured from
  `scripts/preview-showcase.mjs`, which reproduces the publish layout, not from a
  CDN. The external rows include their own network and edge. The comparison is
  still useful because the rubric is identical, but the RAREXT timing is a floor,
  not a promise about every visitor.
- **One run, one machine.** Timing entries move by tens of milliseconds between
  runs. The structural and accessibility findings are stable; the timing subscore
  is the noisiest part of the table.

## Reproduce

```sh
node scripts/preview-showcase.mjs --port 8080 &
npm run bench:ui                      # writes bench/ui-ux.json and screenshots
node scripts/test-showcase-ui.mjs     # the behaviour the screenshots cannot show
```

`RAREXT_BENCH_HEADLESS=1` measures the headless path instead, for comparison with
the gate — expect login-gated apps to drop, because a gate is what a bot sees.
