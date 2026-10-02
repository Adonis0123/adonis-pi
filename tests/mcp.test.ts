import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { proxyEnvState, proxyEnvView } from "../lib/environment.ts";
import { TEMPLATES_DIR } from "../lib/layout.ts";
// pi 1.0.0's own parser and validator, imported by path (its package exports hide them): the oracle for our mirror.
import { getConfigValueEnvVarNames } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/resolve-config-value.js";
import { validateMcpServerConfig } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/mcp-servers.js";
import { borrowedClientName, mcpConfigLeftovers, mcpNameConflicts, mcpTransport, preRegisteredClientId, mcpEnvRefs, mcpServerEnvRefs, mcpServerLeftovers, mcpToolName, processEnvView, readMcpConfig, resolveCommand, serverStatus } from "../lib/mcp.ts";

test("resolveCommand: a path must be an executable file as given, a bare name is looked up on PATH", () => {
  assert.equal(resolveCommand(process.execPath), process.execPath);
  assert.equal(resolveCommand("/nonexistent/bin/x"), undefined);
  assert.equal(resolveCommand(basename(process.execPath), { PATH: `/nonexistent::${dirname(process.execPath)}` }), process.execPath, "empty PATH entries are skipped");
  assert.equal(resolveCommand("no-such-command-xyz", { PATH: dirname(process.execPath) }), undefined);
  assert.equal(resolveCommand("no-such-command-xyz", {}), undefined);
  assert.equal(resolveCommand("", { PATH: dirname(process.execPath) }), undefined, "an empty command never resolves to a directory");
  assert.equal(resolveCommand(dirname(process.execPath)), undefined, "a directory is not a command");
  assert.equal(resolveCommand(join(TEMPLATES_DIR, "mcp.json")), undefined, "a non-executable file is not a command");
});

test("MCP env references follow pi's config-value grammar, checked against pi's own parser", () => {
  const corpus = ["${KEY_A}", "Bearer $KEY_B", "!security find-generic-password -s x -w", "literal", "cost $$5 and $!bang", "${A $B}", "${FOO:-$BAR}", "${UNCLOSED", "$", "$1x", "a${X}b$Y-c", "${_U}", "$$${D}", "x$", "${}", "$!{E}"];
  for (const v of corpus) {
    const ours = mcpServerEnvRefs({ command: "x", env: { V: v } });
    const pi = [...new Set(getConfigValueEnvVarNames(v) as string[])].sort();
    assert.deepEqual(ours, pi, `value ${JSON.stringify(v)}`);
  }
  // Which fields count follows the transport pi picks: env for stdio; headers and oauth.clientSecret for http; url as written.
  assert.deepEqual(mcpServerEnvRefs({ command: "x", env: { A: "${KEY_A}" }, headers: { H: "${KEY_H}" } }), ["KEY_A"]);
  assert.deepEqual(mcpServerEnvRefs({ url: "https://h/${KEY_U}", headers: { H: "Bearer $KEY_H" }, env: { A: "${KEY_A}" }, oauth: { clientSecret: "${KEY_S}" } }), ["KEY_H", "KEY_S"]);
  assert.deepEqual(mcpServerEnvRefs({ url: "https://mcp.deepwiki.com/mcp" }), []);
});

