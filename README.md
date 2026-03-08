# opencode-discord

Discord bot frontend for [OpenCode](https://github.com/sst/opencode).

The bot keeps one long-lived OpenCode session per Discord text channel, runs each channel serially, and bridges a small set of Discord actions back into OpenCode tools.

## Behavior

- Supports standard guild text channels only.
- Ignores DMs, threads, forum posts, announcement channels, and other channel types for now.
- Triggers on:
  - bot mention
  - leading trigger phrase, default `hey opencode`
  - replying to a bot message with reply ping enabled
- Keeps one session and one temp workdir per Discord channel for the lifetime of the process.
- Different channels run concurrently.
- Additional same-channel messages that arrive during an active run are folded into that active run.
- Final assistant output is sent only after completion and split across multiple Discord messages when needed.
- Sends compact progress and tool updates during runs.
- Recreates a channel's OpenCode server on the existing workdir if a health probe shows the session is dead.

## Discord Tools

Repo-local tools live under [`opencode/tools`](./opencode/tools):

- `send-file`
- `send-image`
- `send-sticker`
- `react`
- `list-custom-emojis`
- `list-stickers`
- `download-attachments`

Tool bridge enforcement:

- file and image paths must stay inside the current session workdir
- reactions are limited to the triggering Discord message
- attachment downloads are written into the current session workdir

## Sandbox

The bot launches a dedicated OpenCode server per channel session.

Sandbox backends:

- `auto`
- `bwrap`
- `unsafe-dev`

On Linux, `auto` selects `bwrap`. Startup probes required executables up front. For `bwrap`, the bot stages a temp copy of the repo-local OpenCode tool config so the sandbox only gets a narrow read-only view of the tool install instead of the full repo dependency tree.

## Requirements

- Bun
- a Discord bot token
- `opencode` installed and authenticated
- `bwrap` installed if using the `bwrap` backend

## Configuration

See [`.env.example`](./.env.example).

Main variables:

- `DISCORD_TOKEN`
- `TRIGGER_PHRASE`
- `SANDBOX_BACKEND`
- `OPENCODE_BIN`
- `BWRAP_BIN`
- `DISCORD_TOOL_BRIDGE_SOCKET`
- `SANDBOX_READ_ONLY_PATHS`
- `SANDBOX_ENV_PASSTHROUGH`

## Running

Install dependencies:

```bash
bun install
```

Start the bot:

```bash
bun run dev
```

Typecheck:

```bash
bun run typecheck
```

## Notes

- Session state is in memory only. Restarting the bot resets channel sessions.
- Session workdirs live under `/tmp` and are removed on process shutdown.
- The `bwrap` sandbox gets a read-only staged copy of the repo-local OpenCode config and tools, not the live repo tree.
