import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

/**
 * A backup of a registry data directory.
 *
 * The store, the placement registry, and the operator registry are files on disk.
 * Backing up only the store would restore publications while losing the map that
 * says where their bytes live, or losing the keys that may accept attestations.
 * This bundles every regular file under a data directory, with a digest per file
 * and one over the manifest, so a restore can refuse a silently truncated copy.
 */

export const BACKUP_KIND = "rarext.backup";
export const BACKUP_VERSION = 1;

export interface BackupFile {
  /** Path relative to the backed-up data directory, using `/` separators. */
  path: string;
  sha256: string;
  size: number;
  /** Base64 of the file bytes. */
  content: string;
}

export interface BackupBundle {
  kind: typeof BACKUP_KIND;
  version: number;
  createdAt: string;
  label: string | null;
  files: BackupFile[];
  /** SHA-256 over the canonical manifest (paths, hashes, sizes). */
  digest: string;
}

export interface BackupOptions {
  label?: string;
  now?: () => Date;
  /** Skip these relative paths or directory prefixes. */
  exclude?: string[];
}

export interface BackupVerification {
  valid: boolean;
  errors: string[];
  files: number;
  bytes: number;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalize(relativePath: string): string {
  return relativePath.split(sep).join("/");
}

function sortedFiles(files: BackupFile[]): BackupFile[] {
  return [...files].sort((left, right) => left.path.localeCompare(right.path));
}

export function backupDigest(bundle: Omit<BackupBundle, "digest"> | BackupBundle): string {
  const manifest = {
    kind: bundle.kind,
    version: bundle.version,
    createdAt: bundle.createdAt,
    label: bundle.label,
    files: sortedFiles(bundle.files).map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size: file.size,
    })),
  };

  return sha256(JSON.stringify(manifest));
}

function collect(
  root: string,
  current: string,
  files: BackupFile[],
  exclude: string[],
): void {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    const path = normalize(relative(root, full));

    if (exclude.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      continue;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      collect(root, full, files, exclude);
      continue;
    }

    if (!entry.isFile() || entry.name.endsWith(".tmp")) {
      continue;
    }

    const bytes = readFileSync(full);

    files.push({
      path,
      sha256: sha256(bytes),
      size: bytes.length,
      content: bytes.toString("base64"),
    });
  }
}

export function createBackup(root: string, options: BackupOptions = {}): BackupBundle {
  const directory = resolve(root);

  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new Error(`backup source is not a directory: ${root}`);
  }

  const files: BackupFile[] = [];

  collect(directory, directory, files, options.exclude ?? []);
  files.sort((left, right) => left.path.localeCompare(right.path));

  const bundle: Omit<BackupBundle, "digest"> = {
    kind: BACKUP_KIND,
    version: BACKUP_VERSION,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    label: options.label ?? null,
    files,
  };

  return { ...bundle, digest: backupDigest(bundle) };
}

function safeRelative(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0) return false;
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes("\\")) return false;

  const parts = path.split("/");

  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

