import { isAbsolute, resolve } from "node:path";
import { expandTilde, type PermissionGateConfig } from "../../lib/config.ts";

export function globToRegExp(glob: string): RegExp {
  const expanded = expandTilde(glob);
  let re = "";
  for (let i = 0; i < expanded.length; i++) {
    const c = expanded[i];
    if (c === "*") {
      if (expanded[i + 1] === "*") {
        re += ".*";
        i++;
        if (expanded[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

const PATH_TOOLS = new Set(["write", "edit"]);
const SEPARATOR = /\r?\n|;|&&|\|\||\|/;
const SHELL_C = /\b(?:ba|z|da)?sh\s+-[a-zA-Z]*c[a-zA-Z]*\s+(['"])([\s\S]*?)\1/g;

/**
 * Split a command into the pieces a deny rule should see: each separated command, plus the body of
 * any `sh -c '…'` wrapper (recursively). Wrapper bodies are masked before splitting so a `|` inside
 * the quotes does not break the quoted text; the outer pieces keep their original wording.
 */
export function segments(command: string): string[] {
  const out: string[] = [];
  const wrappers: { token: string; original: string; body: string }[] = [];
  const masked = command.replace(SHELL_C, (original, _quote: string, body: string) => {
    const token = `\u0000${wrappers.length}\u0000`;
    wrappers.push({ token, original, body });
    return token;
  });
  for (const part of masked.split(SEPARATOR)) {
    if (part.trim().length === 0) continue;
    let text = part;
    for (const w of wrappers) text = text.replace(w.token, w.original);
    out.push(text);
  }
  for (const w of wrappers) out.push(...segments(w.body));
  return out;
}

export function matchToolCall(
  event: { toolName: string; input: Record<string, unknown> },
  cfg: PermissionGateConfig,
  cwd: string,
): { reason: string; detail: string } | undefined {
  if (event.toolName === "bash") {
    const command = typeof event.input.command === "string" ? event.input.command : "";
    const pieces = segments(command);
    for (const pattern of cfg.denyCommands) {
      const re = new RegExp(pattern);
      const hit = pieces.find((piece) => re.test(piece));
      if (hit !== undefined) {
        return { reason: `command matches denyCommands /${pattern}/`, detail: hit.trim() };
      }
    }
    return undefined;
  }
  if (PATH_TOOLS.has(event.toolName)) {
    const raw = typeof event.input.path === "string" ? event.input.path : typeof event.input.file_path === "string" ? event.input.file_path : "";
    if (!raw) return undefined;
    const expanded = expandTilde(raw);
    const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
    for (const glob of cfg.protectedPaths) {
      if (globToRegExp(glob).test(abs)) {
        return { reason: `path matches protectedPaths ${glob}`, detail: abs };
      }
    }
  }
  return undefined;
}
