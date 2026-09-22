// Account Layer maintenance for `pin` (ADR 0002). Run directly by Node ≥ 22.18 (type stripping):
//   account.ts dir <n>                 print the agent dir of account n
//   account.ts setup <n> <pinRoot>     materialise templates (never overwrites), register the package, link AGENTS.md
//   account.ts doctor <n> <pinRoot>    OK/WARN/FAIL report; exit 1 on any FAIL
//   account.ts refs <agentDir>         env vars the account's JSON files reference as "$VAR"
// Layout, template list and the $VAR grammar come from lib/config.ts so the launcher and the extensions agree.
import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountAgentDir, configEnvRefs, envRefs, expandTilde, loadConfig, TEMPLATED_FILES, TEMPLATES_DIR } from "../../lib/config.ts";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const readJson = (p: string): Json => JSON.parse(readFileSync(p, "utf8"));

/**
 * Template keys the account file lacks (a template update the account has not adopted). Extra account keys are not
 * drift: pi and the user legitimately add their own (theme, defaultModel, skills, lastChangelogVersion…).
 */
export function drift(template: Json, account: Json, prefix = ""): string[] {
  const out: string[] = [];
  for (const k of Object.keys(template)) {
    if (k === "$schema" || k === "packages") continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (!(k in account)) out.push(`missing ${path}`);
    else if (isObj(template[k]) && isObj(account[k])) out.push(...drift(template[k], account[k], path));
  }
  return out;
}

/** Files setup copies verbatim. adonis-pi.json is different: it is merged over the template at runtime, so the account keeps only overrides. */
const COPIED_FILES = TEMPLATED_FILES.filter((f) => f !== "adonis-pi.json");

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

function which(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {}
  }
  return undefined;
}

/** Env vars the account references: models.json values plus the effective Config (account merged over template). */
export function refsByFile(dir: string): [string, string[]][] {
  const out: [string, string[]][] = [];
  const models = join(dir, "models.json");
  if (existsSync(models)) out.push(["models.json", envRefs(readFileSync(models, "utf8"))]);
  out.push(["adonis-pi.json", configEnvRefs(join(dir, "adonis-pi.json"))]);
  return out;
}
export function accountRefs(dir: string): string[] {
  return [...new Set(refsByFile(dir).flatMap(([, vars]) => vars))].sort();
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

function doctor(n: number, pinRoot: string): number {
  const d = accountAgentDir(n);
  let fails = 0;
  const ok = (m: string) => console.log(`OK   ${m}`);
  const warn = (m: string) => console.log(`WARN ${m}`);
  const fail = (m: string) => {
    console.log(`FAIL ${m}`);
    fails++;
  };
  if (!existsSync(d)) {
    fail(`account dir ${d} missing (run: pin setup ${n})`);
    return 1;
  }
  for (const f of TEMPLATED_FILES) {
    const p = join(d, f);
    if (!existsSync(p)) {
      fail(`${f} missing`);
      continue;
    }
    if (f === "adonis-pi.json") continue; // merged at runtime; validated below instead of diffed
    let dr: string[];
    try {
      dr = drift(readJson(join(TEMPLATES_DIR, f)), readJson(p));
    } catch {
      dr = ["unparseable"];
    }
    if (dr.length === 0) ok(`${f} matches template keys`);
    else warn(`${f} drift: ${dr.join(",")}`);
  }
  const cfgPath = join(d, "adonis-pi.json");
  if (existsSync(cfgPath)) {
    // The same validator the extensions use: an invalid file means they silently run on template defaults.
    try {
      loadConfig({ path: cfgPath });
      ok("adonis-pi.json is valid");
    } catch (e) {
      fail(`adonis-pi.json invalid: ${(e as Error).message}`);
    }
  }
  const proxy = join(d, "proxy.env");
  if (existsSync(proxy)) {
    const mode = statSync(proxy).mode & 0o777;
    if (mode === 0o600) ok("proxy.env mode 600");
    else fail(`proxy.env mode is ${mode.toString(8)}, must be 600`);
    const text = readFileSync(proxy, "utf8");
    for (const [file, vars] of refsByFile(d)) {
      for (const v of vars) {
        if (new RegExp(`^export ${v}=.+`, "m").test(text)) ok(`${file} $${v} provided`);
        else warn(`${file} references $${v} but proxy.env leaves it empty`);
      }
    }
  } else warn("proxy.env missing (API providers will not authenticate)");
  const settings = join(d, "settings.json");
  if (existsSync(settings)) {
    const packages = packagesOf(settings);
    if (packages.includes(pinRoot)) ok(`settings.json packages includes ${pinRoot}`);
    else fail(`settings.json packages lacks ${pinRoot} (run: pin setup ${n})`);
    for (const p of packages) if (p.startsWith("/") && !existsSync(p)) warn(`settings.json packages entry ${p} does not exist on disk`);
  }
  const link = join(d, "AGENTS.md");
  try {
    if (lstatSync(link).isSymbolicLink()) {
      if (existsSync(link)) ok(`AGENTS.md -> ${readlinkSync(link)}`);
      else fail("AGENTS.md is a dangling link");
    } else warn("AGENTS.md is a regular file (not shared)");
  } catch {
    warn("AGENTS.md not linked (agentsMd empty?)");
  }
  const pi = which("pi");
  if (!pi) fail("pi not on PATH (npm install -g @earendil-works/pi-coding-agent@0.87.0)");
  else {
    let ver = "";
    try {
      ver = /\d+\.\d+\.\d+/.exec(execFileSync(pi, ["--version"], { encoding: "utf8" }))?.[0] ?? "";
    } catch {}
    if (ver.startsWith("0.87.")) ok(`pi ${ver} on PATH (${pi})`);
    else if (!ver) warn(`pi found at ${pi} but its version is unreadable`);
    else warn(`pi ${ver} differs from the tested 0.87.x; run npm test in the package after upgrading pi`);
  }
  return fails === 0 ? 0 : 1;
}

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
  case "refs":
    console.log(accountRefs(a).join(" "));
    break;
  default:
    console.error("account.ts: unknown command");
    process.exitCode = 2;
}