export function verifyBackup(value: unknown): BackupVerification {
  const errors: string[] = [];
  const empty = { valid: false, errors, files: 0, bytes: 0 };

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    errors.push("backup must be a JSON object");
    return empty;
  }

  const bundle = value as Partial<BackupBundle>;

  if (bundle.kind !== BACKUP_KIND) errors.push("backup.kind is not rarext.backup");
  if (!Number.isInteger(bundle.version) || bundle.version !== BACKUP_VERSION) {
    errors.push(`backup.version must be ${BACKUP_VERSION}`);
  }
  if (typeof bundle.createdAt !== "string" || Number.isNaN(Date.parse(bundle.createdAt))) {
    errors.push("backup.createdAt must be an ISO timestamp");
  }
  if (bundle.label !== null && bundle.label !== undefined && typeof bundle.label !== "string") {
    errors.push("backup.label must be a string or null");
  }
  if (!Array.isArray(bundle.files)) {
    errors.push("backup.files must be an array");
    return empty;
  }

  const paths = new Set<string>();
  const files: BackupFile[] = [];
  let bytes = 0;

  for (const [index, candidate] of bundle.files.entries()) {
    if (typeof candidate !== "object" || candidate === null) {
      errors.push(`files[${index}] is not an object`);
      continue;
    }

    const file = candidate as Partial<BackupFile>;

    if (!safeRelative(file.path)) {
      errors.push(`files[${index}].path is not a safe relative path`);
      continue;
    }

    if (paths.has(file.path)) {
      errors.push(`files[${index}] repeats ${file.path}`);
      continue;
    }

    paths.add(file.path);

    if (!Number.isInteger(file.size) || (file.size as number) < 0) {
      errors.push(`files[${index}].size is not a non-negative integer`);
      continue;
    }

    if (typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      errors.push(`files[${index}].sha256 is not a SHA-256 digest`);
      continue;
    }

    if (typeof file.content !== "string") {
      errors.push(`files[${index}].content is not base64`);
      continue;
    }

    const content = Buffer.from(file.content, "base64");

    if (content.length !== file.size) {
      errors.push(`files[${index}] has ${content.length} bytes, expected ${file.size}`);
      continue;
    }

    if (sha256(content) !== file.sha256) {
      errors.push(`files[${index}] (${file.path}) does not match its digest`);
      continue;
    }

    bytes += content.length;
    files.push(file as BackupFile);
  }

  if (files.length !== bundle.files.length) {
    return { valid: false, errors, files: files.length, bytes };
  }

  if (typeof bundle.digest !== "string" || !/^[0-9a-f]{64}$/.test(bundle.digest)) {
    errors.push("backup.digest is not a SHA-256 digest");
  } else if (backupDigest(bundle as BackupBundle) !== bundle.digest) {
    errors.push("backup.digest does not match the manifest");
  }

  return { valid: errors.length === 0, errors, files: files.length, bytes };
}

export interface RestoreResult {
  restored: number;
  bytes: number;
}

export function restoreBackup(
  value: unknown,
  target: string,
  options: { force?: boolean } = {},
): RestoreResult {
  const checked = verifyBackup(value);

  if (!checked.valid) {
    throw new Error(`backup is not valid: ${checked.errors.join("; ")}`);
  }

  const bundle = value as BackupBundle;
  const root = resolve(target);

  if (existsSync(root) && readdirSync(root).length > 0 && !options.force) {
    throw new Error(`restore target is not empty: ${target} (use --force to overwrite)`);
  }

  const bytes = new Map<string, Buffer>();
  let total = 0;

  for (const file of bundle.files) {
    const content = Buffer.from(file.content, "base64");
    const destination = resolve(root, file.path);

    if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
      throw new Error(`refusing to restore outside the target: ${file.path}`);
    }

    bytes.set(destination, content);
    total += content.length;
  }

  for (const [destination, content] of bytes) {
    mkdirSync(dirname(destination), { recursive: true });
    const temp = `${destination}.${process.pid}.tmp`;
    writeFileSync(temp, content);
    renameSync(temp, destination);
  }

  return { restored: bytes.size, bytes: total };
}

export function writeBackup(bundle: BackupBundle, filePath: string): void {
  const checked = verifyBackup(bundle);

  if (!checked.valid) {
    throw new Error(`refusing to write an invalid backup: ${checked.errors.join("; ")}`);
  }

  mkdirSync(dirname(resolve(filePath)), { recursive: true });
  const temp = `${resolve(filePath)}.${process.pid}.tmp`;

  writeFileSync(temp, gzipSync(`${JSON.stringify(bundle)}\n`));
  renameSync(temp, resolve(filePath));
}

export function readBackup(filePath: string): BackupBundle {
  return JSON.parse(gunzipSync(readFileSync(filePath)).toString("utf8")) as BackupBundle;
}
