import { describe, expect, test } from "bun:test"
import { Effect, Queue, Ref } from "effect"
import type { Message } from "discord.js"

import { buildQueuedFollowUpPrompt } from "@/discord/messages.ts"
import { coordinateActiveRunPrompts } from "@/sessions/prompt-coordinator.ts"
import { enqueueRunRequest } from "@/sessions/request-routing.ts"
import type { RunRequest } from "@/sessions/session.ts"
import type { PromptResult, SessionHandle } from "@/opencode/service.ts"
import type { LoggerShape } from "@/util/logging.ts"

const makeMessage = (id: string) =>
  ({
    id,
    attachments: new Map(),
  }) as unknown as Message

const makeRequest = (id: string, prompt = `prompt-${id}`, attachmentMessageIds: ReadonlyArray<string> = [id]): RunRequest => ({
  message: makeMessage(id),
  prompt,
  attachmentMessages: attachmentMessageIds.map((messageId) => makeMessage(messageId)),
})

const makeLogger = (): LoggerShape => ({
  info: () => Effect.void,
  warn: () => Effect.void,
  error: () => Effect.void,
})

const makeSessionHandle = (): SessionHandle =>
  ({
    sessionId: "ses-1",
    client: {} as never,
    workdir: "/tmp/workdir",
    backend: "bwrap",
    close: () => Effect.void,
  }) satisfies SessionHandle

const makeActiveRunState = async () => ({
  attachmentMessagesById: new Map<string, Message>(),
  followUpQueue: await Effect.runPromise(Queue.unbounded<RunRequest>()),
  acceptFollowUps: await Effect.runPromise(Ref.make(true)),
})

describe("coordinateActiveRunPrompts", () => {
  test("prompts the initial batch, absorbs queued follow-ups, and returns the last result", async () => {
    const activeRun = await makeActiveRunState()
    const promptCalls: string[] = []
    const prompt = (_session: SessionHandle, value: string) =>
      Effect.sync(() => {
        promptCalls.push(value)
        return {
          messageId: `msg-${promptCalls.length}`,
          transcript: `reply-${promptCalls.length}`,
        } satisfies PromptResult
      })

    await Effect.runPromise(Queue.offerAll(activeRun.followUpQueue, [
      makeRequest("m-2", "follow-1", ["m-2", "m-3"]),
      makeRequest("m-4", "follow-2", ["m-4"]),
    ]))

    const result = await Effect.runPromise(
      coordinateActiveRunPrompts({
        channelId: "c-1",
        session: makeSessionHandle(),
        activeRun,
        initialRequests: [makeRequest("m-1", "initial", ["m-1"])],
        prompt,
        logger: makeLogger(),
      }),
    )

    expect(promptCalls).toEqual([
      "initial",
      buildQueuedFollowUpPrompt(["follow-1", "follow-2"]),
    ])
    expect(result).toEqual({
      messageId: "msg-2",
      transcript: "reply-2",
    })
    expect([...activeRun.attachmentMessagesById.keys()]).toEqual(["m-1", "m-2", "m-3", "m-4"])
  })

  test("reopens follow-up intake before the follow-up prompt and leaves it closed on exit", async () => {
    const activeRun = await makeActiveRunState()
    const gateSnapshots: boolean[] = []
    const prompt = (_session: SessionHandle, _value: string) =>
      Ref.get(activeRun.acceptFollowUps).pipe(
        Effect.map((gate) => {
          gateSnapshots.push(gate)
          return {
            messageId: `msg-${gateSnapshots.length}`,
            transcript: `reply-${gateSnapshots.length}`,
          } satisfies PromptResult
        }),
      )

    await Effect.runPromise(Queue.offer(activeRun.followUpQueue, makeRequest("m-2", "follow-up")))

    await Effect.runPromise(
      coordinateActiveRunPrompts({
        channelId: "c-1",
        session: makeSessionHandle(),
        activeRun,
        initialRequests: [makeRequest("m-1", "initial")],
        prompt,
        logger: makeLogger(),
      }),
    )

    expect(gateSnapshots).toEqual([true, true])
    expect(await Effect.runPromise(Ref.get(activeRun.acceptFollowUps))).toBe(false)
  })

  test("absorbs a follow-up queued while the first prompt is running", async () => {
    const activeRun = await makeActiveRunState()
    const sessionQueue = await Effect.runPromise(Queue.unbounded<RunRequest>())
    const session = {
      queue: sessionQueue,
      activeRun,
    } satisfies Parameters<typeof enqueueRunRequest>[0]
    const promptCalls: string[] = []
    const queuedFollowUp = makeRequest("m-2", "later", ["m-2", "m-3"])

    const prompt = (_session: SessionHandle, value: string) =>
      Effect.gen(function* () {
        promptCalls.push(value)
        if (promptCalls.length === 1) {
          const destination = yield* enqueueRunRequest(session, queuedFollowUp)
          expect(destination).toBe("follow-up")
        }
        return {
          messageId: `msg-${promptCalls.length}`,
          transcript: `reply-${promptCalls.length}`,
        } satisfies PromptResult
      })

    const result = await Effect.runPromise(
      coordinateActiveRunPrompts({
        channelId: "c-1",
        session: makeSessionHandle(),
        activeRun,
        initialRequests: [makeRequest("m-1", "initial", ["m-1"])],
        prompt,
        logger: makeLogger(),
      }),
    )

    expect(promptCalls).toEqual([
      "initial",
      buildQueuedFollowUpPrompt(["later"]),
    ])
    expect(result.messageId).toBe("msg-2")
    expect([...activeRun.attachmentMessagesById.keys()]).toEqual(["m-1", "m-2", "m-3"])
    expect(await Effect.runPromise(Queue.takeAll(sessionQueue).pipe(Effect.map((items) => [...items])))).toEqual([])
  })
})
