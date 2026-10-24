/**
 * Loopback detection for operator-only routes. A request with no token is only
 * trusted to destroy data when it arrives over the loopback interface.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;

  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;

  return normalized === "::1" || normalized.startsWith("127.");
}

export interface RemoteAddressCarrier {
  socket: { remoteAddress?: string | undefined };
}

/**
 * A destructive collection pass is allowed when the caller presented a token
 * (already checked) or when the connection is local. An unknown address is not
 * loopback.
 */
export function destructiveGcAllowed(
  req: RemoteAddressCarrier,
  tokenCount: number,
): boolean {
  return tokenCount > 0 || isLoopbackAddress(req.socket.remoteAddress);
}
