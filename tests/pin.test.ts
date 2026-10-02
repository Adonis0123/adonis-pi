import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, readlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compareVersions, type Finding, inspectAccount, renderFinding } from "../bin/lib/account.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const PIN = join(ROOT, "bin", "pin");

const ADAPTER = "npm:pi-mcp-adapter@2.36.0";

function env(home: string, extra: Record<string, string> = {}) {
  const fakeBin = join(home, "fakebin");
  mkdirSync(fakeBin, { recursive: true });
  // Every call is logged to $HOME/pi-calls, so tests can assert setup never runs pi (no package to install).
  writeFileSync(
    join(fakeBin, "pi"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/pi-calls"\nif [ "${1:-}" = "--version" ]; then echo "${FAKE_PI_VERSION:-1.0.0}"; exit 0; fi\n' +
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
  assert.deepEqual(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).packages, [ROOT], "only this checkout: pi's built-in MCP Client needs no package");
  assert.equal(existsSync(join(home, "pi-calls")), false, "setup never runs pi (no pi install of pi-mcp-adapter)");
  assert.doesNotMatch(r.out, /pi-mcp-adapter|install/);
  assert.equal(existsSync(join(agent, "npm")), false);
  const mcp = JSON.parse(readFileSync(join(agent, "mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers["kimi-cu"].command, join(home, "fakebin", "kimi-cu"), "the placeholder is resolved to this machine's KimiCU");
  assert.equal(mcp.mcpServers.figma.enabled, false);
  assert.equal("figma-desktop" in mcp.mcpServers, false);
  assert.equal(mcp.mcpServers["figma-rest"].timeout, 180);
  assert.doesNotMatch(JSON.stringify(mcp), /clientName/, "no borrowed OAuth identity in the Template");
  assert.deepEqual(mcp.mcpServers["figma-rest"].args, ["-y", "figma-developer-mcp@0.13.2", "--stdio", "--env", "/dev/null", "--no-telemetry"], "Framelink is pinned; no cwd .env, no telemetry");
  assert.equal(mcp.mcpServers["figma-rest"].env.FIGMA_API_KEY, "${FIGMA_API_KEY}", "the Figma key stays a reference; only proxy.env holds a value");
  assert.equal(mcp.autoEnableCodemode, false, "codemode stays off; every MCP call reaches the Permission Gate as a direct mcp__ tool");
  assert.equal(mcp.settings, undefined, "no adapter-era settings block");
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
  // packages registration is the one documented amendment; ROOT is already there, so the file stays verbatim
  assert.equal(readFileSync(settings, "utf8"), edited);
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
  assert.deepEqual(json, { defaultProvider: "glm", theme: "light", packages: [ROOT] });
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
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [ROOT], theme: "light", skills: ["!x"] }, null, 2) + "\n");
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
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [ROOT, "/nonexistent/old-checkout"], lastChangelogVersion: "1.0.0" }, null, 2) + "\n");
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

