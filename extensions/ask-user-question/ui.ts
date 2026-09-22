import { Editor, type EditorTheme, Key as TuiKey, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { initialState, OTHER_LABEL, otherIndex, reduce, setDraft, type Answer, type Key, type QuestionInput, type QuestionState } from "./state.ts";

interface UiLike {
  ui: { custom<T>(factory: (tui: any, theme: any, kb: any, done: (v: T) => void) => any): Promise<T> };
}

export function askOne(ctx: UiLike, q: QuestionInput, index: number, total: number): Promise<Answer | null> {
  return ctx.ui.custom<Answer | null>((tui, theme, _kb, done) => {
    let state: QuestionState = initialState();
    let cached: string[] | undefined;

    const editorTheme: EditorTheme = {
      borderColor: (s: string) => theme.fg("accent", s),
      selectList: {
        selectedPrefix: (t: string) => theme.fg("accent", t),
        selectedText: (t: string) => theme.fg("accent", t),
        description: (t: string) => theme.fg("muted", t),
        scrollInfo: (t: string) => theme.fg("dim", t),
        noMatch: (t: string) => theme.fg("warning", t),
      },
    };
    const editor = new Editor(tui, editorTheme);
    editor.onSubmit = (value: string) => step("enter", value);

    function refresh() {
      cached = undefined;
      tui.requestRender();
    }

    function step(key: Key, draft?: string) {
      if (draft !== undefined) state = setDraft(state, draft);
      const r = reduce(q, state, key);
      state = r.state;
      if (r.done !== undefined) {
        done(r.done);
        return;
      }
      if (!state.editing) editor.setText("");
      refresh();
    }

    function handleInput(data: string) {
      if (state.editing) {
        if (matchesKey(data, TuiKey.escape)) return step("escape");
        editor.handleInput(data);
        state = setDraft(state, editor.getText());
        refresh();
        return;
      }
      if (matchesKey(data, TuiKey.up)) return step("up");
      if (matchesKey(data, TuiKey.down)) return step("down");
      if (matchesKey(data, TuiKey.enter)) return step("enter");
      if (matchesKey(data, TuiKey.escape)) return step("escape");
      if (data === " ") return step("space");
    }

    function render(width: number): string[] {
      if (cached) return cached;
      const w = Math.max(1, width);
      const lines: string[] = [];
      const add = (prefix: string, text: string) => {
        const pw = visibleWidth(prefix);
        const wrapped = wrapTextWithAnsi(text, Math.max(1, w - pw));
        wrapped.forEach((l: string, i: number) => lines.push(`${i === 0 ? prefix : " ".repeat(pw)}${l}`));
      };
      lines.push(theme.fg("accent", "─".repeat(w)));
      const title = `${q.header ? `${q.header} · ` : ""}(${index + 1}/${total})`;
      add(" ", theme.fg("muted", title));
      add(" ", theme.fg("text", q.question));
      lines.push("");
      const rows = [...q.options.map((o) => o.label), OTHER_LABEL];
      rows.forEach((label, i) => {
        const isOther = i === otherIndex(q);
        const cursor = i === state.cursor ? theme.fg("accent", "> ") : "  ";
        const box = q.multiSelect && !isOther ? (state.checked.has(i) ? "[x] " : "[ ] ") : "";
        const color = i === state.cursor ? "accent" : "text";
        add(cursor, theme.fg(color, `${box}${i + 1}. ${label}${isOther && state.editing ? " ✎" : ""}`));
        const desc = q.options[i]?.description;
        if (desc) add("     ", theme.fg("muted", desc));
      });
      if (state.editing) {
        lines.push("");
        add(" ", theme.fg("muted", "Your answer:"));
        for (const l of editor.render(Math.max(1, w - 2))) lines.push(` ${l}`);
      }
      lines.push("");
      const hint = state.editing
        ? "Enter to submit • Esc to go back"
        : q.multiSelect
          ? "↑↓ move • Space toggle • Enter confirm • Esc cancel"
          : "↑↓ move • Enter select • Esc cancel";
      add(" ", theme.fg("dim", hint));
      lines.push(theme.fg("accent", "─".repeat(w)));
      cached = lines;
      return lines;
    }

    return { render, invalidate: () => (cached = undefined), handleInput };
  });
}

/** RPC fallback: dialogs exist (select/input) but custom panels do not. */
export async function askOneRpc(
  ctx: { ui: { select(title: string, options: string[]): Promise<string | undefined>; input(title: string, placeholder?: string): Promise<string | undefined> } },
  q: QuestionInput,
  index: number,
  total: number,
): Promise<Answer | null> {
  const note = q.multiSelect ? "single pick; multi-select unavailable in this mode" : undefined;
  const title = `${q.header ? `${q.header} · ` : ""}(${index + 1}/${total}) ${q.question}${note ? ` [${note}]` : ""}`;
  const rows = q.options.map((o) => (o.description ? `${o.label} — ${o.description}` : o.label));
  const picked = await ctx.ui.select(title, [...rows, OTHER_LABEL]);
  if (picked === undefined) return null;
  if (picked !== OTHER_LABEL) {
    const idx = rows.indexOf(picked);
    const label = idx >= 0 ? q.options[idx].label : picked;
    return note ? { selected: [label], note } : { selected: [label] };
  }
  const custom = await ctx.ui.input("Your answer");
  if (custom === undefined || custom.trim() === "") return null;
  return note ? { selected: [], custom: custom.trim(), note } : { selected: [], custom: custom.trim() };
}
