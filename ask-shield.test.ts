import test from "node:test";
import assert from "node:assert/strict";
import { ASK_ANSWERS_CUSTOM_TYPE, askModelOf, decideShield, findOpenAsk, isUrgentMessage, type AskEntryLike, type DaemonVerdict } from "./ask-shield.ts";

const iso = (ms: number) => new Date(ms).toISOString();
const NOW = Date.parse("2026-10-27T12:00:00.000Z");
const posted = (askId: string, at: number, over: Partial<NonNullable<AskEntryLike["message"]>> = {}): AskEntryLike => ({
  type: "message", timestamp: iso(at),
  message: { role: "toolResult", toolName: "ask_user", isError: false, details: { ask: { askId, askedAt: iso(at) } }, ...over },
});
const closed = (askId: string, reason = "submitted"): AskEntryLike => ({ type: "custom_message", customType: ASK_ANSWERS_CUSTOM_TYPE, details: { askId, reason }, timestamp: iso(NOW) });

test("a form is open from its ask_user result until its answers entry, and only the latest one counts", () => {
  assert.deepEqual(findOpenAsk([posted("a1", NOW - 1000)]), { askId: "a1", postedAt: NOW - 1000 });
  assert.equal(findOpenAsk([posted("a1", NOW - 5000), closed("a1")]), undefined, "answered");
  assert.equal(findOpenAsk([posted("a1", NOW - 5000), closed("a1", "cancelled")]), undefined, "cancelled or voided");
  assert.equal(findOpenAsk([posted("a1", NOW - 9000), closed("a1"), posted("a2", NOW - 1000)])?.askId, "a2", "a later form is open again");
  assert.equal(findOpenAsk([posted("a1", NOW - 9000), posted("a2", NOW - 1000)])?.askId, "a2", "a newer form replaces the older one");
  assert.equal(findOpenAsk([posted("a1", NOW - 9000), posted("a2", NOW - 1000), closed("a1")])?.askId, "a2", "closing the superseded form does not close the newer one");
  assert.equal(findOpenAsk([]), undefined);
});

test("entries that only look like a form are ignored", () => {
  assert.equal(findOpenAsk([posted("a1", NOW, { isError: true })]), undefined, "a rejected question set");
  assert.equal(findOpenAsk([posted("a1", NOW, { toolName: "bash" })]), undefined, "another tool");
  assert.equal(findOpenAsk([posted("a1", NOW, { details: {} })]), undefined, "no ask id");
  assert.equal(findOpenAsk([posted("a1", NOW, { details: { ask: { askId: "" } } })]), undefined);
  assert.equal(findOpenAsk([{ type: "message", message: { role: "assistant" } }, { type: "custom", customType: ASK_ANSWERS_CUSTOM_TYPE }]), undefined);
  assert.equal(findOpenAsk([{ type: "message", message: { role: "toolResult", toolName: "ask_user", details: { ask: { askId: "x", askedAt: "not a date" } } }, timestamp: "also not" }]), undefined);
});

test("[URGENTE] is recognised at the start of a message, after at most one leading tag", () => {
  assert.equal(isUrgentMessage("[URGENTE] Alert"), true);
  assert.equal(isUrgentMessage("  [urgent] alert"), true);
  assert.equal(isUrgentMessage("[RICHIESTA] [URGENTE] fai subito"), true);
  assert.equal(isUrgentMessage("[INFO] nothing urgent here"), false);
  assert.equal(isUrgentMessage("This is [URGENTE] in the middle of a long sentence that goes on"), false);
});

