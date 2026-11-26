import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KEEP_ENTRY, SUBSESSION_COMPLETION, SUBSESSION_LINK, completionTimes, keptChildren, readChildHeader, selectAutoArchiveCandidates, trackedChildren, type EntryLike } from "./children.ts";
import type { WakeCandidate } from "./provider.ts";

const ME = "0198aaaa-0000-7000-8000-00000000000a";
const link = (id: string, file = `/s/2026_${id}.jsonl`, by = ME): EntryLike => ({ type: "custom", customType: SUBSESSION_LINK, data: { version: 1, spawnedBySessionId: by, spawnedSessionId: id, spawnedSessionFile: file } });
const done = (id: string, at: string): EntryLike => ({ type: "custom_message", customType: SUBSESSION_COMPLETION, details: { sessionId: id }, timestamp: at });
const keep = (id: string, on: boolean): EntryLike => ({ type: "custom", customType: KEEP_ENTRY, data: { id, keep: on } });

test("trackedChildren lists only this session's own links", () => {
  const entries = [link("c1"), link("c2"), link("other", "/s/x.jsonl", "someone-else"), { type: "message" }, { type: "custom", customType: SUBSESSION_LINK, data: { spawnedBySessionId: ME } }];
  assert.deepEqual(trackedChildren(entries, ME).map((c) => c.piSessionId), ["c1", "c2"]);
});

test("completionTimes keeps the latest notice of each child, and keptChildren the latest keep/unkeep", () => {
  const times = completionTimes([done("c1", "2026-10-23T08:00:00.000Z"), done("c1", "2026-10-23T09:00:00.000Z"), done("c2", "2026-10-23T07:00:00.000Z"), { customType: SUBSESSION_COMPLETION, details: { sessionId: "bad" }, timestamp: "not a date" }]);
  assert.equal(times.get("c1"), Date.parse("2026-10-23T09:00:00.000Z"));
  assert.equal(times.has("bad"), false);
  assert.deepEqual([...keptChildren([keep("c1", true), keep("c2", true), keep("c1", false)])], ["c2"]);
});

