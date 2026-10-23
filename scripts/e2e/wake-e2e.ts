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
import { performArchive, performWake, type WakeDeps } from "../../wake/controller.ts";
import { createSessiondProvider } from "../../wake/sessiond.ts";
import { WakeTrustStore, wakeTrustPath } from "../../wake/trust.ts";

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
const trustedTargetId = randomUUID();
writeFixtureSession(trustedTargetId, "e2e-dormant-trusted");
const longMessageTargetId = randomUUID();
writeFixtureSession(longMessageTargetId, "e2e-dormant-long");
const brokenDialogTargetId = randomUUID();
writeFixtureSession(brokenDialogTargetId, "e2e-dormant-broken-dialog");

// ---- Before: the daemon lists the saved sessions without loading them.
const before = await daemon("GET", `/health`);
check("daemon starts with no loaded session", before.json.activeSessions === 0, `activeSessions=${before.json.activeSessions}`);
const listed = await daemon("GET", `/sessions?cwd=${encodeURIComponent(work)}`);
check("catalog lists the saved sessions", listed.status === 200 && listed.json.length === 5, `status=${listed.status} n=${listed.json?.length}`);
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

// ---- A sender the user trusted (/wake-trust) wakes with confirm "always" and no UI at all.
new WakeTrustStore(wakeTrustPath()).grant({ piSessionId: "e2e-sender-pi", cwd: root }, 1);
const trustedDeps: WakeDeps = { ...deps(undefined, { confirm: "always" }), trust: new WakeTrustStore(wakeTrustPath()) };
delete (trustedDeps as { confirm?: unknown }).confirm;
const trustedWake = await performWake(trustedDeps, { to: trustedTargetId, cwd: work, message: "E2E trusted brief." });
check("a trusted sender wakes without a confirmation dialog", trustedWake.ok && trustedWake.outcome === "delivered", `${trustedWake.outcome} (${trustedWake.code})`);
check("the audit records the approval as a /wake-trust grant", readFileSync(wakeAuditPath(), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).some((e) => e.outcome === "delivered" && e.confirmedBy === "trust" && e.target.piSessionId === trustedTargetId));
new WakeTrustStore(wakeTrustPath()).revoke("e2e-sender-pi");
const untrusted = await performWake({ ...deps(undefined, { confirm: "always" }) }, { to: randomUUID(), cwd: work, message: "x0" });
check("without the grant and without a UI the wake is refused", !untrusted.ok && untrusted.code === "confirmation_unavailable", untrusted.code);

// ---- A long message: the dialog must stay within what PI WEB accepts (1000 characters), as the real ctx.ui.confirm enforces.
const piWebConfirm = async (title: string, body: string): Promise<boolean> => { if (title.length > 1000 || body.length > 1000) throw new Error("message exceeds its length limit"); return true; };
const longWake = await performWake({ ...deps(undefined, { confirm: "always" }), confirm: piWebConfirm }, { to: longMessageTargetId, cwd: work, message: `E2E long brief. ${"Context sentence. ".repeat(400)}` });
check("a very long message still gets a dialog PI WEB accepts, and is delivered", longWake.ok && longWake.outcome === "delivered", `${longWake.outcome} (${longWake.code}) ${longWake.text.slice(0, 100)}`);
const brokenDialog = await performWake({ ...deps(undefined, { confirm: "always" }), confirm: async () => { throw new Error("dialog refused"); } }, { to: brokenDialogTargetId, cwd: work, message: "E2E dialog failure" });
check("a dialog that fails is reported as an error, not as a refusal by the user, and nothing is woken", !brokenDialog.ok && brokenDialog.code === "confirmation_failed" && !(await client.listSessions()).some((x) => x.piSessionId === brokenDialogTargetId), brokenDialog.code);

