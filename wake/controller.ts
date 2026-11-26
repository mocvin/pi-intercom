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
import type { OwnedChild } from "./children.ts";

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

/** What archiving needs beyond a wake: the sender's own tracked subsessions, and (for the automatic path) its /archive-trust grant. */
export interface ArchiveDeps extends Omit<WakeDeps, "client"> {
  /** Direct tracked subsessions of the sender (spawn_subsession), read from its own entries. */
  children?: OwnedChild[];
  archiveTrust?: { find(piSessionId: string, now?: number): { expiresAt: number } | undefined };
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
export async function performArchive(deps: ArchiveDeps, request: ArchiveRequest): Promise<ArchiveResult> {
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
  let tracked: OwnedChild | undefined;
  try {
    const entries = audit.read();
    spawned = findOwnSpawn(entries, deps.self.piSessionId, request.piSessionId, cwd);
    tracked = spawned ? undefined : deps.children?.find((child) => child.piSessionId === request.piSessionId && sameCwd(child.cwd, cwd));
    if (!spawned && !tracked) return blocked("not_created_by_you", "Only a session that this session created with spawn, or one of its own tracked subsessions (spawn_subsession), can be archived. Anything else is archived by the user in PI WEB.");
    const limit = checkArchiveLimit(config, entries, now());
    if (limit) return blocked(limit.code, limit.detail);
  } catch (error) {
    return blocked("audit_unavailable", `Cannot read the audit (${error instanceof Error ? error.message : String(error)}); not archiving.`);
  }

  const asked = await askUser(
    deps.confirm,
    "Archive a session?",
    dialogBody(`Archive the session ${request.piSessionId} in ${clipMiddle(cwd, 160)}, ${spawned ? `which session ${clip(deps.self.intercomId ?? deps.self.piSessionId, 40)} created with spawn on ${new Date(spawned.ts).toISOString()}` : `one of the tracked subsessions of ${clip(deps.self.intercomId ?? deps.self.piSessionId, 40)} (spawn_subsession)`}. It is closed and moved to the archive: nothing is deleted, and you can restore it in PI WEB. If it is working, the archive is refused.`, ""),
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

export interface ArchiveManyRequest {
  ids: string[];
  signal?: AbortSignal;
}

export interface ArchiveManyItem {
  piSessionId: string;
  cwd?: string;
  name?: string;
  ok: boolean;
  code: string;
  text: string;
}

export interface ArchiveManyResult {
  ok: boolean;
  code: string;
  text: string;
  results: ArchiveManyItem[];
}

export const MAX_ARCHIVE_BATCH = 10;

function idleText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes < 90 ? `${minutes}m` : minutes < 48 * 60 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)}d`;
}

/**
 * Archive several sessions with ONE confirmation that lists them. Only sessions this sender created with spawn or that are its own
 * tracked subsessions; each must be saved, not archived yet, and idle for wake.archiveMinIdleMs. The host refuses a working
 * session on its own, and each session gets its own result and audit entries. The user is always asked.
 */
export async function performArchiveMany(deps: ArchiveDeps, request: ArchiveManyRequest): Promise<ArchiveManyResult> {
  const { config, provider, audit } = deps;
  const now = deps.now ?? Date.now;
  const started = now();
  const ids = [...new Set(request.ids.map((id) => id.trim()).filter(Boolean))];
  const results: ArchiveManyItem[] = [];
  const entryFor = (id: string, cwd: string | undefined, name: string | undefined, outcome: WakeOutcome, code: string, detail: string, messageId: string = randomUUID()): WakeAuditEntry => ({
    ts: now(), kind: "archive", outcome, code, messageId,
    target: { piSessionId: id, ...(cwd ? { cwd } : {}), ...(name ? { name } : {}) },
    sender: { ...(deps.self.intercomId ? { intercomId: deps.self.intercomId } : {}), piSessionId: deps.self.piSessionId, cwd: deps.self.cwd },
    textLength: 0, textSha256: sha256(""), provider: provider?.id ?? config.provider, durationMs: now() - started, confirmedBy: "user", detail: detail.slice(0, 300),
  });
  const record = (...entries: WakeAuditEntry[]) => { try { for (const e of entries) audit.append(e); } catch { /* the outcome is reported; an audit write failure must not hide it */ } };
  const stop = (code: string, text: string): ArchiveManyResult => {
    record(entryFor(ids[0] ?? "", undefined, undefined, "blocked", code, text));
    return { ok: false, code, text, results };
  };

  if (!config.enabled) return stop("wake_disabled", "Archiving is disabled. Set wake.enabled in the intercom config to allow it.");
  if (!provider) return stop("provider_missing", `No wake provider "${config.provider}" is available.`);
  if (!provider.archive || !provider.list) return stop("archive_unsupported", `The provider "${provider.id}" cannot archive sessions.`);
  if (ids.length === 0) return stop("no_sessions", "archive needs at least one session id.");
  if (ids.length > MAX_ARCHIVE_BATCH) return stop("too_many", `At most ${MAX_ARCHIVE_BATCH} sessions can be archived with one confirmation.`);
  if (!deps.confirm) return stop("confirmation_unavailable", "Archiving sessions needs the user's confirmation, always, and no UI is available.");

  // Who owns what: sessions this sender created with spawn (audit) or its tracked subsessions (its own entries).
  let entries: WakeAuditEntry[];
  try {
    entries = audit.read();
  } catch (error) {
    return stop("audit_unavailable", `Cannot read the audit (${error instanceof Error ? error.message : String(error)}); not archiving.`);
  }
  const owned = new Map<string, string>();
  for (const id of ids) {
    const spawn = entries.find((e) => e.kind === "spawn" && e.outcome !== "attempting" && e.outcome !== "blocked" && e.outcome !== "refused" && e.target.piSessionId === id && e.sender.piSessionId === deps.self.piSessionId && e.target.cwd);
    const child = deps.children?.find((c) => c.piSessionId === id);
    const cwd = spawn?.target.cwd ?? child?.cwd;
    if (cwd) owned.set(id, cwd);
  }
  const catalogs = new Map<string, Awaited<ReturnType<NonNullable<typeof provider.list>>>>();
  const skip = (id: string, text: string, code: string, cwd?: string, name?: string) => results.push({ piSessionId: id, ...(cwd ? { cwd } : {}), ...(name ? { name } : {}), ok: false, code, text });
  const eligible: Array<{ id: string; cwd: string; name?: string; idleMs: number }> = [];
  for (const id of ids) {
    const cwd = owned.get(id);
    if (id === deps.self.piSessionId) { skip(id, "this is the current session", "self_target"); continue; }
    if (!cwd) { skip(id, "not created by this session with spawn and not one of its tracked subsessions", "not_created_by_you"); continue; }
    if (!cwdAllowed(config, cwd)) { skip(id, `${cwd} is not in wake.allowCwds`, "cwd_not_allowed", cwd); continue; }
    if (!catalogs.has(cwd)) {
      try {
        catalogs.set(cwd, await provider.list(cwd, AbortSignal.any([AbortSignal.timeout(config.listTimeoutMs), ...(request.signal ? [request.signal] : [])])));
      } catch (error) {
        return stop(`provider_${error instanceof WakeError ? error.code : "unavailable"}`, `Cannot look up the sessions: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const item = catalogs.get(cwd)!.find((c) => c.piSessionId === id);
    if (!item || item.persisted === false) { skip(id, "not saved yet (it never answered), so it cannot be archived", "not_saved", cwd, item?.name); continue; }
    if (item.archived) { skip(id, "already archived", "already_archived", cwd, item.name); continue; }
    const modified = item.modified ? Date.parse(item.modified) : NaN;
    if (!Number.isFinite(modified)) { skip(id, "its last activity is unknown", "unknown_activity", cwd, item.name); continue; }
    const idleMs = now() - modified;
    if (idleMs < config.archiveMinIdleMs) { skip(id, `active ${idleText(idleMs)} ago; wait until it has been idle for ${idleText(config.archiveMinIdleMs)}`, "too_recent", cwd, item.name); continue; }
    eligible.push({ id, cwd, ...(item.name ? { name: item.name } : {}), idleMs });
  }
  const summarize = (): string => results.map((r) => `- ${r.name ? `"${clip(r.name, 40)}" ` : ""}${r.piSessionId}: ${r.ok ? "archived" : r.text}`).join("\n");
  if (eligible.length === 0) return stop("nothing_to_archive", `None of the ${ids.length} session(s) can be archived:\n${summarize()}`);

  const recent = entries.filter((e) => e.kind === "archive" && e.outcome === "attempting" && now() - e.ts < config.spawnWindowMs).length;
  if (recent + eligible.length > config.archiveMax) {
    return stop("rate_limited_archive", `At most ${config.archiveMax} sessions can be archived per ${Math.round(config.spawnWindowMs / 60_000)} minutes (${recent} already in this window).`);
  }

  const list = eligible.map((e) => `- ${clip(e.name ?? "(unnamed)", 40)} · ${e.id.slice(0, 13)} · idle ${idleText(e.idleMs)}`).join("\n");
  const asked = await askUser(deps.confirm, `Archive ${eligible.length} session${eligible.length === 1 ? "" : "s"}?`, dialogBody(`Requested by ${clip(deps.self.intercomId ?? deps.self.piSessionId, 40)}. They are closed and moved to the archive: nothing is deleted, and you can restore them in PI WEB. A session that is working is refused.`, list));
  if (asked === "failed") return stop("confirmation_failed", "The confirmation dialog could not be shown, so nothing was archived. This is not a refusal by the user; try again, or tell the user.");
  if (asked === "declined") {
    record(...eligible.map((e) => entryFor(e.id, e.cwd, e.name, "refused", "user_declined", "Archiving cancelled by the user.")));
    return { ok: false, code: "user_declined", text: "Archiving cancelled by the user.", results };
  }

  // One audit reservation per session before the host is asked, so the limit counts them even if this process stops.
  const reserved = new Map<string, string>();
  try {
    for (const e of eligible) { const messageId = randomUUID(); reserved.set(e.id, messageId); audit.append(entryFor(e.id, e.cwd, e.name, "attempting", "reserved", "reserved", messageId)); }
  } catch (error) {
    return stop("audit_unavailable", `Cannot record the archive in the audit (${error instanceof Error ? error.message : String(error)}); not archiving.`);
  }
  for (const e of eligible) {
    try {
      await provider.archive({ piSessionId: e.id, cwd: e.cwd }, AbortSignal.any([AbortSignal.timeout(config.wakeTimeoutMs), ...(request.signal ? [request.signal] : [])]));
      record(entryFor(e.id, e.cwd, e.name, "archived", "archived", "archived", reserved.get(e.id)));
      results.push({ piSessionId: e.id, cwd: e.cwd, ...(e.name ? { name: e.name } : {}), ok: true, code: "archived", text: "archived" });
    } catch (error) {
      const archiveError = error instanceof WakeError ? error : new WakeError("timeout", error instanceof Error ? error.message : String(error));
      const text = archiveError.definitive ? archiveError.message : `outcome unknown (${archiveError.message}); check in PI WEB`;
      record(entryFor(e.id, e.cwd, e.name, "failed", `provider_${archiveError.code}`, text, reserved.get(e.id)));
      results.push({ piSessionId: e.id, cwd: e.cwd, ...(e.name ? { name: e.name } : {}), ok: false, code: `provider_${archiveError.code}`, text });
    }
  }
  const archivedCount = results.filter((r) => r.ok).length;
  return {
    ok: archivedCount > 0,
    code: archivedCount === eligible.length && results.length === eligible.length ? "archived" : archivedCount > 0 ? "partly_archived" : "not_archived",
    text: `Archived ${archivedCount} of ${ids.length} session(s); they were closed and can be restored from the archive in PI WEB.\n${summarize()}`,
    results,
  };
}

