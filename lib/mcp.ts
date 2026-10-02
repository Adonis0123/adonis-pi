// MCP Config (CONTEXT.md): the shape of mcp.json as pi's built-in MCP Client reads it, its `${VAR}` grammar, the
// leftovers of the retired pi-mcp-adapter Bridge, and the one Server Status verdict (ADR 0004).
// Reads only the files and environment view it is handed; never proxy.env (that is lib/environment.ts, launcher-only).
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config.ts";
import { expandTilde, KIMI_CU_PLACEHOLDER } from "./layout.ts";

export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
export interface McpServerConfig {
  type?: string;
  command?: string;
  args?: string[];
  /** Child environment, added to pi's own (which `pin` fills from proxy.env). Values are pi config values: see `mcpServerEnvRefs`. */
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  /** Request headers; pi config values like `env`. */
  headers?: Record<string, string>;
  oauth?: { clientName?: string; clientId?: string; clientSecret?: string; [k: string]: unknown };
  /** false keeps the entry without connecting. Default true. */
  enabled?: boolean;
  /** How tools reach the model; pi's default is `codemode`. */
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
  /** Per-request timeout in seconds (pi default 60). */
  timeout?: number;
  description?: string;
}
export interface McpConfig {
  autoEnableCodemode?: boolean;
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

/**
 * The registered name of a server's tool, as pi 1.0.0 builds it (extensions/mcp/tools.js): every character outside
 * [A-Za-z0-9_] becomes `_`. A name past 64 characters, or one that collides after this, keeps its first 55 characters
 * plus `_<hash8>` (createMcpToolName): the `mcp__<server>__` prefix survives, but an exact denyTools rule for such a long
 * name never matches, so gate those with a `*` glob.
 */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
}

const EXPOSURES = ["codemode", "deferred", "direct", "hidden"];
/** pi's exposure aliases (core/mcp-servers.js): `codemode-deferred` is `codemode`. */
export const resolveExposure = (v: unknown): unknown => (v === "codemode-deferred" ? "codemode" : v);
const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStringRecord = (v: unknown) => isRecord(v) && Object.values(v).every((e) => typeof e === "string");
const parseUrl = (v: unknown): URL | undefined => (typeof v === "string" && URL.canParse(v) ? new URL(v) : undefined);

function oauthError(o: unknown): string | undefined {
  if (o === undefined) return undefined;
  if (!isRecord(o)) return "oauth must be an object";
  for (const k of ["clientId", "clientSecret", "scope"]) if (o[k] !== undefined && typeof o[k] !== "string") return `oauth.${k} must be a string`;
  const port = o.callbackPort;
  if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) return "oauth.callbackPort must be a port number";
  if (o.callbackUrl !== undefined) {
    const u = parseUrl(o.callbackUrl);
    if (!u || u.protocol !== "http:" || !LOOPBACK.includes(u.hostname) || u.search !== "" || u.hash !== "") return "oauth.callbackUrl must be an http URI on localhost, 127.0.0.1, or [::1] without query or fragment";
    if (u.port && port !== undefined && Number(u.port) !== port) return "oauth.callbackUrl and oauth.callbackPort name different ports";
  }
  if (o.clientName !== undefined && (typeof o.clientName !== "string" || !o.clientName.trim())) return "oauth.clientName must be a non-empty string";
  if (o.authServerMetadataUrl !== undefined) {
    const u = parseUrl(o.authServerMetadataUrl);
    if (!u || !(u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.includes(u.hostname)))) return "oauth.authServerMetadataUrl must be an https URL, or http on localhost, 127.0.0.1, or [::1]";
  }
  return undefined;
}

/**
 * The transport pi connects for an entry, or why pi rejects the whole entry: a port of pi 1.0.0's
 * validateMcpServerConfig (core/mcp-servers.js; tests/mcp.test.ts checks it against the original). A string `url` wins
 * over `command`; `type` must agree with it; `sse` is rejected. pi reports a rejected entry and skips it.
 */
