import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

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
  bytesFor(id: string, hash: string, directory?: string): { module: VerifierModule; bytes: Buffer } | null;
}

interface LoadedModule {
  module: VerifierModule;
  directory: string;
}

function isText(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isSafeName(value: string): boolean {
  return SAFE_NAME.test(value) && basename(value) === value;
}

function isManifest(value: unknown): value is VerifierModule {
  if (typeof value !== "object" || value === null) return false;
  const manifest = value as Partial<VerifierModule>;

  return (
    isText(manifest.id, 128) &&
    isSafeName(manifest.id) &&
    isText(manifest.app, 128) &&
    isSafeName(manifest.app) &&
    isText(manifest.kind, 128) &&
    manifest.format === "es-module" &&
    isText(manifest.entry, 128) &&
    manifest.entry.endsWith(".mjs") &&
    isSafeName(manifest.entry) &&
    isText(manifest.abi, 128) &&
    typeof manifest.hash === "string" &&
    /^[0-9a-f]{64}$/.test(manifest.hash) &&
    typeof manifest.bytes === "number" &&
    Number.isSafeInteger(manifest.bytes) &&
    manifest.bytes >= 0 &&
    typeof manifest.description === "string"
  );
}

/**
 * The portable verifier catalogue.
 *
 * A module is served by its hash. The registry checks the bytes against the
 * hash before advertising or sending them, and the attestation names the hash,
 * so a browser that ran the module and a server that ran the same module
 * produce the same verdict — and a substituted module is caught.
 *
 * A manifest is admitted only when its declared entry is a basename, its
 * declared byte count and SHA-256 match the bytes on disk, and no other
 * manifest already claims the same app. Broken entries are omitted rather
 * than advertised with a hash the registry cannot honour.
 */
export class VerifierModuleRegistry {
  private readonly modules = new Map<string, LoadedModule>();
  private readonly root: string | null;

  constructor(directory: string) {
    this.root = existsSync(directory) ? directory : null;
    if (!this.root) return;

    for (const id of readdirSync(this.root)) {
      if (!isSafeName(id)) continue;

      const manifestPath = join(this.root, id, "manifest.json");
      if (!existsSync(manifestPath)) continue;

      let manifest: VerifierModule;
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
        if (!isManifest(parsed)) continue;
        manifest = parsed;
      } catch {
        continue;
      }

      const path = join(this.root, id, "dist", manifest.entry);
      if (!existsSync(path)) continue;

      let bytes: Buffer;
      try {
        bytes = readFileSync(path);
      } catch {
        continue;
      }

      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== manifest.hash || bytes.length !== manifest.bytes) continue;
      if (this.modules.has(manifest.app)) continue;

      this.modules.set(manifest.app, { module: manifest, directory: id });
    }
  }

  private readBytes(entry: LoadedModule, directory: string | null): Buffer | null {
    if (!directory) return null;

    const path = join(directory, entry.directory, "dist", entry.module.entry);
    if (!existsSync(path)) return null;

    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch {
      return null;
    }

    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.module.hash || bytes.length !== entry.module.bytes) return null;

    return bytes;
  }

  list(): VerifierModule[] {
    return [...this.modules.values()]
      .filter((entry) => this.readBytes(entry, this.root) !== null)
      .map((entry) => entry.module);
  }

  get(app: string): VerifierModule | null {
    const entry = this.modules.get(app);
    return entry && this.readBytes(entry, this.root) ? entry.module : null;
  }

  bytesFor(
    id: string,
    hash: string,
    directory: string | null = this.root,
  ): { module: VerifierModule; bytes: Buffer } | null {
    const entry = this.modules.get(id);
    if (!entry || entry.module.hash !== hash) return null;

    const bytes = this.readBytes(entry, directory);
    return bytes ? { module: entry.module, bytes } : null;
  }
}
