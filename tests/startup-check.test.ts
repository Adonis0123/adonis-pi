import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createFakePi, fakeCtx } from "./helpers/fake-pi.ts";
import startupCheck, { missingByFile } from "../extensions/startup-check/index.ts";

const models = JSON.stringify({
  providers: {
    glm: { apiKey: "$GLM_API_KEY", models: [] },
    kimi: { apiKey: "${KIMI_API_KEY}", models: [] },
    local: { apiKey: "literal-key", models: [] },
  },
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
          "kimi-cu": { command: "{{KIMI_CU_BIN}}", args: ["mcp"], exposure: "direct" },
          deepwiki: { url: "https://mcp.deepwiki.com/mcp" },
          figma: { url: "https://mcp.figma.com/mcp", enabled: false },
        },
      }),
    );
    const section = mcpBoundarySection(dir)!;
    assert.match(section, /^MCP tools here come from pi's built-in MCP Client and are named mcp__<server>__<tool>/);
    assert.match(section, /\(kimi-cu: mcp__kimi_cu__get_app_state\)\. Claude Code keeps the hyphen \(mcp__kimi-cu__…\), so map tool names in shared skills by meaning/);
    assert.match(section, /Available: deepwiki \(mcp__deepwiki__\*: only from codemode scripts\)\./, "absent exposure is pi's default, codemode");
    assert.match(section, /Not available in pi: kimi-cu, figma\./);
    assert.doesNotMatch(section, /mode=ax/, "the kimi-cu hint only appears when kimi-cu is usable");
    assert.doesNotMatch(section, /pi-mcp-adapter|mcpScript|mcp\(\{/, "no adapter or meta-tool wording");
    // a resolved but missing executable is "not available" too, matching pin doctor
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { "kimi-cu": { command: "/nonexistent/kimi-cu", exposure: "direct" } } }));
    assert.match(mcpBoundarySection(dir)!, /No MCP server is enabled.*\nNot available in pi: kimi-cu/);
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { "kimi-cu": { command: process.execPath, exposure: "direct" } } }));
    const withKimi = mcpBoundarySection(dir)!;
    assert.match(withKimi, /Available: kimi-cu \(direct tools mcp__kimi_cu__\*\)\./);
    assert.match(withKimi, /call mcp__kimi_cu__get_app_state with mode=ax/);
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "kimi-cu": { command: "{{KIMI_CU_BIN}}", args: ["mcp"], exposure: "direct" },
          deepwiki: { url: "https://mcp.deepwiki.com/mcp" },
          figma: { url: "https://mcp.figma.com/mcp", enabled: false },
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

test("each usable server is phrased by its exposure; hidden counts as not available", async () => {
  const { mcpBoundarySection } = await import("../extensions/startup-check/index.ts");
  await withAgentDir(undefined, {}, async (dir) => {
    const url = "https://example.com/mcp";
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          a: { url, exposure: "direct" },
          "b-x": { url, exposure: "deferred" },
          c: { url, exposure: "codemode" },
          d: { url },
          e: { url, exposure: "hidden" },
        },
      }),
    );
    const s = mcpBoundarySection(dir)!;
    assert.match(
      s,
      /Available: a \(direct tools mcp__a__\*\); b-x \(mcp__b_x__\*: load with tool_search first, or call from codemode scripts\); c \(mcp__c__\*: load with tool_search first, or call from codemode scripts\); d \(mcp__d__\*: load with tool_search first, or call from codemode scripts\)\./,
      "one deferred server activates tool_search, which reaches every codemode tool too",
    );
    assert.match(s, /Not available in pi: e\./);
    // With codemode off (the Template's autoEnableCodemode: false), codemode servers are unreachable; per-tool overrides are flagged.
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ autoEnableCodemode: false, mcpServers: { a: { url, exposure: "direct", toolExposure: { "x_*": "hidden" } }, c: { url, exposure: "codemode" }, d: { url } } }));
    const off = mcpBoundarySection(dir)!;
    assert.match(off, /Available: a \(direct tools mcp__a__\*; some tools have their own exposure\)\./);
    assert.match(off, /Not available in pi: c, d\./);
    // pi's routes are account-wide: with codemode off, one deferred server's tool_search still reaches the codemode ones.
    writeFileSync(join(dir, "mcp.json"), JSON.stringify({ autoEnableCodemode: false, mcpServers: { b: { url, exposure: "deferred" }, d: { url }, h: { url, exposure: "hidden", toolExposure: { read_x: "direct" } }, z: { url, exposure: "hidden" } } }));
    const ts = mcpBoundarySection(dir)!;
    assert.match(ts, /Available: b \(mcp__b__\*: load with tool_search first\); d \(mcp__d__\*: load with tool_search first\); h \(only the tools its toolExposure exposes, mcp__h__\*\)\./);
    assert.match(ts, /Not available in pi: z\./);
  });
});

