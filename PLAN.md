# Discord Bot Frontend for Opencode

## Goal

Build a Discord bot frontend for opencode in this repository using Bun, TypeScript, Effect, and Discord.js. The bot should let users interact with a long-lived opencode session per Discord channel by using a trigger phrase, mentioning the bot, or replying to the bot. Responses should be sent back only once complete, never streamed token-by-token into Discord.

## Confirmed Product Requirements

### Supported Discord Surfaces

- Guild text channels only for v1.
- No DMs, forum posts, or other Discord surfaces in the initial implementation.

### Invocation Rules

The bot should respond when any of the following are true:

- A user mentions the bot.
- A user sends a message whose content starts with the trigger phrase `hey opencode`.
- A user replies to a previous bot message.

Additional parsing rules:

- Mention-based invocations should strip the mention before forwarding text to opencode.
- The trigger phrase should only match as a leading prefix.
- Reply-to-bot messages should include the replied-to bot message text as context.

### Session and Conversation Model

- One opencode session per Discord channel.
- That session is long-lived for the duration of the bot process.
- If users send more messages in the same channel later, including hours later, the same opencode session should continue.
- No persistence across app restarts for v1.

### Concurrency Model

- Only one active opencode run per channel.
- Additional requests in the same channel should queue and run in order.
- Different channels may run concurrently.

### Working Directories

- Each channel session gets its own working directory.
- Working directories should live under the system temp directory.
- Each working directory starts empty.
- Session working directories remain alive until process exit.
- No cleanup of inactive sessions during runtime for v1.

### Persistence and Logging

- All session metadata is in memory only for v1.
- No persistent transcripts.
- Keep structured local logs for debugging and operations.

### What Gets Forwarded to Opencode

Each submitted turn should include:

- The cleaned user text.
- A user identity prefix using the Discord user tag.
- Quoted replied-to message text when the invocation is a reply.
- Attachment metadata.
- Embed summaries.

### Discord Output Rules

- Do not stream partial responses to Discord.
- While opencode is running, show typing indicators only.
- Send the completed response once available.
- If the final response exceeds Discord message length limits, split it across multiple final messages.
- Failures should be returned as a concise error summary.

### Discord Tooling Requirements

V1 must support custom tools that allow opencode to:

- Send generated files back to Discord.
- Send images back to Discord.
- React to the invoking user message with emoji.

Tool constraints:

- File and image upload tools may only send files from the current session working directory.
- The reaction tool may only react to the message that triggered the current run.
- Any user in accessible guild text channels may trigger opencode and therefore indirectly trigger these tools.
- No extra file-size, MIME-type, or count guardrails are required in v1 beyond Discord's own constraints and the workdir path restriction.

### Channel Access Rules

- The bot should respond in all guild text channels it can access.
- No channel allowlist for v1.

### Commands

- No explicit slash or prefix commands in v1.
- Interaction is purely message-driven.

## Technical Decisions

### Discord Integration

Use Discord.js with Bun and TypeScript.

Confirmed via `btca ask`:

- The recommended model is a standard `Client` with `Events.MessageCreate`.
- Use `message.fetchReference()` for reply detection.
- Use `message.channel.sendTyping()` for typing indicators.
- Use `message.reply()` or `channel.send()` for final responses.
- Use `channel.send({ files: [...] })` for file and image uploads.
- Use `message.react()` for emoji reactions.
- Long responses should be split explicitly by the app rather than relying on automatic behavior.
- Bun is acceptable, but Discord.js remains primarily Node-oriented, so the implementation should stay close to standard Discord.js APIs and be verified carefully on Bun.

### Opencode Integration

Use a locally managed `opencode serve` process and the opencode TypeScript SDK.

Confirmed via `btca ask`:

- Long-lived conversation support is provided through opencode sessions.
- The best-supported integration for an external TypeScript app is `opencode serve` plus the JS/TS SDK or HTTP API.
- The app should create or reuse a session ID per Discord channel.
- To avoid streaming partial output, use the prompt API that waits for the final assistant message rather than consuming CLI output.
- Use the opencode SSE event stream to observe status and tool execution events.
- Custom tools are supported via repo-local `.opencode/tools` files or plugins.

For v1, choose:

- Spawn and supervise a local `opencode serve` process from the bot.
- Use the SDK as the primary app integration surface.
- Register custom tools under repo-local `.opencode/tools`.

### Effect Integration

Use Effect as the application architecture and lifecycle framework.

Confirmed via `btca ask`:

- Use `Context.Tag` and `Layer` to model services.
- Use scoped resources for the Discord client, the opencode server process, and background workers.
- Use in-memory refs for channel session state.
- Use a per-channel queue or mailbox worker model for strict FIFO execution per channel.
- Use `FiberSet` for background worker supervision.
- Use a top-level scoped runtime and graceful shutdown flow.

