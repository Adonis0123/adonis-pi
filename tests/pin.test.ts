import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, readlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Finding, inspectAccount, renderFinding } from "../bin/lib/account.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const PIN = join(ROOT, "bin", "pin");

const ADAPTER = "npm:pi-mcp-adapter@2.36.0";

function env(home: string, extra: Record<string, string> = {}) {
  const fakeBin = join(home, "fakebin");
  mkdirSync(fakeBin, { recursive: true });
  // `pi install npm:<pkg>@<v>` is simulated by materialising what pi would leave under <agentDir>/npm.
  writeFileSync(
    join(fakeBin, "pi"),
    '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then echo "${FAKE_PI_VERSION:-0.87.0}"; exit 0; fi\n' +
      'if [ "${1:-}" = "install" ]; then spec=${2#npm:}; name=${spec%@*}; ver=${spec#*@}; d="$PI_CODING_AGENT_DIR/npm/node_modules/$name"; mkdir -p "$d"; printf \'{"name":"%s","version":"%s"}\' "$name" "${FAKE_INSTALL_VERSION:-$ver}" > "$d/package.json"; echo "FAKE_INSTALL $spec"; exit 0; fi\n' +
      'printf "FAKE_PI %s\\n" "$*"\nenv | grep "^PI_CODING_AGENT_DIR=" || true\n',
  );
  chmodSync(join(fakeBin, "pi"), 0o755);
  const kimi = join(fakeBin, "kimi-cu");
  writeFileSync(kimi, "#!/bin/sh\nexit 0\n");
  chmodSync(kimi, 0o755);
  writeFileSync(join(fakeBin, "npx"), "#!/bin/sh\nexit 0\n"); // figma-rest's bare `npx` command resolves on PATH
  chmodSync(join(fakeBin, "npx"), 0o755);
  return { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, ADONIS_PI_KIMI_CU_BIN: kimi, ...extra };
}
function pin(home: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync("sh", [PIN, ...args], { env: env(home, extra), encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
}
/** What `pin doctor 1` would judge, as Findings (the structure tests assert on; wording stays free). */
function inspect(home: string, extra: Record<string, string> = {}): Finding[] {
  return inspectAccount(1, ROOT, { home, env: env(home, extra) });
}
const of = (fs: Finding[], subject: string, item?: string) => fs.filter((f) => f.subject === subject && (item === undefined || f.item === item));
const levels = (fs: Finding[], subject: string, item?: string) => of(fs, subject, item).map((f) => f.level);

test("setup 1 materialises templates into ~/.pi/agent and registers the package", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  const r = pin(home, ["setup", "1"]);
  assert.equal(r.code, 0, r.out);
  const agent = join(home, ".pi", "agent");
  for (const f of ["settings.json", "models.json", "adonis-pi.json", "mcp.json", "proxy.env"]) assert.ok(existsSync(join(agent, f)), f);
  assert.deepEqual(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).packages, [ADAPTER, ROOT], "template pins the MCP Bridge; setup appends this checkout");
  assert.match(r.out, /^install npm:pi-mcp-adapter@2\.36\.0 -> /m, "setup runs pi install once");
  assert.ok(existsSync(join(agent, "npm", "node_modules", "pi-mcp-adapter", "package.json")));
  const mcp = JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers["kimi-cu"].command, join(home, "fakebin", "kimi-cu"), "the placeholder is resolved to this machine's KimiCU");
  assert.equal(mcp.mcpServers.figma.disabled, true);
  assert.deepEqual(mcp.mcpServers["figma-rest"].args, ["-y", "figma-developer-mcp@0.13.2", "--stdio", "--env", "/dev/null", "--no-telemetry"], "Framelink is pinned; no cwd .env, no telemetry");
  assert.equal(mcp.mcpServers["figma-rest"].env.FIGMA_API_KEY, "${FIGMA_API_KEY}", "the Figma key stays a reference; only proxy.env holds a value");
  assert.equal(mcp.settings.scriptMode, false, "mcpScript stays off so every MCP call is visible to the permission gate as mcp or a direct tool");
  assert.equal(lstatSync(join(agent, "proxy.env")).mode & 0o777, 0o600);
  assert.match(r.out, /agentsMd is empty/);
  const cfg = JSON.parse(readFileSync(join(agent, "adonis-pi.json"), "utf8"));
  assert.deepEqual(Object.keys(cfg).sort(), ["$schema", "agentsMd"], "the account config holds overrides only, so template defaults keep flowing");
});

