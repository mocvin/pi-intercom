import test from "node:test";
import assert from "node:assert/strict";
import { resolveWakeCandidate } from "./resolve.ts";
import type { WakeCandidate } from "./provider.ts";

const c = (piSessionId: string, extra: Partial<WakeCandidate> = {}): WakeCandidate => ({ piSessionId, cwd: "/repo", archived: false, ...extra });

test("an exact full Pi session id resolves, even when another session carries that string as its name", () => {
  const result = resolveWakeCandidate([c("0198-aaaa", { name: "worker" }), c("0198-bbbb", { name: "0198-aaaa" })], "0198-aaaa", "/repo");
  assert.equal(result.ok && result.candidate.piSessionId, "0198-aaaa");
});

test("a name resolves only when it is exact (case-insensitive) and unique in the directory", () => {
  assert.equal(resolveWakeCandidate([c("a", { name: "Reviewer" })], "reviewer", "/repo").ok, true);
  const ambiguous = resolveWakeCandidate([c("a", { name: "worker" }), c("b", { name: "Worker" })], "worker", "/repo");
  assert.deepEqual(ambiguous.ok, false);
  assert.equal(!ambiguous.ok && ambiguous.code, "ambiguous");
  const prefix = resolveWakeCandidate([c("a", { name: "reviewer-long" })], "reviewer", "/repo");
  assert.equal(!prefix.ok && prefix.code, "not_found", "name prefixes never resolve");
});

test("an id prefix never resolves: waking needs the full id", () => {
  const result = resolveWakeCandidate([c("0198a0a0-1111-7222-8333-444455556666")], "0198a0a0", "/repo");
  assert.equal(!result.ok && result.code, "not_found");
});

test("sessions of another directory are not candidates", () => {
  const result = resolveWakeCandidate([c("a", { cwd: "/elsewhere", name: "worker" })], "a", "/repo");
  assert.equal(!result.ok && result.code, "not_found");
});

test("an archived session is refused even when it is the only match", () => {
  const result = resolveWakeCandidate([c("a", { archived: true })], "a", "/repo");
  assert.equal(!result.ok && result.code, "archived");
});
