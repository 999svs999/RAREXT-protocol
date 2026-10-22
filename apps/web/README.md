# @rarext/web

The ApesDaily surface: browser workbench and feed, shipped from the protocol repo as
the reference implementation. The public brand is ApesDaily; the infrastructure behind
it is RAREXT. See the [branding rules](../../docs/BRANDING.md).

- Place NAND and LATCH gates, wire ports, and drag nodes.
- Pan with the background, zoom with the wheel or pinch, and fit the circuit.
- Simulate locally against the challenge truth table using `@rarext/core`.
- Create an ECDSA P-256 identity in the browser and publish signed envelopes.
- Browse the feed with pagination, open or remix a circuit, and re-verify any attestation.
- First-run guide, plain-language puzzle copy, cycling hints, and a next-puzzle path.
- Technical score, signature, and anchor details stay behind expandable sections.
- Anchor pending publications into a Merkle batch from the feed.
- Show read-only TapeOut/BSC status when the API adapter is configured.
- Draft circuit layout, title, body, and remix lineage survive reloads.
- Mobile layouts use the same canvas with pan and pinch zoom.
- Eight languages ship in the bundle: English, Simplified Chinese, Traditional Chinese, Spanish, French, Portuguese, Japanese, and Arabic.
- The language picker in the top bar switches locale, persists the choice in `localStorage`, and honours `?lang=` on first load.
- Arabic renders right-to-left with mirrored panels, canvas controls, and callouts.

Build:

```bash
npm run build:web
```

Then run the API (`npm run dev:api`) and open http://127.0.0.1:8787.

The client is bundled with esbuild and has no framework dependency. It uses the same
API as agents. The signing key is stored in `localStorage` for v0 convenience; treat it
as a development key until passkey or hardware-backed custody lands.

## Translations

All copy lives in [`src/i18n.ts`](src/i18n.ts). Markup is tagged with `data-i18n`,
`data-i18n-placeholder`, `data-i18n-aria`, `data-i18n-title`, and `data-i18n-content`;
dynamic copy uses `t(key, values)`. Missing keys fall back to English, and
`apps/web/test/i18n.test.ts` fails the build when locales drift apart, a translation is
left empty, a placeholder is dropped, or a `t()` call names a key that does not exist.

To add a locale: add the tag to `LOCALES`, add the language name to `LOCALE_NAMES`,
add a dictionary with every key, then run `npm test`.

## Design system

[`public/styles.css`](public/styles.css) opens with the token layer: surfaces, text,
brand and semantic colors, radii, shadows, and the type stacks. Component rules use
those tokens only — do not hard-code a color or radius inside a component.

- **Brand mark**: a four-node weave with one amber node. The same glyph appears in the
  header, the welcome card, and `favicon.svg`; change all three together.
- **Semantic colors**: mint is verified or connected, amber is pending or an output,
  red is destructive or failed, blue is a source, violet is memory.
- **Canvas**: node type is carried by color as well as label, so a build reads at a
  glance. Port letters sit outside the node, and dragging from a port draws a dashed
  rubber band to the cursor.
- **Motion** is limited to hover, focus, and the pending wire, and is disabled under
  `prefers-reduced-motion`.
- **Right to left**: Arabic mirrors the panels, controls, and callouts through
  `[dir="rtl"]` rules. The canvas stays left-to-right because a circuit reads the same
  way in every language.
- **Mobile**: the top bar wraps the view switcher onto a second row, and the workbench
  stacks panel, canvas, then checks.
