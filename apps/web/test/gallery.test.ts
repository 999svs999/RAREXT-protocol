import assert from "node:assert/strict";
import test from "node:test";

import { start, stop } from "../../api/test/helpers.ts";

test("the gallery verifies embedded blobs and uses portable live paths", async () => {
  const { server, base } = await start();

  try {
    const page = await fetch(`${base}/gallery.html`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);

    const html = await page.text();
    assert.match(html, /blobs\.json/);
    assert.match(html, /crypto\.subtle\.digest\("SHA-256"/);
    assert.match(html, /fetch\("\.\/v1\/blobs"\)/);
    assert.match(html, /\.\/v1\/blobs\/\$\{encodeURIComponent\(hash\)\}\/raw/);
    assert.doesNotMatch(html, /innerHTML/);
  } finally {
    await stop(server);
  }
});
