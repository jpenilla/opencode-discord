import { Effect } from "effect";

import { CommandContext } from "@/discord/commands/command-context.ts";
import { AppConfig } from "@/config.ts";
import { InfoCards } from "@/discord/info-cards.ts";
import { OpencodeService } from "@/opencode/service.ts";
import { IdleCompactionWorkflow } from "@/sessions/idle-compaction-workflow.ts";
import { QuestionStatus } from "@/sessions/question-status.ts";
import { SessionControl } from "@/sessions/session-control.ts";
import { SessionStore } from "@/state/store.ts";
import { Logger } from "@/util/logging.ts";

export type GuildCommandDependencies =
  | AppConfig
  | IdleCompactionWorkflow
  | InfoCards
  | OpencodeService
  | QuestionStatus
  | SessionControl
  | SessionStore
  | Logger;

export type GuildCommand = {
  name: string;
  description: string;
  execute: Effect.Effect<boolean, unknown, CommandContext | GuildCommandDependencies>;
};

type GuildCommandDefinitionInput<TName extends string, TDescription extends string> = {
  name: TName;
  description: TDescription;
  execute: GuildCommand["execute"];
};

export const defineGuildCommand = <const TName extends string, const TDescription extends string>(
  input: GuildCommandDefinitionInput<TName, TDescription>,
) =>
  ({
    name: input.name,
    description: input.description,
    execute: input.execute,
  }) satisfies GuildCommand;