test("setup 2 uses ~/.pi-002/agent", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  assert.equal(pin(home, ["setup", "2"]).code, 0);
  assert.ok(existsSync(join(home, ".pi-002", "agent", "settings.json")));
});

test("setup never overwrites an existing account file (Review Focus 5)", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const settings = join(home, ".pi", "agent", "settings.json");
  const edited = JSON.stringify({ packages: [ROOT], defaultProvider: "glm", theme: "light" }, null, 2) + "\n";
  writeFileSync(settings, edited);
  const models = join(home, ".pi", "agent", "models.json");
  writeFileSync(models, "{\"providers\":{}}\n");
  const mcp = join(home, ".pi", "agent", "mcp.json");
  writeFileSync(mcp, "{\"mcpServers\":{}}\n");
  const r = pin(home, ["setup", "1"]);
  // packages registration is the one documented amendment: the pinned Bridge is appended, everything else stays verbatim
  assert.deepEqual(JSON.parse(readFileSync(settings, "utf8")), { packages: [ROOT, ADAPTER], defaultProvider: "glm", theme: "light" });
  assert.equal(readFileSync(models, "utf8"), "{\"providers\":{}}\n");
  assert.equal(readFileSync(mcp, "utf8"), "{\"mcpServers\":{}}\n");
  assert.match(r.out, /^keep  .*mcp\.json$/m);
});

test("setup adds a missing packages entry while keeping user keys and 4-space indentation", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const settings = join(home, ".pi", "agent", "settings.json");
  writeFileSync(settings, JSON.stringify({ defaultProvider: "glm", theme: "light" }, null, 4) + "\n");
  pin(home, ["setup", "1"]);
  const text = readFileSync(settings, "utf8");
  const json = JSON.parse(text);
  assert.deepEqual(json, { defaultProvider: "glm", theme: "light", packages: [ROOT, ADAPTER] });
  assert.match(text, /^    "defaultProvider"/m);
  assert.doesNotMatch(text, /^  "/m);
});

test("setup links AGENTS.md when agentsMd is set and refuses to replace a real file", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  const rules = join(home, "rules.md");
  writeFileSync(rules, "# rules\n");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: rules }));
  assert.equal(pin(home, ["setup", "1"]).code, 0);
  assert.equal(readlinkSync(join(agent, "AGENTS.md")), rules);
  unlinkSync(join(agent, "AGENTS.md")); // writeFileSync would follow the link and overwrite rules.md
  writeFileSync(join(agent, "AGENTS.md"), "real file\n"); // now a real file where the link was
  const r = pin(home, ["setup", "1"]);
  assert.equal(readFileSync(rules, "utf8"), "# rules\n");
  assert.equal(readFileSync(join(agent, "AGENTS.md"), "utf8"), "real file\n");
  assert.match(r.out, /AGENTS.md is a regular file/);
});

