import { randomUUID } from "crypto";
import { isAbsolute, resolve } from "path";
import type { SendResult } from "../broker/client.ts";
import type { WakeConfig } from "../config.ts";
import type { Attachment, MessageReceipt, SessionInfo, WakeTarget } from "../types.ts";
import { WAKE_FEATURE } from "../types.ts";
import { sameCwd } from "../cwd.ts";
import { WakeAudit, sha256, type WakeAuditEntry, type WakeOutcome } from "./audit.ts";
import { checkArchiveLimit, checkLimits, checkMessage, checkSpawnLimit, clip, clipMiddle, createdBySpawn, cwdAllowed, dialogBody, findOwnSpawn } from "./policy.ts";
import { SAFE_MESSAGE_ID, SAFE_SESSION_ID, WakeError, type WakeProvider } from "./provider.ts";
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
  /** Ask the user; undefined when there is no UI, which blocks the wake unless confirm is "never" or the sender is trusted. */
  confirm?: (title: string, body: string) => Promise<boolean>;
  /** /wake-trust grants. A sender with a valid grant is not asked to confirm; every other check still applies. */
  trust?: { find(piSessionId: string, now?: number): { expiresAt: number } | undefined };
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
  /** Create a new session in `cwd` and deliver the message to it, instead of waking an existing one (`to` is ignored). */
  spawn?: boolean;
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

/**
 * Ask the user. A dialog that throws (PI WEB refuses it, the UI is gone) is "failed", never "declined": an error must not be
 * recorded as the user's answer.
 */
