import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountRefs } from "../lib/refs.ts";

test("accountRefs: every $VAR an account references, by file in report order, in each file's own grammar", () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-refs-"));
  writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { glm: { apiKey: "$GLM_API_KEY" }, kimi: { apiKey: "${KIMI_API_KEY}" }, local: { apiKey: "literal" } } }));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: { "figma-rest": { command: "npx", env: { FIGMA_API_KEY: "${FIGMA_API_KEY}", PROMPT: "$HOME" } }, remote: { url: "https://h/x?k=$env:REMOTE_KEY" } } }));
  assert.deepEqual(accountRefs(dir), [
    { file: "models.json", name: "GLM_API_KEY" },
    { file: "models.json", name: "KIMI_API_KEY" },
    { file: "adonis-pi.json", name: "ADONIS_PI_NOTIFY_CMD" },
    { file: "mcp.json", name: "FIGMA_API_KEY" },
    { file: "mcp.json", name: "REMOTE_KEY" },
  ], "the template notifier counts while the account has no adonis-pi.json; a bare $HOME in mcp.json is not a Bridge reference");
  writeFileSync(join(dir, "adonis-pi.json"), JSON.stringify({ notify: { command: "/opt/notify.sh" } }));
  writeFileSync(join(dir, "mcp.json"), "{ broken");
  assert.deepEqual(accountRefs(dir), [
    { file: "models.json", name: "GLM_API_KEY" },
    { file: "models.json", name: "KIMI_API_KEY" },
  ], "a literal notifier references nothing; an unreadable mcp.json is doctor's finding, not a variable");
});
