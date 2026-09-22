import { statSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, loadTemplate, type AdonisPiConfig, type NotifyConfig } from "./config.ts";
import { agentDir } from "./layout.ts";
import { buildPayload, decideSettled, sendNotify, sessionRef, type BranchEntry, type SessionRef } from "./notify.ts";

/** What this pi process can do with a human: derived once from ctx, consumed by every Extension. */
export interface Surface {
  /** pi offers dialogs (confirm/select/input): tui and rpc. */
  canPrompt: boolean;
  /** A custom pi-tui panel can be rendered: tui only. */
  canPanel: boolean;
  /** Someone at a terminal should be told via the Notifier: tui only — in rpc another program drives pi and shows its own prompts. */
  canNotify: boolean;
}
export interface SurfaceCtx {
  mode: string;
  hasUI: boolean;
}
export function surface(ctx: SurfaceCtx): Surface {
  return { canPrompt: ctx.hasUI, canPanel: ctx.hasUI && ctx.mode === "tui", canNotify: ctx.mode === "tui" };
}

/** Something an Extension observed. The Session decides whether and how the Notifier hears about it. */
export type Happened =
  | { kind: "question"; questions: { question: string; header?: string }[] }
  | { kind: "permission"; toolName: string; input: Record<string, unknown> }
  | { kind: "settled"; entries: ReadonlyArray<BranchEntry> }
  | { kind: "activity"; toolName: string };

export interface Notification {
  args: string[];
  payload: Record<string, unknown>;
}

/** Pure gating + payload policy. `undefined` means nobody needs to hear about it. */
export function decideNotification(h: Happened, notify: NotifyConfig, ref: SessionRef): Notification | undefined {
  const k = notify.kinds;
  const plain = ["--agent", "pi"];
  switch (h.kind) {
    case "question":
      if (!k.confirm) return undefined;
      return { args: plain, payload: buildPayload("question", ref, { tool_input: { questions: h.questions.map((q) => ({ question: q.question, header: q.header })) } }) };
    case "permission": {
      if (!k.confirm) return undefined;
      return { args: plain, payload: buildPayload("permission", ref, { tool_name: h.toolName, tool_input: permissionSummary(h.input) }) };
    }
    case "settled": {
      const d = decideSettled(h.entries, k);
      if (!d) return undefined;
      if (d.kind === "fail") return { args: plain, payload: buildPayload("fail", ref, { error: d.error, error_details: d.details.slice(0, 500) }) };
      return { args: plain, payload: buildPayload("stop", ref, { last_assistant_message: d.text.slice(-4000) }) };
    }
    case "activity":
      // Activity marks are never gated by kinds: they only tell the notifier the agent is still working.
      return { args: [...plain, "--mark"], payload: buildPayload("mark", ref, { tool_name: h.toolName }) };
  }
}

/** The one field of a gated call worth sending to the Notifier: the shell command, the file path, or the MCP tool name. */
function permissionSummary(input: Record<string, unknown>): Record<string, string> {
  if (typeof input.command === "string") return { command: input.command.slice(0, 200) };
  if (typeof input.path === "string") return { path: input.path };
  if (typeof input.tool === "string") return { tool: input.tool };
  return {};
}

export type Spawn = (notify: NotifyConfig, args: string[], payload: Record<string, unknown>) => void;

export interface Session {
  config: AdonisPiConfig;
  surface: Surface;
  ref: SessionRef;
  /** Report what happened; returns whether the Notifier was invoked. */
  notify(h: Happened): boolean;
}

export interface SessionDeps {
  /** Replace the cached account-config loader (tests). */
  loadConfig?: () => AdonisPiConfig;
  /** Replace the spawn adapter (tests). */
  spawn?: Spawn;
}

export interface SessionCtx extends SurfaceCtx {
  cwd: string;
  sessionManager: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined };
  ui: { notify(msg: string, level: "info" | "warning" | "error"): void };
}

export function createSession(ctx: SessionCtx, config: AdonisPiConfig, spawn: Spawn = sendNotify): Session {
  const s = surface(ctx);
  const ref = sessionRef(ctx);
  return {
    config,
    surface: s,
    ref,
    notify(h) {
      if (!s.canNotify || !config.notify.command) return false;
      const n = decideNotification(h, config.notify, ref);
      if (!n) return false;
      spawn(config.notify, n.args, n.payload);
      return true;
    },
  };
}

/**
 * Config is re-read whenever adonis-pi.json changes on disk (mtime+size), so edits apply at the next event without a
 * restart. A broken file falls back to the template with the Permission Gate forced to `block`: the account's own Deny
 * rules are unreadable, so nothing the default rules catch may slip through on a confirm. Reported once per file version.
 */
function brokenConfigFallback(): AdonisPiConfig {
  const cfg = loadTemplate();
  if (cfg.permissionGate.mode !== "off") cfg.permissionGate.mode = "block";
  return cfg;
}
let cache: { key: string; config: AdonisPiConfig } | undefined;

function cachedConfig(ctx: SessionCtx): AdonisPiConfig {
  const path = join(agentDir(), "adonis-pi.json");
  let key = `${path}:missing`;
  try {
    const st = statSync(path);
    key = `${path}:${st.mtimeMs}:${st.size}`;
  } catch {}
  if (cache?.key === key) return cache.config;
  try {
    cache = { key, config: loadConfig({ path }) };
  } catch (e) {
    cache = { key, config: brokenConfigFallback() };
    const msg = e instanceof ConfigError ? e.message : `adonis-pi config: ${(e as Error).message}`;
    if (surface(ctx).canPrompt) ctx.ui.notify(`${msg} — using template defaults; permission gate blocks every hit until the file is fixed`, "warning");
  }
  return cache.config;
}

export function getSession(ctx: SessionCtx, deps: SessionDeps = {}): Session {
  const config = deps.loadConfig ? deps.loadConfig() : cachedConfig(ctx);
  return createSession(ctx, config, deps.spawn);
}
