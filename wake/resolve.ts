import { sameCwd } from "../cwd.ts";
import type { WakeCandidate } from "./provider.ts";

export type ResolveFailure = "not_found" | "ambiguous" | "archived";

export type ResolveResult =
  | { ok: true; candidate: WakeCandidate }
  | { ok: false; code: ResolveFailure; detail: string };

/**
 * Pick the one persisted session `to` names inside `cwd`.
 * An exact full Pi session id wins. A name is accepted only when it is exact (case-insensitive) and unique among
 * the sessions of that directory. Id prefixes are never accepted: a wake loads a session, so the target must be exact.
 */
export function resolveWakeCandidate(candidates: WakeCandidate[], to: string, cwd: string): ResolveResult {
  const inCwd = candidates.filter((candidate) => sameCwd(candidate.cwd, cwd));
  const wanted = to.trim();
  const byId = inCwd.filter((candidate) => candidate.piSessionId === wanted);
  const lower = wanted.toLowerCase();
  const byName = byId.length > 0 ? [] : inCwd.filter((candidate) => candidate.name?.trim().toLowerCase() === lower);
  const matches = byId.length > 0 ? byId : byName;
  if (matches.length === 0) {
    return { ok: false, code: "not_found", detail: `No persisted session "${wanted}" in ${cwd}. Use its full session id, or an exact name that is unique in that directory.` };
  }
  if (matches.length > 1) {
    return { ok: false, code: "ambiguous", detail: `${matches.length} persisted sessions in ${cwd} are named "${wanted}". Use the full session id.` };
  }
  const candidate = matches[0]!;
  if (candidate.archived) {
    return { ok: false, code: "archived", detail: `Session ${candidate.piSessionId} is archived and read-only. Restore it first.` };
  }
  return { ok: true, candidate };
}
