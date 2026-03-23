import { ContainerBuilder, SeparatorBuilder, TextDisplayBuilder } from "@discordjs/builders";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type InteractionReplyOptions,
  type MessageCreateOptions,
  type MessageEditOptions,
} from "discord.js";
import type { QuestionAnswer, QuestionInfo, QuestionRequest } from "@opencode-ai/sdk/v2";

const CUSTOM_ID_PREFIX = "ocq";
const MODAL_INPUT_ID = "answer";
export const QUESTION_OPTIONS_PER_PAGE = 25;
const QUESTION_STATUS_COLORS = {
  active: 0x4f8cff,
  submitting: 0xf0b429,
  answered: 0x2bb673,
  rejected: 0xd64545,
  expired: 0x6b7280,
} as const;

export type QuestionDraft = {
  selectedOptions: string[];
  customAnswer: string | null;
};

export type QuestionBatchStatus = "active" | "submitting" | "answered" | "rejected";
export type QuestionBatchCardStatus = QuestionBatchStatus | "expired";

export type PendingQuestionBatchView = {
  sessionId: string;
  request: QuestionRequest;
  version: number;
  page: number;
  optionPages: ReadonlyArray<number>;
  drafts: ReadonlyArray<QuestionDraft>;
  status: QuestionBatchCardStatus;
  resolvedAnswers?: ReadonlyArray<QuestionAnswer>;
};

type QuestionActionMeta = { sessionID: string; requestID: string; version: number };
type IndexedQuestionActionKind =
  | "option-prev"
  | "option-next"
  | "clear"
  | "select"
  | "custom"
  | "modal";
type IndexedQuestionAction = { kind: IndexedQuestionActionKind; questionIndex: number };

type QuestionAction =
  | (QuestionActionMeta & { kind: "question-prev" | "question-next" | "submit" | "reject" })
  | (QuestionActionMeta & IndexedQuestionAction);
type QuestionActionInput =
  | { kind: "question-prev" | "question-next" | "submit" | "reject" }
  | IndexedQuestionAction;

const STATUS_TITLES: Record<PendingQuestionBatchView["status"], string> = {
  active: "❓ Questions need answers",
  submitting: "⏳ Submitting answers",
  answered: "✅ Questions answered",
  rejected: "⛔ Questions rejected",
  expired: "⏱️ Questions expired",
};

const text = (content: string) => new TextDisplayBuilder().setContent(content);
const addText = (container: ContainerBuilder, content: string | null) =>
  content ? container.addTextDisplayComponents(text(content)) : container;
const button = (action: QuestionAction, label: string, style: ButtonStyle, disabled = false) =>
  new ButtonBuilder()
    .setCustomId(setQuestionActionId(action))
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
const addButtons = (container: ContainerBuilder, ...buttons: ReadonlyArray<ButtonBuilder>) =>
  container.addActionRowComponents((row) => row.addComponents(...buttons));

const compact = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}…`;
};

const lines = (...parts: Array<string | null | undefined | false>) =>
  parts.filter(Boolean).join("\n");

const questionAllowsCustom = (question: QuestionInfo) => question.custom !== false;

const questionCountLabel = (questionCount: number) =>
  `${questionCount} question${questionCount === 1 ? "" : "s"}`;

const terminalStatusSummary = (input: PendingQuestionBatchView) => {
  const count = input.request.questions.length;
  return input.status === "answered"
    ? questionCountLabel(count)
    : input.status === "rejected"
      ? count === 1
        ? "This question prompt was rejected without submitting answers."
        : "These question prompts were rejected without submitting answers."
      : input.status === "expired"
        ? count === 1
          ? "This question prompt expired before it was answered."
          : "These question prompts expired before they were answered."
        : null;
};

const questionModeLabel = (question: QuestionInfo) =>
  question.multiple ? "Pick many" : "Pick one";

const questionAnswer = (question: QuestionInfo, draft: QuestionDraft): QuestionAnswer => {
  if (question.multiple) {
    return draft.customAnswer
      ? [...draft.selectedOptions, draft.customAnswer]
      : [...draft.selectedOptions];
  }

  if (draft.customAnswer) {
    return [draft.customAnswer];
  }

  return draft.selectedOptions.slice(0, 1);
};

const questionAnswered = (question: QuestionInfo, draft: QuestionDraft) =>
  questionAnswer(question, draft).length > 0;

const answerSummary = (answers: ReadonlyArray<string>) =>
  answers.length === 0
    ? "*(none yet)*"
    : answers.map((answer) => `\`${compact(answer, 180)}\``).join("\n");

