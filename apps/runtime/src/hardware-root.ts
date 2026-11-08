import { AgentSigner, generateAgentKeypair } from "../../../packages/agent-sdk/src/index.ts";
import { sha256Hex } from "./digest.ts";
import { issueProviderCertificate } from "./model-bundle.ts";
import type { ProviderCertificate } from "./model-bundle.ts";

/**
 * A simulated hardware root of trust: the SILICON VENDOR's root key.
 *
 * This key is not chosen by a deployment. It ships with the protocol, the way a
 * chip's root key is fused into the die, so a deployment PINS it rather than
 * supplying one. A quote whose certificate chain does not terminate at this root
 * is refused, no matter who signed the leaf. In production this would be a real
 * vendor root (Intel SGX, AMD SEV-SNP, Apple SEP) held in hardware; here it is a
 * fixed key, so the shape is the same but the root is a file, not a fuse.
 */
const HARDWARE_ROOT_JWK = {
  kty: "EC",
  crv: "P-256",
  x: "lj4IrJR3okFY-2OQXxloW-VPHaFzu1dEQ8r46lG80QQ",
  y: "xDyWZx1qKvaFubrjFgx_MgZQFSAnJAVI1UjuYN9q-qY",
  d: "OxeHEDX1RzsNTSIdEMW7B4zwq-XS2uJBt42m1QmQsAg",
} as const;

/** The vendor root of trust, as a signer (used to issue platform certificates). */
export function hardwareRootSigner(): AgentSigner {
  return new AgentSigner(HARDWARE_ROOT_JWK as unknown as never);
}

const HARDWARE_ROOT = hardwareRootSigner();

/** The key id every hardware-rooted deployment pins. */
export const HARDWARE_ROOT_KEY_ID = HARDWARE_ROOT.keyId;

/** The vendor root's public key, shipable to deployments that pin it. */
export const HARDWARE_ROOT_PUBLIC_KEY = HARDWARE_ROOT.publicKey;

/**
 * A chain from a leaf key up to the vendor hardware root: the leaf is certified
 * by a platform key, and the platform key by the vendor root. Depth two is the
 * point — a bare leaf is not hardware-rooted, and a chain that stops at anything
 * but the vendor root is refused.
 */
export function issueHardwareChain(leafPublicKey: unknown): {
  chain: ProviderCertificate[];
  platform: AgentSigner;
} {
  const platform = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const leafCertificate = issueProviderCertificate({ subject: leafPublicKey, issuerSigner: platform });
  const platformCertificate = issueProviderCertificate({
    subject: platform.publicKey,
    issuerSigner: HARDWARE_ROOT,
  });
  return { chain: [leafCertificate, platformCertificate], platform };
}

/**
 * A measured-boot chain: the vendor root certifies FIRMWARE, firmware certifies
 * the OS, the OS certifies the app (the enclave's leaf key). Each certificate
 * names its stage, so a deployment can require the chain to extend through every
 * stage it trusts — a leaf signed outside the measured boot is refused.
 *
 * The chain from the leaf up is app → os → firmware → (vendor root).
 */
/** The measurement a stage carries by default: a digest of its declared image. */
export function stageMeasurement(stage: string): string {
  return sha256Hex(`rarext.measured-boot.v1\n${stage}`);
}

export function issueMeasuredBootChain(
  leafPublicKey: unknown,
  measurements: Record<string, string> = {},
): {
  chain: ProviderCertificate[];
  stages: string[];
  measurements: Record<string, string>;
} {
  const firmware = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const os = new AgentSigner(generateAgentKeypair("ecdsa-p256").privateKey);
  const measured = {
    app: measurements.app ?? stageMeasurement("app"),
    os: measurements.os ?? stageMeasurement("os"),
    firmware: measurements.firmware ?? stageMeasurement("firmware"),
  };
  const chain: ProviderCertificate[] = [
    issueProviderCertificate({ subject: leafPublicKey, issuerSigner: os, stage: "app", measurement: measured.app }),
    issueProviderCertificate({ subject: os.publicKey, issuerSigner: firmware, stage: "os", measurement: measured.os }),
    issueProviderCertificate({
      subject: firmware.publicKey,
      issuerSigner: HARDWARE_ROOT,
      stage: "firmware",
      measurement: measured.firmware,
    }),
  ];
  return { chain, stages: ["app", "os", "firmware"], measurements: measured };
}
