import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { accountAgentDir, agentDir, ConfigError, envRefs, expandTilde, loadConfig, loadTemplate, mcpBareRefs, mcpEnvRefs, mcpServerEnvRefs, missingEnvRefs, processEnvView, proxyEnvLookup, proxyEnvState, proxyEnvView, readMcpConfig, resolveCommand, resolveEnvRef, resolveKimiCuBin, serverStatus, TEMPLATES_DIR } from "../lib/config.ts";

test("agentDir honours PI_CODING_AGENT_DIR and expands ~", () => {
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/.pi-002/agent" }), join(homedir(), ".pi-002/agent"));
  assert.equal(agentDir({}), join(homedir(), ".pi", "agent"));
});

test("expandTilde only touches a leading ~", () => {
  assert.equal(expandTilde("~/x"), join(homedir(), "x"));
  assert.equal(expandTilde("/a/~/x"), "/a/~/x");
});

test("resolveEnvRef resolves $VAR and ${VAR}, leaves plain strings", () => {
  const env = { FOO: "bar" };
  assert.equal(resolveEnvRef("$FOO", env), "bar");
  assert.equal(resolveEnvRef("${FOO}", env), "bar");
  assert.equal(resolveEnvRef("$MISSING", env), undefined);
  assert.equal(resolveEnvRef("literal", env), "literal");
  assert.equal(resolveEnvRef(3, env), 3);
});

test("loadTemplate returns the shipped defaults with ask mode", () => {
  const t = loadTemplate();
  assert.equal(t.permissionGate.mode, "ask");
  assert.equal(t.notify.kinds.idle, false);
  assert.equal(t.agentsMd, "");
  assert.ok(t.permissionGate.denyTools.length > 0, "the template gates Figma canvas writes even while figma is disabled");
});

test("loadConfig merges account file over template and resolves env refs", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-cfg-"));
  const file = join(dir, "adonis-pi.json");
  writeFileSync(file, JSON.stringify({ agentsMd: "~/rules.md", notify: { kinds: { idle: true } } }));
  const cfg = loadConfig({ path: file, env: { ADONIS_PI_NOTIFY_CMD: "/opt/notify.sh" } });
  assert.equal(cfg.agentsMd, join(homedir(), "rules.md"));
  assert.equal(cfg.notify.command, "/opt/notify.sh");
  assert.equal(cfg.notify.kinds.idle, true);
  assert.equal(cfg.notify.kinds.confirm, true);
  assert.equal(cfg.permissionGate.denyCommands.length, 5);
});

test("loadConfig with a missing file returns the template", () => {
  const cfg = loadConfig({ path: "/nonexistent/adonis-pi.json", env: {} });
  assert.equal(cfg.permissionGate.mode, "ask");
  assert.equal(cfg.notify.command, undefined);
});

test("loadConfig rejects an invalid mode with ConfigError naming the field", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-cfg-"));
  const file = join(dir, "adonis-pi.json");
  writeFileSync(file, JSON.stringify({ permissionGate: { mode: "yolo" } }));
  assert.throws(() => loadConfig({ path: file, env: {} }), (e: unknown) => e instanceof ConfigError && /permissionGate\.mode/.test((e as Error).message));
});

test("loadConfig accepts mode off", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-cfg-"));
  const file = join(dir, "adonis-pi.json");
  writeFileSync(file, JSON.stringify({ permissionGate: { mode: "off" } }));
  assert.equal(loadConfig({ path: file, env: {} }).permissionGate.mode, "off");
});

test("loadConfig rejects idle without confirm", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-cfg-"));
  const file = join(dir, "adonis-pi.json");
  writeFileSync(file, JSON.stringify({ notify: { kinds: { confirm: false, idle: true } } }));
  assert.throws(() => loadConfig({ path: file, env: {} }), (e: unknown) => e instanceof ConfigError && /idle requires/.test((e as Error).message));
});

test("loadConfig rejects malformed JSON with ConfigError", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-cfg-"));
  const file = join(dir, "adonis-pi.json");
  writeFileSync(file, "{ not json");
  assert.throws(() => loadConfig({ path: file, env: {} }), ConfigError);
});

test("loadConfig rejects unknown keys at any depth so typos never become silent defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-cfg-"));
  const file = join(dir, "adonis-pi.json");
  writeFileSync(file, JSON.stringify({ notify: { kinds: { confrim: false } } }));
  assert.throws(() => loadConfig({ path: file, env: {} }), (e: unknown) => e instanceof ConfigError && /unknown key "notify\.kinds\.confrim"/.test((e as Error).message));
  writeFileSync(file, JSON.stringify({ bogus: 1 }));
  assert.throws(() => loadConfig({ path: file, env: {} }), /unknown key "bogus"/);
});

test("loadConfig extends template arrays instead of replacing them, without duplicates", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-cfg-"));
  const file = join(dir, "adonis-pi.json");
  const first = loadTemplate().permissionGate.denyCommands[0];
  writeFileSync(file, JSON.stringify({ permissionGate: { denyCommands: ["^\\s*curl\\b", first], protectedPaths: ["~/.gnupg/**"] } }));
  const cfg = loadConfig({ path: file, env: {} });
  assert.equal(cfg.permissionGate.denyCommands.length, 6);
  assert.equal(cfg.permissionGate.denyCommands.at(-1), "^\\s*curl\\b");
  assert.deepEqual(cfg.permissionGate.protectedPaths, ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**"]);
});

