import test from "node:test";
import assert from "node:assert/strict";
import { defaultWakeConfig } from "../config.ts";
import { checkLimits, checkMessage, cwdAllowed, findSecretLikeContent, MAX_WAKE_MESSAGE_BYTES } from "./policy.ts";
import type { WakeAuditEntry } from "./audit.ts";

const entry = (over: Partial<WakeAuditEntry>): WakeAuditEntry => ({
  ts: 1_000_000, outcome: "attempting", code: "reserved", messageId: "m1", target: { piSessionId: "p1", cwd: "/repo" }, sender: {}, textLength: 1, textSha256: "x", dedupKey: "k1", ...over,
});
const q = { piSessionId: "p1", cwd: "/repo", dedupKey: "k1" };

test("messages that look like secrets, are empty, or are too large are refused", () => {
  assert.equal(checkMessage("please review the diff").ok, true);
  assert.equal(checkMessage("   ").ok, false);
  assert.equal(checkMessage("x".repeat(MAX_WAKE_MESSAGE_BYTES + 1)).ok, false);
  for (const secret of ["ghp_" + "a".repeat(36), "github_pat_" + "A".repeat(50), "AKIA" + "A".repeat(16), "-----BEGIN OPENSSH PRIVATE KEY-----", "Authorization: Bearer " + "a".repeat(40), "password = hunter2hunter2"]) {
    assert.ok(findSecretLikeContent(secret), secret.slice(0, 12));
    const verdict = checkMessage(`here: ${secret}`);
    assert.equal(!verdict.ok && verdict.code, "possible_secret");
  }
});

test("only directories in the allowlist may be woken, and an empty allowlist allows nothing", () => {
  const config = { ...defaultWakeConfig(), allowCwds: ["/repo"] };
  assert.equal(cwdAllowed(config, "/repo"), true);
  assert.equal(cwdAllowed(config, "/repo/"), true);
  assert.equal(cwdAllowed(config, "/repo/sub"), false);
  assert.equal(cwdAllowed(defaultWakeConfig(), "/repo"), false);
});

test("an identical message to the same session inside the window is a duplicate; a failed attempt does not count", () => {
  const config = defaultWakeConfig();
  const now = 1_000_000 + 60_000;
  assert.equal(checkLimits(config, [entry({})], q, now)?.code, "duplicate");
  assert.equal(checkLimits(config, [entry({}), entry({ outcome: "failed", code: "provider_not_found" })], q, now), undefined, "the host refused, nothing was sent");
  assert.equal(checkLimits({ ...config, perTargetWindowMs: 1 }, [entry({})], q, 1_000_000 + config.dedupMs + 1), undefined, "outside the duplicate window");
  assert.equal(checkLimits(config, [entry({})], { ...q, dedupKey: "other" }, now), undefined);
});

test("per-target and global rate limits count reservations in their windows", () => {
  const config = { ...defaultWakeConfig(), perTargetMax: 2, globalMax: 3 };
  const now = 1_000_000 + 1000;
  const two = [entry({ messageId: "a", dedupKey: "ka" }), entry({ messageId: "b", dedupKey: "kb" })];
  assert.equal(checkLimits(config, two, { ...q, dedupKey: "new" }, now)?.code, "rate_limited_target");
  assert.equal(checkLimits(config, two, { piSessionId: "p2", cwd: "/repo", dedupKey: "new" }, now), undefined);
  const three = [...two, entry({ messageId: "c", dedupKey: "kc", target: { piSessionId: "p2", cwd: "/repo" } })];
  assert.equal(checkLimits(config, three, { piSessionId: "p3", cwd: "/repo", dedupKey: "new" }, now)?.code, "rate_limited_global");
  assert.equal(checkLimits(config, two, { ...q, dedupKey: "new" }, 1_000_000 + config.perTargetWindowMs + 1), undefined, "outside the window");
});

test("with its own reservation counted, the limit is exceeded only by more than the maximum", () => {
  const config = { ...defaultWakeConfig(), perTargetMax: 2 };
  const own = entry({ messageId: "own", dedupKey: "kown" });
  const other = entry({ messageId: "o1", dedupKey: "ko1" });
  assert.equal(checkLimits(config, [other, own], { ...q, dedupKey: "kown" }, 1_001_000, "own"), undefined);
  assert.equal(checkLimits(config, [other, entry({ messageId: "o2", dedupKey: "ko2" }), own], { ...q, dedupKey: "kown" }, 1_001_000, "own")?.code, "rate_limited_target");
});
