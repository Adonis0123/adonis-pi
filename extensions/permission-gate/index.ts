import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getRuntimeConfig } from "../../lib/runtime-config.ts";
import { buildPayload, sendNotify, sessionRef } from "../../lib/notify.ts";
import { matchToolCall } from "./match.ts";

export default function permissionGate(pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const cfg = getRuntimeConfig(ctx);
    const hit = matchToolCall({ toolName: event.toolName, input: event.input as Record<string, unknown> }, cfg.permissionGate, ctx.cwd);
    if (!hit) return;

    if (cfg.permissionGate.mode === "block" || !ctx.hasUI) {
      return { block: true, reason: `adonis-pi permission gate: ${hit.reason}` };
    }

    if (cfg.notify.kinds.confirm) {
      const input = event.input as Record<string, unknown>;
      const summary = typeof input.command === "string" ? { command: input.command.slice(0, 200) } : typeof input.path === "string" ? { path: input.path } : {};
      sendNotify(cfg.notify, ["--agent", "pi"], buildPayload("permission", sessionRef(ctx), { tool_name: event.toolName, tool_input: summary }));
    }
    const allowed = await ctx.ui.confirm("Permission gate", `${hit.reason}\n\n${hit.detail}\n\nAllow this call?`);
    if (!allowed) {
      return { block: true, reason: `User denied: ${hit.reason}` };
    }
  });
}
