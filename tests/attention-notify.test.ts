import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createFakePi, fakeCtx } from "./helpers/fake-pi.ts";
import attentionNotify, { decideSettled, lastAssistantFromBranch } from "../extensions/attention-notify/index.ts";
import { resetRuntimeConfigForTests } from "../lib/runtime-config.ts";

const CAPTURE = fileURLToPath(new URL("./fixtures/capture-notify.sh", import.meta.url));
const kinds = { confirm: true, fail: true, idle: false };
const asst = (text: string, stopReason = "stop", errorMessage?: string) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage },
});
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const toolResult = () => ({ type: "message", message: { role: "toolResult", content: [] } });

beforeEach(() => resetRuntimeConfigForTests());

test("lastAssistantFromBranch picks the last assistant message entry, ignoring later tool results and non-message entries", () => {
  const entries = [user("hi"), asst("first"), toolResult(), asst("second"), toolResult(), { type: "custom", customType: "x" }];
  assert.deepEqual(lastAssistantFromBranch(entries), { text: "second", stopReason: "stop", errorMessage: undefined });
  assert.equal(lastAssistantFromBranch([user("hi")]), undefined);
});

test("decideSettled: actionable provider error → fail", () => {
  assert.deepEqual(decideSettled([asst("", "error", "401 invalid api key")], kinds), { kind: "fail", error: "authentication_failed", details: "401 invalid api key" });
});

test("decideSettled: transient error or user abort → nothing (Review Focus 4)", () => {
  assert.equal(decideSettled([asst("", "error", "429 rate limit")], kinds), undefined);
  assert.equal(decideSettled([asst("", "error", "500 overloaded, retrying")], kinds), undefined);
  assert.equal(decideSettled([asst("partial", "aborted")], kinds), undefined);
});

test("decideSettled: normal end → stop with the last assistant text", () => {
  assert.deepEqual(decideSettled([asst("first"), toolResult(), asst("需要你拍板\n选 A？")], kinds), { kind: "stop", text: "需要你拍板\n选 A？" });
});

test("decideSettled: kinds gate both branches; Stop is sent only when confirm is on", () => {
  assert.equal(decideSettled([asst("", "error", "401")], { ...kinds, fail: false }), undefined);
  assert.equal(decideSettled([asst("done")], { confirm: false, fail: true, idle: false }), undefined);
  assert.equal(decideSettled([asst("需要你拍板\n选？")], { confirm: false, fail: true, idle: true }), undefined);
  assert.deepEqual(decideSettled([asst("done")], { confirm: true, fail: true, idle: true }), { kind: "stop", text: "done" });
});

async function withCapture(run: (capture: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "adonis-pi-attn-"));
  const capture = join(dir, "capture.txt");
  writeFileSync(join(dir, "adonis-pi.json"), JSON.stringify({ notify: { command: CAPTURE } }));
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.CAPTURE_FILE = capture;
  try {
    await run(capture);
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.CAPTURE_FILE;
  }
}
async function read(capture: string) {
  for (let i = 0; i < 50 && !(existsSync(capture) && readFileSync(capture, "utf8").includes("SECRETS")); i++) await sleep(20);
  return existsSync(capture) ? readFileSync(capture, "utf8") : "";
}
const ctxWithBranch = (entries: unknown[], overrides: Record<string, unknown> = {}) =>
  fakeCtx({ sessionManager: { ...fakeCtx().sessionManager, getBranch: () => entries }, ...overrides });

test("agent_settled sends Stop with last_assistant_message in TUI mode", async () => {
  await withCapture(async (capture) => {
    const { pi, emit } = createFakePi();
    attentionNotify(pi);
    await emit("agent_settled", {}, ctxWithBranch([user("go"), asst("all done?")]));
    const out = await read(capture);
    assert.match(out, /"hook_event_name":"Stop"/);
    assert.match(out, /"last_assistant_message":"all done\?"/);
    assert.match(out, /^ARGS --agent pi$/m);
  });
});

test("agent_settled sends StopFailure with a mapped error code", async () => {
  await withCapture(async (capture) => {
    const { pi, emit } = createFakePi();
    attentionNotify(pi);
    await emit("agent_settled", {}, ctxWithBranch([asst("", "error", "402 insufficient balance")]));
    const out = await read(capture);
    assert.match(out, /"hook_event_name":"StopFailure"/);
    assert.match(out, /"error":"billing_error"/);
  });
});

test("agent_end sends nothing (only agent_settled reports)", async () => {
  await withCapture(async (capture) => {
    const { pi, emit } = createFakePi();
    attentionNotify(pi);
    await emit("agent_end", { messages: [] }, ctxWithBranch([asst("mid-run")]));
    await sleep(150);
    assert.equal(existsSync(capture), false);
  });
});

test("tool_result marks activity with --mark and PostToolUse", async () => {
  await withCapture(async (capture) => {
    const { pi, emit } = createFakePi();
    attentionNotify(pi);
    await emit("tool_result", { toolName: "read", toolCallId: "c1", content: [] }, fakeCtx());
    const out = await read(capture);
    assert.match(out, /^ARGS --agent pi --mark$/m);
    assert.match(out, /"hook_event_name":"PostToolUse"/);
    assert.match(out, /"tool_name":"read"/);
  });
});

test("nothing is sent outside TUI mode", async () => {
  await withCapture(async (capture) => {
    const { pi, emit } = createFakePi();
    attentionNotify(pi);
    await emit("agent_settled", {}, ctxWithBranch([asst("x")], { mode: "print", hasUI: false }));
    await emit("tool_result", { toolName: "read" }, fakeCtx({ mode: "rpc", hasUI: true }));
    await sleep(150);
    assert.equal(existsSync(capture), false);
  });
});