test("doctor passes on a fresh setup and fails on a 644 proxy.env; every line is a rendered Finding", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  writeFileSync(join(home, ".pi", "agent", "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  let r = pin(home, ["doctor", "1"]);
  assert.equal(r.code, 0, r.out);
  const lines = r.out.trimEnd().split("\n");
  assert.ok(lines.length > 8);
  for (const l of lines) assert.match(l, /^(OK   |WARN |FAIL )\S/, l);
  assert.doesNotMatch(r.out, /^FAIL/m);
  assert.match(r.out, /^WARN mcp.json figma-rest -> npx but proxy.env does not set \$FIGMA_API_KEY/m, "subject and item lead the line; the template proxy.env has no Figma key yet");
  chmodSync(join(home, ".pi", "agent", "proxy.env"), 0o644);
  r = pin(home, ["doctor", "1"]);
  assert.equal(r.code, 1, "any FAIL is exit 1");
  assert.match(r.out, /^FAIL proxy.env mode/m);
  assert.equal(renderFinding({ level: "WARN", subject: "mcp.json", item: "ghost", message: "x" }), "WARN mcp.json ghost x");
});

test("doctor reports template drift as missing keys only, validates adonis-pi.json, and warns on empty env refs", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "", bogus: 1, permissionGate: { mode: "ask" } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [ROOT, ADAPTER], theme: "light", skills: ["!x"] }, null, 2) + "\n");
  const fs = inspect(home);
  const [driftF] = of(fs, "settings.json").filter((f) => f.message.startsWith("drift:"));
  assert.equal(driftF.level, "WARN");
  for (const k of ["defaultProvider", "quietStartup", "enableInstallTelemetry"]) assert.match(driftF.message, new RegExp(`missing ${k}`));
  assert.doesNotMatch(driftF.message, /theme|skills/, "user and pi keys in settings.json are not drift");
  const fileF = of(fs, "adonis-pi.json").filter((f) => !f.item);
  assert.deepEqual(fileF.map((f) => f.level), ["FAIL"], "adonis-pi.json is merged at runtime, so missing keys are not drift; the invalid file is");
  assert.match(fileF[0].message, /unknown key "bogus"/, "doctor runs the same validator as the extensions");
  assert.deepEqual(levels(fs, "models.json", "$GLM_API_KEY"), ["WARN"]);
});

test("doctor reports the notifier variable and a stale packages path", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [ROOT, ADAPTER, "/nonexistent/old-checkout"], lastChangelogVersion: "0.87.0" }, null, 2) + "\n");
  const fs = inspect(home);
  assert.deepEqual(levels(fs, "adonis-pi.json", "$ADONIS_PI_NOTIFY_CMD"), ["WARN"]);
  assert.ok(of(fs, "settings.json").some((f) => f.level === "WARN" && f.message.includes("/nonexistent/old-checkout")));
  assert.equal(fs.some((f) => f.level === "FAIL"), false);
});

test("doctor fails when settings.json lacks the packages entry (Review Focus 5)", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], note: ROOT }, null, 2)); // path present elsewhere must not count
  const fs = inspect(home);
  assert.ok(of(fs, "settings.json").some((f) => f.level === "FAIL" && f.message.includes(ROOT)));
});

test("doctor pins the MCP Bridge: missing entry, other version, or a different installed version all FAIL", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  let fs = inspect(home);
  assert.ok(of(fs, "settings.json").some((f) => f.level === "OK" && f.message.includes(ADAPTER)));
  assert.deepEqual(of(fs, "pi-mcp-adapter").map((f) => [f.level, f.message]), [["OK", "2.36.0 installed"]]);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [ROOT, "npm:pi-mcp-adapter"] }, null, 2));
  fs = inspect(home);
  assert.ok(of(fs, "settings.json").some((f) => f.level === "FAIL" && /npm:pi-mcp-adapter;.*expected exactly npm:pi-mcp-adapter@2\.36\.0/.test(f.message)));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [ROOT, ADAPTER] }, null, 2));
  writeFileSync(join(agent, "npm", "node_modules", "pi-mcp-adapter", "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "2.35.0" }));
  fs = inspect(home);
  assert.deepEqual(levels(fs, "pi-mcp-adapter"), ["FAIL"]);
  assert.match(of(fs, "pi-mcp-adapter")[0].message, /2\.35\.0.*2\.36\.0/);
});

