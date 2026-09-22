// Account Layer maintenance for `pin` (ADR 0002). Run directly by Node ≥ 22.18 (type stripping):
//   account.ts dir <n>                 print the agent dir of account n
//   account.ts setup <n> <pinRoot>     materialise templates (never overwrites), register the package, link AGENTS.md
//   account.ts doctor <n> <pinRoot>    OK/WARN/FAIL report; exit 1 on any FAIL
//   account.ts vars <agentDir>         env var names the account references or its proxy.env exports (for pin --dry-run)
// doctor is `inspectAccount` (structured Findings, what tests call) plus one line of rendering; only the CLI prints.
// Layout, Template list, `$VAR` grammar and the Server Status verdict come from lib/, so the launcher and the extensions agree.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../lib/config.ts";
import { type ProxyEnv, proxyEnvState, proxyEnvView, resolveKimiCuBin } from "../../lib/environment.ts";
import { accountAgentDir, expandTilde, KIMI_CU_PLACEHOLDER, MCP_ADAPTER_NAME, MCP_ADAPTER_PACKAGE, MCP_ADAPTER_VERSION, TEMPLATED_FILES, TEMPLATES_DIR } from "../../lib/layout.ts";
import { mcpBareRefs, readMcpConfig, resolveCommand, serverStatus } from "../../lib/mcp.ts";
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

/** The MCP Bridge as pi installed it under <agentDir>/npm, or undefined. */
function installedAdapter(agentDir: string): { dir: string; version: string } | undefined {
  const dir = join(agentDir, "npm", "node_modules", MCP_ADAPTER_NAME);
  const pkg = join(dir, "package.json");
  if (!existsSync(pkg)) return undefined;
  try {
    return { dir, version: String(readJson(pkg).version ?? "") };
  } catch {
    return { dir, version: "" };
  }
}

/** The `npm:pi-mcp-adapter…` entries in settings.json packages (any version). */
function adapterEntries(packages: string[]): string[] {
  return packages.filter((p) => p === `npm:${MCP_ADAPTER_NAME}` || p.startsWith(`npm:${MCP_ADAPTER_NAME}@`));
}

