import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakePi, fakeCtx, fakeNotifier } from "./helpers/fake-pi.ts";
import { initialState, reduce, OTHER_LABEL, type QuestionInput } from "../extensions/ask-user-question/state.ts";
import askUserQuestion, { formatAnswers } from "../extensions/ask-user-question/index.ts";

const single: QuestionInput = { header: "Approach", question: "Which?", options: [{ label: "A" }, { label: "B", description: "slower" }] };
const multi: QuestionInput = { ...single, multiSelect: true };

test("single-select: down + enter returns the second option", () => {
  let s = initialState();
  s = reduce(single, s, "down").state;
  const r = reduce(single, s, "enter");
  assert.deepEqual(r.done, { selected: ["B"] });
});

test("single-select: enter on the trailing Other opens the editor; escape closes it, escape again cancels", () => {
  let s = initialState();
  s = reduce(single, s, "down").state;
  s = reduce(single, s, "down").state; // cursor on Other (index 2)
  let r = reduce(single, s, "enter");
  assert.equal(r.state.editing, true);
  assert.equal(r.done, undefined);
  r = reduce(single, r.state, "escape");
  assert.equal(r.state.editing, false);
  r = reduce(single, r.state, "escape");
  assert.equal(r.done, null);
});

test("multi-select: space toggles, enter with selections returns them in option order", () => {
  let s = initialState();
  s = reduce(multi, s, "space").state; // A
  s = reduce(multi, s, "down").state;
  s = reduce(multi, s, "space").state; // B
  s = reduce(multi, s, "up").state;
  s = reduce(multi, s, "space").state; // untoggle A
  s = reduce(multi, s, "space").state; // toggle A again
  const r = reduce(multi, s, "enter");
  assert.deepEqual(r.done, { selected: ["A", "B"] });
});

test("multi-select: enter with nothing checked does not finish (Review Focus 3)", () => {
  const r = reduce(multi, initialState(), "enter");
  assert.equal(r.done, undefined);
  assert.equal(r.state.editing, false);
});

test("cursor is clamped to [0, options.length] where the last slot is Other", () => {
  let s = initialState();
  s = reduce(single, s, "up").state;
  assert.equal(s.cursor, 0);
  for (let i = 0; i < 10; i++) s = reduce(single, s, "down").state;
  assert.equal(s.cursor, 2);
});

test("formatAnswers writes one line per question with header, joins multi answers, marks custom", () => {
  const text = formatAnswers([single, multi, single], [{ selected: ["A"] }, { selected: ["A", "B"] }, { selected: [], custom: "C please" }]);
  assert.equal(text, ["Q1 Approach: A", "Q2 Approach: A, B", `Q3 Approach: ${OTHER_LABEL} — C please`].join("\n"));
});

test("tool registers as AskUserQuestion with a Claude-compatible schema", () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  const tool = tools.get("AskUserQuestion");
  assert.ok(tool);
  const schema = tool!.parameters as any;
  assert.equal(schema.properties.questions.type, "array");
  const q = schema.properties.questions.items.properties;
  assert.ok(q.question && q.options && q.header && q.multiSelect);
});

test("non-UI mode returns an error text and null answers", async () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  const r = await tools.get("AskUserQuestion")!.execute("t1", { questions: [single] }, undefined, undefined, fakeCtx({ mode: "print", hasUI: false }));
  assert.match(r.content[0].text!, /not available/i);
  assert.doesNotMatch(r.content[0].text!, /recommended/i);
  assert.deepEqual((r.details as any).answers, [null]);
});

test("RPC mode (hasUI but no TUI) falls back to ctx.ui.select and never calls custom", async () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  let customCalls = 0;
  const ctx = fakeCtx({ mode: "rpc", hasUI: true, ui: { ...fakeCtx().ui, custom: async () => { customCalls++; return null; }, select: async () => "B" } });
  const r = await tools.get("AskUserQuestion")!.execute("t1", { questions: [single] }, undefined, undefined, ctx);
  assert.equal(customCalls, 0);
  assert.equal(r.content[0].text, "Q1 Approach: B");
});

test("RPC mode Other goes through ctx.ui.input", async () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  const ctx = fakeCtx({ mode: "rpc", hasUI: true, ui: { ...fakeCtx().ui, select: async () => OTHER_LABEL, input: async () => "C please" } });
  const r = await tools.get("AskUserQuestion")!.execute("t1", { questions: [single] }, undefined, undefined, ctx);
  assert.equal(r.content[0].text, `Q1 Approach: ${OTHER_LABEL} — C please`);
});

test("RPC mode shows descriptions in the select rows and marks a degraded multi-select in content and details", async () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  let rows: string[] = [];
  const ctx = fakeCtx({ mode: "rpc", hasUI: true, ui: { ...fakeCtx().ui, select: async (_t: string, options: string[]) => { rows = options; return "B — slower"; } } });
  const r = await tools.get("AskUserQuestion")!.execute("t1", { questions: [multi] }, undefined, undefined, ctx);
  assert.deepEqual(rows, ["A", "B — slower", OTHER_LABEL]);
  assert.equal(r.content[0].text, "Q1 Approach: B (single pick; multi-select unavailable in this mode)");
  assert.equal((r.details as any).answers[0].note, "single pick; multi-select unavailable in this mode");
});

test("UI mode asks each question through ctx.ui.custom in order and formats the result", async () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  const scripted = [{ selected: ["B"] }, { selected: ["A", "B"] }];
  let calls = 0;
  const ctx = fakeCtx({ ui: { ...fakeCtx().ui, custom: async () => scripted[calls++] } });
  const r = await tools.get("AskUserQuestion")!.execute("t1", { questions: [single, multi] }, undefined, undefined, ctx);
  assert.equal(calls, 2);
  assert.equal(r.content[0].text, "Q1 Approach: B\nQ2 Approach: A, B");
});

test("a cancelled question stops the sequence and reports it", async () => {
  const { pi, tools } = createFakePi();
  askUserQuestion(pi);
  const ctx = fakeCtx({ ui: { ...fakeCtx().ui, custom: async () => null } });
  const r = await tools.get("AskUserQuestion")!.execute("t1", { questions: [single, multi] }, undefined, undefined, ctx);
  assert.match(r.content[0].text!, /cancelled/i);
});

test("asking notifies once per tool call in the TUI with the question texts, and not in rpc", async () => {
  const n = fakeNotifier();
  const { pi, tools } = createFakePi();
  askUserQuestion(pi, n.deps);
  const ctx = fakeCtx({ ui: { ...fakeCtx().ui, custom: async () => ({ selected: ["A"] }) } });
  await tools.get("AskUserQuestion")!.execute("t1", { questions: [single, multi] }, undefined, undefined, ctx);
  assert.equal(n.sent.length, 1);
  assert.equal(n.sent[0].payload.hook_event_name, "PreToolUse");
  assert.equal(n.sent[0].payload.tool_name, "AskUserQuestion");
  assert.deepEqual((n.sent[0].payload.tool_input as any).questions, [{ question: "Which?", header: "Approach" }, { question: "Which?", header: "Approach" }]);
  const rpc = fakeCtx({ mode: "rpc", hasUI: true, ui: { ...fakeCtx().ui, select: async () => "A" } });
  await tools.get("AskUserQuestion")!.execute("t2", { questions: [single] }, undefined, undefined, rpc);
  assert.equal(n.sent.length, 1);
});
