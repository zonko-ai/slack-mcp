import { readFile } from "node:fs/promises";
import { slackTools } from "../slack/tool-catalog.js";

type Json = Record<string, unknown>;

type McpResult = {
  readonly isError?: boolean;
  readonly content?: readonly { readonly type: string; readonly text?: string }[];
};

type ToolResult = {
  readonly name: string;
  readonly status: "passed" | "slack_error" | "skipped" | "mcp_error";
  readonly detail: string;
};

type TestContext = {
  endpoint: string;
  authorizationToken: string;
  sessionId?: string | undefined;
  userId?: string;
  userEmail?: string;
  channelId?: string;
  messageTs?: string;
  scheduledMessageId?: string;
  reminderId?: string;
  bookmarkId?: string;
  remoteFileExternalId: string;
  remoteFileId?: string;
  callId?: string;
  usergroupId?: string;
};

const endpoint = process.env.SLACK_MCP_TEST_ENDPOINT ?? "http://127.0.0.1:13182/mcp";
const authorizationToken = process.env.SLACK_MCP_BEARER_TOKEN ?? process.env.SLACK_MCP_API_KEY ?? await readApiKey();
const runId = Date.now().toString(36);

const ctx: TestContext = {
  endpoint,
  authorizationToken,
  sessionId: await initialize(endpoint, authorizationToken),
  remoteFileExternalId: `slack-mcp-${runId}`
};

const results: ToolResult[] = [];

for (const tool of orderedTools()) {
  const args = argsFor(tool.name, ctx);
  if (args === null) {
    results.push({ name: tool.name, status: "skipped", detail: "dependency unavailable" });
    continue;
  }
  const result = await callTool(ctx, tool.name, args);
  results.push(classify(tool.name, result));
  captureState(tool.name, result, ctx);
}

await cleanup(ctx, results);

const summary = results.reduce(
  (acc, result) => ({ ...acc, [result.status]: (acc[result.status] ?? 0) + 1 }),
  {} as Record<ToolResult["status"], number>
);

console.log(JSON.stringify({ endpoint, toolCount: slackTools.length, summary, results }, null, 2));

async function readApiKey(): Promise<string> {
  try {
    return (await readFile(".local-api-key", "utf8")).trim();
  } catch {
    throw new Error("Set SLACK_MCP_BEARER_TOKEN, SLACK_MCP_API_KEY, or keep .local-api-key from the deployment command.");
  }
}

async function initialize(target: string, key: string): Promise<string | undefined> {
  const response = await fetch(target, {
    method: "POST",
    headers: commonHeaders(key),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "slack-mcp-live-tool-tester", version: "0.1.0" }
      }
    })
  });
  const sessionId = response.headers.get("mcp-session-id");
  if (!response.ok) {
    throw new Error(`Failed to initialize MCP session: ${response.status} ${await response.text()}`);
  }
  return sessionId ?? undefined;
}

async function callTool(ctx: TestContext, name: string, args: Json): Promise<McpResult> {
  const headers = commonHeaders(ctx.authorizationToken);
  if (ctx.sessionId) {
    headers["mcp-session-id"] = ctx.sessionId;
  }
  const response = await fetch(ctx.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: `${name}-${runId}`,
      method: "tools/call",
      params: { name, arguments: args }
    })
  });
  const body = await readMcpJson(response) as { readonly result?: McpResult; readonly error?: unknown };
  if (!response.ok || body.error) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify(body.error ?? body) }] };
  }
  return body.result ?? { isError: true, content: [{ type: "text", text: "missing result" }] };
}

function commonHeaders(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    accept: "application/json, text/event-stream",
    "content-type": "application/json"
  };
}

async function readMcpJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.startsWith("event:")) {
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    if (dataLine) {
      return JSON.parse(dataLine.slice(6));
    }
  }
  return JSON.parse(text);
}

