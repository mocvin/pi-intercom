import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WakeAudit, sha256, type WakeAuditEntry } from "./audit.ts";

const entry = (over: Partial<WakeAuditEntry> = {}): WakeAuditEntry => ({
  ts: Date.now(), outcome: "delivered", code: "delivered", messageId: "m", target: { piSessionId: "p", cwd: "/repo" }, sender: {}, textLength: 5, textSha256: sha256("hello"), ...over,
});
const withDir = (fn: (dir: string) => void) => { const dir = mkdtempSync(join(tmpdir(), "wake-audit-")); try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

test("the audit file is private (0600) in a private directory and holds one JSON object per line", () => {
  withDir((dir) => {
    const audit = new WakeAudit(join(dir, "sub", "wake-audit.jsonl"));
    audit.append(entry({ messageId: "a" }));
    audit.append(entry({ messageId: "b" }));
    assert.equal(statSync(audit.path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "sub")).mode & 0o777, 0o700);
    assert.deepEqual(audit.read().map((e) => e.messageId), ["a", "b"]);
  });
});

test("the message text never reaches the audit; only its length and hash do", () => {
  withDir((dir) => {
    const audit = new WakeAudit(join(dir, "a.jsonl"));
    const secretText = "super private brief for the other agent";
    audit.append(entry({ textLength: secretText.length, textSha256: sha256(secretText), detail: "The session daemon refused the wake (HTTP 400)" }));
    assert.equal(readFileSync(audit.path, "utf-8").includes("private brief"), false);
    assert.equal(audit.read()[0]!.textSha256, sha256(secretText));
  });
});

test("retention drops old entries and keeps at most maxEntries, newest last", () => {
  withDir((dir) => {
    const audit = new WakeAudit(join(dir, "a.jsonl"), 3, 24 * 60 * 60 * 1000);
    audit.append(entry({ messageId: "old", ts: Date.now() - 3 * 24 * 60 * 60 * 1000 }));
    for (const id of ["1", "2", "3", "4"]) audit.append(entry({ messageId: id }));
    assert.deepEqual(audit.read().map((e) => e.messageId), ["2", "3", "4"]);
  });
});

test("a torn or foreign line does not stop the audit from being read", () => {
  withDir((dir) => {
    const audit = new WakeAudit(join(dir, "a.jsonl"));
    audit.append(entry({ messageId: "ok" }));
    appendFileSync(audit.path, '{"ts":1,"outcome":"deliv\nnot json\n{"unrelated":true}\n');
    writeFileSync(`${audit.path}.unused`, "");
    assert.deepEqual(audit.read().map((e) => e.messageId), ["ok"]);
  });
});

test("an append that cannot be written throws, so callers fail closed", () => {
  withDir((dir) => {
    const audit = new WakeAudit(join(dir, "missing-parent-is-created", "x", "a.jsonl"));
    audit.append(entry());
    const blocked = new WakeAudit(join(dir, "a.jsonl", "child.jsonl")); // a.jsonl below is a file, not a directory
    writeFileSync(join(dir, "a.jsonl"), "");
    assert.throws(() => blocked.append(entry()));
  });
});
