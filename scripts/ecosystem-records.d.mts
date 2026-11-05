// Type declarations for scripts/ecosystem-records.mjs — the TS side (the
// verifiers and their tests) imports this module, and TS7016 turns a missing
// declaration into implicit `any`, which means the typecheck is verifying
// nothing about the very records it is supposed to prove.
import type { Buffer } from "node:buffer";

export declare const root: string;
export declare const REGISTRY_URL: string;
export declare const MIRROR_URL: string;
export declare function sha256Hex(buf: Buffer | Uint8Array | string): string;

export interface EcosystemBrand {
  handle: string;
  app: string;
  kind: string;
  name: string;
  origin: string;
  title: string;
  generator: string;
  identityDir: string;
  /** Paths the origin SERVES. A record may never list a 404. */
  pages: string[];
  note?: string;
}

export declare const ECOSYSTEM_BRANDS: EcosystemBrand[];

export interface PageEntry { path: string; sha256: string; bytes: number }
export interface MediaEntry { url: string; sha256: string; bytes: number }

export interface SiteRecordInput {
  origin: string;
  title: string;
  generator: string;
  pages: PageEntry[];
  media?: MediaEntry[];
  revision?: string | null;
  publishedAt?: string | null;
}
export declare function siteRecordBody(input: SiteRecordInput): Record<string, unknown>;

export interface FetchedPage {
  path: string;
  /** Either the raw bytes (network step) or the digest itself (pure step). */
  body?: Buffer | Uint8Array | string;
  sha256?: string;
  bytes?: number;
}
export declare function pagesFrom(fetched: FetchedPage[]): PageEntry[];

export interface NameTarget { kind: "site" | "registry" | "mirror" | "gallery"; url: string }
export interface NameRecordInput {
  name: string;
  identityKey: string;
  targets: NameTarget[];
  note?: string;
}
export declare function nameRecordBody(input: NameRecordInput): Record<string, unknown>;

export declare function targetsFor(brand: EcosystemBrand): NameTarget[];

export declare function fetchBrandPages(
  brand: EcosystemBrand,
  fetchImpl?: typeof fetch,
): Promise<{ path: string; body: Buffer }[]>;

export interface BuiltRecord {
  brand: string;
  app: string;
  kind: string;
  site: Record<string, unknown>;
  name: Record<string, unknown>;
}
export declare function buildEcosystemRecords(options?: {
  identities?: Record<string, string>;
  fetchImpl?: typeof fetch;
  publishedAt?: string | null;
  only?: string | null;
}): Promise<BuiltRecord[]>;

export declare function isSkippableEcosystemError(err: unknown): boolean;

export declare function buildBrandRecords(
  brand: EcosystemBrand,
  keyId: string | undefined,
  options?: { fetchImpl?: typeof fetch; publishedAt?: string | null },
): Promise<BuiltRecord>;
