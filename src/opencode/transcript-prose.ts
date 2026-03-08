const renderReasoning = (text: string) => {
  const trimmed = text.trim()
  if (!trimmed) {
    return ""
  }
  return ""
}

export const renderProseTranscriptPart = (part: any) => {
  switch (part.type) {
    case "text":
      return part.text?.trim() ?? ""
    case "reasoning":
      return part.text?.trim() ? renderReasoning(part.text) : ""
    default:
      return ""
  }
}
