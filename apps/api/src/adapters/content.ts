import { createHash } from "node:crypto";

import type {
  AdapterInfo,
  AdapterReceipt,
  AdapterStatus,
} from "../../../../packages/core/src/index.ts";

import { statusFor } from "./types.ts";
import type { RarextAdapter } from "./types.ts";

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

/**
 * A CIDv1 over a raw sha2-256 multihash, which is what a content-addressed file
 * looks like to an IPFS or Arweave node. No dependency, no daemon: the digest is
 * the pointer.
 *
 *   CIDv1 = <0x01 version> <0x55 raw codec> <0x12 sha2-256> <0x20 length> <digest>
 */
export function cidV1Raw(bytes: Uint8Array): string {
  const digest = createHash("sha256").update(bytes).digest();

  const multihash = Buffer.concat([
    Buffer.from([0x12, 0x20]),
    digest,
  ]);

  const cid = Buffer.concat([
    Buffer.from([0x01, 0x55]),
    multihash,
  ]);

  return `b${base32Encode(cid)}`;
}

export interface PinOptions {
  /** A pinning service that accepts a CID and returns a reference. */
  serviceUrl?: string | null;
  fetchImpl?: typeof fetch;
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

    const response = await requestFetch(this.options.serviceUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cid,
        root,
        publicationIds,
        content: Buffer.from(payload, "utf8").toString("base64"),
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`pinning service returned ${response.status}`);
    }

    const result = (await response.json()) as { reference?: string };

    return {
      adapter: "content",
      status: "ok",
      reference: result.reference ?? `cid:${cid}`,
    };
  }
}