async function askUser(confirm: (title: string, body: string) => Promise<boolean>, title: string, body: string): Promise<"approved" | "declined" | "failed"> {
  try {
    return (await confirm(title, body)) ? "approved" : "declined";
  } catch {
    return "failed";
  }
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
  // Read once: a grant revoked while this wake runs still applies to it, never the other way round.
  const trusted = Boolean(deps.trust?.find(deps.self.piSessionId, now()));
  const spawn = request.spawn === true;
  // Waking asks unless the sender is trusted or wake.confirm is "never"; spawning asks according to wake.spawnConfirm,
  // which by default (always) also asks trusted senders: creating a session is a stronger step than waking one.
  const confirmedBy: "user" | "trust" | "config" = spawn
    ? (config.spawnConfirm === "never" ? "config" : config.spawnConfirm === "trusted" && trusted ? "trust" : "user")
    : (trusted ? "trust" : config.confirm === "never" ? "config" : "user");
  const spawnDedupKey = sha256(`spawn\0${resolve(request.cwd || ".")}\0${text}`);

  const entry = (outcome: WakeOutcome, code: string, detail?: string): WakeAuditEntry => ({
    ts: now(),
    kind: spawn ? "spawn" : "wake",
    outcome,
    code,
    messageId,
    target: { ...(target ?? { cwd: request.cwd }) },
    sender: { ...(deps.self.intercomId ? { intercomId: deps.self.intercomId } : {}), piSessionId: deps.self.piSessionId, cwd: deps.self.cwd },
    textLength: text.length,
    textSha256: sha256(text),
    ...(spawn ? { dedupKey: spawnDedupKey } : target ? { dedupKey: sha256(`${target.piSessionId}\0${target.cwd}\0${text}`) } : {}),
    provider: provider?.id ?? config.provider,
    ...((daemon ?? provider?.describe?.()) ? { daemon: daemon ?? provider?.describe?.() } : {}),
    durationMs: now() - started,
    confirmedBy,
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
  if (!config.enabled) return blocked("wake_disabled", spawn ? "Creating sessions is disabled. Set wake.enabled in the intercom config to allow it." : "Waking persisted sessions is disabled. Set wake.enabled in the intercom config to allow it.");
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
  if (spawn && !provider.create) return blocked("spawn_unsupported", `The provider "${provider.id}" cannot create sessions.`);
  if (spawn) {
    try {
      if (createdBySpawn(audit.read(), deps.self.piSessionId)) return blocked("spawn_chain", "This session was itself created by spawn; it cannot create further sessions.");
    } catch (error) {
      return blocked("audit_unavailable", `Cannot read the audit (${error instanceof Error ? error.message : String(error)}); not creating a session.`);
    }
  }
  if (confirmedBy === "user" && !deps.confirm) {
    return blocked("confirmation_unavailable", spawn
      ? "Creating a session needs the user's confirmation and no UI is available. wake.spawnConfirm can be set to \"trusted\" (with /wake-trust on) or \"never\" in the intercom config."
      : "Waking a session needs the user's confirmation and no UI is available. The user can allow this session to wake without confirmation with /wake-trust on.");
  }

  // ---- Resolve the target in the host catalog (read-only).
  let name: string | undefined;
  if (!spawn) try {
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
  if (target?.piSessionId === deps.self.piSessionId) return blocked("self_target", "Cannot wake the current session.");

  // ---- Limits, confirmation, reservation.
  const dedupKey = spawn ? spawnDedupKey : sha256(`${target!.piSessionId}\0${target!.cwd}\0${text}`);
  const limitQuery = { piSessionId: target?.piSessionId ?? "", cwd, dedupKey };
  const limit = checkLimits(config, audit.read(), limitQuery, now()) ?? (spawn ? checkSpawnLimit(config, audit.read(), now()) : undefined);
  if (limit) return blocked(limit.code, limit.detail);

  if (spawn && confirmedBy === "user") {
    const head = `This starts a NEW session in ${clipMiddle(cwd, 160)}. It loads that project's extensions and runs its model, with that project's permissions, on the task below. Requested by session ${clip(deps.self.intercomId ?? deps.self.piSessionId, 40)} (${clipMiddle(deps.self.cwd, 160)}).`;
    const asked = await askUser(deps.confirm!, "Create a session in another project?", dialogBody(head, text));
    if (asked === "failed") return blocked("confirmation_failed", "The confirmation dialog could not be shown, so no session was created. This is not a refusal by the user; try again, or tell the user.");
    if (asked === "declined") return done(false, "refused", "user_declined", "Session creation cancelled by the user.");
  }

  if (!spawn && confirmedBy === "user") {
    // The text is bounded: PI WEB rejects a dialog over 1000 characters, and that used to be recorded as a refusal.
    const head = `This loads the saved session${name ? ` "${clip(name, 80)}"` : ""} (${target?.piSessionId}) in ${clipMiddle(cwd, 160)} and delivers this message to it. The session runs its extensions and then answers the message with its model. If the session is already open in PI WEB with questions waiting for the user (ask_user), those questions are closed as unanswered.`;
    const asked = await askUser(deps.confirm!, "Wake a persisted session?", dialogBody(head, text));
    if (asked === "failed") return blocked("confirmation_failed", "The confirmation dialog could not be shown, so nothing was sent. This is not a refusal by the user; try again, or tell the user.");
    if (asked === "declined") return done(false, "refused", "user_declined", "Wake cancelled by the user.");
  }

  try {
    audit.append(entry("attempting", "reserved"));
  } catch (error) {
    return { ok: false, outcome: "blocked", code: "audit_unavailable", text: `Cannot record the wake in the audit (${error instanceof Error ? error.message : String(error)}); not waking.`, messageId, target };
  }
  // Re-check with our own reservation counted, so two sessions racing cannot both pass the limits.
  const recheck = checkLimits(config, audit.read(), limitQuery, now(), messageId) ?? (spawn ? checkSpawnLimit(config, audit.read(), now(), messageId) : undefined);
  if (recheck) return done(false, "failed", recheck.code, recheck.detail);

  // ---- Spawn: create the empty session first; the message follows the same path as a wake of a loaded session.
  if (spawn) {
    try {
      const createSignal = AbortSignal.any([AbortSignal.timeout(config.wakeTimeoutMs), ...(request.signal ? [request.signal] : [])]);
      const created = await provider.create!(cwd, createSignal);
      daemon = provider.describe?.();
      target = { piSessionId: created.piSessionId, cwd };
    } catch (error) {
      const createError = error instanceof WakeError ? error : new WakeError("timeout", error instanceof Error ? error.message : String(error));
      return done(false, "failed", `provider_${createError.code}`, `No session was created: ${createError.message}${createError.definitive ? "" : ". The outcome is unknown: a new empty session may exist in that project; the message was not sent"}.`);
    }
  }
  if (!target) return done(false, "failed", "internal", "No target session.");

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
      return done(true, "already_connected", "already_connected", spawn
        ? `Created session ${target.piSessionId} in ${cwd}; it had already connected and the message was delivered.`
        : `Session ${target.piSessionId} was already connected; the message was delivered normally.`);
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
      if (spawn) return done(true, "delivered", "delivered", `Created session ${target.piSessionId} in ${cwd} and delivered the message (${receipts[0]}). Its reply, if any, arrives through intercom.`);
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

export interface ArchiveRequest {
  piSessionId: string;
  cwd: string;
  signal?: AbortSignal;
}

export interface ArchiveResult {
  ok: boolean;
  outcome: WakeOutcome;
  code: string;
  text: string;
  target: { piSessionId: string; cwd: string };
}

/**
 * Archive a session that `spawn` created, on behalf of the session that created it. The user is ALWAYS asked:
 * no setting and no /wake-trust grant removes the dialog, and without a UI nothing happens.
 * The host archives reversibly (nothing is deleted) and refuses a session that is working.
 */
export async function performArchive(deps: Omit<WakeDeps, "client">, request: ArchiveRequest): Promise<ArchiveResult> {
  const { config, provider, audit } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const messageId = randomUUID();
  const cwd = request.cwd && isAbsolute(request.cwd) ? resolve(request.cwd) : request.cwd;
  const target = { piSessionId: request.piSessionId, cwd };
  let daemon: string | undefined;

  const entry = (outcome: WakeOutcome, code: string, detail?: string): WakeAuditEntry => ({
    ts: now(),
    kind: "archive",
    outcome,
    code,
    messageId,
    target: { ...target },
    sender: { ...(deps.self.intercomId ? { intercomId: deps.self.intercomId } : {}), piSessionId: deps.self.piSessionId, cwd: deps.self.cwd },
    textLength: 0,
    textSha256: sha256(""),
    provider: provider?.id ?? config.provider,
    ...((daemon ?? provider?.describe?.()) ? { daemon: daemon ?? provider?.describe?.() } : {}),
    durationMs: now() - started,
    confirmedBy: "user",
    ...(detail ? { detail: detail.slice(0, 300) } : {}),
  });
  const done = (ok: boolean, outcome: WakeOutcome, code: string, text: string): ArchiveResult => {
    try {
      audit.append(entry(outcome, code, text));
    } catch {
      // The refusal already stopped the action; a failed audit write must not hide the reason.
    }
    return { ok, outcome, code, text, target };
  };
  const blocked = (code: string, text: string) => done(false, "blocked", code, text);

  if (!config.enabled) return blocked("wake_disabled", "Archiving is disabled. Set wake.enabled in the intercom config to allow it.");
  if (!provider) return blocked("provider_missing", `No wake provider "${config.provider}" is available.`);
  if (!provider.archive) return blocked("archive_unsupported", `The provider "${provider.id}" cannot archive sessions.`);
  if (!SAFE_SESSION_ID.test(request.piSessionId)) return blocked("invalid_session_id", "archive needs the full Pi session id of a session that spawn created.");
  if (!cwd || !isAbsolute(cwd)) return blocked("invalid_cwd", "archive needs the session's absolute working directory (cwd).");
  if (!cwdAllowed(config, cwd)) return blocked("cwd_not_allowed", `${cwd} is not in wake.allowCwds.`);
  if (request.piSessionId === deps.self.piSessionId) return blocked("self_target", "Cannot archive the current session.");
  // The user is always asked; nothing else can stand in for the dialog.
  if (!deps.confirm) return blocked("confirmation_unavailable", "Archiving a session needs the user's confirmation, always, and no UI is available.");

  let spawned: WakeAuditEntry | undefined;
  try {
    const entries = audit.read();
    spawned = findOwnSpawn(entries, deps.self.piSessionId, request.piSessionId, cwd);
    if (!spawned) return blocked("not_created_by_you", "Only a session that this session created with spawn can be archived. Anything else is archived by the user in PI WEB.");
    const limit = checkArchiveLimit(config, entries, now());
    if (limit) return blocked(limit.code, limit.detail);
  } catch (error) {
    return blocked("audit_unavailable", `Cannot read the audit (${error instanceof Error ? error.message : String(error)}); not archiving.`);
  }

  const asked = await askUser(
    deps.confirm,
    "Archive a session?",
    dialogBody(`Archive the session ${request.piSessionId} in ${clipMiddle(cwd, 160)}, which session ${clip(deps.self.intercomId ?? deps.self.piSessionId, 40)} created with spawn on ${new Date(spawned.ts).toISOString()}. It is closed and moved to the archive: nothing is deleted, and you can restore it in PI WEB. If it is working, the archive is refused.`, ""),
  );
  if (asked === "failed") return blocked("confirmation_failed", "The confirmation dialog could not be shown, so nothing was archived. This is not a refusal by the user; try again, or tell the user.");
  if (asked === "declined") return done(false, "refused", "user_declined", "Archiving cancelled by the user.");

  try {
    audit.append(entry("attempting", "reserved"));
  } catch (error) {
    return { ok: false, outcome: "blocked", code: "audit_unavailable", text: `Cannot record the archive in the audit (${error instanceof Error ? error.message : String(error)}); not archiving.`, target };
  }
  try {
    const signal = AbortSignal.any([AbortSignal.timeout(config.wakeTimeoutMs), ...(request.signal ? [request.signal] : [])]);
    await provider.archive(target, signal);
  } catch (error) {
    const archiveError = error instanceof WakeError ? error : new WakeError("timeout", error instanceof Error ? error.message : String(error));
    return done(false, "failed", `provider_${archiveError.code}`, archiveError.definitive
      ? `The session was not archived: ${archiveError.message}.`
      : `The outcome is unknown (${archiveError.message}); check in PI WEB whether the session is archived.`);
  }
  return done(true, "archived", "archived", `Archived session ${request.piSessionId} in ${cwd}. It was closed and can be restored from the archive in PI WEB.`);
}