export type McpTransport = { kind: "http"; url: string } | { kind: "stdio"; command: string } | { kind: "invalid"; reason: string };
export function mcpTransport(srv: McpServerConfig, name = "s"): McpTransport {
  const bad = (reason: string): McpTransport => ({ kind: "invalid", reason });
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return bad(`invalid server name "${name}" (use letters, digits, "_" and "-")`);
  if (!isRecord(srv)) return bad("must be an object");
  const raw = srv as Record<string, unknown>;
  const exposure = resolveExposure(raw.exposure);
  if (exposure !== undefined && !EXPOSURES.includes(exposure as string)) return bad(`exposure must be one of ${EXPOSURES.map((e) => `"${e}"`).join(", ")}`);
  if (raw.toolExposure !== undefined) {
    if (!isRecord(raw.toolExposure)) return bad("toolExposure must map tool names to exposures");
    for (const [tool, v] of Object.entries(raw.toolExposure)) if (!EXPOSURES.includes(resolveExposure(v) as string)) return bad(`toolExposure "${tool}" must be one of ${EXPOSURES.map((e) => `"${e}"`).join(", ")}`);
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") return bad("enabled must be a boolean");
  if (raw.description !== undefined && typeof raw.description !== "string") return bad("description must be a string");
  if (raw.timeout !== undefined && (typeof raw.timeout !== "number" || !(raw.timeout > 0))) return bad("timeout must be a positive number of seconds");
  const { type } = raw;
  if (type === "sse") return bad("legacy SSE transport is not supported; use the streamable HTTP URL");
  if (typeof raw.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
    const u = parseUrl(raw.url);
    if (!u || !/^https?:$/.test(u.protocol)) return bad("url must be an http or https URL");
    if (raw.headers !== undefined && !isStringRecord(raw.headers)) return bad("headers must map names to strings");
    const o = oauthError(raw.oauth);
    if (o) return bad(o);
    if (raw.auth !== undefined) {
      if (!isRecord(raw.auth) || typeof raw.auth.provider !== "string" || !raw.auth.provider) return bad("auth.provider must be a provider name");
      if (u.protocol !== "https:" && !LOOPBACK.includes(u.hostname)) return bad("auth requires an https URL, or http on localhost, 127.0.0.1, or [::1]");
    }
    return { kind: "http", url: raw.url };
  }
  if (typeof raw.command === "string" && (type === undefined || type === "stdio")) {
    if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((a) => typeof a === "string"))) return bad("args must be an array of strings");
    if (raw.env !== undefined && !isStringRecord(raw.env)) return bad("env must map names to strings");
    if (raw.cwd !== undefined && typeof raw.cwd !== "string") return bad("cwd must be a string");
    return { kind: "stdio", command: raw.command };
  }
  return bad('needs either "command" (stdio) or "url" (streamable HTTP)');
}

/**
 * The values pi resolves with its config-value grammar (core/resolve-config-value.js) for the transport it picks: `env`
 * for stdio, `headers` and `oauth.clientSecret` for http (pi ignores the other side's fields). `url`, `cwd` and `args`
 * are sent as written (only a leading `~` is expanded).
 */
function configValues(srv: McpServerConfig): string[] {
  const t = mcpTransport(srv);
  const secret = typeof srv.oauth?.clientSecret === "string" ? [srv.oauth.clientSecret] : [];
  const values = t.kind === "stdio" ? Object.values(srv.env ?? {}) : t.kind === "http" ? [...Object.values(srv.headers ?? {}), ...secret] : [];
  return values.filter((v): v is string => typeof v === "string");
}

/**
 * One pi config value parsed the way pi 1.0.0 does (parseConfigValueTemplate): a value starting with `!` is a shell
 * command; otherwise `${NAME}` and `$NAME` are references, `$$` and `$!` escaped literals, and a `${…}` whose inside is
 * not a plain name (`${A:-x}`, `${A B}`) is sent literally.
 */
function parseValue(value: string): { refs: string[]; literalBraces: string[] } {
  const refs: string[] = [];
  const literalBraces: string[] = [];
  if (value.startsWith("!")) return { refs, literalBraces };
  let i = 0;
  while (i < value.length) {
    const d = value.indexOf("$", i);
    if (d < 0) break;
    const next = value[d + 1];
    if (next === "$" || next === "!") {
      i = d + 2;
      continue;
    }
    if (next === "{") {
      const end = value.indexOf("}", d + 2);
      if (end < 0) {
        i = d + 1;
        continue;
      }
      const name = value.slice(d + 2, end);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) refs.push(name);
      else literalBraces.push(value.slice(d, end + 1));
      i = end + 1;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(value.slice(d + 1));
    if (m) {
      refs.push(m[0]);
      i = d + 1 + m[0].length;
    } else i = d + 1;
  }
  return { refs, literalBraces };
}

/** Environment variables a server's config values reference, sorted, deduplicated. */
export function mcpServerEnvRefs(srv: McpServerConfig): string[] {
  return [...new Set(configValues(srv).flatMap((v) => parseValue(v).refs))].sort();
}

/** Every variable any server references, over all servers (disabled ones too: doctor reports what the file asks for). */
export function mcpEnvRefs(cfg: McpConfig): string[] {
  return [...new Set(Object.values(cfg.mcpServers).flatMap(mcpServerEnvRefs))].sort();
}

/** Config values computed by a `!command` when the server connects: unknowable without running it. */
function commandValues(srv: McpServerConfig): boolean {
  return configValues(srv).some((v) => v.startsWith("!"));
}

/** What the retired Bridge understood and pi does not: ignored fields, or syntax pi reads differently. */
const ADAPTER_SERVER_FIELDS: Record<string, string> = {
  disabled: 'use "enabled": false (pi ignores "disabled", so the server would connect)',
  directTools: 'use "exposure": "direct"',
  requestTimeoutMs: 'use "timeout" in seconds',
};
const ADAPTER_SYNTAX = /\$env:(\w+)|\{env:(\w+)\}/g;

