import { renderProseTranscriptPart } from "@/opencode/transcript-prose.ts"
import { renderToolTranscriptPart } from "@/opencode/transcript-tool.ts"

export const renderTranscript = (parts: any[]) => {
  const lines: string[] = []

  for (const part of parts) {
    if (part.type === "tool") {
      const tool = renderToolTranscriptPart(part)
      if (tool) {
        lines.push(tool)
      }
      continue
    }

    const prose = renderProseTranscriptPart(part)
    if (prose) {
      lines.push(prose)
    }
  }

  return lines.join("\n\n").trim()
}
