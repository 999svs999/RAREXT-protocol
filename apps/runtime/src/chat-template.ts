/**
 * A safe interpreter for the `tokenizer.chat_template` a GGUF container carries.
 *
 * The template is UNTRUSTED bytes from a model file, so it is never compiled to
 * JavaScript and never `eval`'d: it is tokenized, parsed to an AST, and walked
 * with a fixed evaluator. Only the constructs a chat template uses are
 * supported — `{% for %}`, `{% if %}/{% elif %}/{% else %}`, `{% set %}`, `{{ }}`
 * expressions with member/index access, comparisons, `and`/`or`/`not`, `in`,
 * `is defined`, and a few filters (`tojson`, `trim`, `length`, `join`, `string`,
 * `default`). Anything else throws, and the caller falls back to the explicit
 * prompt, so an exotic template degrades rather than executing.
 */

export type TemplateScope = Record<string, unknown>;

type Expr =
  | { kind: "literal"; value: unknown }
  | { kind: "name"; name: string }
  | { kind: "member"; object: Expr; property: Expr; computed: boolean }
  | { kind: "call"; callee: Expr; args: Expr[]; named: Record<string, Expr> }
  | { kind: "unary"; op: string; value: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "list"; items: Expr[] }
  | { kind: "test"; value: Expr; name: string; negated: boolean };

type Node =
  | { kind: "text"; text: string }
  | { kind: "output"; expr: Expr }
  | { kind: "set"; name: string; attribute?: string; expr: Expr }
  | { kind: "macro"; name: string; params: Array<{ name: string; fallback: Expr | null }>; body: Node[] }
  | { kind: "callBlock"; callee: Expr; args: Expr[]; named: Record<string, Expr>; body: Node[] }
  | { kind: "if"; branches: Array<{ condition: Expr | null; body: Node[] }> }
  | { kind: "for"; name: string; iterable: Expr; condition: Expr | null; body: Node[]; elseBody: Node[] };

// ── lexer ───────────────────────────────────────────────────────────────────

type Chunk =
  | { kind: "text"; value: string }
  | { kind: "output"; value: string }
  | { kind: "statement"; value: string };

function lex(source: string): Chunk[] {
  const chunks: Chunk[] = [];
  let at = 0;
  while (at < source.length) {
    const open = source.indexOf("{{", at);
    const stmt = source.indexOf("{%", at);
    const comment = source.indexOf("{#", at);
    let next = -1;
    let kind: "text" | "output" | "statement" | "comment" = "text";
    for (const [index, which] of [
      [open, "output"],
      [stmt, "statement"],
      [comment, "comment"],
    ] as Array<[number, "output" | "statement" | "comment"]>) {
      if (index >= 0 && (next < 0 || index < next)) {
        next = index;
        kind = which;
      }
    }
    if (next < 0) {
      chunks.push({ kind: "text", value: source.slice(at) });
      break;
    }
    // Whitespace control: `{{-` / `{%-` strips the whitespace before it.
    const trimBefore = source[next + 2] === "-";
    let text = source.slice(at, next);
    if (trimBefore) text = text.replace(/\s+$/, "");
    if (text !== "") chunks.push({ kind: "text", value: text });

    const closeTag = kind === "output" ? "}}" : kind === "statement" ? "%}" : "#}";
    const close = source.indexOf(closeTag, next + 2);
    if (close < 0) throw new Error("unterminated template tag");
    const trimAfter = source[close - 1] === "-";
    const inner = source.slice(next + 2 + (trimBefore ? 1 : 0), close - (trimAfter ? 1 : 0)).trim();
    if (kind !== "comment") chunks.push({ kind, value: inner });
    at = close + 2;
    if (trimAfter) {
      const rest = source.slice(at);
      const trimmed = rest.replace(/^\s+/, "");
      at += rest.length - trimmed.length;
    }
  }
  return chunks;
}

// ── expression parser ───────────────────────────────────────────────────────

class ExprParser {
  private tokens: string[];
  private at = 0;

  constructor(source: string) {
    this.tokens = ExprParser.tokenize(source);
  }

