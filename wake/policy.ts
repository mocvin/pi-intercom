import { sameCwd } from "../cwd.ts";
import type { WakeConfig } from "../config.ts";
import type { WakeAuditEntry } from "./audit.ts";

export const MAX_WAKE_MESSAGE_BYTES = 32 * 1024;

/** Patterns that are almost never intended in a message to another agent. Best effort, not a guarantee. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["AWS access key id", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer credential", /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/],
  ["password assignment", /\b(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["']?[^\s"']{8,}/i],
];

export function findSecretLikeContent(text: string): string | undefined {
  for (const [label, pattern] of SECRET_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return undefined;
}

export function checkMessage(text: string): { ok: true } | { ok: false; code: string; detail: string } {
  if (!text.trim()) return { ok: false, code: "empty_message", detail: "The message is empty." };
  if (Buffer.byteLength(text, "utf8") > MAX_WAKE_MESSAGE_BYTES) {
    return { ok: false, code: "message_too_large", detail: `The message exceeds ${MAX_WAKE_MESSAGE_BYTES} bytes.` };
  }
  const secret = findSecretLikeContent(text);
  if (secret) return { ok: false, code: "possible_secret", detail: `The message looks like it contains a secret (${secret}). Remove it; secrets are never sent to a woken session.` };
  return { ok: true };
}

/**
 * PI WEB refuses a confirmation dialog whose text is longer than 1000 characters (EXTENSION_DIALOG_TEXT_MAX_LENGTH) and the
 * extension's confirm() then rejects. Stay clearly under it, whatever the name, the directory, or the message look like.
 */
export const DIALOG_TEXT_BUDGET = 900;

/** Cut at `max` UTF-16 units without leaving half a surrogate pair, adding an ellipsis when something was cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 1));
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Keep the start and the end of a long path: the end is the part that tells projects apart. */
export function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const keep = Math.max(2, max - 1);
  const head = Math.ceil(keep / 3);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

/** `head`, a blank line, then as much of `message` as fits: the whole dialog never exceeds DIALOG_TEXT_BUDGET. */
export function dialogBody(head: string, message: string): string {
  const room = DIALOG_TEXT_BUDGET - head.length - 2;
  if (!message.trim()) return clip(head, DIALOG_TEXT_BUDGET);
  if (room < 40) return clip(head, DIALOG_TEXT_BUDGET);
  return `${head}\n\n${clip(message, room)}`;
}

export function cwdAllowed(config: WakeConfig, cwd: string): boolean {
  return config.allowCwds.some((allowed) => sameCwd(allowed, cwd));
}

export type LimitFailure = { code: "duplicate" | "rate_limited_target" | "rate_limited_global" | "rate_limited_spawn" | "rate_limited_archive"; detail: string };

/**
 * Check the duplicate window and the rate limits against the shared audit.
 * A reservation (`attempting`) counts until its attempt finishes with `failed` (the host refused, so nothing happened).
 */
export function checkLimits(
  config: WakeConfig,
  entries: WakeAuditEntry[],
  query: { piSessionId: string; cwd: string; dedupKey: string },
  now: number,
  ownMessageId?: string,
): LimitFailure | undefined {
  const finals = new Map<string, WakeAuditEntry>();
  for (const entry of entries) if (entry.outcome !== "attempting") finals.set(entry.messageId, entry);
  const counted = entries.filter((entry) => entry.outcome === "attempting" && finals.get(entry.messageId)?.outcome !== "failed");

  const duplicate = counted.find((entry) => entry.dedupKey === query.dedupKey && entry.messageId !== ownMessageId && now - entry.ts < config.dedupMs);
  if (duplicate) {
    return { code: "duplicate", detail: `The same message to this session was already sent ${Math.max(1, Math.round((now - duplicate.ts) / 1000))}s ago.` };
  }
  const perTarget = counted.filter((entry) => entry.target.piSessionId === query.piSessionId && sameCwdLoose(entry.target.cwd, query.cwd) && now - entry.ts < config.perTargetWindowMs).length;
  if (perTarget > config.perTargetMax - (ownMessageId ? 0 : 1)) {
    return { code: "rate_limited_target", detail: `At most ${config.perTargetMax} wakes per ${Math.round(config.perTargetWindowMs / 60_000)} minutes for one session.` };
  }
  const global = counted.filter((entry) => now - entry.ts < config.globalWindowMs).length;
  if (global > config.globalMax - (ownMessageId ? 0 : 1)) {
    return { code: "rate_limited_global", detail: `At most ${config.globalMax} wakes per ${Math.round(config.globalWindowMs / 60_000)} minutes in total.` };
  }
  return undefined;
}

function sameCwdLoose(a: string | undefined, b: string): boolean {
  return a !== undefined && sameCwd(a, b);
}

/** Entries that are an active spawn attempt: reserved and not later marked failed. */
function countedSpawns(entries: WakeAuditEntry[]): WakeAuditEntry[] {
  const finals = new Map<string, WakeAuditEntry>();
  for (const entry of entries) if (entry.outcome !== "attempting") finals.set(entry.messageId, entry);
  return entries.filter((entry) => entry.kind === "spawn" && entry.outcome === "attempting" && finals.get(entry.messageId)?.outcome !== "failed");
}

/** At most spawnMax sessions created per spawnWindowMs, across every sender. `ownMessageId` is our own reservation, already written. */
export function checkSpawnLimit(config: WakeConfig, entries: WakeAuditEntry[], now: number, ownMessageId?: string): LimitFailure | undefined {
  const recent = countedSpawns(entries).filter((entry) => now - entry.ts < config.spawnWindowMs).length;
  if (recent > config.spawnMax - (ownMessageId ? 0 : 1)) {
    return { code: "rate_limited_spawn", detail: `At most ${config.spawnMax} sessions can be created per ${Math.round(config.spawnWindowMs / 60_000)} minutes.` };
  }
  return undefined;
}

/** At most archiveMax archive actions per spawnWindowMs, across every sender. */
export function checkArchiveLimit(config: WakeConfig, entries: WakeAuditEntry[], now: number): LimitFailure | undefined {
  const recent = entries.filter((entry) => entry.kind === "archive" && entry.outcome === "attempting" && now - entry.ts < config.spawnWindowMs).length;
  if (recent > config.archiveMax - 1) {
    return { code: "rate_limited_archive", detail: `At most ${config.archiveMax} sessions can be archived per ${Math.round(config.spawnWindowMs / 60_000)} minutes.` };
  }
  return undefined;
}

/**
 * The spawn that created a session, if it is one this sender may archive: the sender must be the session that created it,
 * the directory must match, and the creation must have gone through (a failed delivery still leaves the empty session).
 */
export function findOwnSpawn(entries: WakeAuditEntry[], sender: string, piSessionId: string, cwd: string): WakeAuditEntry | undefined {
  return entries.find((entry) => entry.kind === "spawn" && entry.outcome !== "attempting" && entry.outcome !== "blocked" && entry.outcome !== "refused"
    && entry.target.piSessionId === piSessionId && entry.sender.piSessionId === sender && entry.target.cwd !== undefined && sameCwd(entry.target.cwd, cwd));
}

/** A session that was itself created by spawn cannot create others: no chains of agents starting agents. */
export function createdBySpawn(entries: WakeAuditEntry[], piSessionId: string): boolean {
  return entries.some((entry) => entry.kind === "spawn" && entry.target.piSessionId === piSessionId);
}
