import test from "node:test";
import assert from "node:assert/strict";
import { isSessionInfo, isSessionRegistration } from "./protocol.ts";

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
