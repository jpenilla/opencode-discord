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
} from "discord.js"
import type { QuestionAnswer, QuestionInfo, QuestionRequest } from "@opencode-ai/sdk/v2"

const CUSTOM_ID_PREFIX = "ocq"
const MODAL_INPUT_ID = "answer"
export const QUESTION_OPTIONS_PER_PAGE = 25

export type QuestionDraft = {
  selectedOptions: string[]
  customAnswer: string | null
}

export type QuestionBatchStatus = "active" | "submitting" | "answered" | "rejected"

export type PendingQuestionBatchView = {
  request: QuestionRequest
  page: number
  optionPages: ReadonlyArray<number>
  drafts: ReadonlyArray<QuestionDraft>
  status: QuestionBatchStatus | "expired"
  resolvedAnswers?: ReadonlyArray<QuestionAnswer>
}

type QuestionAction =
  | { kind: "question-prev"; requestID: string }
  | { kind: "question-next"; requestID: string }
  | { kind: "option-prev"; requestID: string; questionIndex: number }
  | { kind: "option-next"; requestID: string; questionIndex: number }
  | { kind: "clear"; requestID: string; questionIndex: number }
  | { kind: "select"; requestID: string; questionIndex: number }
  | { kind: "custom"; requestID: string; questionIndex: number }
  | { kind: "submit"; requestID: string }
  | { kind: "reject"; requestID: string }
  | { kind: "modal"; requestID: string; questionIndex: number }

const compact = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength - 1)}…`
}

const lines = (...parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join("\n")

const questionAllowsCustom = (question: QuestionInfo) => question.custom !== false

const questionAnswer = (question: QuestionInfo, draft: QuestionDraft): QuestionAnswer => {
  if (question.multiple) {
    return draft.customAnswer ? [...draft.selectedOptions, draft.customAnswer] : [...draft.selectedOptions]
  }

  if (draft.customAnswer) {
    return [draft.customAnswer]
  }

  return draft.selectedOptions.slice(0, 1)
}

const questionAnswered = (question: QuestionInfo, draft: QuestionDraft) => questionAnswer(question, draft).length > 0

const answerSummary = (answers: ReadonlyArray<string>) =>
  answers.length === 0 ? "*(none yet)*" : answers.map((answer) => `- \`${compact(answer, 180)}\``).join("\n")

const answerCount = (request: QuestionRequest, drafts: ReadonlyArray<QuestionDraft>) =>
  request.questions.reduce((count, question, index) => count + (questionAnswered(question, drafts[index] ?? emptyQuestionDraft()) ? 1 : 0), 0)

export const questionOptionPageCount = (question: QuestionInfo) =>
  Math.max(1, Math.ceil(question.options.length / QUESTION_OPTIONS_PER_PAGE))

const optionSlice = (question: QuestionInfo, page: number) => {
  const totalPages = questionOptionPageCount(question)
  const normalizedPage = Math.min(Math.max(0, page), totalPages - 1)
  const start = normalizedPage * QUESTION_OPTIONS_PER_PAGE
  return {
    page: normalizedPage,
    totalPages,
    items: question.options.slice(start, start + QUESTION_OPTIONS_PER_PAGE),
    start,
  }
}

const emptyQuestionDraft = (): QuestionDraft => ({
  selectedOptions: [],
  customAnswer: null,
})

const setQuestionActionId = (action: QuestionAction) => {
  switch (action.kind) {
    case "question-prev":
    case "question-next":
    case "submit":
    case "reject":
      return [CUSTOM_ID_PREFIX, action.requestID, action.kind].join(":")
    case "clear":
    case "select":
    case "custom":
    case "option-prev":
    case "option-next":
    case "modal":
      return [CUSTOM_ID_PREFIX, action.requestID, action.kind, String(action.questionIndex)].join(":")
  }
}