const base = (over: { entries?: AskEntryLike[]; now?: number; runtimeStartedAt?: number; verdicts?: Map<string, DaemonVerdict>; enabled?: boolean; maxAgeMs?: number; askModel?: "legacy" | "durable" | undefined } = {}) => decideShield({
  entries: over.entries ?? [posted("a1", NOW - 60_000)],
  now: over.now ?? NOW,
  runtimeStartedAt: over.runtimeStartedAt ?? NOW - 3_600_000,
  verdicts: over.verdicts ?? new Map(),
  options: { askModel: "askModel" in over ? over.askModel : "legacy", enabled: over.enabled ?? true, maxAgeMs: over.maxAgeMs ?? 6 * 3_600_000, verdictTtlMs: 60_000 },
});

test("a form posted during this runtime shields, and asks for a daemon check", () => {
  const decision = base();
  assert.deepEqual([decision.shield, decision.askId, decision.reason, decision.needsVerification], [true, "a1", "open_form", true]);
});

test("a fresh daemon verdict decides: open keeps the shield, closed drops it", () => {
  const open = base({ verdicts: new Map([["a1", { open: true, at: NOW - 1000 }]]) });
  assert.deepEqual([open.shield, open.needsVerification], [true, undefined]);
  const dead = base({ verdicts: new Map([["a1", { open: false, at: NOW - 1000 }]]) });
  assert.deepEqual([dead.shield, dead.reason], [false, "daemon_says_closed"]);
  const old = base({ verdicts: new Map([["a1", { open: false, at: NOW - 120_000 }]]) });
  assert.deepEqual([old.shield, old.needsVerification], [true, true], "an old verdict is not trusted, and is refreshed");
});

test("a form posted before this runtime started counts only if the daemon confirmed it", () => {
  const unconfirmed = base({ runtimeStartedAt: NOW - 1000 });
  assert.deepEqual([unconfirmed.shield, unconfirmed.reason, unconfirmed.needsVerification], [false, "posted_before_this_runtime_unconfirmed", true]);
  const confirmed = base({ runtimeStartedAt: NOW - 1000, verdicts: new Map([["a1", { open: true, at: NOW - 500 }]]) });
  assert.equal(confirmed.shield, true);
  const denied = base({ runtimeStartedAt: NOW - 1000, verdicts: new Map([["a1", { open: false, at: NOW - 500 }]]) });
  assert.equal(denied.shield, false);
});

test("every doubt means deliver as before: disabled, no form, stale, answered", () => {
  assert.deepEqual([base({ enabled: false }).shield, base({ enabled: false }).reason], [false, "disabled"]);
  assert.equal(base({ entries: [] }).shield, false);
  assert.equal(base({ entries: [posted("a1", NOW - 60_000), closed("a1")] }).shield, false);
  const stale = base({ entries: [posted("a1", NOW - 7 * 3_600_000)] });
  assert.deepEqual([stale.shield, stale.reason], [false, "stale"]);
});

test("the form model comes from the daemon's runtime version: 1.202610.1 and older are legacy, 1.202610.2 and newer are durable", () => {
  assert.equal(askModelOf("1.202610.1"), "legacy");
  assert.equal(askModelOf("1.202609.9"), "legacy");
  assert.equal(askModelOf("1.202610.0"), "legacy");
  assert.equal(askModelOf("0.99.99"), "legacy");
  for (const version of ["1.202610.2", "1.202610.8", "1.202611.1", "2.0.0", "1.202610.10"]) assert.equal(askModelOf(version), "durable", version);
  assert.equal(askModelOf(undefined), undefined);
  assert.equal(askModelOf(""), undefined);
  assert.equal(askModelOf("latest"), undefined);
  assert.equal(askModelOf("sessiond 1.202610.1"), undefined, "only a bare version");
});

test("with the durable model, or an unknown one, there is nothing to protect and messages are delivered as before", () => {
  const durable = base({ askModel: "durable" });
  assert.deepEqual([durable.shield, durable.reason], [false, "host_has_durable_forms"]);
  const unknown = base({ askModel: undefined });
  assert.deepEqual([unknown.shield, unknown.reason], [false, "host_unknown"]);
  assert.equal(base({ askModel: "legacy" }).shield, true);
});
