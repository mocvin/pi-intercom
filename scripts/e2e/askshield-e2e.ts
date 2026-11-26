/**
 * What an intercom message does to an open ask_user form, on an ISOLATED PI WEB daemon and intercom broker
 * (scripts/e2e/run.sh askshield), with the scripted local model of faux-model.ts (a user text with ASKFORM opens a form).
 * Each trial writes the intercom config, opens a fresh session (the config is read when its extension loads), leaves a form
 * open, sends it an intercom message from a plain client, and looks at the form, the transcript and the model calls.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { IntercomClient } from "../../broker/client.ts";
import { spawnBrokerIfNeeded } from "../../broker/spawn.ts";
import { askModelOf } from "../../ask-shield.ts";

const root = process.env.WAKER_E2E_ROOT ?? "";
const agentDir = process.env.PI_CODING_AGENT_DIR ?? "";
const socket = process.env.PI_WEB_SESSIOND_SOCKET ?? "";
if (!root.startsWith("/tmp/waker-e2e-") || !agentDir.startsWith(root) || !socket.startsWith(root)) throw new Error("Refusing to run outside a throwaway /tmp/waker-e2e-* directory");
const work = path.join(root, "work");
mkdirSync(work, { recursive: true });
const failures: string[] = [];
const expect = (label: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`); if (!ok) failures.push(label); };
const note = (label: string, value: unknown) => console.log(`  [observed] ${label}: ${JSON.stringify(value)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function daemon(method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: socket, path: url, method, headers: body ? { "content-type": "application/json" } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const t = Buffer.concat(chunks).toString(); let json: any; try { json = t ? JSON.parse(t) : undefined; } catch { json = t; } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
async function waitFor(label: string, fn: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return; await sleep(100); }
  throw new Error(`Timed out: ${label}`);
}
const q = `cwd=${encodeURIComponent(work)}`;
const status = async (id: string) => (await daemon("GET", `/sessions/${id}/status?${q}`)).json;
const idle = async (id: string) => { const s = await status(id); return !s.isStreaming && !s.isCompacting && (s.pendingMessageCount ?? 0) === 0; };
const prompt = (id: string, text: string) => daemon("POST", `/sessions/${id}/prompt`, { cwd: work, text });
const modelCalls = (): any[] => existsSync(path.join(root, "model-calls.jsonl")) ? readFileSync(path.join(root, "model-calls.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
function transcript(id: string): any[] {
  const dir = path.join(agentDir, "sessions");
  if (!existsSync(dir)) return [];
  for (const sub of readdirSync(dir)) for (const f of readdirSync(path.join(dir, sub))) {
    if (f.endsWith(`_${id}.jsonl`)) return readFileSync(path.join(dir, sub, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  return [];
}

const health = (await daemon("GET", "/health")).json;
const model = askModelOf(health?.version?.runtimeVersion);
console.log(`PI WEB ${health?.version?.runtimeVersion} (Pi SDK ${health?.piVersion}): form model ${model}`);
if (!model) throw new Error("Cannot tell the form model of this PI WEB");
/** A form that was posted and has no answers entry yet, from the saved transcript (works for both form models). */
const formPosted = (id: string): string | undefined => transcript(id).filter((e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === "ask_user").map((e) => e.message.details?.ask?.askId as string | undefined).filter(Boolean).at(-1);

await spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]);
const peer = new IntercomClient();
await peer.connect({ name: "e2e-peer", piSessionId: "e2e-peer-pi", cwd: root, model: "e2e", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() });
const peerReplies: string[] = [];
peer.on("message", (_from: unknown, message: { content: { text: string } }) => peerReplies.push(message.content.text));

const setConfig = (config: Record<string, unknown>) => writeFileSync(path.join(agentDir, "intercom", "config.json"), JSON.stringify(config));

