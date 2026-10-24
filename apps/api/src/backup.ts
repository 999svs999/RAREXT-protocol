import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
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
const RESTORE_LOCK = ".rarext-restore.lock";

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

    if (
      !entry.isFile() ||
      entry.name.endsWith(".tmp") ||
      entry.name === RESTORE_LOCK
    ) {
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
  const lock = join(root, RESTORE_LOCK);

  if (existsSync(root)) {
    if (!statSync(root).isDirectory()) {
      throw new Error(`restore target is not a directory: ${target}`);
    }
    if (existsSync(lock)) {
      throw new Error(`restore already in progress for ${target} (remove ${lock} if not)`);
    }
    if (readdirSync(root).length > 0 && !options.force) {
      throw new Error(`restore target is not empty: ${target} (use --force to overwrite)`);
    }
  }

  mkdirSync(root, { recursive: true });
  const realRoot = realpathSync(root);

  // Two restores into one target would interleave their per-file renames. The
  // lock makes the second one refuse instead of leaving a mixed tree. A crashed
  // restore leaves the lock behind; remove it by hand once no restore is
  // running.
  try {
    writeFileSync(lock, `${process.pid} ${Date.now()}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`restore already in progress for ${target} (remove ${lock} if not)`);
    }
    throw error;
  }

  const staged: { temporary: string; destination: string; existed: boolean }[] = [];
  let total = 0;

  try {
    for (const file of bundle.files) {
      const content = Buffer.from(file.content, "base64");
      const destination = resolve(root, file.path);

      if (destination !== root && !destination.startsWith(`${root}${sep}`)) {
        throw new Error(`refusing to restore outside the target: ${file.path}`);
      }

      mkdirSync(dirname(destination), { recursive: true });

      // A pre-existing symlinked directory under the target must not redirect
      // a write outside it.
      const realParent = realpathSync(dirname(destination));
      if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
        throw new Error(`refusing to restore through a symlink: ${file.path}`);
      }

      const temporary = `${destination}.${randomUUID()}.tmp`;
      writeFileSync(temporary, content, { flag: "wx" });
      staged.push({ temporary, destination, existed: existsSync(destination) });
      total += content.length;
    }
  } catch (error) {
    for (const entry of staged) rmSync(entry.temporary, { force: true });
    rmSync(lock, { force: true });
    throw error;
  }

  try {
    for (const entry of staged) renameSync(entry.temporary, entry.destination);
  } catch (error) {
    for (const entry of staged) {
      rmSync(entry.temporary, { force: true });
      if (!entry.existed) rmSync(entry.destination, { force: true });
    }
    throw error;
  } finally {
    rmSync(lock, { force: true });
  }

  return { restored: staged.length, bytes: total };
}

export function writeBackup(bundle: BackupBundle, filePath: string): void {
  const checked = verifyBackup(bundle);

  if (!checked.valid) {
    throw new Error(`refusing to write an invalid backup: ${checked.errors.join("; ")}`);
  }

  const destination = resolve(filePath);
  mkdirSync(dirname(destination), { recursive: true });
  const temp = `${destination}.${randomUUID()}.tmp`;

  try {
    writeFileSync(temp, gzipSync(`${JSON.stringify(bundle)}\n`), { flag: "wx" });
    renameSync(temp, destination);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function readBackup(filePath: string): BackupBundle {
  return JSON.parse(gunzipSync(readFileSync(filePath)).toString("utf8")) as BackupBundle;
}
