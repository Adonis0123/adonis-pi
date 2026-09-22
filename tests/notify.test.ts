import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { buildPayload, classifyError, filterEnv, sendNotify, sessionRef, lastAssistantText } from "../lib/notify.ts";

const CAPTURE = fileURLToPath(new URL("./fixtures/capture-notify.sh", import.meta.url));
const notifyCfg = (command: string | undefined, idle = false) => ({
  command,
  kinds: { confirm: true, fail: true, idle },
  idleDelaySeconds: 45,
});

async function waitFor(file: string) {
  // The fixture writes several lines; SECRETS is the last one, so wait for it instead of the file's existence.
  for (let i = 0; i < 100; i++) {
    if (existsSync(file) && readFileSync(file, "utf8").includes("SECRETS")) break;
    await sleep(20);
  }
  return readFileSync(file, "utf8");
}

test("sessionRef prefers getSessionId, then the session file basename, then nosession", () => {
  assert.equal(sessionRef({ cwd: "/p", sessionManager: { getSessionId: () => "sid-1", getSessionFile: () => "/s/x.jsonl" } }).sessionId, "sid-1");
  const ref = sessionRef({ cwd: "/p", sessionManager: { getSessionFile: () => "/s/2026-09-22T10-00-00_abc.jsonl" } });
  assert.equal(ref.sessionId, "2026-09-22T10-00-00_abc");
  assert.equal(ref.cwd, "/p");
  assert.equal(sessionRef({ cwd: "/p", sessionManager: {} }).sessionId, "nosession");
});

test("filterEnv strips provider secrets and keeps everything else", () => {
  const out = filterEnv({ GLM_API_KEY: "a", KIMI_API_KEY: "b", ANTHROPIC_AUTH_TOKEN: "c", OPENAI_BASE_URL: "d", ADONIS_PI_NOTIFY_CMD: "/n", PATH: "/bin", HOME: "/h" });
  assert.deepEqual(out, { ADONIS_PI_NOTIFY_CMD: "/n", PATH: "/bin", HOME: "/h" });
});

test("buildPayload emits Claude-dialect hook JSON per kind", () => {
  const ref = { sessionId: "s1", cwd: "/p" };
  assert.deepEqual(buildPayload("question", ref, { tool_input: { questions: [{ question: "A or B?" }] } }), {
    hook_event_name: "PreToolUse", session_id: "s1", cwd: "/p", tool_name: "AskUserQuestion",
    tool_input: { questions: [{ question: "A or B?" }] },
  });
  assert.deepEqual(buildPayload("permission", ref, { tool_name: "bash", tool_input: { command: "sudo x" } }), {
    hook_event_name: "PermissionRequest", session_id: "s1", cwd: "/p", tool_name: "bash", tool_input: { command: "sudo x" },
  });
  assert.deepEqual(buildPayload("fail", ref, { error: "billing_error", error_details: "402" }), {
    hook_event_name: "StopFailure", session_id: "s1", cwd: "/p", error: "billing_error", error_details: "402",
  });
  assert.deepEqual(buildPayload("stop", ref, { last_assistant_message: "done?" }), {
    hook_event_name: "Stop", session_id: "s1", cwd: "/p", last_assistant_message: "done?",
  });
  assert.deepEqual(buildPayload("mark", ref, { tool_name: "read" }), {
    hook_event_name: "PostToolUse", session_id: "s1", cwd: "/p", tool_name: "read",
  });
});

test("classifyError maps actionable provider errors and ignores transient ones", () => {
  assert.equal(classifyError("401 Unauthorized: invalid api key"), "authentication_failed");
  assert.equal(classifyError("HTTP 403 forbidden"), "authentication_failed");
  assert.equal(classifyError("402 insufficient balance"), "billing_error");
  assert.equal(classifyError("You exceeded your current quota"), "billing_error");
  assert.equal(classifyError("model k3-9m does not exist"), "model_not_found");
  assert.equal(classifyError("429 rate limit exceeded"), undefined);
  assert.equal(classifyError("500 overloaded"), undefined);
});

test("lastAssistantText joins text blocks of the last assistant message", () => {
  const r = lastAssistantText([
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "x" }, { type: "text", text: "b" }], stopReason: "stop" },
    { role: "toolResult", content: [] },
  ]);
  assert.deepEqual(r, { text: "a\nb", stopReason: "stop", errorMessage: undefined });
  assert.equal(lastAssistantText([{ role: "user", content: "x" }]), undefined);
});

test("sendNotify spawns the command with --agent pi, pipes JSON, passes idle env, strips secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-notify-"));
  const file = join(dir, "capture.txt");
  const env = { ...process.env, CAPTURE_FILE: file, GLM_API_KEY: "leak", ANTHROPIC_API_KEY: "leak2" };
  const sent = sendNotify(notifyCfg(CAPTURE, true), ["--agent", "pi", "--mark"], { hook_event_name: "PostToolUse" }, { env });
  assert.equal(sent, true);
  const out = await waitFor(file);
  assert.match(out, /^ARGS --agent pi --mark$/m);
  assert.match(out, /^STDIN \{"hook_event_name":"PostToolUse"\}$/m);
  assert.match(out, /^ENV AGENT_ATTENTION_IDLE=1 AGENT_ATTENTION_IDLE_DELAY=45$/m);
  assert.match(out, /^SECRETS $/m);
});

test("sendNotify is a no-op when the command is unset", () => {
  assert.equal(sendNotify(notifyCfg(undefined), ["--agent", "pi"], {}), false);
});

test("sendNotify swallows a missing executable instead of throwing", () => {
  assert.equal(sendNotify(notifyCfg("/nonexistent/notifier"), ["--agent", "pi"], {}), true);
});
