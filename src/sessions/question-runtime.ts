import { Effect, Ref } from "effect"
import { type Interaction, type Message } from "discord.js"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"

import {
  buildQuestionAnswers,
  buildQuestionModal,
  clearQuestionDraft,
  createQuestionMessageCreate,
  createQuestionMessageEdit,
  parseQuestionActionId,
  QUESTION_OPTIONS_PER_PAGE,
  questionDrafts,
  questionInteractionReply,
  questionOptionPageCount,
  readQuestionModalValue,
  setQuestionCustomAnswer,
  setQuestionOptionSelection,
  type QuestionBatchStatus,
  type QuestionDraft,
} from "@/discord/question-card.ts"
import { expireQuestionBatch, setQuestionBatchStatus } from "@/sessions/question-batch-state.ts"
import { rejectQuestionBatch, submitQuestionBatch } from "@/sessions/question-submission.ts"
import type { SessionContext } from "@/sessions/session-lifecycle.ts"
import { questionUiFailureOutcome, type ActiveRun, type ChannelSession } from "@/sessions/session.ts"
import type { LoggerShape } from "@/util/logging.ts"

type PendingQuestionBatch = {
  request: QuestionRequest
  session: ChannelSession
  ownerId: string
  message: Message | null
  page: number
  optionPages: number[]
  drafts: QuestionDraft[]
  status: QuestionBatchStatus | "expired"
  resolvedAnswers?: Array<QuestionAnswer>
}

export type QuestionRuntimeEvent =
  | {
      type: "asked"
      sessionId: string
      request: QuestionRequest
    }
  | {
      type: "replied"
      sessionId: string
      requestId: string
      answers: ReadonlyArray<QuestionAnswer>
    }
  | {
      type: "rejected"
      sessionId: string
      requestId: string
    }

export type QuestionRuntime = {
  handleEvent: (event: QuestionRuntimeEvent) => Effect.Effect<void, unknown>
  handleInteraction: (interaction: Interaction) => Effect.Effect<boolean, unknown>
  expireForSession: (sessionId: string) => Effect.Effect<void, unknown>
}

type QuestionRuntimeDeps = {
  getSessionContext: (sessionId: string) => Effect.Effect<SessionContext | null>
  replyToQuestion: (
    session: ChannelSession["opencode"],
    requestID: string,
    answers: Array<QuestionAnswer>,
  ) => Effect.Effect<void, unknown>
  rejectQuestion: (
    session: ChannelSession["opencode"],
    requestID: string,
  ) => Effect.Effect<void, unknown>
  sendQuestionUiFailure: (message: Message, error: unknown) => Effect.Effect<void, unknown>
  logger: LoggerShape
  formatError: (error: unknown) => string
}

const questionBatchView = (batch: PendingQuestionBatch) => ({
  request: batch.request,
  page: batch.page,
  optionPages: batch.optionPages,
  drafts: batch.drafts,
  status: batch.status,
  resolvedAnswers: batch.resolvedAnswers,
})

