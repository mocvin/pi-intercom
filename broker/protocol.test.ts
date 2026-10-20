import test from "node:test";
import assert from "node:assert/strict";
import { isSessionInfo, isSessionRegistration, isWakeTarget, messageDeliveryFingerprint } from "./protocol.ts";

const base = { cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1 };

test("session info and registration accept an absent or well-formed Pi session id", () => {
  assert.equal(isSessionInfo({ id: "a", ...base }), true);
  assert.equal(isSessionInfo({ id: "a", piSessionId: "0198a0a0-1111-7222-8333-444455556666", ...base }), true);
  assert.equal(isSessionRegistration(base), true);
  assert.equal(isSessionRegistration({ piSessionId: "p".repeat(256), ...base }), true);
});

test("session info and registration reject a malformed Pi session id", () => {
  for (const piSessionId of [1, true, null, "", "  ", "p".repeat(257), {}, []]) {
    assert.equal(isSessionInfo({ id: "a", piSessionId, ...base }), false, JSON.stringify(piSessionId));
    assert.equal(isSessionRegistration({ piSessionId, ...base }), false, JSON.stringify(piSessionId));
  }
});

test("unknown optional registration fields stay ignored (forward compatibility)", () => {
  assert.equal(isSessionRegistration({ futureField: "x", ...base }), true);
  assert.equal(isSessionInfo({ id: "a", futureField: "x", ...base }), true);
});

test("wake targets need an exact Pi session id and an absolute cwd", () => {
  assert.equal(isWakeTarget({ piSessionId: "0198a0a0-1111-7222-8333-444455556666", cwd: "/repo" }), true);
  for (const bad of [null, "x", {}, { piSessionId: "p" }, { cwd: "/repo" }, { piSessionId: "", cwd: "/repo" }, { piSessionId: "p".repeat(257), cwd: "/repo" },
    { piSessionId: "p", cwd: "relative/dir" }, { piSessionId: "p", cwd: "" }, { piSessionId: "p", cwd: "/" + "d".repeat(4096) }, { piSessionId: 1, cwd: "/repo" }]) {
    assert.equal(isWakeTarget(bad), false, JSON.stringify(bad));
  }
});

test("the delivery fingerprint covers the wake target and is unchanged for ordinary sends", () => {
  const message = { id: "m", timestamp: 1, content: { text: "hello" } };
  const plain = messageDeliveryFingerprint(message, "target");
  assert.equal(plain, messageDeliveryFingerprint(message, "target", undefined));
  assert.equal(JSON.parse(plain).wake, undefined);
  const a = messageDeliveryFingerprint(message, "p", { piSessionId: "p", cwd: "/a" });
  assert.notEqual(a, messageDeliveryFingerprint(message, "p", { piSessionId: "p", cwd: "/b" }));
  assert.notEqual(a, messageDeliveryFingerprint(message, "p"));
});
