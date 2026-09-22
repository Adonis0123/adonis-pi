import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { NotifyConfig } from "./config.ts";

export interface SessionRef {
  sessionId: string;
  cwd: string;
}

export type PayloadKind = "question" | "permission" | "fail" | "stop" | "mark";

const EVENT_NAME: Record<PayloadKind, string> = {
  question: "PreToolUse",
  permission: "PermissionRequest",
  fail: "StopFailure",
  stop: "Stop",
  mark: "PostToolUse",
};

export function sessionRef(ctx: {
  cwd: string;
  sessionManager: { getSessionId?: () => string | undefined; getSessionFile?: () => string | undefined };
}): SessionRef {
  const id = ctx.sessionManager.getSessionId?.();
  if (id) return { sessionId: id, cwd: ctx.cwd };
  const file = ctx.sessionManager.getSessionFile?.();
  const sessionId = file ? basename(file).replace(/\.jsonl$/, "") : "nosession";
  return { sessionId, cwd: ctx.cwd };
}

const SECRET_KEY = /(_API_KEY|_AUTH_TOKEN)$|^(ANTHROPIC|OPENAI)_/;

export function filterEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_KEY.test(k)) out[k] = v;
  return out;
}

export function buildPayload(kind: PayloadKind, ref: SessionRef, extra: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = { hook_event_name: EVENT_NAME[kind], session_id: ref.sessionId, cwd: ref.cwd };
  if (kind === "question") base.tool_name = "AskUserQuestion";
  return { ...base, ...extra };
}

export function classifyError(message: string): "authentication_failed" | "billing_error" | "model_not_found" | undefined {
  const m = message.toLowerCase();
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|authentication|invalid[ _]api[ _]key/.test(m)) return "authentication_failed";
  if (/\b402\b|insufficient|quota|billing|balance|payment/.test(m)) return "billing_error";
  if (/model\b.*\b(not found|does not exist|not exist|unknown)|\b404\b.*model/.test(m)) return "model_not_found";
  return undefined;
}

interface MessageLike {
  role: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
}

export function lastAssistantText(messages: ReadonlyArray<MessageLike>): { text: string; stopReason?: string; errorMessage?: string } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const blocks = Array.isArray(m.content) ? (m.content as { type?: string; text?: string }[]) : [];
    const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("\n");
    return { text, stopReason: m.stopReason, errorMessage: m.errorMessage };
  }
  return undefined;
}

export function sendNotify(
  notify: NotifyConfig,
  args: string[],
  payload: Record<string, unknown>,
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): boolean {
  if (!notify.command) return false;
  const env = {
    ...filterEnv(opts.env ?? process.env),
    AGENT_ATTENTION_IDLE: notify.kinds.idle ? "1" : "0",
    AGENT_ATTENTION_IDLE_DELAY: String(notify.idleDelaySeconds),
  };
  try {
    const child = spawn(notify.command, args, { stdio: ["pipe", "ignore", "ignore"], detached: true, env });
    child.on("error", () => {});
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, opts.timeoutMs ?? 10_000);
    child.on("exit", () => clearTimeout(timer));
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(payload));
    child.unref();
  } catch {
    // Never let a notifier failure reach the agent loop.
  }
  return true;
}
