import http from "http";
import https from "https";
import type { WakeTarget } from "../types.ts";
import { SAFE_MESSAGE_ID, SAFE_SESSION_ID, WAKE_COMMAND_PROMPT, WakeError, type WakeCandidate, type WakeProvider } from "./provider.ts";

/**
 * Wake provider for the PI WEB session daemon.
 *
 * EXPERIMENTAL: it uses internal, unsupported routes of the daemon,
 *   GET  /health                               identifies the daemon
 *   GET  /sessions?cwd=<absolute cwd>          read-only catalog of persisted sessions
 *   POST /sessions                             creates a new, empty session in a directory (spawn)
 *   POST /sessions/bulk/archive                archives sessions (reversible); answers 200 even for sessions it refused
 *   POST /sessions/:sessionId/commands/run     opens a saved session and runs one REGISTERED command
 * commands/run is used instead of /prompt because it refuses a command the session does not have (an intercom
 * that is missing or too old), so "/intercom-wake ..." can never reach a model as text, and it does not echo the
 * command in the PI WEB transcript. Verified on an isolated daemon (scripts/e2e/busy-e2e.ts).
 * They can change in any PI WEB release. Every unexpected answer becomes a WakeError (fail closed).
 * Do not call any other session route to "check" a session: status, messages, and snapshots open it too.
 * The endpoint is never guessed: it comes from configuration or PI_WEB_SESSIOND_SOCKET / PI_WEB_SESSIOND_URL.
 */
export const SESSIOND_PROVIDER_ID = "pi-web-sessiond";

interface Endpoint { socketPath?: string; url?: URL }

function resolveEndpoint(options: { sessiondSocket?: string; sessiondUrl?: string }, env: NodeJS.ProcessEnv): Endpoint {
  const url = options.sessiondUrl ?? (options.sessiondSocket ? undefined : env.PI_WEB_SESSIOND_URL);
  if (url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new WakeError("unavailable", "The session daemon URL must be http or https");
    return { url: parsed };
  }
  const socketPath = options.sessiondSocket ?? env.PI_WEB_SESSIOND_SOCKET;
  if (!socketPath) {
    throw new WakeError("unavailable", "The PI WEB session daemon endpoint is not configured (set PI_WEB_SESSIOND_SOCKET, or wake.sessiondSocket / wake.sessiondUrl in the intercom config).");
  }
  return { socketPath };
}

interface HttpResult { status: number; json: unknown }

const CONNECT_FAILURES = new Set(["ECONNREFUSED", "ENOENT", "EACCES", "EPERM", "ENOTFOUND", "EHOSTUNREACH"]);