export const createQuestionRuntime = (deps: QuestionRuntimeDeps): Effect.Effect<QuestionRuntime> =>
  Effect.gen(function* () {
    const batchesRef = yield* Ref.make(new Map<string, PendingQuestionBatch>())

    const getQuestionBatch = (requestId: string) =>
      Ref.get(batchesRef).pipe(Effect.map((batches) => batches.get(requestId) ?? null))

    const putQuestionBatch = (batch: PendingQuestionBatch) =>
      Ref.update(batchesRef, (current) => {
        const batches = new Map(current)
        batches.set(batch.request.id, batch)
        return batches
      })

    const updateQuestionBatch = (requestId: string, update: (batch: PendingQuestionBatch) => PendingQuestionBatch | null) =>
      Ref.modify(batchesRef, (current): readonly [PendingQuestionBatch | null, Map<string, PendingQuestionBatch>] => {
        const existing = current.get(requestId)
        if (!existing) {
          return [null, current]
        }

        const nextBatch = update(existing)
        const batches = new Map(current)
        if (nextBatch) {
          batches.set(requestId, nextBatch)
        } else {
          batches.delete(requestId)
        }
        return [nextBatch, batches]
      })

    const removeQuestionBatch = (requestId: string) =>
      Ref.modify(batchesRef, (current): readonly [PendingQuestionBatch | null, Map<string, PendingQuestionBatch>] => {
        const existing = current.get(requestId) ?? null
        if (!existing) {
          return [null, current]
        }

        const batches = new Map(current)
        batches.delete(requestId)
        return [existing, batches]
      })

    const hasPendingQuestionsForSession = (sessionId: string) =>
      Ref.get(batchesRef).pipe(
        Effect.map((batches) =>
          [...batches.values()].some(
            (batch) =>
              batch.session.opencode.sessionId === sessionId &&
              (batch.status === "active" || batch.status === "submitting"),
          ),
        ),
      )

    const syncTypingForSession = (sessionId: string) =>
      deps.getSessionContext(sessionId).pipe(
        Effect.flatMap((context) => {
          const activeRun = context?.activeRun ?? null
          if (!activeRun) {
            return Effect.void
          }

          return hasPendingQuestionsForSession(sessionId).pipe(
            Effect.flatMap((hasPendingQuestions) => {
              if (hasPendingQuestions) {
                return Effect.promise(() => activeRun.typing.pause()).pipe(
                  Effect.timeoutOption("1 second"),
                  Effect.flatMap((result) =>
                    result._tag === "Some"
                      ? Effect.void
                      : deps.logger.warn("typing pause timed out while question prompt was active", {
                          channelId: activeRun.discordMessage.channelId,
                          sessionId,
                        }),
                  ),
                )
              }

              return Effect.sync(() => {
                activeRun.typing.resume()
              })
            }),
          )
        }),
      )

    const editQuestionMessage = (batch: PendingQuestionBatch) => {
      const message = batch.message
      if (!message) {
        return Effect.void
      }

      return Effect.promise(() => message.edit(createQuestionMessageEdit(questionBatchView(batch)))).pipe(
        Effect.asVoid,
      )
    }

    const replyToQuestionInteraction = (interaction: Interaction, message: string) => {
      if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) {
        return Effect.void
      }
      if (interaction.replied || interaction.deferred) {
        return Effect.void
      }
      return Effect.promise(() => interaction.reply(questionInteractionReply(message))).pipe(Effect.ignore)
    }

    const handleQuestionAsked = (session: ChannelSession, activeRun: ActiveRun, request: QuestionRequest) =>
      Effect.gen(function* () {
        const existing = yield* getQuestionBatch(request.id)
        if (existing) {
          return
        }

        const batch: PendingQuestionBatch = {
          request,
          session,
          ownerId: activeRun.discordMessage.author.id,
          message: null,
          page: 0,
          optionPages: request.questions.map(() => 0),
          drafts: questionDrafts(request),
          status: "active",
        }

        const questionMessage = yield* Effect.tryPromise({
          try: () =>
            activeRun.discordMessage.reply({
              ...createQuestionMessageCreate(questionBatchView(batch)),
              allowedMentions: { repliedUser: true, parse: ["users", "roles", "everyone"] },
            }),
          catch: (error) => error,
        }).pipe(
          Effect.timeoutFail({
            duration: "5 seconds",
            onTimeout: () => new Error("Timed out sending question batch to Discord"),
          }),
          Effect.either,
        )

        if (questionMessage._tag === "Right") {
          yield* putQuestionBatch({
            ...batch,
            message: questionMessage.right,
          })
          yield* syncTypingForSession(session.opencode.sessionId)
          return
        }

        const questionUiFailure = deps.formatError(questionMessage.left)
        activeRun.questionOutcome = questionUiFailureOutcome(questionUiFailure)

        yield* deps.logger.error("failed to post question batch", {
          channelId: session.channelId,
          sessionId: session.opencode.sessionId,
          requestId: request.id,
          error: deps.formatError(questionMessage.left),
        })

        const rejectResult = yield* deps.rejectQuestion(session.opencode, request.id).pipe(Effect.either)
        if (rejectResult._tag === "Left") {
          yield* deps.logger.error("failed to reject question batch after UI failure", {
            channelId: session.channelId,
            sessionId: session.opencode.sessionId,
            requestId: request.id,
            error: deps.formatError(rejectResult.left),
          })

          yield* Effect.promise(() => activeRun.typing.stop()).pipe(Effect.ignore)
          const failureReply = yield* deps.sendQuestionUiFailure(activeRun.discordMessage, questionUiFailure).pipe(
            Effect.either,
          )
          if (failureReply._tag === "Right") {
            activeRun.questionOutcome = questionUiFailureOutcome(questionUiFailure, true)
          } else {
            yield* deps.logger.error("failed to send question UI failure message", {
              channelId: session.channelId,
              sessionId: session.opencode.sessionId,
              requestId: request.id,
              error: deps.formatError(failureReply.left),
            })
          }
          return
        }

        yield* syncTypingForSession(session.opencode.sessionId)
      })

    const finalizeQuestionBatch = (
      requestId: string,
      status: "answered" | "rejected",
      resolvedAnswers?: ReadonlyArray<QuestionAnswer>,
    ) =>
      Effect.gen(function* () {
        const batch = yield* updateQuestionBatch(requestId, (current) =>
          setQuestionBatchStatus(current, status, resolvedAnswers),
        )
        if (!batch) {
          return
        }

        yield* editQuestionMessage(batch).pipe(
          Effect.catchAll((error) =>
            deps.logger.warn("failed to edit finalized question batch", {
              channelId: batch.session.channelId,
              sessionId: batch.session.opencode.sessionId,
              requestId,
              error: deps.formatError(error),
            }),
          ),
        )
        yield* removeQuestionBatch(requestId)
        yield* syncTypingForSession(batch.session.opencode.sessionId)
      })

    const persistQuestionBatch = (
      requestId: string,
      update: (batch: PendingQuestionBatch) => PendingQuestionBatch | null,
    ) => updateQuestionBatch(requestId, update)

    const updateInteraction = (interaction: Interaction, batch: PendingQuestionBatch) => {
      if (!interaction.isButton()) {
        return Effect.void
      }
      return Effect.promise(() => interaction.update(createQuestionMessageEdit(questionBatchView(batch))))
    }

    const questionSubmissionRuntime = {
      persistBatch: persistQuestionBatch,
      updateInteraction,
      editBatch: editQuestionMessage,
      finalizeBatch: finalizeQuestionBatch,
      replyExpired: (interaction: Interaction) =>
        replyToQuestionInteraction(interaction, "This question prompt has expired."),
      followUpFailure: (interaction: Interaction, message: string) => {
        if (!interaction.isButton()) {
          return Effect.void
        }
        return Effect.promise(() => interaction.followUp(questionInteractionReply(message)))
      },
      submitToOpencode: deps.replyToQuestion,
      rejectInOpencode: deps.rejectQuestion,
      formatError: deps.formatError,
    } as const

    const currentQuestionDraft = (batch: PendingQuestionBatch, questionIndex: number) =>
      batch.drafts[questionIndex] ?? clearQuestionDraft()

    const applyQuestionUpdate = (
      interaction: Interaction,
      requestId: string,
      update: (batch: PendingQuestionBatch) => PendingQuestionBatch | null,
    ) =>
      Effect.gen(function* () {
        if (!interaction.isButton() && !interaction.isStringSelectMenu()) {
          return false
        }

        const batch = yield* persistQuestionBatch(requestId, update)
        if (!batch) {
          yield* replyToQuestionInteraction(interaction, "This question prompt is no longer active.")
          return true
        }

        yield* Effect.promise(() => interaction.update(createQuestionMessageEdit(questionBatchView(batch))))
        return true
      })

    const handleInteraction = (interaction: Interaction): Effect.Effect<boolean, unknown> =>
      Effect.gen(function* () {
        if (!interaction.isButton() && !interaction.isStringSelectMenu() && !interaction.isModalSubmit()) {
          return false
        }

        const action = parseQuestionActionId(interaction.customId)
        if (!action) {
          return false
        }

        const batch = yield* getQuestionBatch(action.requestID)
        if (!batch) {
          yield* replyToQuestionInteraction(interaction, "This question prompt has expired.")
          return true
        }

        if (interaction.user.id !== batch.ownerId) {
          yield* replyToQuestionInteraction(interaction, "Only the user who started this run can answer these questions.")
          return true
        }

        if ((interaction.isButton() || interaction.isStringSelectMenu()) && batch.message && interaction.message.id !== batch.message.id) {
          yield* replyToQuestionInteraction(interaction, "This question prompt has been replaced.")
          return true
        }

        if (batch.status !== "active") {
          yield* replyToQuestionInteraction(interaction, "This question prompt is already being finalized.")
          return true
        }

        switch (action.kind) {
          case "question-prev":
            return yield* applyQuestionUpdate(interaction, action.requestID, (current) => ({
              ...current,
              page: Math.max(0, current.page - 1),
            }))
          case "question-next":
            return yield* applyQuestionUpdate(interaction, action.requestID, (current) => ({
              ...current,
              page: Math.min(current.request.questions.length - 1, current.page + 1),
            }))
          case "option-prev":
            return yield* applyQuestionUpdate(interaction, action.requestID, (current) => {
              const optionPages = [...current.optionPages]
              optionPages[action.questionIndex] = Math.max(0, (optionPages[action.questionIndex] ?? 0) - 1)
              return {
                ...current,
                page: action.questionIndex,
                optionPages,
              }
            })
          case "option-next":
            return yield* applyQuestionUpdate(interaction, action.requestID, (current) => {
              const question = current.request.questions[action.questionIndex]
              if (!question) {
                return current
              }
              const maxOptionPage = Math.max(0, questionOptionPageCount(question) - 1)
              const optionPages = [...current.optionPages]
              optionPages[action.questionIndex] = Math.min(maxOptionPage, (optionPages[action.questionIndex] ?? 0) + 1)
              return {
                ...current,
                page: action.questionIndex,
                optionPages,
              }
            })
          case "clear":
            return yield* applyQuestionUpdate(interaction, action.requestID, (current) => {
              const drafts = [...current.drafts]
              drafts[action.questionIndex] = clearQuestionDraft()
              return {
                ...current,
                page: action.questionIndex,
                drafts,
              }
            })
          case "select":
            if (!interaction.isStringSelectMenu()) {
              return false
            }

            return yield* applyQuestionUpdate(interaction, action.requestID, (current) => {
              const question = current.request.questions[action.questionIndex]
              if (!question) {
                return current
              }

              const page = current.optionPages[action.questionIndex] ?? 0
              const visibleOptions = question.options
                .slice(
                  page * QUESTION_OPTIONS_PER_PAGE,
                  page * QUESTION_OPTIONS_PER_PAGE + QUESTION_OPTIONS_PER_PAGE,
                )
                .map((option) => option.label)
              const drafts = [...current.drafts]
              drafts[action.questionIndex] = setQuestionOptionSelection({
                question,
                draft: currentQuestionDraft(current, action.questionIndex),
                visibleOptions,
                selectedOptions: interaction.values,
              })
              return {
                ...current,
                page: action.questionIndex,
                drafts,
              }
            })
          case "custom":
            if (!interaction.isButton()) {
              return false
            }

            {
              const question = batch.request.questions[action.questionIndex]
              if (!question || question.custom === false) {
                yield* replyToQuestionInteraction(interaction, "This question does not allow a custom answer.")
                return true
              }

              yield* Effect.promise(() =>
                interaction.showModal(
                  buildQuestionModal({
                    requestID: action.requestID,
                    questionIndex: action.questionIndex,
                    question,
                    draft: currentQuestionDraft(batch, action.questionIndex),
                  }),
                ),
              )
              return true
            }
          case "modal":
            if (!interaction.isModalSubmit()) {
              return false
            }

            {
              const question = batch.request.questions[action.questionIndex]
              if (!question || question.custom === false) {
                yield* replyToQuestionInteraction(interaction, "This question does not allow a custom answer.")
                return true
              }

              const customAnswer = readQuestionModalValue(interaction)
              if (!customAnswer) {
                yield* Effect.promise(() =>
                  interaction.reply(questionInteractionReply("Custom answer cannot be empty.")),
                ).pipe(Effect.ignore)
                return true
              }

              const updated = yield* persistQuestionBatch(action.requestID, (current) => {
                const drafts = [...current.drafts]
                drafts[action.questionIndex] = setQuestionCustomAnswer(
                  question,
                  currentQuestionDraft(current, action.questionIndex),
                  customAnswer,
                )
                return {
                  ...current,
                  page: action.questionIndex,
                  drafts,
                }
              })
              if (!updated) {
                yield* replyToQuestionInteraction(interaction, "This question prompt has expired.")
                return true
              }

              yield* editQuestionMessage(updated).pipe(
                Effect.catchAll((error) =>
                  deps.logger.warn("failed to edit question batch after modal submit", {
                    channelId: updated.session.channelId,
                    sessionId: updated.session.opencode.sessionId,
                    requestId: updated.request.id,
                    error: deps.formatError(error),
                  }),
                ),
              )
              yield* Effect.promise(() => interaction.deferUpdate()).pipe(Effect.ignore)
              return true
            }
          case "submit":
            if (!interaction.isButton()) {
              return false
            }

            return yield* submitQuestionBatch(questionSubmissionRuntime)({
              interaction,
              requestId: action.requestID,
              answers: buildQuestionAnswers(batch.request, batch.drafts),
            })
          case "reject":
            if (!interaction.isButton()) {
              return false
            }

            return yield* rejectQuestionBatch(questionSubmissionRuntime)({
              interaction,
              requestId: action.requestID,
            })
        }
      })

    const expireForSession = (sessionId: string) =>
      Effect.gen(function* () {
        const expired = yield* Ref.modify(
          batchesRef,
          (current): readonly [PendingQuestionBatch[], Map<string, PendingQuestionBatch>] => {
            const stale = [...current.values()].filter(
              (batch) =>
                batch.session.opencode.sessionId === sessionId &&
                (batch.status === "active" || batch.status === "submitting"),
            )
            if (stale.length === 0) {
              return [[], current]
            }

            const batches = new Map(current)
            for (const batch of stale) {
              batches.delete(batch.request.id)
            }

            return [stale.map((batch) => expireQuestionBatch(batch)), batches]
          },
        )

        yield* Effect.forEach(
          expired,
          (batch) =>
            editQuestionMessage(batch).pipe(
              Effect.catchAll((error) =>
                deps.logger.warn("failed to expire question batch message", {
                  channelId: batch.session.channelId,
                  sessionId: batch.session.opencode.sessionId,
                  requestId: batch.request.id,
                  error: deps.formatError(error),
                }),
              ),
            ),
          { concurrency: "unbounded" },
        ).pipe(Effect.asVoid)
      })

    return {
      handleEvent: (event) => {
        switch (event.type) {
          case "asked":
            return deps.getSessionContext(event.sessionId).pipe(
              Effect.flatMap((context) => {
                if (!context?.activeRun) {
                  return Effect.void
                }
                return handleQuestionAsked(context.session, context.activeRun, event.request)
              }),
            )
          case "replied":
            return finalizeQuestionBatch(event.requestId, "answered", event.answers)
          case "rejected":
            return finalizeQuestionBatch(event.requestId, "rejected")
        }
      },
      handleInteraction,
      expireForSession,
    } satisfies QuestionRuntime
  })
