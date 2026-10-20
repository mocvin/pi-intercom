/**
 * Test-only model for the isolated E2E daemon: no network, no credentials.
 * It records what it was asked (to prove whether a wake prompt ever reached a model) and is scriptable:
 *   - a user text containing SLOW makes the turn last FAUX_SLOW_MS (default 10 s);
 *   - a user text containing ASKFORM makes the model call ask_user (an open browser form);
 *   - while the file $WAKER_E2E_ROOT/slow-all exists every call is slow (used to hold a compaction open).
 * Loaded only by scripts/e2e/run.sh into a throwaway agent directory.
 */
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

export default function fauxModel(pi: any): void {
  const root = process.env.WAKER_E2E_ROOT ?? "";
  if (!root.startsWith("/tmp/waker-e2e-")) return;
  const log = join(root, "model-calls.jsonl");
  const slowMs = Number(process.env.FAUX_SLOW_MS ?? 10_000);
  const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  const faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", name: "Faux", contextWindow: 200_000, maxTokens: 4_000 }], tokensPerSecond: 2_000 });
  const step = async (context: any, options: any) => {
    const messages: any[] = context.messages ?? [];
    const users = messages.filter((m) => m.role === "user");
    const last = users.at(-1);
    const lastText = typeof last?.content === "string" ? last.content : (last?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
    const all = JSON.stringify(messages);
    const slow = lastText.includes("SLOW") || existsSync(join(root, "slow-all"));
    appendFileSync(log, `${JSON.stringify({ t: Date.now(), lastUser: lastText.slice(0, 120), sawWakePrompt: all.includes("/intercom-wake"), slow })}\n`);
    if (slow) await sleep(slowMs, options?.signal);
    if (lastText.includes("ASKFORM") && !messages.some((m) => m.role === "toolResult" && m.toolName === "ask_user")) {
      return fauxAssistantMessage(fauxToolCall("ask_user", { questions: [{ id: "q1", question: "Which option?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] }] }), { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(`ok (${lastText.slice(0, 40)})`);
  };
  faux.setResponses(Array.from({ length: 500 }, () => step));
  pi.registerProvider(faux.provider);
}