/** Config the server entry carries that pi ignores or reads differently (adapter-era fields and syntax, other clients' `${VAR:-x}`), each phrased with its fix. */
export function mcpServerLeftovers(srv: McpServerConfig): string[] {
  const out = Object.entries(ADAPTER_SERVER_FIELDS)
    .filter(([k]) => k in srv)
    .map(([k, fix]) => `has "${k}"; ${fix}`);
  const strings = [...configValues(srv), srv.url, srv.cwd].filter((v): v is string => typeof v === "string");
  const syntax = [...new Set(strings.flatMap((v) => [...v.matchAll(ADAPTER_SYNTAX)].map((m) => [m[0], m[1] ?? m[2]] as const)).map(([w, n]) => `${w} -> \${${n}}`))];
  if (syntax.length) out.push(`uses pi-mcp-adapter syntax ${syntax.join(", ")}`);
  const braces = [...new Set(configValues(srv).flatMap((v) => parseValue(v).literalBraces))];
  if (braces.length) out.push(`has ${braces.join(", ")}, which pi sends literally (only a plain \${NAME} is expanded; no defaults)`);
  const urlRefs = [srv.url, srv.cwd].filter((v): v is string => typeof v === "string" && /\$\{\w+\}/.test(v));
  if (urlRefs.length) out.push("has ${VAR} in url/cwd, which pi sends literally; move the value into headers or env");
  return out;
}

/** Adapter-era leftovers at the top of mcp.json (its `settings` block). */
export function mcpConfigLeftovers(cfg: McpConfig): string[] {
  return "settings" in cfg ? ['has a "settings" block (pi-mcp-adapter only); remove it ("autoEnableCodemode" is the one top-level option pi reads)'] : [];
}

/** Server names pi treats as one (`-` and `_` are the same): pi keeps the first and rejects the rest. Each later name, with the one it collides with. */
export function mcpNameConflicts(cfg: McpConfig): [later: string, first: string][] {
  const seen = new Map<string, string>();
  const out: [string, string][] = [];
  for (const name of Object.keys(cfg.mcpServers)) {
    const key = name.replace(/-/g, "_");
    const first = seen.get(key);
    if (first === undefined) seen.set(key, name);
    else out.push([name, first]);
  }
  return out;
}

/** pi registers OAuth clients as `pi`; any other `oauth.clientName` borrows another client's identity (ADR 0003, 0004). */
export const PI_CLIENT_NAME = "pi";
export function borrowedClientName(srv: McpServerConfig): string | undefined {
  const name = srv.oauth?.clientName;
  return typeof name === "string" && name !== PI_CLIENT_NAME ? name : undefined;
}
/** A pre-registered `oauth.clientId` skips registration: legitimate only for a client the user registered, so doctor asks instead of judging. */
export function preRegisteredClientId(srv: McpServerConfig): string | undefined {
  const id = srv.oauth?.clientId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
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

/** How one environment variable looks to pi: non-empty, empty/unset, or not decidable without running a shell. */
export type VarState = "set" | "empty" | "unknown";
/** How a caller sees the environment: pi reads its own process environment, `pin doctor` a static parse of proxy.env. */
export type EnvView = (name: string) => VarState;
export const processEnvView =
  (env: NodeJS.ProcessEnv): EnvView =>
  (name) => (env[name] ? "set" : "empty");

/**
 * The one verdict on whether an MCP Server can be reached from a pi launched on this account (CONTEXT.md "Server
 * Status"); `pin doctor` and startup-check only phrase it. `target` is the command or url as written (callers redact
 * urls before printing). pi fails a server whose referenced variable is unset, so `env-empty` is unusable; `computed`
 * marks a usable server with a `!command` value, whose outcome only connecting shows.
 */
export type ServerStatus =
  | { usable: true; target: string; refs: string[]; computed: boolean }
  | { usable: false; kind: "disabled" }
  | { usable: false; kind: "placeholder"; command: string }
  | { usable: false; kind: "invalid"; reason: string }
  | { usable: false; kind: "command-unresolved"; command: string }
  | { usable: false; kind: "env-empty"; target: string; vars: string[] }
  | { usable: false; kind: "env-unknown"; target: string; vars: string[] };

export function serverStatus(srv: McpServerConfig, view: { env: EnvView; path?: string }, name?: string): ServerStatus {
  if (srv.enabled === false) return { usable: false, kind: "disabled" };
  if (srv.command === KIMI_CU_PLACEHOLDER && srv.url === undefined) return { usable: false, kind: "placeholder", command: srv.command };
  const t = mcpTransport(srv, name);
  if (t.kind === "invalid") return { usable: false, kind: "invalid", reason: t.reason };
  const target = t.kind === "http" ? t.url : t.command;
  if (t.kind === "stdio" && resolveCommand(t.command, { PATH: view.path }) === undefined) return { usable: false, kind: "command-unresolved", command: t.command };
  const refs = mcpServerEnvRefs(srv);
  const empty = refs.filter((v) => view.env(v) === "empty");
  if (empty.length) return { usable: false, kind: "env-empty", target, vars: empty };
  const unknown = refs.filter((v) => view.env(v) === "unknown");
  if (unknown.length) return { usable: false, kind: "env-unknown", target, vars: unknown };
  return { usable: true, target, refs, computed: commandValues(srv) };
}