const answerCount = (request: QuestionRequest, drafts: ReadonlyArray<QuestionDraft>) =>
  request.questions.reduce(
    (count, question, index) =>
      count + (questionAnswered(question, drafts[index] ?? emptyQuestionDraft()) ? 1 : 0),
    0,
  );

export const questionOptionPageCount = (question: QuestionInfo) =>
  Math.max(1, Math.ceil(question.options.length / QUESTION_OPTIONS_PER_PAGE));

const optionSlice = (question: QuestionInfo, page: number) => {
  const totalPages = questionOptionPageCount(question);
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1);
  const start = normalizedPage * QUESTION_OPTIONS_PER_PAGE;
  return {
    page: normalizedPage,
    totalPages,
    items: question.options.slice(start, start + QUESTION_OPTIONS_PER_PAGE),
    start,
  };
};

const emptyQuestionDraft = (): QuestionDraft => ({
  selectedOptions: [],
  customAnswer: null,
});

const setQuestionActionId = (action: QuestionAction) =>
  [
    CUSTOM_ID_PREFIX,
    action.sessionID,
    action.requestID,
    String(action.version),
    action.kind,
    "questionIndex" in action ? String(action.questionIndex) : null,
  ]
    .filter((part): part is string => part !== null)
    .join(":");

const withQuestionActionMeta = (
  sessionID: string,
  requestID: string,
  version: number,
  action: QuestionActionInput,
): QuestionAction => ({ ...action, sessionID, requestID, version }) as QuestionAction;

export const parseQuestionActionId = (customId: string): QuestionAction | null => {
  const parts = customId.split(":");
  const [prefix, sessionID, requestID, versionRaw, kind, questionIndex] = parts;
  if (!prefix || !sessionID || !requestID || !versionRaw || !kind) {
    return null;
  }
  if (prefix !== CUSTOM_ID_PREFIX) {
    return null;
  }

  const version = Number(versionRaw);
  if (!Number.isSafeInteger(version) || version < 0) {
    return null;
  }

  if (parts.length !== 5 && parts.length !== 6) {
    return null;
  }

  switch (kind) {
    case "question-prev":
      return { kind, sessionID, requestID, version };
    case "question-next":
      return { kind, sessionID, requestID, version };
    case "submit":
      return { kind, sessionID, requestID, version };
    case "reject":
      return { kind, sessionID, requestID, version };
    case "clear":
    case "select":
    case "custom":
    case "option-prev":
    case "option-next":
    case "modal": {
      const parsedIndex = Number(questionIndex);
      if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
        return null;
      }
      return { kind, sessionID, requestID, version, questionIndex: parsedIndex };
    }
    default:
      return null;
  }
};

const optionLabel = (question: QuestionInfo, page: number) => {
  const options = optionSlice(question, page);
  if (question.options.length === 0) {
    return null;
  }

  return options.totalPages === 1
    ? `${question.options.length} option${question.options.length === 1 ? "" : "s"}`
    : `Options ${options.start + 1}-${options.start + options.items.length} of ${question.options.length} • page ${options.page + 1}/${options.totalPages}`;
};

const renderQuestionMeta = (input: PendingQuestionBatchView) => {
  const question = input.request.questions[input.page]!;
  const answered = answerCount(input.request, input.drafts);
  return [
    `Question ${input.page + 1}/${input.request.questions.length}`,
    `${answered}/${input.request.questions.length} answered`,
    questionModeLabel(question),
    questionAllowsCustom(question) ? "Other allowed" : null,
    optionLabel(question, input.optionPages[input.page] ?? 0),
  ]
    .filter(Boolean)
    .join(" • ");
};

const renderQuestionTitle = (question: QuestionInfo) => {
  const header = question.header.trim();
  return header && !/^q\d+$/i.test(header) ? `**${header}**` : null;
};

const renderActiveQuestionText = (input: PendingQuestionBatchView) => {
  const question = input.request.questions[input.page]!;
  return lines(renderQuestionTitle(question), question.question);
};

const renderAnswerText = (input: PendingQuestionBatchView) => {
  const question = input.request.questions[input.page]!;
  const draft = input.drafts[input.page] ?? emptyQuestionDraft();
  const answers = questionAnswer(question, draft);
  return lines("**Current answer**", answerSummary(answers));
};

