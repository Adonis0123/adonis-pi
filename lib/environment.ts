// This machine as the Launcher sees it: a static reading of the Secret Layer (proxy.env) and where KimiCU lives.
// Launcher-only (ADR 0002 rule 3): nothing under extensions/ or lib/session.ts imports this module; tests/scaffold.test.ts checks.
import { expandTilde } from "./layout.ts";
import { type EnvView, isExecutableFile, resolveCommand, type VarState } from "./mcp.ts";

const KIMI_CU_CANDIDATES = ["/Applications/KimiCU.app/Contents/MacOS/kimi-cu", "~/Applications/KimiCU.app/Contents/MacOS/kimi-cu"];

/** Where the KimiCU MCP executable lives on this machine: $ADONIS_PI_KIMI_CU_BIN when set (authoritative), else the app bundle, else PATH. */
export function resolveKimiCuBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.ADONIS_PI_KIMI_CU_BIN;
  if (override !== undefined) return isExecutableFile(expandTilde(override)) ? expandTilde(override) : undefined;
  for (const c of KIMI_CU_CANDIDATES) if (isExecutableFile(expandTilde(c))) return expandTilde(c);
  return resolveCommand("kimi-cu", env);
}

/**
 * What `. proxy.env` in bin/pin leaves for pi, judged statically per exported variable: "set" (non-empty literal),
 * "empty", or "unknown" when the value needs shell evaluation ($VAR other than $HOME) that this parser will not run.
 * Recognised lines: blank, `# comment`, `[export] NAME=word [# comment]` (quotes, backslashes, a later plain `NAME=`
 * re-assignment keep their shell meaning; a `#` inside the word is literal), and `unset NAME…`. Any other line — a
 * second command after `;`, `if`/`source`, `export A B`, a quote that runs past the line end — could change any
 * variable, so the whole result degrades to "unknown" rather than report a confident wrong state. Variables assigned
 * but never exported are not inherited by pi and are left out. tests/environment.test.ts checks every verdict against
 * a real `sh` sourcing the same text.
 */
export interface ProxyEnv {
  /** Exported variables with a state; names absent here were never exported (or were unset). */
  state: Map<string, VarState>;
  /** False when a line could not be parsed, in which case every state above has already been degraded to "unknown" and absent names must be read as "unknown" too. */
  certain: boolean;
}
/** The state of one variable as pi will see it: absent = "empty" in a fully parsed file, "unknown" otherwise. */
export function proxyEnvLookup(env: ProxyEnv, name: string): VarState {
  return env.state.get(name) ?? (env.certain ? "empty" : "unknown");
}
/** A parsed proxy.env as the environment view `serverStatus` takes. */
export const proxyEnvView =
  (parsed: ProxyEnv): EnvView =>
  (name) => proxyEnvLookup(parsed, name);

export function proxyEnvState(text: string): ProxyEnv {
  const exported = new Set<string>();
  const state = new Map<string, VarState>();
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
function shellWord(rest: string, homeKnown = true): VarState | undefined {
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
