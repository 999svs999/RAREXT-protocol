import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  asChallenge,
  createChallengeRegistry,
  MAX_CONFIGURED_CHALLENGES,
  MAX_CONFIGURED_CHALLENGE_SOURCE_BYTES,
} from "../src/challenges.ts";

/**
 * The challenge validation boundary.
 *
 * A challenge's `spec` is what a verifier and a leaderboard read, so the rule is: the
 * boundary refuses by name anything the consumer would later refuse, and nothing that
 * reaches a verifier carries a spec the boundary did not check. These cases cover the
 * hostile inputs; where behaviour is deliberately permissive it is stated as such rather
 * than left implicit.
 */

const base = {
  id: "boundary-probe",
  app: "logic",
  title: "Probe",
  description: "A challenge used to probe the boundary.",
};

test("a challenge whose spec the bounded verifier would refuse is refused by name", () => {
  // The verifier checks its spec with core's isBoundedSpec; the boundary must not admit
  // a challenge that the verifier will refuse later — that turns a refused input into a
  // broken verification for whoever reads the registry in between.
  const bad = [
    { metric: "notAMetric", bound: 4, reference: [1, 2] },
    { metric: "maxAbsError", bound: Number.NaN, reference: [1, 2] },
    { metric: "maxAbsError", bound: -1, reference: [1, 2] },
    { metric: "maxAbsError", bound: 4, reference: [] },
    { metric: "maxAbsError", bound: 4, reference: [1, Number.POSITIVE_INFINITY] },
    { metric: "maxAbsError", bound: 4, reference: ["1", 2] },
    { metric: "maxAbsError", bound: "4", reference: [1, 2] },
  ];
  for (const spec of bad) {
    assert.throws(
      () => asChallenge({ ...base, app: "ai-bounded", spec }),
      /spec/i,
      `spec ${JSON.stringify(spec).slice(0, 60)} must be refused by name`,
    );
  }

  // …and a spec that IS valid passes, so the check refuses the right thing.
  const ok = asChallenge({
    ...base,
    app: "ai-bounded",
    spec: { metric: "maxAbsError", bound: 4, reference: [1, 2, 3] },
  });
  assert.deepEqual(ok.spec, { metric: "maxAbsError", bound: 4, reference: [1, 2, 3] });
});

test("a spec that is not an object is refused, for every app", () => {
  for (const spec of ["bound-4", 4, true, []] as unknown[]) {
    assert.throws(
      () => asChallenge({ ...base, spec }),
      /spec/i,
      `${JSON.stringify(spec)} must not be admitted as a spec`,
    );
  }
  // Absent is fine: a challenge may carry no spec at all.
  assert.equal(asChallenge({ ...base }).spec, undefined);
  // An app the protocol does not know still gets an object-or-nothing rule, not a pass-through.
  assert.deepEqual(asChallenge({ ...base, app: "some-other-app", spec: { anything: 1 } }).spec, {
    anything: 1,
  });
});

test("version and semanticsVersion must be positive integers, not NaN or fractions", () => {
  for (const bad of [Number.NaN, 0, -1, 1.5, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => asChallenge({ ...base, version: bad }),
      /version/i,
      `version ${bad} must be refused`,
    );
    assert.throws(
      () => asChallenge({ ...base, semanticsVersion: bad }),
      /semantics/i,
      `semanticsVersion ${bad} must be refused`,
    );
  }
  const ok = asChallenge({ ...base, version: 3, semanticsVersion: 2 });
  assert.equal(ok.version, 3);
  assert.equal(ok.semanticsVersion, 2);
  // Absent falls back to 1 rather than becoming undefined.
  assert.equal(asChallenge({ ...base }).version, 1);
});

test("a blank, padded or overlong id is refused — never silently normalized", () => {
  // Refusing beats trimming: a trimmed id is a challenge published under a name its author
  // did not write, and two readers would disagree about which name they were quoting.
  for (const bad of ["", "   ", "  padded  ", "x".repeat(201)]) {
    assert.throws(
      () => asChallenge({ ...base, id: bad }),
      /id/i,
      `id ${JSON.stringify(bad.slice(0, 12))} must be refused`,
    );
  }
  assert.equal(asChallenge({ ...base, id: "kept-as-written" }).id, "kept-as-written");
  assert.equal(asChallenge({ ...base, id: "x".repeat(200) }).id.length, 200, "the cap itself is allowed");
});

test("a prototype-polluting spec key cannot reach Object.prototype", () => {
  // The spec is parsed from JSON in production, so `__proto__` arrives as an own property
  // rather than a setter. Assert the real property: nothing is installed globally.
  const polluted = JSON.parse(
    '{"id":"probe","app":"ai-bounded","title":"t","description":"d","spec":{"metric":"maxAbsError","bound":4,"reference":[1],"__proto__":{"injected":true}}}',
  );
  asChallenge(polluted);
  assert.equal(({} as Record<string, unknown>).injected, undefined, "Object.prototype was polluted");
  assert.equal(Object.getPrototypeOf({}).injected, undefined);
});

test("status and sponsor stay closed enumerations", () => {
  assert.throws(() => asChallenge({ ...base, status: "bogus" }), /status/i);
  assert.throws(() => asChallenge({ ...base, sponsor: 42 }), /sponsor/i);
  assert.equal(asChallenge({ ...base, status: "sponsored", sponsor: "alice" }).status, "sponsored");
  assert.equal(asChallenge({ ...base }).sponsor, null);
});

