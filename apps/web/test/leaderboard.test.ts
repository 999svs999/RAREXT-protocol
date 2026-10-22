import test from "node:test";
import assert from "node:assert/strict";

import { start, stop } from "../../api/test/helpers.ts";

test("the leaderboard page is served and links to the live endpoints", async () => {
  const { server, base } = await start();

  try {
    const page = await fetch(`${base}/leaderboard.html`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);

    const html = await page.text();
    assert.match(html, /Leaderboard/);
    assert.match(html, /Capability-based discovery/);
    assert.match(html, /\/v1\/leaderboard/);
    assert.match(html, /\/v1\/publications\//);

    const home = await (await fetch(`${base}/`)).text();
    assert.match(home, /href="\/leaderboard\.html"/);
  } finally {
    await stop(server);
  }
});
