export interface QuestionOption {
  label: string;
  description?: string;
}
export interface QuestionInput {
  header?: string;
  question: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}
export interface Answer {
  selected: string[];
  custom?: string;
  /** Set when the answer was collected in a degraded way (e.g. RPC single pick for a multi-select). */
  note?: string;
}
export interface QuestionState {
  cursor: number;
  checked: Set<number>;
  editing: boolean;
  draft: string;
}
export type Key = "up" | "down" | "space" | "enter" | "escape";

export const OTHER_LABEL = "Other (type your own)";

export function initialState(): QuestionState {
  return { cursor: 0, checked: new Set(), editing: false, draft: "" };
}

export function otherIndex(q: QuestionInput): number {
  return q.options.length;
}

export function reduce(q: QuestionInput, s: QuestionState, key: Key): { state: QuestionState; done?: Answer | null } {
  const other = otherIndex(q);
  if (s.editing) {
    if (key === "escape") return { state: { ...s, editing: false, draft: "" } };
    if (key === "enter") {
      const custom = s.draft.trim();
      if (!custom) return { state: { ...s, editing: false, draft: "" } };
      return { state: s, done: { selected: selectedLabels(q, s), custom } };
    }
    return { state: s };
  }
  switch (key) {
    case "up":
      return { state: { ...s, cursor: Math.max(0, s.cursor - 1) } };
    case "down":
      return { state: { ...s, cursor: Math.min(other, s.cursor + 1) } };
    case "space": {
      if (!q.multiSelect || s.cursor === other) return { state: s };
      const checked = new Set(s.checked);
      checked.has(s.cursor) ? checked.delete(s.cursor) : checked.add(s.cursor);
      return { state: { ...s, checked } };
    }
    case "enter": {
      if (s.cursor === other) return { state: { ...s, editing: true } };
      if (!q.multiSelect) return { state: s, done: { selected: [q.options[s.cursor].label] } };
      if (s.checked.size === 0) return { state: s };
      return { state: s, done: { selected: selectedLabels(q, s) } };
    }
    case "escape":
      return { state: s, done: null };
  }
}

function selectedLabels(q: QuestionInput, s: QuestionState): string[] {
  return [...s.checked].sort((a, b) => a - b).map((i) => q.options[i].label);
}

/** Text typed into the editor is fed through here (not a Key). */
export function setDraft(s: QuestionState, draft: string): QuestionState {
  return { ...s, draft };
}
