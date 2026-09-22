import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, readlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

test("doctor passes on a fresh setup and fails on a 644 proxy.env", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  writeFileSync(join(home, ".pi", "agent", "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  let r = pin(home, ["doctor", "1"]);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /^FAIL/m);
  chmodSync(join(home, ".pi", "agent", "proxy.env"), 0o644);
  r = pin(home, ["doctor", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^FAIL proxy.env mode/m);
});

test("doctor reports template drift as missing keys only, validates adonis-pi.json, and warns on empty env refs", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "", bogus: 1, permissionGate: { mode: "ask" } }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [ROOT, ADAPTER], theme: "light", skills: ["!x"] }, null, 2) + "\n");
  const r = pin(home, ["doctor", "1"]);
  assert.match(r.out, /^WARN settings.json drift: missing defaultProvider,missing quietStartup,missing enableInstallTelemetry$/m);
  assert.doesNotMatch(r.out, /extra/, "user and pi keys in settings.json are not drift");
  assert.doesNotMatch(r.out, /adonis-pi.json drift/, "adonis-pi.json is merged at runtime, so missing keys are not drift");
  assert.match(r.out, /^WARN models.json references \$GLM_API_KEY but proxy.env leaves it empty/m);
  assert.match(r.out, /^FAIL adonis-pi.json invalid: .*unknown key "bogus"/m, "doctor runs the same validator as the extensions");
  assert.equal(r.code, 1);
});

test("doctor reports the notifier variable and a stale packages path", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [ROOT, ADAPTER, "/nonexistent/old-checkout"], lastChangelogVersion: "0.87.0" }, null, 2) + "\n");
  const r = pin(home, ["doctor", "1"]);
  assert.match(r.out, /^WARN adonis-pi.json references \$ADONIS_PI_NOTIFY_CMD but proxy.env leaves it empty/m);
  assert.match(r.out, /^WARN settings.json packages entry \/nonexistent\/old-checkout does not exist on disk/m);
  assert.equal(r.code, 0);
});

test("doctor fails when settings.json lacks the packages entry (Review Focus 5)", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [], note: ROOT }, null, 2)); // path present elsewhere must not count
  const r = pin(home, ["doctor", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^FAIL settings.json packages lacks/m);
});

test("doctor pins the MCP Bridge: missing entry, other version, or a different installed version all FAIL", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  assert.match(pin(home, ["doctor", "1"]).out, /^OK   settings.json packages pins npm:pi-mcp-adapter@2\.36\.0\nOK   pi-mcp-adapter 2\.36\.0 installed$/m);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [ROOT, "npm:pi-mcp-adapter"] }, null, 2));
  let r = pin(home, ["doctor", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^FAIL settings.json packages has npm:pi-mcp-adapter; expected exactly npm:pi-mcp-adapter@2\.36\.0/m);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [ROOT, ADAPTER] }, null, 2));
  writeFileSync(join(agent, "npm", "node_modules", "pi-mcp-adapter", "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "2.35.0" }));
  r = pin(home, ["doctor", "1"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^FAIL pi-mcp-adapter 2\.35\.0 installed, template pins 2\.36\.0/m);
});

test("setup without KimiCU keeps the placeholder and doctor reports it; a wrong command path also FAILs", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  const r = pin(home, ["setup", "1"], { ADONIS_PI_KIMI_CU_BIN: "/nonexistent/kimi-cu" }); // the override is authoritative: no fallback to the app bundle or PATH
  assert.match(r.out, /KimiCU not found/);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  let d = pin(home, ["doctor", "1"]);
  assert.equal(d.code, 1);
  assert.match(d.out, /^FAIL mcp.json kimi-cu command is still \{\{KIMI_CU_BIN\}\}/m);
  const mcp = JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8"));
  mcp.mcpServers["kimi-cu"].command = "/nonexistent/kimi-cu";
  writeFileSync(join(agent, "mcp.json"), JSON.stringify(mcp, null, 2));
  d = pin(home, ["doctor", "1"]);
  assert.match(d.out, /^FAIL mcp.json kimi-cu command \/nonexistent\/kimi-cu is not an executable file/m);
  mcp.mcpServers["kimi-cu"].disabled = true;
  writeFileSync(join(agent, "mcp.json"), JSON.stringify(mcp, null, 2));
  d = pin(home, ["doctor", "1"]);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /^OK   mcp.json kimi-cu disabled$/m);
});

