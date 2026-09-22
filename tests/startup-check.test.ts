import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createFakePi, fakeCtx } from "./helpers/fake-pi.ts";
import startupCheck, { envRefs, missingByFile, missingEnvRefs } from "../extensions/startup-check/index.ts";

const models = JSON.stringify({
  providers: {
    glm: { apiKey: "$GLM_API_KEY", models: [] },
    kimi: { apiKey: "${KIMI_API_KEY}", models: [] },
    local: { apiKey: "literal-key", models: [] },
  },
});

test("envRefs lists each $VAR once, sorted, ignoring literal keys", () => {
  assert.deepEqual(envRefs(models), ["GLM_API_KEY", "KIMI_API_KEY"]);
  assert.deepEqual(envRefs("{ not json"), []);
});

test("missingEnvRefs treats empty strings as missing", () => {
  assert.deepEqual(missingEnvRefs(models, { GLM_API_KEY: "x", KIMI_API_KEY: "" }), ["KIMI_API_KEY"]);
  assert.deepEqual(missingEnvRefs(models, { GLM_API_KEY: "x", KIMI_API_KEY: "y" }), []);
});

async function withAgentDir(modelsText: string | undefined, env: Record<string, string>, run: (dir: string) => Promise<void>, configText?: string) {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-start-"));
  if (modelsText !== undefined) writeFileSync(join(dir, "models.json"), modelsText);
  if (configText !== undefined) writeFileSync(join(dir, "adonis-pi.json"), configText);
  const saved = { ...process.env };
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.GLM_API_KEY;
  delete process.env.KIMI_API_KEY;
  delete process.env.ADONIS_PI_NOTIFY_CMD;
  Object.assign(process.env, env);
  try {
    await run(dir);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test("session_start at startup warns once with the missing variables and the pin hint", async () => {
  await withAgentDir(models, { GLM_API_KEY: "x", ADONIS_PI_NOTIFY_CMD: "/n" }, async () => {
    const { pi, emit } = createFakePi();
    startupCheck(pi);
    const notes: string[] = [];
    const ctx = fakeCtx({ ui: { ...fakeCtx().ui, notify: (m: string) => notes.push(m) } });
    await emit("session_start", { reason: "startup" }, ctx);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /KIMI_API_KEY/);
    assert.doesNotMatch(notes[0], /GLM_API_KEY/);
    assert.match(notes[0], /pin <n>/);
  });
});

test("nothing is said when every variable is set, on reload, without UI, or without models.json", async () => {
  await withAgentDir(models, { GLM_API_KEY: "x", KIMI_API_KEY: "y", ADONIS_PI_NOTIFY_CMD: "/n" }, async () => {
    const { pi, emit } = createFakePi();
    startupCheck(pi);
    const notes: string[] = [];
    const ctx = fakeCtx({ ui: { ...fakeCtx().ui, notify: (m: string) => notes.push(m) } });
    await emit("session_start", { reason: "startup" }, ctx);
    assert.deepEqual(notes, []);
  });
  await withAgentDir(models, {}, async () => {
    const { pi, emit } = createFakePi();
    startupCheck(pi);
    const notes: string[] = [];
    const ctx = fakeCtx({ ui: { ...fakeCtx().ui, notify: (m: string) => notes.push(m) } });
    await emit("session_start", { reason: "reload" }, ctx);
    await emit("session_start", { reason: "startup" }, fakeCtx({ hasUI: false, mode: "print", ui: { ...fakeCtx().ui, notify: (m: string) => notes.push(m) } }));
    assert.deepEqual(notes, []);
  });
  await withAgentDir(undefined, { ADONIS_PI_NOTIFY_CMD: "/n" }, async () => {
    const { pi, emit } = createFakePi();
    startupCheck(pi);
    const notes: string[] = [];
    await emit("session_start", { reason: "startup" }, fakeCtx({ ui: { ...fakeCtx().ui, notify: (m: string) => notes.push(m) } }));
    assert.deepEqual(notes, []);
  });
});

test("the notifier variable counts too: from the account adonis-pi.json, or from the template when the file is absent", async () => {
  await withAgentDir(models, { GLM_API_KEY: "x", KIMI_API_KEY: "y" }, async (dir) => {
    assert.deepEqual(missingByFile(dir, process.env), [["adonis-pi.json", ["ADONIS_PI_NOTIFY_CMD"]]]);
    const { pi, emit } = createFakePi();
    startupCheck(pi);
    const notes: string[] = [];
    await emit("session_start", { reason: "startup" }, fakeCtx({ ui: { ...fakeCtx().ui, notify: (m: string) => notes.push(m) } }));
    assert.equal(notes.length, 1);
    assert.match(notes[0], /adonis-pi\.json needs ADONIS_PI_NOTIFY_CMD/);
  });
  await withAgentDir(models, {}, async (dir) => {
    assert.deepEqual(missingByFile(dir, process.env), [["models.json", ["GLM_API_KEY", "KIMI_API_KEY"]], ["adonis-pi.json", ["MY_NOTIFIER"]]]);
  }, JSON.stringify({ notify: { command: "$MY_NOTIFIER" } }));
  await withAgentDir(models, { GLM_API_KEY: "x", KIMI_API_KEY: "y" }, async (dir) => {
    assert.deepEqual(missingByFile(dir, process.env), [], "a literal notifier path needs no variable");
  }, JSON.stringify({ notify: { command: "/opt/notify.sh" } }));
});

test("before_agent_start adds one MCP boundary section from mcp.json: enabled servers, disabled ones, placeholder counts as unavailable", async () => {
  const { mcpBoundarySection } = await import("../extensions/startup-check/index.ts");
  await withAgentDir(undefined, {}, async (dir) => {
    assert.equal(mcpBoundarySection(dir), undefined, "no mcp.json, no section");
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "kimi-cu": { command: "{{KIMI_CU_BIN}}", args: ["mcp"], directTools: true },
          deepwiki: { url: "https://mcp.deepwiki.com/mcp" },
          figma: { url: "https://mcp.figma.com/mcp", disabled: true },
        },
      }),
    );
    const section = mcpBoundarySection(dir)!;
    assert.match(section, /Available: deepwiki \(proxy: first mcp\(\{search:"deepwiki"\}\)/);
    assert.match(section, /Not available in pi: kimi-cu, figma\./);
    assert.doesNotMatch(section, /mode=ax/, "the kimi-cu hint only appears when kimi-cu is usable");
    assert.match(section, /mcpScript tool is turned off/);
    // a resolved but missing executable is "not available" too, matching pin doctor
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { "kimi-cu": { command: "/nonexistent/kimi-cu", directTools: true } } }));
    assert.match(mcpBoundarySection(dir)!, /No MCP server is enabled.*\nNot available in pi: kimi-cu/);
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { "kimi-cu": { command: process.execPath, directTools: true } } }));
    const withKimi = mcpBoundarySection(dir)!;
    assert.match(withKimi, /Available: kimi-cu \(direct tools kimi-cu_\*\)\./);
    assert.match(withKimi, /mode=ax/);
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "kimi-cu": { command: "{{KIMI_CU_BIN}}", args: ["mcp"], directTools: true },
          deepwiki: { url: "https://mcp.deepwiki.com/mcp" },
          figma: { url: "https://mcp.figma.com/mcp", disabled: true },
        },
      }),
    );
    const { pi, emit } = createFakePi();
    startupCheck(pi);
    const event = { prompt: "hi", systemPromptOptions: { sections: {} as Record<string, string> } };
    await emit("before_agent_start", event, fakeCtx());
    assert.equal(event.systemPromptOptions.sections.adonis_pi_mcp, section);
    writeFileSync(join(dir, "mcp.json"), "{ broken");
    assert.equal(mcpBoundarySection(dir), undefined, "an unreadable mcp.json adds nothing; pin doctor reports it");
  });
});

