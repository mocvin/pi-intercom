import { randomUUID } from "crypto";
import { isAbsolute, resolve } from "path";
import type { SendResult } from "../broker/client.ts";
import type { WakeConfig } from "../config.ts";
import type { Attachment, MessageReceipt, SessionInfo, WakeTarget } from "../types.ts";
import { WAKE_FEATURE } from "../types.ts";
import { sameCwd } from "../cwd.ts";
import { WakeAudit, sha256, type WakeAuditEntry, type WakeOutcome } from "./audit.ts";
import { checkLimits, checkMessage, cwdAllowed } from "./policy.ts";
import { SAFE_MESSAGE_ID, WakeError, type WakeProvider } from "./provider.ts";
import { resolveWakeCandidate } from "./resolve.ts";

/** The slice of the intercom client the wake flow needs; the real IntercomClient satisfies it. */
export interface WakeClient {
  readonly sessionId: string | null;
  supportsFeature(feature: string): boolean;
  listSessions(options?: { timeoutMs?: number }): Promise<SessionInfo[]>;
  send(to: string, options: { text: string; attachments?: Attachment[]; messageId?: string; wake?: WakeTarget }): Promise<SendResult>;
  cancelMessage(messageId: string): Promise<SendResult>;
  onMessageReceipt(handler: (from: SessionInfo, receipt: MessageReceipt) => void): () => void;
}

export interface WakeDeps {
  client: WakeClient;
  config: WakeConfig;
  provider: WakeProvider | undefined;
  audit: WakeAudit;
  /** Ask the user; undefined when there is no UI, which blocks the wake unless confirm is "never". */
  confirm?: (title: string, body: string) => Promise<boolean>;
  self: { intercomId: string | null; piSessionId: string; cwd: string };
  now?: () => number;
}

export interface WakeRequest {
  to: string;
  cwd: string;
  message: string;
  attachments?: Attachment[];
  messageId?: string;
  signal?: AbortSignal;
}

export interface WakeResult {
  /** False means the message was not delivered and is not held for later (blocked, refused, failed). */
  ok: boolean;
  outcome: WakeOutcome;
  code: string;
  text: string;
  messageId: string;
  target?: { piSessionId: string; cwd: string; name?: string };
}

const RECEIPT_PROOF = new Set(["receiver_received", "acknowledged", "injected", "queued"]);

/**
 * Deliver a message to a persisted session that is not connected: hold it once in the broker mailbox,
 * reopen the session through the provider, and wait for the receiver's receipt.
 * The caller has already established that the target is not connected.
 */
