/**
 * Replace the running intercom broker with the broker of a given pi-intercom package directory.
 * Sessions are not touched: their clients reconnect on their own. The broker's in-memory state
 * (held mailbox messages, pending ask edges) is lost, so check that nothing important is waiting first.
 *
 * It holds the broker spawn lock while it swaps, so a reconnecting session cannot start a broker
 * from its own (possibly older) package in the gap.
 *
 *   node_modules/.bin/tsx scripts/ops/restart-broker.ts /abs/path/to/pi-intercom-package [--check]
 * --check only prints the resolved paths.
 *
 * Uses PI_CODING_AGENT_DIR (default ~/.pi/agent) like every pi-intercom process.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { getAgentDirPath, getBrokerSocketPath, getIntercomDirPath } from "../../broker/paths.ts";
import { createMessageReader, writeMessage } from "../../broker/framing.ts";
import { getTsxLoaderPath } from "../../broker/spawn.ts";

const pkg = path.resolve(process.argv[2] ?? "");
const brokerPath = path.join(pkg, "broker", "broker.ts");
// tsx may be nested in the package or hoisted next to it (npm install layout); resolve it like the broker spawner does.
const loader = getTsxLoaderPath(pkg);
if (!existsSync(brokerPath) || !existsSync(loader)) throw new Error(`Not an installed pi-intercom package: ${pkg}`);
const agentDir = getAgentDirPath();
const intercomDir = getIntercomDirPath(agentDir);
const pidFile = path.join(intercomDir, "broker.pid");
const lockFile = path.join(intercomDir, "broker.spawn.lock");
const socketPath = getBrokerSocketPath(process.platform, agentDir);
if (process.argv.includes("--check")) {
  console.log(JSON.stringify({ pkg, brokerPath, loader, agentDir, socketPath }));
  process.exit(0);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const health = () => new Promise<boolean>((resolve) => {
  const socket = net.connect(socketPath);
  const requestId = randomUUID();
  const done = (ok: boolean) => { clearTimeout(timer); socket.destroy(); resolve(ok); };
  const timer = setTimeout(() => done(false), 1000);
  socket.on("error", () => done(false));
  socket.on("connect", () => writeMessage(socket, { type: "health", requestId }));
  socket.on("data", createMessageReader((m: any) => done(m?.type === "health_ok" && m.requestId === requestId && m.protocol === "pi-intercom" && m.version === 1), () => done(false)));
});

writeFileSync(lockFile, `${process.pid}\n${Date.now()}\n`, { flag: "wx", mode: 0o600 }); // throws if another spawn is in progress
const started = Date.now();
try {
  const oldPid = existsSync(pidFile) ? Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10) : NaN;
  if (Number.isSafeInteger(oldPid) && alive(oldPid)) {
    console.log(`stopping broker ${oldPid}`);
    process.kill(oldPid, "SIGTERM");
    for (let i = 0; i < 50 && alive(oldPid); i++) await sleep(100);
    if (alive(oldPid)) throw new Error(`broker ${oldPid} did not stop; nothing else was changed`);
  }
  const child = spawn(process.execPath, ["--import", pathToFileURL(loader).href, brokerPath], {
    detached: true,
    stdio: "ignore",
    cwd: intercomDir,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, NODE_NO_WARNINGS: "1" },
  });
  child.unref();
  for (let i = 0; i < 80 && !(await health()); i++) await sleep(100);
  if (!(await health())) throw new Error("the new broker did not answer its health check");
  const newPid = readFileSync(pidFile, "utf-8").trim();
  console.log(`broker ${newPid} running from ${pkg} (swap took ${Date.now() - started} ms)`);
} finally {
  try { unlinkSync(lockFile); } catch { /* already gone */ }
}