test("accountAgentDir follows the Family layout", () => {
  assert.equal(accountAgentDir(1, "/h"), "/h/.pi/agent");
  assert.equal(accountAgentDir(2, "/h"), "/h/.pi-002/agent");
  assert.equal(accountAgentDir(12, "/h"), "/h/.pi-012/agent");
});

test("envRefs accepts $VAR and ${VAR} in any case and skips invalid JSON", () => {
  assert.deepEqual(envRefs('{"a":"$glm_key","b":"${KIMI_API_KEY}","c":"literal $X"}'), ["KIMI_API_KEY", "glm_key"]);
  assert.deepEqual(envRefs("{nope"), []);
  assert.deepEqual(missingEnvRefs('{"a":"$A","b":"$B"}', { A: "1", B: "" }), ["B"]);
});

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

test("proxyEnvState mirrors what `. proxy.env` leaves for pi: set / empty / unknown, exported names only", () => {
  const text = [
    "export A=b # comment",
    'export B="" # comment',
    "export C=$OTHER",
    "export D=b=c",
    "  export E=b",
    "export F=b",
    "F=",
    "G=never-exported",
    'export H="quoted $X"',
    "export I='$literal'",
    'export J="a\\"b"',
    "export L=#literal",
    "export M=$HOME/bin/notify",
    'export N="${HOME}/x"',
    "export O=$HOMEX",
    "export P=gone",
    "unset P",
    "# export Q=1",
  ].join("\n");
  const env = proxyEnvState(text);
  assert.equal(env.certain, true);
  assert.deepEqual(
    Object.fromEntries(env.state),
    { A: "set", B: "empty", C: "unknown", D: "set", E: "set", F: "empty", H: "unknown", I: "set", J: "set", L: "set", M: "set", N: "set", O: "unknown" },
    "reviewer line shapes; a # inside the word is literal; $HOME is always set under pin; P was unset; G is not exported; Q is a comment",
  );
  assert.equal(proxyEnvLookup(env, "P"), "empty", "an unset or never-exported name reads as empty in a fully parsed file");
  const odd = proxyEnvState("export A=\u00a0\nexport B=\u000b\n");
  assert.deepEqual(Object.fromEntries(odd.state), { A: "set", B: "set" }, "a no-break space or vertical tab is a value to the shell, not whitespace");
  assert.equal(odd.certain, true);
  assert.equal(proxyEnvState("export C=x \u00a0\n").certain, false, "a stray non-ASCII blank after the word is a second argument to export: not a simple line");
  const noHome = proxyEnvState("unset HOME\nexport A=$HOME/x\nexport HOME=/tmp\nexport B=$HOME/y");
  assert.deepEqual(Object.fromEntries(noHome.state), { A: "unknown", HOME: "set", B: "unknown" }, "$HOME is only known while the file leaves HOME alone");
  assert.deepEqual([...env.state].filter(([, st]) => st === "set").map(([n]) => n), ["A", "D", "E", "I", "J", "L", "M", "N"]);
});

test("proxyEnvState degrades to unknown instead of guessing when a line is not a simple assignment", () => {
  for (const text of [
    "export A=b; A=", // a second command on the line
    "export A=b\nexport A=c && unset A", // a command list
    'export A="line1\nline2"', // a value spanning lines
    "export A=b\nif [ -f ~/.x ]; then . ~/.x; fi", // control flow that may change anything
    "export A=b\nexport A B", // export without assignment
    "export A=b\nunset $NAME", // unset of a computed name
    "export A=\\\n\n", // a trailing backslash continues the statement on the next line (shell: A empty)
    "export A=</dev/null", // a redirection, not a value (shell: A empty)
    "export A=\nexport B=${A:=x}", // an assigning expansion sets A as a side effect (shell: A = x)
    "export A=b\nexport B=${A=x}",
    "export A=\nexport B=$((A=1))", // arithmetic expansion can assign too (shell: A = 1)
    "export A=b\nexport B=$(A=1; echo)", // command substitution runs arbitrary code
    "export A=\r\nexport B=b\r\n", // CRLF: the shell keeps \r as part of every value
  ]) {
    const env = proxyEnvState(text);
    assert.equal(env.certain, false, text);
    assert.equal(proxyEnvLookup(env, "A"), "unknown", text);
    assert.equal(proxyEnvLookup(env, "NEVER_MENTIONED"), "unknown", `${text}: an unparsed line could have set anything`);
    assert.equal([...env.state.values()].every((st) => st === "unknown"), true, text);
  }
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

test("resolveKimiCuBin only accepts executable files, from the override, the app bundle or PATH", () => {
  assert.equal(resolveKimiCuBin({ ADONIS_PI_KIMI_CU_BIN: dirname(process.execPath) }), undefined, "a directory is not the executable");
  assert.equal(resolveKimiCuBin({ ADONIS_PI_KIMI_CU_BIN: process.execPath }), process.execPath);
});

test("loadConfig enforces the schema's idleDelaySeconds constraint: integer >= 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-cfg-"));
  const file = join(dir, "adonis-pi.json");
  for (const bad of [-1, 1.5]) {
    writeFileSync(file, JSON.stringify({ notify: { idleDelaySeconds: bad } }));
    assert.throws(() => loadConfig({ path: file }), /idleDelaySeconds must be an integer >= 0/);
  }
  writeFileSync(file, JSON.stringify({ notify: { idleDelaySeconds: 0 } }));
  assert.equal(loadConfig({ path: file }).notify.idleDelaySeconds, 0);
});