/** Open a form in a fresh session, send it one intercom message, and report what happened to the form. */
async function trial(label: string, config: Record<string, unknown>, text: string) {
  setConfig(config);
  const created = await daemon("POST", "/sessions", { cwd: work });
  const id = created.json.id as string;
  await prompt(id, "ASKFORM please");
  await waitFor(`${label}: form open`, async () => (await idle(id)) && (model === "legacy" ? Boolean((await status(id)).pendingAsk) : Boolean(formPosted(id))));
  const askId = model === "legacy" ? (await status(id)).pendingAsk?.askId : formPosted(id);
  // The session must be on the roster before it can be messaged.
  let target: any;
  await waitFor(`${label}: on the roster`, async () => { target = (await peer.listSessions()).find((s) => s.piSessionId === id); return Boolean(target); }, 20_000);
  const callsBefore = modelCalls().length;
  const sent = await peer.send(target.id, { messageId: `shield-${label}-${Date.now()}`, text });
  await sleep(3500);
  const after = await status(id);
  const entries = transcript(id);
  const result = {
    id, askId, sent,
    formStillOpen: model === "legacy" ? after.pendingAsk?.askId === askId : !entries.some((e) => e.customType === "pi-web.ask.answers" && e.details?.askId === askId),
    queuedBehindAsk: entries.some((e) => e.type === "custom_message" && e.customType === "intercom_message" && e.details?.queuedBehindAsk),
    modelCallsAfter: modelCalls().slice(callsBefore).filter((c) => !String(c.lastUser).startsWith("Create a 2-6 word title")).length,
    seenInTranscript: entries.some((e) => e.type === "custom_message" && e.customType === "intercom_message" && JSON.stringify(e.content).includes(text.slice(0, 30))),
    userNudges: entries.filter((e) => e.type === "message" && e.message?.role === "user" && JSON.stringify(e.message.content).includes("New intercom message above")).length,
    voided: entries.filter((e) => e.customType === "pi-web.ask.answers").map((e) => e.details?.reason),
  };
  return result;
}

