# opencode-discord

Discord frontend for [OpenCode](https://github.com/sst/opencode).

This project runs OpenCode behind a Discord bot. Each Discord text channel gets its own long-lived OpenCode thread and persistent session home/workspace, so channel conversations stay isolated and survive bot restarts.

## Overview

What the bot does:

- Creates one OpenCode session per Discord channel.
- Lets different channels run concurrently.
- Reuses the same channel session across messages and lazily reattaches it after bot restarts.
- Bridges a small set of Discord-native actions back into OpenCode as tools.
- Supports interactive OpenCode question prompts with Discord components and modals.
- Exposes slash commands for compaction and interruption.

Current scope:

- Supported: standard guild text channels.
- Ignored: DMs, threads, forum posts, announcement channels, and this bot's own messages.
- Other bot-authored messages are allowed by default. Set `IGNORE_OTHER_BOT_TRIGGERS=true` to ignore them.
- Channel session metadata is persisted in SQLite.
- Channel-level visibility preferences for thinking messages and compaction summaries are persisted in SQLite.
- Per-channel session homes/workspaces are stored under `./storage` by default.
- In-flight runs, queued follow-ups, typing state, and question UI are not restored after restart.

## How Invocation Works

The bot starts a run when a message in a supported channel does one of these:

- Mentions the bot.
- Starts with the configured trigger phrase.
- Replies to a bot message with reply ping enabled.

Behavior details:

- Trigger phrase matching is case-insensitive.
- Reply-without-ping does not count as a trigger.
- Reply-to-bot invocation includes the replied bot message text as reply context for the next run.
- The bot always ignores its own messages.
- Set `IGNORE_OTHER_BOT_TRIGGERS=true` to also ignore other bot-authored messages.

Default trigger phrase: `hey opencode`

## Session Model

- The first triggered message in a channel creates that channel’s OpenCode session and session home/workspace.
- Each channel runs serially.
- Different channels can run at the same time.
- Same-channel follow-ups that arrive during an active run are folded into that run instead of starting a second concurrent run.
- If a channel session becomes unhealthy, the bot recreates the OpenCode worker on the same workdir.
- Idle per-channel workers are closed after a configurable timeout and lazily reopened on the next message.

Important lifecycle note:

- Restarting the bot preserves idle thread history and session files, but not active Discord-side runtime state.

## Discord UX

During a run, the bot may show:

- typing indicator
- progress updates
- tool cards
- compaction cards
- interactive question cards

Final assistant output is sent only after completion and is chunked safely across multiple Discord messages when needed.

Question prompts:

- OpenCode question batches are rendered as interactive Discord cards.
- The card shows one question at a time.
- Supports single-select and multi-select questions.
- Supports optional custom answers through a modal when the question allows it.
- Supports paging through both questions and large option sets.
- Any user in the channel can answer the question batch.
- Rejected, expired, or replaced prompts are updated in place.

## Slash Commands

The bot syncs these guild commands on startup and when it joins a new guild:

- `/compact`
  Compact the current channel session when no run is active.
- `/interrupt`
  Interrupt the active run in the current channel.
- `/toggle-thinking`
  Toggle whether thinking progress messages are shown in the current channel.
- `/toggle-compaction-summaries`
  Toggle whether compaction summaries are shown in the current channel.

Command behavior:

- All commands acknowledge privately to the caller.
- `/compact` also posts in-channel compaction status.
- `/interrupt` also posts an in-channel interruption card.
- The visibility toggle commands persist per Discord channel, not per OpenCode session.
- Both commands are restricted to standard guild text channels.

## Discord Tools Exposed To OpenCode

Repo-local tools live under [`opencode/tools`](./opencode/tools):

- `download-attachments`
- `list-custom-emojis`
- `list-stickers`
- `react`
- `send-file`
- `send-image`
- `send-sticker`

What they do:

- `send-file`
  Upload a file to Discord. Relative paths resolve from the current session workdir and must stay under the synthetic session home.
- `send-image`
  Upload an image to Discord. Relative paths resolve from the current session workdir and must stay under the synthetic session home.
- `download-attachments`
  Download attachments from a specific Discord message by `messageId`. Relative destinations resolve from the current session workdir and must stay under the synthetic session home.
- `react`
  Add a reaction to a specific Discord message by `messageId`.
- `list-custom-emojis`
  List usable custom emoji in the current Discord context.
- `list-stickers`
  List usable stickers in the current Discord context.
- `send-sticker`
  Send a sticker that is usable in the current Discord context.

Current guardrails:

- File/image paths are resolved from the session workdir when relative and must stay under the synthetic session home.
- Download destinations are resolved from the session workdir when relative and must stay under the synthetic session home.
- `download-attachments` is limited to messages associated with the current run context.
- Reactions are allowed for any message in the current Discord channel.
- Emoji/sticker availability is filtered by the current Discord context and permissions.

Implementation note:

- OpenCode scans top-level files in `opencode/tools/*.ts` as tool modules.
- Shared helpers should live under a subdirectory such as [`opencode/tools/lib`](./opencode/tools/lib), not as another top-level file in `opencode/tools/`.

## Requirements

- Bun
- `opencode` installed on the host
- OpenCode already authenticated on the host
- a Discord bot token
- a Discord application with Message Content intent enabled
- `bwrap` installed if you want the `bwrap` sandbox backend

OpenCode/provider auth is expected to come from normal host OpenCode state, not from ad hoc environment variables.

## Configuration

See [`.env.example`](./.env.example).

Main variables:

- `DISCORD_TOKEN`
  Discord bot token. Required.
- `TRIGGER_PHRASE`
  Leading text trigger. Default: `hey opencode`
- `IGNORE_OTHER_BOT_TRIGGERS`
  Whether to ignore trigger phrase, mention, and reply triggers from other bots. Default: `false`
- `SESSION_INSTRUCTIONS`
  Optional extra instructions appended to OpenCode's system prompt for each Discord channel session
- `STATE_DIR`
  Persistent storage root. Default: `./storage`
- `DEFAULT_PROVIDER_ID`
  Optional provider id override applied to each session prompt when paired with `DEFAULT_MODEL_ID`
- `DEFAULT_MODEL_ID`
  Optional model id override applied to each session prompt when paired with `DEFAULT_PROVIDER_ID`
- `SHOW_THINKING_BY_DEFAULT`
  Whether thinking progress messages are shown by default in channels without an override yet. Default: `true`
- `SHOW_COMPACTION_SUMMARIES_BY_DEFAULT`
  Whether compaction summaries are shown by default in channels without an override yet. Default: `true`
- `SESSION_IDLE_TIMEOUT_MS`
  Idle timeout in milliseconds before an unused per-channel OpenCode worker is closed. Default: `1800000`
- `SANDBOX_BACKEND`
  One of `auto`, `bwrap`, or `unsafe-dev`
- `OPENCODE_BIN`
  Path or command name for the OpenCode CLI. Default: `opencode`
- `BWRAP_BIN`
  Path or command name for Bubblewrap. Default: `bwrap`
- `DISCORD_TOOL_BRIDGE_SOCKET`
  Optional explicit Unix socket path for the local Discord tool bridge
- `SANDBOX_READ_ONLY_PATHS`
  Optional comma-separated read-only bind list for the `bwrap` backend
- `SANDBOX_ENV_PASSTHROUGH`
  Optional comma-separated extra env vars to pass through to sandboxed workers

Notes:

- `DISCORD_TOKEN` is the only required env var.
- `SESSION_INSTRUCTIONS` is applied per OpenCode session, not injected into every visible Discord message.
- `STATE_DIR` stores both the SQLite metadata DB and per-channel session homes/workspaces.
- `DEFAULT_PROVIDER_ID` and `DEFAULT_MODEL_ID` are only used when both are set; otherwise the bot keeps using OpenCode's normal default model resolution.
- `SESSION_IDLE_TIMEOUT_MS` closes only the worker process after inactivity; the persisted thread and files remain and are reopened lazily.
- `SANDBOX_READ_ONLY_PATHS` replaces the default `bwrap` read-only bind list; it does not append to it.
- `SANDBOX_ENV_PASSTHROUGH` is for additional env vars only. OpenCode auth should usually come from host state.

## Sandbox Behavior

Supported backends:

- `auto`
- `bwrap`
- `unsafe-dev`

Backend selection:

- On Linux, `auto` resolves to `bwrap`.
- On non-Linux platforms, `auto` resolves to `unsafe-dev`.

Startup behavior:

- Required executables are probed eagerly at startup.
- If the selected backend cannot be started, the bot fails closed.

`bwrap` behavior:

- Each channel session has a persistent synthetic home/workspace under `STATE_DIR`.
- Each worker gets a synthetic home directory, and the OpenCode session cwd is `$HOME/workspace`.
- The session workdir is the writable project area inside that synthetic home, and is mounted into the sandbox at `/home/opencode/workspace`.
- `/tmp` inside the sandbox is a tmpfs.
- The repo-local OpenCode config/tool workspace is staged into a temporary copy first and mounted read-only.
- Only a small env allowlist plus `SANDBOX_ENV_PASSTHROUGH` is inherited.

Important caveat:

- The current `bwrap` profile is not a network-isolated sandbox.

## Tool Bridge

The Discord bridge between OpenCode tools and the bot process is a local HTTP server on a Unix socket.

Behavior:

- The socket path is generated automatically unless `DISCORD_TOOL_BRIDGE_SOCKET` is set.
- A per-process random token authenticates bridge requests.
- Workers receive `OPENCODE_DISCORD_BRIDGE_SOCKET` and `OPENCODE_DISCORD_BRIDGE_TOKEN`.
- Bridge requests are rejected unless there is an active run for the supplied `sessionID`.

Important caveat:

- The current path confinement checks for file/image/download tools are lexical (`resolve`/`relative`), not `realpath`-based. Symlinks inside the synthetic session home are therefore not a hard security boundary.

## Running

Install dependencies:

```bash
bun install
```

Run in development:

```bash
bun run dev
```

Run normally:

```bash
bun run start
```

Typecheck:

```bash
bun run typecheck
```

Run tests:

```bash
bun run test
```

## Operational Notes

- The bot uses the repo-local [`opencode`](./opencode) workspace for its custom Discord tools.
- Host OpenCode config/auth/model state is copied into worker-specific XDG state under the synthetic home before workers start.
- Persistent bot-managed state lives under `STATE_DIR` (`./storage` by default).
- Logs are structured JSON to stdout.
- Logs can include backend choice, workdirs, server URLs, bridge socket paths, and raw OpenCode event properties, so treat them as potentially sensitive.
- Outgoing final replies and tool sends allow normal Discord mentions; be careful if you let OpenCode generate arbitrary mention-like text in shared channels.
