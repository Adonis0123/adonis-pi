import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { proxyEnvState, proxyEnvView } from "../lib/environment.ts";
import { TEMPLATES_DIR } from "../lib/layout.ts";
import { mcpBareRefs, mcpEnvRefs, mcpServerEnvRefs, processEnvView, readMcpConfig, resolveCommand, serverStatus } from "../lib/mcp.ts";

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

test("MCP env references follow the Bridge's syntax: ${VAR}, $env:VAR, {env:VAR} anywhere; a bare $VAR is a mistake, not a reference", () => {
  const srv = { command: "x", env: { A: "${KEY_A}", B: "Bearer $env:KEY_B", C: "{env:KEY_C}/x", D: "literal", E: "$KEY_E" }, url: "https://h/${KEY_U}", headers: { H: "${KEY_A}" } };
  assert.deepEqual(mcpServerEnvRefs(srv), ["KEY_A", "KEY_B", "KEY_C", "KEY_U"]);
  assert.deepEqual(mcpBareRefs(srv), ["KEY_E"]);
  assert.deepEqual(mcpServerEnvRefs({ url: "https://mcp.deepwiki.com/mcp" }), []);
  assert.deepEqual(mcpBareRefs({ url: "https://mcp.deepwiki.com/mcp" }), []);
});

test("the MCP template pins Framelink, references the Figma key by variable only and turns its telemetry off", () => {
  const text = readFileSync(join(TEMPLATES_DIR, "mcp.json"), "utf8");
  const cfg = readMcpConfig(join(TEMPLATES_DIR, "mcp.json"));
  assert.deepEqual(mcpEnvRefs(cfg), ["FIGMA_API_KEY"]);
  assert.deepEqual(cfg.mcpServers["figma-rest"].args, ["-y", "figma-developer-mcp@0.13.2", "--stdio", "--env", "/dev/null", "--no-telemetry"], "no cwd .env can override the key or re-enable telemetry");
  assert.deepEqual(mcpBareRefs(cfg.mcpServers["figma-rest"]), []);
  assert.equal(cfg.mcpServers["figma-rest"].env?.FRAMELINK_TELEMETRY, "off");
  assert.equal(cfg.mcpServers.figma.disabled, true, "the official remote server stays a disabled placeholder");
  assert.doesNotMatch(text, /figd_/, "no token in the Repo Layer");
});

test("serverStatus is the single verdict doctor and startup-check present: disabled, placeholder, no target, bad command, empty or unknown env", () => {
  const bin = dirname(process.execPath);
  const cmd = basename(process.execPath);
  const view = { env: processEnvView({ KEY: "x", EMPTY: "" }), path: bin };
  assert.deepEqual(serverStatus({ command: cmd, env: { A: "${KEY}" } }, view), { usable: true, target: cmd, refs: ["KEY"] });
  assert.deepEqual(serverStatus({ url: "https://h/x" }, view), { usable: true, target: "https://h/x", refs: [] });
  assert.deepEqual(serverStatus({ command: cmd, disabled: true }, view), { usable: false, kind: "disabled" });
  assert.deepEqual(serverStatus({ command: "{{KIMI_CU_BIN}}" }, view), { usable: false, kind: "placeholder", command: "{{KIMI_CU_BIN}}" });
  assert.deepEqual(serverStatus({}, view), { usable: false, kind: "no-target" }, "neither command nor url is unusable for both presenters");
  assert.deepEqual(serverStatus({ command: "no-such-command-xyz" }, view), { usable: false, kind: "command-unresolved", command: "no-such-command-xyz" });
  assert.deepEqual(serverStatus({ command: cmd, env: { A: "${EMPTY}", B: "${MISSING}" } }, view), { usable: false, kind: "env-empty", target: cmd, vars: ["EMPTY", "MISSING"] });
  const parsed = proxyEnvState("export KEY=$OTHER\n");
  assert.deepEqual(serverStatus({ command: cmd, env: { A: "${KEY}" } }, { env: proxyEnvView(parsed), path: bin }), { usable: false, kind: "env-unknown", target: cmd, vars: ["KEY"] });
  assert.deepEqual(serverStatus({ command: cmd, env: { A: "$HOME" } }, view), { usable: true, target: cmd, refs: [] }, "a bare $VAR is not a reference; the Bridge passes it through");
});
