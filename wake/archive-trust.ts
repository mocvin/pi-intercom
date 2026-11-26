import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { getIntercomDirPath } from "../broker/paths.ts";

/**
 * Parent sessions the user allowed to archive their own finished subsessions by themselves, without asking each time.
 * This is a SEPARATE permission from /wake-trust (which only allows waking sessions) and lives in its own file.
 * A grant is tied to the real Pi session id of the session it was granted in (read in-process, so another
 * session cannot claim it), expires, and is created or removed only after the user confirms in a dialog.
 */
export interface ArchiveTrustEntry {
  piSessionId: string;
  /** For display only. */
  name?: string;
  /** For display only. */
  cwd: string;
  grantedAt: number;
  expiresAt: number;
}

interface ArchiveTrustFile {
  version: 1;
  entries: ArchiveTrustEntry[];
}

export function archiveTrustPath(intercomDir: string = getIntercomDirPath()): string {
  return join(intercomDir, "archive-trust.json");
}

const isEntry = (value: unknown): value is ArchiveTrustEntry => {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return typeof e.piSessionId === "string" && e.piSessionId.length > 0
    && typeof e.cwd === "string"
    && (e.name === undefined || typeof e.name === "string")
    && typeof e.grantedAt === "number" && typeof e.expiresAt === "number";
};

export class ArchiveTrustStore {
  constructor(readonly path: string = archiveTrustPath()) {}

  /** All entries in the file, expired ones included. Throws when the file exists but cannot be understood. */
  private readAll(): ArchiveTrustEntry[] {
    if (!existsSync(this.path)) return [];
    const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<ArchiveTrustFile>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.entries) || !parsed.entries.every(isEntry)) {
      throw new Error(`Unrecognized archive trust file ${this.path}`);
    }
    return parsed.entries;
  }

  private writeAll(entries: ArchiveTrustEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, entries } satisfies ArchiveTrustFile, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }

  /** Valid grants. Throws on an unreadable file (callers decide; the auto-archive path treats it as "not allowed"). */
  list(now = Date.now()): ArchiveTrustEntry[] {
    return this.readAll().filter((entry) => entry.expiresAt > now);
  }

  /** The valid grant of this session, if any. Never throws: an unreadable file means no grant (fail closed). */
  find(piSessionId: string, now = Date.now()): ArchiveTrustEntry | undefined {
    try {
      return this.list(now).find((entry) => entry.piSessionId === piSessionId);
    } catch {
      return undefined;
    }
  }

  /** Create or renew the grant of a session; expired grants are dropped on the way. */
  grant(subject: { piSessionId: string; name?: string; cwd: string }, days: number, now = Date.now()): ArchiveTrustEntry {
    const entry: ArchiveTrustEntry = {
      piSessionId: subject.piSessionId,
      ...(subject.name ? { name: subject.name } : {}),
      cwd: subject.cwd,
      grantedAt: now,
      expiresAt: now + days * 24 * 60 * 60 * 1000,
    };
    const kept = this.readAllOrEmptyForRepair().filter((e) => e.piSessionId !== subject.piSessionId && e.expiresAt > now);
    this.writeAll([...kept, entry]);
    return entry;
  }

  /** Remove the grant of a session. Returns the removed grant, if there was one. */
  revoke(piSessionId: string, now = Date.now()): ArchiveTrustEntry | undefined {
    const all = this.readAllOrEmptyForRepair();
    const removed = all.find((e) => e.piSessionId === piSessionId);
    this.writeAll(all.filter((e) => e.piSessionId !== piSessionId && e.expiresAt > now));
    return removed && removed.expiresAt > now ? removed : undefined;
  }

  /**
   * A grant or revoke is an explicit, confirmed user action, so it may replace a file that cannot be read:
   * the unreadable content granted nothing anyway (find() fails closed).
   */
  private readAllOrEmptyForRepair(): ArchiveTrustEntry[] {
    try {
      return this.readAll();
    } catch {
      return [];
    }
  }
}
