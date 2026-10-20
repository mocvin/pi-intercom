import { appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { createHash } from "crypto";
import { getIntercomDirPath } from "../broker/paths.ts";

export type WakeOutcome =
  | "attempting"          // reservation written before the host is asked; counts toward limits
  | "delivered"           // the woken session confirmed receipt
  | "already_connected"   // the target connected first; ordinary delivery
  | "accepted_unconfirmed" // the host accepted the wake but no receipt arrived in time
  | "uncertain"           // the host's answer is unknown; the message stays held
  | "failed"              // the host refused; the held message was withdrawn
  | "refused"             // the user declined
  | "blocked"             // a policy or validation check stopped it before anything was held
  | "trust_granted"       // the user allowed a session to wake others without confirmation (/wake-trust on)
  | "trust_revoked";      // the user removed that permission

export interface WakeAuditEntry {
  ts: number;
  outcome: WakeOutcome;
  code: string;
  messageId: string;
  target: { piSessionId?: string; cwd?: string; name?: string };
  sender: { intercomId?: string; piSessionId?: string; cwd?: string };
  textLength: number;
  /** SHA-256 of the message text; the text itself is never stored. */
  textSha256: string;
  /** SHA-256 over target and text, for the duplicate check. */
  dedupKey?: string;
  provider?: string;
  daemon?: string;
  durationMs?: number;
  /** How the wake was approved: the user in a dialog, a /wake-trust grant, or wake.confirm = "never". */
  confirmedBy?: "user" | "trust" | "config";
  /** Short, content-free diagnostic. Never the message text. */
  detail?: string;
}

export const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function wakeAuditPath(intercomDir: string = getIntercomDirPath()): string {
  return join(intercomDir, "wake-audit.jsonl");
}

/** Append-only JSONL audit of wake attempts, shared by every session of the user. Mode 0600; bounded by entries and age. */
export class WakeAudit {
  constructor(
    readonly path: string = wakeAuditPath(),
    private readonly maxEntries = 1000,
    private readonly retentionMs = 30 * 24 * 60 * 60 * 1000,
  ) {}

  private ensureFile(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) {
      writeFileSync(this.path, "", { mode: 0o600 });
    }
    if (process.platform !== "win32") chmodSync(this.path, 0o600);
  }

  /** Throws when the entry cannot be recorded: callers fail closed, because the limits depend on this file. */
  append(entry: WakeAuditEntry): void {
    this.ensureFile();
    const fd = openSync(this.path, "a", 0o600);
    try {
      appendFileSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.pruneIfNeeded();
  }

  read(): WakeAuditEntry[] {
    if (!existsSync(this.path)) return [];
    const entries: WakeAuditEntry[] = [];
    for (const line of readFileSync(this.path, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as WakeAuditEntry;
        if (typeof parsed.ts === "number" && typeof parsed.outcome === "string" && typeof parsed.messageId === "string") entries.push(parsed);
      } catch {
        // A torn line must not stop the audit from being read.
      }
    }
    return entries;
  }

  private pruneIfNeeded(): void {
    const entries = this.read();
    const cutoff = Date.now() - this.retentionMs;
    const kept = entries.filter((entry) => entry.ts >= cutoff).slice(-this.maxEntries);
    if (kept.length === entries.length) return;
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}