  /** Split into identifiers, numbers, strings, and operators. */
  private static tokenize(source: string): string[] {
    const tokens: string[] = [];
    let at = 0;
    while (at < source.length) {
      const ch = source[at]!;
      if (/\s/.test(ch)) {
        at += 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let end = at + 1;
        let value = "";
        while (end < source.length && source[end] !== ch) {
          if (source[end] === "\\" && end + 1 < source.length) {
            value += source[end + 1];
            end += 2;
            continue;
          }
          value += source[end];
          end += 1;
        }
        if (end >= source.length) throw new Error("unterminated string in template expression");
        tokens.push(JSON.stringify(value));
        at = end + 1;
        continue;
      }
      const operator = ["==", "!=", ">=", "<=", "//", "|"].find((op) => source.startsWith(op, at));
      if (operator !== undefined) {
        tokens.push(operator);
        at += operator.length;
        continue;
      }
      if ("+-*/%<>=~()[]{}.,".includes(ch)) {
        tokens.push(ch);
        at += 1;
        continue;
      }
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at));
      if (match !== null) {
        tokens.push(match[0]);
        at += match[0].length;
        continue;
      }
      const number = /^\d+(\.\d+)?/.exec(source.slice(at));
      if (number !== null) {
        tokens.push(number[0]);
        at += number[0].length;
        continue;
      }
      throw new Error(`unexpected character ${JSON.stringify(ch)} in template expression`);
    }
    return tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.at];
  }

  private take(): string {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error("unexpected end of template expression");
    this.at += 1;
    return token;
  }

  private eat(token: string): boolean {
    if (this.peek() === token) {
      this.at += 1;
      return true;
    }
    return false;
  }

  parse(): Expr {
    const expr = this.parseOr();
    if (this.at < this.tokens.length) throw new Error(`unexpected ${JSON.stringify(this.peek())} in template expression`);
    return expr;
  }

  private parseOr(): Expr {
    let left = this.parseAnd();
    while (this.peek() === "or") {
      this.take();
      left = { kind: "binary", op: "or", left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Expr {
    let left = this.parseNot();
    while (this.peek() === "and") {
      this.take();
      left = { kind: "binary", op: "and", left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Expr {
    if (this.peek() === "not") {
      this.take();
      return { kind: "unary", op: "not", value: this.parseNot() };
    }
    return this.parseComparison();
  }

  private parseComparison(): Expr {
    const left = this.parseAdditive();
    for (;;) {
      const token = this.peek();
      if (token === "is") {
        this.take();
        const negated = this.eat("not");
        const name = this.take();
        return { kind: "test", value: left, name, negated };
      }
      if (token === "in" || token === "==" || token === "!=" || token === ">" || token === "<" || token === ">=" || token === "<=") {
        this.take();
        return { kind: "binary", op: token, left, right: this.parseAdditive() };
      }
      return left;
    }
  }

  private parseAdditive(): Expr {
    let left = this.parsePostfix();
    for (;;) {
      const token = this.peek();
      if (token === "+" || token === "-" || token === "*" || token === "/" || token === "%" || token === "//" || token === "~") {
        this.take();
        left = { kind: "binary", op: token, left, right: this.parsePostfix() };
        continue;
      }
      return left;
    }
  }

  private parsePostfix(): Expr {
    let value = this.parsePrimary();
    for (;;) {
      if (this.eat(".")) {
        value = { kind: "member", object: value, property: { kind: "name", name: this.take() }, computed: false };
        continue;
      }
      if (this.eat("[")) {
        const property = this.parseOr();
        if (!this.eat("]")) throw new Error("missing ] in template expression");
        value = { kind: "member", object: value, property, computed: true };
        continue;
      }
      if (this.eat("(")) {
        const call = this.parseArguments();
        value = { kind: "call", callee: value, args: call.args, named: call.named };
        continue;
      }
      if (this.eat("|")) {
        const name = this.take();
        // A filter's arguments are parenthesised: `x | join(",")`.
        const call = this.eat("(") ? this.parseArguments() : { args: [], named: {} };
        value = {
          kind: "call",
          callee: { kind: "name", name: `__filter_${name}` },
          args: [value, ...call.args],
          named: call.named,
        };
        continue;
      }
      return value;
    }
  }

  /** `(a, b=1, c)` -> positional args and keyword args. */
  private parseArguments(): { args: Expr[]; named: Record<string, Expr> } {
    const args: Expr[] = [];
    const named: Record<string, Expr> = {};
    if (this.eat(")")) return { args, named };
    for (;;) {
      const token = this.peek();
      const next = this.tokens[this.at + 1];
      if (token !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token) && next === "=") {
        this.take();
        this.take();
        named[token] = this.parseOr();
      } else {
        args.push(this.parseOr());
      }
      if (this.eat(",")) continue;
      if (this.eat(")")) return { args, named };
      throw new Error("missing ) in template call");
    }
  }

  private parsePrimary(): Expr {
    const token = this.peek();
    if (token === "(") {
      this.take();
      const inner = this.parseOr();
      if (!this.eat(")")) throw new Error("missing ) in template expression");
      return inner;
    }
    if (token === "[") {
      this.take();
      const items: Expr[] = [];
      if (!this.eat("]")) {
        do {
          items.push(this.parseOr());
        } while (this.eat(","));
        if (!this.eat("]")) throw new Error("missing ] in template list");
      }
      return { kind: "list", items };
    }
    if (token === undefined) throw new Error("unexpected end of template expression");
    this.take();
    if (token.startsWith('"')) return { kind: "literal", value: JSON.parse(token) as string };
    if (/^\d/.test(token)) return { kind: "literal", value: Number(token) };
    if (token === "true" || token === "True") return { kind: "literal", value: true };
    if (token === "false" || token === "False") return { kind: "literal", value: false };
    if (token === "none" || token === "None" || token === "null") return { kind: "literal", value: null };
    return { kind: "name", name: token };
  }
}

function parseExpression(source: string): Expr {
  return new ExprParser(source).parse();
}

// ── statement parser ────────────────────────────────────────────────────────

function parseNodes(chunks: Chunk[], start: number, stopWords: string[]): { nodes: Node[]; next: number; stop: string | null } {
  const nodes: Node[] = [];
  let at = start;
  while (at < chunks.length) {
    const chunk = chunks[at]!;
    if (chunk.kind === "text") {
      nodes.push({ kind: "text", text: chunk.value });
      at += 1;
      continue;
    }
    if (chunk.kind === "output") {
      nodes.push({ kind: "output", expr: parseExpression(chunk.value) });
      at += 1;
      continue;
    }
    const word = /^[A-Za-z_]+/.exec(chunk.value)?.[0] ?? "";
    if (stopWords.includes(word)) {
      return { nodes, next: at, stop: word };
    }
    if (word === "if") {
      const branches: Array<{ condition: Expr | null; body: Node[] }> = [];
      let condition: Expr | null = parseExpression(chunk.value.slice(2).trim());
      let cursor = at + 1;
      for (;;) {
        const parsed = parseNodes(chunks, cursor, ["elif", "else", "endif"]);
        branches.push({ condition, body: parsed.nodes });
        const stop = parsed.stop;
        const stopChunk = chunks[parsed.next]!;
        if (stop === "elif") {
          condition = parseExpression(stopChunk.value.slice(4).trim());
          cursor = parsed.next + 1;
          continue;
        }
        if (stop === "else") {
          const elseParsed = parseNodes(chunks, parsed.next + 1, ["endif"]);
          branches.push({ condition: null, body: elseParsed.nodes });
          at = elseParsed.next + 1;
          break;
        }
        if (stop === "endif") {
          at = parsed.next + 1;
          break;
        }
        throw new Error("unterminated {% if %} in template");
      }
      nodes.push({ kind: "if", branches });
      continue;
    }
    if (word === "for") {
      const match = /^for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(.*)$/.exec(chunk.value);
      if (match === null) throw new Error(`unsupported {% ${chunk.value} %}`);
      const name = match[1]!;
      let rest = match[2]!.trim();
      let condition: Expr | null = null;
      const ifAt = rest.indexOf(" if ");
      if (ifAt >= 0) {
        condition = parseExpression(rest.slice(ifAt + 4).trim());
        rest = rest.slice(0, ifAt).trim();
      }
      const iterable = parseExpression(rest);
      const body = parseNodes(chunks, at + 1, ["endfor", "else"]);
      let elseBody: Node[] = [];
      let cursor = body.next;
      if (body.stop === "else") {
        const elseParsed = parseNodes(chunks, body.next + 1, ["endfor"]);
        elseBody = elseParsed.nodes;
        cursor = elseParsed.next;
      }
      if (chunks[cursor] === undefined) throw new Error("unterminated {% for %} in template");
      nodes.push({ kind: "for", name, iterable, condition, body: body.nodes, elseBody });
      at = cursor + 1;
      continue;
    }
    if (word === "set") {
      const match = /^set\s+([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*=\s*(.*)$/.exec(chunk.value);
      if (match === null) throw new Error(`unsupported {% ${chunk.value} %}`);
      nodes.push({
        kind: "set",
        name: match[1]!,
        ...(match[2] === undefined ? {} : { attribute: match[2] }),
        expr: parseExpression(match[3]!),
      });
      at += 1;
      continue;
    }
    if (word === "call") {
      // `{% call macro(args) %}body{% endcall %}` — the body is passed to the
      // macro as `caller()`, Jinja's way to wrap a block in a macro.
      const callExpr = parseExpression(chunk.value.slice(4).trim());
      if (callExpr.kind !== "call") throw new Error(`unsupported {% ${chunk.value} %}`);
      const body = parseNodes(chunks, at + 1, ["endcall"]);
      if (chunks[body.next] === undefined) throw new Error("unterminated {% call %} in template");
      nodes.push({
        kind: "callBlock",
        callee: callExpr.callee,
        args: callExpr.args,
        named: callExpr.named,
        body: body.nodes,
      });
      at = body.next + 1;
      continue;
    }
    if (word === "macro") {
      const match = /^macro\s+([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*$/.exec(chunk.value);
      if (match === null) throw new Error(`unsupported {% ${chunk.value} %}`);
      const params = match[2]!.trim() === ""
        ? []
        : match[2]!.split(",").map((part) => {
            const pieces = part.split("=");
            const name = pieces[0]!.trim();
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`bad macro parameter ${name}`);
            return { name, fallback: pieces.length > 1 ? parseExpression(pieces.slice(1).join("=").trim()) : null };
          });
      const body = parseNodes(chunks, at + 1, ["endmacro"]);
      if (chunks[body.next] === undefined) throw new Error("unterminated {% macro %} in template");
      nodes.push({ kind: "macro", name: match[1]!, params, body: body.nodes });
      at = body.next + 1;
      continue;
    }
    throw new Error(`unsupported template statement {% ${chunk.value} %}`);
  }
  return { nodes, next: at, stop: null };
}

// ── evaluator ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (value === "" || value === 0) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function resolveName(name: string, scope: TemplateScope, filters: Record<string, (...args: unknown[]) => unknown>): unknown {
  // A pipe (`x | tojson`) is compiled to a call to `__filter_tojson`; resolve it
  // back to the filter table.
  if (name.startsWith("__filter_")) {
    const filterName = name.slice("__filter_".length);
    const filter = filters[filterName];
    // A pipe names a filter explicitly, so an unknown one is an error rather
    // than silently empty output.
    if (filter === undefined) throw new Error(`unsupported template filter ${JSON.stringify(filterName)}`);
    return filter;
  }
  if (Object.hasOwn(scope, name)) return scope[name];
  if (Object.hasOwn(filters, name)) return filters[name];
  if (name === "raise_exception") {
    return () => {
      throw new Error("the chat template raised an exception");
    };
  }
  if (name === "namespace") {
    return (...args: unknown[]) => ({ ...(isRecord(args[args.length - 1]) ? (args[args.length - 1] as Record<string, unknown>) : {}) });
  }
  if (name === "range") {
    return (...args: unknown[]) => {
      const count = Number(args[0] ?? 0);
      return Array.from({ length: Math.max(0, count) }, (_, index) => index);
    };
  }
  return undefined;
}

function evaluate(expr: Expr, scope: TemplateScope, filters: Record<string, (...args: unknown[]) => unknown>): unknown {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "name":
      return resolveName(expr.name, scope, filters);
    case "list":
      return expr.items.map((item) => evaluate(item, scope, filters));
    case "member": {
      const object = evaluate(expr.object, scope, filters);
      const property = expr.computed ? evaluate(expr.property, scope, filters) : (expr.property as { name: string }).name;
      if (Array.isArray(object) && typeof property === "number") return object[property];
      if (isRecord(object)) return object[String(property)];
      return undefined;
    }
    case "call": {
      const callee = evaluate(expr.callee, scope, filters);
      const positional = expr.args.map((arg) => evaluate(arg, scope, filters));
      const named: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(expr.named)) named[key] = evaluate(value, scope, filters);
      return invokeValue(callee, positional, named);
    }
    case "unary":
      return expr.op === "not" ? !truthy(evaluate(expr.value, scope, filters)) : undefined;
    case "test": {
      const value = evaluate(expr.value, scope, filters);
      const result = expr.name === "defined" ? value !== undefined : truthy(value);
      return expr.negated ? !result : result;
    }
    case "binary": {
      const op = expr.op;
      if (op === "and") return truthy(evaluate(expr.left, scope, filters)) ? evaluate(expr.right, scope, filters) : false;
      if (op === "or") {
        const left = evaluate(expr.left, scope, filters);
        return truthy(left) ? left : evaluate(expr.right, scope, filters);
      }
      const left = evaluate(expr.left, scope, filters);
      const right = evaluate(expr.right, scope, filters);
      switch (op) {
        case "==":
          return left === right;
        case "!=":
          return left !== right;
        case ">":
          return Number(left) > Number(right);
        case "<":
          return Number(left) < Number(right);
        case ">=":
          return Number(left) >= Number(right);
        case "<=":
          return Number(left) <= Number(right);
        case "in":
          return Array.isArray(right) ? right.includes(left) : isRecord(right) ? Object.hasOwn(right, String(left)) : false;
        case "~":
          return stringify(left) + stringify(right);
        case "+":
          // Jinja concatenates lists and strings with `+`, and adds numbers.
          if (Array.isArray(left) || Array.isArray(right)) {
            return [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])];
          }
          if (typeof left === "string" || typeof right === "string") return stringify(left) + stringify(right);
          return Number(left) + Number(right);
        case "-":
          return Number(left) - Number(right);
        case "*":
          return Number(left) * Number(right);
        case "/":
          return Number(left) / Number(right);
        case "%":
          return Number(left) % Number(right);
        case "//":
          return Math.floor(Number(left) / Number(right));
        default:
          return undefined;
      }
    }
  }
}

/** Call a macro object or a function with positional and keyword arguments. */
function invokeValue(callee: unknown, positional: unknown[], named: Record<string, unknown>): unknown {
  if (isRecord(callee) && callee.__rarextMacro === true) {
    return (callee.invoke as (args: unknown[], kwargs: Record<string, unknown>) => unknown)(positional, named);
  }
  if (typeof callee !== "function") return undefined;
  // Keywords reach a function as a trailing object, which is how the filters
  // that take them (`map(attribute=…)`, `default(…)`) read them.
  return (callee as (...args: unknown[]) => unknown)(...positional, named);
}

function renderNodes(nodes: Node[], scope: TemplateScope, filters: Record<string, (...args: unknown[]) => unknown>): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") {
      out += node.text;
    } else if (node.kind === "output") {
      out += stringify(evaluate(node.expr, scope, filters));
    } else if (node.kind === "set") {
      const value = evaluate(node.expr, scope, filters);
      if (node.attribute === undefined) {
        scope[node.name] = value;
      } else {
        // `{% set ns.x = … %}` mutates the namespace object, which is how a
        // template accumulates across loop iterations (Jinja's pattern).
        const target = scope[node.name];
        if (isRecord(target)) target[node.attribute] = value;
        else scope[node.name] = { [node.attribute]: value };
      }
    } else if (node.kind === "callBlock") {
      const callee = evaluate(node.callee, scope, filters);
      const positional = node.args.map((arg) => evaluate(arg, scope, filters));
      const named: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.named)) named[key] = evaluate(value, scope, filters);
      // `caller()` renders the block; kwargs become variables inside it.
      named.caller = {
        __rarextMacro: true,
        invoke: (_args: unknown[], kwargs: Record<string, unknown>) =>
          renderNodes(node.body, { ...scope, ...kwargs }, filters),
      };
      out += stringify(invokeValue(callee, positional, named));
    } else if (node.kind === "macro") {
      const definitionScope = scope;
      const invoke = (positional: unknown[], named: Record<string, unknown>): string => {
        const local: TemplateScope = { ...definitionScope };
        node.params.forEach((param, index) => {
          if (Object.hasOwn(named, param.name)) local[param.name] = named[param.name];
          else if (index < positional.length) local[param.name] = positional[index];
          else local[param.name] = param.fallback === null ? undefined : evaluate(param.fallback, definitionScope, filters);
        });
        // A `{% call %}` block arrives as `caller`, which the macro renders.
        if (Object.hasOwn(named, "caller")) local.caller = named.caller;
        return renderNodes(node.body, local, filters);
      };
      scope[node.name] = { __rarextMacro: true, invoke, name: node.name };
    } else if (node.kind === "if") {
      for (const branch of node.branches) {
        if (branch.condition === null || truthy(evaluate(branch.condition, scope, filters))) {
          out += renderNodes(branch.body, scope, filters);
          break;
        }
      }
    } else if (node.kind === "for") {
      const iterable = evaluate(node.iterable, scope, filters);
      const items = Array.isArray(iterable) ? iterable : [];
      let rendered = false;
      for (let index = 0; index < items.length; index += 1) {
        const child: TemplateScope = { ...scope, [node.name]: items[index] };
        if (node.condition !== null) {
          scope[node.name] = items[index];
          const keep = truthy(evaluate(node.condition, { ...child, loop: { index0: index, index: index + 1, first: index === 0, last: index === items.length - 1, length: items.length } }, filters));
          if (!keep) continue;
        }
        child.loop = { index0: index, index: index + 1, first: index === 0, last: index === items.length - 1, length: items.length };
        out += renderNodes(node.body, child, filters);
        rendered = true;
      }
      if (!rendered && items.length === 0) out += renderNodes(node.elseBody, scope, filters);
    }
  }
  return out;
}

