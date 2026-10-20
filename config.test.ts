import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfigPath, loadConfig } from "./config.ts";

async function withAgentDir<T>(agentDir: string, fn: () => T | Promise<T>): Promise<T> {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    return await fn();
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test("getConfigPath uses the centralized intercom runtime directory", () => {
  assert.equal(getConfigPath("/tmp/pi-agent/intercom"), join("/tmp/pi-agent", "intercom", "config.json"));
});

test("loadConfig reads config below PI_CODING_AGENT_DIR", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));

  try {
    const intercomDir = join(root, "intercom");
    mkdirSync(intercomDir, { recursive: true });
    writeFileSync(join(intercomDir, "config.json"), JSON.stringify({ status: "platform-test" }));

    await withAgentDir(root, () => {
      assert.equal(loadConfig().status, "platform-test");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig defaults inboundTrigger to current auto-trigger behavior", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    await withAgentDir(root, () => {
      assert.equal(loadConfig().inboundTrigger, "always");
      assert.equal(loadConfig().busyDelivery, "steer");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig defaults cross-machine routing", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    await withAgentDir(root, () => {
      const config = loadConfig().crossMachine;
      assert.equal(config.remoteCommand, "pi-intercom");
      assert.equal(config.machineName.length > 0, true);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig accepts cross-machine overrides", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ crossMachine: {
      machineName: "laptop",
      remoteCommand: "/opt/tools/pi-intercom",
    } }));
    await withAgentDir(root, () => {
      assert.deepEqual(loadConfig().crossMachine, {
        machineName: "laptop",
        remoteCommand: "/opt/tools/pi-intercom",
      });
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig accepts inboundTrigger replies policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ inboundTrigger: "replies", busyDelivery: "human-first" }));
    await withAgentDir(root, () => {
      assert.equal(loadConfig().inboundTrigger, "replies");
      assert.equal(loadConfig().busyDelivery, "human-first");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig ignores obsolete toolVisibility values", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ toolVisibility: "lazy", replyHint: false }));
    await withAgentDir(root, () => {
      assert.equal(loadConfig().replyHint, false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig accepts a restart-stable intercom id", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ stableId: " pinned-worker " }));
    await withAgentDir(root, () => {
      assert.equal(loadConfig().stableId, "pinned-worker");
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid inboundTrigger values", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ inboundTrigger: "prompt" }));

    await withAgentDir(root, () => {
      assert.throws(
        () => loadConfig(),
        /Failed to load intercom config.*"inboundTrigger" must be "always", "replies", or "never"/,
      );
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects empty cross-machine strings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ crossMachine: { remoteCommand: "  " } }));
    await withAgentDir(root, () => {
      assert.throws(() => loadConfig(), /"crossMachine.remoteCommand" must be a non-empty string/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects invalid busyDelivery values", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ busyDelivery: "prompt" }));
    await withAgentDir(root, () => {
      assert.throws(() => loadConfig(), /"busyDelivery" must be "steer" or "human-first"/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig leaves waking persisted sessions off, confirmed, and empty by default", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    await withAgentDir(root, () => {
      const wake = loadConfig().wake;
      assert.equal(wake.enabled, false);
      assert.equal(wake.confirm, "always");
      assert.deepEqual(wake.allowCwds, []);
      assert.equal(wake.provider, "pi-web-sessiond");
      assert.equal(wake.perTargetMax, 3);
      assert.equal(wake.globalMax, 10);
      assert.equal(wake.dedupMs, 10 * 60_000);
      assert.equal(wake.auditRetentionDays, 30);
      assert.equal(wake.auditMaxEntries, 1000);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadConfig reads wake settings and rejects unknown or invalid ones", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-intercom-config-"));
  try {
    mkdirSync(join(root, "intercom"), { recursive: true });
    const write = (wake: unknown) => writeFileSync(join(root, "intercom", "config.json"), JSON.stringify({ wake }));
    await withAgentDir(root, () => {
      write({ enabled: true, allowCwds: ["/work/a", "/work/b"], confirm: "never", perTargetMax: 5, sessiondSocket: "/run/pi-web/sessiond.sock" });
      const wake = loadConfig().wake;
      assert.deepEqual([wake.enabled, wake.confirm, wake.perTargetMax, wake.sessiondSocket], [true, "never", 5, "/run/pi-web/sessiond.sock"]);
      assert.deepEqual(wake.allowCwds, ["/work/a", "/work/b"]);
      for (const [bad, message] of [
        [{ enabled: "yes" }, /"wake.enabled" must be a boolean/],
        [{ allowCwds: ["relative"] }, /"wake.allowCwds" must be an array of absolute/],
        [{ allowCwds: "/work" }, /"wake.allowCwds" must be an array of absolute/],
        [{ confirm: "sometimes" }, /"wake.confirm" must be "always" or "never"/],
        [{ dedupMs: 0 }, /"wake.dedupMs" must be a positive integer/],
        [{ globalMax: 1.5 }, /"wake.globalMax" must be a positive integer/],
        [{ provider: " " }, /"wake.provider" must be a non-empty string/],
        [{ sessiondUrl: "" }, /"wake.sessiondUrl" must be a non-empty string/],
        [{ autoWake: true }, /"wake.autoWake" is not a known setting/],
        ["on", /"wake" must be an object/],
      ] as const) {
        write(bad);
        assert.throws(() => loadConfig(), message);
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
