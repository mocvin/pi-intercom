import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultWakeConfig, type WakeConfig } from "../config.ts";
import type { SendResult } from "../broker/client.ts";
import type { MessageReceipt, SessionInfo } from "../types.ts";
import { WakeAudit } from "./audit.ts";
import { performArchive, performWake, type WakeClient, type WakeDeps } from "./controller.ts";
import { DIALOG_TEXT_BUDGET, clip, clipMiddle, dialogBody } from "./policy.ts";
import type { WakeProvider } from "./provider.ts";

/** What PI WEB does: a dialog whose title or text is over 1000 characters is refused, and confirm() rejects. */
const PI_WEB_LIMIT = 1000;
const NEW_ID = "0198b0b0-cccc-7ddd-8eee-ffff00001111";
const TARGET = "0198a0a0-aaaa-7bbb-8ccc-ddddeeeeffff";
const ok = (id: string): SendResult => ({ id, delivered: true, delivery: "queued", code: "wake_pending", retryable: false, outcomeKnown: true });

function setup(over: { cwd?: string; name?: string; confirm?: (title: string, body: string) => Promise<boolean>; self?: string } = {}) {
  const cwd = over.cwd ?? "/proj";
  const dir = mkdtempSync(join(tmpdir(), "dialog-"));
  const handlers = new Set<(from: SessionInfo, receipt: MessageReceipt) => void>();
  const calls = { sent: 0, bodies: [] as string[], created: 0, woken: 0, archived: 0 };
  let lastId = "";
  const client: WakeClient = {
    sessionId: "sender-intercom-id",
    supportsFeature: () => true,
    listSessions: async () => [],
    send: async (_to, options) => { lastId = options.messageId!; calls.sent++; return ok(options.messageId!); },
    cancelMessage: async (id) => ok(id),
    onMessageReceipt: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
  };
  const provider: WakeProvider = {
    id: "fake",
    list: async () => [{ piSessionId: TARGET, cwd, name: over.name ?? "worker", archived: false }],
    wake: async () => { calls.woken++; for (const handler of handlers) handler({} as SessionInfo, { messageId: lastId, status: "receiver_received", timestamp: Date.now() }); },
    create: async () => { calls.created++; return { piSessionId: NEW_ID }; },
    archive: async () => { calls.archived++; },
  };
  const config: WakeConfig = { ...defaultWakeConfig(), enabled: true, provider: "fake", allowCwds: [cwd], deliveryTimeoutMs: 250 };
  const audit = new WakeAudit(join(dir, "wake-audit.jsonl"));
  const piWeb = async (title: string, body: string): Promise<boolean> => {
    calls.bodies.push(body);
    if (title.length > PI_WEB_LIMIT || body.length > PI_WEB_LIMIT) throw new Error("message exceeds its length limit");
    return over.confirm ? over.confirm(title, body) : true;
  };
  const deps: WakeDeps = { client, config, provider, audit, confirm: piWeb, self: { intercomId: "sender-intercom-id", piSessionId: over.self ?? "sender-pi-id", cwd: "/elsewhere" } };
  return { deps, calls, audit, cwd, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("dialogBody never exceeds the budget, whatever the message", () => {
  const head = "H".repeat(300);
  for (const length of [0, 1, 50, 600, 601, 5000, 100_000]) {
    const body = dialogBody(head, "m".repeat(length));
    assert.ok(body.length <= DIALOG_TEXT_BUDGET, `message ${length} -> ${body.length}`);
    assert.ok(body.startsWith(head));
  }
  assert.equal(dialogBody("head", "short"), "head\n\nshort");
  assert.equal(dialogBody("head", ""), "head");
  assert.ok(dialogBody("H".repeat(2000), "x").length <= DIALOG_TEXT_BUDGET, "even a huge head is bounded");
});

test("clip does not split a surrogate pair, and clipMiddle keeps the end of a path", () => {
  const emoji = "😀".repeat(50);
  const clipped = clip(emoji, 11);
  assert.ok(clipped.length <= 11);
  assert.doesNotMatch(clipped, /[\ud800-\udbff](?![\udc00-\udfff])/, "no lone high surrogate");
  const path = `/mnt/c/Users/x/${"d/".repeat(100)}Projects/the-end`;
  const middle = clipMiddle(path, 60);
  assert.ok(middle.length <= 60);
  assert.ok(middle.endsWith("Projects/the-end".slice(-10)));
  assert.equal(clipMiddle("/short", 60), "/short");
});

test("a wake with a long message, a long name and a long directory still shows a dialog PI WEB accepts", async () => {
  const cwd = `/mnt/c/Users/someone/Documents/vault/Company/${"long-directory-name/".repeat(12)}2. Meeting`;
  for (const length of [1, 592, 5000]) {
    const t = setup({ cwd, name: "Teams e Posta read-only handover ".repeat(8) });
    try {
      const result = await performWake(t.deps, { to: TARGET, cwd, message: `Update ${"x".repeat(length)}` });
      assert.equal(result.ok, true, `message ${length}: ${result.text}`);
      assert.equal(t.calls.bodies.length, 1);
      assert.ok(t.calls.bodies[0]!.length <= PI_WEB_LIMIT, `dialog ${t.calls.bodies[0]!.length}`);
    } finally {
      t.cleanup();
    }
  }
});

test("the case that was refused (592 characters, long directory) now works", async () => {
  const cwd = "/mnt/c/Users/someone/Documents/vault/Company/2. Meeting";
  const t = setup({ cwd, name: "Teams e Posta read-only handover" });
  try {
    const result = await performWake(t.deps, { to: TARGET, cwd, message: "a".repeat(592) });
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "delivered");
  } finally {
    t.cleanup();
  }
});

test("a dialog that fails is an error, never a refusal: nothing is sent, nothing is reserved, and a retry works", async () => {
  let fail = true;
  const t = setup({ confirm: async () => { if (fail) throw new Error("the UI is gone"); return true; } });
  try {
    const result = await performWake(t.deps, { to: TARGET, cwd: t.cwd, message: "Please review" });
    assert.equal(result.ok, false);
    assert.equal(result.code, "confirmation_failed");
    assert.doesNotMatch(result.text, /cancelled by the user/i);
    assert.deepEqual([t.calls.sent, t.calls.woken], [0, 0]);
    assert.equal(t.audit.read().some((e) => e.outcome === "attempting"), false, "the failed dialog consumed no rate limit");
    assert.equal(t.audit.read().some((e) => e.code === "user_declined"), false);
    fail = false;
    assert.equal((await performWake(t.deps, { to: TARGET, cwd: t.cwd, message: "Please review" })).ok, true, "the same message is not refused as a duplicate");
  } finally {
    t.cleanup();
  }
});

test("a user who really declines is still recorded as a refusal", async () => {
  const t = setup({ confirm: async () => false });
  try {
    const result = await performWake(t.deps, { to: TARGET, cwd: t.cwd, message: "Please review" });
    assert.equal(result.code, "user_declined");
    assert.equal(t.audit.read().at(-1)!.outcome, "refused");
  } finally {
    t.cleanup();
  }
});

test("spawn: a long task and long directories give an accepted dialog; a failing dialog creates nothing", async () => {
  const cwd = `/mnt/c/Users/someone/${"nested-project-directory/".repeat(10)}app`;
  const t = setup({ cwd });
  try {
    const result = await performWake({ ...t.deps, self: { intercomId: "i".repeat(80), piSessionId: "sender-pi-id", cwd: cwd + "/sub".repeat(60) } }, { to: "", cwd, message: "Task. ".repeat(500), spawn: true });
    assert.equal(result.ok, true, result.text);
    assert.ok(t.calls.bodies[0]!.length <= PI_WEB_LIMIT);
  } finally {
    t.cleanup();
  }
  const broken = setup({ confirm: async () => { throw new Error("boom"); } });
  try {
    const result = await performWake(broken.deps, { to: "", cwd: broken.cwd, message: "Task", spawn: true });
    assert.equal(result.code, "confirmation_failed");
    assert.equal(broken.calls.created, 0, "no session is created when the dialog fails");
  } finally {
    broken.cleanup();
  }
});

test("archive: the dialog is bounded and a failing dialog archives nothing", async () => {
  const cwd = `/mnt/c/${"project-directory/".repeat(20)}app`;
  const seeded = (t: ReturnType<typeof setup>) => t.audit.append({ ts: Date.now() - 1000, kind: "spawn", outcome: "delivered", code: "delivered", messageId: "m0", target: { piSessionId: NEW_ID, cwd }, sender: { piSessionId: "sender-pi-id" }, textLength: 1, textSha256: "x" });
  const t = setup({ cwd });
  try {
    seeded(t);
    const { client: _client, ...deps } = t.deps;
    const result = await performArchive({ ...deps, self: { ...deps.self, intercomId: "i".repeat(80) } }, { piSessionId: NEW_ID, cwd });
    assert.equal(result.ok, true, result.text);
    assert.ok(t.calls.bodies[0]!.length <= PI_WEB_LIMIT);
  } finally {
    t.cleanup();
  }
  const broken = setup({ cwd, confirm: async () => { throw new Error("boom"); } });
  try {
    seeded(broken);
    const { client: _client, ...deps } = broken.deps;
    const result = await performArchive(deps, { piSessionId: NEW_ID, cwd });
    assert.equal(result.code, "confirmation_failed");
    assert.equal(broken.calls.archived, 0);
  } finally {
    broken.cleanup();
  }
});
