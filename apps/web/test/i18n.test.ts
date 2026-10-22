import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { DICTIONARIES, LOCALES } from "../src/i18n.ts";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const indexHtml = readFileSync(`${webRoot}public/index.html`, "utf8");
const mainSource = readFileSync(`${webRoot}src/main.ts`, "utf8");

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

test("every locale ships the same set of keys", () => {
  const expected = Object.keys(DICTIONARIES.en).sort();

  for (const locale of LOCALES) {
    const actual = Object.keys(DICTIONARIES[locale]).sort();
    assert.deepEqual(actual, expected, `locale ${locale} has a different key set`);
  }
});

test("every translation is filled in", () => {
  for (const locale of LOCALES) {
    for (const [key, value] of Object.entries(DICTIONARIES[locale])) {
      assert.ok(value.trim().length > 0, `${locale}:${key} is empty`);
      assert.notEqual(value, key, `${locale}:${key} is untranslated`);
    }
  }
});

test("every locale keeps the same placeholders", () => {
  for (const key of Object.keys(DICTIONARIES.en)) {
    const expected = placeholders(DICTIONARIES.en[key] ?? "");

    for (const locale of LOCALES) {
      const actual = placeholders(DICTIONARIES[locale][key] ?? "");
      assert.deepEqual(actual, expected, `${locale}:${key} has different placeholders`);
    }
  }
});

test("markup translation hooks all resolve", () => {
  const hooks = [
    ...indexHtml.matchAll(/data-i18n(?:-aria|-title|-content|-placeholder)?="([^"]+)"/g),
  ].map((match) => match[1] ?? "");

  assert.ok(hooks.length > 0, "expected translation hooks in index.html");

  for (const key of hooks) {
    assert.ok(DICTIONARIES.en[key], `missing translation for ${key}`);
  }
});

test("code translation calls all resolve", () => {
  const calls = [...mainSource.matchAll(/\bt\(\s*"([^"]+)"/g)].map((match) => match[1] ?? "");

  assert.ok(calls.length > 0, "expected translation calls in main.ts");

  for (const key of calls) {
    assert.ok(DICTIONARIES.en[key], `missing translation for ${key}`);
  }
});
