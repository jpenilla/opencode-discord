import type { AppConfigShape } from "@/config.ts";

export type PromptModelOverride = {
  providerID: string;
  modelID: string;
};

export type PromptRequestInput = {
  sessionID: string;
  noReply: false;
  model?: PromptModelOverride;
  parts: [
    {
      type: "text";
      text: string;
    },
  ];
};

export const resolvePromptModelOverride = (
  config: Pick<AppConfigShape, "defaultProviderId" | "defaultModelId">,
): PromptModelOverride | null => {
  if (config.defaultProviderId === undefined || config.defaultModelId === undefined) {
    return null;
  }

  return {
    providerID: config.defaultProviderId,
    modelID: config.defaultModelId,
  };
};

export const hasIncompletePromptModelOverride = (
  config: Pick<AppConfigShape, "defaultProviderId" | "defaultModelId">,
) => (config.defaultProviderId === undefined) !== (config.defaultModelId === undefined);

export const buildPromptRequestInput = (
  sessionID: string,
  prompt: string,
  modelOverride: PromptModelOverride | null,
): PromptRequestInput => ({
  sessionID,
  ...(modelOverride ? { model: modelOverride } : {}),
  noReply: false,
  parts: [{ type: "text", text: prompt }],
});
