import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, lstatSync, readlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const PIN = join(ROOT, "bin", "pin");

function env(home: string, extra: Record<string, string> = {}) {
  const fakeBin = join(home, "fakebin");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(join(fakeBin, "pi"), '#!/bin/sh\nif [ "${1:-}" = "--version" ]; then echo "${FAKE_PI_VERSION:-0.87.0}"; exit 0; fi\nprintf "FAKE_PI %s\\n" "$*"\nenv | grep "^PI_CODING_AGENT_DIR=" || true\n');
  chmodSync(join(fakeBin, "pi"), 0o755);
  return { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, ...extra };
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
  for (const f of ["settings.json", "models.json", "adonis-pi.json", "proxy.env"]) assert.ok(existsSync(join(agent, f)), f);
  assert.deepEqual(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).packages, [ROOT]);
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
  pin(home, ["setup", "1"]);
  assert.equal(readFileSync(settings, "utf8"), edited);
  assert.equal(readFileSync(models, "utf8"), "{\"providers\":{}}\n");
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
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [ROOT], theme: "light", skills: ["!x"] }, null, 2) + "\n");
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
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ packages: [ROOT, "/nonexistent/old-checkout"], lastChangelogVersion: "0.87.0" }, null, 2) + "\n");
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
  writeFileSync(join(home, ".pi", "agent", "proxy.env"), "export GLM_API_KEY=abc\n");
  chmodSync(join(home, ".pi", "agent", "proxy.env"), 0o600);
  const r = pin(home, ["1", "--model", "glm/glm-5.3"], { PIN_DRY_RUN: "1" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`^PI_CODING_AGENT_DIR=${join(home, ".pi", "agent")}$`, "m"));
  assert.match(r.out, /^GLM_API_KEY=<set>$/m);
  assert.match(r.out, /^KIMI_API_KEY=<unset>$/m);
  assert.match(r.out, /^ADONIS_PI_NOTIFY_CMD=<unset>$/m, "every $VAR the account references is reported");
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
  const r = pin(home, ["1"], { PIN_DRY_RUN: "1", ANTHROPIC_API_KEY: "leak", OPENAI_API_KEY: "leak2" });
  assert.match(r.out, /^ANTHROPIC_API_KEY=<unset>$/m);
  assert.match(r.out, /^OPENAI_API_KEY=<unset>$/m);
});
