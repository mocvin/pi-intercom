/**
 * Choice 1: what happens when a wake reaches a session that is ALREADY loaded and busy?
 * (Possible when the session is open in PI WEB but not on the intercom roster.)
 * Runs only on the isolated daemon of scripts/e2e/run.sh busy, with the scripted local model of faux-model.ts.
 * Compares the two ways to deliver the internal command:
 *   M1 = POST /sessions/:id/prompt        (what the MVP provider first used)
 *   M2 = POST /sessions/:id/commands/run  (what the provider uses now: runs only registered commands, no echo)
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { createSessiondProvider } from "../../wake/sessiond.ts";

const root = process.env.WAKER_E2E_ROOT ?? "";
const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
const socket = process.env.PI_WEB_SESSIOND_SOCKET ?? "";
if (!root.startsWith("/tmp/waker-e2e-") || !agentDir.startsWith(root) || !socket.startsWith(root)) throw new Error("Refusing to run outside a throwaway /tmp/waker-e2e-* directory");
const work = path.join(root, "work");
writeFileSync(path.join(agentDir, "intercom", "config.json"), JSON.stringify({ wake: { receiveTimeoutMs: 1000 } }));

type Finding = { scenario: string; method: string; observation: string; value: unknown };
const findings: Finding[] = [];
const failures: string[] = [];
const note = (scenario: string, method: string, observation: string, value: unknown) => { findings.push({ scenario, method, observation, value }); console.log(`  [${scenario}/${method}] ${observation}: ${typeof value === "string" ? value : JSON.stringify(value)}`); };
const expect = (label: string, ok: boolean) => { console.log(`${ok ? "PASS" : "FAIL"} ${label}`); if (!ok) failures.push(label); };

function daemon(method: string, url: string, body?: unknown, timeoutMs = 60_000): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: url, method, headers: body ? { "content-type": "application/json" } : {}, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const t = Buffer.concat(chunks).toString(); let json: any; try { json = t ? JSON.parse(t) : undefined; } catch { json = t; } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label: string, fn: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const q = `cwd=${encodeURIComponent(work)}`;
const status = async (id: string) => (await daemon("GET", `/sessions/${id}/status?${q}`)).json;
const idle = async (id: string) => { const s = await status(id); return !s.isStreaming && !s.isCompacting && (s.pendingMessageCount ?? 0) === 0; };
async function newSession(): Promise<string> {
  const created = await daemon("POST", "/sessions", { cwd: work });
  if (created.status !== 200 || typeof created.json?.id !== "string") throw new Error(`cannot create a session: ${created.status} ${JSON.stringify(created.json)}`);
  return created.json.id;
}
const prompt = (id: string, text: string) => daemon("POST", `/sessions/${id}/prompt`, { cwd: work, text });
const modelCalls = () => existsSync(path.join(root, "model-calls.jsonl")) ? readFileSync(path.join(root, "model-calls.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
function transcript(id: string): any[] {
  const dir = path.join(agentDir, "sessions");
  for (const sub of readdirSync(dir)) for (const f of readdirSync(path.join(dir, sub))) {
    if (f.endsWith(`_${id}.jsonl`)) return readFileSync(path.join(dir, sub, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  return [];
}
const userWakeMessages = (entries: any[]) => entries.filter((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes("/intercom-wake")).length;
const wakeEntries = (entries: any[]) => entries.filter((e) => e.type === "custom" && e.customType === "intercom_wake");
const provider = createSessiondProvider({ sessiondSocket: socket });
async function wakeVia(method: "M1-prompt" | "M2-commands", id: string, messageId: string): Promise<string> {
  if (method === "M2-commands") {
    try { await provider.wake({ piSessionId: id, cwd: work }, messageId); return "accepted (provider)"; } catch (error) { return `error: ${(error as Error).message}`; }
  }
  const r = await daemon("POST", `/sessions/${id}/prompt`, { cwd: work, text: `/intercom-wake ${messageId}`, streamingBehavior: "followUp" });
  return `HTTP ${r.status} ${JSON.stringify(r.json)}`;
}

const methods = ["M1-prompt", "M2-commands"] as const;

// ---- Baseline: the scripted model works.
const warm = await newSession();
await prompt(warm, "hello");
await waitFor("warm-up turn", async () => (await idle(warm)) && transcript(warm).some((e) => e.message?.role === "assistant"));
expect("the scripted model answers in the isolated daemon", transcript(warm).some((e) => e.message?.role === "assistant" && JSON.stringify(e.message.content).includes("ok (hello")));

// ---- S2: session streaming a long model turn.
for (const method of methods) {
  const id = await newSession();
  await prompt(id, "hello");
  await waitFor("idle", () => idle(id));
  await prompt(id, "SLOW work");
  await waitFor("streaming", async () => (await status(id)).isStreaming === true);
  const before = modelCalls().length;
  const sentAt = Date.now();
  note("S2 streaming", method, "wake answer", await wakeVia(method, id, `probe-s2-${method}`));
  await waitFor("turn finished", () => idle(id), 40_000);
  await sleep(1500);
  const entries = transcript(id);
  const after = modelCalls().slice(before);
  const slowReply = entries.filter((e) => e.message?.role === "assistant").at(-1);
  const wake = wakeEntries(entries)[0];
  note("S2 streaming", method, "extra model calls after the wake", after.length);
  note("S2 streaming", method, "a model ever saw the wake prompt", modelCalls().some((c) => c.sawWakePrompt));
  note("S2 streaming", method, "wake prompt stored as a user message", userWakeMessages(entries));
  note("S2 streaming", method, "command ran (intercom_wake entry)", wake ? wake.data.outcome : "no");
  note("S2 streaming", method, "command ran during the turn (seconds after the wake / turn end)", wake ? `${((Date.parse(wake.timestamp) - sentAt) / 1000).toFixed(1)}s / ${((Date.parse(slowReply.timestamp) - sentAt) / 1000).toFixed(1)}s` : "-");
  note("S2 streaming", method, "the running turn completed normally", `${slowReply?.message?.stopReason} ${JSON.stringify(slowReply?.message?.content).slice(0, 60)}`);
  expect(`S2 ${method}: no model saw the wake prompt, no extra turn, turn not disturbed`, after.length === 0 && userWakeMessages(entries) === 0 && slowReply?.message?.stopReason === "stop" && Boolean(wake));
}

// ---- S3: session compacting.
for (const method of methods) {
  const id = await newSession();
  for (const text of ["hello", "more context", "even more context"]) { await prompt(id, text); await waitFor("idle", () => idle(id)); }
  writeFileSync(path.join(root, "slow-all"), "");
  void daemon("POST", `/sessions/${id}/commands/run`, { cwd: work, text: "/compact" }, 60_000).catch(() => undefined);
  await waitFor("compacting", async () => (await status(id)).isCompacting === true);
  rmSync(path.join(root, "slow-all"), { force: true });
  const before = modelCalls().length; // includes the slow compaction call
  const sentAt = Date.now();
  note("S3 compacting", method, "wake answer", await wakeVia(method, id, `probe-s3-${method}`));
  await waitFor("compaction finished", () => idle(id), 40_000);
  await sleep(2500);
  const entries = transcript(id);
  // Compaction itself may make two calls (history summary and turn-prefix summary); only other calls count.
  const after = modelCalls().slice(before).filter((c) => !String(c.lastUser).startsWith("<conversation>") && !String(c.lastUser).startsWith("# Conversation"));
  const wake = wakeEntries(entries)[0];
  const compaction = entries.find((e) => e.type === "compaction");
  note("S3 compacting", method, "compaction completed", Boolean(compaction));
  note("S3 compacting", method, "extra model calls after the wake", after.length);
  note("S3 compacting", method, "wake prompt stored as a user message", userWakeMessages(entries));
  note("S3 compacting", method, "command ran (intercom_wake entry)", wake ? `${wake.data.outcome} after ${((Date.parse(wake.timestamp) - sentAt) / 1000).toFixed(1)}s` : "no");
  expect(`S3 ${method}: compaction not disturbed, no model saw the wake prompt, no extra turn`, Boolean(compaction) && after.length === 0 && userWakeMessages(entries) === 0 && !modelCalls().some((c) => c.sawWakePrompt));
}

// ---- S4: session idle with an open ask_user form.
for (const method of methods) {
  const id = await newSession();
  await prompt(id, "ASKFORM please");
  await waitFor("form open", async () => (await idle(id)) && Boolean((await status(id)).pendingAsk));
  const before = modelCalls().length;
  note("S4 open form", method, "wake answer", await wakeVia(method, id, `probe-s4-${method}`));
  await sleep(2500);
  await waitFor("idle", () => idle(id));
  const s = await status(id);
  const entries = transcript(id);
  note("S4 open form", method, "form still open after the wake", Boolean(s.pendingAsk));
  note("S4 open form", method, "extra model calls after the wake", modelCalls().slice(before).filter((c) => !String(c.lastUser).startsWith("Create a 2-6 word title")).length);
  note("S4 open form", method, "wake prompt stored as a user message", userWakeMessages(entries));
  note("S4 open form", method, "voided-form note added to the transcript", entries.filter((e) => e.type === "custom_message" && /ask/i.test(e.customType ?? "")).map((e) => e.customType));
}

// ---- S5: a command the session does not have (an old or missing intercom).
{
  const id = await newSession();
  await prompt(id, "hello"); await waitFor("idle", () => idle(id));
  const before = modelCalls().length;
  const m2 = await daemon("POST", `/sessions/${id}/commands/run`, { cwd: work, text: "/intercom-wake-missing probe" });
  await sleep(1500); await waitFor("idle", () => idle(id));
  note("S5 unknown command", "M2-commands", "answer", `HTTP ${m2.status} ${JSON.stringify(m2.json)}`);
  note("S5 unknown command", "M2-commands", "model calls", modelCalls().length - before);
  expect("S5 M2: an unknown command is refused and nothing reaches the model", m2.status === 200 && m2.json?.type === "unsupported" && modelCalls().length === before);
  const before1 = modelCalls().length;
  const m1 = await daemon("POST", `/sessions/${id}/prompt`, { cwd: work, text: "/intercom-wake-missing probe" });
  await sleep(1500); await waitFor("idle", () => idle(id));
  const reached = modelCalls().slice(before1).some((c) => String(c.lastUser).includes("/intercom-wake-missing"));
  note("S5 unknown command", "M1-prompt", "answer", `HTTP ${m1.status} ${JSON.stringify(m1.json)}`);
  note("S5 unknown command", "M1-prompt", "the text reached the model as a prompt", reached);
  const archived = await newSession();
  await prompt(archived, "hello"); await waitFor("idle", () => idle(archived));
  await daemon("POST", "/sessions/bulk/archive", { sessions: [{ id: archived, cwd: work }] });
  const onArchived = await daemon("POST", `/sessions/${archived}/commands/run`, { cwd: work, text: "/intercom-wake probe" });
  const onMissing = await daemon("POST", `/sessions/00000000-0000-7000-8000-000000000000/commands/run`, { cwd: work, text: "/intercom-wake probe" });
  note("S5 errors", "M2-commands", "archived session", `HTTP ${onArchived.status} ${JSON.stringify(onArchived.json)}`);
  note("S5 errors", "M2-commands", "missing session", `HTTP ${onMissing.status} ${JSON.stringify(onMissing.json)}`);
}

// ---- S6: archiving a session that spawn created (provider.archive), idle, working, and never answered.
{
  const archivedIds = async () => ((await daemon("GET", `/sessions?${q}`)).json as any[]).filter((e) => e.archived === true).map((e) => e.id as string);
  const tryArchive = async (id: string) => { try { await provider.archive!({ piSessionId: id, cwd: work }); return "archived"; } catch (error) { return `${(error as { code?: string }).code ?? "error"}: ${(error as Error).message}`; } };

  const idleId = await newSession();
  await prompt(idleId, "hello");
  await waitFor("idle session ready", async () => (await idle(idleId)) && transcript(idleId).some((e) => e.message?.role === "assistant"));
  const idleResult = await tryArchive(idleId);
  note("S6 archive", "provider", "idle loaded session", idleResult);
  expect("S6: an idle loaded session is archived and the catalog lists it as archived", idleResult === "archived" && (await archivedIds()).includes(idleId));
  const woken = await daemon("POST", `/sessions/${idleId}/commands/run`, { cwd: work, text: "/intercom-wake probe" });
  note("S6 archive", "provider", "a command on the archived session", `HTTP ${woken.status} ${JSON.stringify(woken.json).slice(0, 100)}`);

  const workingId = await newSession();
  await prompt(workingId, "hello");
  await waitFor("idle", () => idle(workingId));
  await prompt(workingId, "SLOW work");
  await waitFor("streaming", async () => (await status(workingId)).isStreaming === true);
  const workingResult = await tryArchive(workingId);
  note("S6 archive", "provider", "working session", workingResult);
  await waitFor("turn finished", () => idle(workingId), 40_000);
  await sleep(1500);
  const finished = transcript(workingId).filter((e) => e.message?.role === "assistant").at(-1);
  expect("S6: a working session is refused as busy, not archived, and its turn completes normally", workingResult.startsWith("busy") && !(await archivedIds()).includes(workingId) && finished?.message?.stopReason === "stop", `${workingResult} / ${finished?.message?.stopReason}`);
  const retry = await tryArchive(workingId);
  expect("S6: once it is idle the same session can be archived", retry === "archived" && (await archivedIds()).includes(workingId), retry);

  const emptyId = await newSession();
  const emptyResult = await tryArchive(emptyId);
  note("S6 archive", "provider", "a new session that never answered (not persisted)", emptyResult);
  expect("S6: a never-answered session is never reported archived unless the catalog says so", emptyResult !== "archived" || (await archivedIds()).includes(emptyId), emptyResult);
}

writeFileSync(path.join(root, "busy-result.json"), JSON.stringify({ failures, findings }, null, 2));
console.log(`\n${failures.length ? `${failures.length} expectation(s) failed` : "all expectations met"}; findings in busy-result.json`);
process.exit(failures.length ? 1 : 0);
