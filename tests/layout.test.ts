import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountAgentDir, agentDir, expandTilde } from "../lib/layout.ts";

test("agentDir honours PI_CODING_AGENT_DIR and expands ~", () => {
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/.pi-002/agent" }), join(homedir(), ".pi-002/agent"));
  assert.equal(agentDir({}), join(homedir(), ".pi", "agent"));
});

test("expandTilde only touches a leading ~", () => {
  assert.equal(expandTilde("~/x"), join(homedir(), "x"));
  assert.equal(expandTilde("/a/~/x"), "/a/~/x");
});

test("accountAgentDir follows the Family layout", () => {
  assert.equal(accountAgentDir(1, "/h"), "/h/.pi/agent");
  assert.equal(accountAgentDir(2, "/h"), "/h/.pi-002/agent");
  assert.equal(accountAgentDir(12, "/h"), "/h/.pi-012/agent");
});
