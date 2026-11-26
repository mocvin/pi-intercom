import { closeSync, openSync, readSync } from "fs";
import { basename, isAbsolute, resolve, sep } from "path";
import { sameCwd } from "../cwd.ts";
import type { WakeCandidate } from "./provider.ts";

/**
 * Tracked subsessions of the current session, as PI WEB records them. PI WEB writes `pi-web.subsession.link` entries in
 * the PARENT (spawnedBySessionId, spawnedSessionId, spawnedSessionFile) and a `pi-web.subsession.spawned` entry in the
 * child, outside the model's context, and delivers a `subsession.completion` message to the parent when a child stops
 * working. This module only reads the parent's own entries: it never trusts what a model says about its children.
 */
export const SUBSESSION_LINK = "pi-web.subsession.link";
export const SUBSESSION_COMPLETION = "subsession.completion";
/** Entry the `keep` action writes in the parent: a child marked keep is never archived automatically. */
export const KEEP_ENTRY = "intercom_keep";

export interface EntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
  timestamp?: string;
}

export interface TrackedChild {
  piSessionId: string;
  /** Saved file of the child as recorded in the parent's link entry. */
  file: string;
}

export interface OwnedChild {
  piSessionId: string;
  cwd: string;
  file?: string;
  via: "subsession";
}

const rec = (value: unknown): Record<string, unknown> | undefined => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined);

/** Direct children this session spawned with spawn_subsession, from its own entries (later links of the same id win). */
export function trackedChildren(entries: readonly EntryLike[], selfId: string): TrackedChild[] {
  const found = new Map<string, TrackedChild>();
  for (const entry of entries) {
    if (entry.customType !== SUBSESSION_LINK) continue;
    const data = rec(entry.data);
    if (!data || data.spawnedBySessionId !== selfId) continue;
    const id = data.spawnedSessionId;
    if (typeof id !== "string" || !id) continue;
    found.set(id, { piSessionId: id, file: typeof data.spawnedSessionFile === "string" ? data.spawnedSessionFile : "" });
  }
  return [...found.values()];
}

/** When PI WEB last told this parent that each child stopped working (latest notice per child, epoch ms). */
export function completionTimes(entries: readonly EntryLike[]): Map<string, number> {
  const times = new Map<string, number>();
  for (const entry of entries) {
    if (entry.customType !== SUBSESSION_COMPLETION) continue;
    const id = rec(entry.details)?.sessionId;
    const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
    if (typeof id !== "string" || !Number.isFinite(at)) continue;
    if (at > (times.get(id) ?? 0)) times.set(id, at);
  }
  return times;
}

/** Children the parent marked keep (the latest keep/unkeep entry of each id wins). */
export function keptChildren(entries: readonly EntryLike[]): Set<string> {
  const kept = new Set<string>();
  for (const entry of entries) {
    if (entry.customType !== KEEP_ENTRY) continue;
    const data = rec(entry.data);
    if (!data || typeof data.id !== "string") continue;
    if (data.keep === false) kept.delete(data.id);
    else kept.add(data.id);
  }
  return kept;
}

/**
 * The directory of a child, from the first line of its saved file. The file is only read when it is inside the agent's
 * session directory and its header agrees with the link: same id, and a parent that is this session.
 */
export function readChildHeader(child: TrackedChild, selfId: string, sessionsRoot: string): { cwd: string } | undefined {
  if (!child.file || !isAbsolute(child.file)) return undefined;
  const file = resolve(child.file);
  const root = resolve(sessionsRoot);
  if (!file.startsWith(root + sep) || !file.endsWith(`_${child.piSessionId}.jsonl`)) return undefined;
  let text: string;
  try {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(16 * 1024);
      text = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  try {
    const header = JSON.parse(text.split("\n", 1)[0] ?? "") as Record<string, unknown>;
    const parent = typeof header.parentSession === "string" ? basename(header.parentSession) : "";
    if (header.type !== "session" || header.id !== child.piSessionId || !parent.endsWith(`_${selfId}.jsonl`)) return undefined;
    if (typeof header.cwd !== "string" || !isAbsolute(header.cwd)) return undefined;
    return { cwd: header.cwd };
  } catch {
    return undefined;
  }
}

export interface AutoArchiveCandidate {
  piSessionId: string;
  cwd: string;
  name?: string;
}

export interface SelectInput {
  now: number;
  children: Array<TrackedChild & { cwd: string }>;
  completions: Map<string, number>;
  kept: Set<string>;
  catalogs: Map<string, WakeCandidate[]>;
  minIdleMs: number;
  /** Children already given up on after repeated failures. */
  gaveUp: Set<string>;
}

/**
 * Finished children that may be archived: PI WEB delivered their completion notice, nothing happened since, they have been
 * idle for minIdleMs, they are saved, not archived, not marked keep, and have no live descendants of their own.
 */
export function selectAutoArchiveCandidates(input: SelectInput): { candidates: AutoArchiveCandidate[]; skipped: Array<{ piSessionId: string; reason: string }> } {
  const candidates: AutoArchiveCandidate[] = [];
  const skipped: Array<{ piSessionId: string; reason: string }> = [];
  for (const child of input.children) {
    const skip = (reason: string) => skipped.push({ piSessionId: child.piSessionId, reason });
    if (input.gaveUp.has(child.piSessionId)) { skip("gave_up"); continue; }
    if (input.kept.has(child.piSessionId)) { skip("keep"); continue; }
    const completedAt = input.completions.get(child.piSessionId);
    if (completedAt === undefined) { skip("no_completion_notice"); continue; }
    if (input.now - completedAt < input.minIdleMs) { skip("too_recent"); continue; }
    const catalog = [...input.catalogs].find(([cwd]) => sameCwd(cwd, child.cwd))?.[1];
    const entry = catalog?.find((item) => item.piSessionId === child.piSessionId);
    if (!entry || entry.persisted === false) { skip("not_saved"); continue; }
    if (entry.archived) { skip("already_archived"); continue; }
    const modified = entry.modified ? Date.parse(entry.modified) : NaN;
    // Anything written after the completion notice (a new task for the child) means it is not finished.
    if (!Number.isFinite(modified)) { skip("unknown_activity"); continue; }
    if (modified > completedAt + 60_000) { skip("active_since_completion"); continue; }
    if (input.now - modified < input.minIdleMs) { skip("too_recent"); continue; }
    const childFile = entry.path ?? child.file;
    const hasLiveDescendant = catalog!.some((other) => !other.archived && other.piSessionId !== entry.piSessionId && other.parentSessionPath !== undefined && childFile !== "" && basename(other.parentSessionPath) === basename(childFile));
    if (hasLiveDescendant) { skip("has_descendants"); continue; }
    candidates.push({ piSessionId: child.piSessionId, cwd: child.cwd, ...(entry.name ? { name: entry.name } : {}) });
  }
  return { candidates, skipped };
}
