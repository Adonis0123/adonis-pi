import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSession, type SessionDeps } from "../../lib/session.ts";
import { matchToolCall } from "./match.ts";

export default function permissionGate(pi: ExtensionAPI, deps: SessionDeps = {}) {
  pi.on("tool_call", async (event, ctx) => {
    const session = getSession(ctx, deps);
    if (session.config.permissionGate.mode === "off") return;
    const input = event.input as Record<string, unknown>;
    const hit = matchToolCall({ toolName: event.toolName, input }, session.config.permissionGate, ctx.cwd);
    if (!hit) return;

    if (session.config.permissionGate.mode === "block" || !session.surface.canPrompt) {
      return { block: true, reason: `adonis-pi permission gate: ${hit.reason}` };
    }
    session.notify({ kind: "permission", toolName: event.toolName, input });
    const allowed = await ctx.ui.confirm("Permission gate", `${hit.reason}\n\n${hit.detail}\n\nAllow this call?`);
    if (!allowed) {
      return { block: true, reason: `User denied: ${hit.reason}` };
    }
  });
}
