import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultWakeConfig, type WakeConfig } from "../config.ts";
import { WakeAudit, type WakeAuditEntry } from "./audit.ts";
import { performArchive, performArchiveMany, performAutoArchive, type ArchiveDeps } from "./controller.ts";
import { WakeError, type WakeCandidate, type WakeProvider } from "./provider.ts";

const ME = "sender-pi-id";
const id = (n: number) => `0198b0b0-${String(n).padStart(4, "0")}-7ddd-8eee-ffffffffffff`;
const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

interface Setup {
  config?: Partial<WakeConfig>;
  children?: number[];
  spawned?: number[];
  catalog?: Record<number, Partial<WakeCandidate>>;
  confirm?: false | (() => Promise<boolean>);
  archive?: (piSessionId: string) => Promise<void>;
  trusted?: boolean;
  wakeTrusted?: boolean;
  self?: string;
}

function setup(over: Setup = {}) {
  const dir = mkdtempSync(join(tmpdir(), "archive-many-"));
  const audit = new WakeAudit(join(dir, "wake-audit.jsonl"));
  const calls = { archived: [] as string[], confirms: [] as Array<{ title: string; body: string }>, listed: [] as string[] };
  for (const n of over.spawned ?? []) {
    audit.append({ ts: NOW - 3_600_000, kind: "spawn", outcome: "delivered", code: "delivered", messageId: `m${n}`, target: { piSessionId: id(n), cwd: "/proj" }, sender: { piSessionId: ME }, textLength: 1, textSha256: "x" });
  }
  const catalog = (n: number): WakeCandidate => ({ piSessionId: id(n), cwd: "/proj", name: `session ${n}`, archived: false, modified: minutesAgo(60), path: `/s/2026_${id(n)}.jsonl`, ...(over.catalog?.[n] ?? {}) });
  const provider: WakeProvider = {
    id: "fake",
    list: async (cwd) => { calls.listed.push(cwd); return [...(over.children ?? []), ...(over.spawned ?? [])].map(catalog); },
    wake: async () => { throw new Error("archive must not wake"); },
    archive: async (target) => { calls.archived.push(target.piSessionId); if (over.archive) await over.archive(target.piSessionId); },
  };
  const config: WakeConfig = { ...defaultWakeConfig(), enabled: true, provider: "fake", allowCwds: ["/proj"], ...over.config };
  const deps: ArchiveDeps = {
    config, provider, audit, now: () => NOW,
    ...(over.confirm === false ? {} : { confirm: async (title: string, body: string) => { calls.confirms.push({ title, body }); return over.confirm ? over.confirm() : true; } }),
    ...(over.wakeTrusted ? { trust: { find: () => ({ expiresAt: NOW + 1000 }) } } : {}),
    ...(over.trusted ? { archiveTrust: { find: () => ({ expiresAt: NOW + 1000 }) } } : {}),
    self: { intercomId: "sender-intercom-id", piSessionId: over.self ?? ME, cwd: "/elsewhere" },
    children: (over.children ?? []).map((n) => ({ piSessionId: id(n), cwd: "/proj", via: "subsession" as const })),
  };
  return { deps, calls, audit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const withSetup = async (over: Setup, fn: (t: ReturnType<typeof setup>) => Promise<void>) => { const t = setup(over); try { await fn(t); } finally { t.cleanup(); } };
const finals = (audit: WakeAudit): WakeAuditEntry[] => audit.read().filter((e) => e.outcome !== "attempting");

test("a tracked subsession of the sender can be archived one at a time, with the usual confirmation", async () => {
  await withSetup({ children: [1] }, async (t) => {
    const result = await performArchive(t.deps, { piSessionId: id(1), cwd: "/proj" });
    assert.equal(result.ok, true);
    assert.deepEqual(t.calls.archived, [id(1)]);
    assert.equal(t.calls.confirms.length, 1);
    assert.match(t.calls.confirms[0]!.body, /tracked subsessions/);
  });
  await withSetup({ children: [1] }, async (t) => {
    assert.equal((await performArchive(t.deps, { piSessionId: id(2), cwd: "/proj" })).code, "not_created_by_you", "another session is still refused");
  });
});

test("a batch asks ONCE, lists every session, and archives each with its own result and audit", async () => {
  await withSetup({ children: [1, 2], spawned: [3] }, async (t) => {
    const result = await performArchiveMany(t.deps, { ids: [id(1), id(2), id(3)] });
    assert.equal(result.ok, true);
    assert.equal(result.code, "archived");
    assert.equal(t.calls.confirms.length, 1, "one dialog for the whole batch");
    for (const n of [1, 2, 3]) assert.match(t.calls.confirms[0]!.body, new RegExp(id(n).slice(0, 13)));
    assert.deepEqual(t.calls.archived, [id(1), id(2), id(3)]);
    const done = finals(t.audit).filter((e) => e.kind === "archive" && e.outcome === "archived");
    assert.deepEqual(done.map((e) => e.target.piSessionId), [id(1), id(2), id(3)]);
    assert.ok(done.every((e) => e.confirmedBy === "user"));
  });
});

test("the batch dialog stays within PI WEB's limit with ten long-named sessions", async () => {
  const many = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  await withSetup({ children: many, catalog: Object.fromEntries(many.map((n) => [n, { name: "A very long session name that goes on and on and on ".repeat(5) }])) }, async (t) => {
    const result = await performArchiveMany(t.deps, { ids: many.map(id) });
    assert.equal(result.ok, true);
    assert.ok(t.calls.confirms[0]!.body.length <= 1000, `${t.calls.confirms[0]!.body.length}`);
  });
});

test("a batch is always confirmed: not skipped by any trust, refused without a UI, and declining archives nothing", async () => {
  await withSetup({ children: [1], trusted: true, wakeTrusted: true, config: { confirm: "never", spawnConfirm: "never" } }, async (t) => {
    await performArchiveMany(t.deps, { ids: [id(1)] });
    assert.equal(t.calls.confirms.length, 1);
  });
  await withSetup({ children: [1], confirm: false, trusted: true }, async (t) => {
    assert.equal((await performArchiveMany(t.deps, { ids: [id(1)] })).code, "confirmation_unavailable");
    assert.deepEqual(t.calls.archived, []);
  });
  await withSetup({ children: [1, 2], confirm: async () => false }, async (t) => {
    const result = await performArchiveMany(t.deps, { ids: [id(1), id(2)] });
    assert.equal(result.code, "user_declined");
    assert.deepEqual(t.calls.archived, []);
  });
  await withSetup({ children: [1], confirm: async () => { throw new Error("dialog refused"); } }, async (t) => {
    assert.equal((await performArchiveMany(t.deps, { ids: [id(1)] })).code, "confirmation_failed");
    assert.deepEqual(t.calls.archived, []);
  });
});

test("ineligible sessions are reported one by one and never reach the host; the rest still goes ahead", async () => {
  await withSetup({ children: [1, 2, 3, 4], catalog: { 2: { archived: true }, 3: { modified: minutesAgo(2) }, 4: { modified: undefined } } }, async (t) => {
    const result = await performArchiveMany(t.deps, { ids: [id(1), id(2), id(3), id(4), id(5), ME] });
    assert.equal(result.ok, true);
    assert.equal(result.code, "partly_archived", "some of what was asked for was skipped");
    assert.deepEqual(t.calls.archived, [id(1)]);
    const code = (n: string) => result.results.find((r) => r.piSessionId === n)?.code;
    assert.equal(code(id(2)), "already_archived");
    assert.equal(code(id(3)), "too_recent");
    assert.equal(code(id(4)), "unknown_activity");
    assert.equal(code(id(5)), "not_created_by_you");
    assert.equal(code(ME), "self_target");
    assert.ok(!t.calls.confirms[0]!.body.includes(id(5).slice(0, 13)), "only eligible sessions are listed in the dialog");
  });
});

test("a session the host lists but has not saved yet is skipped before the user is asked", async () => {
  await withSetup({ children: [1, 2], catalog: { 2: { persisted: false } } }, async (t) => {
    const result = await performArchiveMany(t.deps, { ids: [id(1), id(2)] });
    assert.equal(result.results.find((r) => r.piSessionId === id(2))?.code, "not_saved");
    assert.deepEqual(t.calls.archived, [id(1)]);
    assert.ok(!t.calls.confirms[0]!.body.includes(id(2).slice(0, 13)), "not offered to the user");
  });
});

test("nothing eligible means no dialog; more than ten, an empty list, or a disabled wake are refused", async () => {
  await withSetup({ children: [1], catalog: { 1: { modified: minutesAgo(1) } } }, async (t) => {
    assert.equal((await performArchiveMany(t.deps, { ids: [id(1)] })).code, "nothing_to_archive");
    assert.equal(t.calls.confirms.length, 0);
    assert.equal((await performArchiveMany(t.deps, { ids: [] })).code, "no_sessions");
    assert.equal((await performArchiveMany(t.deps, { ids: Array.from({ length: 11 }, (_, i) => id(i + 1)) })).code, "too_many");
  });
  await withSetup({ children: [1], config: { enabled: false } }, async (t) => assert.equal((await performArchiveMany(t.deps, { ids: [id(1)] })).code, "wake_disabled"));
});

test("a working session is refused by the host and reported, the others are archived; a directory outside the allowlist is skipped", async () => {
  await withSetup({ children: [1, 2], archive: async (sid) => { if (sid === id(1)) throw new WakeError("busy", "working"); } }, async (t) => {
    const result = await performArchiveMany(t.deps, { ids: [id(1), id(2)] });
    assert.equal(result.code, "partly_archived");
    assert.equal(result.results.find((r) => r.piSessionId === id(1))?.code, "provider_busy");
    assert.equal(result.results.find((r) => r.piSessionId === id(2))?.ok, true);
  });
  await withSetup({ children: [1], config: { allowCwds: ["/other"] } }, async (t) => {
    const result = await performArchiveMany(t.deps, { ids: [id(1)] });
    assert.equal(result.code, "nothing_to_archive");
    assert.equal(result.results[0]!.code, "cwd_not_allowed");
  });
});

test("archiveMax counts every session of a batch", async () => {
  await withSetup({ children: [1, 2, 3], config: { archiveMax: 2 } }, async (t) => {
    assert.equal((await performArchiveMany(t.deps, { ids: [id(1), id(2), id(3)] })).code, "rate_limited_archive");
    assert.deepEqual(t.calls.archived, []);
    assert.equal((await performArchiveMany(t.deps, { ids: [id(1), id(2)] })).ok, true);
  });
});

// ---- Automatic archiving
const candidates = (...ns: number[]) => ns.map((n) => ({ piSessionId: id(n), cwd: "/proj", name: `session ${n}` }));
const auto = (t: ReturnType<typeof setup>, ns: number[], attempts = new Map<string, number>()) => performAutoArchive({ ...t.deps, attempts }, { candidates: candidates(...ns) });

test("auto-archive needs BOTH the global switch and the parent's own /archive-trust", async () => {
  await withSetup({ children: [1], trusted: true, config: { autoArchive: "off" } }, async (t) => {
    assert.equal((await auto(t, [1])).code, "auto_archive_off");
    assert.deepEqual(t.calls.archived, []);
  });
  await withSetup({ children: [1], config: { autoArchive: "trusted-children" } }, async (t) => {
    assert.equal((await auto(t, [1])).code, "not_trusted");
    assert.deepEqual(t.calls.archived, []);
  });
  await withSetup({ children: [1], wakeTrusted: true, config: { autoArchive: "trusted-children" } }, async (t) => {
    assert.equal((await auto(t, [1])).code, "not_trusted", "a /wake-trust grant is not an /archive-trust grant");
    assert.deepEqual(t.calls.archived, []);
  });
  await withSetup({ children: [1], trusted: true, config: { autoArchive: "trusted-children", enabled: false } }, async (t) => {
    assert.equal((await auto(t, [1])).code, "wake_disabled");
  });
});

test("with both keys the child is archived without a dialog and audited as archive_auto / archive-trust", async () => {
  await withSetup({ children: [1], trusted: true, config: { autoArchive: "trusted-children" } }, async (t) => {
    const result = await auto(t, [1]);
    assert.equal(result.items[0]!.outcome, "archived");
    assert.deepEqual(t.calls.archived, [id(1)]);
    assert.equal(t.calls.confirms.length, 0, "no dialog");
    const entry = t.audit.read().at(-1)!;
    assert.deepEqual([entry.kind, entry.outcome, entry.code, entry.confirmedBy, entry.target.piSessionId, entry.target.name, entry.sender.piSessionId], ["archive_auto", "archived", "archive_auto", "archive-trust", id(1), "session 1", ME]);
  });
});

test("a working child is left alone, silently, and tried again later; it is never audited as failed", async () => {
  let busy = true;
  await withSetup({ children: [1], trusted: true, config: { autoArchive: "trusted-children" }, archive: async () => { if (busy) throw new WakeError("busy", "working"); } }, async (t) => {
    const attempts = new Map<string, number>();
    for (let i = 0; i < 5; i++) {
      const result = await auto(t, [1], attempts);
      assert.equal(result.items[0]!.outcome, "busy");
      assert.equal(result.items[0]!.giveUp, false);
    }
    assert.equal(t.audit.read().length, 0, "busy rounds leave no audit noise");
    busy = false;
    assert.equal((await auto(t, [1], attempts)).items[0]!.outcome, "archived");
  });
});

test("a session that cannot be archived is given up on after three tries, with one audit entry", async () => {
  await withSetup({ children: [1], trusted: true, config: { autoArchive: "trusted-children" }, archive: async () => { throw new WakeError("rejected", "not persisted"); } }, async (t) => {
    const attempts = new Map<string, number>();
    const gaveUp: boolean[] = [];
    for (let i = 0; i < 3; i++) gaveUp.push((await auto(t, [1], attempts)).items[0]!.giveUp);
    assert.deepEqual(gaveUp, [false, false, true]);
    const failed = t.audit.read().filter((e) => e.kind === "archive_auto");
    assert.equal(failed.length, 1);
    assert.deepEqual([failed[0]!.outcome, failed[0]!.code], ["failed", "provider_rejected"]);
  });
});

test("the cap: three per round and autoArchiveMax per window across rounds", async () => {
  await withSetup({ children: [1, 2, 3, 4, 5], trusted: true, config: { autoArchive: "trusted-children", autoArchiveMax: 4 } }, async (t) => {
    assert.equal((await auto(t, [1, 2, 3, 4, 5])).items.filter((i) => i.outcome === "archived").length, 3, "three per round");
    assert.equal((await auto(t, [4, 5])).items.filter((i) => i.outcome === "archived").length, 1, "one left in the window");
    assert.equal((await auto(t, [5])).code, "rate_limited_auto_archive");
    assert.equal(t.calls.archived.length, 4);
  });
});

test("auto-archive never touches the current session or a directory outside wake.allowCwds", async () => {
  await withSetup({ children: [1], trusted: true, config: { autoArchive: "trusted-children", allowCwds: ["/other"] } }, async (t) => {
    const result = await auto(t, [1]);
    assert.equal(result.items[0]!.outcome, "skipped");
    assert.deepEqual(t.calls.archived, []);
  });
  await withSetup({ children: [1], trusted: true, self: id(1), config: { autoArchive: "trusted-children" } }, async (t) => {
    assert.equal((await auto(t, [1])).items[0]!.code, "self_target");
    assert.deepEqual(t.calls.archived, []);
  });
});
