/**
 * Production check of one wake, with the real config, provider, broker and audit.
 * The caller confirms explicitly (this script is the confirmation): run it only for a session the user chose.
 *   node_modules/.bin/tsx scripts/ops/verify-wake.ts <piSessionId> <abs cwd>
 */
import { IntercomClient } from "../../broker/client.ts";
import { loadConfig } from "../../config.ts";
import "../../wake/builtin.ts";
import { WakeAudit, wakeAuditPath } from "../../wake/audit.ts";
import { performWake } from "../../wake/controller.ts";
import { createWakeProvider } from "../../wake/provider.ts";
import type { Message, SessionInfo } from "../../types.ts";

const [piSessionId, cwd] = process.argv.slice(2);
if (!piSessionId || !cwd) throw new Error("usage: verify-wake.ts <piSessionId> <abs cwd>");
const name = "wake-rollout-check";
const config = loadConfig().wake;
const client = new IntercomClient();
const replies: Array<{ from: SessionInfo; message: Message }> = [];
client.on("message", (from: SessionInfo, message: Message) => {
  replies.push({ from, message });
  client.sendMessageReceipt({ messageId: message.id, status: "receiver_received", timestamp: Date.now() });
});
await client.connect({ name, cwd: process.cwd(), model: "verify", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now(), acknowledgesReceipts: true });
const result = await performWake({
  client,
  config,
  provider: createWakeProvider(config.provider, { ...(config.sessiondSocket ? { sessiondSocket: config.sessiondSocket } : {}), ...(config.sessiondUrl ? { sessiondUrl: config.sessiondUrl } : {}) }),
  audit: new WakeAudit(wakeAuditPath(), config.auditMaxEntries, config.auditRetentionDays * 86_400_000),
  confirm: async () => true,
  self: { intercomId: client.sessionId, piSessionId: "wake-rollout-check", cwd: process.cwd() },
}, {
  to: piSessionId,
  cwd,
  message: `Wake check. Reply with the intercom tool: intercom({ action: "send", to: "${name}", message: "received" }). Do nothing else.`,
});
console.log(JSON.stringify({ ok: result.ok, outcome: result.outcome, code: result.code, text: result.text }));
const roster = await client.listSessions();
const woken = roster.find((s) => s.piSessionId === piSessionId || s.id === piSessionId);
console.log(JSON.stringify({ wokenOnRoster: Boolean(woken), intercomId: woken?.id, name: woken?.name, piSessionIdReported: woken?.piSessionId }));
const deadline = Date.now() + 120_000;
while (replies.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
console.log(JSON.stringify({ reply: replies[0] ? { from: replies[0].from.name ?? replies[0].from.id, text: replies[0].message.content.text.slice(0, 200) } : null }));
await client.disconnect();
