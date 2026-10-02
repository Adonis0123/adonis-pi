// Account Layer layout and the Repo Layer constants every other module agrees on (ADR 0002). No I/O beyond path math.
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** The agent dir of the account this pi process runs as: $PI_CODING_AGENT_DIR, else account 1. */
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
export type TemplatedFile = (typeof TEMPLATED_FILES)[number];

export const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
export const TEMPLATE_PATH = join(TEMPLATES_DIR, "adonis-pi.json");

/** The retired third-party MCP Bridge (ADR 0003, superseded by ADR 0004): installed, it replaces pi's built-in MCP Client, so `pin doctor` fails on it. */
export const MCP_ADAPTER_NAME = "pi-mcp-adapter";
/** The `extensions` entry that turns pi's built-in MCP Client off. */
export const BUILTIN_MCP_OFF = "-builtin:mcp";
/** The oldest pi whose built-in MCP Client has everything the Template uses (exposure, timeout, oauth.clientName). */
export const PI_MIN_VERSION = "0.99.2";
export const PI_TESTED_MINOR = "1.0.";

/** Placeholder in templates/mcp.json for the KimiCU executable; `pin setup` replaces it (the Repo Layer holds no machine paths). */
export const KIMI_CU_PLACEHOLDER = "{{KIMI_CU_BIN}}";