function argsFor(name: string, ctx: TestContext): Json | null {
  const channel = ctx.channelId;
  const ts = ctx.messageTs;
  const user = ctx.userId;
  const userEmail = ctx.userEmail;
  const scheduled = ctx.scheduledMessageId;
  const reminder = ctx.reminderId;
  const bookmark = ctx.bookmarkId;
  const remoteFile = ctx.remoteFileId;
  const call = ctx.callId;
  const usergroup = ctx.usergroupId;

  switch (name) {
    case "slack_auth_test":
    case "slack_api_test":
    case "slack_team_info":
    case "slack_team_profile_get":
    case "slack_emoji_list":
    case "slack_users_list":
    case "slack_reminders_list":
    case "slack_stars_list":
      return {};
    case "slack_users_info":
    case "slack_users_get_presence":
    case "slack_users_profile_get":
      return user ? { user } : null;
    case "slack_users_lookup_by_email":
      return userEmail ? { email: userEmail } : null;
    case "slack_users_set_presence":
      return { presence: "auto" };
    case "slack_users_profile_set":
      return { profile: JSON.stringify({ status_text: "Slack MCP test", status_emoji: ":white_check_mark:" }) };
    case "slack_users_delete_photo":
      return {};

    case "slack_conversations_create":
      return { name: `slackmcp-${runId}`, is_private: false };
    case "slack_conversations_list":
      return { types: "public_channel,private_channel,im,mpim", limit: 20 };
    case "slack_conversations_info":
    case "slack_conversations_members":
    case "slack_conversations_join":
    case "slack_conversations_archive":
    case "slack_conversations_unarchive":
    case "slack_conversations_leave":
      return channel ? { channel } : null;
    case "slack_conversations_history":
      return channel ? { channel, limit: 5 } : null;
    case "slack_conversations_replies":
      return channel && ts ? { channel, ts } : null;
    case "slack_conversations_open":
      return user ? { users: user } : null;
    case "slack_conversations_close":
      return null;
    case "slack_conversations_invite":
      return channel && user ? { channel, users: user } : null;
    case "slack_conversations_kick":
      return null;
    case "slack_conversations_rename":
      return channel ? { channel, name: `slackmcp-renamed-${runId}` } : null;
    case "slack_conversations_set_topic":
      return channel ? { channel, topic: "Slack MCP live write test topic" } : null;
    case "slack_conversations_set_purpose":
      return channel ? { channel, purpose: "Slack MCP live write test purpose" } : null;
    case "slack_conversations_mark":
      return channel && ts ? { channel, ts } : null;

    case "slack_chat_post_message":
      return channel ? { channel, text: `Slack MCP live test ${runId}` } : null;
    case "slack_chat_post_ephemeral":
      return channel && user ? { channel, user, text: `Slack MCP ephemeral test ${runId}` } : null;
    case "slack_chat_me_message":
      return channel ? { channel, text: `Slack MCP me-message test ${runId}` } : null;
    case "slack_chat_update":
      return channel && ts ? { channel, ts, text: `Slack MCP live test updated ${runId}` } : null;
    case "slack_chat_delete":
      return channel && ts ? { channel, ts } : null;
    case "slack_chat_schedule_message":
      return channel ? { channel, post_at: Math.floor(Date.now() / 1000) + 600, text: `Slack MCP scheduled test ${runId}` } : null;
    case "slack_chat_delete_scheduled_message":
      return channel && scheduled ? { channel, scheduled_message_id: scheduled } : null;
    case "slack_chat_scheduled_messages_list":
      return channel ? { channel, limit: 20 } : {};
    case "slack_chat_get_permalink":
      return channel && ts ? { channel, message_ts: ts } : null;
    case "slack_chat_unfurl":
      return channel && ts ? { channel, ts, unfurls: JSON.stringify({ "https://example.com": { text: "Slack MCP unfurl test" } }) } : null;
    case "slack_search_messages":
      return { query: "Slack MCP", count: 5 };

    case "slack_reactions_add":
    case "slack_reactions_get":
    case "slack_reactions_remove":
      return channel && ts ? { channel, timestamp: ts, name: "white_check_mark" } : null;
    case "slack_reactions_list":
      return {};

    case "slack_files_list":
      return channel ? { channel, count: 10 } : {};
    case "slack_files_info":
    case "slack_files_delete":
    case "slack_files_shared_public_url":
    case "slack_files_revoke_public_url":
      return null;
    case "slack_files_remote_add":
      return { external_id: ctx.remoteFileExternalId, external_url: "https://example.com/slack-mcp-test", title: `Slack MCP remote file ${runId}` };
    case "slack_files_remote_info":
      return remoteFile ? { file: remoteFile } : { external_id: ctx.remoteFileExternalId };
    case "slack_files_remote_list":
      return {};
    case "slack_files_remote_share":
      return channel ? { external_id: ctx.remoteFileExternalId, channels: channel } : null;
    case "slack_files_remote_update":
      return { external_id: ctx.remoteFileExternalId, title: `Slack MCP remote file updated ${runId}` };
    case "slack_files_remote_remove":
      return { external_id: ctx.remoteFileExternalId };

    case "slack_pins_add":
    case "slack_pins_list":
    case "slack_pins_remove":
      return channel && ts ? { channel, timestamp: ts } : channel ? { channel } : null;

    case "slack_reminders_add":
      return { text: `Slack MCP reminder ${runId}`, time: "in 10 minutes" };
    case "slack_reminders_info":
    case "slack_reminders_complete":
    case "slack_reminders_delete":
      return reminder ? { reminder } : null;

    case "slack_stars_add":
    case "slack_stars_remove":
      return channel && ts ? { channel, timestamp: ts } : null;

    case "slack_bookmarks_add":
      return channel ? { channel_id: channel, title: `Slack MCP bookmark ${runId}`, link: "https://example.com", type: "link" } : null;
    case "slack_bookmarks_list":
      return channel ? { channel_id: channel } : null;
    case "slack_bookmarks_edit":
      return channel && bookmark ? { channel_id: channel, bookmark_id: bookmark, title: `Slack MCP bookmark updated ${runId}`, link: "https://example.com/updated" } : null;
    case "slack_bookmarks_remove":
      return channel && bookmark ? { channel_id: channel, bookmark_id: bookmark } : null;

    case "slack_usergroups_list":
      return {};
    case "slack_usergroups_create":
      return { name: `Slack MCP ${runId}`, handle: `slackmcp${runId}` };
    case "slack_usergroups_users_list":
    case "slack_usergroups_update":
    case "slack_usergroups_disable":
    case "slack_usergroups_enable":
      return usergroup ? { usergroup } : null;
    case "slack_usergroups_users_update":
      return usergroup && user ? { usergroup, users: user } : null;

    case "slack_calls_add":
      return { external_unique_id: `slack-mcp-${runId}`, join_url: "https://example.com/call", title: `Slack MCP call ${runId}` };
    case "slack_calls_info":
    case "slack_calls_end":
      return call ? { id: call } : null;
    case "slack_calls_update":
      return call ? { id: call, title: `Slack MCP call updated ${runId}` } : null;
    case "slack_calls_participants_add":
    case "slack_calls_participants_remove":
      return call && user ? { id: call, users: JSON.stringify([{ slack_id: user }]) } : null;

    case "slack_dnd_info":
    case "slack_dnd_end_snooze":
    case "slack_dnd_end_dnd":
      return {};
    case "slack_dnd_team_info":
      return user ? { users: user } : {};
    case "slack_dnd_set_snooze":
      return { num_minutes: 1 };

    case "slack_admin_users_list":
      return {};
    case "slack_admin_users_invite":
      return { team_id: "T00000000", email: `slack-mcp-${runId}@example.com` };
    case "slack_admin_conversations_archive":
    case "slack_admin_conversations_delete":
    case "slack_admin_conversations_invite":
    case "slack_admin_conversations_rename":
      return channel ? { channel_id: channel, channel, users: user, name: `admin-${runId}` } : null;
    default:
      return {};
  }
}

