/**
 * A byte-level grammar compiler for constrained decoding.
 *
 * `response_format` is not a request the model may ignore: the schema is
 * compiled to a DFA over bytes, and the engine only ever emits a token that
 * keeps the output a prefix of a string the DFA accepts. The DFA is built with
 * a Thompson NFA and subset construction, so recursion (arrays of arrays,
 * objects in arrays) is expressed directly and the result is a finite table.
 *
 * The table is plain numbers so it can be handed to the engine artifact through
 * the `node:vm` boundary unchanged: `table[state * 256 + byte]` is the next
 * state, or -1 for a dead byte; `accept[state]` is 1 at a completed document.
 */

export interface ByteDfa {
  states: number;
  /** One flag per state: 1 when a document may end here. */
  accept: number[];
  /** `states * 256` entries; -1 is dead. */
  table: number[];
}

interface Edge {
  to: number;
  /** 256-entry byte mask. */
  mask: Uint8Array;
}

interface Frag {
  start: number;
  end: number;
}

class Nfa {
  readonly edges = new Map<number, Edge[]>();
  private next = 0;

  state(): number {
    const id = this.next;
    this.next += 1;
    this.edges.set(id, []);
    return id;
  }

  edge(from: number, to: number, mask: Uint8Array): void {
    this.edges.get(from)!.push({ to, mask });
  }

  epsilon(from: number, to: number): void {
    const mask = new Uint8Array(256);
    this.edge(from, to, mask);
  }

  /** A fragment that matches exactly `text`. */
  literal(text: string): Frag {
    const bytes = new TextEncoder().encode(text);
    let at = this.state();
    const start = at;
    for (const byte of bytes) {
      const next = this.state();
      const mask = new Uint8Array(256);
      mask[byte] = 1;
      this.edge(at, next, mask);
      at = next;
    }
    return { start, end: at };
  }

  /** A fragment that matches one byte accepted by `allow`. */
  byte(predicate: (byte: number) => boolean): Frag {
    const start = this.state();
    const end = this.state();
    const mask = new Uint8Array(256);
    for (let byte = 0; byte < 256; byte += 1) if (predicate(byte)) mask[byte] = 1;
    this.edge(start, end, mask);
    return { start, end };
  }

  concat(parts: Frag[]): Frag {
    if (parts.length === 0) {
      const at = this.state();
      return { start: at, end: at };
    }
    for (let i = 1; i < parts.length; i += 1) this.epsilon(parts[i - 1]!.end, parts[i]!.start);
    return { start: parts[0]!.start, end: parts[parts.length - 1]!.end };
  }

  alternate(parts: Frag[]): Frag {
    const start = this.state();
    const end = this.state();
    for (const part of parts) {
      this.epsilon(start, part.start);
      this.epsilon(part.end, end);
    }
    return { start, end };
  }

  /** Zero or more repetitions of `frag` (a copy per repetition is not needed:
   *  Thompson's construction loops the same fragment). */
  star(frag: Frag): Frag {
    const start = this.state();
    const end = this.state();
    this.epsilon(start, frag.start);
    this.epsilon(start, end);
    this.epsilon(frag.end, frag.start);
    this.epsilon(frag.end, end);
    return { start, end };
  }

  optional(frag: Frag): Frag {
    const start = this.state();
    const end = this.state();
    this.epsilon(start, frag.start);
    this.epsilon(frag.start === frag.end ? start : frag.end, end);
    this.epsilon(start, end);
    return { start, end };
  }

  empty(): Frag {
    const at = this.state();
    return { start: at, end: at };
  }
}

/** Thompson NFA -> DFA by subset construction, flattened to a byte table. */
function compile(nfa: Nfa, start: number, accept: number): ByteDfa {
  const closure = (seed: number[]): number[] => {
    const seen = new Set<number>(seed);
    const stack = [...seed];
    while (stack.length > 0) {
      const state = stack.pop()!;
      for (const edge of nfa.edges.get(state) ?? []) {
        let epsilon = true;
        for (let byte = 0; byte < 256; byte += 1) {
          if (edge.mask[byte] === 1) {
            epsilon = false;
            break;
          }
        }
        if (epsilon && !seen.has(edge.to)) {
          seen.add(edge.to);
          stack.push(edge.to);
        }
      }
    }
    return [...seen].sort((a, b) => a - b);
  };

  const startSet = closure([start]);
  const key = (set: number[]): string => set.join(",");
  const ids = new Map<string, number>([[key(startSet), 0]]);
  const sets: number[][] = [startSet];
  const acceptFlag: number[] = [];
  const table: number[] = [];
  for (let index = 0; index < sets.length; index += 1) {
    const set = sets[index]!;
    acceptFlag.push(set.includes(accept) ? 1 : 0);
    for (let byte = 0; byte < 256; byte += 1) {
      const moved: number[] = [];
      for (const state of set) {
        for (const edge of nfa.edges.get(state) ?? []) {
          if (edge.mask[byte] === 1) moved.push(edge.to);
        }
      }
      if (moved.length === 0) {
        table.push(-1);
        continue;
      }
      const target = closure(moved);
      const id = key(target);
      let next = ids.get(id);
      if (next === undefined) {
        next = sets.length;
        ids.set(id, next);
        sets.push(target);
      }
      table.push(next);
    }
  }
  return { states: sets.length, accept: acceptFlag, table };
}