test("doctor resolves bare commands on PATH and checks mcp.json env references against proxy.env", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  const proxy = join(agent, "proxy.env");
  writeFileSync(proxy, "export GLM_API_KEY=abc\n");
  chmodSync(proxy, 0o600);
  let d = pin(home, ["doctor", "1"]);
  assert.equal(d.code, 0, d.out);
  assert.match(d.out, /^WARN mcp.json references \$FIGMA_API_KEY but proxy.env leaves it empty$/m);
  assert.match(d.out, /^WARN mcp.json figma-rest -> npx but proxy.env does not set \$FIGMA_API_KEY \(unavailable until it does\)$/m, "the server line says unavailable, matching startup-check");
  writeFileSync(proxy, 'export GLM_API_KEY=abc\nexport FIGMA_API_KEY=""\n');
  d = pin(home, ["doctor", "1"]);
  assert.match(d.out, /^WARN mcp.json references \$FIGMA_API_KEY but proxy.env leaves it empty$/m, "an empty quoted value is empty");
  writeFileSync(proxy, "export GLM_API_KEY=abc\nexport FIGMA_API_KEY=figd_test\n");
  d = pin(home, ["doctor", "1"]);
  assert.match(d.out, /^OK   mcp.json \$FIGMA_API_KEY provided$/m);
  assert.match(d.out, /^OK   mcp.json figma-rest -> npx \(env: \$FIGMA_API_KEY\)$/m);
  assert.doesNotMatch(d.out, /figd_test/, "doctor never prints values");
  const mcp = JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8"));
  writeFileSync(proxy, "export GLM_API_KEY=abc\nexport FIGMA_API_KEY=$FROM_ELSEWHERE\n");
  d = pin(home, ["doctor", "1"]);
  assert.match(d.out, /^WARN mcp.json \$FIGMA_API_KEY is computed when proxy.env is sourced; doctor cannot check it/m, "shell expansion is reported as unknown, not as provided or empty");
  assert.match(d.out, /^WARN mcp.json figma-rest -> npx; availability depends on \$FIGMA_API_KEY, which doctor cannot evaluate$/m);
  writeFileSync(proxy, "export GLM_API_KEY=abc\nexport FIGMA_API_KEY=figd_test\n");
  mcp.mcpServers["figma-rest"].env.EXTRA = "$HOME";
  writeFileSync(join(agent, "mcp.json"), JSON.stringify(mcp, null, 2));
  d = pin(home, ["doctor", "1"]);
  assert.match(d.out, /^WARN mcp.json figma-rest has bare \$HOME; the MCP Bridge sends that literally — if a variable was meant, write \$\{HOME\}$/m);
  assert.match(d.out, /^OK   mcp.json figma-rest -> npx \(env: \$FIGMA_API_KEY\)$/m, "a bare $VAR warns but does not make the server unavailable (it may be a deliberate literal)");
  delete mcp.mcpServers["figma-rest"].env.EXTRA;
  mcp.mcpServers["figma-rest"].command = "no-such-command-xyz";
  writeFileSync(join(agent, "mcp.json"), JSON.stringify(mcp, null, 2));
  d = pin(home, ["doctor", "1"]);
  assert.equal(d.code, 1);
  assert.match(d.out, /^FAIL mcp.json figma-rest command no-such-command-xyz is not an executable on PATH$/m);
});

test("doctor reports the pi version: OK on 0.87.x, WARN on anything else", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  writeFileSync(join(home, ".pi", "agent", "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  assert.match(pin(home, ["doctor", "1"]).out, /^OK   pi 0\.87\.0 on PATH/m);
  const r = pin(home, ["doctor", "1"], { FAKE_PI_VERSION: "0.88.0" });
  assert.equal(r.code, 0);
  assert.match(r.out, /^WARN pi 0\.88\.0 differs from the tested 0\.87\.x/m);
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
