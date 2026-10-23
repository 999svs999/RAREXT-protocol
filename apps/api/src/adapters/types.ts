import type {
  AdapterInfo,
  AdapterReceipt,
  AdapterStatus,
  SourceQuery,
  SourceResolution,
} from "../../../../packages/core/src/index.ts";

export interface TracIdentityProof {
  kind: "trac";
  challenge: Record<string, unknown>;
  signature: string;
}

export interface IdentityLinkProof {
  handle: string;
  network: string;
  externalId: string;
  proofUrl: string;
  nonce: string;
  audience?: string;
  binding?: string;
  externalProof?: TracIdentityProof;
}

export interface RarextAdapter {
  info(): AdapterInfo;
  status(): Promise<AdapterStatus>;
  anchor?(root: string, publicationIds: string[]): Promise<AdapterReceipt>;
  resolveSource?(query: SourceQuery): Promise<SourceResolution>;
  verifyIdentityLink?(proof: IdentityLinkProof): Promise<void>;
}

export function statusFor(info: AdapterInfo, details: Record<string, unknown>): AdapterStatus {
  return { ...info, details };
}
