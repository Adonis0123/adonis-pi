import { Editor, type EditorTheme, Key as TuiKey, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { initialState, OTHER_LABEL, otherIndex, reduce, setDraft, type Answer, type Key, type QuestionInput, type QuestionState } from "./state.ts";

/** The slice of pi's theme the panel uses. */
export interface ThemeLike {
  fg(color: string, text: string): string;
}
/** The slice of pi-tui's Editor the panel uses; tests substitute a plain object. */
export interface EditorLike {
  onSubmit?: (value: string) => void;
  setText(text: string): void;
  getText(): string;
  handleInput(data: string): void;
  render(width: number): string[];
}
export interface PanelDeps {
  theme: ThemeLike;
  editor: EditorLike;
  requestRender(): void;
  done(answer: Answer | null): void;
}
/** What pi's `ui.custom` expects back: a component that renders lines and takes raw key input. */
export interface Panel {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
}

/**
 * The whole keypress → state → render loop for one question. `done` fires exactly once; afterwards input and
 * renders are ignored, so a stray key after Enter cannot re-enter the reducer.
 */
export function createPanel(q: QuestionInput, index: number, total: number, deps: PanelDeps): Panel {
  const { theme, editor } = deps;
  let state: QuestionState = initialState();
  let cached: string[] | undefined;
  let finished = false;

  const finish = (answer: Answer | null) => {
    if (finished) return;
    finished = true;
    deps.done(answer);
  };
  const refresh = () => {
    cached = undefined;
    deps.requestRender();
  };
  const step = (key: Key, draft?: string) => {
    if (finished) return;
    if (draft !== undefined) state = setDraft(state, draft);
    const r = reduce(q, state, key);
    state = r.state;
    if (r.done !== undefined) return finish(r.done);
    if (!state.editing) editor.setText("");
    refresh();
  };
  editor.onSubmit = (value: string) => step("enter", value);

  const handleInput = (data: string) => {
    if (finished) return;
    if (state.editing) {
      if (matchesKey(data, TuiKey.escape)) return step("escape");
      editor.handleInput(data); // Enter inside the editor arrives here as onSubmit → step("enter")
      if (finished) return;
      state = setDraft(state, editor.getText());
      refresh();
      return;
    }
    if (matchesKey(data, TuiKey.up)) return step("up");
    if (matchesKey(data, TuiKey.down)) return step("down");
    if (matchesKey(data, TuiKey.enter)) return step("enter");
    if (matchesKey(data, TuiKey.escape)) return step("escape");
    if (data === " ") return step("space");
  };

  const render = (width: number): string[] => {
    if (cached) return cached;
    const w = Math.max(1, width);
    const lines: string[] = [];
    const add = (prefix: string, text: string) => {
      const pw = visibleWidth(prefix);
      const wrapped = wrapTextWithAnsi(text, Math.max(1, w - pw));
      wrapped.forEach((l: string, i: number) => lines.push(`${i === 0 ? prefix : " ".repeat(pw)}${l}`));
    };
    lines.push(theme.fg("accent", "─".repeat(w)));
    add(" ", theme.fg("muted", `${q.header ? `${q.header} · ` : ""}(${index + 1}/${total})`));
    add(" ", theme.fg("text", q.question));
    lines.push("");
    const rows = [...q.options.map((o) => o.label), OTHER_LABEL];
    rows.forEach((label, i) => {
      const isOther = i === otherIndex(q);
      const cursor = i === state.cursor ? theme.fg("accent", "> ") : "  ";
      const box = q.multiSelect && !isOther ? (state.checked.has(i) ? "[x] " : "[ ] ") : "";
      add(cursor, theme.fg(i === state.cursor ? "accent" : "text", `${box}${i + 1}. ${label}${isOther && state.editing ? " ✎" : ""}`));
      const desc = q.options[i]?.description;
      if (desc) add("     ", theme.fg("muted", desc));
    });
    if (state.editing) {
      lines.push("");
      add(" ", theme.fg("muted", "Your answer:"));
      for (const l of editor.render(Math.max(1, w - 2))) lines.push(` ${l}`);
    }
    lines.push("");
    const hint = state.editing ? "Enter to submit • Esc to go back" : q.multiSelect ? "↑↓ move • Space toggle • Enter confirm • Esc cancel" : "↑↓ move • Enter select • Esc cancel";
    add(" ", theme.fg("dim", hint));
    lines.push(theme.fg("accent", "─".repeat(w)));
    cached = lines;
    return lines;
  };

  return { render, invalidate: () => (cached = undefined), handleInput };
}

/** The pi UI surface both adapters share; pi's ExtensionContext satisfies it structurally. */
export interface AskCtx {
  ui: {
    custom<T>(factory: (tui: { requestRender(): void }, theme: ThemeLike, keybindings: unknown, done: (value: T) => void) => Panel): Promise<T>;
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
  };
}

function editorTheme(theme: ThemeLike): EditorTheme {
  return {
    borderColor: (s: string) => theme.fg("accent", s),
    selectList: {
      selectedPrefix: (t: string) => theme.fg("accent", t),
      selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t),
      scrollInfo: (t: string) => theme.fg("dim", t),
      noMatch: (t: string) => theme.fg("warning", t),
    },
  };
}

/** TUI adapter: a pi-tui custom panel. */
export function askOne(ctx: AskCtx, q: QuestionInput, index: number, total: number): Promise<Answer | null> {
  return ctx.ui.custom<Answer | null>((tui, theme, _kb, done) =>
    createPanel(q, index, total, { theme, editor: new Editor(tui as any, editorTheme(theme)), requestRender: () => tui.requestRender(), done }),
  );
}

/** RPC adapter: dialogs exist (select/input) but custom panels do not. */
export async function askOneRpc(ctx: AskCtx, q: QuestionInput, index: number, total: number): Promise<Answer | null> {
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