// ── grammars ────────────────────────────────────────────────────────────────

const isDigit = (byte: number): boolean => byte >= 0x30 && byte <= 0x39;
const isNonZeroDigit = (byte: number): boolean => byte >= 0x31 && byte <= 0x39;
const isStringByte = (byte: number): boolean => byte >= 0x20 && byte !== 0x22 && byte !== 0x5c;

/** `"..."`: no escapes, no control bytes — the shape a constrained decoder emits. */
function stringFrag(nfa: Nfa): Frag {
  const open = nfa.literal('"');
  const body = nfa.star(nfa.byte(isStringByte));
  const close = nfa.literal('"');
  return nfa.concat([open, body, close]);
}

/** JSON number, with optional sign, fraction, and exponent. */
function numberFrag(nfa: Nfa, integerOnly: boolean): Frag {
  const sign = nfa.optional(nfa.literal("-"));
  const zero = nfa.literal("0");
  const nonzero = nfa.concat([nfa.byte(isNonZeroDigit), nfa.star(nfa.byte(isDigit))]);
  const integer = nfa.alternate([zero, nonzero]);
  const parts: Frag[] = [sign, integer];
  if (!integerOnly) {
    const fraction = nfa.concat([nfa.literal("."), nfa.concat([nfa.byte(isDigit), nfa.star(nfa.byte(isDigit))])]);
    const exponent = nfa.concat([
      nfa.byte((byte) => byte === 0x65 || byte === 0x45),
      nfa.optional(nfa.byte((byte) => byte === 0x2b || byte === 0x2d)),
      nfa.concat([nfa.byte(isDigit), nfa.star(nfa.byte(isDigit))]),
    ]);
    parts.push(nfa.optional(fraction), nfa.optional(exponent));
  }
  return nfa.concat(parts);
}

function literalValue(nfa: Nfa, value: unknown): Frag {
  return nfa.literal(JSON.stringify(value));
}

interface SchemaNode {
  type?: string;
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
  enum?: unknown[];
  additionalProperties?: boolean;
}

/**
 * Compile a JSON Schema (the strict subset a constrained decode can honour) into
 * a DFA. Object properties are emitted in schema order; `required` decides which
 * may be omitted; `additionalProperties: false` is enforced by construction.
 * Unsupported keywords are refused rather than silently ignored.
 */
export function schemaDfa(schema: unknown): ByteDfa {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error("json_schema must be an object schema");
  }
  const nfa = new Nfa();
  const build = (node: unknown): Frag => {
    if (typeof node !== "object" || node === null) {
      throw new Error("json_schema entries must be objects");
    }
    const spec = node as SchemaNode;
    if (Array.isArray(spec.enum)) {
      if (spec.enum.length === 0) throw new Error("json_schema enum must not be empty");
      return nfa.alternate(spec.enum.map((value) => literalValue(nfa, value)));
    }
    switch (spec.type) {
      case "string":
        return stringFrag(nfa);
      case "integer":
        return numberFrag(nfa, true);
      case "number":
        return numberFrag(nfa, false);
      case "boolean":
        return nfa.alternate([nfa.literal("true"), nfa.literal("false")]);
      case "null":
        return nfa.literal("null");
      case "array": {
        const item = spec.items === undefined ? jsonValue() : build(spec.items);
        const open = nfa.literal("[");
        const rest = nfa.star(nfa.concat([nfa.literal(","), item]));
        const close = nfa.literal("]");
        // An empty array is valid, so the whole body is optional.
        return nfa.concat([open, nfa.optional(nfa.concat([item, rest])), close]);
      }
      case "object": {
        const properties = spec.properties ?? {};
        const required = new Set(spec.required ?? []);
        if (spec.additionalProperties !== false) {
          throw new Error("json_schema object needs additionalProperties: false to be constrained");
        }
        const names = Object.keys(properties);
        const optional = names.filter((name) => !required.has(name));
        if (optional.length > 10) {
          throw new Error("json_schema object has too many optional properties to constrain");
        }
        // The properties are emitted in schema order; an optional one is either
        // present or absent. Every required/allowable combination is one
        // alternative, so required properties cannot be skipped and a property
        // cannot repeat.
        const alternatives: Frag[] = [];
        for (let mask = 0; mask < 1 << optional.length; mask += 1) {
          const present = names.filter(
            (name) => required.has(name) || optional.indexOf(name) >= 0 && (mask & (1 << optional.indexOf(name))) !== 0,
          );
          const pieces: Frag[] = [];
          for (const name of present) {
            const key = nfa.literal(`${JSON.stringify(name)}:`);
            pieces.push(nfa.concat([key, build(properties[name])]));
          }
          const parts: Frag[] = [nfa.literal("{")];
          present.forEach((_, index) => {
            if (index > 0) parts.push(nfa.literal(","));
            parts.push(pieces[index]!);
          });
          parts.push(nfa.literal("}"));
          alternatives.push(nfa.concat(parts));
        }
        return nfa.alternate(alternatives);
      }
      default:
        throw new Error(`json_schema type "${String(spec.type)}" is not supported for constrained decoding`);
    }
  };

  // A generic JSON value, used for untyped array items and as the `json_object`
  // grammar. Recursion is expressed by sharing one value fragment.
  const jsonValue = ((): (() => Frag) => {
    let value: Frag | null = null;
    return () => {
      if (value !== null) return value;
      const start = nfa.state();
      const end = nfa.state();
      value = { start, end };
      const alternatives: Frag[] = [
        stringFrag(nfa),
        numberFrag(nfa, false),
        nfa.alternate([nfa.literal("true"), nfa.literal("false"), nfa.literal("null")]),
      ];
      // [ ( value ( , value )* )? ]
      alternatives.push(
        nfa.concat([
          nfa.literal("["),
          nfa.optional(
            nfa.concat([value, nfa.star(nfa.concat([nfa.literal(","), value]))]),
          ),
          nfa.literal("]"),
        ]),
      );
      // { ( "key" : value ( , "key" : value )* )? }
      const member = nfa.concat([nfa.literal('"'), nfa.star(nfa.byte(isStringByte)), nfa.literal('":'), value]);
      alternatives.push(
        nfa.concat([
          nfa.literal("{"),
          nfa.optional(
            nfa.concat([member, nfa.star(nfa.concat([nfa.literal(","), member]))]),
          ),
          nfa.literal("}"),
        ]),
      );
      for (const alternative of alternatives) {
        nfa.epsilon(start, alternative.start);
        nfa.epsilon(alternative.end, end);
      }
      return value;
    };
  })();

  const root = build(schema);
  return compile(nfa, root.start, root.end);
}

