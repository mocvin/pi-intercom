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

export function cwdAllowed(config: WakeConfig, cwd: string): boolean {
  return config.allowCwds.some((allowed) => sameCwd(allowed, cwd));
}

export type LimitFailure = { code: "duplicate" | "rate_limited_target" | "rate_limited_global"; detail: string };

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