test("doctor fails on pi-mcp-adapter packages and -builtin:mcp, and warns on a leftover adapter install", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  const settings = join(agent, "settings.json");
  let fs = inspect(home);
  assert.deepEqual(of(fs, "pi-mcp-adapter"), []);
  assert.equal(fs.some((f) => f.level === "FAIL"), false, "a fresh setup has no adapter and keeps the built-in MCP Client on");
  writeFileSync(settings, JSON.stringify({ packages: [ROOT, ADAPTER, "npm:pi-mcp-adapter", "npm:pi-mcp-adapter-fork@1.0.0"], extensions: ["-builtin:mcp", "./x.ts"] }, null, 2));
  fs = inspect(home);
  const fails = of(fs, "settings.json").filter((f) => f.level === "FAIL");
  assert.deepEqual(fails.map((f) => f.item), [ADAPTER, "npm:pi-mcp-adapter", "-builtin:mcp"], "every adapter spec, any version; a differently named package is not the adapter");
  assert.ok(fails[0].message.includes(`PI_CODING_AGENT_DIR=${agent} pi remove ${ADAPTER}`), fails[0].message);
  assert.match(fails[0].message, /replaces pi's built-in MCP Client/);
  assert.ok(fails[1].message.endsWith(`pi remove npm:pi-mcp-adapter)`), fails[1].message);
  assert.match(fails[2].message, /turns pi's built-in MCP Client off \(remove that entry\)/);
  const leftover = join(agent, "npm", "node_modules", "pi-mcp-adapter");
  mkdirSync(leftover, { recursive: true });
  writeFileSync(join(leftover, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "2.36.0" }));
  assert.deepEqual(of(inspect(home), "pi-mcp-adapter"), [], "with a packages entry the FAIL already says what to do");
  writeFileSync(settings, JSON.stringify({ packages: [ROOT] }, null, 2));
  fs = inspect(home);
  assert.deepEqual(levels(fs, "pi-mcp-adapter"), ["WARN"]);
  assert.ok(of(fs, "pi-mcp-adapter")[0].message.includes(leftover));
  assert.equal(fs.some((f) => f.level === "FAIL"), false, "an unloaded leftover install is not a failure");
  // pi also loads object entries ({ source }) and turns built-ins off with `!glob`; `+builtin:mcp` wins over `!`, `-` over both.
  const settingsFails = (packages: unknown[], extensions: string[]) => {
    writeFileSync(settings, JSON.stringify({ packages, extensions }, null, 2));
    return of(inspect(home), "settings.json").filter((f) => f.level === "FAIL").map((f) => f.item);
  };
  assert.deepEqual(settingsFails([ROOT, { source: ADAPTER, extensions: [] }], []), [ADAPTER], "an object packages entry loads the adapter too");
  assert.deepEqual(settingsFails([ROOT], ["!builtin:*"]), ["!builtin:*"]);
  assert.deepEqual(settingsFails([ROOT], ["!*"]), ["!*"]);
  assert.deepEqual(settingsFails([ROOT], ["!builtin:{mcp,codemode}"]), ["!builtin:{mcp,codemode}"]);
  assert.deepEqual(settingsFails([ROOT], ["!builtin:*", "+builtin:mcp"]), [], "+builtin:mcp forces it back on");
  assert.deepEqual(settingsFails([ROOT], ["+builtin:mcp", "-builtin:mcp"]), ["-builtin:mcp"]);
  assert.deepEqual(settingsFails([ROOT], ["!builtin:codemode", "-builtin:tool_search"]), [], "other built-ins are not the MCP Client");
});

