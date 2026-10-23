import test from "node:test";
import assert from "node:assert/strict";

import { start, stop } from "../../api/test/helpers.ts";

test("the home page serves the read-only $BEM balance hooks", async () => {
  const { server, base } = await start();

  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);

    const html = await page.text();
    assert.match(html, /id="bem-address"/);
    assert.match(html, /id="bem-check"/);
    assert.match(html, /id="bem-balance"/);
    assert.match(html, /data-i18n="bem\.hint"/);
  } finally {
    await stop(server);
  }
});