test("setup without KimiCU keeps the placeholder and doctor reports it; a wrong command path also FAILs", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  const r = pin(home, ["setup", "1"], { ADONIS_PI_KIMI_CU_BIN: "/nonexistent/kimi-cu" }); // the override is authoritative: no fallback to the app bundle or PATH
  assert.match(r.out, /KimiCU not found/);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  let fs = inspect(home);
  assert.deepEqual(levels(fs, "mcp.json", "kimi-cu"), ["FAIL"]);
  assert.match(of(fs, "mcp.json", "kimi-cu")[0].message, /\{\{KIMI_CU_BIN\}\}/);
  const mcp = JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8"));
  mcp.mcpServers["kimi-cu"].command = "/nonexistent/kimi-cu";
  writeFileSync(join(agent, "mcp.json"), JSON.stringify(mcp, null, 2));
  fs = inspect(home);
  assert.deepEqual(of(fs, "mcp.json", "kimi-cu").map((f) => [f.level, f.message]), [["FAIL", "command /nonexistent/kimi-cu is not an executable file"]]);
  mcp.mcpServers["kimi-cu"].disabled = true;
  writeFileSync(join(agent, "mcp.json"), JSON.stringify(mcp, null, 2));
  fs = inspect(home);
  assert.deepEqual(of(fs, "mcp.json", "kimi-cu").map((f) => [f.level, f.message]), [["OK", "disabled"]]);
  assert.equal(fs.some((f) => f.level === "FAIL"), false);
});

test("doctor resolves bare commands on PATH and checks mcp.json env references against proxy.env", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  const proxy = join(agent, "proxy.env");
  const server = (fs: Finding[]) => of(fs, "mcp.json", "figma-rest").map((f) => [f.level, f.message] as const);
  writeFileSync(proxy, "export GLM_API_KEY=abc\n");
  chmodSync(proxy, 0o600);
  let fs = inspect(home);
  assert.equal(fs.some((f) => f.level === "FAIL"), false);
  assert.deepEqual(levels(fs, "mcp.json", "$FIGMA_API_KEY"), ["WARN"]);
  assert.deepEqual(server(fs).map(([l]) => l), ["WARN"]);
  assert.match(server(fs)[0][1], /unavailable/, "the server line says unavailable, matching startup-check");
  writeFileSync(proxy, 'export GLM_API_KEY=abc\nexport FIGMA_API_KEY=""\n');
  fs = inspect(home);
  assert.deepEqual(levels(fs, "mcp.json", "$FIGMA_API_KEY"), ["WARN"], "an empty quoted value is empty");
  writeFileSync(proxy, "export GLM_API_KEY=abc\nexport FIGMA_API_KEY=figd_test\n");
  fs = inspect(home);
  assert.deepEqual(levels(fs, "mcp.json", "$FIGMA_API_KEY"), ["OK"]);
  assert.deepEqual(server(fs), [["OK", "-> npx (env: $FIGMA_API_KEY)"]]);
  assert.doesNotMatch(JSON.stringify(fs), /figd_test/, "doctor never carries values");
  const mcp = JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8"));
  writeFileSync(proxy, "export GLM_API_KEY=abc\nexport FIGMA_API_KEY=$FROM_ELSEWHERE\n");
  fs = inspect(home);
  assert.deepEqual(levels(fs, "mcp.json", "$FIGMA_API_KEY"), ["WARN"], "shell expansion is reported as unknown, not as provided or empty");
  assert.match(of(fs, "mcp.json", "$FIGMA_API_KEY")[0].message, /cannot check/);
  assert.deepEqual(server(fs).map(([l]) => l), ["WARN"]);
  assert.match(server(fs)[0][1], /cannot evaluate/);
  writeFileSync(proxy, "export GLM_API_KEY=abc\nexport FIGMA_API_KEY=figd_test\n");
  mcp.mcpServers["figma-rest"].env.EXTRA = "$HOME";
  writeFileSync(join(agent, "mcp.json"), JSON.stringify(mcp, null, 2));
  fs = inspect(home);
  assert.deepEqual(server(fs).map(([l]) => l), ["WARN", "OK"], "a bare $VAR warns but does not make the server unavailable (it may be a deliberate literal)");
  assert.match(server(fs)[0][1], /bare \$HOME.*\$\{HOME\}/);
  delete mcp.mcpServers["figma-rest"].env.EXTRA;
  mcp.mcpServers["figma-rest"].command = "no-such-command-xyz";
  mcp.mcpServers.ghost = {};
  mcp.mcpServers.remote = { url: "https://user:secret@mcp.example.com/mcp?token=abc123" };
  writeFileSync(join(agent, "mcp.json"), JSON.stringify(mcp, null, 2));
  fs = inspect(home);
  assert.deepEqual(server(fs), [["FAIL", "command no-such-command-xyz is not an executable on PATH"]]);
  assert.deepEqual(levels(fs, "mcp.json", "ghost"), ["WARN"]);
  assert.deepEqual(of(fs, "mcp.json", "remote").map((f) => [f.level, f.message]), [["OK", "-> https://mcp.example.com/mcp (credentials/query hidden)"]]);
  assert.doesNotMatch(JSON.stringify(fs), /secret|abc123/, "urls are redacted before they reach a Finding");
});