test("doctor fails on every adapter-era leftover and a borrowed clientName, and still reports each server's status", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  const agent = join(home, ".pi", "agent");
  writeFileSync(join(agent, "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  writeFileSync(join(agent, "proxy.env"), "export FIGMA_API_KEY=figd_test\nexport REMOTE_TOKEN=t\n");
  chmodSync(join(agent, "proxy.env"), 0o600);
  const mcpPath = join(agent, "mcp.json");
  const migrated = readFileSync(mcpPath, "utf8");
  let fs = inspect(home);
  assert.equal(of(fs, "mcp.json").some((f) => f.level === "FAIL"), false, "the migrated Template passes");
  // The adapter-era Template shape (pi-mcp-adapter 2.36.0) as an account kept it.
  writeFileSync(
    mcpPath,
    JSON.stringify({
      settings: { toolPrefix: "server", scriptMode: false },
      mcpServers: {
        deepwiki: { url: "https://mcp.deepwiki.com/mcp", directTools: true },
        "figma-rest": { command: "npx", args: ["-y", "figma-developer-mcp@0.13.2"], env: { FIGMA_API_KEY: "$env:FIGMA_API_KEY" }, requestTimeoutMs: 180000 },
        figma: { url: "https://mcp.figma.com/mcp", disabled: true, oauth: { clientName: "Claude Code" } },
        remote: { url: "https://h.example.com/mcp?k=${REMOTE_TOKEN}" },
        own: { url: "https://own.example.com/mcp", oauth: { clientName: "pi" } },
      },
    }),
  );
  fs = inspect(home);
  const at = (item?: string) => of(fs, "mcp.json").filter((f) => f.item === item).map((f) => [f.level, f.message] as const);
  const top = at(undefined).filter(([, m]) => !m.startsWith("drift:")); // drift (missing autoEnableCodemode) is the template check, also file-level
  assert.deepEqual(top.map(([l]) => l), ["FAIL"]);
  assert.match(top[0][1], /"settings" block/);
  assert.deepEqual(at("deepwiki").map(([l]) => l), ["FAIL", "OK"], "a leftover FAILs before the status line, which still appears");
  assert.match(at("deepwiki")[0][1], /directTools.*"exposure": "direct"/);
  assert.deepEqual(at("figma-rest").map(([l]) => l), ["FAIL", "FAIL", "WARN"]);
  assert.match(at("figma-rest")[2][1], /does not set \$env /, "pi reads $env:FIGMA_API_KEY as a reference to $env");
  assert.match(at("figma-rest")[0][1], /requestTimeoutMs.*timeout/);
  assert.match(at("figma-rest")[1][1], /\$env:FIGMA_API_KEY -> \$\{FIGMA_API_KEY\}/);
  assert.deepEqual(at("figma").map(([l]) => l), ["FAIL", "FAIL", "OK"], "pi ignores disabled, so the server would connect: the status says usable");
  assert.match(at("figma")[0][1], /"disabled".*"enabled": false/);
  assert.match(at("figma")[1][1], /oauth.clientName "Claude Code" borrows another client's identity; remove oauth.clientName.*ADR 0004/);
  assert.deepEqual(at("remote").map(([l]) => l), ["FAIL", "OK"]);
  assert.match(at("remote")[0][1], /url\/cwd/);
  assert.deepEqual(at("own").map(([l]) => l), ["OK"], "clientName pi is pi's own identity");
  writeFileSync(
    mcpPath,
    JSON.stringify({
      autoEnableCodemode: false,
      mcpServers: {
        "figma-rest": { command: "npx", exposure: "direct" },
        figma_rest: { command: "npx" },
        both: { url: "https://both.example.com/mcp?t=1", command: "no-such-command-xyz" },
        sse: { type: "sse", url: "https://sse.example.com/sse" },
        registered: { url: "https://r.example.com/mcp", oauth: { clientId: "my-app" } },
        dflt: { command: "npx", env: { A: "${TOKEN:-dev}" } },
      },
    }),
  );
  fs = inspect(home);
  assert.deepEqual(at("figma_rest").map(([l]) => l), ["FAIL", "OK"], "pi treats - and _ as the same name and rejects the later one");
  assert.match(at("figma_rest")[0][1], /same server as "figma-rest"/);
  assert.deepEqual(at("both"), [["OK", "-> https://both.example.com/mcp (credentials/query hidden)"]], "pi connects the url; the command is ignored, and the url is still redacted");
  assert.deepEqual(at("sse").map(([l]) => l), ["FAIL"]);
  assert.match(at("sse")[0][1], /SSE transport is not supported.*pi rejects the entry/);
  assert.deepEqual(at("registered").map(([l]) => l), ["WARN", "OK"]);
  assert.match(at("registered")[0][1], /pre-registered oauth.clientId; keep it only if you registered that client yourself/);
  assert.deepEqual(at("dflt").map(([l]) => l), ["FAIL", "OK"]);
  assert.match(at("dflt")[0][1], /\$\{TOKEN:-dev\}, which pi sends literally/);
  writeFileSync(mcpPath, migrated);
  assert.equal(of(inspect(home), "mcp.json").some((f) => f.level === "FAIL"), false);
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
  mcp.mcpServers["kimi-cu"].enabled = false;
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
  mcp.mcpServers["figma-rest"].env.EXTRA = "team-$FIGMA_TEAM";
  writeFileSync(join(agent, "mcp.json"), JSON.stringify(mcp, null, 2));
  fs = inspect(home);
  assert.deepEqual(server(fs).map(([l]) => l), ["WARN"], "an embedded bare $VAR is a pi reference: unset, pi will not connect the server");
  assert.match(server(fs)[0][1], /does not set \$FIGMA_TEAM \(unavailable/);
  assert.deepEqual(levels(fs, "mcp.json", "$FIGMA_TEAM"), ["WARN"]);
  assert.doesNotMatch(JSON.stringify(fs), /bare/);
  mcp.mcpServers["figma-rest"].env.EXTRA = "!security find-generic-password -w -s figma";
  writeFileSync(join(agent, "mcp.json"), JSON.stringify(mcp, null, 2));
  fs = inspect(home);
  assert.deepEqual(server(fs).map(([l]) => l), ["WARN"]);
  assert.match(server(fs)[0][1], /^-> npx \(env: \$FIGMA_API_KEY\); a !command value is computed when the server connects; doctor cannot check it \(run: pin 1 mcp list\)$/);
  delete mcp.mcpServers["figma-rest"].env.EXTRA;
  mcp.mcpServers["figma-rest"].command = "no-such-command-xyz";
  mcp.mcpServers.ghost = {};
  mcp.mcpServers.remote = { url: "https://user:secret@mcp.example.com/mcp?token=abc123" };
  writeFileSync(join(agent, "mcp.json"), JSON.stringify(mcp, null, 2));
  fs = inspect(home);
  assert.deepEqual(server(fs), [["FAIL", "command no-such-command-xyz is not an executable on PATH"]]);
  assert.deepEqual(of(fs, "mcp.json", "ghost").map((f) => [f.level, f.message]), [["FAIL", "needs either \"command\" (stdio) or \"url\" (streamable HTTP); pi rejects the entry (unavailable)"]]);
  assert.deepEqual(of(fs, "mcp.json", "remote").map((f) => [f.level, f.message]), [["OK", "-> https://mcp.example.com/mcp (credentials/query hidden)"]]);
  assert.doesNotMatch(JSON.stringify(fs), /secret|abc123/, "urls are redacted before they reach a Finding");
});

test("doctor reports the pi version: OK on 1.0.x, FAIL below 0.99.2, WARN otherwise", () => {
  const home = mkdtempSync(join(tmpdir(), "pin-home-"));
  pin(home, ["setup", "1"]);
  writeFileSync(join(home, ".pi", "agent", "adonis-pi.json"), JSON.stringify({ agentsMd: "" }));
  assert.deepEqual(of(inspect(home), "pi").map((f) => [f.level, f.message.split(" on PATH")[0]]), [["OK", "1.0.0"]]);
  for (const [ver, level] of [["1.0.7", "OK"], ["1.1.0", "WARN"], ["0.99.2", "WARN"], ["0.100.0", "WARN"], ["0.99.1", "FAIL"], ["0.87.0", "FAIL"]] as const) {
    const fs = of(inspect(home, { FAKE_PI_VERSION: ver }), "pi");
    assert.deepEqual(fs.map((f) => f.level), [level], ver);
    assert.match(fs[0].message, new RegExp(ver.replaceAll(".", "\\.")));
    if (level === "FAIL") assert.match(fs[0].message, /older than 0\.99\.2.*npm install -g @earendil-works\/pi-coding-agent@1\.0\.0/);
  }
  assert.deepEqual([compareVersions("0.99.10", "0.99.2"), compareVersions("1.0.0", "1.0.0"), compareVersions("0.9.9", "0.10.0")], [1, 0, -1], "numeric, not lexical");
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
