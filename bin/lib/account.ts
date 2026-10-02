// Account Layer maintenance for `pin` (ADR 0002). Run directly by Node ≥ 22.18 (type stripping):
//   account.ts dir <n>                 print the agent dir of account n
//   account.ts setup <n> <pinRoot>     materialise templates (never overwrites), register the package, link AGENTS.md
//   account.ts doctor <n> <pinRoot>    OK/WARN/FAIL report; exit 1 on any FAIL
//   account.ts vars <agentDir>         env var names the account references or its proxy.env exports (for pin --dry-run)
// doctor is `inspectAccount` (structured Findings, what tests call) plus one line of rendering; only the CLI prints.
// Layout, Template list, `$VAR` grammar, adapter leftovers and the Server Status verdict come from lib/, so the launcher and
// the extensions agree. MCP is pi's built-in MCP Client (ADR 0004); doctor stays static and never runs `pi mcp list`.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../lib/config.ts";
import { type ProxyEnv, proxyEnvState, proxyEnvView, resolveKimiCuBin } from "../../lib/environment.ts";
import { accountAgentDir, BUILTIN_MCP_OFF, expandTilde, KIMI_CU_PLACEHOLDER, MCP_ADAPTER_NAME, PI_MIN_VERSION, PI_TESTED_MINOR, TEMPLATED_FILES, TEMPLATES_DIR } from "../../lib/layout.ts";
import { borrowedClientName, mcpConfigLeftovers, mcpNameConflicts, mcpServerLeftovers, preRegisteredClientId, readMcpConfig, resolveCommand, serverStatus } from "../../lib/mcp.ts";
import { accountRefs } from "../../lib/refs.ts";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const readJson = (p: string): Json => JSON.parse(readFileSync(p, "utf8"));

/**
 * Template keys the account file lacks (a template update the account has not adopted). Extra account keys are not
 * drift: pi and the user legitimately add their own (theme, defaultModel, skills, lastChangelogVersion…).
 */
function drift(template: Json, account: Json, prefix = ""): string[] {
  const out: string[] = [];
  for (const k of Object.keys(template)) {
    if (k === "$schema" || k === "packages") continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (!(k in account)) out.push(`missing ${path}`);
    else if (isObj(template[k]) && isObj(account[k])) out.push(...drift(template[k], account[k], path));
  }
  return out;
}

/**
 * Files setup copies verbatim. adonis-pi.json is different: it is merged over the template at runtime, so the account
 * keeps only overrides. mcp.json is copied with the KimiCU placeholder resolved to this machine's executable.
 */
const COPIED_FILES = TEMPLATED_FILES.filter((f) => f !== "adonis-pi.json" && f !== "mcp.json");

/** Template mcp.json with the placeholder replaced; unresolved when KimiCU is not installed (doctor reports it). */
function renderMcpTemplate(env: NodeJS.ProcessEnv = process.env): { text: string; kimiCuBin: string | undefined } {
  const text = readFileSync(join(TEMPLATES_DIR, "mcp.json"), "utf8");
  const kimiCuBin = resolveKimiCuBin(env);
  return { text: kimiCuBin ? text.replaceAll(JSON.stringify(KIMI_CU_PLACEHOLDER), JSON.stringify(kimiCuBin)) : text, kimiCuBin };
}

function describeUnresolved(command: string): string {
  if (command.length === 0) return "is empty";
  if (command.includes("/")) return "is not an executable file";
  return "is not an executable on PATH";
}

