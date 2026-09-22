import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadTemplate, type AdonisPiConfig, type NotifyConfig } from "../../lib/config.ts";
import type { SessionDeps } from "../../lib/session.ts";

type Handler = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

export interface ToolDefinitionLike {
  name: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: any,
  ) => Promise<{ content: { type: string; text?: string }[]; details?: unknown }>;
}

export function createFakePi() {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, ToolDefinitionLike>();
  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerTool(tool: ToolDefinitionLike) {
      tools.set(tool.name, tool);
    },
    registerCommand() {},
    registerShortcut() {},
    sendMessage() {},
    appendEntry() {},
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  async function emit(event: string, payload: object, ctx: object): Promise<unknown> {
    let result: unknown;
    for (const h of handlers.get(event) ?? []) {
      const r = await h({ type: event, ...payload }, ctx);
      if (r !== undefined) result = r;
    }
    return result;
  }
  return { pi: pi as unknown as ExtensionAPI, emit, tools };
}

export function fakeCtx(overrides: Record<string, unknown> = {}) {
  return {
    mode: "tui",
    hasUI: true,
    cwd: "/tmp/fake-project",
    ui: {
      confirm: async () => true,
      select: async () => undefined,
      input: async () => undefined,
      editor: async () => undefined,
      notify: () => {},
      setStatus: () => {},
      custom: async () => null,
    },
    sessionManager: {
      getSessionFile: () => "/tmp/fake-sessions/abc12345-session.jsonl",
      getEntries: () => [],
    },
    ...overrides,
  };
}

/** A Session dependency set with an in-memory spawn adapter and a template config whose notifier is "on". */
export function fakeNotifier(notifyOverrides: Partial<NotifyConfig> = {}, configOverrides: Partial<AdonisPiConfig> = {}) {
  const sent: { args: string[]; payload: Record<string, unknown> }[] = [];
  const config: AdonisPiConfig = { ...loadTemplate(), ...configOverrides };
  config.notify = { ...config.notify, command: "/fake/notifier", ...notifyOverrides };
  const deps: SessionDeps = { loadConfig: () => config, spawn: (_n, args, payload) => sent.push({ args, payload }) };
  return { sent, deps, config };
}
