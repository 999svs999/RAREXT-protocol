import type { IncomingMessage } from "node:http";

/** How a request body may be bounded. */
export interface BodyLimits {
  /** Hard cap on the bytes read. Exceeding it throws; nothing more is read. */
  limit: number;
  /**
   * Inactivity bound, in milliseconds: how long the reader waits for the NEXT
   * chunk before treating the body as stalled. Reset on every chunk, so a
   * slow-but-progressing body is not killed while a client that stops middling
   * and holds the socket open is.
   */
  stallMs?: number;
}

export interface CollectedBody {
  bytes: Buffer;
  /** What the client claimed, or 0 when it declared nothing. */
  declared: number;
  /** Bytes actually delivered. */
  size: number;
  /** True when the stream ended early, stalled, or was aborted mid-body. */
  endedEarly: boolean;
}

/**
 * Read a request body with a hard size cap and an inactivity bound — ONE
 * implementation, because this repo had two body readers and only one of them
 * had learned these lessons.
 *
 * `holder-server.ts` grew the stall timer and the declared-versus-delivered
 * refusal during the MCP storage hardening round; `pin-server.ts` kept a
 * reader with a size cap alone, so a client that declared a length, sent part
 * of it, and held the socket open wedged a pin write indefinitely. Extracting
 * the collection is how both get the same behaviour instead of the newer one
 * getting a copy of the fix.
 *
 * The returned facts are for the caller to answer with: the holder writes a
 * 400 and closes the connection, the pin server throws and lets its handler
 * answer. What the reader guarantees either way is that a fragment is never
 * parsed as a whole body.
 */
export async function collectBody(
  request: IncomingMessage,
  { limit, stallMs = 30_000 }: BodyLimits,
): Promise<CollectedBody> {
  const headerValue = request.headers["content-length"];
  const declared = Number(headerValue ?? "0");

  if (Number.isSafeInteger(declared) && declared > limit) {
    throw new Error("request body is too large");
  }

  const chunks: Buffer[] = [];
  let size = 0;
  let endedEarly = false;

  let stallTimer: NodeJS.Timeout | null = null;
  const arm = () => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      endedEarly = true;
      request.destroy(new Error("request body read stalled"));
    }, stallMs);
    stallTimer.unref?.();
  };

  arm();

  try {
    for await (const chunk of request) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new Error("request body is too large");
      chunks.push(chunk as Buffer);
      arm();
    }
  } catch (error) {
    // A destroyed socket (the stall timer, or a client abort) interrupts the
    // loop, and an oversized body throws from inside it. Both mean the body is
    // not a whole body: report it, never parse a fragment.
    if (error instanceof Error && error.message === "request body is too large") {
      if (stallTimer) clearTimeout(stallTimer);
      throw error;
    }
    endedEarly = true;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
  }

  if (Number.isSafeInteger(declared) && declared > 0 && size !== declared) {
    endedEarly = true;
  }

  return { bytes: Buffer.concat(chunks), declared: Number.isSafeInteger(declared) ? declared : 0, size, endedEarly };
}