test("figma-rest is available only when its bare command resolves on PATH and every variable its env references is set", async () => {
  const { mcpBoundarySection } = await import("../extensions/startup-check/index.ts");
  await withAgentDir(undefined, { ADONIS_PI_NOTIFY_CMD: "/opt/notify.sh" }, async (dir) => {
    const bin = dirname(process.execPath);
    const write = (srv: unknown) => writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { "figma-rest": srv } }));
    write({ command: basename(process.execPath), args: ["--stdio"], env: { FIGMA_API_KEY: "${FIGMA_TEST_KEY}", FRAMELINK_TELEMETRY: "off" }, directTools: true });
    let s = mcpBoundarySection(dir, { PATH: bin })!;
    assert.match(s, /No MCP server is enabled.*\nNot available in pi: figma-rest/, "unset key: the Bridge would start the server with an empty key");
    assert.doesNotMatch(s, /REST API/, "no figma-rest hint while it is unavailable");
    s = mcpBoundarySection(dir, { PATH: bin, FIGMA_TEST_KEY: "x" })!;
    assert.match(s, /Available: figma-rest \(direct tools figma-rest_\*\)\./);
    assert.match(s, /figma-rest_get_figma_data\(fileKey, nodeId\)/);
    assert.match(s, /node-id 1-2 is nodeId 1:2/);
    s = mcpBoundarySection(dir, { PATH: "/nonexistent", FIGMA_TEST_KEY: "x" })!;
    assert.match(s, /Not available in pi: figma-rest/, "a bare command must be on PATH, as pin doctor checks");
    write({ command: basename(process.execPath), env: { PROMPT: "$HOME" }, directTools: true });
    s = mcpBoundarySection(dir, { PATH: bin })!;
    assert.match(s, /Available: figma-rest/, "a bare $VAR may be a deliberate literal: pin doctor warns, startup-check does not disable");
    write({ command: basename(process.execPath), args: ["--stdio"], env: { FIGMA_API_KEY: "${FIGMA_TEST_KEY}", FRAMELINK_TELEMETRY: "off" }, directTools: true });
    assert.deepEqual(missingByFile(dir, { ADONIS_PI_NOTIFY_CMD: "/opt/notify.sh" }), [["mcp.json", ["FIGMA_TEST_KEY"]]]);
    assert.deepEqual(missingByFile(dir, { ADONIS_PI_NOTIFY_CMD: "/opt/notify.sh", FIGMA_TEST_KEY: "x" }), []);
    write({ url: "https://mcp.deepwiki.com/mcp" });
    assert.deepEqual(missingByFile(dir, { ADONIS_PI_NOTIFY_CMD: "/opt/notify.sh" }), [], "servers without env reference nothing");
  });
});