function packagesOf(settingsPath: string): string[] {
  const j = readJson(settingsPath);
  return Array.isArray(j.packages) ? (j.packages as string[]) : [];
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
  console.log(`packages: ${addPackage(join(d, "settings.json"), pinRoot)}`);
  console.log(`packages: ${MCP_ADAPTER_PACKAGE} ${addPackage(join(d, "settings.json"), MCP_ADAPTER_PACKAGE)}`);
  // pi installs user-level npm packages only through `pi install`, never on startup; run it once so the Bridge exists.
  const adapter = installedAdapter(d);
  if (adapter?.version === MCP_ADAPTER_VERSION) console.log(`keep  ${adapter.dir} (${adapter.version})`);
  else if (process.env.PIN_SKIP_INSTALL === "1") console.log(`note  ${MCP_ADAPTER_NAME} ${adapter?.version ?? "not installed"}; install skipped (PIN_SKIP_INSTALL)`);
  else {
    const pi = resolveCommand("pi");
    if (!pi) console.log(`note  pi not on PATH; run later: PI_CODING_AGENT_DIR=${d} pi install ${MCP_ADAPTER_PACKAGE}`);
    else {
      try {
        execFileSync(pi, ["install", MCP_ADAPTER_PACKAGE], { env: { ...process.env, PI_CODING_AGENT_DIR: d }, stdio: "inherit" });
        console.log(`install ${MCP_ADAPTER_PACKAGE} -> ${installedAdapter(d)?.dir ?? "(location unknown; see pin doctor)"}`);
      } catch (e) {
        console.log(`note  pi install failed (${(e as Error).message}); run later: PI_CODING_AGENT_DIR=${d} pi install ${MCP_ADAPTER_PACKAGE}`);
      }
    }
  }
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
 * "proxy.env", "pi", "pi-mcp-adapter", "account"); `item` narrows it to one MCP Server name, `$VAR` or package spec.
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
    const packages = packagesOf(settings);
    if (packages.includes(pinRoot)) add("OK", "settings.json", `packages includes ${pinRoot}`);
    else add("FAIL", "settings.json", `packages lacks ${pinRoot} (run: pin setup ${n})`);
    for (const p of packages) if (p.startsWith("/") && !existsSync(p)) add("WARN", "settings.json", `packages entry ${p} does not exist on disk`);
    const entries = adapterEntries(packages);
    if (entries.length === 1 && entries[0] === MCP_ADAPTER_PACKAGE) add("OK", "settings.json", `packages pins ${MCP_ADAPTER_PACKAGE}`);
    else if (entries.length === 0) add("FAIL", "settings.json", `packages lacks ${MCP_ADAPTER_PACKAGE} (run: pin setup ${n})`);
    else add("FAIL", "settings.json", `packages has ${entries.join(", ")}; expected exactly ${MCP_ADAPTER_PACKAGE} (edit settings.json, then: PI_CODING_AGENT_DIR=${d} pi install ${MCP_ADAPTER_PACKAGE})`);
    const adapter = installedAdapter(d);
    if (!adapter) add("FAIL", MCP_ADAPTER_NAME, `not installed under ${join(d, "npm")} (run: pin setup ${n})`);
    else if (adapter.version === MCP_ADAPTER_VERSION) add("OK", MCP_ADAPTER_NAME, `${adapter.version} installed`);
    else add("FAIL", MCP_ADAPTER_NAME, `${adapter.version || "?"} installed, template pins ${MCP_ADAPTER_VERSION} (run: PI_CODING_AGENT_DIR=${d} pi install ${MCP_ADAPTER_PACKAGE})`);
  }
  const mcpPath = join(d, "mcp.json");
  if (existsSync(mcpPath)) {
    try {
      const servers = readMcpConfig(mcpPath).mcpServers;
      const view = { env: proxyEnvView(envState), path: env.PATH };
      for (const [name, srv] of Object.entries(servers)) {
        // A whole-string "$VAR" may be a mis-written reference (the Bridge sends it literally) or a deliberate literal: warn, never disable.
        const bare = mcpBareRefs(srv);
        if (bare.length) add("WARN", "mcp.json", `has bare ${bare.map((v) => `$${v}`).join(", ")}; the MCP Bridge sends that literally — if a variable was meant, write ${bare.map((v) => `\${${v}}`).join(", ")}`, name);
        // The Server Status verdict (lib/mcp.ts), phrased. PATH is this shell's; a proxy.env that changes PATH is not modelled.
        const st = serverStatus(srv, view);
        const shown = (target: string) => (srv.command === undefined ? redactUrl(target) : target);
        if (st.usable) add("OK", "mcp.json", `-> ${shown(st.target)}${st.refs.length ? ` (env: ${st.refs.map((v) => `$${v}`).join(", ")})` : ""}`, name);
        else if (st.kind === "disabled") add("OK", "mcp.json", "disabled", name);
        else if (st.kind === "placeholder") add("FAIL", "mcp.json", `command is still ${KIMI_CU_PLACEHOLDER} (install KimiCU or set ADONIS_PI_KIMI_CU_BIN, then edit mcp.json)`, name);
        else if (st.kind === "command-unresolved") add("FAIL", "mcp.json", `command ${st.command} ${describeUnresolved(st.command)}`, name);
        else if (st.kind === "no-target") add("WARN", "mcp.json", "has neither command nor url (unavailable)", name);
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
  if (!pi) add("FAIL", "pi", "not on PATH (npm install -g @earendil-works/pi-coding-agent@0.87.0)");
  else {
    let ver = "";
    try {
      ver = /\d+\.\d+\.\d+/.exec(execFileSync(pi, ["--version"], { encoding: "utf8", env }))?.[0] ?? "";
    } catch {}
    if (ver.startsWith("0.87.")) add("OK", "pi", `${ver} on PATH (${pi})`);
    else if (!ver) add("WARN", "pi", `found at ${pi} but its version is unreadable`);
    else add("WARN", "pi", `${ver} differs from the tested 0.87.x; run npm test in the package after upgrading pi`);
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
