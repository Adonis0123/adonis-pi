import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface PermissionGateConfig {
  /** ask = confirm in the UI (block without one); block = always block; off = the gate does nothing (pi's native, no-prompt behaviour). */
  mode: "ask" | "block" | "off";
  denyCommands: string[];
  protectedPaths: string[];
  /** Globs on MCP tool names as the MCP Bridge registers them (`<server>_<tool>`): direct tools by their own name, proxy calls by the `tool` argument of the `mcp` meta-tool. */
  denyTools: string[];
}
export interface NotifyConfig {
  command: string | undefined;
  kinds: { confirm: boolean; fail: boolean; idle: boolean };
  idleDelaySeconds: number;
}
export interface AdonisPiConfig {
  agentsMd: string;
  permissionGate: PermissionGateConfig;
  notify: NotifyConfig;
  askUserQuestion: { enabled: boolean };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`adonis-pi config: ${message}`);
    this.name = "ConfigError";
  }
}

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.PI_CODING_AGENT_DIR;
  return v ? expandTilde(v) : join(homedir(), ".pi", "agent");
}

/** Account Layer layout (CONTEXT.md "Family"): account 1 is ~/.pi, account n>=2 is ~/.pi-00n; pi reads the agent/ subdir. */
export function accountAgentDir(n: number, home: string = homedir()): string {
  const family = n === 1 ? ".pi" : `.pi-${String(n).padStart(3, "0")}`;
  return join(home, family, "agent");
}

/** Account Layer files that have a Template in this repo (ADR 0002 rule 2). */
export const TEMPLATED_FILES = ["settings.json", "models.json", "adonis-pi.json", "mcp.json"] as const;

/** The MCP Bridge (ADR 0003), pinned: `pi update --all` skips versioned specs, so upgrades are a Template change reported by `pin doctor`. */
export const MCP_ADAPTER_NAME = "pi-mcp-adapter";
export const MCP_ADAPTER_VERSION = "2.36.0";
export const MCP_ADAPTER_PACKAGE = `npm:${MCP_ADAPTER_NAME}@${MCP_ADAPTER_VERSION}`;

/** Placeholder in templates/mcp.json for the KimiCU executable; `pin setup` replaces it (the Repo Layer holds no machine paths). */
export const KIMI_CU_PLACEHOLDER = "{{KIMI_CU_BIN}}";
const KIMI_CU_CANDIDATES = ["/Applications/KimiCU.app/Contents/MacOS/kimi-cu", "~/Applications/KimiCU.app/Contents/MacOS/kimi-cu"];

/** Where the KimiCU MCP executable lives on this machine: $ADONIS_PI_KIMI_CU_BIN when set (authoritative), else the app bundle, else PATH. */
export function resolveKimiCuBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.ADONIS_PI_KIMI_CU_BIN;
  if (override !== undefined) return isExecutableFile(expandTilde(override)) ? expandTilde(override) : undefined;
  for (const c of KIMI_CU_CANDIDATES) if (isExecutableFile(expandTilde(c))) return expandTilde(c);
  return resolveCommand("kimi-cu", env);
}

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

/** Bare "$VAR" values the Bridge would NOT expand: a config mistake doctor and startup-check must flag instead of counting as a reference. */
export function mcpBareRefs(srv: McpServerConfig): string[] {
  return [...new Set(mcpStrings(srv).map((v) => BARE_REF.exec(v)?.[1]).filter((v): v is string => v !== undefined))].sort();
}

/** Every variable any server references, over all servers (disabled ones too: doctor reports what the file asks for). */
export function mcpEnvRefs(cfg: McpConfig): string[] {
  return [...new Set(Object.values(cfg.mcpServers).flatMap(mcpServerEnvRefs))].sort();
}

