/**
 * Data a read-only tracing tool needs to follow requests and answers between sessions, kept in the session's own entries
 * (never sent to the model, never on the wire). Everything here is schema version 1 (`v: 1` in each entry).
 *
 *   intercom_sent     { v, to, message{text, replyTo, supersedes, retryOf, attachments}, messageId, timestamp,
 *                       expectsReply?, delivery?, recipient?{id, piSessionId, cwd, name}, replyToInferred?, wake?, ... }
 *   intercom_receipt  { v, messageId, status, timestamp, detail?, from{id, piSessionId, cwd, name} }
 *                     one per receipt the receiver reports for a message THIS session sent (the broker routes receipts only to
 *                     the sender); it can precede the intercom_sent entry of the same messageId: join by messageId
 *
 * WHY A TEXT TAG: the broker accepts `replyTo` only for an ask that is pending between the two sessions (E_REPLY_TARGET
 * otherwise), so a plain message cannot be answered "in thread" on the wire. A plain message therefore tells the model to
 * begin its answer with `[RE:<message id>]`; the sender records that tag as `threadRef` in its own entry (explicit, high
 * confidence). No protocol change.
 *
 * `replyToInferred` is a best guess about which received message a plain send answers. It lives ONLY in the sender's own
 * entry: a wrong replyTo on the wire could satisfy an ask that is waiting for a different reply.
 */
export const TRACE_SCHEMA_VERSION = 1;

/** `[RE:<message id>]` at the start of a message (after at most one leading `[TAG]`): an explicit "this answers that message". */
const THREAD_TAG = /^\s*(?:\[[A-Za-zÀ-ÿ ,'’-]{1,40}\]\s*)?\[RE:([A-Za-z0-9][A-Za-z0-9._:-]{3,127})\]/;

export function extractThreadRef(text: string): string | undefined {
  return THREAD_TAG.exec(text.slice(0, 300))?.[1];
}

/** What to tell the model so that its answer to a plain message can be linked to it. */
export function threadReplyHint(toId: string, messageId: string): string {
  return `intercom({ action: "send", to: ${JSON.stringify(toId)}, message: "[RE:${messageId}] ..." })`;
}

/** A plain message is considered answered by a send to the same peer if it arrived this recently. */
export const INFERENCE_WINDOW_MS = 30 * 60_000;

interface PeerState {
  lastOutboundAt: number; // for diagnostics only
  /** Messages received from the peer since the last time this session sent it anything. */
  inbound: Array<{ id: string; at: number; expectsReply: boolean }>;
}

export interface InferredReply {
  id: string;
  basis: "sole_unanswered_message_from_peer";
  ageMs: number;
}

/**
 * Remembers, per peer, what arrived since this session last wrote to it. A plain send to a peer that has exactly ONE such
 * message, recent, and not an ask (asks are already threaded by their own inference) is recorded as answering it.
 * More than one candidate, none, or an old one: no guess.
 */
export class PeerTracker {
  private readonly peers = new Map<string, PeerState>();
  /** Message id -> who sent it, for the most recent inbound messages (to check that a [RE:id] tag names a real message). */
  private readonly inboundIds = new Map<string, string>();

  private state(peerId: string): PeerState {
    let state = this.peers.get(peerId);
    if (!state) {
      state = { lastOutboundAt: 0, inbound: [] };
      this.peers.set(peerId, state);
      if (this.peers.size > 200) {
        const oldest = this.peers.keys().next().value as string | undefined;
        if (oldest !== undefined && oldest !== peerId) this.peers.delete(oldest);
      }
    }
    return state;
  }

  recordInbound(peerId: string, messageId: string, at: number, expectsReply: boolean): void {
    const state = this.state(peerId);
    state.inbound.push({ id: messageId, at, expectsReply });
    if (state.inbound.length > 20) state.inbound.shift();
    this.inboundIds.delete(messageId);
    this.inboundIds.set(messageId, peerId);
    while (this.inboundIds.size > 500) {
      const oldest = this.inboundIds.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.inboundIds.delete(oldest);
    }
  }

  recordOutbound(peerId: string, at: number): void {
    const state = this.state(peerId);
    state.lastOutboundAt = at;
    state.inbound = [];
  }

  /** Whether this peer really sent a message with that id (recent ones only). */
  receivedFrom(peerId: string, messageId: string): boolean {
    return this.inboundIds.get(messageId) === peerId;
  }

  /** What a plain send to this peer right now most likely answers, if it can be said with confidence. */
  inferReply(peerId: string, now: number, windowMs = INFERENCE_WINDOW_MS): InferredReply | undefined {
    const state = this.peers.get(peerId);
    if (!state) return undefined;
    // recordOutbound empties the list, so what is left arrived after this session last wrote to the peer.
    if (state.inbound.length !== 1) return undefined;
    const only = state.inbound[0]!;
    if (only.expectsReply || now - only.at > windowMs || now < only.at) return undefined;
    return { id: only.id, basis: "sole_unanswered_message_from_peer", ageMs: now - only.at };
  }
}

export interface RecipientInfo {
  id: string;
  piSessionId?: string;
  cwd?: string;
  name?: string;
}

export function recipientInfo(session: { id: string; piSessionId?: string; cwd?: string; name?: string }): RecipientInfo {
  return {
    id: session.id,
    ...(session.piSessionId ? { piSessionId: session.piSessionId } : {}),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    ...(session.name ? { name: session.name } : {}),
  };
}