export function createSessiondProvider(options: { sessiondSocket?: string; sessiondUrl?: string } = {}, env: NodeJS.ProcessEnv = process.env): WakeProvider {
  let daemon: string | undefined;

  const request = (method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, signal: AbortSignal | undefined, uncertainOnFailure: boolean): Promise<HttpResult> => new Promise((resolve, reject) => {
    let endpoint: Endpoint;
    try {
      endpoint = resolveEndpoint(options, env);
    } catch (error) {
      reject(error instanceof WakeError ? error : new WakeError("unavailable", error instanceof Error ? error.message : String(error)));
      return;
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = { accept: "application/json" };
    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    const onResponse = (response: http.IncomingMessage) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 8 * 1024 * 1024) {
          response.destroy();
          reject(new WakeError("unsupported", "The session daemon answer is too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json: unknown;
        try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
        resolve({ status: response.statusCode ?? 0, json });
      });
      response.on("error", (error) => reject(failure(error)));
    };
    const failure = (error: unknown): WakeError => {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code && CONNECT_FAILURES.has(code)) return new WakeError("unavailable", `Cannot reach the session daemon (${code})`);
      if ((error as Error | undefined)?.name === "AbortError") return new WakeError(uncertainOnFailure ? "timeout" : "unavailable", "The session daemon request was aborted or timed out");
      return uncertainOnFailure
        ? new WakeError("timeout", `The session daemon request failed after it was sent (${(error as Error | undefined)?.message ?? "unknown"})`)
        : new WakeError("unavailable", `The session daemon request failed (${(error as Error | undefined)?.message ?? "unknown"})`);
    };
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const common = { method, headers, signal: combined };
    try {
      const req = endpoint.socketPath
        ? http.request({ ...common, socketPath: endpoint.socketPath, path })
        : (endpoint.url!.protocol === "https:" ? https : http).request(new URL(path, endpoint.url), common, onResponse);
      if (endpoint.socketPath) req.on("response", onResponse);
      req.on("error", (error) => reject(failure(error)));
      if (payload !== undefined) req.write(payload);
      req.end();
    } catch (error) {
      reject(failure(error));
    }
  });

  const errorText = (json: unknown): string => {
    const text = typeof json === "object" && json !== null && typeof (json as { error?: unknown }).error === "string" ? (json as { error: string }).error : "";
    return text.slice(0, 200);
  };

  const identify = async (timeoutMs: number, signal: AbortSignal | undefined): Promise<void> => {
    const health = await request("GET", "/health", undefined, timeoutMs, signal, false);
    const version = (health.json as { version?: { component?: unknown; runtimeVersion?: unknown } } | undefined)?.version;
    if (health.status !== 200 || (health.json as { ok?: unknown } | undefined)?.ok !== true || version?.component !== "sessiond") {
      throw new WakeError("unsupported", "The endpoint does not look like a PI WEB session daemon (unexpected /health answer)");
    }
    daemon = typeof version.runtimeVersion === "string" ? `sessiond ${version.runtimeVersion}` : "sessiond";
  };

  return {
    id: SESSIOND_PROVIDER_ID,
    describe: () => daemon,

    async list(cwd, signal) {
      const timeoutMs = 30_000; // backstop: the caller bounds the call with its own signal
      await identify(timeoutMs, signal);
      const result = await request("GET", `/sessions?cwd=${encodeURIComponent(cwd)}`, undefined, timeoutMs, signal, false);
      if (result.status === 400) throw new WakeError("rejected", `The session daemon refused the directory: ${errorText(result.json) || "bad request"}`);
      if (result.status !== 200 || !Array.isArray(result.json)) throw new WakeError("unsupported", `Unexpected catalog answer from the session daemon (HTTP ${result.status})`);
      const candidates: WakeCandidate[] = [];
      for (const item of result.json as unknown[]) {
        if (typeof item !== "object" || item === null) throw new WakeError("unsupported", "Unexpected catalog entry from the session daemon");
        const entry = item as Record<string, unknown>;
        if (typeof entry.id !== "string" || !entry.id || typeof entry.cwd !== "string") throw new WakeError("unsupported", "Unexpected catalog entry from the session daemon");
        candidates.push({
          piSessionId: entry.id,
          cwd: entry.cwd,
          archived: entry.archived === true,
          ...(typeof entry.name === "string" ? { name: entry.name } : {}),
          ...(typeof entry.modified === "string" ? { modified: entry.modified } : {}),
          ...(typeof entry.messageCount === "number" ? { messageCount: entry.messageCount } : {}),
        });
      }
      return candidates;
    },

    async create(cwd, signal) {
      await identify(30_000, signal);
      // The request may have created the session even if the answer is lost: failures after sending are uncertain.
      const result = await request("POST", "/sessions", { cwd }, 30_000, signal, true);
      const answer = result.json as { id?: unknown } | undefined;
      if (result.status === 200 && typeof answer?.id === "string" && SAFE_SESSION_ID.test(answer.id)) return { piSessionId: answer.id };
      const message = errorText(result.json);
      if (result.status === 400) throw new WakeError("rejected", `The session daemon refused to create a session: ${message || "bad request"}`);
      if (result.status >= 500) throw new WakeError("server_error", `The session daemon failed while creating the session (HTTP ${result.status})`);
      throw new WakeError("unsupported", `Unexpected answer when creating a session (HTTP ${result.status})`);
    },

    async archive(target, signal) {
      if (!SAFE_SESSION_ID.test(target.piSessionId)) throw new WakeError("rejected", "The session id is not valid for an archive");
      await identify(30_000, signal);
      // Only the bulk route is used: it archives a session that is not loaded without loading it, and it refuses a working one.
      const result = await request("POST", "/sessions/bulk/archive", { sessions: [{ id: target.piSessionId, cwd: target.cwd }] }, 30_000, signal, true);
      const answer = result.json as { archivedSessionIds?: unknown; failures?: unknown } | undefined;
      if (result.status === 200 && Array.isArray(answer?.archivedSessionIds) && Array.isArray(answer?.failures)) {
        if ((answer.archivedSessionIds as unknown[]).includes(target.piSessionId)) return;
        const failure = (answer.failures as unknown[]).find((item) => typeof item === "object" && item !== null && (item as { sessionId?: unknown }).sessionId === target.piSessionId) as { error?: unknown } | undefined;
        const why = typeof failure?.error === "string" ? failure.error.slice(0, 200) : "";
        if (/stop current session activity/i.test(why)) throw new WakeError("busy", "The session is working; the host refuses to archive it");
        if (/not found/i.test(why)) throw new WakeError("not_found", "The session daemon has no such session in that directory");
        throw new WakeError("rejected", `The session daemon did not archive the session${why ? `: ${why}` : ""}`);
      }
      const message = errorText(result.json);
      if (result.status === 404) throw new WakeError("not_found", "The session daemon has no such session in that directory");
      if (result.status === 400) throw new WakeError("rejected", `The session daemon refused the archive: ${message || "bad request"}`);
      if (result.status >= 500) throw new WakeError("server_error", `The session daemon failed while archiving (HTTP ${result.status})`);
      throw new WakeError("unsupported", `Unexpected answer when archiving a session (HTTP ${result.status})`);
    },

    async wake(target: WakeTarget, messageId: string, signal) {
      if (!SAFE_MESSAGE_ID.test(messageId)) throw new WakeError("rejected", "The message id cannot be carried in a wake command");
      const result = await request(
        "POST",
        `/sessions/${encodeURIComponent(target.piSessionId)}/commands/run`,
        // A busy session runs the command at once (streaming) or right after compaction; no model call either way.
        { cwd: target.cwd, text: WAKE_COMMAND_PROMPT(messageId) },
        30_000, // backstop: the caller bounds the call with its own signal
        signal,
        true,
      );
      const answer = result.json as { type?: unknown; message?: unknown } | undefined;
      if (result.status === 200 && answer?.type === "done") return;
      if (result.status === 200 && answer?.type === "unsupported") {
        const why = typeof answer.message === "string" ? answer.message.slice(0, 200) : "unsupported";
        throw new WakeError("rejected", `The session cannot run /intercom-wake (${why}); its intercom extension is missing or too old, so nothing was sent to it`);
      }
      const message = errorText(result.json);
      if (result.status === 404 || /session not found/i.test(message)) throw new WakeError("not_found", "The session daemon has no such session in that directory");
      if (/archived/i.test(message)) throw new WakeError("archived", "The session is archived and read-only");
      if (result.status >= 500) throw new WakeError("server_error", `The session daemon failed while handling the wake (HTTP ${result.status})`);
      if (result.status === 200) throw new WakeError("unsupported", "Unexpected wake answer from the session daemon");
      // (an "accepted" answer would come from the /prompt route, which this provider no longer uses)
      throw new WakeError("rejected", `The session daemon refused the wake (HTTP ${result.status}${message ? `: ${message}` : ""})`);
    },
  };
}
