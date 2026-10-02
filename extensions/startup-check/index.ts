import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir } from "../../lib/layout.ts";
import { type McpServerConfig, mcpToolName, processEnvView, readMcpConfig, resolveExposure, serverStatus } from "../../lib/mcp.ts";
import { accountRefs } from "../../lib/refs.ts";
import { surface } from "../../lib/session.ts";

/** Which files of an account reference environment variables that `env` leaves unset: [file, missing vars], files in report order. */
export function missingByFile(dir: string, env: NodeJS.ProcessEnv): [string, string[]][] {
  const out = new Map<string, string[]>();
  for (const r of accountRefs(dir)) if (!env[r.name]) out.set(r.file, [...(out.get(r.file) ?? []), r.name]);
  return [...out];
}

/**
 * Which indirect route pi activates for the account (extensions/mcp/index.js ensureDiscoveryActive): over every enabled
 * server's exposure and toolExposure values, `codemode` activates the codemode tool unless `autoEnableCodemode` is
 * false, and `deferred` activates tool_search. Either one reaches every non-direct, non-hidden tool.
 */
function indirectRoutes(servers: McpServerConfig[], autoEnableCodemode: boolean): { codemode: boolean; toolSearch: boolean } {
  const exposures = new Set<unknown>();
  for (const s of servers) {
    if (s.enabled === false) continue;
    exposures.add(resolveExposure(s.exposure) ?? "codemode");
    for (const e of Object.values(s.toolExposure ?? {})) exposures.add(resolveExposure(e));
  }
  return { codemode: exposures.has("codemode") && autoEnableCodemode, toolSearch: exposures.has("deferred") };
}

/**
 * How the model reaches one usable server's tools, by its pi `exposure` (docs/mcp.md "Control tool exposure"); absent =
 * `codemode`. A non-direct server is reachable only through a route the account activates. `toolExposure` overrides
 * are flagged, not spelled out.
 */
function reach(name: string, srv: McpServerConfig, routes: { codemode: boolean; toolSearch: boolean }): string | undefined {
  const ns = `${mcpToolName(name, "")}*`;
  const overrides = Object.values(srv.toolExposure ?? {}).map(resolveExposure);
  const mixed = overrides.length ? "; some tools have their own exposure" : "";
  const indirect = routes.toolSearch && routes.codemode ? "load with tool_search first, or call from codemode scripts" : routes.toolSearch ? "load with tool_search first" : routes.codemode ? "only from codemode scripts" : undefined;
  const exposure = resolveExposure(srv.exposure) ?? "codemode";
  if (exposure === "direct") return `${name} (direct tools ${ns}${mixed})`;
  if (exposure === "hidden") return overrides.some((e) => e === "direct" || ((e === "codemode" || e === "deferred") && indirect)) ? `${name} (only the tools its toolExposure exposes, ${ns})` : undefined;
  return indirect ? `${name} (${ns}: ${indirect}${mixed})` : undefined;
}

/**
 * One system-prompt section telling the model which MCP Servers pi's built-in MCP Client can reach and how their tools
 * are named, so shared skills written against another Host's server set or names do not call what is not here.
 * Absent mcp.json = no section.
 */
export function mcpBoundarySection(dir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = join(dir, "mcp.json");
  if (!existsSync(path)) return undefined;
  let servers: Record<string, McpServerConfig>;
  let autoEnableCodemode: boolean;
  try {
    const cfg = readMcpConfig(path);
    servers = cfg.mcpServers;
    autoEnableCodemode = cfg.autoEnableCodemode !== false;
  } catch {
    return undefined;
  }
  // One verdict shared with pin doctor (lib/mcp.ts serverStatus), read against pi's own environment and PATH; a usable
  // server whose tools no activated route reaches (hidden, or non-direct with neither codemode nor tool_search on) is listed as not available too.
  const view = { env: processEnvView(env), path: env.PATH };
  const routes = indirectRoutes(Object.values(servers), autoEnableCodemode);
  const available: [string, string][] = [];
  const unavailable: string[] = [];
  for (const [n, s] of Object.entries(servers)) {
    const r = serverStatus(s, view, n).usable ? reach(n, s, routes) : undefined;
    if (r) available.push([n, r]);
    else unavailable.push(n);
  }
  const has = (n: string) => available.some(([a]) => a === n);
  const lines = [
    `MCP tools here come from pi's built-in MCP Client and are named mcp__<server>__<tool>, every character outside [A-Za-z0-9_] turned into _ (kimi-cu: ${mcpToolName("kimi-cu", "get_app_state")}). Claude Code keeps the hyphen (mcp__kimi-cu__…), so map tool names in shared skills by meaning, not by spelling.`,
    available.length ? `Available: ${available.map(([, r]) => r).join("; ")}.` : "No MCP server is enabled in this account.",
    unavailable.length ? `Not available in pi: ${unavailable.join(", ")}. Do not attempt them here; a skill that needs them belongs in Claude Code, Codex or Grok Build.` : "",
    has("kimi-cu") ? `kimi-cu screenshots need a vision model; with a text-only model call ${mcpToolName("kimi-cu", "get_app_state")} with mode=ax (accessibility tree) instead.` : "",
    has("figma-rest")
      ? `figma-rest reads Figma files through the REST API (Framelink), the fallback while the official Figma MCP server is not available to pi: ${mcpToolName("figma-rest", "get_figma_data")}(fileKey, nodeId) returns layout, styles and text as a compact indented tree; ${mcpToolName("figma-rest", "download_figma_images")} saves PNG/SVG exports under the current directory. Take fileKey and nodeId from a figma.com/design/<fileKey>/…?node-id=<a>-<b> URL (node-id 1-2 is nodeId 1:2). It cannot read variables or write to the canvas.`
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
