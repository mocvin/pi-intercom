/**
 * Keep an open `ask_user` form alive while intercom messages arrive.
 *
 * PI WEB cancels the session's open form (and the user's partial answers) whenever a message with role `user` starts in the
 * session, and a model turn can open a new form that replaces it. A plain intercom message used to start such a turn (and, on
 * Pi before 1.2, a synthetic user message). While a form is open the message is now delivered the way `inboundTrigger: "never"`
 * delivers it: visible in the transcript, in the model's context for the turn the form's answers start, and with NO turn of
 * its own.
 *
 * ONLY FOR THE OLD FORM MODEL. PI WEB before 1.202610.2 keeps one "pending ask" per session in memory and cancels it on a user
 * message. From 1.202610.2 on a form is a durable transcript entry: answers and skips are ordinary replies, nothing is
 * cancelled, and the status has no `pendingAsk`. Holding messages there would only delay them, so the shield applies only
 * when the session daemon is known to be older than that (see askModelOf); unknown means off.
 *
 * The form is recognised from the session's own entries, as PI WEB writes them: an `ask_user` tool result carrying
 * `details.ask.askId` opens it, a `pi-web.ask.answers` custom message with the same `details.askId` closes it (answered,
 * cancelled, or voided). Every doubt resolves to "no form open": a message is then delivered as before.
 */
export const ASK_ANSWERS_CUSTOM_TYPE = "pi-web.ask.answers";

export interface AskEntryLike {
  type?: string;
  customType?: string;
  details?: unknown;
  message?: { role?: string; toolName?: string; isError?: boolean; details?: unknown };
  timestamp?: string;
}

export interface OpenAsk {
  askId: string;
  /** When the form was posted (epoch ms). */
  postedAt: number;
}

const rec = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined);

/** The latest form that was posted and has no closing entry, from the session's own entries. */
export function findOpenAsk(entries: readonly AskEntryLike[]): OpenAsk | undefined {
  const closed = new Set<string>();
  let latest: OpenAsk | undefined;
  for (const entry of entries) {
    if (entry.type === "custom_message" && entry.customType === ASK_ANSWERS_CUSTOM_TYPE) {
      const id = rec(entry.details)?.askId;
      if (typeof id === "string") closed.add(id);
      continue;
    }
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "toolResult" || message.toolName !== "ask_user" || message.isError === true) continue;
    const ask = rec(rec(message.details)?.ask);
    const askId = ask?.askId;
    if (typeof askId !== "string" || !askId) continue;
    const at = Date.parse(typeof ask?.askedAt === "string" ? ask.askedAt : entry.timestamp ?? "");
    if (!Number.isFinite(at)) continue;
    latest = { askId, postedAt: at };
  }
  return latest && !closed.has(latest.askId) ? latest : undefined;
}

/** `[URGENTE]` (or `[URGENT]`) at the start of a message: the sender says it cannot wait. */
export function isUrgentMessage(text: string): boolean {
  return /^\s*(?:\[[^\]]{0,40}\]\s*)?\[(?:URGENTE|URGENT)\]/i.test(text.slice(0, 120));
}

/** The first PI WEB version where a form is a durable entry and an intercom message can no longer cancel it. */
export const DURABLE_FORMS_FROM = [1, 202610, 2] as const;

/**
 * Which form model the session daemon uses, from its runtime version (`1.202610.1`): `legacy` (an open form that a user
 * message cancels), `durable` (nothing to protect), or undefined when it cannot be told.
 */
export function askModelOf(runtimeVersion: string | undefined): "legacy" | "durable" | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(runtimeVersion ?? "");
  if (!match) return undefined;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) {
    if (version[i]! !== DURABLE_FORMS_FROM[i]) return version[i]! < DURABLE_FORMS_FROM[i]! ? "legacy" : "durable";
  }
  return "durable";
}

/** What the session daemon says about the form: open or not, or nothing known. */
export type DaemonVerdict = { open: boolean; askId?: string; at: number };

export interface ShieldDecision {
  shield: boolean;
  askId?: string;
  /** Why the message is not shielded (or how it was decided), for diagnostics and tests. */
  reason: string;
  /** The daemon's opinion is missing or old: the caller may refresh it (asynchronously). */
  needsVerification?: boolean;
}

export interface ShieldOptions {
  /** The daemon's form model. Anything but `legacy` means there is nothing to protect. */
  askModel: "legacy" | "durable" | undefined;
  enabled: boolean;
  maxAgeMs: number;
  /** A verdict younger than this is used as is. */
  verdictTtlMs: number;
}

/**
 * Whether an incoming message must be kept from starting a turn. Rules, in order:
 *  - off in config, or no open form in the entries: deliver as before;
 *  - the form is older than maxAgeMs: stale, deliver as before;
 *  - the daemon said the form is not open (a fresh verdict): it died with a restart, deliver as before;
 *  - a form posted before this runtime started counts only if the daemon confirmed it is open (the session may have been
 *    reloaded or restored, and PI WEB keeps open forms only in memory);
 *  - otherwise shield.
 */
export function decideShield(input: {
  entries: readonly AskEntryLike[];
  now: number;
  runtimeStartedAt: number;
  verdicts: ReadonlyMap<string, DaemonVerdict>;
  options: ShieldOptions;
}): ShieldDecision {
  const { options } = input;
  if (!options.enabled) return { shield: false, reason: "disabled" };
  if (options.askModel !== "legacy") return { shield: false, reason: options.askModel === "durable" ? "host_has_durable_forms" : "host_unknown" };
  const open = findOpenAsk(input.entries);
  if (!open) return { shield: false, reason: "no_open_form" };
  if (input.now - open.postedAt > options.maxAgeMs) return { shield: false, askId: open.askId, reason: "stale" };
  const verdict = input.verdicts.get(open.askId);
  const fresh = verdict !== undefined && input.now - verdict.at <= options.verdictTtlMs;
  if (fresh && !verdict.open) return { shield: false, askId: open.askId, reason: "daemon_says_closed" };
  if (open.postedAt < input.runtimeStartedAt && !(fresh && verdict.open)) {
    return { shield: false, askId: open.askId, reason: "posted_before_this_runtime_unconfirmed", needsVerification: true };
  }
  return { shield: true, askId: open.askId, reason: "open_form", ...(!fresh ? { needsVerification: true } : {}) };
}