export const parseQuestionActionId = (customId: string): QuestionAction | null => {
  const [prefix, requestID, kind, questionIndex] = customId.split(":")
  if (prefix !== CUSTOM_ID_PREFIX || !requestID || !kind) {
    return null
  }

  switch (kind) {
    case "question-prev":
      return { kind, requestID }
    case "question-next":
      return { kind, requestID }
    case "submit":
      return { kind, requestID }
    case "reject":
      return { kind, requestID }
    case "clear":
    case "select":
    case "custom":
    case "option-prev":
    case "option-next":
    case "modal": {
      const parsedIndex = Number(questionIndex)
      if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
        return null
      }
      return { kind, requestID, questionIndex: parsedIndex }
    }
    default:
      return null
  }
}

const renderQuestionBody = (input: PendingQuestionBatchView) => {
  if (input.status === "answered" || input.status === "rejected" || input.status === "expired") {
    const resolvedAnswers = input.resolvedAnswers ?? input.request.questions.map((question, index) => questionAnswer(question, input.drafts[index] ?? emptyQuestionDraft()))
    return lines(
      input.status === "answered"
        ? "## ✅ Questions answered"
        : input.status === "rejected"
          ? "## ⛔ Questions rejected"
          : "## ⏱️ Questions expired",
      ...input.request.questions.flatMap((question, index) => {
        const answers = resolvedAnswers[index] ?? []
        return ["", `**${question.header}**`, question.question, answerSummary(answers)]
      }),
    )
  }

  const question = input.request.questions[input.page]!
  const draft = input.drafts[input.page] ?? emptyQuestionDraft()
  const answers = questionAnswer(question, draft)
  const answered = answerCount(input.request, input.drafts)
  const options = optionSlice(question, input.optionPages[input.page] ?? 0)
  const optionLabel =
    question.options.length === 0
      ? null
      : options.totalPages === 1
        ? `${question.options.length} option${question.options.length === 1 ? "" : "s"}`
        : `Options ${options.start + 1}-${options.start + options.items.length} of ${question.options.length} (page ${options.page + 1}/${options.totalPages})`

  return lines(
    input.status === "submitting" ? "## ⏳ Submitting answers..." : "## ❓ Questions need answers",
    `**${question.header}**`,
    `Question ${input.page + 1}/${input.request.questions.length} · ${answered}/${input.request.questions.length} answered`,
    optionLabel ? optionLabel : null,
    "",
    question.question,
    "",
    "Current answer:",
    answerSummary(answers),
    question.options.length > QUESTION_OPTIONS_PER_PAGE
      ? "_This question has more than 25 options. Use the option page buttons to navigate the full list._"
      : null,
    question.multiple ? "_Multiple selections allowed._" : null,
    questionAllowsCustom(question) ? "_Use Other... for a custom answer._" : null,
  )
}

