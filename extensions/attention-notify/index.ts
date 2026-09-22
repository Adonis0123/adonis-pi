import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSession, type SessionDeps } from "../../lib/session.ts";
import type { BranchEntry } from "../../lib/notify.ts";


export default function attentionNotify(pi: ExtensionAPI, deps: SessionDeps = {}) {
  pi.on("tool_result", async (event, ctx) => {
    getSession(ctx, deps).notify({ kind: "activity", toolName: (event as { toolName?: string }).toolName ?? "unknown" });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const entries = (ctx.sessionManager as { getBranch?: () => BranchEntry[] }).getBranch?.() ?? [];
    getSession(ctx, deps).notify({ kind: "settled", entries });
  });
}