export async function performWake(deps: WakeDeps, request: WakeRequest): Promise<WakeResult> {
  const { config, provider, audit, client } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const messageId = request.messageId ?? randomUUID();
  const text = request.message;
  let target: { piSessionId: string; cwd: string; name?: string } | undefined;
  let daemon: string | undefined;

  const entry = (outcome: WakeOutcome, code: string, detail?: string): WakeAuditEntry => ({
    ts: now(),
    outcome,
    code,
    messageId,
    target: { ...(target ?? { cwd: request.cwd }) },
    sender: { ...(deps.self.intercomId ? { intercomId: deps.self.intercomId } : {}), piSessionId: deps.self.piSessionId, cwd: deps.self.cwd },
    textLength: text.length,
    textSha256: sha256(text),
    ...(target ? { dedupKey: sha256(`${target.piSessionId}\0${target.cwd}\0${text}`) } : {}),
    provider: provider?.id ?? config.provider,
    ...((daemon ?? provider?.describe?.()) ? { daemon: daemon ?? provider?.describe?.() } : {}),
    durationMs: now() - started,
    ...(detail ? { detail: detail.slice(0, 300) } : {}),
  });
  const done = (ok: boolean, outcome: WakeOutcome, code: string, message: string, detail?: string): WakeResult => {
    try {
      audit.append(entry(outcome, code, detail ?? message));
    } catch {
      // The block/refusal already stopped the wake; a failed audit write must not hide the reason.
    }
    return { ok, outcome, code, text: message, messageId, ...(target ? { target } : {}) };
  };
  const blocked = (code: string, message: string) => done(false, "blocked", code, message);

  // ---- Static checks: nothing has been read from the host and nothing is held yet.
  if (!config.enabled) return blocked("wake_disabled", "Waking persisted sessions is disabled. Set wake.enabled in the intercom config to allow it.");
  if (!SAFE_MESSAGE_ID.test(messageId)) return blocked("invalid_message_id", "The message id is not valid for a wake.");
  if (!provider) return blocked("provider_missing", `No wake provider "${config.provider}" is available.`);
  if (!client.supportsFeature(WAKE_FEATURE)) {
    return blocked("broker_unsupported", "The intercom broker does not support waking persisted sessions (wake-v1). The broker must be restarted on a version that does; sessions are not affected by that restart.");
  }
  if (!request.cwd || !isAbsolute(request.cwd)) return blocked("invalid_cwd", "A wake needs the target's absolute working directory (cwd).");
  const cwd = resolve(request.cwd);
  if (!cwdAllowed(config, cwd)) return blocked("cwd_not_allowed", `${cwd} is not in wake.allowCwds.`);
  const messageCheck = checkMessage(text);
  if (!messageCheck.ok) return blocked(messageCheck.code, messageCheck.detail);
  if (config.confirm === "always" && !deps.confirm) return blocked("confirmation_unavailable", "Waking a session needs the user's confirmation and no UI is available.");

  // ---- Resolve the target in the host catalog (read-only).
  let name: string | undefined;
  try {
    const listSignal = AbortSignal.any([AbortSignal.timeout(config.listTimeoutMs), ...(request.signal ? [request.signal] : [])]);
    const candidates = await provider.list(cwd, listSignal);
    const resolved = resolveWakeCandidate(candidates, request.to, cwd);
    if (!resolved.ok) return blocked(resolved.code, resolved.detail);
    target = { piSessionId: resolved.candidate.piSessionId, cwd, ...(resolved.candidate.name ? { name: resolved.candidate.name } : {}) };
    name = resolved.candidate.name;
    daemon = provider.describe?.();
  } catch (error) {
    const code = error instanceof WakeError ? error.code : "unavailable";
    return blocked(`provider_${code}`, `Cannot look up the session: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (target.piSessionId === deps.self.piSessionId) return blocked("self_target", "Cannot wake the current session.");

  // ---- Limits, confirmation, reservation.
  const dedupKey = sha256(`${target.piSessionId}\0${target.cwd}\0${text}`);
  const limit = checkLimits(config, audit.read(), { piSessionId: target.piSessionId, cwd, dedupKey }, now());
  if (limit) return blocked(limit.code, limit.detail);

  if (config.confirm === "always") {
    const preview = text.length > 600 ? `${text.slice(0, 600)}…` : text;
    let approved = false;
    try {
      approved = await deps.confirm!(
        "Wake a persisted session?",
        `This loads the saved session${name ? ` "${name}"` : ""} (${target.piSessionId}) in ${cwd} and delivers this message to it. The session runs its extensions and then answers the message with its model. If the session is already open in PI WEB with questions waiting for the user (ask_user), those questions are closed as unanswered.\n\n${preview}`,
      );
    } catch {
      approved = false;
    }
    if (!approved) return done(false, "refused", "user_declined", "Wake cancelled by the user.");
  }

  try {
    audit.append(entry("attempting", "reserved"));
  } catch (error) {
    return { ok: false, outcome: "blocked", code: "audit_unavailable", text: `Cannot record the wake in the audit (${error instanceof Error ? error.message : String(error)}); not waking.`, messageId, target };
  }
  // Re-check with our own reservation counted, so two sessions racing cannot both pass the limits.
  const recheck = checkLimits(config, audit.read(), { piSessionId: target.piSessionId, cwd, dedupKey }, now(), messageId);
  if (recheck) return done(false, "failed", recheck.code, recheck.detail);

  // ---- Hold the message once. A target that connected meanwhile is delivered to normally.
  const wake: WakeTarget = { piSessionId: target.piSessionId, cwd };
  const receipts: string[] = [];
  const unsubscribe = client.onMessageReceipt((_from, receipt) => {
    if (receipt.messageId === messageId && RECEIPT_PROOF.has(receipt.status)) receipts.push(receipt.status);
  });
  try {
    let held: SendResult;
    try {
      held = await client.send(target.piSessionId, { text, ...(request.attachments ? { attachments: request.attachments } : {}), messageId, wake });
    } catch (error) {
      return done(false, "failed", "send_failed", `The message could not be handed to the broker: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!held.delivered) {
      return done(false, "failed", held.code ?? "delivery_failed", `The broker refused the message: ${held.reason ?? "delivery failed"}`);
    }
    if (held.delivery === "socket_delivered") {
      return done(true, "already_connected", "already_connected", `Session ${target.piSessionId} was already connected; the message was delivered normally.`);
    }

    // ---- Reopen the session.
    try {
      const wakeSignal = AbortSignal.any([AbortSignal.timeout(config.wakeTimeoutMs), ...(request.signal ? [request.signal] : [])]);
      await provider.wake(wake, messageId, wakeSignal);
    } catch (error) {
      const wakeError = error instanceof WakeError ? error : new WakeError("timeout", error instanceof Error ? error.message : String(error));
      if (wakeError.definitive) {
        let withdrawn = "The held message was withdrawn.";
        try {
          const cancelled = await client.cancelMessage(messageId);
          if (!cancelled.delivered) withdrawn = "The held message could not be withdrawn and may still be delivered if the session reconnects.";
        } catch {
          withdrawn = "The held message could not be withdrawn and may still be delivered if the session reconnects.";
        }
        return done(false, "failed", `provider_${wakeError.code}`, `The session was not woken: ${wakeError.message}. ${withdrawn}`);
      }
      return done(true, "uncertain", `provider_${wakeError.code}`, `The outcome of the wake is unknown (${wakeError.message}). The message stays held in the broker mailbox for up to 24 hours and is delivered if the session opens. Do not resend it.`);
    }

    // ---- Wait for the woken session to confirm it received the held message.
    const deadline = now() + config.deliveryTimeoutMs;
    while (receipts.length === 0 && now() < deadline && !request.signal?.aborted) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    if (receipts.length > 0) {
      return done(true, "delivered", "delivered", `Woke session ${target.piSessionId}${name ? ` ("${name}")` : ""} and delivered the message (${receipts[0]}).`);
    }
    return done(true, "accepted_unconfirmed", "no_receipt", `The session daemon accepted the wake, but no receipt arrived within ${Math.round(config.deliveryTimeoutMs / 1000)}s. The message stays held in the broker mailbox and is delivered when the session registers. Do not resend it.`);
  } finally {
    unsubscribe();
  }
}

/** Find a connected session that is the target of a send addressed as `to` inside `cwd`; the caller delivers to it normally. */
export function findLiveWakeTarget(sessions: SessionInfo[], to: string, cwd: string): SessionInfo | undefined {
  const wanted = to.trim();
  const lower = wanted.toLowerCase();
  const inCwd = sessions.filter((session) => sameCwd(session.cwd, cwd));
  return inCwd.find((session) => session.piSessionId === wanted || session.id === wanted)
    ?? inCwd.find((session) => session.name?.toLowerCase() === lower);
}
