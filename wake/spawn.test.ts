import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultWakeConfig, type WakeConfig } from "../config.ts";
import type { SendResult } from "../broker/client.ts";
import type { MessageReceipt, SessionInfo } from "../types.ts";
import { WakeAudit } from "./audit.ts";
import { performWake, type WakeClient, type WakeDeps } from "./controller.ts";
import { WakeError, type WakeProvider } from "./provider.ts";

const NEW_ID = "0198b0b0-cccc-7ddd-8eee-ffff00001111";
const ok = (id: string, extra: Partial<SendResult> = {}): SendResult => ({ id, delivered: true, delivery: "queued", code: "wake_pending", retryable: false, outcomeKnown: true, ...extra });

function setup(over: {
  config?: Partial<WakeConfig>;
  trusted?: boolean;
  confirm?: false | (() => Promise<boolean>);
  create?: (() => Promise<{ piSessionId: string }>) | "absent";
  wake?: (messageId: string, emit: (status: MessageReceipt["status"]) => void) => Promise<void>;
  self?: string;
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "spawn-controller-"));
  const handlers = new Set<(from: SessionInfo, receipt: MessageReceipt) => void>();
  const calls = { created: [] as string[], sent: [] as Array<{ to: string; wake?: unknown }>, cancelled: [] as string[], woken: [] as string[], confirms: [] as string[] };
  let lastId = "";
  const client: WakeClient = {
    sessionId: "sender-intercom-id",
    supportsFeature: () => true,
    listSessions: async () => [],
    send: async (to, options) => { lastId = options.messageId!; calls.sent.push({ to, ...(options.wake ? { wake: options.wake } : {}) }); return ok(options.messageId!); },
    cancelMessage: async (id) => { calls.cancelled.push(id); return ok(id, { delivery: "socket_delivered", code: undefined }); },
    onMessageReceipt: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
  };
  const emit = (status: MessageReceipt["status"]) => { for (const handler of handlers) handler({} as SessionInfo, { messageId: lastId, status, timestamp: Date.now() }); };
  const provider: WakeProvider = {
    id: "fake",
    list: async () => { throw new Error("spawn must not read the catalog"); },
    wake: async (_target, messageId) => { calls.woken.push(messageId); await (over.wake ?? (async (_id, e) => { e("receiver_received"); }))(messageId, emit); },
    ...(over.create === "absent" ? {} : { create: async (cwd: string) => { calls.created.push(cwd); return typeof over.create === "function" ? over.create() : { piSessionId: NEW_ID }; } }),
  };
  const config: WakeConfig = { ...defaultWakeConfig(), enabled: true, provider: "fake", allowCwds: ["/proj"], deliveryTimeoutMs: 250, ...over.config };
  const audit = new WakeAudit(join(dir, "wake-audit.jsonl"));
  const deps: WakeDeps = {
    client, config, provider, audit,
    ...(over.confirm === false ? {} : { confirm: async (title: string) => { calls.confirms.push(title); return over.confirm ? over.confirm() : true; } }),
    ...(over.trusted ? { trust: { find: () => ({ expiresAt: Date.now() + 1000 }) } } : {}),
    self: { intercomId: "sender-intercom-id", piSessionId: over.self ?? "sender-pi-id", cwd: "/elsewhere" },
  };
  return { deps, calls, audit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const req = (over: Record<string, unknown> = {}) => ({ to: "", cwd: "/proj", message: "Run the weekly report", spawn: true, ...over });
const finals = (audit: WakeAudit) => audit.read().filter((e) => e.outcome !== "attempting");
const withSetup = async (over: Parameters<typeof setup>[0], fn: (t: ReturnType<typeof setup>) => Promise<void>) => { const t = setup(over); try { await fn(t); } finally { t.cleanup(); } };

test("spawn asks by default, creates the session, and delivers the message once", async () => {
  await withSetup({}, async (t) => {
    const result = await performWake(t.deps, req());
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "delivered");
    assert.equal(result.target?.piSessionId, NEW_ID);
    assert.deepEqual(t.calls.created, ["/proj"]);
    assert.equal(t.calls.confirms.length, 1);
    assert.deepEqual(t.calls.sent.map((s) => [s.to, s.wake]), [[NEW_ID, { piSessionId: NEW_ID, cwd: "/proj" }]]);
    assert.equal(t.calls.woken.length, 1);
    const [reserved, final] = t.audit.read();
    assert.equal(reserved!.kind, "spawn");
    assert.equal(final!.kind, "spawn");
    assert.equal(final!.confirmedBy, "user");
    assert.equal(final!.target.piSessionId, NEW_ID);
    assert.equal(readFileSync(t.audit.path, "utf-8").includes("weekly report"), false, "the audit never holds the text");
  });
});

test("by default even a /wake-trust sender is asked: spawnConfirm is separate from confirm", async () => {
  await withSetup({ trusted: true, config: { confirm: "never" } }, async (t) => {
    const result = await performWake(t.deps, req());
    assert.equal(result.ok, true);
    assert.equal(t.calls.confirms.length, 1);
    assert.equal(finals(t.audit)[0]!.confirmedBy, "user");
  });
});

