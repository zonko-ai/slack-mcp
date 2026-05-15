export type JsonObjectSchema = {
  readonly type: "object";
  readonly properties: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
};

export type SlackToolAnnotations = {
  readonly scopes: readonly string[];
  readonly token: "user" | "bot" | "either" | "admin";
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly requiresEnterprise?: boolean;
};

export type SlackTool = {
  readonly name: string;
  readonly method: string;
  readonly description: string;
  readonly inputSchema: JsonObjectSchema;
  readonly annotations: SlackToolAnnotations;
};

type FieldName =
  | "attachments"
  | "blocks"
  | "channel"
  | "channels"
  | "cursor"
  | "email"
  | "external_id"
  | "external_url"
  | "file"
  | "filename"
  | "handle"
  | "id"
  | "inclusive"
  | "join_url"
  | "latest"
  | "limit"
  | "max_conversations"
  | "messages_per_conversation"
  | "link"
  | "description"
  | "bookmark_id"
  | "message_ts"
  | "name"
  | "oldest"
  | "num_minutes"
  | "post_at"
  | "presence"
  | "profile"
  | "purpose"
  | "query"
  | "channel_id"
  | "external_unique_id"
  | "reminder"
  | "scheduled_message_id"
  | "team_id"
  | "text"
  | "time"
  | "type"
  | "timestamp"
  | "title"
  | "topic"
  | "ts"
  | "ts_from"
  | "ts_to"
  | "types"
  | "unfurls"
  | "url"
  | "user"
  | "usergroup"
  | "users";

const fieldSchemas: Record<FieldName, unknown> = {
  attachments: { type: "string", description: "JSON-encoded Slack attachments." },
  blocks: { type: "string", description: "JSON-encoded Slack Block Kit blocks." },
  channel: { type: "string", description: "Slack channel, conversation, DM, or MPIM id." },
  channels: { type: "string", description: "Comma-separated Slack channel ids." },
  cursor: { type: "string", description: "Pagination cursor returned by Slack." },
  email: { type: "string", description: "Email address." },
  external_id: { type: "string", description: "External file id." },
  external_url: { type: "string", description: "External file URL." },
  file: { type: "string", description: "Slack file id." },
  filename: { type: "string", description: "File name." },
  handle: { type: "string", description: "Slack user group handle." },
  id: { type: "string", description: "Slack object id." },
  inclusive: { type: "boolean", description: "Whether timestamp bounds are inclusive." },
  join_url: { type: "string", description: "Call join URL." },
  latest: { type: "string", description: "Latest timestamp bound." },
  limit: { type: "number", description: "Maximum number of records to return." },
  max_conversations: { type: "number", description: "Maximum number of conversations to scan." },
  messages_per_conversation: { type: "number", description: "Maximum unread messages to fetch per conversation." },
  link: { type: "string", description: "Slack bookmark link URL." },
  description: { type: "string", description: "Description text." },
  bookmark_id: { type: "string", description: "Slack bookmark id." },
  message_ts: { type: "string", description: "Slack message timestamp." },
  name: { type: "string", description: "Name for a Slack object." },
  oldest: { type: "string", description: "Oldest timestamp bound." },
  num_minutes: { type: "number", description: "Number of minutes." },
  post_at: { type: "number", description: "Unix timestamp for scheduled delivery." },
  presence: { type: "string", description: "Slack presence value." },
  profile: { type: "string", description: "JSON-encoded Slack profile object." },
  purpose: { type: "string", description: "Slack channel purpose text." },
  query: { type: "string", description: "Search query." },
  channel_id: { type: "string", description: "Slack channel id." },
  external_unique_id: { type: "string", description: "External unique call id." },
  reminder: { type: "string", description: "Slack reminder id." },
  scheduled_message_id: { type: "string", description: "Scheduled message id." },
  team_id: { type: "string", description: "Slack team id." },
  text: { type: "string", description: "Plain text content." },
  time: { type: "string", description: "Reminder time, timestamp, or natural language time." },
  type: { type: "string", description: "Slack object type." },
  timestamp: { type: "string", description: "Slack message timestamp." },
  title: { type: "string", description: "Title." },
  topic: { type: "string", description: "Conversation topic or purpose text." },
  ts: { type: "string", description: "Slack message timestamp." },
  ts_from: { type: "string", description: "Start timestamp for file or message filtering." },
  ts_to: { type: "string", description: "End timestamp for file or message filtering." },
  types: { type: "string", description: "Comma-separated Slack object types." },
  unfurls: { type: "string", description: "JSON-encoded unfurl map." },
  url: { type: "string", description: "URL." },
  user: { type: "string", description: "Slack user id." },
  usergroup: { type: "string", description: "Slack user group id." },
  users: { type: "string", description: "Comma-separated Slack user ids." }
};