const PLAIN = "Update from the peer: build finished.";
const URGENT = "[URGENTE] Production alert from the peer: act now.";
if (model === "durable") {
  // PI WEB 1.202610.2 and newer: a form is a durable entry, nothing cancels it, and the shield must stay out of the way.
  const plain = await trial("durable-plain", {}, PLAIN);
  note("durable model, default config", { formStillOpen: plain.formStillOpen, modelCallsAfter: plain.modelCallsAfter, queuedBehindAsk: plain.queuedBehindAsk, voided: plain.voided });
  expect("on this PI WEB an intercom message does not cancel an open form (the problem does not exist)", plain.formStillOpen && plain.voided.length === 0, plain);
  expect("the shield stays out of the way: the message starts a turn as usual and is not marked as queued behind a form", plain.modelCallsAfter >= 1 && !plain.queuedBehindAsk && plain.seenInTranscript, plain);
  const urgentDurable = await trial("durable-urgent", {}, URGENT);
  expect("an [URGENTE] message is delivered as usual too", urgentDurable.formStillOpen && urgentDurable.modelCallsAfter >= 1 && !urgentDurable.queuedBehindAsk, urgentDurable);
  const askedAfter = await trial("durable-never", { inboundTrigger: "never" }, PLAIN);
  expect("inboundTrigger never still keeps the message from starting a turn", askedAfter.formStillOpen && askedAfter.modelCallsAfter === 0, askedAfter);
  // The form can still be answered after the messages: the answers are ordinary replies.
  const answer = await daemon("POST", `/sessions/${plain.id}/ask/submit`, { cwd: work, askId: plain.askId, answers: [{ id: "q1", values: ["a"] }] });
  expect("the form can still be answered after the message arrived", answer.status === 200, answer.status);
} else {
const pending = async (id: string) => (await status(id)).pendingAsk?.askId as string | undefined;

// The problem: by default (shield off) an intercom message cancels the open form.
const off = await trial("off", { shieldOpenAsk: false }, PLAIN);
note("shield off", { formStillOpen: off.formStillOpen, modelCallsAfter: off.modelCallsAfter, userNudges: off.userNudges, voided: off.voided });
expect("without the shield an intercom message cancels the open form and starts a turn (the problem)", !off.formStillOpen && off.voided.includes("cancelled") && off.modelCallsAfter >= 1 && off.userNudges === 1);

// The no-code mitigation: inboundTrigger never.
const never = await trial("never", { shieldOpenAsk: false, inboundTrigger: "never" }, PLAIN);
expect("inboundTrigger never keeps the form (the temporary mitigation)", never.formStillOpen && never.seenInTranscript && never.modelCallsAfter === 0, never);

// The fix: the default configuration.
const shield = await trial("shield", {}, PLAIN);
note("shield on (default)", { formStillOpen: shield.formStillOpen, modelCallsAfter: shield.modelCallsAfter, userNudges: shield.userNudges, seenInTranscript: shield.seenInTranscript, voided: shield.voided });
expect("with the shield the form stays open, the message is in the transcript, and no turn started", shield.formStillOpen && shield.seenInTranscript && shield.modelCallsAfter === 0 && shield.userNudges === 0 && shield.voided.length === 0, shield);
// The shielded message is not lost: once the form is answered, the turn that starts has it in its context.
const callsBeforeSubmit = modelCalls().length;
const submit = await daemon("POST", `/sessions/${shield.id}/ask/submit`, { cwd: work, askId: shield.askId, answers: [{ id: "q1", values: ["a"] }] });
await waitFor("turn after the answers", async () => (await idle(shield.id)) && modelCalls().length > callsBeforeSubmit);
const afterSubmit = modelCalls().slice(callsBeforeSubmit).filter((c) => !String(c.lastUser).startsWith("Create a 2-6 word title"));
expect("answering the form works and the queued message is in the context of the turn that follows", submit.status === 200 && afterSubmit.length >= 1 && afterSubmit.some((c) => c.sawPeer === true), { submit: submit.status, calls: afterSubmit.length });
expect("the form closed as submitted, not cancelled", transcript(shield.id).some((e) => e.customType === "pi-web.ask.answers" && e.details?.reason === "submitted"));

// Several messages in a row, from the same peer.
setConfig({});
const many = await daemon("POST", "/sessions", { cwd: work });
const manyId = many.json.id as string;
await prompt(manyId, "ASKFORM please");
await waitFor("many: form open", async () => (await idle(manyId)) && Boolean(await pending(manyId)));
const manyAsk = await pending(manyId);
const manyTarget: any = await (async () => { let t: any; await waitFor("many: roster", async () => { t = (await peer.listSessions()).find((x) => x.piSessionId === manyId); return Boolean(t); }, 20_000); return t; })();
for (let i = 1; i <= 4; i++) await peer.send(manyTarget.id, { messageId: `shield-many-${i}-${Date.now()}`, text: `Message ${i} while the form is open.` });
await sleep(3000);
const manyEntries = transcript(manyId).filter((e) => e.type === "custom_message" && e.customType === "intercom_message");
expect("four messages in a row all queue behind the form and none cancels it", (await pending(manyId)) === manyAsk && manyEntries.length === 4, { queued: manyEntries.length });
expect("each queued message is marked with the form it waits behind", manyEntries.every((e) => e.details?.queuedBehindAsk === manyAsk));
await daemon("POST", `/sessions/${manyId}/ask/cancel`, { cwd: work, askId: manyAsk });

// Urgent: by default it queues like the others (and the user is told); shieldUrgent trigger starts the turn anyway.
const urgent = await trial("urgent", {}, URGENT);
expect("an [URGENTE] message does not cancel the form by default", urgent.formStillOpen && urgent.seenInTranscript && urgent.modelCallsAfter === 0, urgent);
const urgentTrigger = await trial("urgent-trigger", { shieldUrgent: "trigger" }, URGENT);
expect("with shieldUrgent trigger an [URGENTE] message starts the turn, which cancels the form", !urgentTrigger.formStillOpen && urgentTrigger.voided.includes("cancelled"), urgentTrigger);

// No form open: nothing changes, the message starts a turn as before.
setConfig({});
const plain = await daemon("POST", "/sessions", { cwd: work });
const plainId = plain.json.id as string;
await prompt(plainId, "hello");
await waitFor("plain: idle", () => idle(plainId));
let plainTarget: any;
await waitFor("plain: roster", async () => { plainTarget = (await peer.listSessions()).find((x) => x.piSessionId === plainId); return Boolean(plainTarget); }, 20_000);
const plainBefore = modelCalls().length;
await peer.send(plainTarget.id, { messageId: `shield-none-${Date.now()}`, text: "No form here: please act on this." });
await sleep(3500);
expect("without a form an intercom message still starts a turn", modelCalls().slice(plainBefore).filter((c) => !String(c.lastUser).startsWith("Create a 2-6 word title")).length >= 1);

}

await peer.disconnect().catch(() => undefined);
writeFileSync(path.join(root, "askshield-result.json"), JSON.stringify({ model, failures }, null, 2));
console.log(`\n${failures.length ? `${failures.length} expectation(s) failed` : "all expectations met"}`);
process.exit(failures.length ? 1 : 0);
