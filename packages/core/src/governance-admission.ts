/**
 * A registry admission: the document a join request carries, and the rule it must satisfy.
 *
 * The federation's seed list has grown, until now, only by the registry operator's hand —
 * a maintainer editing `seed.json` and republishing. That is a list nobody new can join,
 * which is not a federation but a guest list. The 民主 rail already decides how money moves
 * (proposals, votes, budgets, execution); an admission is the same decision with a
 * different effect: instead of paying credits, executing the decision ADDS a registry to
 * the list the node serves. The document says WHAT is being admitted, in the seed's own
 * entry shape, so an admission and the list it joins cannot disagree about fields.
 *
 * The document proposes. The decision — the proposal's tally, under the window and
 * quorum the proposal itself declared — is the only thing that applies it, and that
 * happens in the API's execute route, which refuses a tie, a missed quorum, and a
 * second application of the same decision. The admission never certifies reachability:
 * an entry in a federation list is a statement the community made, and clients verify
 * copies against roots as always.
 */

export const GOVERNANCE_ADMISSION_KIND = "rarext.registry-admission.v1";

export interface RegistryAdmission {
  kind: typeof GOVERNANCE_ADMISSION_KIND;
  /** The registry, in the seed list's own entry shape — an admission cannot invent fields. */
  registry: {
    id: string;
    url: string;
    operator: string;
    chains: string[];
    note?: string;
  };
  /** When the request was made. */
  issuedAt: string;
  /**
   * The proposal choice whose win APPLIES this admission — the same shape the budget's
   * `payOn` uses, because both are the bridge from a decision to its effect, and the two
   * bridges should read the same way.
   */
  payOn: string;
}

const HEXISH_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The structural rule. A URL that does not parse, an id that is not a seed-shaped id,
 * a chains field that is not a non-empty list of strings: each is refused by name,
 * because a document written against a different convention must fail here rather
 * than join a federation it does not match.
 */
export function admissionProblems(admission: unknown): string[] {
  const problems: string[] = [];
  const document = admission as Partial<RegistryAdmission> | null;
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return ["an admission must be a JSON object"];
  }
  if (document.kind !== GOVERNANCE_ADMISSION_KIND) {
    problems.push(`an admission must be a ${GOVERNANCE_ADMISSION_KIND} payload`);
  }
  const registry = document.registry as Partial<RegistryAdmission["registry"]> | undefined;
  if (typeof registry !== "object" || registry === null || Array.isArray(registry)) {
    problems.push("an admission's registry must be a JSON object");
    return problems;
  }
  if (typeof registry.id !== "string" || !HEXISH_ID.test(registry.id)) {
    problems.push(`an admission's registry id must match ${HEXISH_ID.source}`);
  }
  if (typeof registry.url !== "string" || registry.url.length === 0) {
    problems.push("an admission's registry url must be a non-empty string");
  } else {
    try {
      const parsed = new URL(registry.url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        problems.push(`an admission's registry url must be http(s), not ${parsed.protocol}`);
      }
    } catch {
      problems.push(`an admission's registry url does not parse: ${registry.url.slice(0, 80)}`);
    }
  }
  if (typeof registry.operator !== "string" || registry.operator.length === 0) {
    problems.push("an admission's registry operator must be a non-empty string");
  }
  if (!Array.isArray(registry.chains) || registry.chains.length === 0 || registry.chains.some((chain) => typeof chain !== "string")) {
    problems.push("an admission's registry chains must be a non-empty array of strings");
  }
  if (registry.note !== undefined && typeof registry.note !== "string") {
    problems.push("an admission's registry note, when present, must be a string");
  }
  if (typeof document.issuedAt !== "string" || Number.isNaN(Date.parse(document.issuedAt))) {
    problems.push("an admission's issuedAt must be a parseable timestamp");
  }
  if (typeof document.payOn !== "string" || document.payOn.length === 0) {
    problems.push("an admission's payOn must name the choice that applies it");
  }
  return problems;
}

/**
 * The seed-shaped entry the admission proposes — exactly what
 * `parseRegistrySeedList` reads, so an admitted registry and a hand-written one
 * are the same shape to every client.
 */
export function admissionEntry(admission: RegistryAdmission): {
  id: string;
  url: string;
  operator: string;
  chains: string[];
  note: string | null;
} {
  return {
    id: admission.registry.id,
    url: admission.registry.url,
    operator: admission.registry.operator,
    chains: [...admission.registry.chains],
    note: admission.registry.note ?? null,
  };
}
