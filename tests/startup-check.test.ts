import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