test("spawnConfirm trusted lets only trusted senders skip the dialog", async () => {
  await withSetup({ trusted: true, config: { spawnConfirm: "trusted" } }, async (t) => {
    assert.equal((await performWake(t.deps, req())).ok, true);
    assert.equal(t.calls.confirms.length, 0);
    assert.equal(finals(t.audit)[0]!.confirmedBy, "trust");
  });
  await withSetup({ config: { spawnConfirm: "trusted" } }, async (t) => {
    assert.equal((await performWake(t.deps, req())).ok, true);
    assert.equal(t.calls.confirms.length, 1, "an untrusted sender is still asked");
  });
});

test("spawnConfirm never skips the dialog but keeps every other check", async () => {
  await withSetup({ config: { spawnConfirm: "never" } }, async (t) => {
    assert.equal((await performWake(t.deps, req())).ok, true);
    assert.equal(t.calls.confirms.length, 0);
    assert.equal(finals(t.audit)[0]!.confirmedBy, "config");
    const blocked = await performWake(t.deps, req({ cwd: "/other" }));
    assert.equal(blocked.code, "cwd_not_allowed");
  });
});

test("without a UI the default blocks before anything is created", async () => {
  await withSetup({ confirm: false }, async (t) => {
    const result = await performWake(t.deps, req());
    assert.equal(result.ok, false);
    assert.equal(result.code, "confirmation_unavailable");
    assert.deepEqual(t.calls.created, []);
    assert.deepEqual(t.calls.sent, []);
  });
});

test("a declined dialog creates nothing", async () => {
  await withSetup({ confirm: async () => false }, async (t) => {
    const result = await performWake(t.deps, req());
    assert.equal(result.code, "user_declined");
    assert.deepEqual(t.calls.created, []);
    assert.deepEqual(t.calls.sent, []);
  });
});

test("a directory outside wake.allowCwds, a secret, or a disabled wake create nothing", async () => {
  await withSetup({}, async (t) => {
    assert.equal((await performWake(t.deps, req({ cwd: "/other" }))).code, "cwd_not_allowed");
    assert.equal((await performWake(t.deps, req({ message: "token: abcdefgh12345678" }))).code, "possible_secret");
    assert.deepEqual(t.calls.created, []);
    assert.equal(t.calls.confirms.length, 0);
  });
  await withSetup({ config: { enabled: false } }, async (t) => {
    assert.equal((await performWake(t.deps, req())).code, "wake_disabled");
    assert.deepEqual(t.calls.created, []);
  });
});

test("a provider that cannot create sessions fails closed", async () => {
  await withSetup({ create: "absent" }, async (t) => {
    assert.equal((await performWake(t.deps, req())).code, "spawn_unsupported");
  });
});

test("a session created by spawn cannot spawn again", async () => {
  await withSetup({}, async (t) => {
    assert.equal((await performWake(t.deps, req())).ok, true);
  });
  const t = setup({ self: NEW_ID });
  try {
    // The audit already records NEW_ID as the target of a spawn.
    t.audit.append({ ts: Date.now(), kind: "spawn", outcome: "delivered", code: "delivered", messageId: "m0", target: { piSessionId: NEW_ID, cwd: "/proj" }, sender: {}, textLength: 1, textSha256: "x" });
    const result = await performWake(t.deps, req({ message: "start another one" }));
    assert.equal(result.code, "spawn_chain");
    assert.deepEqual(t.calls.created, []);
  } finally {
    t.cleanup();
  }
});

test("spawnMax limits how many sessions are created in the window, and a duplicate task is refused", async () => {
  await withSetup({ config: { spawnMax: 2, spawnConfirm: "never" } }, async (t) => {
    assert.equal((await performWake(t.deps, req({ message: "task one" }))).ok, true);
    assert.equal((await performWake(t.deps, req({ message: "task one" }))).code, "duplicate");
    assert.equal((await performWake(t.deps, req({ message: "task two" }))).ok, true);
    const third = await performWake(t.deps, req({ message: "task three" }));
    assert.equal(third.code, "rate_limited_spawn");
    assert.equal(t.calls.created.length, 2);
  });
});

test("a definite refusal to create sends nothing; an uncertain one says a session may exist", async () => {
  await withSetup({ create: async () => { throw new WakeError("rejected", "bad cwd"); } }, async (t) => {
    const result = await performWake(t.deps, req());
    assert.equal(result.ok, false);
    assert.equal(result.code, "provider_rejected");
    assert.deepEqual(t.calls.sent, []);
  });
  await withSetup({ create: async () => { throw new WakeError("timeout", "lost"); } }, async (t) => {
    const result = await performWake(t.deps, req());
    assert.equal(result.ok, false);
    assert.match(result.text, /may exist/);
    assert.deepEqual(t.calls.sent, []);
  });
});

test("a definite refusal of the delivery withdraws the held message and reports the created session", async () => {
  await withSetup({ wake: async () => { throw new WakeError("rejected", "intercom is too old"); } }, async (t) => {
    const result = await performWake(t.deps, req());
    assert.equal(result.ok, false);
    assert.equal(t.calls.cancelled.length, 1);
    assert.equal(result.target?.piSessionId, NEW_ID);
  });
});

test("a failed spawn does not count toward the limit", async () => {
  await withSetup({ config: { spawnMax: 1, spawnConfirm: "never" }, create: async () => { throw new WakeError("rejected", "no"); } }, async (t) => {
    await performWake(t.deps, req({ message: "a" }));
    t.deps.provider = { ...t.deps.provider!, create: async () => ({ piSessionId: NEW_ID }) };
    assert.equal((await performWake(t.deps, req({ message: "b" }))).ok, true);
  });
});
