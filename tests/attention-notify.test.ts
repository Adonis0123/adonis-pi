import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, fakeCtx, fakeNotifier } from "./helpers/fake-pi.ts";
import attentionNotify, { decideSettled, lastAssistantFromBranch } from "../extensions/attention-notify/index.ts";

const kinds = { confirm: true, fail: true, idle: false };
const asst = (text: string, stopReason = "stop", errorMessage?: string) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason, errorMessage },
});
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const toolResult = () => ({ type: "message", message: { role: "toolResult", content: [] } });

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

const ctxWithBranch = (entries: unknown[], overrides: Record<string, unknown> = {}) =>
  fakeCtx({ sessionManager: { ...fakeCtx().sessionManager, getBranch: () => entries }, ...overrides });

test("agent_settled sends Stop with last_assistant_message in TUI mode", async () => {
  const n = fakeNotifier();
  const { pi, emit } = createFakePi();
  attentionNotify(pi, n.deps);
  await emit("agent_settled", {}, ctxWithBranch([user("go"), asst("all done?")]));
  assert.equal(n.sent.length, 1);
  assert.deepEqual(n.sent[0].args, ["--agent", "pi"]);
  assert.equal(n.sent[0].payload.hook_event_name, "Stop");
  assert.equal(n.sent[0].payload.last_assistant_message, "all done?");
});

test("agent_settled sends StopFailure with a mapped error code", async () => {
  const n = fakeNotifier();
  const { pi, emit } = createFakePi();
  attentionNotify(pi, n.deps);
  await emit("agent_settled", {}, ctxWithBranch([asst("", "error", "402 insufficient balance")]));
  assert.equal(n.sent[0].payload.hook_event_name, "StopFailure");
  assert.equal(n.sent[0].payload.error, "billing_error");
});

test("agent_end sends nothing (only agent_settled reports)", async () => {
  const n = fakeNotifier();
  const { pi, emit } = createFakePi();
  attentionNotify(pi, n.deps);
  await emit("agent_end", { messages: [] }, ctxWithBranch([asst("mid-run")]));
  assert.equal(n.sent.length, 0);
});

test("tool_result marks activity with --mark and PostToolUse, regardless of kinds", async () => {
  const n = fakeNotifier({ kinds: { confirm: false, fail: false, idle: false } });
  const { pi, emit } = createFakePi();
  attentionNotify(pi, n.deps);
  await emit("tool_result", { toolName: "read", toolCallId: "c1", content: [] }, fakeCtx());
  assert.deepEqual(n.sent[0].args, ["--agent", "pi", "--mark"]);
  assert.equal(n.sent[0].payload.hook_event_name, "PostToolUse");
  assert.equal(n.sent[0].payload.tool_name, "read");
});

test("nothing is sent outside TUI mode (print or rpc)", async () => {
  const n = fakeNotifier();
  const { pi, emit } = createFakePi();
  attentionNotify(pi, n.deps);
  await emit("agent_settled", {}, ctxWithBranch([asst("x")], { mode: "print", hasUI: false }));
  await emit("tool_result", { toolName: "read" }, fakeCtx({ mode: "rpc", hasUI: true }));
  await emit("agent_settled", {}, ctxWithBranch([asst("x?")], { mode: "rpc", hasUI: true }));
  assert.equal(n.sent.length, 0);
});