test("readChildHeader reads the directory only when the file, the id and the parent all agree", () => {
  const root = mkdtempSync(join(tmpdir(), "children-"));
  try {
    const dir = join(root, "sessions", "--proj--");
    mkdirSync(dir, { recursive: true });
    const good = join(dir, "2026_c1.jsonl");
    writeFileSync(good, `${JSON.stringify({ type: "session", id: "c1", cwd: "/proj", parentSession: `/p/2026_${ME}.jsonl` })}\n{"type":"message"}\n`);
    const sessions = join(root, "sessions");
    assert.deepEqual(readChildHeader({ piSessionId: "c1", file: good }, ME, sessions), { cwd: "/proj" });
    assert.equal(readChildHeader({ piSessionId: "c1", file: good }, "another-parent", sessions), undefined, "a different parent");
    assert.equal(readChildHeader({ piSessionId: "c2", file: good }, ME, sessions), undefined, "the file is not that session's");
    const wrongId = join(dir, "2026_c3.jsonl");
    writeFileSync(wrongId, `${JSON.stringify({ type: "session", id: "other", cwd: "/proj", parentSession: `/p/2026_${ME}.jsonl` })}\n`);
    assert.equal(readChildHeader({ piSessionId: "c3", file: wrongId }, ME, sessions), undefined, "the header id differs");
    const outside = join(root, "outside_c4.jsonl");
    writeFileSync(outside, `${JSON.stringify({ type: "session", id: "c4", cwd: "/proj", parentSession: `/p/2026_${ME}.jsonl` })}\n`);
    assert.equal(readChildHeader({ piSessionId: "c4", file: outside }, ME, sessions), undefined, "outside the session directory");
    assert.equal(readChildHeader({ piSessionId: "c5", file: join(dir, "2026_c5.jsonl") }, ME, sessions), undefined, "missing file");
    assert.equal(readChildHeader({ piSessionId: "c1", file: "relative/2026_c1.jsonl" }, ME, sessions), undefined, "relative path");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const catalogEntry = (id: string, over: Partial<WakeCandidate> = {}): WakeCandidate => ({ piSessionId: id, cwd: "/proj", name: `name-${id}`, archived: false, modified: minutesAgo(45), path: `/s/2026_${id}.jsonl`, ...over });
function select(over: { children?: string[]; done?: Record<string, number>; kept?: string[]; catalog?: WakeCandidate[]; gaveUp?: string[]; minIdleMs?: number } = {}) {
  const ids = over.children ?? ["c1"];
  return selectAutoArchiveCandidates({
    now: NOW,
    children: ids.map((id) => ({ piSessionId: id, file: `/s/2026_${id}.jsonl`, cwd: "/proj" })),
    completions: new Map(ids.map((id) => [id, NOW - (over.done?.[id] ?? 40) * 60_000])),
    kept: new Set(over.kept),
    catalogs: new Map([["/proj", over.catalog ?? ids.map((id) => catalogEntry(id))]]),
    minIdleMs: over.minIdleMs ?? 10 * 60_000,
    gaveUp: new Set(over.gaveUp),
  });
}

test("a finished, idle, saved child is a candidate", () => {
  const { candidates } = select();
  assert.deepEqual(candidates, [{ piSessionId: "c1", cwd: "/proj", name: "name-c1" }]);
});

test("every reason that keeps a child is reported, and nothing else is selected", () => {
  const reasons = (over: Parameters<typeof select>[0]) => select(over).skipped.map((s) => s.reason);
  assert.deepEqual(reasons({ kept: ["c1"] }), ["keep"]);
  assert.deepEqual(reasons({ gaveUp: ["c1"] }), ["gave_up"]);
  assert.deepEqual(reasons({ done: { c1: 3 } }), ["too_recent"], "completion notice is too recent");
  assert.deepEqual(reasons({ catalog: [catalogEntry("c1", { modified: minutesAgo(2) })], done: { c1: 40 } }), ["active_since_completion"], "written after the notice: it got new work");
  assert.deepEqual(reasons({ catalog: [catalogEntry("c1", { modified: minutesAgo(41) })], done: { c1: 40 }, minIdleMs: 60 * 60_000 }), ["too_recent"], "idle for less than minIdle");
  assert.deepEqual(reasons({ catalog: [] }), ["not_saved"]);
  assert.deepEqual(reasons({ catalog: [catalogEntry("c1", { persisted: false })] }), ["not_saved"], "listed by the host but not saved yet");
  assert.deepEqual(reasons({ catalog: [catalogEntry("c1", { archived: true })] }), ["already_archived"]);
  assert.deepEqual(reasons({ catalog: [catalogEntry("c1", { modified: undefined })] }), ["unknown_activity"]);
  const noNotice = selectAutoArchiveCandidates({ ...{ now: NOW, kept: new Set<string>(), minIdleMs: 1, gaveUp: new Set<string>() }, children: [{ piSessionId: "c1", file: "", cwd: "/proj" }], completions: new Map(), catalogs: new Map([["/proj", [catalogEntry("c1")]]]) });
  assert.deepEqual(noNotice.skipped.map((s) => s.reason), ["no_completion_notice"], "a child whose result was never delivered to the parent stays");
});

test("a child that has live descendants of its own is not archived, but one whose descendants are archived is", () => {
  const withGrandchild = [catalogEntry("c1"), catalogEntry("g1", { parentSessionPath: "/s/2026_c1.jsonl", path: "/s/2026_g1.jsonl" })];
  assert.deepEqual(select({ catalog: withGrandchild }).skipped.map((s) => s.reason), ["has_descendants"]);
  const archivedGrandchild = [catalogEntry("c1"), catalogEntry("g1", { parentSessionPath: "/s/2026_c1.jsonl", archived: true })];
  assert.deepEqual(select({ catalog: archivedGrandchild }).candidates.map((c) => c.piSessionId), ["c1"]);
});

test("each child is judged separately", () => {
  const { candidates, skipped } = select({ children: ["c1", "c2", "c3"], kept: ["c2"], done: { c3: 2 } });
  assert.deepEqual(candidates.map((c) => c.piSessionId), ["c1"]);
  assert.deepEqual(skipped.map((s) => [s.piSessionId, s.reason]), [["c2", "keep"], ["c3", "too_recent"]]);
});