const renderQuestionHints = (input: PendingQuestionBatchView) => {
  const question = input.request.questions[input.page]!;
  const hints = [
    input.request.questions.length > 1
      ? "Use Prev/Next to review the whole batch before submitting."
      : null,
    question.options.length > QUESTION_OPTIONS_PER_PAGE
      ? "This question has more than 25 options. Use the choice paging buttons to browse them."
      : null,
  ].filter(Boolean);

  if (hints.length === 0) {
    return null;
  }

  return hints.length === 1
    ? lines("**How to answer**", hints[0]!)
    : lines("**How to answer**", ...hints.map((hint) => `- ${hint}`));
};

const renderResolvedQuestionSection = (question: QuestionInfo, answers: ReadonlyArray<string>) =>
  lines(
    renderQuestionTitle(question),
    question.question,
    answers.length > 0 ? lines("**Answer**", answerSummary(answers)) : null,
  );

const renderResolvedQuestionSections = (input: PendingQuestionBatchView) => {
  const resolvedAnswers =
    input.resolvedAnswers ??
    input.request.questions.map((question, index) =>
      questionAnswer(question, input.drafts[index] ?? emptyQuestionDraft()),
    );

  return input.request.questions.map((question, index) =>
    renderResolvedQuestionSection(question, resolvedAnswers[index] ?? []),
  );
};

const renderQuestionContainer = (input: PendingQuestionBatchView) => {
  const container = new ContainerBuilder().setAccentColor(QUESTION_STATUS_COLORS[input.status]);
  const action = (value: QuestionActionInput) =>
    withQuestionActionMeta(input.sessionId, input.request.id, input.version, value);
  const questionButton = (
    value: QuestionActionInput,
    label: string,
    style: ButtonStyle,
    disabled = false,
  ) => button(action(value), label, style, disabled);

  addText(
    container,
    lines(
      `**${STATUS_TITLES[input.status]}**`,
      ["active", "submitting"].includes(input.status)
        ? renderQuestionMeta(input)
        : terminalStatusSummary(input),
    ),
  );

  if (["answered", "rejected", "expired"].includes(input.status)) {
    const resolvedSections = renderResolvedQuestionSections(input).filter(Boolean);
    for (const [index, section] of resolvedSections.entries()) {
      if (index > 0) {
        container.addSeparatorComponents(new SeparatorBuilder());
      }
      addText(container, section);
    }
    return container;
  }

  const question = input.request.questions[input.page]!;
  const draft = input.drafts[input.page] ?? emptyQuestionDraft();
  const options = optionSlice(question, input.optionPages[input.page] ?? 0);
  const allAnswered = input.request.questions.every((item, index) =>
    questionAnswered(item, input.drafts[index] ?? emptyQuestionDraft()),
  );
  const optionPageLabel =
    options.totalPages > 1
      ? lines(
          `**Choice page ${options.page + 1}/${options.totalPages}**`,
          `${options.start + 1}-${options.start + options.items.length} of ${question.options.length} options`,
        )
      : null;

  container.addSeparatorComponents(new SeparatorBuilder());
  addText(container, renderActiveQuestionText(input));
  addText(container, renderAnswerText(input));
  addText(container, optionPageLabel);
  addText(container, renderQuestionHints(input));

  if (question.options.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(setQuestionActionId(action({ kind: "select", questionIndex: input.page })))
      .setPlaceholder(
        options.totalPages === 1
          ? question.multiple
            ? "Select one or more answers"
            : "Select one answer"
          : `Select from options ${options.start + 1}-${options.start + options.items.length}`,
      )
      .setMinValues(1)
      .setMaxValues(
        question.multiple ? Math.min(options.items.length, QUESTION_OPTIONS_PER_PAGE) : 1,
      )
      .addOptions(
        options.items.map((option) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(option.label)
            .setDescription(compact(option.description, 100))
            .setValue(option.label)
            .setDefault(draft.selectedOptions.includes(option.label)),
        ),
      );

    container.addActionRowComponents((row) => row.addComponents(select));
  }

  const questionButtons: ButtonBuilder[] = [
    questionButton({ kind: "question-prev" }, "Prev", ButtonStyle.Secondary, input.page === 0),
    questionButton(
      { kind: "question-next" },
      "Next",
      ButtonStyle.Secondary,
      input.page === input.request.questions.length - 1,
    ),
    questionButton(
      { kind: "clear", questionIndex: input.page },
      "Clear",
      ButtonStyle.Secondary,
      questionAnswer(question, draft).length === 0,
    ),
  ];

  if (questionAllowsCustom(question)) {
    questionButtons.push(
      questionButton(
        { kind: "custom", questionIndex: input.page },
        draft.customAnswer ? "Edit other..." : "Other...",
        ButtonStyle.Primary,
      ),
    );
  }

  addButtons(container, ...questionButtons);

  if (options.totalPages > 1) {
    addButtons(
      container,
      questionButton(
        { kind: "option-prev", questionIndex: input.page },
        "Prev choices",
        ButtonStyle.Secondary,
        options.page === 0,
      ),
      questionButton(
        { kind: "option-next", questionIndex: input.page },
        "Next choices",
        ButtonStyle.Secondary,
        options.page === options.totalPages - 1,
      ),
    );
  }

  addButtons(
    container,
    questionButton(
      { kind: "submit" },
      `Submit ${answerCount(input.request, input.drafts)}/${input.request.questions.length}`,
      ButtonStyle.Success,
      !allAnswered,
    ),
    questionButton({ kind: "reject" }, "Reject", ButtonStyle.Danger),
  );

  return container;
};