// ---- Guards against the real daemon.
const dup = await performWake(deps(), { to: dormantId, cwd: work, message: brief });
check("the same message again is refused as a duplicate", !dup.ok && dup.code === "duplicate", dup.code);
const missing = await performWake(deps(), { to: randomUUID(), cwd: work, message: "x1" });
check("an unknown session is refused", !missing.ok && missing.code === "not_found", missing.code);
const arch = await performWake(deps(), { to: archivedId, cwd: work, message: "x2" });
check("an archived session is refused and not loaded", !arch.ok && arch.code === "archived" && (await daemon("GET", `/health`)).json.activeSessions === 3, arch.code);
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

// ---- spawn: a NEW session in a project, created through the daemon, receiving the task once.
const activeBeforeSpawn = (await daemon("GET", `/health`)).json.activeSessions as number;
const filesBeforeSpawn = readdirSync(path.dirname(dormantFile)).filter((f) => f.endsWith(".jsonl")).length;
const noUi = await performWake(deps(), { to: "", cwd: work, message: "E2E spawn without a UI", spawn: true });
check("spawn by default asks, and without a UI nothing is created", !noUi.ok && noUi.code === "confirmation_unavailable" && (await daemon("GET", `/health`)).json.activeSessions === activeBeforeSpawn, noUi.code);
new WakeTrustStore(wakeTrustPath()).grant({ piSessionId: "e2e-sender-pi", cwd: root }, 1);
const trustedNoUi = await performWake({ ...deps(), trust: new WakeTrustStore(wakeTrustPath()) }, { to: "", cwd: work, message: "E2E spawn trusted without a UI", spawn: true });
check("a /wake-trust sender is still asked by default for spawn", !trustedNoUi.ok && trustedNoUi.code === "confirmation_unavailable", trustedNoUi.code);
new WakeTrustStore(wakeTrustPath()).revoke("e2e-sender-pi");
const spawnBrief = "E2E spawn brief: please acknowledge this task in one short sentence.";
const spawned = await performWake(deps(undefined, { spawnConfirm: "never" }), { to: "", cwd: work, message: spawnBrief, spawn: true });
check("spawn reports delivered", spawned.ok && spawned.outcome === "delivered" && Boolean(spawned.target?.piSessionId), `${spawned.outcome} (${spawned.code}) ${spawned.text}`);
const newId = spawned.target?.piSessionId ?? "";
check("exactly one new session was loaded by the daemon", (await daemon("GET", `/health`)).json.activeSessions === activeBeforeSpawn + 1);
const roster2 = await client.listSessions();
const created = roster2.find((s) => s.piSessionId === newId);
check("the new session is on intercom in the requested project", Boolean(created) && created!.cwd === work, created ? `intercom id ${created.id}` : "absent");
// The isolated daemon has no model, so the new session never answers and Pi never saves a file for it: read it back
// from the daemon that holds it instead.
await new Promise((r) => setTimeout(r, 2000));
const newMessages = await daemon("GET", `/sessions/${encodeURIComponent(newId)}/messages?cwd=${encodeURIComponent(work)}`);
const list = (newMessages.json?.messages ?? []) as Array<Record<string, any>>;
const newInjected = list.filter((m) => m.role === "custom" && m.customType === "intercom_message");
check("the task was injected exactly once", newMessages.status === 200 && newInjected.length === 1 && String(newInjected[0]!.content).includes("E2E spawn brief"), `status=${newMessages.status} count=${newInjected.length}`);
check("the spawn prompt never became a user message", !list.some((m) => m.role === "user" && JSON.stringify(m.content).includes("/intercom-wake")), `${list.length} messages`);
check("creating the session added no history file for the other sessions", readdirSync(path.dirname(dormantFile)).filter((f) => f.endsWith(".jsonl")).length === filesBeforeSpawn);
const spawnAudit = readFileSync(wakeAuditPath(), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
check("the audit records the spawn, who approved it, and no text", spawnAudit.some((e) => e.kind === "spawn" && e.outcome === "delivered" && e.confirmedBy === "config" && e.target.piSessionId === newId) && !JSON.stringify(spawnAudit).includes("E2E spawn brief"));
const chained = await performWake({ ...deps(undefined, { spawnConfirm: "never" }), self: { intercomId: created?.id ?? null, piSessionId: newId, cwd: work } }, { to: "", cwd: work, message: "E2E spawn from the spawned session", spawn: true });
check("a session created by spawn cannot spawn", !chained.ok && chained.code === "spawn_chain", chained.code);
const outsideSpawn = await performWake(deps(undefined, { spawnConfirm: "never" }), { to: "", cwd: path.join(root, "elsewhere"), message: "E2E spawn outside", spawn: true });
check("spawn outside the allowlist creates nothing", !outsideSpawn.ok && outsideSpawn.code === "cwd_not_allowed" && (await daemon("GET", `/health`)).json.activeSessions === activeBeforeSpawn + 1, outsideSpawn.code);

// ---- archive: the whole flow against the real daemon, on a loaded, saved session that spawn "created" (seeded in the audit).
const audit = new WakeAudit(wakeAuditPath());
const archiveDeps = (confirm?: () => Promise<boolean>) => ({ config: { ...config, enabled: true }, provider: createSessiondProvider({ sessiondSocket: socket }), audit, ...(confirm ? { confirm } : {}), trust: new WakeTrustStore(wakeTrustPath()), self: { intercomId: client.sessionId, piSessionId: "e2e-sender-pi", cwd: root } });
const notMine = await performArchive(archiveDeps(async () => true), { piSessionId: dormantId, cwd: work });
check("archive refuses a session this sender did not create with spawn", !notMine.ok && notMine.code === "not_created_by_you", notMine.code);
audit.append({ ts: Date.now(), kind: "spawn", outcome: "delivered", code: "delivered", messageId: randomUUID(), target: { piSessionId: dormantId, cwd: work }, sender: { piSessionId: "e2e-sender-pi" }, textLength: 1, textSha256: "x" });
new WakeTrustStore(wakeTrustPath()).grant({ piSessionId: "e2e-sender-pi", cwd: root }, 1);
const noUiArchive = await performArchive(archiveDeps(), { piSessionId: dormantId, cwd: work });
check("archive without a UI is blocked, even with a /wake-trust grant and confirm never", !noUiArchive.ok && noUiArchive.code === "confirmation_unavailable", noUiArchive.code);
new WakeTrustStore(wakeTrustPath()).revoke("e2e-sender-pi");
const declined = await performArchive(archiveDeps(async () => false), { piSessionId: dormantId, cwd: work });
const archivedNow = async () => ((await daemon("GET", `/sessions?cwd=${encodeURIComponent(work)}`)).json as any[]).filter((e) => e.archived === true).map((e) => e.id as string);
check("a declined archive changes nothing", !declined.ok && declined.code === "user_declined" && !(await archivedNow()).includes(dormantId));
const activeBeforeArchive = (await daemon("GET", `/health`)).json.activeSessions as number;
const archivedResult = await performArchive(archiveDeps(async () => true), { piSessionId: dormantId, cwd: work });
check("a confirmed archive archives the loaded session", archivedResult.ok && archivedResult.outcome === "archived" && (await archivedNow()).includes(dormantId), `${archivedResult.outcome} (${archivedResult.code}) ${archivedResult.text}`);
check("the archived session was closed in the daemon", (await daemon("GET", `/health`)).json.activeSessions === activeBeforeArchive - 1);
const wakeArchived = await performWake(deps(), { to: dormantId, cwd: work, message: "E2E wake after archive" });
check("an archived session can no longer be woken", !wakeArchived.ok && wakeArchived.code === "archived", wakeArchived.code);
const auditAfter = readFileSync(wakeAuditPath(), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
check("the audit records the archive, approved by the user", auditAfter.some((e) => e.kind === "archive" && e.outcome === "archived" && e.confirmedBy === "user" && e.target.piSessionId === dormantId));

await client.disconnect().catch(() => undefined);
const failed = results.filter((r) => !r.ok);
writeFileSync(path.join(root, "e2e-result.json"), JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
