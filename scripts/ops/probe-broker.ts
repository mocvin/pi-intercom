/** Read-only check of the running broker: features and roster size. Registers briefly as "broker-probe". */
import { IntercomClient } from "../../broker/client.ts";
const client = new IntercomClient();
await client.connect({ name: "broker-probe", cwd: process.cwd(), model: "probe", pid: process.pid, startedAt: Date.now(), lastActivity: Date.now() });
const sessions = (await client.listSessions()).filter((s) => s.id !== client.sessionId);
console.log(JSON.stringify({
  features: ["extension-bus-v1", "exact-send-v1", "pi-session-id-v1", "wake-v1"].filter((f) => client.supportsFeature(f)),
  sessions: sessions.length,
  withPiSessionId: sessions.filter((s) => s.piSessionId).length,
}));
await client.disconnect();