/** The keyword arguments a call passed, if any (always the last argument). */
function keywords(args: unknown[]): Record<string, unknown> {
  const last = args[args.length - 1];
  return isRecord(last) ? last : {};
}

/** Read `a.b.c` out of an item, for `map(attribute=…)` / `selectattr`. */
function pick(item: unknown, attribute: unknown): unknown {
  if (typeof attribute !== "string" || attribute === "") return item;
  let value: unknown = item;
  for (const part of attribute.split(".")) {
    if (Array.isArray(value)) value = value[Number(part)];
    else if (isRecord(value)) value = value[part];
    else return undefined;
  }
  return value;
}

/** The Jinja tests a template uses in `selectattr`/`select`. */
function test(name: unknown, value: unknown, args: unknown[]): boolean {
  switch (name) {
    case "equalto":
    case "eq":
      return value === args[0];
    case "ne":
      return value !== args[0];
    case "in":
      return Array.isArray(args[0]) ? (args[0] as unknown[]).includes(value) : false;
    case "defined":
      return value !== undefined;
    case "undefined":
      return value === undefined;
    case "none":
      return value === null || value === undefined;
    case "true":
      return value === true;
    case "false":
      return value === false;
    default:
      throw new Error(`unsupported template test ${JSON.stringify(String(name))}`);
  }
}

