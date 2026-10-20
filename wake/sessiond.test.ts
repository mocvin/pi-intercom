import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createSessiondProvider } from "./sessiond.ts";
import { WakeError } from "./provider.ts";

type Handler = (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void;

async function withDaemon<T>(handler: Handler, fn: (socketPath: string, requests: Array<{ method: string; url: string; body: string }>) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "wake-sessiond-"));
  const socketPath = join(dir, "sessiond.sock");
  const requests: Array<{ method: string; url: string; body: string }> = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      handler(req, body, res);
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  try {
    return await fn(socketPath, requests);
  } finally {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const json = (res: http.ServerResponse, status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const health = { ok: true, activeSessions: 3, version: { component: "sessiond", runtimeVersion: "1.202610.1" } };
const catalog = [
  { id: "0198-live", path: "/p/a.jsonl", cwd: "/repo", name: "worker", created: "c", modified: "m", messageCount: 12, firstMessage: "hi" },
  { id: "0198-arch", path: "/p/b.jsonl", cwd: "/repo", archived: true, created: "c", modified: "m", messageCount: 1, firstMessage: "x" },
];
const expectWakeError = async (promise: Promise<unknown>, code: string, definitive: boolean) => {
  await assert.rejects(promise, (error: unknown) => error instanceof WakeError && error.code === code && error.definitive === definitive, `expected ${code}`);
};

test("list reads only /health and the catalog route, and maps entries including archived", async () => {
  await withDaemon((req, _b, res) => (req.url === "/health" ? json(res, 200, health) : json(res, 200, catalog)), async (socketPath, requests) => {
    const provider = createSessiondProvider({ sessiondSocket: socketPath });
    const candidates = await provider.list("/repo with space/ü");
    assert.deepEqual(candidates.map((c) => [c.piSessionId, c.name, c.archived]), [["0198-live", "worker", false], ["0198-arch", undefined, true]]);
    assert.equal(provider.describe?.(), "sessiond 1.202610.1");
    assert.deepEqual(requests.map((r) => `${r.method} ${r.url.split("?")[0]}`), ["GET /health", "GET /sessions"], "no route that opens a session is ever called");
    assert.equal(new URL(requests[1]!.url, "http://x").searchParams.get("cwd"), "/repo with space/ü");
  });
});

test("list fails closed on anything that is not a recognizable session daemon", async () => {
  const cases: Array<[string, Handler, string]> = [
    ["wrong component", (_r, _b, res) => json(res, 200, { ok: true, version: { component: "web" } }), "unsupported"],
    ["health not ok", (_r, _b, res) => json(res, 503, { ok: false }), "unsupported"],
    ["catalog not an array", (r, _b, res) => (r.url === "/health" ? json(res, 200, health) : json(res, 200, { sessions: [] })), "unsupported"],
    ["catalog entry without id", (r, _b, res) => (r.url === "/health" ? json(res, 200, health) : json(res, 200, [{ cwd: "/repo" }])), "unsupported"],
    ["catalog entry not an object", (r, _b, res) => (r.url === "/health" ? json(res, 200, health) : json(res, 200, ["x"])), "unsupported"],
    ["catalog refused", (r, _b, res) => (r.url === "/health" ? json(res, 200, health) : json(res, 400, { error: "cwd query parameter is required" })), "rejected"],
    ["catalog 500", (r, _b, res) => (r.url === "/health" ? json(res, 200, health) : json(res, 500, {})), "unsupported"],
    ["health not json", (_r, _b, res) => { res.writeHead(200); res.end("<html>"); }, "unsupported"],
  ];
  for (const [label, handler, code] of cases) {
    await withDaemon(handler, async (socketPath) => {
      await assert.rejects(createSessiondProvider({ sessiondSocket: socketPath }).list("/repo"), (error: unknown) => error instanceof WakeError && error.code === code && error.definitive, label);
    });
  }
});

test("an unreachable or unconfigured daemon is a definitive 'unavailable' and nothing is guessed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wake-sessiond-none-"));
  try {
    await expectWakeError(createSessiondProvider({ sessiondSocket: join(dir, "nope.sock") }).list("/repo"), "unavailable", true);
    await expectWakeError(createSessiondProvider({}, {}).list("/repo"), "unavailable", true);
    await expectWakeError(createSessiondProvider({}, {}).wake({ piSessionId: "p", cwd: "/repo" }, "m1"), "unavailable", true);
    // The endpoint comes from the environment only when it is set explicitly.
    await withDaemon((r, _b, res) => (r.url === "/health" ? json(res, 200, health) : json(res, 200, [])), async (socketPath) => {
      assert.deepEqual(await createSessiondProvider({}, { PI_WEB_SESSIOND_SOCKET: socketPath }).list("/repo"), []);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wake runs the internal command through the session's commands route with the exact cwd", async () => {
  await withDaemon((_r, _b, res) => json(res, 200, { type: "done" }), async (socketPath, requests) => {
    await createSessiondProvider({ sessiondSocket: socketPath }).wake({ piSessionId: "0198/odd id", cwd: "/repo" }, "msg-1");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]!.method, "POST");
    assert.equal(requests[0]!.url, "/sessions/0198%2Fodd%20id/commands/run");
    assert.deepEqual(JSON.parse(requests[0]!.body), { cwd: "/repo", text: "/intercom-wake msg-1" });
  });
});

test("wake maps the daemon's answers: refusals are definitive, unknown outcomes are not", async () => {
  const target = { piSessionId: "p", cwd: "/repo" };
  const cases: Array<[Handler, string, boolean]> = [
    [(_r, _b, res) => json(res, 404, { error: "Session not found" }), "not_found", true],
    [(_r, _b, res) => json(res, 400, { error: "Session not found" }), "not_found", true],
    [(_r, _b, res) => json(res, 400, { error: "Archived sessions are read-only. Restore the session to continue." }), "archived", true],
    [(_r, _b, res) => json(res, 400, { error: "cwd field must be a string" }), "rejected", true],
    [(_r, _b, res) => json(res, 500, { error: "boom" }), "server_error", false],
    [(_r, _b, res) => json(res, 200, { type: "unsupported", message: "Unknown command: /intercom-wake" }), "rejected", true],
    [(_r, _b, res) => json(res, 200, { accepted: true }), "unsupported", true],
    [(_r, _b, res) => json(res, 200, { type: "select" }), "unsupported", true],
    [(_r, _b, res) => json(res, 200, {}), "unsupported", true],
  ];
  for (const [handler, code, definitive] of cases) {
    await withDaemon(handler, async (socketPath) => expectWakeError(createSessiondProvider({ sessiondSocket: socketPath }).wake(target, "m1"), code, definitive));
  }
});

test("a wake whose answer never arrives is an uncertain timeout, not a definitive failure", async () => {
  await withDaemon(() => undefined, async (socketPath) => {
    await expectWakeError(createSessiondProvider({ sessiondSocket: socketPath }).wake({ piSessionId: "p", cwd: "/repo" }, "m1", AbortSignal.timeout(150)), "timeout", false);
  });
});

test("a message id that cannot be carried safely in a command is refused before anything is sent", async () => {
  await withDaemon((_r, _b, res) => json(res, 200, { type: "done" }), async (socketPath, requests) => {
    for (const bad of ["", "a b", "x\n/other", "a;b", "$(id)", "x".repeat(200)]) {
      await expectWakeError(createSessiondProvider({ sessiondSocket: socketPath }).wake({ piSessionId: "p", cwd: "/repo" }, bad), "rejected", true);
    }
    assert.equal(requests.length, 0);
  });
});
