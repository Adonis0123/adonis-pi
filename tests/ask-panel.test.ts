import { test } from "node:test";
import assert from "node:assert/strict";
import type { QuestionInput, Answer } from "../extensions/ask-user-question/state.ts";
import { askOne, createPanel, type EditorLike, type ThemeLike } from "../extensions/ask-user-question/ui.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

const single: QuestionInput = { header: "Color", question: "Which?", options: [{ label: "Red", description: "warm" }, { label: "Blue" }] };
const multi: QuestionInput = { ...single, multiSelect: true };
const theme: ThemeLike = { fg: (_c: string, t: string) => t };

/** Minimal stand-in for pi-tui's Editor: appends printable input, submits on Enter. */
function fakeEditor(): EditorLike & { text: string } {
  return {
    text: "",
    onSubmit: undefined,
    setText(t) {
      this.text = t;
    },
    getText() {
      return this.text;
    },
    handleInput(data) {
      if (data === ENTER) this.onSubmit?.(this.text);
      else this.text += data;
    },
    render() {
      return [`[${this.text}]`];
    },
  };
}

function panel(q: QuestionInput) {
  const done: (Answer | null)[] = [];
  let renders = 0;
  const editor = fakeEditor();
  const p = createPanel(q, 0, 1, { theme, editor, requestRender: () => renders++, done: (a) => done.push(a) });
  return { p, done, editor, renders: () => renders, text: () => p.render(60).join("\n") };
}

test("single-select: renders header, options with descriptions and the hint; down + enter picks the second option", () => {
  const { p, done, text } = panel(single);
  assert.match(text(), /Color · \(1\/1\)/);
  assert.match(text(), /> 1\. Red\n {5}warm\n {2}2\. Blue\n {2}3\. Other \(type your own\)/);
  assert.match(text(), /↑↓ move • Enter select • Esc cancel/);
  p.handleInput(DOWN);
  assert.match(text(), /  1\. Red\n {5}warm\n> 2\. Blue/);
  p.handleInput(ENTER);
  assert.deepEqual(done, [{ selected: ["Blue"] }]);
});

test("Other: typing goes through the editor, Enter submits once, later input is ignored", () => {
  const { p, done, editor, text, renders } = panel(single);
  p.handleInput(DOWN);
  p.handleInput(DOWN);
  p.handleInput(ENTER);
  assert.match(text(), /3\. Other \(type your own\) ✎/);
  assert.match(text(), /Your answer:\n \[\]\n/);
  assert.match(text(), /Enter to submit • Esc to go back/);
  p.handleInput("C");
  p.handleInput("x");
  assert.equal(editor.text, "Cx");
  assert.match(text(), /\[Cx\]/);
  const before = renders();
  p.handleInput(ENTER);
  assert.deepEqual(done, [{ selected: [], custom: "Cx" }]);
  p.handleInput(DOWN);
  p.handleInput(ENTER);
  assert.equal(done.length, 1, "done fires exactly once");
  assert.equal(renders(), before, "no renders requested after finishing");
});

test("Esc while editing goes back to the list and clears the draft; Esc on the list cancels", () => {
  const { p, done, editor, text } = panel(single);
  p.handleInput(DOWN);
  p.handleInput(DOWN);
  p.handleInput(ENTER);
  p.handleInput("z");
  p.handleInput(ESC);
  assert.equal(editor.text, "");
  assert.doesNotMatch(text(), /Your answer/);
  assert.deepEqual(done, []);
  p.handleInput(ESC);
  assert.deepEqual(done, [null]);
});

test("multi-select: space toggles boxes, enter needs at least one, answers come in option order", () => {
  const { p, done, text } = panel(multi);
  assert.match(text(), /> \[ \] 1\. Red/);
  p.handleInput(ENTER);
  assert.deepEqual(done, []);
  p.handleInput(DOWN);
  p.handleInput(" ");
  assert.match(text(), /> \[x\] 2\. Blue/);
  p.handleInput(UP);
  p.handleInput(" ");
  p.handleInput(ENTER);
  assert.deepEqual(done, [{ selected: ["Red", "Blue"] }]);
});

test("askOne hands pi's custom factory a panel and resolves with its answer", async () => {
  let factoryCalls = 0;
  const ctx = {
    ui: {
      custom: async <T,>(factory: (tui: { requestRender(): void }, th: ThemeLike, kb: unknown, done: (v: T) => void) => { handleInput(d: string): void }) => {
        factoryCalls++;
        return new Promise<T>((resolve) => {
          const p = factory({ requestRender() {} }, theme, {}, resolve);
          p.handleInput(ENTER); // picks the first option
        });
      },
      select: async () => undefined,
      input: async () => undefined,
    },
  };
  const a = await askOne(ctx, single, 0, 1);
  assert.equal(factoryCalls, 1);
  assert.deepEqual(a, { selected: ["Red"] });
});