const FILTERS: Record<string, (...args: unknown[]) => unknown> = {
  tojson: (value, ...rest) => {
    const indent = keywords(rest).indent;
    return typeof indent === "number" ? JSON.stringify(value ?? null) : JSON.stringify(value ?? null);
  },
  trim: (value) => stringify(value).trim(),
  length: (value) => (Array.isArray(value) ? value.length : isRecord(value) ? Object.keys(value).length : stringify(value).length),
  join: (value, separator) => (Array.isArray(value) ? value.map(stringify).join(typeof separator === "string" ? separator : ", ") : stringify(value)),
  string: (value) => stringify(value),
  upper: (value) => stringify(value).toUpperCase(),
  lower: (value) => stringify(value).toLowerCase(),
  replace: (value, from, to) => stringify(value).split(stringify(from)).join(stringify(to)),
  safe: (value) => value,
  list: (value) => (Array.isArray(value) ? [...value] : isRecord(value) ? Object.keys(value) : value === undefined || value === null ? [] : [value]),
  keys: (value) => (isRecord(value) ? Object.keys(value) : []),
  values: (value) => (isRecord(value) ? Object.values(value) : []),
  items: (value) => (isRecord(value) ? Object.entries(value) : []),
  first: (value) => (Array.isArray(value) ? value[0] : undefined),
  last: (value) => (Array.isArray(value) ? value[value.length - 1] : undefined),
  count: (value) => (Array.isArray(value) ? value.length : isRecord(value) ? Object.keys(value).length : 0),
  reverse: (value) => (Array.isArray(value) ? [...value].reverse() : stringify(value).split("").reverse().join("")),
  sort: (value, ...rest) => {
    const attribute = keywords(rest).attribute;
    const reverse = keywords(rest).reverse === true;
    const items = Array.isArray(value) ? [...value] : [];
    items.sort((a, b) => {
      const left = pick(a, attribute);
      const right = pick(b, attribute);
      if (left === right) return 0;
      return (left as number | string) < (right as number | string) ? -1 : 1;
    });
    return reverse ? items.reverse() : items;
  },
  unique: (value) => {
    const items = Array.isArray(value) ? value : [];
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = typeof item === "object" ? JSON.stringify(item) : String(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
  map: (value, ...rest) => {
    const attribute = keywords(rest).attribute;
    const items = Array.isArray(value) ? value : [];
    if (attribute === undefined) return items;
    return items.map((item) => pick(item, attribute));
  },
  select: (value, name, ...rest) => filterBy(value, name, rest, false),
  reject: (value, name, ...rest) => filterBy(value, name, rest, true),
  selectattr: (value, attribute, name, ...rest) => filterByAttribute(value, attribute, name, rest, false),
  rejectattr: (value, attribute, name, ...rest) => filterByAttribute(value, attribute, name, rest, true),
  default: (value, fallback, ...rest) => {
    const boolean = keywords(rest).boolean === true;
    if (value === undefined || value === null) return fallback;
    if (boolean && !value) return fallback;
    return value;
  },
};

function filterBy(value: unknown, name: unknown, args: unknown[], negate: boolean): unknown[] {
  const last = args[args.length - 1];
  const positional = isRecord(last) ? args.slice(0, -1) : args;
  return (Array.isArray(value) ? value : []).filter((item) => test(name, item, positional) !== negate);
}

function filterByAttribute(value: unknown, attribute: unknown, name: unknown, args: unknown[], negate: boolean): unknown[] {
  const last = args[args.length - 1];
  const positional = isRecord(last) ? args.slice(0, -1) : args;
  return (Array.isArray(value) ? value : []).filter(
    (item) => test(name, pick(item, attribute), positional) !== negate,
  );
}

/** Render a chat template with a scope, or throw when it uses unsupported syntax. */
export function renderChatTemplate(template: string, scope: TemplateScope): string {
  const chunks = lex(template);
  const parsed = parseNodes(chunks, 0, []);
  if (parsed.next < chunks.length) throw new Error("unexpected trailing template statement");
  return renderNodes(parsed.nodes, { ...scope }, FILTERS);
}

/** The message shape a chat template reads: `role`, `content`, and tool fields. */
export interface TemplateMessage {
  role: string;
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

/** What the engine reports about a container's chat template. */
export interface ChatTemplateInfo {
  template: string;
  bos: string | null;
  eos: string | null;
  addBos: boolean;
}

/**
 * Build the prompt a model's own template produces for an OpenAI-shaped request.
 * The tool list is passed in the `{ type: "function", function: { … } }` shape
 * llama.cpp templates read, and `add_generation_prompt` is set so the template
 * appends its assistant prefix.
 */
export function chatPromptFromTemplate(
  info: ChatTemplateInfo,
  messages: unknown,
  tools: unknown,
  options: { addGenerationPrompt?: boolean } = {},
): string {
  const normalised: TemplateMessage[] = (Array.isArray(messages) ? messages : [])
    .filter(isRecord)
    .map((message) => {
      let content = typeof message.content === "string" ? message.content : "";
      if (Array.isArray(message.content)) {
        content = message.content
          .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
          .filter((text) => text !== "")
          .join("\n");
      }
      return {
        role: typeof message.role === "string" ? message.role : "user",
        content,
        ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls }),
        ...(typeof message.tool_call_id === "string" ? { tool_call_id: message.tool_call_id } : {}),
        ...(typeof message.name === "string" ? { name: message.name } : {}),
      };
    });
  const toolList = Array.isArray(tools) ? tools : [];
  return renderChatTemplate(info.template, {
    messages: normalised,
    tools: toolList,
    add_generation_prompt: options.addGenerationPrompt ?? true,
    bos_token: info.bos ?? "",
    eos_token: info.eos ?? "",
    add_bos_token: info.addBos,
  });
}
