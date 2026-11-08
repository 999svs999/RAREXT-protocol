import { canonicalize } from "../../../packages/core/src/canonical.ts";
import { sha256Hex } from "./digest.ts";

/**
 * The engine behind an endpoint, as much of it as a run can be pinned to.
 * `digest` is the engine image/binary digest when the operator can report one;
 * null is honest ("not exposed") rather than a fabricated hash.
 */
export interface EngineDescriptor {
  name: string;
  version: string | null;
  digest?: string | null;
}

/**
 * A single value that names an engine exactly: name, version, and (when known)
 * the image digest, folded into one digest. Pinning it in a deployment is what
 * lets a replay say "this ran on the engine the run committed" instead of "this
 * ran on some engine" — and refuse when the engine has changed underneath.
 */
export function engineDescriptorFingerprint(engine: EngineDescriptor): string {
  return sha256Hex(
    canonicalize({
      name: engine.name,
      version: engine.version ?? null,
      digest: engine.digest ?? null,
    }),
  );
}