test("mcpTransport picks what pi connects: url over command, type must agree, sse rejected; agrees with pi's validator on validity", () => {
  const u = "https://h/x";
  const cases: object[] = [
    { url: u }, { command: "x" }, { url: u, command: "x" }, { type: "sse", url: u }, { type: "stdio", url: u }, { type: "http", command: "x" }, {}, { type: "streamable-http", url: u },
    { url: "mcp.figma.com/mcp" }, { url: "ftp://h/x" }, { url: u, exposure: "Direct" }, { url: u, exposure: "codemode-deferred" }, { url: u, toolExposure: { a: "nope" } }, { url: u, toolExposure: [] },
    { url: u, toolExposure: { a: "codemode-deferred" } }, { url: u, enabled: "false" }, { url: u, timeout: 0 }, { url: u, timeout: "5" }, { url: u, timeout: 1.5 }, { url: u, description: 3 },
    { url: u, headers: { A: 1 } }, { url: u, headers: [] }, { url: u, oauth: [] }, { url: u, oauth: { clientId: 1 } }, { url: u, oauth: { callbackPort: 70000 } }, { url: u, oauth: { callbackUrl: "https://localhost/cb" } },
    { url: u, oauth: { callbackUrl: "http://127.0.0.1:9/cb", callbackPort: 8 } }, { url: u, oauth: { callbackUrl: "http://localhost/cb?x=1" } }, { url: u, oauth: { clientName: " " } }, { url: u, oauth: { clientName: "pi" } },
    { url: u, oauth: { authServerMetadataUrl: "http://example.com/m" } }, { url: u, oauth: { authServerMetadataUrl: "http://localhost/m" } }, { url: u, oauth: { scope: 1 } },
    { url: u, auth: { provider: "" } }, { url: "http://example.com/mcp", auth: { provider: "p" } }, { url: "http://127.0.0.1:1/mcp", auth: { provider: "p" } },
    { command: "x", args: "a" }, { command: "x", args: [1] }, { command: "x", env: { A: 1 } }, { command: "x", cwd: 1 }, { command: 1 }, { url: 1, command: "x" },
  ];
  for (const c of cases) {
    const pi = validateMcpServerConfig("s", c);
    const ours = mcpTransport(c as never);
    assert.equal(ours.kind === "invalid", typeof pi === "string", JSON.stringify(c));
    if (typeof pi === "string" && ours.kind === "invalid") assert.ok(pi.endsWith(ours.reason), `${JSON.stringify(c)}: pi "${pi}" vs ours "${ours.reason}"`);
  }
  for (const n of ["ok-name_1", "bad name", "x.y", ""]) assert.equal(mcpTransport({ url: u }, n).kind === "invalid", typeof validateMcpServerConfig(n, { url: u }) === "string", n);
  assert.deepEqual(mcpTransport({ url: "https://h/x", command: "x" }), { kind: "http", url: "https://h/x" });
  assert.equal(mcpNameConflicts({ mcpServers: { "figma-rest": {}, figma_rest: {}, a: {} } }).length, 1);
  assert.deepEqual(mcpNameConflicts({ mcpServers: { "figma-rest": {}, figma_rest: {} } }), [["figma_rest", "figma-rest"]]);
  assert.equal(preRegisteredClientId({ url: "u", oauth: { clientId: "abc" } }), "abc");
  assert.equal(preRegisteredClientId({ url: "u" }), undefined);
});

test("tool names follow pi: mcp__<server>__<tool> with every non-alphanumeric turned into _", () => {
  assert.equal(mcpToolName("kimi-cu", "get_app_state"), "mcp__kimi_cu__get_app_state");
  assert.equal(mcpToolName("figma", "use_figma"), "mcp__figma__use_figma");
});

test("pi-mcp-adapter leftovers are named with their fix; a non-pi oauth.clientName is a borrowed identity", () => {
  const legacy = { url: "https://h/x?k={env:K}", disabled: true, directTools: true, requestTimeoutMs: 1000, headers: { A: "Bearer $env:TOKEN" } } as never;
  const found = mcpServerLeftovers(legacy);
  assert.equal(found.length, 4, found.join("\n"));
  assert.match(mcpServerLeftovers({ command: "x", env: { A: "${TOKEN:-dev}" } }).join(), /\$\{TOKEN:-dev\}, which pi sends literally/);
  assert.match(found[0], /"disabled".*"enabled": false/);
  assert.match(found.join("\n"), /\$env:TOKEN -> \$\{TOKEN\}/);
  assert.match(found.join("\n"), /\{env:K\} -> \$\{K\}/);
  assert.deepEqual(mcpServerLeftovers({ url: "https://h/${K}" }), ["has ${VAR} in url/cwd, which pi sends literally; move the value into headers or env"]);
  assert.deepEqual(mcpServerLeftovers({ command: "x", env: { A: "${K}" }, enabled: false, exposure: "direct", timeout: 5 }), []);
  assert.equal(mcpConfigLeftovers({ settings: {}, mcpServers: {} } as never).length, 1);
  assert.equal(borrowedClientName({ url: "u", oauth: { clientName: "Claude Code" } }), "Claude Code");
  assert.equal(borrowedClientName({ url: "u", oauth: { clientName: "pi" } }), undefined);
  assert.equal(borrowedClientName({ url: "u" }), undefined);
});

