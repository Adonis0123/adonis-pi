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
// `&&` and `||` must precede `&` and `|`; `$(` must precede `(`. Braces are not separators so `${HOME}` stays whole.
const SEPARATOR = /\r?\n|;|&&|\|\||\||&|\$\(|\(|\)/;
// Shell keywords that may precede a command inside one segment: `if x; then sudo y; fi`, `time sudo y`.
const LEADING_KEYWORDS = /^(\s*)(?:(?:if|then|else|elif|do|while|until|time|!)\s+)+/;
const SHELL_C = /\b(?:ba|z|da)?sh\s+-[a-zA-Z]*c[a-zA-Z]*\s+(['"])([\s\S]*?)\1/g;

/**
 * Split a command into the pieces a deny rule should see: each separated command (also inside
 * subshells and `$(…)`), with leading shell keywords removed, plus the body of any `sh -c '…'`
 * wrapper (recursively). Wrapper bodies are masked before splitting so a `|` inside the quotes does
 * not break the quoted text; the outer pieces keep their original wording.
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
    let text = part.replace(LEADING_KEYWORDS, "$1");
    if (text.trim().length === 0) continue;
    for (const w of wrappers) text = text.replace(w.token, w.original);
    out.push(text);
  }
  for (const w of wrappers) out.push(...segments(w.body));
  return out;
}

/** pi's own tools and this package's: everything else reaching the gate came from an Extension, i.e. the MCP Bridge. */
const NATIVE_TOOLS = new Set(["bash", "powershell", "read", "write", "edit", "find", "grep", "ls", "AskUserQuestion"]);
/** The `mcp` meta-tool of the MCP Bridge carries the real target in its `tool` argument; `mcpScript` is disabled in the Template (scriptMode false). */
const PROXY_TOOLS = new Set(["mcp"]);

/**
 * The MCP tool a call targets, as `<server>_<tool>`: a direct tool is called by that name; a proxy call names it in
 * `input.tool`. A proxy call without `tool` (search / describe / connect) is matched as the meta-tool itself (`mcp`),
 * so a rule literally named `mcp` gates every Bridge operation; the shipped defaults never match it.
 */
function mcpTarget(event: { toolName: string; input: Record<string, unknown> }): { name: string; args: unknown } | undefined {
  if (PROXY_TOOLS.has(event.toolName)) {
    return typeof event.input.tool === "string" ? { name: event.input.tool, args: event.input.args } : { name: event.toolName, args: event.input };
  }
  if (NATIVE_TOOLS.has(event.toolName)) return undefined;
  return { name: event.toolName, args: event.input };
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
  const mcp = mcpTarget(event);
  if (mcp) {
    for (const glob of cfg.denyTools) {
      if (globToRegExp(glob).test(mcp.name)) {
        return { reason: `MCP tool matches denyTools ${glob}`, detail: `${mcp.name} ${JSON.stringify(mcp.args ?? {}).slice(0, 200)}` };
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