/** A URL for log lines: scheme, host and path only, so embedded credentials or tokens in the query never reach the terminal. */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search || u.username || u.password ? " (credentials/query hidden)" : ""}`;
  } catch {
    return "(unparseable url)";
  }
}

/** Where an earlier `pi install` left the retired pi-mcp-adapter under <agentDir>/npm, or undefined. */
function installedAdapter(agentDir: string): string | undefined {
  const dir = join(agentDir, "npm", "node_modules", MCP_ADAPTER_NAME);
  return existsSync(dir) ? dir : undefined;
}

/** The `npm:pi-mcp-adapter…` entries in settings.json packages (any version). */
function adapterEntries(packages: string[]): string[] {
  return packages.filter((p) => p === `npm:${MCP_ADAPTER_NAME}` || p.startsWith(`npm:${MCP_ADAPTER_NAME}@`));
}

const stringsAt = (j: Json, key: string): string[] => (Array.isArray(j[key]) ? (j[key] as unknown[]).filter((v): v is string => typeof v === "string") : []);
/** settings.json `packages` sources: pi loads a string entry and an object entry's `source` alike (core/package-manager.js). */
const packageSources = (j: Json): string[] =>
  Array.isArray(j.packages) ? (j.packages as unknown[]).flatMap((v) => (typeof v === "string" ? [v] : isObj(v) && typeof v.source === "string" ? [v.source] : [])) : [];

/** A minimatch-style glob (`*`, `?`, `{a,b}`, `[…]`) as a whole-string RegExp; enough for matching the one name `builtin:mcp`. */
function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end < 0) re += "\\[";
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, "^")}]`;
        i = end;
      }
    } else if (c === "{") {
      const end = glob.indexOf("}", i + 1);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${glob.slice(i + 1, end).split(",").map((alt) => alt.replace(/[.+^$()|\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * Whether the user `extensions` setting leaves pi's built-in MCP Client on, as pi 1.0.0 decides it
 * (core/package-manager.js isEnabledByOverrides): `!glob` excludes by pattern, then `+builtin:mcp` forces it on, then
 * `-builtin:mcp` forces it off. Returns the entries that turn it off, or [] when it stays on. A project-level
 * `.pi/settings.json` can override this per project; doctor does not read projects.
 */
export function builtinMcpOffBy(extensions: string[]): string[] {
  const name = "builtin:mcp";
  const excl = extensions.filter((e) => e.startsWith("!") && globRe(e.slice(1)).test(name));
  const forceOn = extensions.includes(`+${name}`);
  const forceOff = extensions.filter((e) => e === BUILTIN_MCP_OFF);
  if (forceOff.length) return forceOff;
  return forceOn ? [] : excl;
}

/** -1, 0 or 1 comparing two `major.minor.patch` versions numerically (no prerelease tags: doctor only reads `\d+.\d+.\d+`). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1;
  return 0;
}

/** Add `pkg` to settings.json `packages`, keeping the file's indentation and other keys. */
function addPackage(settingsPath: string, pkg: string): "present" | "added" {
  const text = readFileSync(settingsPath, "utf8");
  const json = readJson(settingsPath);
  const packages = Array.isArray(json.packages) ? (json.packages as string[]) : [];
  if (packages.includes(pkg)) return "present";
  json.packages = [...packages, pkg];
  const indent = /^\n?([ \t]+)"/m.exec(text)?.[1] ?? "  ";
  writeFileSync(settingsPath, JSON.stringify(json, null, indent) + (text.endsWith("\n") ? "\n" : ""));
  return "added";
}

/**
 * Variable names `pin --dry-run` reports as set/unset (names only, never values): every `$VAR` the account's files
 * reference plus every variable its proxy.env exports (built-in pi providers such as kimi-coding read their key from
 * the environment without any file naming it). Names an unparseable proxy.env line exports are not seen.
 */
function accountVars(dir: string): string[] {
  const proxy = join(dir, "proxy.env");
  const exported = existsSync(proxy) ? [...proxyEnvState(readFileSync(proxy, "utf8")).state.keys()] : [];
  return [...new Set([...accountRefs(dir).map((r) => r.name), ...exported])];
}

function setup(n: number, pinRoot: string): void {
  const d = accountAgentDir(n);
  mkdirSync(d, { recursive: true });
  for (const f of COPIED_FILES) {
    const dest = join(d, f);
    if (existsSync(dest)) console.log(`keep  ${dest}`);
    else {
      copyFileSync(join(TEMPLATES_DIR, f), dest);
      console.log(`write ${dest}`);
    }
  }
  const mcpDest = join(d, "mcp.json");
  if (existsSync(mcpDest)) console.log(`keep  ${mcpDest}`);
  else {
    const { text, kimiCuBin } = renderMcpTemplate();
    writeFileSync(mcpDest, text);
    console.log(kimiCuBin ? `write ${mcpDest} (kimi-cu -> ${kimiCuBin})` : `write ${mcpDest} (KimiCU not found; kimi-cu keeps the ${KIMI_CU_PLACEHOLDER} placeholder, see pin doctor)`);
  }
  const cfgDest = join(d, "adonis-pi.json");
  if (existsSync(cfgDest)) console.log(`keep  ${cfgDest}`);
  else {
    const schema = readJson(join(TEMPLATES_DIR, "adonis-pi.json")).$schema;
    writeFileSync(cfgDest, JSON.stringify({ $schema: schema, agentsMd: "" }, null, 2) + "\n");
    console.log(`write ${cfgDest} (overrides only; defaults come from the package template)`);
  }
  const proxy = join(d, "proxy.env");
  if (existsSync(proxy)) console.log(`keep  ${proxy}`);
  else {
    writeFileSync(proxy, readFileSync(join(TEMPLATES_DIR, "proxy.env.example")), { mode: 0o600 });
    console.log(`write ${proxy} (fill in your keys)`);
  }
  // chmod is the one thing setup changes on an existing file: a readable proxy.env is a leak, not a preference.
  if ((statSync(proxy).mode & 0o777) !== 0o600) chmodSync(proxy, 0o600);
  // MCP needs no package: pi's built-in MCP Client reads mcp.json. An old pi-mcp-adapter entry is doctor's FAIL, not setup's to remove.
  console.log(`packages: ${addPackage(join(d, "settings.json"), pinRoot)}`);
  const cfgPath = join(d, "adonis-pi.json");
  let agentsMd = "";
  try {
    const v = readJson(cfgPath).agentsMd;
    agentsMd = typeof v === "string" ? v : "";
  } catch {}
  const link = join(d, "AGENTS.md");
  if (!agentsMd) {
    console.log(`note  agentsMd is empty in ${cfgPath} — set it to your shared AGENTS.md and rerun setup`);
    return;
  }
  const target = expandTilde(agentsMd);
  let isRegularFile = false;
  try {
    isRegularFile = !lstatSync(link).isSymbolicLink();
  } catch {}
  if (isRegularFile) console.log(`note  ${link} is a regular file; not replacing it`);
  else if (!existsSync(target)) console.log(`note  agentsMd target ${target} does not exist; link not created`);
  else {
    try {
      unlinkSync(link);
    } catch {}
    symlinkSync(target, link);
    console.log(`link  ${link} -> ${target}`);
  }
}

/**
 * One doctor conclusion (CONTEXT.md "Finding"). `subject` is the Account Layer file or component judged ("settings.json",
 * "models.json", "adonis-pi.json", "mcp.json", "proxy.env", "AGENTS.md", "pi", "pi-mcp-adapter" for a leftover install,
 * "account"); `item` narrows it to one MCP Server name, `$VAR` or package spec.
 * `message` never carries a value from proxy.env or a url with its query.
 */
export type Level = "OK" | "WARN" | "FAIL";
export interface Finding {
  level: Level;
  subject: string;
  item?: string;
  message: string;
}
export function renderFinding(f: Finding): string {
  return `${f.level.padEnd(4)} ${f.subject}${f.item ? ` ${f.item}` : ""} ${f.message}`;
}

/**
 * Every check `pin doctor` makes on account n, as records. `env` supplies PATH (bare mcp.json commands, `pi`) and the
 * environment `pi --version` runs in; proxy.env is read statically and never sourced.
 */
export function inspectAccount(n: number, pinRoot: string, opts: { home?: string; env?: NodeJS.ProcessEnv } = {}): Finding[] {
  const env = opts.env ?? process.env;
  const d = accountAgentDir(n, opts.home);
  const out: Finding[] = [];
  const add = (level: Level, subject: string, message: string, item?: string) => out.push(item === undefined ? { level, subject, message } : { level, subject, item, message });
  if (!existsSync(d)) {
    add("FAIL", "account", `dir ${d} missing (run: pin setup ${n})`);
    return out;
  }
  for (const f of TEMPLATED_FILES) {
    const p = join(d, f);
    if (!existsSync(p)) {
      add("FAIL", f, "missing");
      continue;
    }
    if (f === "adonis-pi.json") continue; // merged at runtime; validated below instead of diffed
    let dr: string[];
    try {
      dr = drift(readJson(join(TEMPLATES_DIR, f)), readJson(p));
    } catch {
      dr = ["unparseable"];
    }
    if (dr.length === 0) add("OK", f, "matches template keys");
    else add("WARN", f, `drift: ${dr.join(",")}`);
  }
  const cfgPath = join(d, "adonis-pi.json");
  if (existsSync(cfgPath)) {
    // The same validator the extensions use: an invalid file means they silently run on template defaults.
    try {
      loadConfig({ path: cfgPath });
      add("OK", "adonis-pi.json", "is valid");
    } catch (e) {
      add("FAIL", "adonis-pi.json", `invalid: ${(e as Error).message}`);
    }
  }
  const proxy = join(d, "proxy.env");
  // What proxy.env will leave for pi, judged statically: set / empty / unknown (needs shell evaluation, which doctor never runs).
  let envState: ProxyEnv = { state: new Map(), certain: true };
  if (existsSync(proxy)) {
    const mode = statSync(proxy).mode & 0o777;
    if (mode === 0o600) add("OK", "proxy.env", "mode 600");
    else add("FAIL", "proxy.env", `mode is ${mode.toString(8)}, must be 600`);
    envState = proxyEnvState(readFileSync(proxy, "utf8"));
    if (!envState.certain) add("WARN", "proxy.env", "has lines doctor cannot parse (only `export NAME=value`, `NAME=value`, `unset NAME` and comments are understood); variable checks below are reported as unknown");
    const view = proxyEnvView(envState);
    for (const { file, name } of accountRefs(d)) {
      const st = view(name);
      if (st === "set") add("OK", file, "provided", `$${name}`);
      else if (st === "unknown") add("WARN", file, `is computed when proxy.env is sourced; doctor cannot check it (PIN_DRY_RUN=1 pin ${n} shows set/unset)`, `$${name}`);
      else add("WARN", file, "is referenced but proxy.env leaves it empty", `$${name}`);
    }
  } else add("WARN", "proxy.env", "missing (API providers will not authenticate)");
  const settings = join(d, "settings.json");
  if (existsSync(settings)) {
    const sj = readJson(settings);
    const packages = packageSources(sj);
    if (packages.includes(pinRoot)) add("OK", "settings.json", `packages includes ${pinRoot}`);
    else add("FAIL", "settings.json", `packages lacks ${pinRoot} (run: pin setup ${n})`);
    for (const p of packages) if (p.startsWith("/") && !existsSync(p)) add("WARN", "settings.json", `packages entry ${p} does not exist on disk`);
    // pi-mcp-adapter registers /mcp, which replaces pi's built-in MCP Client: pi then ignores mcp.json in sessions (ADR 0004).
    const entries = adapterEntries(packages);
    for (const spec of entries) add("FAIL", "settings.json", `packages loads the retired MCP bridge, which replaces pi's built-in MCP Client (run: PI_CODING_AGENT_DIR=${d} pi remove ${spec})`, spec);
    for (const e of builtinMcpOffBy(stringsAt(sj, "extensions"))) add("FAIL", "settings.json", `extensions has "${e}", which turns pi's built-in MCP Client off (remove that entry)`, e);
    const leftover = installedAdapter(d);
    if (leftover && entries.length === 0) add("WARN", MCP_ADAPTER_NAME, `left installed at ${leftover}; no packages entry loads it, so pi ignores it (delete the directory to tidy up)`);
  }
  const mcpPath = join(d, "mcp.json");
  if (existsSync(mcpPath)) {
    try {
      const cfg = readMcpConfig(mcpPath);
      const view = { env: proxyEnvView(envState), path: env.PATH };
      // pi silently ignores what only the retired adapter understood (a `disabled` server would connect): each leftover FAILs.
      for (const l of mcpConfigLeftovers(cfg)) add("FAIL", "mcp.json", l);
      for (const [later, first] of mcpNameConflicts(cfg)) add("FAIL", "mcp.json", `is the same server as "${first}" to pi (- and _ are equal); pi keeps "${first}" and rejects this one (rename or remove it)`, later);
      for (const [name, srv] of Object.entries(cfg.mcpServers)) {
        for (const l of mcpServerLeftovers(srv)) add("FAIL", "mcp.json", l, name);
        const borrowed = borrowedClientName(srv);
        if (borrowed !== undefined) add("FAIL", "mcp.json", `oauth.clientName "${borrowed}" borrows another client's identity; remove oauth.clientName so pi registers as itself (ADR 0004)`, name);
        if (preRegisteredClientId(srv) !== undefined) add("WARN", "mcp.json", "uses a pre-registered oauth.clientId; keep it only if you registered that client yourself, never another host's (ADR 0004)", name);
        // The Server Status verdict (lib/mcp.ts), phrased; leftovers above do not suppress it. PATH is this shell's; a proxy.env that changes PATH is not modelled.
        const st = serverStatus(srv, view, name);
        const shown = (target: string) => (target === srv.url ? redactUrl(target) : target);
        const envNote = (refs: string[]) => (refs.length ? ` (env: ${refs.map((v) => `$${v}`).join(", ")})` : "");
        if (st.usable && st.computed) add("WARN", "mcp.json", `-> ${shown(st.target)}${envNote(st.refs)}; a !command value is computed when the server connects; doctor cannot check it (run: pin ${n} mcp list)`, name);
        else if (st.usable) add("OK", "mcp.json", `-> ${shown(st.target)}${envNote(st.refs)}`, name);
        else if (st.kind === "disabled") add("OK", "mcp.json", "disabled", name);
        else if (st.kind === "placeholder") add("FAIL", "mcp.json", `command is still ${KIMI_CU_PLACEHOLDER} (install KimiCU or set ADONIS_PI_KIMI_CU_BIN, then edit mcp.json)`, name);
        else if (st.kind === "command-unresolved") add("FAIL", "mcp.json", `command ${st.command} ${describeUnresolved(st.command)}`, name);
        else if (st.kind === "invalid") add("FAIL", "mcp.json", `${st.reason}; pi rejects the entry (unavailable)`, name);
        else if (st.kind === "env-empty") add("WARN", "mcp.json", `-> ${shown(st.target)} but proxy.env does not set ${st.vars.map((v) => `$${v}`).join(", ")} (unavailable until it does)`, name);
        else add("WARN", "mcp.json", `-> ${shown(st.target)}; availability depends on ${st.vars.map((v) => `$${v}`).join(", ")}, which doctor cannot evaluate`, name);
      }
    } catch (e) {
      add("FAIL", "mcp.json", `invalid: ${(e as Error).message}`);
    }
  }
  const link = join(d, "AGENTS.md");
  try {
    if (lstatSync(link).isSymbolicLink()) {
      if (existsSync(link)) add("OK", "AGENTS.md", `-> ${readlinkSync(link)}`);
      else add("FAIL", "AGENTS.md", "is a dangling link");
    } else add("WARN", "AGENTS.md", "is a regular file (not shared)");
  } catch {
    add("WARN", "AGENTS.md", "not linked (agentsMd empty?)");
  }
  const pi = resolveCommand("pi", env);
  const piInstall = "npm install -g @earendil-works/pi-coding-agent@1.0.0";
  if (!pi) add("FAIL", "pi", `not on PATH (${piInstall})`);
  else {
    let ver = "";
    try {
      ver = /\d+\.\d+\.\d+/.exec(execFileSync(pi, ["--version"], { encoding: "utf8", env }))?.[0] ?? "";
    } catch {}
    if (ver.startsWith(PI_TESTED_MINOR)) add("OK", "pi", `${ver} on PATH (${pi})`);
    else if (!ver) add("WARN", "pi", `found at ${pi} but its version is unreadable`);
    else if (compareVersions(ver, PI_MIN_VERSION) < 0) add("FAIL", "pi", `${ver} is older than ${PI_MIN_VERSION}; its built-in MCP Client lacks the exposure, timeout and oauth.clientName support the Template relies on (${piInstall})`);
    else add("WARN", "pi", `${ver} differs from the tested ${PI_TESTED_MINOR}x; run npm test in the package after upgrading pi`);
  }
  return out;
}

function doctor(n: number, pinRoot: string): number {
  const findings = inspectAccount(n, pinRoot);
  for (const f of findings) console.log(renderFinding(f));
  return findings.some((f) => f.level === "FAIL") ? 1 : 0;
}

/** True when Node runs this file as the program (pin does), false when a test imports it. */
function isMain(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const [cmd, a, b] = process.argv.slice(2);
  switch (cmd) {
    case "dir":
      console.log(accountAgentDir(Number(a)));
      break;
    case "setup":
      setup(Number(a), b);
      break;
    case "doctor":
      process.exitCode = doctor(Number(a), b);
      break;
    case "vars":
      console.log(accountVars(a).join(" "));
      break;
    default:
      console.error("account.ts: unknown command");
      process.exitCode = 2;
  }
}
