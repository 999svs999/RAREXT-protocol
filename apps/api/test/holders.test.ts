import assert from "node:assert/strict";
import test from "node:test";

import { parseHolderSpec } from "../src/holders.ts";

test("holder specs are id=url pairs, trimmed", () => {
  assert.deepEqual(
    parseHolderSpec(" holder-0=http://127.0.0.1:9600 , h1=https://h1.example/path "),
    [
      { id: "holder-0", url: "http://127.0.0.1:9600" },
      { id: "h1", url: "https://h1.example/path" },
    ],
  );
  assert.deepEqual(parseHolderSpec(""), []);
});

test("a holder spec without a url, a scheme, or a unique id is refused", () => {
  assert.throws(() => parseHolderSpec("holder-0"), /id=url/);
  assert.throws(() => parseHolderSpec("holder-0=ftp://example"), /http/);
  assert.throws(() => parseHolderSpec("holder-0=http://a,holder-0=http://b"), /repeated/);
  assert.throws(() => parseHolderSpec("bad id=http://a"), /invalid/);
});
