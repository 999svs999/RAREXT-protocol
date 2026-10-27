/**
 * The artifact-source module owns the generated mirror artifact forms: the
 * inline bundle the workbench reads, the canonical bundle serialization, and
 * the script-tag injection that puts the bundle in front of the app.
 */
export declare function bundleScript(bundle: unknown): string;
export declare function bundleJson(bundle: unknown): string;
export declare function writeBundleFiles(dir: string, bundle: unknown): void;
export declare function injectBundleScript(
  html: string,
  options: { appSrc: string; newAppSrc?: string },
): string;