test("an unparseable createdAt is refused rather than carried as a string", () => {
  for (const bad of ["not-a-date", "2026-13-45T99:99:99Z"]) {
    assert.throws(() => asChallenge({ ...base, createdAt: bad }), /createdAt/i, `${bad} must be refused`);
  }
  assert.equal(asChallenge({ ...base, createdAt: "2026-01-01T00:00:00.000Z" }).createdAt, "2026-01-01T00:00:00.000Z");
});

test("a configured challenge intentionally replaces a built-in with the same id — and says so", () => {
  // Documented behaviour, not an accident: seeds are registered first, configured
  // challenges last, so configuration wins. Asserting it keeps it deliberate.
  process.env.RAREXT_CHALLENGES = JSON.stringify([
    { id: "gen-starter", app: "ai-generative", title: "Replacement", description: "Configured replacement." },
  ]);
  try {
    const registry = createChallengeRegistry();
    const found = registry.get("gen-starter");
    assert.ok(found, "the id resolves");
    assert.equal(found!.title, "Replacement", "configuration wins over the built-in seed");
    assert.equal(registry.list().filter((c) => c.id === "gen-starter").length, 1, "and appears once");
  } finally {
    delete process.env.RAREXT_CHALLENGES;
  }
});

/**
 * The LOADER, one level out from `asChallenge`: `RAREXT_CHALLENGES` is an operator-supplied
 * string, so it is stranger input like any other. A refusal that does not name WHICH source
 * failed leaves an operator reading a raw JSON error with no idea which file or variable it
 * came from.
 */
const withSource = <T>(value: string | undefined, body: () => T): T => {
  const saved = process.env.RAREXT_CHALLENGES;
  if (value === undefined) delete process.env.RAREXT_CHALLENGES;
  else process.env.RAREXT_CHALLENGES = value;
  try {
    return body();
  } finally {
    if (saved === undefined) delete process.env.RAREXT_CHALLENGES;
    else process.env.RAREXT_CHALLENGES = saved;
  }
};

test("malformed JSON from the environment names the variable, not just a parser position", () => {
  assert.throws(
    () => withSource('[{"id":"a",}]', () => createChallengeRegistry()),
    (error: unknown) =>
      error instanceof Error &&
      /RAREXT_CHALLENGES/.test(error.message) &&
      !/^Unexpected|^SyntaxError/.test(error.message),
    "the refusal must name RAREXT_CHALLENGES, not surface a bare SyntaxError",
  );
});

test("malformed JSON in a FILE names the path", () => {
  const dir = mkdtempSync(join(tmpdir(), "rarext-challenges-"));
  const file = join(dir, "broken.json");
  writeFileSync(file, "[{\"id\":\"a\",}]");
  try {
    assert.throws(
      () => withSource(file, () => createChallengeRegistry()),
      (error: unknown) => error instanceof Error && error.message.includes(file),
      "the refusal must name the file it read",
    );
    // a path that does not exist already names itself; keep it that way
    assert.throws(
      () => withSource(join(dir, "missing.json"), () => createChallengeRegistry()),
      /file not found/,
    );
    // a DIRECTORY at that path is a refusal that NAMES the path — the underlying errno may
    // be quoted for diagnosis, but it must not be the whole message.
    assert.throws(
      () => withSource(dir, () => createChallengeRegistry()),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes(dir) &&
        !/^EISDIR|^EACCES/.test(error.message),
      "a directory must be refused with the path named, not as a bare errno",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the { challenges: [...] } wrapper is accepted, and a non-array is refused", () => {
  const wrapped = withSource(
    JSON.stringify({ challenges: [{ id: "wrapped", app: "logic", title: "T", description: "D" }] }),
    () => createChallengeRegistry(),
  );
  assert.ok(wrapped.get("wrapped"), "the wrapper shape registers its challenges");

  // A wrapper whose `challenges` is not an array hits the stated shape rule…
  assert.throws(
    () => withSource(JSON.stringify({ challenges: {} }), () => createChallengeRegistry()),
    /must be an array or \{ challenges: \[\] \}/,
  );
  // …while a bare JSON scalar is not JSON-shaped at all: it is read as a PATH, and refused
  // as one. Stated explicitly because it is a real consequence of the source syntax rule.
  for (const scalar of [JSON.stringify(42), JSON.stringify("nope")]) {
    assert.throws(
      () => withSource(scalar, () => createChallengeRegistry()),
      /file not found/,
      `${scalar} is treated as a path and refused as a missing file`,
    );
  }
});

test("a source larger than the cap is refused by name, and so is too many challenges", () => {
  // Both are memory bounds on operator input, checked by name so the operator knows which
  // limit they hit rather than watching the process grow.
  const huge = JSON.stringify([{ id: "big", app: "logic", title: "T", description: "x".repeat(MAX_CONFIGURED_CHALLENGE_SOURCE_BYTES) }]);
  assert.throws(
    () => withSource(huge, () => createChallengeRegistry()),
    /RAREXT_CHALLENGES/,
    "an oversized source must be refused",
  );

  const many = JSON.stringify(
    Array.from({ length: MAX_CONFIGURED_CHALLENGES + 1 }, (_, i) => ({
      id: `bulk-${i}`, app: "logic", title: "T", description: "D",
    })),
  );
  assert.throws(
    () => withSource(many, () => createChallengeRegistry()),
    new RegExp(String(MAX_CONFIGURED_CHALLENGES)),
    "more challenges than the cap must be refused by name",
  );
});

test("an empty or absent source is simply no configuration", () => {
  assert.equal(withSource(undefined, () => createChallengeRegistry()).get("gen-starter")?.id, "gen-starter");
  assert.equal(withSource("   ", () => createChallengeRegistry()).get("gen-starter")?.id, "gen-starter");
});