/**
 * What `. proxy.env` in bin/pin leaves for pi, judged statically per exported variable: "set" (non-empty literal),
 * "empty", or "unknown" when the value needs shell evaluation ($VAR other than $HOME) that this parser will not run. Recognised lines: blank, `# comment`, `[export] NAME=word [# comment]` (quotes, backslashes, a later
 * plain `NAME=` re-assignment keep their shell meaning; a `#` inside the word is literal), and `unset NAME…`. Any other
 * line — a second command after `;`, `if`/`source`, `export A B`, a quote that runs past the line end — could change any
 * variable, so the whole result degrades to "unknown" rather than report a confident wrong state. Variables assigned
 * but never exported are not inherited by pi and are left out.
 */
export type ProxyEnvState = "set" | "empty" | "unknown";
export interface ProxyEnv {
  /** Exported variables with a state; names absent here were never exported (or were unset). */
  state: Map<string, ProxyEnvState>;
  /** False when a line could not be parsed, in which case every state above has already been degraded to "unknown" and absent names must be read as "unknown" too. */
  certain: boolean;
}
/** The state of one variable as pi will see it: absent = "empty" in a fully parsed file, "unknown" otherwise. */
export function proxyEnvLookup(env: ProxyEnv, name: string): ProxyEnvState {
  return env.state.get(name) ?? (env.certain ? "empty" : "unknown");
}
export function proxyEnvState(text: string): ProxyEnv {
  const exported = new Set<string>();
  const state = new Map<string, ProxyEnvState>();
  let certain = true;
  // $HOME counts as a known non-empty value only while the file itself has not touched HOME.
  let homeKnown = true;
  if (text.includes("\r")) certain = false; // CRLF: the shell keeps \r as part of every value, so nothing here means what it looks like
  for (const raw of text.split("\n")) {
    // Only ASCII blanks are shell whitespace; String.trim() would also strip U+00A0 or \v, which the shell keeps as value.
    const line = raw.replace(/^[ \t]+|[ \t]+$/g, "");
    if (line === "" || line.startsWith("#")) continue;
    if (line.endsWith("\\")) {
      certain = false; // a continuation line: the statement spans lines
      continue;
    }
    const un = /^unset\s+(.+)$/.exec(line);
    if (un) {
      const names = un[1].split(/\s+/);
      if (names.every((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) {
        for (const n of names) {
          exported.delete(n);
          state.delete(n);
          if (n === "HOME") homeKnown = false;
        }
        continue;
      }
      certain = false;
      continue;
    }
    const m = /^(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) {
      certain = false;
      continue;
    }
    const [, exp, name, rest] = m;
    if (name === "HOME") homeKnown = false;
    const word = shellWord(rest, homeKnown);
    if (word === undefined) {
      certain = false;
      continue;
    }
    if (exp) exported.add(name);
    state.set(name, word);
  }
  const out = new Map([...state].filter(([name]) => exported.has(name)));
  if (!certain) for (const name of out.keys()) out.set(name, "unknown");
  return { state: out, certain };
}

/**
 * Classify one shell word (the right-hand side of an assignment) without evaluating it. Returns undefined when the
 * line holds more than that word (another command after `;`/`&&`, a redirection, an unterminated quote continuing on
 * the next line) or when an expansion could assign to some other variable (`${X:=word}`, `${X=word}`).
 */
function shellWord(rest: string, homeKnown = true): ProxyEnvState | undefined {
  if (/\$\{[A-Za-z_][A-Za-z0-9_]*:?=/.test(rest)) return undefined; // assigning expansion: side effect on another name
  if (/\$\(|`/.test(rest)) return undefined; // command or arithmetic substitution: may run anything or assign ($((A=1)))
  let value = "";
  let dynamic = false;
  let quote: '"' | "'" | undefined;
  let i = 0;
  const dollar = (): void => {
    // $HOME / ${HOME} comes from the login shell pin runs in, so it is a known non-empty value; anything else needs evaluation.
    const m = homeKnown ? /^\$(HOME\b|\{HOME\})/.exec(rest.slice(i)) : null;
    if (m) {
      value += "~";
      i += m[0].length - 1;
    } else dynamic = true;
  };
  for (; i < rest.length; i++) {
    const c = rest[i];
    if (quote === "'") {
      if (c === "'") quote = undefined;
      else value += c;
    } else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "\\" && i + 1 < rest.length) value += rest[++i];
      else if (c === "$") dollar();
      else value += c;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "\\" && i + 1 < rest.length) value += rest[++i];
    else if (c === " " || c === "\t") break; // unquoted whitespace ends the word
    else if (c === ";" || c === "&" || c === "|" || c === "<" || c === ">") return undefined; // another command or a redirection follows: not a simple assignment line
    else if (c === "$") dollar();
    else value += c;
  }
  if (quote) return undefined; // the value continues on the next line
  const tail = rest.slice(i).replace(/^[ \t]+|[ \t]+$/g, "");
  if (tail !== "" && !tail.startsWith("#")) return undefined; // something other than a comment after the word
  if (dynamic) return "unknown";
  return value.length > 0 ? "set" : "empty";
}

function isExecutableFile(p: string): boolean {
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
export interface McpConfig {
  settings?: Record<string, unknown>;
  mcpServers: Record<string, McpServerConfig>;
}

/** How a caller sees one environment variable: `pin doctor` reads it off a static parse of proxy.env, pi reads its own process environment. */
export type EnvView = (name: string) => ProxyEnvState;
export const processEnvView =
  (env: NodeJS.ProcessEnv): EnvView =>
  (name) => (env[name] ? "set" : "empty");
export const proxyEnvView =
  (parsed: ProxyEnv): EnvView =>
  (name) => proxyEnvLookup(parsed, name);

/**
 * The one verdict on whether an MCP Server can be reached from a pi launched on this account; `pin doctor` and
 * startup-check only phrase it. `target` is the command or url as written (callers redact urls before printing).
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
/** Read an mcp.json (Template or Account). Throws on malformed JSON or a missing mcpServers object. */
export function readMcpConfig(path: string): McpConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!isObject(raw) || !isObject(raw.mcpServers)) throw new ConfigError(`${path} must contain an mcpServers object`);
  return raw as unknown as McpConfig;
}

/** Environment variables a JSON document references as whole-string "$VAR" / "${VAR}" values (keys such as "$schema" do not count), sorted, deduplicated. */
export function envRefs(jsonText: string): string[] {
  let doc: unknown;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const found = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      const m = ENV_REF.exec(v);
      if (m) found.add(m[1]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (isObject(v)) Object.values(v).forEach(walk);
  };
  walk(doc);
  return [...found].sort();
}

export function missingEnvRefs(jsonText: string, env: NodeJS.ProcessEnv): string[] {
  return envRefs(jsonText).filter((v) => !env[v]);
}

/**
 * Env vars the *effective* Config references: the account file merged over the template exactly as loadConfig does,
 * so a template default such as notify.command "$ADONIS_PI_NOTIFY_CMD" counts until the account overrides it.
 * An unreadable account file counts as absent (loadConfig will fall back to the template too).
 */
export function configEnvRefs(path: string): string[] {
  const template = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8")) as Json;
  let merged: Json = template;
  if (existsSync(path)) {
    try {
      const account = JSON.parse(readFileSync(path, "utf8"));
      if (isObject(account)) merged = deepMerge(template, account);
    } catch {}
  }
  return envRefs(JSON.stringify(merged));
}

const ENV_REF = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

export function resolveEnvRef(value: unknown, env: NodeJS.ProcessEnv = process.env): unknown {
  if (typeof value !== "string") return value;
  const m = ENV_REF.exec(value);
  if (!m) return value;
  return env[m[1]];
}

export const TEMPLATE_PATH = fileURLToPath(new URL("../templates/adonis-pi.json", import.meta.url));
export const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

export function loadTemplate(): AdonisPiConfig {
  const raw = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"));
  delete raw.$schema;
  return raw as AdonisPiConfig;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Objects merge key by key; arrays extend the template (account entries are appended, duplicates dropped); scalars replace. */
function deepMerge(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (isObject(v) && isObject(base[k])) out[k] = deepMerge(base[k] as Json, v);
    else if (Array.isArray(v) && Array.isArray(base[k])) out[k] = [...(base[k] as unknown[]), ...v.filter((x) => !(base[k] as unknown[]).includes(x))];
    else out[k] = v;
  }
  return out;
}

/** Every key at every depth must exist in the template, so a typo never silently falls back to a default. */
function rejectUnknownKeys(template: Json, raw: Json, prefix = ""): void {
  for (const k of Object.keys(raw)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (!(k in template)) throw new ConfigError(`unknown key "${path}"`);
    if (isObject(template[k]) && isObject(raw[k])) rejectUnknownKeys(template[k] as Json, raw[k] as Json, path);
  }
}

function expectType(path: string, value: unknown, type: "string" | "boolean" | "number" | "string[]"): void {
  const ok =
    type === "string[]"
      ? Array.isArray(value) && value.every((x) => typeof x === "string")
      : typeof value === type;
  if (!ok) throw new ConfigError(`${path} must be ${type}`);
}

function validate(raw: Json, template: Json): asserts raw is Json & AdonisPiConfig {
  rejectUnknownKeys(template, raw);
  expectType("agentsMd", raw.agentsMd, "string");
  const pg = raw.permissionGate as Json;
  if (!isObject(pg)) throw new ConfigError("permissionGate must be an object");
  if (pg.mode !== "ask" && pg.mode !== "block" && pg.mode !== "off") throw new ConfigError('permissionGate.mode must be "ask", "block" or "off"');
  expectType("permissionGate.denyCommands", pg.denyCommands, "string[]");
  expectType("permissionGate.protectedPaths", pg.protectedPaths, "string[]");
  expectType("permissionGate.denyTools", pg.denyTools, "string[]");
  for (const re of pg.denyCommands as string[]) {
    try {
      new RegExp(re);
    } catch {
      throw new ConfigError(`permissionGate.denyCommands contains an invalid regex: ${re}`);
    }
  }
  const n = raw.notify as Json;
  if (!isObject(n)) throw new ConfigError("notify must be an object");
  if (n.command !== undefined) expectType("notify.command", n.command, "string");
  const kinds = n.kinds as Json;
  if (!isObject(kinds)) throw new ConfigError("notify.kinds must be an object");
  for (const k of ["confirm", "fail", "idle"]) expectType(`notify.kinds.${k}`, kinds[k], "boolean");
  if (kinds.idle === true && kinds.confirm !== true) throw new ConfigError("notify.kinds.idle requires notify.kinds.confirm (the notifier decides confirm-vs-idle from the same Stop event)");
  expectType("notify.idleDelaySeconds", n.idleDelaySeconds, "number");
  if (!Number.isInteger(n.idleDelaySeconds) || (n.idleDelaySeconds as number) < 0) throw new ConfigError("notify.idleDelaySeconds must be an integer >= 0");
  const aq = raw.askUserQuestion as Json;
  if (!isObject(aq)) throw new ConfigError("askUserQuestion must be an object");
  expectType("askUserQuestion.enabled", aq.enabled, "boolean");
}

export function loadConfig(opts: { path?: string; env?: NodeJS.ProcessEnv } = {}): AdonisPiConfig {
  const env = opts.env ?? process.env;
  const path = opts.path ?? join(agentDir(env), "adonis-pi.json");
  const template = loadTemplate() as unknown as Json;
  let merged: Json = template;
  if (existsSync(path)) {
    let account: unknown;
    try {
      account = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw new ConfigError(`${path} is not valid JSON (${(e as Error).message})`);
    }
    if (!isObject(account)) throw new ConfigError(`${path} must contain a JSON object`);
    delete account.$schema;
    merged = deepMerge(template, account);
  }
  validate(merged, template);
  const cfg = merged as AdonisPiConfig;
  const command = resolveEnvRef(cfg.notify.command, env);
  cfg.notify.command = typeof command === "string" && command.length > 0 ? expandTilde(command) : undefined;
  const agentsMd = resolveEnvRef(cfg.agentsMd, env);
  cfg.agentsMd = typeof agentsMd === "string" ? expandTilde(agentsMd) : "";
  return cfg;
}