## Proposed System Architecture

### High-Level Components

1. `Config`
   - Loads environment variables and process configuration.
   - Includes Discord bot token and trigger phrase.

2. `DiscordGateway`
   - Owns the Discord.js client.
   - Parses incoming messages and detects invocation triggers.
   - Starts and refreshes typing indicators while work is running.
   - Sends final replies, file uploads, image uploads, and reactions.

3. `OpencodeServer`
   - Spawns and supervises a local `opencode serve` process.
   - Ensures startup readiness and clean shutdown.

4. `OpencodeClient`
   - Wraps the opencode SDK.
   - Creates and reuses channel-bound opencode sessions.
   - Submits prompts and waits for final assistant responses.
   - Subscribes to SSE events and routes them to the correct in-memory run state.

5. `ChannelSessionRegistry`
   - Stores all in-memory session state keyed by Discord channel ID.
   - Tracks session ID, temp workdir path, queue/mailbox, and run metadata.

6. `RunRouter`
   - Serializes work per channel.
   - Enqueues new runs and dispatches them to one worker per channel.
   - Preserves ordering while allowing cross-channel concurrency.

7. `DiscordToolBridge`
   - Provides the bridge invoked by custom opencode tools.
   - Validates path restrictions and message targeting rules.
   - Performs file/image uploads and reactions back into Discord.

8. `Logging`
   - Produces structured local logs for process lifecycle, message routing, session creation, tool activity, and failures.

## Detailed Runtime Behavior

### Message Intake Flow

1. Discord.js emits `messageCreate`.
2. Ignore bot messages and non-guild-text-channel messages.
3. Determine whether the message is an invocation by checking, in order:
   - reply-to-bot
   - mention
   - leading trigger phrase
4. Normalize the user prompt:
   - strip mention when applicable
   - remove trigger phrase prefix when applicable
   - gather reply context, attachment metadata, and embed summaries
   - prefix the turn with the user's tag
5. Look up or create the channel session.
6. Enqueue a run in the per-channel worker.

### Channel Session Creation Flow

On first use of a Discord channel:

1. Create an empty temp directory for the channel session.
2. Create a new opencode session through the SDK.
3. Create in-memory state for that channel.
4. Create a channel mailbox or queue and start a dedicated worker if one does not already exist.

### Run Execution Flow

For each queued channel job:

1. Mark the channel as busy.
2. Start typing indication in the Discord channel.
3. Submit the prompt to opencode using the channel's session ID.
4. Wait for the final assistant message rather than streaming partial output.
5. Consume SSE events during execution for internal tracking, status, and tool activity.
6. If custom Discord tools are invoked, route them through the bridge.
7. Stop typing indication.
8. Send the final assistant response to Discord, splitting into multiple messages if required.
9. On error, send a concise failure summary.
10. Mark the channel worker as idle and proceed to the next queued job.

### Typing Indicator Behavior

- Show typing while a job is active.
- Since Discord typing indicators expire, refresh them on an interval until the run completes.
- Do not post a visible placeholder or progress message in the channel.

### Final Message Formatting

- Prefer replying to the invoking message for the first chunk of the final answer.
- Disable reply pings unless explicitly needed.
- Split long replies safely below Discord's hard message length limit.
- Preserve full content by sending multiple messages rather than truncating.

## Custom Tool Design

### Registration Approach

- Store custom opencode tools in repo-local `.opencode/tools`.
- Tool filenames become tool names.

Planned tools:

- `.opencode/tools/send-file.ts`
- `.opencode/tools/send-image.ts`
- `.opencode/tools/react.ts`

### Tool Bridge Model

Tools should call back into the bot process rather than attempting to manage Discord integration independently.

The bridge should accept enough context to:

- identify the current session and Discord channel
- validate that a requested file path is under the session workdir
- identify the specific invoking message for reaction operations

### Tool Rules

#### `send-file`

- Input: path plus optional caption.
- Validate path is inside the current session workdir.
- Upload the file to the current Discord channel.

#### `send-image`

- Input: image path plus optional caption.
- Validate path is inside the current session workdir.
- Upload the image to the current Discord channel.

#### `react`

- Input: emoji.
- React only to the invoking user message for the current run.

## Effect-Oriented Design

### Service Graph

Planned services:

- `Config`
- `DiscordGateway`
- `OpencodeServer`
- `OpencodeClient`
- `ChannelSessionRegistry`
- `RunRouter`
- `DiscordToolBridge`
- `Logger`

### State Model

Maintain a top-level in-memory map keyed by Discord channel ID.

Each channel entry should include at least:

