import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRuntimeConfig } from "../../lib/runtime-config.ts";
import { buildPayload, classifyError, lastAssistantText, sendNotify, sessionRef } from "../../lib/notify.ts";

type Kinds = { confirm: boolean; fail: boolean; idle: boolean };
type Decision = { kind: "fail"; error: string; details: string } | { kind: "stop"; text: string } | undefined;
interface BranchEntry {
  type: string;
  message?: { role: string; content?: unknown; stopReason?: string; errorMessage?: string };
}

export function lastAssistantFromBranch(entries: ReadonlyArray<BranchEntry>) {
  const messages = entries.filter((e) => e.type === "message" && e.message).map((e) => e.message!);
  return lastAssistantText(messages);
}

export function decideSettled(entries: ReadonlyArray<BranchEntry>, kinds: Kinds): Decision {
  const last = lastAssistantFromBranch(entries);
  if (!last) return undefined;
  if (last.stopReason === "aborted") return undefined; // the user interrupted; nobody is waiting on a notification
  if (last.stopReason === "error") {
    if (!kinds.fail) return undefined;
    const code = classifyError(last.errorMessage ?? "");
    return code ? { kind: "fail", error: code, details: last.errorMessage ?? "" } : undefined;
  }
  // The notifier turns one Stop into either confirm or idle; with confirm off we cannot send Stop at all
  // (config validation already rejects idle-without-confirm).
  if (!kinds.confirm) return undefined;
  return { kind: "stop", text: last.text };
}

export default function attentionNotify(pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    if (ctx.mode !== "tui") return;
    const cfg = getRuntimeConfig(ctx);
    sendNotify(cfg.notify, ["--agent", "pi", "--mark"], buildPayload("mark", sessionRef(ctx), { tool_name: (event as { toolName?: string }).toolName ?? "unknown" }));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    const cfg = getRuntimeConfig(ctx);
    const entries = (ctx.sessionManager as { getBranch?: () => BranchEntry[] }).getBranch?.() ?? [];
    const d = decideSettled(entries, cfg.notify.kinds);
    if (!d) return;
    if (d.kind === "fail") {
      sendNotify(cfg.notify, ["--agent", "pi"], buildPayload("fail", sessionRef(ctx), { error: d.error, error_details: d.details.slice(0, 500) }));
    } else {
      sendNotify(cfg.notify, ["--agent", "pi"], buildPayload("stop", sessionRef(ctx), { last_assistant_message: d.text.slice(-4000) }));
    }
  });
}