/** The grammar for `response_format: { type: "json_object" }`: any JSON value. */
export function jsonObjectDfa(): ByteDfa {
  // Reuse the schema compiler with a permissive top-level alternation: a value
  // is either an object or an array or a scalar, which `schemaDfa` cannot
  // express, so build it here directly.
  const nfa = new Nfa();
  let value: Frag | null = null;
  const jsonValue = (): Frag => {
    if (value !== null) return value;
    const start = nfa.state();
    const end = nfa.state();
    value = { start, end };
    const alternatives: Frag[] = [
      stringFrag(nfa),
      numberFrag(nfa, false),
      nfa.alternate([nfa.literal("true"), nfa.literal("false"), nfa.literal("null")]),
    ];
    const member = nfa.concat([nfa.literal('"'), nfa.star(nfa.byte(isStringByte)), nfa.literal('":'), jsonValue()]);
    alternatives.push(
      nfa.concat([
        nfa.literal("{"),
        nfa.optional(
          nfa.concat([member, nfa.star(nfa.concat([nfa.literal(","), member]))]),
        ),
        nfa.literal("}"),
      ]),
    );
    alternatives.push(
      nfa.concat([
        nfa.literal("["),
        nfa.optional(
          nfa.concat([jsonValue(), nfa.star(nfa.concat([nfa.literal(","), jsonValue()]))]),
        ),
        nfa.literal("]"),
      ]),
    );
    for (const alternative of alternatives) {
      nfa.epsilon(start, alternative.start);
      nfa.epsilon(alternative.end, end);
    }
    return value;
  };
  const root = jsonValue();
  return compile(nfa, root.start, root.end);
}

/** True when the DFA accepts exactly `text` (used by tests and callers). */
export function dfaAccepts(dfa: ByteDfa, text: string): boolean {
  let state = 0;
  for (const byte of new TextEncoder().encode(text)) {
    state = dfa.table[state * 256 + byte] ?? -1;
    if (state < 0) return false;
  }
  return dfa.accept[state] === 1;
}

/** True when every prefix of `text` stays inside the DFA (never a dead byte). */
export function dfaLivePrefix(dfa: ByteDfa, text: string): boolean {
  let state = 0;
  for (const byte of new TextEncoder().encode(text)) {
    state = dfa.table[state * 256 + byte] ?? -1;
    if (state < 0) return false;
  }
  return true;
}

/**
 * The DFA for a `response_format`. `json_object` accepts any JSON value; a
 * `json_schema` is compiled from its schema. `strict` is required for a schema
 * because a non-strict schema has no single constrained language.
 */
export function responseFormatDfa(format: unknown): ByteDfa | null {
  if (typeof format !== "object" || format === null) return null;
  const spec = format as { type?: unknown; json_schema?: unknown };
  if (spec.type === "json_object") return jsonObjectDfa();
  if (spec.type !== "json_schema") return null;
  if (typeof spec.json_schema !== "object" || spec.json_schema === null) {
    throw new Error("response_format json_schema must carry a json_schema object");
  }
  const inner = spec.json_schema as { schema?: unknown; strict?: unknown };
  if (inner.strict !== true) {
    throw new Error("response_format json_schema requires strict: true to be constrained");
  }
  if (inner.schema === undefined) {
    throw new Error("response_format json_schema must carry a schema");
  }
  return schemaDfa(inner.schema);
}
