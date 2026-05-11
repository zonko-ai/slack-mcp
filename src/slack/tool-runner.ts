import { SlackApiClient, SlackApiError } from "./client.js";
import { findSlackTool, type SlackTool } from "./tool-catalog.js";
import type { SlackInstallation, SlackInstallationInput, TokenStore } from "./token-store.js";
import {
  refreshSlackToken,
  shouldRefreshSlackToken,
  SlackTokenRefreshError,
  type SlackTokenRotationConfig
} from "./token-rotation.js";

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
  readonly tokenRotation?: SlackTokenRotationConfig | undefined;
};

export type SlackToolCall = {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly connectionId?: string | null | undefined;
};

export class SlackToolRunner {
  private readonly tokenStore: TokenStore;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly tokenRotation: SlackTokenRotationConfig | undefined;

  constructor(options: SlackToolRunnerOptions) {
    this.tokenStore = options.tokenStore;
    this.fetchImpl = options.fetch;
    this.tokenRotation = options.tokenRotation;
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

    try {
      const token = await this.accessTokenForTool(tool, installation);
      const client = new SlackApiClient(
        this.fetchImpl === undefined ? { token } : { token, fetch: this.fetchImpl }
      );
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
      if (error instanceof SlackTokenRefreshError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: error.slackError,
                  method: "oauth.v2.access"
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

  private async accessTokenForTool(tool: SlackTool, installation: SlackInstallation): Promise<string> {
    const selected = selectInstallationToken(tool, installation);
    const tokenRotation = this.tokenRotation;
    if (
      !tokenRotation ||
      !selected.refreshToken ||
      !shouldRefreshSlackToken({
        config: tokenRotation,
        expiresAt: selected.expiresAt,
        refreshToken: selected.refreshToken
      })
    ) {
      return selected.accessToken;
    }

    const refreshed = await refreshSlackToken({
      config: tokenRotation,
      refreshToken: selected.refreshToken,
      fetch: this.fetchImpl ?? defaultFetch
    });
    const saved = await this.tokenStore.save(
      installationInputWithRefreshedToken(installation, selected.kind, refreshed)
    );
    return selected.kind === "bot" ? saved.botAccessToken ?? refreshed.accessToken : saved.accessToken;
  }
}

type SelectedInstallationToken = {
  readonly kind: "user" | "bot";
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expiresAt?: string | undefined;
};

type RefreshedInstallationToken = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly scope?: string | undefined;
};

function selectInstallationToken(tool: SlackTool, installation: SlackInstallation): SelectedInstallationToken {
  if (tool.annotations.token === "bot" && installation.botAccessToken) {
    return {
      kind: "bot",
      accessToken: installation.botAccessToken,
      refreshToken: installation.botRefreshToken,
      expiresAt: installation.botTokenExpiresAt
    };
  }

  return {
    kind: "user",
    accessToken: installation.accessToken,
    refreshToken: installation.userRefreshToken,
    expiresAt: installation.userTokenExpiresAt
  };
}

function installationInputWithRefreshedToken(
  installation: SlackInstallation,
  kind: "user" | "bot",
  refreshed: RefreshedInstallationToken
): SlackInstallationInput {
  return {
    teamId: installation.teamId,
    teamName: installation.teamName,
    enterpriseId: installation.enterpriseId,
    userId: installation.userId,
    accessToken: kind === "user" ? refreshed.accessToken : installation.accessToken,
    ...optionalStringField("userRefreshToken", kind === "user" ? refreshed.refreshToken : installation.userRefreshToken),
    ...optionalStringField("userTokenExpiresAt", kind === "user" ? refreshed.expiresAt : installation.userTokenExpiresAt),
    ...optionalStringField("botAccessToken", kind === "bot" ? refreshed.accessToken : installation.botAccessToken),
    ...optionalStringField("botRefreshToken", kind === "bot" ? refreshed.refreshToken : installation.botRefreshToken),
    ...optionalStringField("botTokenExpiresAt", kind === "bot" ? refreshed.expiresAt : installation.botTokenExpiresAt),
    scope: kind === "user" ? refreshed.scope ?? installation.scope : installation.scope,
    ...optionalStringField("botScope", kind === "bot" ? refreshed.scope ?? installation.botScope : installation.botScope),
    tokenType: installation.tokenType
  };
}

function optionalStringField<Key extends keyof SlackInstallationInput>(
  key: Key,
  value: SlackInstallationInput[Key] | undefined
): Partial<SlackInstallationInput> {
  return typeof value === "string" ? { [key]: value } as Partial<SlackInstallationInput> : {};
}

const defaultFetch: typeof fetch = (input, init) => fetch(input, init);

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
