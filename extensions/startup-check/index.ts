import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../../lib/layout.ts";
import { type McpServerConfig, processEnvView, readMcpConfig, serverStatus } from "../../lib/mcp.ts";
import { accountRefs } from "../../lib/refs.ts";
import { surface } from "../../lib/session.ts";

/** Which files of an account reference environment variables that `env` leaves unset: [file, missing vars], files in report order. */
export function missingByFile(dir: string, env: NodeJS.ProcessEnv): [string, string[]][] {
  const out = new Map<string, string[]>();
  for (const r of accountRefs(dir)) if (!env[r.name]) out.set(r.file, [...(out.get(r.file) ?? []), r.name]);
  return [...out];
}

/**
 * One system-prompt section telling the model which MCP Servers this pi can reach, so shared skills written against
 * another Host's server set (Figma remote, 45 tools) do not call what is not here. Absent mcp.json = no section.
 */
export function mcpBoundarySection(dir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = join(dir, "mcp.json");
  if (!existsSync(path)) return undefined;
  let servers: Record<string, McpServerConfig>;
  try {
    servers = readMcpConfig(path).mcpServers;
  } catch {
    return undefined;
  }
  // One verdict shared with pin doctor (lib/mcp.ts serverStatus), read against pi's own environment and PATH.
  const view = { env: processEnvView(env), path: env.PATH };
  const usable = ([, s]: [string, McpServerConfig]) => serverStatus(s, view).usable;
  const entries = Object.entries(servers);
  const enabled = entries.filter(usable);
  const disabled = entries.filter((e) => !usable(e));
  const lines = [
    "This pi reaches MCP servers only through the pi-mcp-adapter bridge; tool names are <server>_<tool>. The mcpScript tool is turned off here.",
    enabled.length
      ? `Available: ${enabled.map(([n, s]) => (s.directTools ? `${n} (direct tools ${n}_*)` : `${n} (proxy: first mcp({search:"${n}"}) to list its tools, then mcp({tool:"${n}_<tool>", args:{…}}))`)).join("; ")}.`
      : "No MCP server is enabled in this account.",
    disabled.length ? `Not available in pi: ${disabled.map(([n]) => n).join(", ")}. Do not attempt them here; a skill that needs them belongs in Claude Code, Codex or Grok Build.` : "",
    enabled.some(([n]) => n === "kimi-cu") ? "kimi-cu screenshots need a vision model; with a text-only model call kimi-cu_get_app_state with mode=ax (accessibility tree) instead." : "",
    enabled.some(([n]) => n === "figma-rest")
      ? "figma-rest reads Figma files through the REST API (Framelink), not the official Figma MCP server: figma-rest_get_figma_data(fileKey, nodeId) returns layout, styles and text as a compact indented tree; figma-rest_download_figma_images saves PNG/SVG exports under the current directory. Take fileKey and nodeId from a figma.com/design/<fileKey>/…?node-id=<a>-<b> URL (node-id 1-2 is nodeId 1:2). It cannot read variables or write to the canvas."
      : "",
  ].filter(Boolean);
  return lines.join("\n");
}

export default function startupCheck(pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const section = mcpBoundarySection(agentDir());
    if (section) event.systemPromptOptions.sections["adonis_pi_mcp"] = section;
  });

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" || !surface(ctx).canPrompt) return;
    const missing = missingByFile(agentDir(), process.env);
    if (missing.length === 0) return;
    const needs = missing.map(([file, vars]) => `${file} needs ${vars.join(", ")}`).join("; ");
    const vars = missing.flatMap(([, v]) => v);
    ctx.ui.notify(`adonis-pi: ${needs} but the environment does not set ${vars.length === 1 ? "it" : "them"}. Add \`export ${vars[0]}=…\` to ${join(agentDir(), "proxy.env")} and launch through \`pin <n>\` so it is loaded.`, "warning");
  });
}