export interface AutoArchiveCandidateInput {
  piSessionId: string;
  cwd: string;
  name?: string;
}

export interface AutoArchiveItem {
  piSessionId: string;
  cwd: string;
  name?: string;
  outcome: "archived" | "busy" | "failed" | "skipped";
  code: string;
  /** True when the caller should stop retrying this session. */
  giveUp: boolean;
}

export const AUTO_ARCHIVE_PER_TICK = 3;
export const AUTO_ARCHIVE_GIVE_UP_AFTER = 3;

/**
 * Archive finished tracked subsessions of this session WITHOUT asking, because the user allowed it with /archive-trust and
 * turned wake.autoArchive on. Both are required: the global setting alone grants nothing, and a /wake-trust grant is not
 * consulted. Candidates are chosen by selectAutoArchiveCandidates; this checks the permission again, enforces the hourly cap,
 * asks the host (which refuses a working session: retried later, silently), and audits every archive.
 */
export async function performAutoArchive(
  deps: ArchiveDeps & { attempts: Map<string, number> },
  request: { candidates: AutoArchiveCandidateInput[]; signal?: AbortSignal },
): Promise<{ code: string; items: AutoArchiveItem[] }> {
  const { config, provider, audit } = deps;
  const now = deps.now ?? Date.now;
  const items: AutoArchiveItem[] = [];
  if (!config.enabled) return { code: "wake_disabled", items };
  if (config.autoArchive !== "trusted-children") return { code: "auto_archive_off", items };
  if (!deps.archiveTrust?.find(deps.self.piSessionId, now())) return { code: "not_trusted", items };
  if (!provider?.archive) return { code: "archive_unsupported", items };

  let archivedRecently: number;
  try {
    archivedRecently = audit.read().filter((e) => e.kind === "archive_auto" && e.outcome === "archived" && now() - e.ts < config.spawnWindowMs).length;
  } catch {
    return { code: "audit_unavailable", items };
  }
  let room = Math.min(AUTO_ARCHIVE_PER_TICK, Math.max(0, config.autoArchiveMax - archivedRecently));
  if (room === 0 && request.candidates.length > 0) return { code: "rate_limited_auto_archive", items };

  const entryFor = (c: AutoArchiveCandidateInput, outcome: WakeOutcome, code: string, detail: string): WakeAuditEntry => ({
    ts: now(), kind: "archive_auto", outcome, code, messageId: randomUUID(),
    target: { piSessionId: c.piSessionId, cwd: c.cwd, ...(c.name ? { name: c.name } : {}) },
    sender: { ...(deps.self.intercomId ? { intercomId: deps.self.intercomId } : {}), piSessionId: deps.self.piSessionId, cwd: deps.self.cwd },
    textLength: 0, textSha256: sha256(""), provider: provider.id, confirmedBy: "archive-trust", detail: detail.slice(0, 300),
  });
  const record = (entry: WakeAuditEntry) => { try { audit.append(entry); } catch { /* reported to the caller anyway */ } };

  for (const candidate of request.candidates) {
    if (room === 0) break;
    const base = { piSessionId: candidate.piSessionId, cwd: candidate.cwd, ...(candidate.name ? { name: candidate.name } : {}) };
    if (candidate.piSessionId === deps.self.piSessionId || !cwdAllowed(config, candidate.cwd)) {
      items.push({ ...base, outcome: "skipped", code: candidate.piSessionId === deps.self.piSessionId ? "self_target" : "cwd_not_allowed", giveUp: true });
      continue;
    }
    try {
      await provider.archive({ piSessionId: candidate.piSessionId, cwd: candidate.cwd }, AbortSignal.any([AbortSignal.timeout(config.wakeTimeoutMs), ...(request.signal ? [request.signal] : [])]));
      deps.attempts.delete(candidate.piSessionId);
      record(entryFor(candidate, "archived", "archive_auto", `archived by ${deps.self.piSessionId} under /archive-trust`));
      items.push({ ...base, outcome: "archived", code: "archive_auto", giveUp: false });
      room -= 1;
    } catch (error) {
      const archiveError = error instanceof WakeError ? error : new WakeError("timeout", error instanceof Error ? error.message : String(error));
      if (archiveError.code === "busy") {
        items.push({ ...base, outcome: "busy", code: "provider_busy", giveUp: false });
        continue;
      }
      const tries = (deps.attempts.get(candidate.piSessionId) ?? 0) + 1;
      deps.attempts.set(candidate.piSessionId, tries);
      const giveUp = tries >= AUTO_ARCHIVE_GIVE_UP_AFTER;
      if (giveUp) record(entryFor(candidate, "failed", `provider_${archiveError.code}`, `gave up after ${tries} attempts: ${archiveError.message}`));
      items.push({ ...base, outcome: "failed", code: `provider_${archiveError.code}`, giveUp });
    }
  }
  return { code: "ok", items };
}
