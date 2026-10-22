import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface VerifierModule {
  id: string;
  app: string;
  kind: string;
  format: string;
  entry: string;
  abi: string;
  hash: string;
  bytes: number;
  description: string;
}

export interface VerifierModuleCatalogue {
  list(): VerifierModule[];
  get(app: string): VerifierModule | null;
  /** The exact bytes for a module, or null when the hash does not match. */
  bytesFor(id: string, hash: string): { module: VerifierModule; bytes: Buffer } | null;
}

/**
 * The portable verifier catalogue.
 *
 * A module is served by its hash. The registry checks the bytes against the
 * hash before sending them, and the attestation names the hash, so a browser
 * that ran the module and a server that ran the same module produce the same
 * verdict — and a substituted module is caught.
 */
export class VerifierModuleRegistry {
  private readonly modules = new Map<string, VerifierModule>();

  constructor(directory: string) {
    if (!existsSync(directory)) return;

    for (const id of readdirSync(directory)) {
      const manifestPath = join(directory, id, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as VerifierModule;
        if (!manifest.id || !manifest.hash) continue;
        this.modules.set(manifest.app, manifest);
      } catch {
        continue;
      }
    }
  }

  list(): VerifierModule[] {
    return [...this.modules.values()];
  }

  get(app: string): VerifierModule | null {
    return this.modules.get(app) ?? null;
  }

  bytesFor(
    id: string,
    hash: string,
    directory: string,
  ): { module: VerifierModule; bytes: Buffer } | null {
    const module = this.modules.get(id);
    if (!module) return null;
    if (module.hash !== hash) return null;

    const path = join(directory, id, "dist", module.entry);
    if (!existsSync(path)) return null;

    const bytes = readFileSync(path);
    const actual = createHash("sha256").update(bytes).digest("hex");

    if (actual !== hash) return null;

    return { module, bytes };
  }
}
