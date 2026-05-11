import { SlackApiClient, SlackApiError } from "./client.js";
import { findSlackTool } from "./tool-catalog.js";
import type { TokenStore } from "./token-store.js";

export type ToolContent = {
  readonly type: "text";
  readonly text: string;
};

export type ToolCallResult = {
  readonly content: readonly ToolContent[];
  readonly isError?: boolean;
};

export type SlackToolRunnerOptions = {
  readonly tokenStore: TokenStore;
  readonly fetch?: typeof fetch;
};

export type SlackToolCall = {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly connectionId?: string | null | undefined;
};

export class SlackToolRunner {
  private readonly tokenStore: TokenStore;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(options: SlackToolRunnerOptions) {
    this.tokenStore = options.tokenStore;
    this.fetchImpl = options.fetch;
  }

  async callTool(call: SlackToolCall): Promise<ToolCallResult> {
    const tool = findSlackTool(call.name);
    if (!tool) {
      return { isError: true, content: [{ type: "text", text: `Unknown Slack tool: ${call.name}` }] };
    }

    const installation = call.connectionId
      ? await this.tokenStore.get(call.connectionId)
      : await this.tokenStore.getDefault();
    if (!installation) {
      return {
        isError: true,
        content: [{ type: "text", text: "No Slack OAuth installation is available for this MCP request." }]
      };
    }

    const token = tool.annotations.token === "bot" && installation.botAccessToken
      ? installation.botAccessToken
      : installation.accessToken;
    const client = new SlackApiClient(
      this.fetchImpl === undefined ? { token } : { token, fetch: this.fetchImpl }
    );

    try {
      const result = await client.call(tool.method, sanitizeArguments(call.arguments));
      return { content: [{ type: "text", text: JSON.stringify(redactSensitiveSlackData(result), null, 2) }] };
    } catch (error) {
      if (error instanceof SlackApiError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: error.slackError,
                  method: error.method,
                  needed: error.needed,
                  provided: error.provided
                },
                null,
                2
              )
            }
          ]
        };
      }
      throw error;
    }
  }
}

function sanitizeArguments(argumentsObject: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(argumentsObject).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

const SLACK_TOKEN_PATTERN = /\bxox[a-zA-Z]?-[A-Za-z0-9-]+\b/g;
const SENSITIVE_RESPONSE_KEYS = new Set([
  "token",
  "access_token",
  "bot_access_token",
  "user_access_token",
  "refresh_token",
  "authed_user_token",
  "accesstoken",
  "botaccesstoken",
  "useraccesstoken",
  "refreshtoken"
]);

function redactSensitiveSlackData(value: unknown): unknown {
  if (typeof value === "string") {
    return redactTokenString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveSlackData(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => {
      if (isSensitiveResponseKey(key)) {
        return [key, "[redacted]"];
      }
      return [key, redactSensitiveSlackData(nestedValue)];
    })
  );
}

function isSensitiveResponseKey(key: string): boolean {
  return SENSITIVE_RESPONSE_KEYS.has(key.toLowerCase());
}

function redactTokenString(value: string): string {
  return value.replace(SLACK_TOKEN_PATTERN, "[redacted]");
}