const renderQuestionMessage = (input: PendingQuestionBatchView) => ({
  components: [renderQuestionContainer(input)],
});

export const createQuestionMessageCreate = (
  input: PendingQuestionBatchView,
): MessageCreateOptions => ({
  ...renderQuestionMessage(input),
  flags: MessageFlags.IsComponentsV2,
});

export const createQuestionMessageEdit = (input: PendingQuestionBatchView): MessageEditOptions => ({
  ...renderQuestionMessage(input),
  content: null,
  flags: MessageFlags.IsComponentsV2,
});

export const questionDrafts = (request: QuestionRequest) =>
  request.questions.map(() => emptyQuestionDraft());

export const buildQuestionAnswers = (
  request: QuestionRequest,
  drafts: ReadonlyArray<QuestionDraft>,
): Array<QuestionAnswer> =>
  request.questions.map((question, index) =>
    questionAnswer(question, drafts[index] ?? emptyQuestionDraft()),
  );

export const setQuestionOptionSelection = (input: {
  question: QuestionInfo;
  draft: QuestionDraft;
  visibleOptions: ReadonlyArray<string>;
  selectedOptions: ReadonlyArray<string>;
}): QuestionDraft => {
  const { question, draft, visibleOptions, selectedOptions } = input;
  if (question.multiple) {
    const retained = draft.selectedOptions.filter((option) => !visibleOptions.includes(option));
    return {
      ...draft,
      selectedOptions: [...retained, ...selectedOptions],
    };
  }

  return {
    selectedOptions: selectedOptions.slice(0, 1),
    customAnswer: null,
  };
};

export const setQuestionCustomAnswer = (
  question: QuestionInfo,
  draft: QuestionDraft,
  customAnswer: string,
): QuestionDraft =>
  question.multiple
    ? {
        ...draft,
        customAnswer,
      }
    : {
        selectedOptions: [],
        customAnswer,
      };

export const clearQuestionDraft = (): QuestionDraft => emptyQuestionDraft();

export const buildQuestionModal = (input: {
  sessionID: string;
  requestID: string;
  version: number;
  questionIndex: number;
  question: QuestionInfo;
  draft: QuestionDraft;
}) =>
  new ModalBuilder()
    .setCustomId(
      setQuestionActionId(
        withQuestionActionMeta(input.sessionID, input.requestID, input.version, {
          kind: "modal",
          questionIndex: input.questionIndex,
        }),
      ),
    )
    .setTitle(compact(input.question.header || "Custom answer", 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(MODAL_INPUT_ID)
          .setLabel(compact(input.question.header || "Answer", 45))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setPlaceholder(compact(input.question.question, 100))
          .setValue(input.draft.customAnswer ?? ""),
      ),
    );

export const readQuestionModalValue = (interaction: {
  fields: { getTextInputValue: (customId: string) => string };
}) => interaction.fields.getTextInputValue(MODAL_INPUT_ID).trim();

export const questionInteractionReply = (message: string): InteractionReplyOptions => ({
  content: message,
  flags: MessageFlags.Ephemeral,
  allowedMentions: { parse: [] },
});
