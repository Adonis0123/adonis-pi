// Config (CONTEXT.md): adonis-pi.json merged over its Template, validated, with `$VAR` values resolved. The one module
// every Extension reads configuration through (ADR 0002 rule 3).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir, expandTilde, TEMPLATE_PATH } from "./layout.ts";

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
