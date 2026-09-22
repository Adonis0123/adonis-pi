import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir, configEnvRefs, envRefs, KIMI_CU_PLACEHOLDER, mcpEnvRefs, mcpServerEnvRefs, missingEnvRefs, readMcpConfig, resolveCommand, type McpServerConfig } from "../../lib/config.ts";
import { surface } from "../../lib/session.ts";

export { envRefs, missingEnvRefs };

/** Which files of an account reference environment variables that `env` leaves unset: [file label, missing vars]. */
export function missingByFile(dir: string, env: NodeJS.ProcessEnv): [string, string[]][] {
  const out: [string, string[]][] = [];
  const models = join(dir, "models.json");
  if (existsSync(models)) {
    const m = missingEnvRefs(readFileSync(models, "utf8"), env);
    if (m.length) out.push(["models.json", m]);
  }
  // The effective Config = account file merged over the template, so template defaults such as "$ADONIS_PI_NOTIFY_CMD" count too.
  const c = configEnvRefs(join(dir, "adonis-pi.json")).filter((v) => !env[v]);
  if (c.length) out.push(["adonis-pi.json", c]);
  const mcp = join(dir, "mcp.json");
  if (existsSync(mcp)) {
    try {
      const m = mcpEnvRefs(readMcpConfig(mcp)).filter((v) => !env[v]);
      if (m.length) out.push(["mcp.json", m]);
    } catch {} // an unreadable mcp.json is pin doctor's report, not a missing variable
  }
  return out;
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
  // Same tests pin doctor applies: disabled, an unresolved placeholder, a command that is not an executable, or an unset
  // variable the server needs (the Bridge would start it with an empty key and it would fail on first call) all mean
  // "not here". A bare "$VAR" is only a doctor warning: it may be a deliberate literal, and the Bridge passes it through.
  const usable = ([, s]: [string, McpServerConfig]) =>
    !s.disabled &&
    s.command !== KIMI_CU_PLACEHOLDER &&
    (s.command === undefined || resolveCommand(s.command, env) !== undefined) &&
    mcpServerEnvRefs(s).every((v) => Boolean(env[v]));
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
