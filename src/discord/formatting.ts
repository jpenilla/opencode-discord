const SAFE_DISCORD_MESSAGE_LIMIT = 1900
const FENCE_RE = /^(`{3,})([A-Za-z0-9_-]+)?\s*$/

type FenceState = {
  marker: string
  language: string
  open: boolean
}

export const formatCodeBlock = (content: string, language = "text") => {
  const trimmed = content.trim()
  if (!trimmed) {
    return ""
  }
  const fence = trimmed.includes("```") ? "````" : "```"
  return `${fence}${language}\n${trimmed}\n${fence}`
}

export const formatErrorResponse = (title: string, message: string) =>
  [title, "", formatCodeBlock(message, "text")].filter(Boolean).join("\n")

const findSplitPoint = (text: string, maxLength: number) => {
  if (text.length <= maxLength) {
    return text.length
  }

  const slice = text.slice(0, maxLength)
  const candidates = [
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf("\n"),
    Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? ")),
    slice.lastIndexOf(" "),
  ].filter((index) => index > 0)

  if (candidates.length === 0) {
    return maxLength
  }

  const splitAt = Math.max(...candidates)
  return splitAt === slice.lastIndexOf("\n\n") ? splitAt + 2 : splitAt + 1
}

const advanceFenceState = (text: string, initial: FenceState): FenceState => {
  let state = { ...initial }

  for (const line of text.split("\n")) {
    const match = line.match(FENCE_RE)
    if (!match) {
      continue
    }

    if (!state.open) {
      state = {
        marker: match[1],
        language: match[2] ?? "",
        open: true,
      }
      continue
    }

    state = {
      marker: "```",
      language: "",
      open: false,
    }
  }

  return state
}

export const splitDiscordMessage = (text: string, maxLength = SAFE_DISCORD_MESSAGE_LIMIT): Array<string> => {
  if (!text) {
    return [text]
  }

  const chunks: Array<string> = []
  let remaining = text
  let fence: FenceState = {
    marker: "```",
    language: "",
    open: false,
  }

  while (remaining.length > 0) {
    const reopen = fence.open ? `${fence.marker}${fence.language}\n` : ""
    const available = maxLength - reopen.length
    const splitAt = findSplitPoint(remaining, available)
    const body = remaining.slice(0, splitAt)
    const nextFence = advanceFenceState(body, fence)
    const close = nextFence.open ? `\n${nextFence.marker}` : ""

    chunks.push(`${reopen}${body}${close}`.trimEnd())
    remaining = remaining.slice(splitAt).trimStart()
    fence = nextFence
  }

  return chunks
}