test("figma-rest is available only when its bare command resolves on PATH and every variable its env references is set", async () => {
  const { mcpBoundarySection } = await import("../extensions/startup-check/index.ts");
  await withAgentDir(undefined, { ADONIS_PI_NOTIFY_CMD: "/opt/notify.sh" }, async (dir) => {
    const bin = dirname(process.execPath);
    const write = (srv: unknown) => writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { "figma-rest": srv } }));
    write({ command: basename(process.execPath), args: ["--stdio"], env: { FIGMA_API_KEY: "${FIGMA_TEST_KEY}", FRAMELINK_TELEMETRY: "off" }, exposure: "direct" });
    let s = mcpBoundarySection(dir, { PATH: bin })!;
    assert.match(s, /No MCP server is enabled.*\nNot available in pi: figma-rest/, "unset key: pi fails to connect the server");
    assert.doesNotMatch(s, /REST API/, "no figma-rest hint while it is unavailable");
    s = mcpBoundarySection(dir, { PATH: bin, FIGMA_TEST_KEY: "x" })!;
    assert.match(s, /Available: figma-rest \(direct tools mcp__figma_rest__\*\)\./);
    assert.match(s, /mcp__figma_rest__get_figma_data\(fileKey, nodeId\)/);
    assert.match(s, /mcp__figma_rest__download_figma_images saves PNG\/SVG exports/);
    assert.match(s, /node-id 1-2 is nodeId 1:2/);
    s = mcpBoundarySection(dir, { PATH: "/nonexistent", FIGMA_TEST_KEY: "x" })!;
    assert.match(s, /Not available in pi: figma-rest/, "a bare command must be on PATH, as pin doctor checks");
    write({ command: basename(process.execPath), env: { PROMPT: "$HOME" }, exposure: "direct" });
    assert.match(mcpBoundarySection(dir, { PATH: bin })!, /Not available in pi: figma-rest/, "a bare $VAR is a real reference in pi: unset means unavailable");
    assert.match(mcpBoundarySection(dir, { PATH: bin, HOME: "/h" })!, /Available: figma-rest/);
    write({ command: basename(process.execPath), env: { FIGMA_API_KEY: "!security find-generic-password -w" }, exposure: "direct" });
    assert.match(mcpBoundarySection(dir, { PATH: bin })!, /Available: figma-rest/, "a computed !command value is usable here; only connecting shows its outcome");
    write({ command: basename(process.execPath), args: ["--stdio"], env: { FIGMA_API_KEY: "${FIGMA_TEST_KEY}", FRAMELINK_TELEMETRY: "off" }, exposure: "direct" });
    assert.deepEqual(missingByFile(dir, { ADONIS_PI_NOTIFY_CMD: "/opt/notify.sh" }), [["mcp.json", ["FIGMA_TEST_KEY"]]]);
    assert.deepEqual(missingByFile(dir, { ADONIS_PI_NOTIFY_CMD: "/opt/notify.sh", FIGMA_TEST_KEY: "x" }), []);
    write({ url: "https://mcp.deepwiki.com/mcp" });
    assert.deepEqual(missingByFile(dir, { ADONIS_PI_NOTIFY_CMD: "/opt/notify.sh" }), [], "servers without env reference nothing");
    write({});
    assert.match(mcpBoundarySection(dir, { PATH: bin })!, /No MCP server is enabled.*\nNot available in pi: figma-rest/, "neither command nor url: unavailable here exactly as pin doctor says");
  });
});