test("the MCP template is pi-native: direct exposure, no codemode, Framelink pinned with telemetry off, Figma placeholders off, no borrowed identity", () => {
  const text = readFileSync(join(TEMPLATES_DIR, "mcp.json"), "utf8");
  const cfg = readMcpConfig(join(TEMPLATES_DIR, "mcp.json"));
  assert.equal(cfg.autoEnableCodemode, false);
  assert.deepEqual(mcpConfigLeftovers(cfg), []);
  for (const [name, srv] of Object.entries(cfg.mcpServers)) {
    assert.deepEqual(mcpServerLeftovers(srv), [], name);
    assert.equal(borrowedClientName(srv), undefined, name);
  }
  assert.deepEqual(mcpEnvRefs(cfg), ["FIGMA_API_KEY"]);
  assert.deepEqual(cfg.mcpServers["figma-rest"].args, ["-y", "figma-developer-mcp@0.13.2", "--stdio", "--env", "/dev/null", "--no-telemetry"], "no cwd .env can override the key or re-enable telemetry");
  assert.equal(cfg.mcpServers["figma-rest"].env?.FRAMELINK_TELEMETRY, "off");
  assert.equal(cfg.mcpServers["figma-rest"].timeout, 180);
  for (const n of ["kimi-cu", "deepwiki", "figma-rest"]) assert.equal(cfg.mcpServers[n].exposure, "direct", n);
  assert.deepEqual(Object.keys(cfg.mcpServers), ["kimi-cu", "deepwiki", "figma-rest", "figma"], "figma-rest is the Figma fallback; no Desktop server");
  assert.equal(cfg.mcpServers.figma.enabled, false, "the official remote server stays a disabled placeholder");
  assert.doesNotMatch(text, /clientName/);
  assert.doesNotMatch(text, /figd_/, "no token in the Repo Layer");
});

test("serverStatus is the single verdict doctor and startup-check present: disabled, placeholder, no target, bad command, empty or unknown env", () => {
  const bin = dirname(process.execPath);
  const cmd = basename(process.execPath);
  const view = { env: processEnvView({ KEY: "x", EMPTY: "" }), path: bin };
  assert.deepEqual(serverStatus({ command: cmd, env: { A: "${KEY}" } }, view), { usable: true, target: cmd, refs: ["KEY"], computed: false });
  assert.deepEqual(serverStatus({ url: "https://h/x" }, view), { usable: true, target: "https://h/x", refs: [], computed: false });
  assert.deepEqual(serverStatus({ url: "https://h/x", headers: { A: "!gh auth token" } }, view), { usable: true, target: "https://h/x", refs: [], computed: true }, "a !command value is only known on connect");
  assert.deepEqual(serverStatus({ command: cmd, enabled: false }, view), { usable: false, kind: "disabled" });
  assert.equal(serverStatus({ command: cmd, disabled: true } as never, view).usable, true, "pi ignores the adapter's disabled; doctor flags it as a leftover");
  assert.deepEqual(serverStatus({ command: "{{KIMI_CU_BIN}}" }, view), { usable: false, kind: "placeholder", command: "{{KIMI_CU_BIN}}" });
  assert.deepEqual(serverStatus({}, view), { usable: false, kind: "invalid", reason: "needs either \"command\" (stdio) or \"url\" (streamable HTTP)" }, "neither command nor url is unusable for both presenters");
  assert.equal(serverStatus({ type: "sse", url: "https://h/x" }, view).usable, false, "pi rejects sse");
  assert.deepEqual(serverStatus({ url: "https://h/x", command: "no-such-command-xyz" }, view), { usable: true, target: "https://h/x", refs: [], computed: false }, "pi connects the url and ignores the command");
  assert.deepEqual(serverStatus({ command: "no-such-command-xyz" }, view), { usable: false, kind: "command-unresolved", command: "no-such-command-xyz" });
  assert.deepEqual(serverStatus({ command: cmd, env: { A: "${EMPTY}", B: "${MISSING}" } }, view), { usable: false, kind: "env-empty", target: cmd, vars: ["EMPTY", "MISSING"] });
  const parsed = proxyEnvState("export KEY=$OTHER\n");
  assert.deepEqual(serverStatus({ command: cmd, env: { A: "${KEY}" } }, { env: proxyEnvView(parsed), path: bin }), { usable: false, kind: "env-unknown", target: cmd, vars: ["KEY"] });
  assert.deepEqual(serverStatus({ command: cmd, env: { A: "$HOME" } }, view), { usable: false, kind: "env-empty", target: cmd, vars: ["HOME"] }, "a bare $VAR is a reference in pi");
});
