/**
 * Smoke check on an ISOLATED PI WEB daemon: every package named in E2E_EXTRA_PACKAGES (and this one) loads in a new session
 * without an error, and the session lists the commands they register. Used to try another PI WEB / Pi SDK before moving to it.
 */
import http from "node:http";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

const root = process.env.WAKER_E2E_ROOT ?? "";
const socket = process.env.PI_WEB_SESSIOND_SOCKET ?? "";
if (!root.startsWith("/tmp/waker-e2e-") || !socket.startsWith(root)) throw new Error("Refusing to run outside a throwaway /tmp/waker-e2e-* directory");
const work = path.join(root, "work");
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const health = (await daemon("GET", "/health")).json;
console.log(`PI WEB ${health?.version?.runtimeVersion}, Pi SDK ${health?.piVersion ?? "unknown"}`);
const created = await daemon("POST", "/sessions", { cwd: work });
const id = created.json?.id as string;
console.log(`session created: ${created.status} ${id}`);
await sleep(Number(process.env.SMOKE_WAIT_MS ?? 8000)); // extensions (and any npm package) load while the session starts
const commands = await daemon("GET", `/sessions/${id}/commands?cwd=${encodeURIComponent(work)}`);
const names = (Array.isArray(commands.json) ? commands.json : commands.json?.commands ?? []).map((c: any) => c.invocationName ?? c.name).filter(Boolean).sort();
console.log(`commands (${names.length}): ${names.join(" ")}`);
const status = (await daemon("GET", `/sessions/${id}/status?cwd=${encodeURIComponent(work)}`)).json;
const warnings = status?.warnings ?? [];
console.log(`warnings: ${JSON.stringify(warnings)}`);
const logFile = path.join(root, "sessiond.log");
const log = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "";
const errors = log.split("\n").filter((l) => /"level":(50|60)|Failed to load|Cannot find module|extension.*(error|failed)/i.test(l)).slice(0, 8);
console.log(`daemon log errors: ${errors.length}`);
for (const line of errors) console.log(`  ${line.slice(0, 260)}`);
const needed = ["intercom-wake", "wake-trust", "archive-trust", "intercom-wake-status"];
const missing = needed.filter((n) => !names.includes(n));
console.log(missing.length ? `MISSING intercom commands: ${missing.join(", ")}` : "intercom commands present");
process.exit(created.status === 200 && missing.length === 0 && errors.length === 0 && warnings.length === 0 ? 0 : 1);
