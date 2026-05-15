import { SlackApiClient, SlackApiError } from "./client.js";
import {
  findSlackTool,
  parseSlackScopes,
  slackToolTokenKindsForInstallation,
  type SlackTool,
  type SlackToolTokenKind
} from "./tool-catalog.js";
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
      const validationError = validateToolCall(tool, call.arguments);
      if (validationError) {
        return { isError: true, content: [{ type: "text", text: validationError }] };
      }
      const token = await this.accessTokenForTool(tool, installation);
      const client = new SlackApiClient(
        this.fetchImpl === undefined ? { token } : { token, fetch: this.fetchImpl }
      );
      if (tool.method === "harbor.unreadMessages") {
        const result = await fetchUnreadMessages(client, call.arguments);
        return { content: [{ type: "text", text: JSON.stringify(redactSensitiveSlackData(result), null, 2) }] };
      }
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
      if (error instanceof SlackToolAccessError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "missing_required_access",
                  message: error.message,
                  tool: error.tool.name,
                  required_scopes: error.tool.annotations.scopes,
                  token: error.tool.annotations.token,
                  provided_user_scopes: Array.from(parseSlackScopes(error.installation.scope)).sort(),
                  provided_bot_scopes: Array.from(parseSlackScopes(error.installation.botScope ?? "")).sort(),
                  has_bot_token: Boolean(error.installation.botAccessToken)
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
  readonly kind: SlackToolTokenKind;
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
  const allowedTokenKinds = slackToolTokenKindsForInstallation(tool, installation);
  if (allowedTokenKinds.length === 0) {
    throw new SlackToolAccessError(tool, installation);
  }

  const selectedTokenKind = allowedTokenKinds[0];
  if (selectedTokenKind === "bot" && installation.botAccessToken) {
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

class SlackToolAccessError extends Error {
  readonly tool: SlackTool;
  readonly installation: SlackInstallation;

  constructor(tool: SlackTool, installation: SlackInstallation) {
    super(`Slack installation is missing required access for ${tool.name}.`);
    this.name = "SlackToolAccessError";
    this.tool = tool;
    this.installation = installation;
  }
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

const MESSAGE_BODY_METHODS = new Set([
  "chat.postMessage",
  "chat.postEphemeral",
  "chat.update",
  "chat.scheduleMessage"
]);

function validateToolCall(tool: SlackTool, argumentsObject: Record<string, unknown>): string | null {
  if (!MESSAGE_BODY_METHODS.has(tool.method)) {
    return null;
  }
  if (hasUsableMessageBody(argumentsObject)) {
    return null;
  }
  return `${tool.name} requires text, blocks, or attachments.`;
}

function hasUsableMessageBody(argumentsObject: Record<string, unknown>): boolean {
  return (
    stringArg(argumentsObject.text) !== undefined ||
    nonEmptyArrayArg(argumentsObject.blocks) ||
    nonEmptyArrayArg(argumentsObject.attachments)
  );
}

function nonEmptyArrayArg(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
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

type SlackConversation = {
  readonly id?: string;
  readonly name?: string;
  readonly is_channel?: boolean;
  readonly is_group?: boolean;
  readonly is_im?: boolean;
  readonly is_mpim?: boolean;
  readonly is_private?: boolean;
  readonly user?: string;
  readonly last_read?: string;
  readonly unread_count?: number;
  readonly unread_count_display?: number;
};

type SlackConversationsListResponse = {
  readonly channels?: readonly SlackConversation[];
  readonly response_metadata?: {
    readonly next_cursor?: string;
  };
};

type SlackConversationInfoResponse = {
  readonly channel?: SlackConversation;
};

type SlackConversationHistoryResponse = {
  readonly messages?: readonly unknown[];
  readonly has_more?: boolean;
  readonly response_metadata?: {
    readonly next_cursor?: string;
  };
};

type UnreadConversationResult = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly type: string;
  readonly unread_count?: number | undefined;
  readonly last_read?: string | undefined;
  readonly has_more?: boolean | undefined;
  readonly messages: readonly unknown[];
};

type SkippedConversationResult = {
  readonly id: string;
  readonly name?: string | undefined;
  readonly type: string;
  readonly reason: string;
};

async function fetchUnreadMessages(
  client: SlackApiClient,
  rawArguments: Record<string, unknown>
): Promise<{
  readonly ok: true;
  readonly scanned_conversations: number;
  readonly unread_conversations: number;
  readonly conversations: readonly UnreadConversationResult[];
  readonly skipped: readonly SkippedConversationResult[];
}> {
  const args = sanitizeArguments(rawArguments);
  const types = stringArg(args.types) ?? "public_channel,private_channel,mpim,im";
  const maxConversations = clampNumber(numberArg(args.max_conversations) ?? numberArg(args.limit) ?? 50, 1, 200);
  const messagesPerConversation = clampNumber(numberArg(args.messages_per_conversation) ?? 20, 1, 100);

  const conversations = await listConversations(client, types, maxConversations);
  const unread: UnreadConversationResult[] = [];
  const skipped: SkippedConversationResult[] = [];

  for (const conversation of conversations) {
    const id = conversation.id;
    if (!id) {
      continue;
    }

    let detailed = conversation;
    try {
      const info = await client.call("conversations.info", { channel: id }) as SlackConversationInfoResponse;
      detailed = { ...conversation, ...info.channel };
    } catch (error) {
      skipped.push({
        id,
        name: conversation.name,
        type: conversationType(conversation),
        reason: error instanceof SlackApiError ? `conversations.info failed: ${error.slackError}` : "conversations.info failed"
      });
      continue;
    }

    const unreadCount = numericUnreadCount(detailed);
    const lastRead = stringArg(detailed.last_read);
    if (unreadCount === 0) {
      skipped.push({
        id,
        name: detailed.name,
        type: conversationType(detailed),
        reason: "Slack reported no unread messages"
      });
      continue;
    }
    if (unreadCount === undefined && !lastRead) {
      skipped.push({
        id,
        name: detailed.name,
        type: conversationType(detailed),
        reason: "Slack did not expose unread_count or last_read for this conversation"
      });
      continue;
    }

    const historyArgs: Record<string, unknown> = {
      channel: id,
      limit: messagesPerConversation
    };
    if (lastRead) {
      historyArgs.oldest = lastRead;
      historyArgs.inclusive = false;
    }

    const history = await client.call("conversations.history", historyArgs) as SlackConversationHistoryResponse;
    const messages = history.messages ?? [];
    if (messages.length === 0) {
      skipped.push({
        id,
        name: detailed.name,
        type: conversationType(detailed),
        reason: "No messages were returned after the last-read cursor"
      });
      continue;
    }

    unread.push({
      id,
      name: detailed.name,
      type: conversationType(detailed),
      unread_count: unreadCount,
      last_read: lastRead,
      has_more: history.has_more,
      messages
    });
  }

  return {
    ok: true,
    scanned_conversations: conversations.length,
    unread_conversations: unread.length,
    conversations: unread,
    skipped
  };
}

async function listConversations(
  client: SlackApiClient,
  types: string,
  maxConversations: number
): Promise<readonly SlackConversation[]> {
  const conversations: SlackConversation[] = [];
  let cursor: string | undefined;

  while (conversations.length < maxConversations) {
    const remaining = maxConversations - conversations.length;
    const page = await client.call("conversations.list", {
      types,
      limit: Math.min(remaining, 200),
      ...(cursor ? { cursor } : {})
    }) as SlackConversationsListResponse;
    conversations.push(...(page.channels ?? []).slice(0, remaining));
    cursor = page.response_metadata?.next_cursor?.trim() || undefined;
    if (!cursor) {
      break;
    }
  }

  return conversations;
}

function numericUnreadCount(conversation: SlackConversation): number | undefined {
  if (typeof conversation.unread_count_display === "number") {
    return conversation.unread_count_display;
  }
  if (typeof conversation.unread_count === "number") {
    return conversation.unread_count;
  }
  return undefined;
}

function conversationType(conversation: SlackConversation): string {
  if (conversation.is_im) {
    return "im";
  }
  if (conversation.is_mpim) {
    return "mpim";
  }
  if (conversation.is_group || conversation.is_private) {
    return "private_channel";
  }
  if (conversation.is_channel) {
    return "public_channel";
  }
  return "conversation";
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArg(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}