function orderedTools(): typeof slackTools {
  const preferredOrder = [
    "slack_auth_test",
    "slack_api_test",
    "slack_team_info",
    "slack_team_profile_get",
    "slack_emoji_list",
    "slack_users_list",
    "slack_users_info",
    "slack_users_lookup_by_email",
    "slack_users_get_presence",
    "slack_users_set_presence",
    "slack_users_profile_get",
    "slack_users_profile_set",
    "slack_users_delete_photo",
    "slack_conversations_list",
    "slack_conversations_create",
    "slack_conversations_join",
    "slack_conversations_info",
    "slack_conversations_members",
    "slack_conversations_invite",
    "slack_conversations_rename",
    "slack_conversations_set_topic",
    "slack_conversations_set_purpose",
    "slack_chat_post_message",
    "slack_chat_update",
    "slack_chat_get_permalink",
    "slack_chat_post_ephemeral",
    "slack_chat_me_message",
    "slack_chat_schedule_message",
    "slack_chat_scheduled_messages_list",
    "slack_chat_delete_scheduled_message",
    "slack_conversations_history",
    "slack_conversations_replies",
    "slack_conversations_mark",
    "slack_search_messages",
    "slack_reactions_list",
    "slack_reactions_add",
    "slack_reactions_get",
    "slack_reactions_remove",
    "slack_files_list",
    "slack_files_remote_add",
    "slack_files_remote_info",
    "slack_files_remote_list",
    "slack_files_remote_share",
    "slack_files_remote_update",
    "slack_files_remote_remove",
    "slack_pins_list",
    "slack_pins_add",
    "slack_pins_remove",
    "slack_reminders_add",
    "slack_reminders_list",
    "slack_reminders_info",
    "slack_reminders_complete",
    "slack_reminders_delete",
    "slack_stars_list",
    "slack_stars_add",
    "slack_stars_remove",
    "slack_bookmarks_list",
    "slack_bookmarks_add",
    "slack_bookmarks_edit",
    "slack_bookmarks_remove",
    "slack_usergroups_list",
    "slack_usergroups_create",
    "slack_usergroups_users_list",
    "slack_usergroups_update",
    "slack_usergroups_users_update",
    "slack_usergroups_disable",
    "slack_usergroups_enable",
    "slack_calls_add",
    "slack_calls_info",
    "slack_calls_update",
    "slack_calls_participants_add",
    "slack_calls_participants_remove",
    "slack_calls_end",
    "slack_dnd_info",
    "slack_dnd_team_info",
    "slack_dnd_set_snooze",
    "slack_dnd_end_snooze",
    "slack_dnd_end_dnd",
    "slack_chat_unfurl",
    "slack_chat_delete",
    "slack_conversations_leave",
    "slack_conversations_archive",
    "slack_conversations_unarchive",
    "slack_conversations_close",
    "slack_conversations_kick",
    "slack_files_info",
    "slack_files_delete",
    "slack_files_shared_public_url",
    "slack_files_revoke_public_url",
    "slack_admin_users_list",
    "slack_admin_users_invite",
    "slack_admin_conversations_archive",
    "slack_admin_conversations_delete",
    "slack_admin_conversations_invite",
    "slack_admin_conversations_rename"
  ];
  const rank = new Map(preferredOrder.map((name, index) => [name, index]));
  return [...slackTools].sort((left, right) => {
    const leftRank = rank.get(left.name) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.name) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
}

function classify(name: string, result: McpResult): ToolResult {
  const text = result.content?.[0]?.text ?? "";
  if (!result.isError) {
    return { name, status: "passed", detail: summarize(text) };
  }
  return { name, status: text.includes("\"error\"") ? "slack_error" : "mcp_error", detail: summarize(text) };
}

function captureState(name: string, result: McpResult, ctx: TestContext): void {
  if (result.isError) return;
  const data = parseContent(result);
  if (!data) return;

  if (name === "slack_auth_test") {
    setIfPresent(ctx, "userId", stringAt(data, ["user_id"]) ?? stringAt(data, ["user"]));
  }
  if (name === "slack_users_list") {
    const user = firstUsableUser(data);
    if (!ctx.userId) {
      setIfPresent(ctx, "userId", user?.id);
    }
    setIfPresent(ctx, "userEmail", user?.email);
  }
  if (name === "slack_conversations_create") {
    setIfPresent(ctx, "channelId", stringAt(data, ["channel", "id"]));
  }
  if (name === "slack_chat_post_message") {
    setIfPresent(ctx, "messageTs", stringAt(data, ["ts"]));
    setIfPresent(ctx, "channelId", stringAt(data, ["channel"]));
  }
  if (name === "slack_chat_schedule_message") {
    setIfPresent(ctx, "scheduledMessageId", stringAt(data, ["scheduled_message_id"]));
  }
  if (name === "slack_reminders_add") {
    setIfPresent(ctx, "reminderId", stringAt(data, ["reminder", "id"]));
  }
  if (name === "slack_bookmarks_add") {
    setIfPresent(ctx, "bookmarkId", stringAt(data, ["bookmark", "id"]));
  }
  if (name === "slack_files_remote_add") {
    setIfPresent(ctx, "remoteFileId", stringAt(data, ["file", "id"]));
  }
  if (name === "slack_calls_add") {
    setIfPresent(ctx, "callId", stringAt(data, ["call", "id"]));
  }
  if (name === "slack_usergroups_create") {
    setIfPresent(ctx, "usergroupId", stringAt(data, ["usergroup", "id"]));
  }
}

function setIfPresent<Key extends keyof TestContext>(ctx: TestContext, key: Key, value: TestContext[Key] | undefined): void {
  if (value !== undefined) {
    ctx[key] = value;
  }
}

async function cleanup(ctx: TestContext, results: ToolResult[]): Promise<void> {
  const cleanupCalls: Array<readonly [string, Json | null]> = [
    ["slack_chat_delete_scheduled_message", argsFor("slack_chat_delete_scheduled_message", ctx)],
    ["slack_bookmarks_remove", argsFor("slack_bookmarks_remove", ctx)],
    ["slack_pins_remove", argsFor("slack_pins_remove", ctx)],
    ["slack_reactions_remove", argsFor("slack_reactions_remove", ctx)],
    ["slack_reminders_delete", argsFor("slack_reminders_delete", ctx)],
    ["slack_files_remote_remove", argsFor("slack_files_remote_remove", ctx)],
    ["slack_calls_end", argsFor("slack_calls_end", ctx)],
    ["slack_chat_delete", argsFor("slack_chat_delete", ctx)],
    ["slack_usergroups_disable", argsFor("slack_usergroups_disable", ctx)],
    ["slack_conversations_archive", argsFor("slack_conversations_archive", ctx)]
  ];

  for (const [name, args] of cleanupCalls) {
    if (args === null) continue;
    const result = await callTool(ctx, name, args);
    results.push({ ...classify(`${name}#cleanup`, result), name: `${name}#cleanup` });
  }
}

function parseContent(result: McpResult): Json | null {
  const text = result.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return null;
  }
}

function stringAt(value: unknown, path: readonly string[]): string | undefined {
  let current = value;
  for (const part of path) {
    if (typeof current !== "object" || current === null || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

function firstUsableUser(value: Json): { readonly id?: string | undefined; readonly email?: string | undefined } | undefined {
  const members = value.members;
  if (!Array.isArray(members)) return undefined;
  for (const member of members) {
    if (typeof member !== "object" || member === null) continue;
    const record = member as Record<string, unknown>;
    if (record.id === "USLACKBOT") continue;
    if (record.deleted === true || record.is_bot === true) continue;
    const id = typeof record.id === "string" ? record.id : undefined;
    const profile = typeof record.profile === "object" && record.profile !== null
      ? record.profile as Record<string, unknown>
      : {};
    const email = typeof profile.email === "string" ? profile.email : undefined;
    if (id) return { id, email };
  }
  return undefined;
}

function summarize(text: string): string {
  if (!text) return "";
  return text.replace(/\s+/g, " ").slice(0, 300);
}
