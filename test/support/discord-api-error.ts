import { DiscordAPIError } from "discord.js";

export const discordApiValidationMessage =
  "Invalid Form Body\nfiles[0][BASE_TYPE_BAD_LENGTH]: This file cannot be sent";

export const makeDiscordApiError = () =>
  new DiscordAPIError(
    {
      code: 50035,
      message: "Invalid Form Body",
      errors: {
        files: {
          "0": {
            _errors: [{ code: "BASE_TYPE_BAD_LENGTH", message: "This file cannot be sent" }],
          },
        },
      },
    },
    50035,
    400,
    "POST",
    "https://discord.test/api",
    {
      body: null,
      files: [],
    },
  );
