import { MAX_BOUNDED_LENGTH, MAX_GENERATIVE_STEPS } from "../../core/src/index.ts";

/**
 * The SDK's input boundary for the self-publish paths.
 *
 * These helpers exist because the failure they prevent is worse than a refusal: a
 * signed record is a CLAIM, and a claim with a nonsense field in it — a negative
 * gate count, a fractional one, an output generated from a NaN seed — is a record
 * an honest reader has to disbelieve rather than one they can use. Refusing to
 * make it is the only useful answer.
 *
 * The caps are core's, not copied: `steps` above `MAX_GENERATIVE_STEPS` would ask
 * a caller to materialise an unbounded string from a model, which is a denial of
 * service wearing the shape of a parameter.
 */

export function requireFiniteSeed(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("seed must be a finite number");
  }
  return value;
}

export function requireSteps(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("steps must be a non-negative integer");
  }
  if (value > MAX_GENERATIVE_STEPS) {
    throw new Error(
      `steps must not exceed ${MAX_GENERATIVE_STEPS}: a larger run would materialise an unbounded output`,
    );
  }
  return value;
}

export function requireValues(value: number[]): number[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "number" && Number.isFinite(entry))) {
    throw new Error("values must be an array of finite numbers");
  }
  if (value.length > MAX_BOUNDED_LENGTH) {
    throw new Error(
      `values must not exceed ${MAX_BOUNDED_LENGTH} entries: a longer reconstruction is not one this protocol carries`,
    );
  }
  return value;
}
