import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { defaultWakeConfig, type WakeConfig } from "../config.ts";
import type { SendResult } from "../broker/client.ts";
import type { MessageReceipt, SessionInfo } from "../types.ts";
import { WakeAudit } from "./audit.ts";
import { findLiveWakeTarget, performWake, type WakeClient, type WakeDeps } from "./controller.ts";
import { WakeError, type WakeCandidate, type WakeProvider } from "./provider.ts";

const TARGET = "0198a0a0-aaaa-7bbb-8ccc-ddddeeeeffff";
const ok = (id: string, extra: Partial<SendResult> = {}): SendResult => ({ id, delivered: true, delivery: "queued", code: "wake_pending", retryable: false, outcomeKnown: true, ...extra });

function setup(over: { config?: Partial<WakeConfig>; features?: string[]; candidates?: WakeCandidate[]; sendResult?: (id: string) => SendResult; wake?: (messageId: string, emit: (status: MessageReceipt["status"]) => void) => Promise<void>; confirm?: false | ((t: string, b: string) => Promise<boolean>) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "wake-controller-"));
  const handlers = new Set<(from: SessionInfo, receipt: MessageReceipt) => void>();
  const calls = { sent: [] as Array<{ to: string; wake?: unknown; text: string }>, cancelled: [] as string[], woken: [] as string[], confirms: 0 };
  let lastId = "";
  const client: WakeClient = {
    sessionId: "sender-intercom-id",
    supportsFeature: (feature) => (over.features ?? ["wake-v1"]).includes(feature),
    listSessions: async () => [],
    send: async (to, options) => { lastId = options.messageId!; calls.sent.push({ to, text: options.text, ...(options.wake ? { wake: options.wake } : {}) }); const result = over.sendResult ? over.sendResult(options.messageId!) : ok(options.messageId!); return result; },
    cancelMessage: async (id) => { calls.cancelled.push(id); return ok(id, { delivery: "socket_delivered", code: undefined }); },
    onMessageReceipt: (handler) => { handlers.add(handler); return () => handlers.delete(handler); },
  };
  const emit = (status: MessageReceipt["status"]) => { for (const handler of handlers) handler({} as SessionInfo, { messageId: lastId, status, timestamp: Date.now() }); };
  const provider: WakeProvider = {
    id: "fake",
    describe: () => "fake 1.0",
    list: async () => over.candidates ?? [{ piSessionId: TARGET, cwd: "/repo", name: "worker", archived: false }],
    wake: async (_target, messageId) => { calls.woken.push(messageId); await (over.wake ?? (async (_id, e) => { e("receiver_received"); }))(messageId, emit); },
  };
  const config: WakeConfig = { ...defaultWakeConfig(), enabled: true, provider: "fake", allowCwds: ["/repo"], deliveryTimeoutMs: 250, ...over.config };
  const audit = new WakeAudit(join(dir, "wake-audit.jsonl"));
  const deps: WakeDeps = {
    client, config, provider, audit,
    ...(over.confirm === false ? {} : { confirm: async (t: string, b: string) => { calls.confirms++; const c = over.confirm; return c ? c(t, b) : true; } }),
    self: { intercomId: "sender-intercom-id", piSessionId: "sender-pi-id", cwd: "/elsewhere" },
  };
  return { deps, calls, audit, config, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const request = (over: Record<string, unknown> = {}) => ({ to: TARGET, cwd: "/repo", message: "Please review the open branch", ...over });
const finals = (audit: WakeAudit) => audit.read().filter((e) => e.outcome !== "attempting");

test("a wake holds the message once, reopens the session, and reports the receipt", async () => {
  const t = setup();
  try {
    const result = await performWake(t.deps, request());
    assert.equal(result.ok, true);
    assert.equal(result.outcome, "delivered");
    assert.equal(t.calls.sent.length, 1);
    assert.deepEqual(t.calls.sent[0]!.wake, { piSessionId: TARGET, cwd: "/repo" });
    assert.equal(t.calls.woken.length, 1);
    assert.equal(t.calls.woken[0], t.calls.sent[0] && result.messageId);
    assert.deepEqual(t.audit.read().map((e) => e.outcome), ["attempting", "delivered"]);
    assert.equal(t.calls.confirms, 1);
    assert.equal(readFileSync(t.audit.path, "utf-8").includes("open branch"), false, "the audit never holds the text");
  } finally { t.cleanup(); }
});

test("a name resolves through the catalog but the broker is always addressed by the exact Pi session id", async () => {
  const t = setup();
  try {
    const result = await performWake(t.deps, request({ to: "Worker" }));
    assert.equal(result.ok, true);
    assert.equal(t.calls.sent[0]!.to, TARGET);
    assert.equal(result.target?.piSessionId, TARGET);
  } finally { t.cleanup(); }
});

test("every blocked case holds nothing, calls nothing on the host that changes state, and is audited", async () => {
  const cases: Array<[string, Parameters<typeof setup>[0], Record<string, unknown>, string]> = [
    ["disabled by default", { config: { enabled: false } }, {}, "wake_disabled"],
    ["broker without wake-v1", { features: [] }, {}, "broker_unsupported"],
    ["no provider registered", {}, {}, "provider_missing"],
    ["relative cwd", {}, { cwd: "repo" }, "invalid_cwd"],
    ["cwd not allowed", { config: { allowCwds: ["/other"] } }, {}, "cwd_not_allowed"],
    ["empty allowlist", { config: { allowCwds: [] } }, {}, "cwd_not_allowed"],
    ["secret in the message", {}, { message: `token ghp_${"a".repeat(36)}` }, "possible_secret"],
    ["empty message", {}, { message: "  " }, "empty_message"],
    ["no UI to confirm", { confirm: false }, {}, "confirmation_unavailable"],
    ["session not in catalog", { candidates: [] }, {}, "not_found"],
    ["archived session", { candidates: [{ piSessionId: TARGET, cwd: "/repo", archived: true }] }, {}, "archived"],
    ["ambiguous name", { candidates: [{ piSessionId: "a", cwd: "/repo", name: "w", archived: false }, { piSessionId: "b", cwd: "/repo", name: "w", archived: false }] }, { to: "w" }, "ambiguous"],
    ["bad message id", {}, { messageId: "x y" }, "invalid_message_id"],
  ];
  for (const [label, over, req, code] of cases) {
    const t = setup(over);
    try {
      const deps = label === "no provider registered" ? { ...t.deps, provider: undefined } : t.deps;
      const result = await performWake(deps, request(req));
      assert.equal(result.ok, false, label);
      assert.equal(result.code, code, label);
      assert.equal(result.outcome, "blocked", label);
      assert.deepEqual([t.calls.sent.length, t.calls.woken.length, t.calls.cancelled.length], [0, 0, 0], label);
      assert.equal(finals(t.audit).length, 1, label);
    } finally { t.cleanup(); }
  }
});

test("a daemon that cannot be reached blocks the wake and holds nothing", async () => {
  const t = setup();
  try {
    t.deps.provider = { ...t.deps.provider!, list: async () => { throw new WakeError("unavailable", "Cannot reach the session daemon (ECONNREFUSED)"); } };
    const result = await performWake(t.deps, request());
    assert.equal(result.ok, false);
    assert.equal(result.code, "provider_unavailable");
    assert.equal(t.calls.sent.length, 0);
  } finally { t.cleanup(); }
});

test("the current session can never be woken", async () => {
  const t = setup({ candidates: [{ piSessionId: "sender-pi-id", cwd: "/repo", archived: false }] });
  try {
    const result = await performWake(t.deps, request({ to: "sender-pi-id" }));
    assert.equal(result.code, "self_target");
    assert.equal(t.calls.sent.length, 0);
  } finally { t.cleanup(); }
});

test("a declined confirmation holds and wakes nothing", async () => {
  const t = setup({ confirm: async () => false });
  try {
    const result = await performWake(t.deps, request());
    assert.deepEqual([result.ok, result.outcome, result.code], [false, "refused", "user_declined"]);
    assert.deepEqual([t.calls.sent.length, t.calls.woken.length], [0, 0]);
    assert.equal(t.audit.read().some((e) => e.outcome === "attempting"), false, "no reservation was written");
  } finally { t.cleanup(); }
});

test("the confirmation names the session, the directory, and the message, and 'never' skips it for allowlisted directories", async () => {
  let seen = "";
  const t = setup({ confirm: async (_title, body) => { seen = body; return true; } });
  try {
    await performWake(t.deps, request());
    assert.match(seen, /worker/);
    assert.match(seen, new RegExp(TARGET));
    assert.match(seen, /\/repo/);
    assert.match(seen, /open branch/);
  } finally { t.cleanup(); }
  const quiet = setup({ config: { confirm: "never" }, confirm: false });
  try {
    assert.equal((await performWake(quiet.deps, request())).ok, true);
  } finally { quiet.cleanup(); }
});

test("a target that connected first is delivered to normally and the host is not asked to wake anything", async () => {
  const t = setup({ sendResult: (id) => ok(id, { delivery: "socket_delivered", code: undefined }) });
  try {
    const result = await performWake(t.deps, request());
    assert.deepEqual([result.ok, result.outcome], [true, "already_connected"]);
    assert.equal(t.calls.woken.length, 0);
  } finally { t.cleanup(); }
});

test("a broker that refuses the hold ends the wake without touching the host", async () => {
  const t = setup({ sendResult: (id) => ({ id, delivered: false, delivery: "failed", reason: "Invalid wake target", code: "E_INVALID_WAKE", retryable: false, outcomeKnown: true }) });
  try {
    const result = await performWake(t.deps, request());
    assert.deepEqual([result.ok, result.code], [false, "E_INVALID_WAKE"]);
    assert.equal(t.calls.woken.length, 0);
    assert.equal(finals(t.audit)[0]!.outcome, "failed");
  } finally { t.cleanup(); }
});

test("when the host refuses the wake, the held message is withdrawn and the attempt does not count against the limits", async () => {
  const t = setup({ wake: async () => { throw new WakeError("archived", "The session is archived and read-only"); } });
  try {
    const result = await performWake(t.deps, request());
    assert.deepEqual([result.ok, result.outcome, result.code], [false, "failed", "provider_archived"]);
    assert.deepEqual(t.calls.cancelled, [result.messageId]);
    assert.match(result.text, /withdrawn/);
    // The same message can be retried straight away: nothing was sent.
    const retry = await performWake({ ...t.deps, provider: { ...t.deps.provider!, wake: async () => undefined } }, request());
    assert.notEqual(retry.code, "duplicate");
  } finally { t.cleanup(); }
});

test("when the host's answer is unknown, the message stays held and the caller is told not to resend", async () => {
  const t = setup({ wake: async () => { throw new WakeError("timeout", "The session daemon request was aborted or timed out"); } });
  try {
    const result = await performWake(t.deps, request());
    assert.deepEqual([result.ok, result.outcome, result.code], [true, "uncertain", "provider_timeout"]);
    assert.deepEqual(t.calls.cancelled, []);
    assert.match(result.text, /Do not resend/);
  } finally { t.cleanup(); }
});

test("an accepted wake with no receipt is reported as held and unconfirmed", async () => {
  const t = setup({ wake: async () => undefined, config: { deliveryTimeoutMs: 120 } });
  try {
    const result = await performWake(t.deps, request());
    assert.deepEqual([result.ok, result.outcome, result.code], [true, "accepted_unconfirmed", "no_receipt"]);
    assert.deepEqual(t.calls.cancelled, []);
  } finally { t.cleanup(); }
});

test("an identical message to the same session is refused as a duplicate, and the limits stop a burst", async () => {
  const t = setup({ config: { perTargetMax: 2 } });
  try {
    assert.equal((await performWake(t.deps, request())).ok, true);
    const duplicate = await performWake(t.deps, request());
    assert.equal(duplicate.code, "duplicate");
    assert.equal(t.calls.sent.length, 1, "the duplicate was never sent");
    assert.equal((await performWake(t.deps, request({ message: "second, different message" }))).ok, true);
    assert.equal((await performWake(t.deps, request({ message: "third, different message" }))).code, "rate_limited_target");
  } finally { t.cleanup(); }
});

test("a failed audit write refuses the wake instead of waking unrecorded", async () => {
  const t = setup();
  try {
    t.deps.audit.append = () => { throw new Error("disk full"); };
    const result = await performWake(t.deps, request());
    assert.deepEqual([result.ok, result.code], [false, "audit_unavailable"]);
    assert.deepEqual([t.calls.sent.length, t.calls.woken.length], [0, 0]);
  } finally { t.cleanup(); }
});

test("findLiveWakeTarget matches a connected session by Pi session id, intercom id, or exact name inside the directory only", () => {
  const s = (id: string, over: Partial<SessionInfo> = {}) => ({ id, cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1, ...over }) as SessionInfo;
  const roster = [s("stable-id", { piSessionId: "pi-1", name: "Worker" }), s("other", { cwd: "/elsewhere", name: "Worker", piSessionId: "pi-2" })];
  assert.equal(findLiveWakeTarget(roster, "pi-1", "/repo")?.id, "stable-id");
  assert.equal(findLiveWakeTarget(roster, "stable-id", "/repo")?.id, "stable-id");
  assert.equal(findLiveWakeTarget(roster, "worker", "/repo")?.id, "stable-id");
  assert.equal(findLiveWakeTarget(roster, "pi-2", "/repo"), undefined, "same name or id in another directory is not the target");
  assert.equal(findLiveWakeTarget(roster, "nobody", "/repo"), undefined);
});

test("a sender the user trusted wakes without a dialog, even without a UI; every other check still applies", async () => {
  const t = setup({ confirm: false });
  try {
    const trust = { find: (id: string) => (id === "sender-pi-id" ? { expiresAt: Date.now() + 60_000 } : undefined) };
    const result = await performWake({ ...t.deps, trust }, request());
    assert.deepEqual([result.ok, result.outcome], [true, "delivered"]);
    assert.equal(t.calls.confirms, 0);
    assert.equal(t.audit.read().find((e) => e.outcome === "delivered")?.confirmedBy, "trust");
    const outside = await performWake({ ...t.deps, trust }, request({ cwd: "/not-allowed", message: "other" }));
    assert.equal(outside.code, "cwd_not_allowed", "trust does not widen the allowlist");
    const secret = await performWake({ ...t.deps, trust }, request({ message: `ghp_${"a".repeat(36)}` }));
    assert.equal(secret.code, "possible_secret");
    const duplicate = await performWake({ ...t.deps, trust }, request());
    assert.equal(duplicate.code, "duplicate");
  } finally { t.cleanup(); }
});

test("a grant for another session does not skip the dialog", async () => {
  const t = setup();
  try {
    const trust = { find: (id: string) => (id === "someone-else" ? { expiresAt: Date.now() + 60_000 } : undefined) };
    await performWake({ ...t.deps, trust }, request());
    assert.equal(t.calls.confirms, 1);
    assert.equal(t.audit.read().find((e) => e.outcome === "delivered")?.confirmedBy, "user");
    const noUi = setup({ confirm: false });
    try {
      assert.equal((await performWake({ ...noUi.deps, trust }, request())).code, "confirmation_unavailable");
    } finally { noUi.cleanup(); }
  } finally { t.cleanup(); }
});
