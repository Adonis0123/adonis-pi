// MCP Config (CONTEXT.md): the shape of mcp.json, the Bridge's `${VAR}` grammar, and the one Server Status verdict.
// Reads only the files and environment view it is handed; never proxy.env (that is lib/environment.ts, launcher-only).
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config.ts";
import { expandTilde, KIMI_CU_PLACEHOLDER } from "./layout.ts";

export interface McpServerConfig {
  command?: string;
  args?: string[];
  /** Child environment. The MCP Bridge (pi-mcp-adapter 2.36.0) expands `${VAR}`, `$env:VAR` and `{env:VAR}` inside these strings (and url/headers/cwd) from pi's environment, which `pin` fills from proxy.env. It does not expand a bare `$VAR`. */
  env?: Record<string, string>;
  headers?: Record<string, string>;
  cwd?: string;
  /** Per-call timeout for this server (ms); the Bridge falls back to the MCP SDK default (60 s) when absent. */
  requestTimeoutMs?: number;
  url?: string;
  disabled?: boolean;
  directTools?: boolean | string[];
}
export interface McpConfig {
  settings?: Record<string, unknown>;
  mcpServers: Record<string, McpServerConfig>;
}

/** Read an mcp.json (Template or Account). Throws on malformed JSON or a missing mcpServers object. */
export function readMcpConfig(path: string): McpConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || typeof (raw as McpConfig).mcpServers !== "object" || (raw as McpConfig).mcpServers === null) {
    throw new ConfigError(`${path} must contain an mcpServers object`);
  }
  return raw as McpConfig;
}

/** The exact syntaxes pi-mcp-adapter 2.36.0 interpolates (utils.ts interpolateEnvVars); anything else is sent literally. */
const MCP_ENV_REF = /\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g;
/** A whole-string bare "$VAR": what models.json uses, but what the Bridge would pass through unexpanded. */
const BARE_REF = /^\$([A-Za-z_][A-Za-z0-9_]*)$/;

function mcpStrings(srv: McpServerConfig): string[] {
  return [...Object.values(srv.env ?? {}), ...Object.values(srv.headers ?? {}), srv.url, srv.cwd].filter((v): v is string => typeof v === "string");
}

/** Environment variables a server's env/headers/url/cwd reference in a syntax the Bridge expands, sorted, deduplicated. */
export function mcpServerEnvRefs(srv: McpServerConfig): string[] {
  const found = new Set<string>();
  for (const v of mcpStrings(srv)) for (const m of v.matchAll(MCP_ENV_REF)) found.add(m[1] ?? m[2] ?? m[3]);
  return [...found].sort();
}

/** Bare "$VAR" values the Bridge would NOT expand: a config mistake doctor flags instead of counting as a reference. */
export function mcpBareRefs(srv: McpServerConfig): string[] {
  return [...new Set(mcpStrings(srv).map((v) => BARE_REF.exec(v)?.[1]).filter((v): v is string => v !== undefined))].sort();
}

/** Every variable any server references, over all servers (disabled ones too: doctor reports what the file asks for). */
export function mcpEnvRefs(cfg: McpConfig): string[] {
  return [...new Set(Object.values(cfg.mcpServers).flatMap(mcpServerEnvRefs))].sort();
}

export function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Where a stdio server's `command` resolves to an executable regular file on this machine, or undefined. A path
 * (contains "/") must exist as given (after ~ expansion); a bare name such as `npx` is looked up on PATH the way the
 * shell would (empty PATH entries are skipped, not read as ".").
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (command.length === 0) return undefined;
  if (command.includes("/")) {
    const p = expandTilde(command);
    return isExecutableFile(p) ? p : undefined;
  }
  for (const dir of (env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = join(dir, command);
    if (isExecutableFile(p)) return p;
  }
  return undefined;
}

/** How one environment variable looks to the Bridge: non-empty, empty/unset, or not decidable without running a shell. */
export type VarState = "set" | "empty" | "unknown";
/** How a caller sees the environment: pi reads its own process environment, `pin doctor` a static parse of proxy.env. */
export type EnvView = (name: string) => VarState;
export const processEnvView =
  (env: NodeJS.ProcessEnv): EnvView =>
  (name) => (env[name] ? "set" : "empty");

/**
 * The one verdict on whether an MCP Server can be reached from a pi launched on this account (CONTEXT.md "Server
 * Status"); `pin doctor` and startup-check only phrase it. `target` is the command or url as written (callers redact
 * urls before printing).
 */
export type ServerStatus =
  | { usable: true; target: string; refs: string[] }
  | { usable: false; kind: "disabled" }
  | { usable: false; kind: "placeholder"; command: string }
  | { usable: false; kind: "no-target" }
  | { usable: false; kind: "command-unresolved"; command: string }
  | { usable: false; kind: "env-empty"; target: string; vars: string[] }
  | { usable: false; kind: "env-unknown"; target: string; vars: string[] };

export function serverStatus(srv: McpServerConfig, view: { env: EnvView; path?: string }): ServerStatus {
  if (srv.disabled) return { usable: false, kind: "disabled" };
  if (srv.command === KIMI_CU_PLACEHOLDER) return { usable: false, kind: "placeholder", command: srv.command };
  const target = srv.command ?? srv.url;
  if (target === undefined) return { usable: false, kind: "no-target" };
  if (srv.command !== undefined && resolveCommand(srv.command, { PATH: view.path }) === undefined) return { usable: false, kind: "command-unresolved", command: srv.command };
  const refs = mcpServerEnvRefs(srv);
  const empty = refs.filter((v) => view.env(v) === "empty");
  if (empty.length) return { usable: false, kind: "env-empty", target, vars: empty };
  const unknown = refs.filter((v) => view.env(v) === "unknown");
  if (unknown.length) return { usable: false, kind: "env-unknown", target, vars: unknown };
  return { usable: true, target, refs };
}
