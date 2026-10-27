import {
  base32Encode,
  cidV1,
} from "../../../../packages/core/src/index.ts";
import type {
  AdapterInfo,
  AdapterReceipt,
  AdapterStatus,
  SeedPin,
} from "../../../../packages/core/src/index.ts";

import { nodeSha256 } from "../digest.ts";
import { statusFor } from "./types.ts";
import type { RarextAdapter } from "./types.ts";

export { base32Encode };
export type { SeedPin };

/**
 * A CIDv1 over a raw sha2-256 multihash, which is what a content-addressed file
 * looks like to an IPFS or Arweave node. No dependency, no daemon: the digest is
 * the pointer. The composition lives in `@rarext/core`; this path supplies
 * node:crypto as the digest, so there is one CID implementation.
 */
export function cidV1Raw(bytes: Uint8Array): string {
  return cidV1(nodeSha256, bytes);
}

export interface PinOptions {
  /**
   * A pinning service that accepts a CID and returns a reference. `undefined`
   * means "read the environment" (see `pinServiceUrl`); an explicit `null`
   * means "no service", so a caller can pin locally on purpose while a service
   * is configured elsewhere.
   */
  serviceUrl?: string | null;
  /** Bearer token for a pinning service configured with `RAREXT_PIN_TOKEN`. */
  token?: string | null;
  fetchImpl?: typeof fetch;
}

/** What a pinning call returns: the CID always, a reference, and where it went. */
export interface PinResult {
  /** The content address, computed locally before anything leaves the process. */
  cid: string;
  /**
   * What the service returned, or `cid:<cid>` when there is no service (or the
   * service returned nothing usable) — never a reference invented to look like
   * a completed pin.
   */
  reference: string;
  /** The configured service the CID was handed to, or null when it was not. */
  service: string | null;
}

/**
 * The pinning service this process is configured to use: `RAREXT_PIN_SERVICE_URL`
 * for the publish flow and the content adapter, falling back to the adapter's
 * long-standing `RAREXT_PIN_URL`. Null means no service is configured, which is
 * the ordinary state — the CID still names the bytes either way.
 */
export function pinServiceUrl(): string | null {
  return process.env.RAREXT_PIN_SERVICE_URL || process.env.RAREXT_PIN_URL || null;
}

/**
 * The one place a pinning service is POSTed to: it sends the payload the caller
 * built (the CID plus the exact bytes behind it) and returns the parsed body.
 * A non-2xx answer, an oversized body, or a body that is not JSON is an error
 * naming what happened — a pin that was not accepted must never read as one
 * that was.
 */
async function postPin(
  serviceUrl: string,
  token: string | null,
  payload: Record<string, unknown>,
  requestFetch: typeof fetch,
): Promise<{ reference?: unknown }> {
  const response = await requestFetch(serviceUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`pinning service returned ${response.status}`);
  }

  const text = await response.text();
  if (Buffer.byteLength(text) > 64 * 1024) {
    throw new Error("pinning service response is too large");
  }

  try {
    return JSON.parse(text) as { reference?: unknown };
  } catch {
    throw new Error("pinning service returned invalid JSON");
  }
}

/**
 * The publish flow's pinning call: hash the published bytes, and hand that CID
 * to the configured service.
 *
 * The CID is always computed locally first, so the pointer exists whether or
 * not anything is configured. With no service the call is local-only — it
 * fetches nothing and says so (`service: null`, `reference: "cid:<cid>"`); with
 * one, the service's own reference is returned as it came back, and a service
 * that refuses or misbehaves throws with the reason.
 */
export async function pinBundle(
  bytes: Uint8Array,
  options: PinOptions = {},
): Promise<PinResult> {
  const cid = cidV1Raw(bytes);
  const service = options.serviceUrl !== undefined ? options.serviceUrl : pinServiceUrl();

  if (!service) {
    return { cid, reference: `cid:${cid}`, service: null };
  }

  const token = options.token !== undefined ? options.token : process.env.RAREXT_PIN_TOKEN || null;
  const result = await postPin(
    service,
    token,
    { cid, content: Buffer.from(bytes).toString("base64") },
    options.fetchImpl ?? fetch,
  );

  return {
    cid,
    reference: typeof result.reference === "string" ? result.reference : `cid:${cid}`,
    service,
  };
}

/**
 * Pins the registry bundle and returns a receipt carrying the CID.
 *
 * The CID is always computed locally, so the pointer is available even with no
 * pinning service. When a service is configured the CID is handed to it and the
 * receipt says so; without one the receipt reports the computed CID as a local
 * reference, which is honest about what happened.
 */
export class ContentPinAdapter implements RarextAdapter {
  private readonly options: PinOptions;

  constructor(options: PinOptions = {}) {
    this.options = options;
  }

  info(): AdapterInfo {
    const service = this.options.serviceUrl ?? null;

    return {
      id: "content",
      name: "Content addressing",
      kind: "network",
      capabilities: ["anchor", "assets"],
      configured: true,
      status: "ready",
      description: service
        ? "Pins the registry bundle to a content-addressed store and returns the CID."
        : "Computes the bundle's content address locally. Configure a pinning service to publish it.",
      url: service,
    };
  }

  async status(): Promise<AdapterStatus> {
    return statusFor(this.info(), {
      transport: this.options.serviceUrl ? "http" : "local",
      algorithm: "cidv1-raw-sha2-256",
    });
  }

  async anchor(root: string, publicationIds: string[]): Promise<AdapterReceipt> {
    const payload = JSON.stringify({ root, publicationIds });
    const cid = cidV1Raw(Buffer.from(payload, "utf8"));

    if (!this.options.serviceUrl) {
      return {
        adapter: "content",
        status: "ok",
        reference: `cid:${cid}`,
      };
    }

    const requestFetch = this.options.fetchImpl ?? fetch;

    const result = await postPin(
      this.options.serviceUrl,
      this.options.token ?? null,
      {
        cid,
        root,
        publicationIds,
        content: Buffer.from(payload, "utf8").toString("base64"),
      },
      requestFetch,
    );

    return {
      adapter: "content",
      status: "ok",
      reference:
        typeof result.reference === "string" ? result.reference : `cid:${cid}`,
    };
  }
}