const renderQuestionComponents = (input: PendingQuestionBatchView) => {
  if (input.status !== "active") {
    return []
  }

  const question = input.request.questions[input.page]!
  const draft = input.drafts[input.page] ?? emptyQuestionDraft()
  const options = optionSlice(question, input.optionPages[input.page] ?? 0)
  const allAnswered = input.request.questions.every((item, index) => questionAnswered(item, input.drafts[index] ?? emptyQuestionDraft()))
  const components: Array<ActionRowBuilder<any>> = []

  if (question.options.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(setQuestionActionId({ kind: "select", requestID: input.request.id, questionIndex: input.page }))
      .setPlaceholder(
        options.totalPages === 1
          ? question.multiple
            ? "Select one or more answers"
            : "Select one answer"
          : `Select from options ${options.start + 1}-${options.start + options.items.length}`,
      )
      .setMinValues(1)
      .setMaxValues(question.multiple ? Math.min(options.items.length, QUESTION_OPTIONS_PER_PAGE) : 1)
      .addOptions(
        options.items.map((option) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(option.label)
            .setDescription(compact(option.description, 100))
            .setValue(option.label)
            .setDefault(draft.selectedOptions.includes(option.label)),
        ),
      )

    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select))
  }

  const questionButtons = [
    new ButtonBuilder()
      .setCustomId(setQuestionActionId({ kind: "question-prev", requestID: input.request.id }))
      .setLabel("Prev")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page === 0),
    new ButtonBuilder()
      .setCustomId(setQuestionActionId({ kind: "question-next", requestID: input.request.id }))
      .setLabel("Next")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(input.page === input.request.questions.length - 1),
    new ButtonBuilder()
      .setCustomId(setQuestionActionId({ kind: "clear", requestID: input.request.id, questionIndex: input.page }))
      .setLabel("Clear")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(questionAnswer(question, draft).length === 0),
  ]

  if (questionAllowsCustom(question)) {
    questionButtons.push(
      new ButtonBuilder()
        .setCustomId(setQuestionActionId({ kind: "custom", requestID: input.request.id, questionIndex: input.page }))
        .setLabel(draft.customAnswer ? "Edit other..." : "Other...")
        .setStyle(ButtonStyle.Primary),
    )
  }

  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(questionButtons))

  if (options.totalPages > 1) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(setQuestionActionId({ kind: "option-prev", requestID: input.request.id, questionIndex: input.page }))
          .setLabel("Prev options")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(options.page === 0),
        new ButtonBuilder()
          .setCustomId(setQuestionActionId({ kind: "option-next", requestID: input.request.id, questionIndex: input.page }))
          .setLabel("Next options")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(options.page === options.totalPages - 1),
      ),
    )
  }

  components.push(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(setQuestionActionId({ kind: "submit", requestID: input.request.id }))
        .setLabel("Submit answers")
        .setStyle(ButtonStyle.Success)
        .setDisabled(!allAnswered),
      new ButtonBuilder()
        .setCustomId(setQuestionActionId({ kind: "reject", requestID: input.request.id }))
        .setLabel("Reject")
        .setStyle(ButtonStyle.Danger),
    ),
  )

  return components
}

const renderQuestionMessage = (input: PendingQuestionBatchView) => ({
  content: renderQuestionBody(input),
  components: renderQuestionComponents(input),
  allowedMentions: { parse: [] as Array<never> },
})

export const createQuestionMessageCreate = (input: PendingQuestionBatchView): MessageCreateOptions => ({
  ...renderQuestionMessage(input),
  flags: MessageFlags.SuppressNotifications,
})

export const createQuestionMessageEdit = (input: PendingQuestionBatchView): MessageEditOptions => renderQuestionMessage(input)

export const questionDrafts = (request: QuestionRequest) => request.questions.map(() => emptyQuestionDraft())

export const buildQuestionAnswers = (request: QuestionRequest, drafts: ReadonlyArray<QuestionDraft>): Array<QuestionAnswer> =>
  request.questions.map((question, index) => questionAnswer(question, drafts[index] ?? emptyQuestionDraft()))

export const setQuestionOptionSelection = (input: {
  question: QuestionInfo
  draft: QuestionDraft
  visibleOptions: ReadonlyArray<string>
  selectedOptions: ReadonlyArray<string>
}): QuestionDraft => {
  const { question, draft, visibleOptions, selectedOptions } = input
  if (question.multiple) {
    const retained = draft.selectedOptions.filter((option) => !visibleOptions.includes(option))
    return {
      ...draft,
      selectedOptions: [...retained, ...selectedOptions],
    }
  }

  return {
    selectedOptions: selectedOptions.slice(0, 1),
    customAnswer: null,
  }
}

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
      }

export const clearQuestionDraft = (): QuestionDraft => emptyQuestionDraft()

export const buildQuestionModal = (input: {
  requestID: string
  questionIndex: number
  question: QuestionInfo
  draft: QuestionDraft
}) =>
  new ModalBuilder()
    .setCustomId(setQuestionActionId({ kind: "modal", requestID: input.requestID, questionIndex: input.questionIndex }))
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
    )

export const readQuestionModalValue = (interaction: { fields: { getTextInputValue: (customId: string) => string } }) =>
  interaction.fields.getTextInputValue(MODAL_INPUT_ID).trim()

export const questionInteractionReply = (message: string): InteractionReplyOptions => ({
  content: message,
  flags: MessageFlags.Ephemeral,
  allowedMentions: { parse: [] },
})
