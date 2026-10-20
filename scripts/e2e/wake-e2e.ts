/**
 * End-to-end check of the wake flow against an ISOLATED PI WEB session daemon and an isolated intercom broker.
 * Driven by scripts/e2e/run.sh, which sets PI_CODING_AGENT_DIR, PI_WEB_SESSIOND_SOCKET and HOME to throwaway
 * directories. It refuses to run if those point at a live installation.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IntercomClient } from "../../broker/client.ts";
import { spawnBrokerIfNeeded } from "../../broker/spawn.ts";
import { getIntercomDirPath } from "../../broker/paths.ts";
import { defaultWakeConfig } from "../../config.ts";
import { WakeAudit, wakeAuditPath } from "../../wake/audit.ts";
import { performWake, type WakeDeps } from "../../wake/controller.ts";
import { createSessiondProvider } from "../../wake/sessiond.ts";

const root = process.env.WAKER_E2E_ROOT ?? "";
const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
const socket = process.env.PI_WEB_SESSIOND_SOCKET ?? "";
if (!root.startsWith("/tmp/waker-e2e-") || !agentDir.startsWith(root) || !socket.startsWith(root)) {
  throw new Error("Refusing to run: the E2E must use throwaway directories under /tmp/waker-e2e-*");
}
const work = path.join(root, "work");
mkdirSync(work, { recursive: true });
const results: Array<{ step: string; ok: boolean; detail?: string }> = [];
const check = (step: string, ok: boolean, detail?: string) => { results.push({ step, ok, ...(detail ? { detail } : {}) }); console.log(`${ok ? "PASS" : "FAIL"} ${step}${detail ? ` — ${detail}` : ""}`); };

function daemon(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: url, method, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const t = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : undefined }); });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/** A saved session written in the documented JSONL format; the daemon has never loaded it. */
function writeFixtureSession(id: string, name: string): string {
  const dir = path.join(agentDir, "sessions", `--${work.replace(/^[\\/]/, "").replace(/[\\/:]/g, "-")}--`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}_${id}.jsonl`);
  const now = Date.now();
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const lines = [
    { type: "session", version: 3, id, timestamp: new Date(now).toISOString(), cwd: work },
    { type: "session_info", id: "a0000001", parentId: null, timestamp: new Date(now + 1).toISOString(), name },
    { type: "message", id: "a0000002", parentId: "a0000001", timestamp: new Date(now + 2).toISOString(), message: { role: "user", content: "Earlier work in this session", timestamp: now + 2 } },
    { type: "message", id: "a0000003", parentId: "a0000002", timestamp: new Date(now + 3).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Noted." }], api: "fixture", provider: "fixture", model: "fixture", usage, stopReason: "stop", timestamp: now + 3 } },
  ];
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}
const readJsonl = (file: string) => readFileSync(file, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);

const dormantId = randomUUID();
const archivedId = randomUUID();
const dormantFile = writeFixtureSession(dormantId, "e2e-dormant");
const archivedFile = writeFixtureSession(archivedId, "e2e-archived");

// ---- Before: the daemon lists the saved sessions without loading them.
const before = await daemon("GET", `/health`);
check("daemon starts with no loaded session", before.json.activeSessions === 0, `activeSessions=${before.json.activeSessions}`);
const listed = await daemon("GET", `/sessions?cwd=${encodeURIComponent(work)}`);
check("catalog lists both saved sessions", listed.status === 200 && listed.json.length === 2, `status=${listed.status} n=${listed.json?.length}`);
const archive = await daemon("POST", `/sessions/bulk/archive`, { sessions: [{ id: archivedId, cwd: work }] });
check("one fixture session is archived", archive.status === 200, `status=${archive.status} ${JSON.stringify(archive.json).slice(0, 120)}`);
check("reading the catalog loaded nothing", (await daemon("GET", `/health`)).json.activeSessions === 0);

// ---- Sender: a real intercom client on the isolated broker, the real sessiond provider.
await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]);
const client = new IntercomClient();
await client.connect({ name: "e2e-sender", piSessionId: "e2e-sender-pi", cwd: root, model: "e2e", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() });
check("isolated broker advertises wake-v1", client.supportsFeature("wake-v1"));
const config = { ...defaultWakeConfig(), enabled: true, confirm: "never" as const, allowCwds: [work], deliveryTimeoutMs: 45_000, wakeTimeoutMs: 20_000 };
const deps = (provider = createSessiondProvider({ sessiondSocket: socket }), over: Partial<typeof config> = {}): WakeDeps => ({
  client, config: { ...config, ...over }, provider, audit: new WakeAudit(wakeAuditPath()), self: { intercomId: client.sessionId, piSessionId: "e2e-sender-pi", cwd: root },
});

const filesBefore = readdirSync(path.dirname(dormantFile)).filter((f) => f.endsWith(".jsonl")).length;
const roster0 = await client.listSessions();
check("the dormant session is not in the roster", !roster0.some((s) => s.piSessionId === dormantId));

// ---- Happy path.
const brief = "E2E brief: please acknowledge this message in one short sentence.";
const wake = await performWake(deps(), { to: dormantId, cwd: work, message: brief });
check("wake reports delivered", wake.ok && wake.outcome === "delivered", `${wake.outcome} (${wake.code}) ${wake.text}`);
const loaded = await daemon("GET", `/health`);
check("exactly one session was loaded by the daemon", loaded.json.activeSessions === 1, `activeSessions=${loaded.json.activeSessions}`);
const roster1 = await client.listSessions();
const woken = roster1.find((s) => s.piSessionId === dormantId);
check("the woken session is the original one and is now on intercom", Boolean(woken) && woken!.cwd === work, woken ? `intercom id ${woken.id}` : "absent");

await new Promise((r) => setTimeout(r, 3000)); // let the session settle and persist
const entries = readJsonl(dormantFile);
const userTexts = entries.filter((e) => e.type === "message" && e.message?.role === "user").map((e) => JSON.stringify(e.message.content));
check("the wake prompt never became a user message", !userTexts.some((t) => t.includes("/intercom-wake")), `${userTexts.length} user messages`);
const injected = entries.filter((e) => e.type === "custom_message" && e.customType === "intercom_message");
check("the brief was injected exactly once", injected.length === 1 && String(injected[0]!.content).includes("E2E brief"), `count=${injected.length}`);
const wakeEntries = entries.filter((e) => e.type === "custom" && e.customType === "intercom_wake");
check("the session recorded the wake as received", wakeEntries.length === 1 && wakeEntries[0]!.data.outcome === "received", JSON.stringify(wakeEntries.map((e) => e.data)));
check("the session history is the same file (original id kept)", entries[0]!.id === dormantId);
const otherFiles = readdirSync(path.dirname(dormantFile)).filter((f) => f.endsWith(".jsonl"));
check("no new session file was created", otherFiles.length === filesBefore, `files before=${filesBefore} after=${otherFiles.length}`);
const auditText = readFileSync(wakeAuditPath(), "utf-8");
check("the audit has the attempt and no message text", auditText.includes('"outcome":"delivered"') && !auditText.includes("E2E brief"));

// ---- Guards against the real daemon.
const dup = await performWake(deps(), { to: dormantId, cwd: work, message: brief });
check("the same message again is refused as a duplicate", !dup.ok && dup.code === "duplicate", dup.code);
const missing = await performWake(deps(), { to: randomUUID(), cwd: work, message: "x1" });
check("an unknown session is refused", !missing.ok && missing.code === "not_found", missing.code);
const arch = await performWake(deps(), { to: archivedId, cwd: work, message: "x2" });
check("an archived session is refused and not loaded", !arch.ok && arch.code === "archived" && (await daemon("GET", `/health`)).json.activeSessions === 1, arch.code);
const outside = await performWake(deps(), { to: dormantId, cwd: path.join(root, "elsewhere"), message: "x3" });
check("a directory outside the allowlist is refused", !outside.ok && outside.code === "cwd_not_allowed", outside.code);
const down = await performWake(deps(createSessiondProvider({ sessiondSocket: path.join(root, "no-such.sock") })), { to: dormantId, cwd: work, message: "x4" });
check("an unreachable daemon is refused and nothing is held", !down.ok && down.code === "provider_unavailable", down.code);
const self = await performWake({ ...deps(), self: { intercomId: client.sessionId, piSessionId: dormantId, cwd: root } }, { to: dormantId, cwd: work, message: "x5" });
check("the current session cannot be woken", !self.ok && self.code === "self_target", self.code);
const secret = await performWake(deps(), { to: dormantId, cwd: work, message: `token ghp_${"a".repeat(36)}` });
check("a secret-like message is refused", !secret.ok && secret.code === "possible_secret", secret.code);

// ---- A connected target is not woken again by the same flow (the extension routes it to an ordinary send).
const hold = await client.send(dormantId, { messageId: randomUUID(), text: "second brief, connected now", wake: { piSessionId: dormantId, cwd: work } });
check("a wake send to the now-connected session is delivered normally", hold.delivered && hold.delivery === "socket_delivered", `${hold.delivery} ${hold.code ?? ""}`);

await client.disconnect().catch(() => undefined);
const failed = results.filter((r) => !r.ok);
writeFileSync(path.join(root, "e2e-result.json"), JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