test("doctor reports the pi version: OK on 0.87.x, WARN on anything else", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  writeFileSync(join(home, ".pi", "agent", "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  assert.deepEqual(of(inspect(home), "pi").map((f) => [f.level, f.message.split(" on PATH")[0]]), [["OK", "0.87.0"]]);
  const fs = inspect(home, { FAKE_PI_VERSION: "0.88.0" });
  assert.deepEqual(levels(fs, "pi"), ["WARN"]);
  assert.match(of(fs, "pi")[0].message, /0\.88\.0/);
});

test("launch sources proxy.env, exports PI_CODING_AGENT_DIR and execs pi with args", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  writeFileSync(join(home, ".pi", "agent", "proxy.env"), "export GLM_API_KEY=abc\nexport KIMI_API_KEY=\n");
  chmodSync(join(home, ".pi", "agent", "proxy.env"), 0o600);
  const r = pin(home, ["1", "--model", "glm/glm-5.3"], { PIN_DRY_RUN: "1" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`^PI_CODING_AGENT_DIR=${join(home, ".pi", "agent")}$`, "m"));
  assert.match(r.out, /^GLM_API_KEY=<set>$/m);
  assert.match(r.out, /^KIMI_API_KEY=<unset>$/m, "variables proxy.env exports are reported even when no JSON references them (built-in providers read them)");
  assert.match(r.out, /^ADONIS_PI_NOTIFY_CMD=<unset>$/m, "every $VAR the account references is reported");
  assert.match(r.out, /^FIGMA_API_KEY=<unset>$/m, "mcp.json env references count too");
  assert.match(r.out, /^FIGMA_OAUTH_TOKEN=<unset>$/m, "cleared inherited Figma secrets are listed like the provider ones");
  assert.doesNotMatch(r.out, /abc/);
  assert.match(r.out, /^ARGS --model glm\/glm-5.3$/m);
});

test("pin with pi arguments but no account number launches account 1", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const r = pin(home, ["--model", "kimi/k3", "-p", "hi"], { PIN_DRY_RUN: "1" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`^PI_CODING_AGENT_DIR=${join(home, ".pi", "agent")}$`, "m"));
  assert.match(r.out, /^ARGS --model kimi\/k3 -p hi$/m);
  const bare = pin(home, [], { PIN_DRY_RUN: "1" });
  assert.match(bare.out, /^ARGS $/m);
});

test("launch refuses a world-readable proxy.env", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  chmodSync(join(home, ".pi", "agent", "proxy.env"), 0o644);
  const r = pin(home, ["1"], { PIN_DRY_RUN: "1" });
  assert.equal(r.code, 1);
  assert.match(r.out, /proxy.env must be mode 600/);
});

test("launch clears inherited provider env unless proxy.env sets it", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const r = pin(home, ["1"], { PIN_DRY_RUN: "1", ANTHROPIC_API_KEY: "leak", OPENAI_API_KEY: "leak2", FIGMA_API_KEY: "leak3", FIGMA_OAUTH_TOKEN: "leak4" });
  assert.match(r.out, /^ANTHROPIC_API_KEY=<unset>$/m);
  assert.match(r.out, /^OPENAI_API_KEY=<unset>$/m);
  assert.match(r.out, /^FIGMA_API_KEY=<unset>$/m, "Framelink would otherwise read a key from the calling shell");
  assert.match(r.out, /^FIGMA_OAUTH_TOKEN=<unset>$/m, "Framelink prefers an OAuth token over the API key when both are set");
  assert.doesNotMatch(r.out, /leak/);
});