- Discord channel ID
- opencode session ID
- temp workdir path
- per-channel queue or mailbox
- current run metadata
- last activity timestamp
- worker state

### Concurrency Strategy

Use one worker per active channel, backed by a queue or mailbox, to guarantee ordered processing. This preserves the required one-active-run-per-channel behavior while permitting different channels to run concurrently.

### Lifecycle Strategy

- Use scoped resources for the Discord client and opencode child process.
- Run background workers under Effect supervision.
- Gracefully shut down on process termination:
  - stop accepting new messages
  - finish or interrupt workers as appropriate
  - terminate opencode serve
  - release resources cleanly

## Proposed File Layout

```text
PLAN.md
package.json
tsconfig.json
.env.example
.opencode/tools/send-file.ts
.opencode/tools/send-image.ts
.opencode/tools/react.ts
src/index.ts
src/config.ts
src/app.ts
src/discord/client.ts
src/discord/triggers.ts
src/discord/messages.ts
src/opencode/server.ts
src/opencode/client.ts
src/opencode/events.ts
src/sessions/registry.ts
src/sessions/session.ts
src/runs/router.ts
src/runs/job.ts
src/tools/bridge.ts
src/tools/http.ts
src/util/temp.ts
src/util/logging.ts
```

This layout may evolve slightly during implementation, but these concerns should remain separated.

## Implementation Phases

### Phase 1: Project Scaffolding

- Initialize Bun + TypeScript project files.
- Add dependencies for Effect, Discord.js, and the opencode SDK.
- Add config parsing and environment documentation.

### Phase 2: Core Effect App Structure

- Build the top-level service graph with layers.
- Add structured logging and startup/shutdown flow.

### Phase 3: Discord Integration

- Implement Discord client startup.
- Implement guild text channel filtering.
- Implement mention, prefix, and reply trigger detection.
- Implement typing refresh loop.
- Implement safe message splitting and reply behavior.

### Phase 4: Opencode Integration

- Implement local `opencode serve` process supervision.
- Implement SDK client initialization.
- Implement session creation and reuse per channel.
- Subscribe to SSE events and route them internally.

### Phase 5: Session and Queue Management

- Implement temp workdir creation per channel.
- Implement in-memory channel session registry.
- Implement per-channel FIFO run workers.

### Phase 6: Custom Discord Tools

- Implement the local tool bridge.
- Add repo-local `.opencode/tools` files.
- Enforce workdir path restrictions and invoking-message reaction restrictions.

### Phase 7: Error Handling and Operational Hardening

- Add concise user-facing error responses.
- Add structured logs for failures and tool activity.
- Verify cleanup and shutdown behavior.

### Phase 8: End-to-End Verification

- Validate trigger parsing.
- Validate long-lived per-channel session continuity.
- Validate queue behavior.
- Validate typing indicators.
- Validate long-response splitting.
- Validate custom file, image, and reaction tools.

## Verification Checklist

- Bot starts under Bun and logs into Discord successfully.
- Bot responds only in guild text channels.
- Mention trigger works.
- Leading `hey opencode` trigger works.
- Reply-to-bot trigger works.
- Mention is stripped before forwarding to opencode.
- Replied-to bot message text is included as context.
- Attachment metadata and embed summaries are forwarded.
- One channel queues requests in FIFO order.
- Two separate channels can run concurrently.
- Session continuity is preserved within a process lifetime.
- Restarting the bot clears all in-memory session state, as intended.
- Each channel receives a unique temp workdir.
- Final responses are never streamed partially into Discord.
- Long responses split cleanly across multiple messages.
- `send-file` can upload files only from the session workdir.
- `send-image` can upload images only from the session workdir.
- `react` reacts only to the invoking user message.
- Failures surface as concise error summaries.
- Graceful shutdown cleans up resources.

## Risks and Notes

- Discord.js is usable on Bun, but its ecosystem remains more Node-centric. The implementation should avoid unusual runtime tricks and verify gateway, typing, uploads, and reactions early.
- No persistence is intentionally included in v1. Future work may add persisted session state, channel mapping, and sandboxing for safer long-lived workdirs.
- Tool activity should remain operationally visible in local logs and SSE handling, and streamed into Discord, but not overly verbosely in Discord.
- Future versions may add explicit commands such as session reset or status, but those are intentionally excluded from v1.

## Future Expansion Ideas

Not part of v1, but anticipated later:

- Persistent per-channel session mapping across restarts.
- Persistent workdirs with sandboxing.
- Channel or guild allowlists.
- Role-based access control.
- Explicit reset/status/help commands.
- Additional Discord-facing tools.
- Transcript capture or replay tooling.
- More advanced tool feedback formatting.
