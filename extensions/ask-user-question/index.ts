import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getSession, type SessionDeps } from "../../lib/session.ts";
import { OTHER_LABEL, type Answer, type QuestionInput } from "./state.ts";
import { askOne, askOneRpc, type AskCtx } from "./ui.ts";

const OptionSchema = Type.Object({
  label: Type.String({ description: "Display label for the option" }),
  description: Type.Optional(Type.String({ description: "Short explanation shown under the label" })),
});
const QuestionSchema = Type.Object({
  header: Type.Optional(Type.String({ description: "Very short topic label, max ~12 chars" })),
  question: Type.String({ description: "The complete question, ending with a question mark" }),
  options: Type.Array(OptionSchema, { description: "2-4 mutually exclusive choices; an Other/free-text entry is added automatically" }),
  multiSelect: Type.Optional(Type.Boolean({ description: "Allow choosing several options" })),
});
const Params = Type.Object({
  questions: Type.Array(QuestionSchema, { minItems: 1, description: "Questions asked one after another" }),
});

interface Details {
  answers: (Answer | null)[];
}

export function formatAnswers(questions: QuestionInput[], answers: (Answer | null)[]): string {
  return questions
    .map((q, i) => {
      const a = answers[i];
      const label = q.header ?? q.question;
      if (!a) return `Q${i + 1} ${label}: (cancelled)`;
      const parts = [...a.selected];
      if (a.custom !== undefined) parts.push(`${OTHER_LABEL} — ${a.custom}`);
      return `Q${i + 1} ${label}: ${parts.join(", ")}${a.note ? ` (${a.note})` : ""}`;
    })
    .join("\n");
}

export default function askUserQuestion(pi: ExtensionAPI, deps: SessionDeps = {}) {
  pi.registerTool({
    name: "AskUserQuestion",
    label: "Ask user",
    description:
      "Ask the user one or more structured questions and wait for their choices. Use it when a decision is the user's to make and the options are known. Each question shows its options plus a free-text entry.",
    promptSnippet: "Ask the user to choose between concrete options",
    parameters: Params,
    executionMode: "sequential",
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const questions = params.questions as QuestionInput[];
      const session = getSession(ctx, deps);
      if (!session.surface.canPrompt || !session.config.askUserQuestion.enabled) {
        return {
          content: [{ type: "text", text: "Error: AskUserQuestion UI not available (non-interactive mode or disabled). Ask the question in plain text and stop; do not choose for the user." }],
          details: { answers: questions.map(() => null) } as Details,
        };
      }
      const ask = session.surface.canPanel ? askOne : askOneRpc;
      session.notify({ kind: "question", questions });
      const answers: (Answer | null)[] = [];
      for (let i = 0; i < questions.length; i++) {
        const a = await ask(ctx as unknown as AskCtx, questions[i], i, questions.length);
        answers.push(a);
        if (a === null) {
          while (answers.length < questions.length) answers.push(null);
          return {
            content: [{ type: "text", text: `User cancelled at question ${i + 1}.\n${formatAnswers(questions, answers)}` }],
            details: { answers } as Details,
          };
        }
      }
      return { content: [{ type: "text", text: formatAnswers(questions, answers) }], details: { answers } as Details };
    },
  });
}
