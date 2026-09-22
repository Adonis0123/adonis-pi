import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { accountAgentDir, agentDir, envRefs, expandTilde, missingEnvRefs, resolveEnvRef, loadTemplate, loadConfig, ConfigError } from "../lib/config.ts";

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
