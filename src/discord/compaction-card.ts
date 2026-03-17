export type CompactionCardState = "compacting" | "interrupting" | "compacted" | "interrupted";

export const compactionCardContent = (
  state: CompactionCardState,
): { title: string; body: string } => {
  switch (state) {
    case "compacting":
      return {
        title: "🗜️ Compacting session",
        body: "OpenCode is summarizing earlier context for this session.",
      };
    case "interrupting":
      return {
        title: "‼️ Interrupting compaction",
        body: "OpenCode is stopping session compaction.",
      };
    case "compacted":
      return {
        title: "🗜️ Session compacted",
        body: "OpenCode summarized earlier context for this session.",
      };
    case "interrupted":
      return {
        title: "‼️ Compaction interrupted",
        body: "OpenCode stopped compacting this session because the run was interrupted.",
      };
  }
};