const emptySchema: JsonObjectSchema = {
  type: "object",
  properties: {},
  additionalProperties: true
};

function schema(fields: readonly FieldName[], required: readonly FieldName[] = []): JsonObjectSchema {
  return {
    type: "object",
    properties: Object.fromEntries(fields.map((field) => [field, fieldSchemas[field]])),
    required,
    additionalProperties: true
  };
}

function tool(
  name: string,
  method: string,
  description: string,
  scopes: readonly string[],
  fields: readonly FieldName[] = [],
  required: readonly FieldName[] = [],
  options: Omit<SlackToolAnnotations, "scopes" | "readOnlyHint"> & { readonly readOnlyHint?: boolean } = {
    token: "either"
  }
): SlackTool {
  return {
    name,
    method,
    description,
    inputSchema: fields.length === 0 ? emptySchema : schema(fields, required),
    annotations: {
      scopes,
      token: options.token,
      readOnlyHint: options.readOnlyHint ?? isReadOnlyMethod(method),
      ...(options.destructiveHint === undefined ? {} : { destructiveHint: options.destructiveHint }),
      ...(options.requiresEnterprise === undefined ? {} : { requiresEnterprise: options.requiresEnterprise })
    }
  };
}

export const slackTools: readonly SlackTool[] = [
  tool("slack_auth_test", "auth.test", "Verify the active Slack token and return workspace/user metadata.", ["none"], [], [], { token: "either", readOnlyHint: true }),
  tool("slack_api_test", "api.test", "Exercise Slack API connectivity with optional diagnostic arguments.", ["none"], [], [], { token: "either", readOnlyHint: true }),
  tool("slack_team_info", "team.info", "Fetch metadata for the current Slack workspace or a specified team.", ["team:read"], ["team_id"], [], { token: "either", readOnlyHint: true }),
  tool("slack_team_profile_get", "team.profile.get", "Retrieve team profile field definitions for the workspace.", ["users.profile:read"], [], [], { token: "user", readOnlyHint: true }),
  tool("slack_emoji_list", "emoji.list", "List custom emoji aliases and image URLs in the workspace.", ["emoji:read"], [], [], { token: "either", readOnlyHint: true }),

  tool("slack_users_list", "users.list", "List users in the workspace with pagination.", ["users:read"], ["cursor", "limit", "team_id"], [], { token: "either", readOnlyHint: true }),
  tool("slack_users_info", "users.info", "Retrieve detailed information for a Slack user.", ["users:read"], ["user"], ["user"], { token: "either", readOnlyHint: true }),
  tool("slack_users_lookup_by_email", "users.lookupByEmail", "Find a Slack user by email address.", ["users:read.email"], ["email"], ["email"], { token: "either", readOnlyHint: true }),
  tool("slack_users_get_presence", "users.getPresence", "Retrieve realtime presence for a Slack user.", ["users:read"], ["user"], ["user"], { token: "user", readOnlyHint: true }),
  tool("slack_users_set_presence", "users.setPresence", "Set the authenticated user's Slack presence.", ["users:write"], ["presence"], ["presence"], { token: "user", readOnlyHint: false }),
  tool("slack_users_profile_get", "users.profile.get", "Retrieve a Slack user's profile fields.", ["users.profile:read"], ["user"], [], { token: "user", readOnlyHint: true }),
  tool("slack_users_profile_set", "users.profile.set", "Update the authenticated user's Slack profile fields.", ["users.profile:write"], ["user", "profile"], ["profile"], { token: "user", readOnlyHint: false }),
  tool("slack_users_delete_photo", "users.deletePhoto", "Delete the authenticated user's Slack profile photo.", ["users.profile:write"], [], [], { token: "user", readOnlyHint: false, destructiveHint: true }),

  tool("slack_conversations_list", "conversations.list", "List public channels, private channels, DMs, and MPIMs visible to the token.", ["channels:read", "groups:read", "im:read", "mpim:read"], ["cursor", "limit", "types"], [], { token: "either", readOnlyHint: true }),
  tool("slack_conversations_info", "conversations.info", "Retrieve metadata and preferences for a Slack conversation.", ["channels:read", "groups:read", "im:read", "mpim:read"], ["channel"], ["channel"], { token: "either", readOnlyHint: true }),
  tool("slack_conversations_members", "conversations.members", "List member ids for a Slack conversation.", ["channels:read", "groups:read", "im:read", "mpim:read"], ["channel", "cursor", "limit"], ["channel"], { token: "either", readOnlyHint: true }),
  tool("slack_conversations_history", "conversations.history", "Fetch message history for a Slack conversation.", ["channels:history", "groups:history", "im:history", "mpim:history"], ["channel", "cursor", "inclusive", "latest", "limit", "oldest"], ["channel"], { token: "either", readOnlyHint: true }),
  tool("slack_conversations_replies", "conversations.replies", "Fetch replies for a parent message in a Slack conversation.", ["channels:history", "groups:history", "im:history", "mpim:history"], ["channel", "ts", "cursor", "inclusive", "latest", "limit", "oldest"], ["channel", "ts"], { token: "either", readOnlyHint: true }),
  tool("slack_unread_messages", "harbor.unreadMessages", "Scan visible Slack conversations and fetch unread message content when Slack exposes unread state or a last-read cursor.", ["channels:read", "groups:read", "im:read", "mpim:read", "channels:history", "groups:history", "im:history", "mpim:history"], ["types", "max_conversations", "messages_per_conversation"], [], { token: "user", readOnlyHint: true }),
  tool("slack_conversations_open", "conversations.open", "Open or resume a DM or MPIM with one or more users.", ["im:write", "mpim:write"], ["channel", "users"], [], { token: "user", readOnlyHint: false }),
  tool("slack_conversations_close", "conversations.close", "Close a DM or MPIM in the authenticated user's sidebar.", ["im:write", "mpim:write"], ["channel"], ["channel"], { token: "user", readOnlyHint: false }),
  tool("slack_conversations_create", "conversations.create", "Create a public or private Slack channel.", ["channels:write", "groups:write"], ["name"], ["name"], { token: "either", readOnlyHint: false }),
  tool("slack_conversations_archive", "conversations.archive", "Archive a Slack conversation.", ["channels:write", "groups:write"], ["channel"], ["channel"], { token: "either", readOnlyHint: false, destructiveHint: true }),
  tool("slack_conversations_unarchive", "conversations.unarchive", "Unarchive a Slack conversation.", ["channels:write", "groups:write"], ["channel"], ["channel"], { token: "either", readOnlyHint: false }),
  tool("slack_conversations_join", "conversations.join", "Join a public Slack conversation.", ["channels:write"], ["channel"], ["channel"], { token: "either", readOnlyHint: false }),
  tool("slack_conversations_leave", "conversations.leave", "Leave a Slack conversation.", ["channels:write", "groups:write"], ["channel"], ["channel"], { token: "either", readOnlyHint: false }),
  tool("slack_conversations_invite", "conversations.invite", "Invite users to a Slack conversation.", ["channels:write", "groups:write"], ["channel", "users"], ["channel", "users"], { token: "either", readOnlyHint: false }),
  tool("slack_conversations_kick", "conversations.kick", "Remove a user from a Slack conversation.", ["channels:write", "groups:write"], ["channel", "user"], ["channel", "user"], { token: "either", readOnlyHint: false, destructiveHint: true }),
  tool("slack_conversations_rename", "conversations.rename", "Rename a Slack conversation.", ["channels:write", "groups:write"], ["channel", "name"], ["channel", "name"], { token: "either", readOnlyHint: false }),
  tool("slack_conversations_set_topic", "conversations.setTopic", "Set the topic for a Slack conversation.", ["channels:write", "groups:write"], ["channel", "topic"], ["channel", "topic"], { token: "either", readOnlyHint: false }),
  tool("slack_conversations_set_purpose", "conversations.setPurpose", "Set the purpose for a Slack conversation.", ["channels:write", "groups:write"], ["channel", "purpose"], ["channel", "purpose"], { token: "either", readOnlyHint: false }),
  tool("slack_conversations_mark", "conversations.mark", "Set the read cursor in a Slack conversation.", ["channels:history", "groups:history", "im:history", "mpim:history"], ["channel", "ts"], ["channel", "ts"], { token: "user", readOnlyHint: false }),

  tool("slack_chat_post_message", "chat.postMessage", "Send a message to a Slack channel, DM, or private conversation.", ["chat:write"], ["channel", "text", "blocks", "attachments"], ["channel"], { token: "either", readOnlyHint: false }),
  tool("slack_chat_post_ephemeral", "chat.postEphemeral", "Send an ephemeral message to a user in a channel.", ["chat:write"], ["channel", "user", "text", "blocks", "attachments"], ["channel", "user"], { token: "either", readOnlyHint: false }),
  tool("slack_chat_me_message", "chat.meMessage", "Share a me-message in a Slack conversation.", ["chat:write"], ["channel", "text"], ["channel", "text"], { token: "user", readOnlyHint: false }),
  tool("slack_chat_update", "chat.update", "Update an existing Slack message.", ["chat:write"], ["channel", "ts", "text", "blocks", "attachments"], ["channel", "ts"], { token: "either", readOnlyHint: false }),
  tool("slack_chat_delete", "chat.delete", "Delete a Slack message posted by the authenticated user or bot.", ["chat:write"], ["channel", "ts"], ["channel", "ts"], { token: "either", readOnlyHint: false, destructiveHint: true }),
  tool("slack_chat_schedule_message", "chat.scheduleMessage", "Schedule a Slack message for future delivery.", ["chat:write"], ["channel", "post_at", "text", "blocks", "attachments"], ["channel", "post_at"], { token: "either", readOnlyHint: false }),
  tool("slack_chat_delete_scheduled_message", "chat.deleteScheduledMessage", "Delete a pending scheduled Slack message.", ["chat:write"], ["channel", "scheduled_message_id"], ["channel", "scheduled_message_id"], { token: "either", readOnlyHint: false, destructiveHint: true }),
  tool("slack_chat_scheduled_messages_list", "chat.scheduledMessages.list", "List pending scheduled Slack messages.", ["chat:write"], ["channel", "cursor", "latest", "limit", "oldest"], [], { token: "either", readOnlyHint: true }),
  tool("slack_chat_get_permalink", "chat.getPermalink", "Retrieve a permalink for a Slack message.", ["channels:history", "groups:history", "im:history", "mpim:history"], ["channel", "message_ts"], ["channel", "message_ts"], { token: "either", readOnlyHint: true }),
  tool("slack_chat_unfurl", "chat.unfurl", "Customize URL unfurls on a Slack message.", ["links:write"], ["channel", "ts", "unfurls"], ["channel", "ts", "unfurls"], { token: "either", readOnlyHint: false }),

  tool("slack_search_messages", "search.messages", "Search Slack messages workspace-wide using Slack search syntax.", ["search:read"], ["query", "cursor", "limit"], ["query"], { token: "user", readOnlyHint: true }),

  tool("slack_reactions_add", "reactions.add", "Add an emoji reaction to a message, file, or file comment.", ["reactions:write"], ["channel", "timestamp", "name", "file"], ["name"], { token: "either", readOnlyHint: false }),
  tool("slack_reactions_remove", "reactions.remove", "Remove an emoji reaction from a message, file, or file comment.", ["reactions:write"], ["channel", "timestamp", "name", "file"], ["name"], { token: "either", readOnlyHint: false, destructiveHint: true }),
  tool("slack_reactions_get", "reactions.get", "Fetch reactions for a message, file, or file comment.", ["reactions:read"], ["channel", "timestamp", "file"], [], { token: "either", readOnlyHint: true }),
  tool("slack_reactions_list", "reactions.list", "List reactions made by a user.", ["reactions:read"], ["user", "cursor", "limit"], [], { token: "user", readOnlyHint: true }),

  tool("slack_files_list", "files.list", "List Slack files and metadata visible to the token.", ["files:read"], ["channel", "ts_from", "ts_to", "types", "user"], [], { token: "either", readOnlyHint: true }),
  tool("slack_files_info", "files.info", "Retrieve detailed Slack file metadata.", ["files:read"], ["file"], ["file"], { token: "either", readOnlyHint: true }),
  tool("slack_files_delete", "files.delete", "Delete a Slack file.", ["files:write"], ["file"], ["file"], { token: "either", readOnlyHint: false, destructiveHint: true }),
  tool("slack_files_shared_public_url", "files.sharedPublicURL", "Create a public URL for a Slack file.", ["files:write"], ["file"], ["file"], { token: "either", readOnlyHint: false }),
  tool("slack_files_revoke_public_url", "files.revokePublicURL", "Revoke a public URL for a Slack file.", ["files:write"], ["file"], ["file"], { token: "either", readOnlyHint: false, destructiveHint: true }),
  tool("slack_files_remote_add", "files.remote.add", "Add an external remote file reference to Slack.", ["remote_files:write"], ["external_id", "external_url", "title"], ["external_id", "external_url", "title"], { token: "bot", readOnlyHint: false }),
  tool("slack_files_remote_info", "files.remote.info", "Retrieve a Slack remote file reference.", ["remote_files:read"], ["file", "external_id"], [], { token: "bot", readOnlyHint: true }),
  tool("slack_files_remote_list", "files.remote.list", "List Slack remote file references.", ["remote_files:read"], ["channel", "cursor", "limit"], [], { token: "bot", readOnlyHint: true }),
  tool("slack_files_remote_remove", "files.remote.remove", "Remove a Slack remote file reference.", ["remote_files:write"], ["file", "external_id"], [], { token: "bot", readOnlyHint: false, destructiveHint: true }),
  tool("slack_files_remote_share", "files.remote.share", "Share a remote file reference into Slack conversations.", ["remote_files:share"], ["file", "external_id", "channels"], ["channels"], { token: "bot", readOnlyHint: false }),
  tool("slack_files_remote_update", "files.remote.update", "Update a Slack remote file reference.", ["remote_files:write"], ["file", "external_id", "external_url", "title"], [], { token: "bot", readOnlyHint: false }),

  tool("slack_pins_list", "pins.list", "List pinned items in a Slack conversation.", ["pins:read"], ["channel"], ["channel"], { token: "either", readOnlyHint: true }),
  tool("slack_pins_add", "pins.add", "Pin a Slack message or file to a conversation.", ["pins:write"], ["channel", "timestamp", "file"], ["channel"], { token: "either", readOnlyHint: false }),
  tool("slack_pins_remove", "pins.remove", "Unpin a Slack message or file from a conversation.", ["pins:write"], ["channel", "timestamp", "file"], ["channel"], { token: "either", readOnlyHint: false, destructiveHint: true }),

  tool("slack_reminders_add", "reminders.add", "Create a Slack reminder.", ["reminders:write"], ["text", "time", "user"], ["text", "time"], { token: "user", readOnlyHint: false }),
  tool("slack_reminders_delete", "reminders.delete", "Delete a Slack reminder.", ["reminders:write"], ["reminder"], ["reminder"], { token: "user", readOnlyHint: false, destructiveHint: true }),
  tool("slack_reminders_info", "reminders.info", "Retrieve a Slack reminder.", ["reminders:read"], ["reminder"], ["reminder"], { token: "user", readOnlyHint: true }),
  tool("slack_reminders_list", "reminders.list", "List Slack reminders for the authenticated user.", ["reminders:read"], [], [], { token: "user", readOnlyHint: true }),
  tool("slack_reminders_complete", "reminders.complete", "Mark a Slack reminder as complete.", ["reminders:write"], ["reminder"], ["reminder"], { token: "user", readOnlyHint: false }),

  tool("slack_stars_add", "stars.add", "Star a Slack channel, file, file comment, or message.", ["stars:write"], ["channel", "timestamp", "file"], [], { token: "user", readOnlyHint: false }),
  tool("slack_stars_remove", "stars.remove", "Remove a star from a Slack item.", ["stars:write"], ["channel", "timestamp", "file"], [], { token: "user", readOnlyHint: false, destructiveHint: true }),
  tool("slack_stars_list", "stars.list", "List starred Slack items.", ["stars:read"], ["cursor", "limit"], [], { token: "user", readOnlyHint: true }),

  tool("slack_bookmarks_list", "bookmarks.list", "List bookmarks in a Slack channel.", ["bookmarks:read"], ["channel_id"], ["channel_id"], { token: "either", readOnlyHint: true }),
  tool("slack_bookmarks_add", "bookmarks.add", "Add a bookmark to a Slack channel.", ["bookmarks:write"], ["channel_id", "title", "type", "link"], ["channel_id", "title", "type"], { token: "either", readOnlyHint: false }),
  tool("slack_bookmarks_edit", "bookmarks.edit", "Edit a bookmark in a Slack channel.", ["bookmarks:write"], ["channel_id", "bookmark_id", "title", "link"], ["channel_id", "bookmark_id"], { token: "either", readOnlyHint: false }),
  tool("slack_bookmarks_remove", "bookmarks.remove", "Remove a bookmark from a Slack channel.", ["bookmarks:write"], ["channel_id", "bookmark_id"], ["channel_id", "bookmark_id"], { token: "either", readOnlyHint: false, destructiveHint: true }),

  tool("slack_usergroups_list", "usergroups.list", "List Slack user groups.", ["usergroups:read"], [], [], { token: "either", readOnlyHint: true }),
  tool("slack_usergroups_users_list", "usergroups.users.list", "List members of a Slack user group.", ["usergroups:read"], ["usergroup"], ["usergroup"], { token: "either", readOnlyHint: true }),
  tool("slack_usergroups_create", "usergroups.create", "Create a Slack user group.", ["usergroups:write"], ["name", "handle", "description"], ["name"], { token: "either", readOnlyHint: false }),
  tool("slack_usergroups_update", "usergroups.update", "Update Slack user group metadata.", ["usergroups:write"], ["usergroup", "name", "handle", "description"], ["usergroup"], { token: "either", readOnlyHint: false }),
  tool("slack_usergroups_disable", "usergroups.disable", "Disable a Slack user group.", ["usergroups:write"], ["usergroup"], ["usergroup"], { token: "either", readOnlyHint: false, destructiveHint: true }),
  tool("slack_usergroups_enable", "usergroups.enable", "Enable a Slack user group.", ["usergroups:write"], ["usergroup"], ["usergroup"], { token: "either", readOnlyHint: false }),
  tool("slack_usergroups_users_update", "usergroups.users.update", "Replace the member list for a Slack user group.", ["usergroups:write"], ["usergroup", "users"], ["usergroup", "users"], { token: "either", readOnlyHint: false }),

  tool("slack_calls_add", "calls.add", "Register a new Slack call object.", ["calls:write"], ["external_unique_id", "join_url", "title"], ["external_unique_id", "join_url"], { token: "either", readOnlyHint: false }),
  tool("slack_calls_info", "calls.info", "Retrieve Slack call information.", ["calls:read"], ["id"], ["id"], { token: "either", readOnlyHint: true }),
  tool("slack_calls_update", "calls.update", "Update Slack call metadata.", ["calls:write"], ["id", "title", "join_url"], ["id"], { token: "either", readOnlyHint: false }),
  tool("slack_calls_end", "calls.end", "End a Slack call.", ["calls:write"], ["id"], ["id"], { token: "either", readOnlyHint: false, destructiveHint: true }),
  tool("slack_calls_participants_add", "calls.participants.add", "Add participants to a Slack call.", ["calls:write"], ["id", "users"], ["id", "users"], { token: "either", readOnlyHint: false }),
  tool("slack_calls_participants_remove", "calls.participants.remove", "Remove participants from a Slack call.", ["calls:write"], ["id", "users"], ["id", "users"], { token: "either", readOnlyHint: false, destructiveHint: true }),

  tool("slack_dnd_info", "dnd.info", "Retrieve DND status for the authenticated or specified user.", ["dnd:read"], ["user"], [], { token: "user", readOnlyHint: true }),
  tool("slack_dnd_team_info", "dnd.teamInfo", "Retrieve DND status for multiple workspace users.", ["dnd:read"], ["users"], [], { token: "user", readOnlyHint: true }),
  tool("slack_dnd_set_snooze", "dnd.setSnooze", "Set a DND snooze duration for the authenticated user.", ["dnd:write"], ["num_minutes"], ["num_minutes"], { token: "user", readOnlyHint: false }),
  tool("slack_dnd_end_snooze", "dnd.endSnooze", "End the authenticated user's snooze mode.", ["dnd:write"], [], [], { token: "user", readOnlyHint: false }),
  tool("slack_dnd_end_dnd", "dnd.endDnd", "End the authenticated user's DND session.", ["dnd:write"], [], [], { token: "user", readOnlyHint: false }),

  tool("slack_admin_users_list", "admin.users.list", "List users through Slack Admin APIs.", ["admin.users:read"], ["team_id", "cursor", "limit"], [], { token: "admin", readOnlyHint: true, requiresEnterprise: true }),
  tool("slack_admin_users_invite", "admin.users.invite", "Invite a user to an Enterprise Grid workspace.", ["admin.users:write"], ["team_id", "email", "channels"], ["team_id", "email"], { token: "admin", readOnlyHint: false, requiresEnterprise: true }),
  tool("slack_admin_conversations_archive", "admin.conversations.archive", "Archive a conversation through Slack Admin APIs.", ["admin.conversations:write"], ["channel"], ["channel"], { token: "admin", readOnlyHint: false, destructiveHint: true, requiresEnterprise: true }),
  tool("slack_admin_conversations_delete", "admin.conversations.delete", "Delete a conversation through Slack Admin APIs.", ["admin.conversations:write"], ["channel"], ["channel"], { token: "admin", readOnlyHint: false, destructiveHint: true, requiresEnterprise: true }),
  tool("slack_admin_conversations_invite", "admin.conversations.invite", "Invite users to a conversation through Slack Admin APIs.", ["admin.conversations:write"], ["channel", "users"], ["channel", "users"], { token: "admin", readOnlyHint: false, requiresEnterprise: true }),
  tool("slack_admin_conversations_rename", "admin.conversations.rename", "Rename a conversation through Slack Admin APIs.", ["admin.conversations:write"], ["channel", "name"], ["channel", "name"], { token: "admin", readOnlyHint: false, requiresEnterprise: true })
];

export function findSlackTool(name: string): SlackTool | undefined {
  return slackTools.find((toolDefinition) => toolDefinition.name === name);
}

function isReadOnlyMethod(method: string): boolean {
  return (
    method.includes(".list") ||
    method.includes(".info") ||
    method.includes(".get") ||
    method.includes(".history") ||
    method.includes(".replies") ||
    method.includes(".test") ||
    method.includes(".search")
  );
}
