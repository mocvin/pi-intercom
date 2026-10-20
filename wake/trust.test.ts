import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WakeTrustStore } from "./trust.ts";

const DAY = 24 * 60 * 60 * 1000;
const withStore = (fn: (store: WakeTrustStore, path: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "wake-trust-"));
  try { fn(new WakeTrustStore(join(dir, "intercom", "wake-trust.json")), join(dir, "intercom", "wake-trust.json")); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const coord = { piSessionId: "pi-coord-1", name: "Coordinator", cwd: "/vault" };

test("a grant is private, tied to the Pi session id, and expires", () => {
  withStore((store, path) => {
    const now = 1_000_000_000_000;
    const entry = store.grant(coord, 30, now);
    assert.equal(entry.expiresAt, now + 30 * DAY);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(store.find("pi-coord-1", now + DAY)?.name, "Coordinator");
    assert.equal(store.find("pi-other", now + DAY), undefined, "another session cannot use the grant");
    assert.equal(store.find("Coordinator", now + DAY), undefined, "a name is not an identity");
    assert.equal(store.find("pi-coord-1", now + 30 * DAY + 1), undefined, "expired");
    assert.deepEqual(store.list(now + 30 * DAY + 1), []);
  });
});

test("granting again renews instead of duplicating, and expired grants are dropped on write", () => {
  withStore((store, path) => {
    store.grant({ piSessionId: "old", cwd: "/x" }, 1, 0);
    store.grant(coord, 30, 1000);
    store.grant(coord, 30, 2 * DAY);
    const file = JSON.parse(readFileSync(path, "utf-8"));
    assert.deepEqual(file.entries.map((e: { piSessionId: string }) => e.piSessionId), ["pi-coord-1"]);
    assert.equal(file.entries[0].grantedAt, 2 * DAY);
  });
});

test("revoking removes only that session and reports what was removed", () => {
  withStore((store) => {
    store.grant(coord, 30, 0);
    store.grant({ piSessionId: "pi-coord-2", cwd: "/vault" }, 30, 0);
    assert.equal(store.revoke("pi-coord-1", 1)?.piSessionId, "pi-coord-1");
    assert.equal(store.revoke("pi-coord-1", 1), undefined);
    assert.deepEqual(store.list(1).map((e) => e.piSessionId), ["pi-coord-2"]);
  });
});

test("an unreadable or foreign file grants nothing, and an explicit grant repairs it", () => {
  withStore((store, path) => {
    store.grant(coord, 30, 0);
    for (const bad of ["not json", JSON.stringify({ version: 2, entries: [] }), JSON.stringify({ version: 1, entries: [{ piSessionId: 1 }] })]) {
      writeFileSync(path, bad);
      assert.equal(store.find("pi-coord-1", 1), undefined, "fail closed");
      assert.throws(() => store.list(1));
    }
    store.grant(coord, 30, 2);
    assert.equal(store.find("pi-coord-1", 3)?.piSessionId, "pi-coord-1");
  });
});
