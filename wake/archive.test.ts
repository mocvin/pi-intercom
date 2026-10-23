import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultWakeConfig, type WakeConfig } from "../config.ts";
import { WakeAudit, type WakeAuditEntry } from "./audit.ts";
import { performArchive } from "./controller.ts";
import { WakeError, type WakeProvider } from "./provider.ts";

const ID = "0198b0b0-cccc-7ddd-8eee-ffff00001111";
const ME = "sender-pi-id";

function setup(over: {
  config?: Partial<WakeConfig>;
  confirm?: false | (() => Promise<boolean>);
  archive?: (() => Promise<void>) | "absent";
  trusted?: boolean;
  seed?: Partial<WakeAuditEntry> | null;
  self?: string;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "archive-controller-"));
  const audit = new WakeAudit(join(dir, "wake-audit.jsonl"));
  const calls = { archived: [] as Array<{ piSessionId: string; cwd: string }>, confirms: [] as string[] };
  if (over.seed !== null) {
    audit.append({ ts: Date.now() - 60_000, kind: "spawn", outcome: "delivered", code: "delivered", messageId: "m0", target: { piSessionId: ID, cwd: "/proj" }, sender: { piSessionId: ME }, textLength: 3, textSha256: "x", ...over.seed });
  }
  const provider: WakeProvider = {
    id: "fake",
    list: async () => { throw new Error("archive must not read the catalog"); },
    wake: async () => { throw new Error("archive must not wake"); },
    ...(over.archive === "absent" ? {} : { archive: async (target) => { calls.archived.push(target); if (typeof over.archive === "function") await over.archive(); } }),
  };
  const config: WakeConfig = { ...defaultWakeConfig(), enabled: true, provider: "fake", allowCwds: ["/proj"], ...over.config };
  const deps = {
    config, provider, audit,
    ...(over.confirm === false ? {} : { confirm: async (title: string) => { calls.confirms.push(title); return over.confirm ? over.confirm() : true; } }),
    ...(over.trusted ? { trust: { find: () => ({ expiresAt: Date.now() + 1000 }) } } : {}),
    self: { intercomId: "sender-intercom-id", piSessionId: over.self ?? ME, cwd: "/elsewhere" },
  };
  return { deps, calls, audit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const req = (over: Record<string, unknown> = {}) => ({ piSessionId: ID, cwd: "/proj", ...over });
const withSetup = async (over: Parameters<typeof setup>[0], fn: (t: ReturnType<typeof setup>) => Promise<void>) => { const t = setup(over); try { await fn(t); } finally { t.cleanup(); } };

test("archive asks the user, archives a session this sender created with spawn, and audits it", async () => {
  await withSetup({}, async (t) => {
    const result = await performArchive(t.deps, req());
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "archived");
    assert.deepEqual(t.calls.archived, [{ piSessionId: ID, cwd: "/proj" }]);
    assert.equal(t.calls.confirms.length, 1);
    const last = t.audit.read().at(-1)!;
    assert.deepEqual([last.kind, last.outcome, last.confirmedBy, last.target.piSessionId], ["archive", "archived", "user", ID]);
  });
});

test("nothing removes the dialog: not /wake-trust, not wake.confirm or wake.spawnConfirm set to never", async () => {
  await withSetup({ trusted: true, config: { confirm: "never", spawnConfirm: "never" } }, async (t) => {
    assert.equal((await performArchive(t.deps, req())).ok, true);
    assert.equal(t.calls.confirms.length, 1);
  });
});

test("without a UI archive is blocked, even for a trusted sender", async () => {
  await withSetup({ confirm: false, trusted: true, config: { confirm: "never", spawnConfirm: "never" } }, async (t) => {
    const result = await performArchive(t.deps, req());
    assert.equal(result.code, "confirmation_unavailable");
    assert.deepEqual(t.calls.archived, []);
  });
});

test("a declined dialog archives nothing", async () => {
  await withSetup({ confirm: async () => false }, async (t) => {
    const result = await performArchive(t.deps, req());
    assert.equal(result.code, "user_declined");
    assert.deepEqual(t.calls.archived, []);
  });
});

test("only a session this sender created with spawn can be archived", async () => {
  await withSetup({ seed: null }, async (t) => {
    assert.equal((await performArchive(t.deps, req())).code, "not_created_by_you");
    assert.equal(t.calls.confirms.length, 0, "the user is not even asked");
  });
  await withSetup({ seed: { sender: { piSessionId: "someone-else" } } }, async (t) => {
    assert.equal((await performArchive(t.deps, req())).code, "not_created_by_you", "created by another session");
  });
  await withSetup({ seed: { kind: "wake" } }, async (t) => {
    assert.equal((await performArchive(t.deps, req())).code, "not_created_by_you", "a wake target is not a spawn");
  });
  await withSetup({ seed: { target: { piSessionId: ID, cwd: "/other" } } }, async (t) => {
    assert.equal((await performArchive(t.deps, req())).code, "not_created_by_you", "directory must match");
  });
  await withSetup({ seed: { outcome: "blocked" } }, async (t) => {
    assert.equal((await performArchive(t.deps, req())).code, "not_created_by_you", "a blocked spawn created nothing");
  });
});

test("a spawn whose delivery failed still leaves a session this sender may archive", async () => {
  await withSetup({ seed: { outcome: "failed", code: "provider_rejected" } }, async (t) => {
    assert.equal((await performArchive(t.deps, req())).ok, true);
  });
});

test("the current session, a directory outside the allowlist, a bad id, or a disabled wake are refused", async () => {
  await withSetup({ self: ID }, async (t) => assert.equal((await performArchive(t.deps, req())).code, "self_target"));
  await withSetup({}, async (t) => {
    assert.equal((await performArchive(t.deps, req({ cwd: "/other" }))).code, "cwd_not_allowed");
    assert.equal((await performArchive(t.deps, req({ piSessionId: "../etc" }))).code, "invalid_session_id");
    assert.equal((await performArchive(t.deps, req({ cwd: "relative" }))).code, "invalid_cwd");
    assert.deepEqual(t.calls.archived, []);
  });
  await withSetup({ config: { enabled: false } }, async (t) => assert.equal((await performArchive(t.deps, req())).code, "wake_disabled"));
  await withSetup({ archive: "absent" }, async (t) => assert.equal((await performArchive(t.deps, req())).code, "archive_unsupported"));
});

test("a working session is refused by the host and reported; an unknown outcome is not claimed as success", async () => {
  await withSetup({ archive: async () => { throw new WakeError("busy", "working"); } }, async (t) => {
    const result = await performArchive(t.deps, req());
    assert.equal(result.ok, false);
    assert.equal(result.code, "provider_busy");
    assert.equal(t.audit.read().at(-1)!.outcome, "failed");
  });
  await withSetup({ archive: async () => { throw new WakeError("timeout", "lost"); } }, async (t) => {
    const result = await performArchive(t.deps, req());
    assert.equal(result.ok, false);
    assert.match(result.text, /unknown/);
  });
});

test("archiveMax limits archive actions in the window", async () => {
  await withSetup({ config: { archiveMax: 1 } }, async (t) => {
    assert.equal((await performArchive(t.deps, req())).ok, true);
    assert.equal((await performArchive(t.deps, req())).code, "rate_limited_archive");
    assert.equal(t.calls.archived.length, 1);
  });
});
