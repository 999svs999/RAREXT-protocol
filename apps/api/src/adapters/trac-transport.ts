// The Trac anchor transport boundary. RAREXT emits one `rarext.anchor.v1`
// announcement per Merkle root; a transport is responsible for getting it to
// Trac and returning a reference an operator can cite.
//
// Two kinds exist:
//   - `webhook`: a signed-or-plain HTTP POST to an operator-run endpoint
//     (`TRAC_ANCHOR_URL`). This is real and end-to-end testable today.
//   - `intercom`: the native RESET/trac-peer path. It is intentionally blocked:
//     the 0.4.11 wire format has no anchor move and no free-form memo.
export interface AnchorAnnouncement {
  protocol: "rarext.anchor.v1";
  root: string;
  publicationIds: string[];
}

export interface AnchorAnnouncementReceipt {
  reference: string;
}

export interface TracAnchorTransport {
  readonly kind: "webhook" | "intercom";
  readonly endpoint: string | null;
  readonly configured: boolean;
  announce(
    announcement: AnchorAnnouncement,
    signal?: AbortSignal,
  ): Promise<AnchorAnnouncementReceipt>;
}

/**
 * Why the native transport cannot ship yet. Researched against the pinned
 * RESET stack (Trac-Systems/reset, trac-peer 0.4.11):
 *
 *   - Message moves are exact-key validated `{v,t,b,h,p,w}` envelopes. `t` is
 *     one of header/lock/unlock/withdraw/gw_beat/guess/claim and each `p` has a
 *     fixed shape, so there is no slot for an anchor root
 *     (`contract/rules/index.js`, `contract/rules/json.js`).
 *   - MSB contract transactions only accept `transfer`, `gw_set`, and
 *     `params_set`. `transfer` is a strict `{op,to,amount}` command, and the
 *     transaction commits to `blake3(JSON.stringify(command))`, so the root is
 *     not carried and not committed (`contract/protocol.js`,
 *     `signer/lib/wire.mjs`).
 *   - The only free-form channel is the optional `reset-chat` sidechannel, and
 *     it is explicitly off-chain and in memory (`docs/SPEC.md` §6), so it
 *     cannot support an inclusion proof later.
 *
 * A native transport needs one of: an anchor move type, a transfer memo, or a
 * durable content-addressed sidechannel. Until then the webhook transport is
 * the smallest real transport, and this constant is the recorded blocker.
 */
export const INTERCOM_TRANSPORT_BLOCKER =
  "RESET/trac-peer has no anchor move or free-form memo: message moves are fixed {v,t,b,h,p,w} types and MSB transactions only carry a strict {op,to,amount} transfer command, so an anchor root cannot be committed offline";

export const NATIVE_TRANSPORT_SHORT_BLOCKER =
  "no anchor move or transfer memo in the RESET/trac-peer wire format";

export class WebhookAnchorTransport implements TracAnchorTransport {
  readonly kind = "webhook" as const;
  readonly endpoint: string;
  readonly configured = true;
  private readonly requestFetch: typeof fetch;

  constructor(endpoint: string, requestFetch: typeof fetch = fetch) {
    this.endpoint = endpoint;
    this.requestFetch = requestFetch;
  }

  async announce(
    announcement: AnchorAnnouncement,
    signal?: AbortSignal,
  ): Promise<AnchorAnnouncementReceipt> {
    const response = await this.requestFetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(announcement),
      signal: signal ?? AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      throw new Error(`Trac returned ${response.status}`);
    }

    const reference = (await response.text()).slice(0, 500);

    return { reference: reference || `trac:${response.status}` };
  }
}

export class IntercomAnchorTransport implements TracAnchorTransport {
  readonly kind = "intercom" as const;
  readonly endpoint = null;
  readonly configured = false;

  async announce(): Promise<AnchorAnnouncementReceipt> {
    throw new Error(INTERCOM_TRANSPORT_BLOCKER);
  }
}

export function createTracAnchorTransport(
  url: string | null,
  requestFetch: typeof fetch = fetch,
): TracAnchorTransport {
  return url ? new WebhookAnchorTransport(url, requestFetch) : new IntercomAnchorTransport();
}
