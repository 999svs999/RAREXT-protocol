/**
 * Read-only $BEM balance view. The registry's TapeOut adapter reads the balance
 * over `eth_call` and returns base units plus the token decimals; this module
 * turns that into the text the UI shows. It never signs and never writes.
 */
export interface BemStatus {
  configured: boolean;
  chainId: string | null;
  blockNumber: string | null;
  bemContract: string | null;
  bemDecimals: number;
  address: string | null;
  bemBalance: string | null;
  error?: string;
}

export type BemReadout =
  | { kind: "empty" }
  | { kind: "unavailable" }
  | { kind: "amount"; amount: string };

const DEFAULT_DECIMALS = 18;
const MAX_DECIMALS = 36;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function decimalsOf(value: unknown): number {
  const decimals = Number(value);
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_DECIMALS
    ? decimals
    : DEFAULT_DECIMALS;
}

export function parseBemStatus(value: unknown): BemStatus {
  const record = (value ?? {}) as Record<string, unknown>;

  return {
    configured: record.configured === true,
    chainId: asString(record.chainId),
    blockNumber: asString(record.blockNumber),
    bemContract: asString(record.bemContract),
    bemDecimals: decimalsOf(record.bemDecimals),
    address: asString(record.address),
    bemBalance: asString(record.bemBalance),
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

export function formatTokenAmount(raw: string, decimals: number): string {
  const digits = raw.replace(/^0+(?=\d)/, "") || "0";
  const scale = decimalsOf(decimals);

  if (scale === 0) return group(digits);

  const padded = digits.padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");

  return fraction ? `${group(whole)}.${fraction}` : group(whole);
}

export function bemReadout(status: BemStatus): BemReadout {
  if (!status.configured || !status.address) return { kind: "empty" };
  if (status.error || status.bemBalance === null) return { kind: "unavailable" };

  return { kind: "amount", amount: formatTokenAmount(status.bemBalance, status.bemDecimals) };
}
