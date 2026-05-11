import { describe, expect, test } from "vitest";
import { slackTools } from "../src/slack/tool-catalog.js";

describe("slackTools", () => {
  test("exposes a broad Composio-relevant Slack tool surface with unique MCP names", () => {
    const names = slackTools.map((tool) => tool.name);
    const uniqueNames = new Set(names);

    expect(uniqueNames.size).toBe(names.length);
    expect(names.length).toBeGreaterThanOrEqual(60);
    expect(names).toEqual(
      expect.arrayContaining([
        "slack_auth_test",
        "slack_team_info",
        "slack_conversations_history",
        "slack_conversations_replies",
        "slack_conversations_create",
        "slack_conversations_invite",
        "slack_chat_post_message",
        "slack_chat_update",
        "slack_chat_schedule_message",
        "slack_reactions_add",
        "slack_files_list",
        "slack_files_info",
        "slack_pins_add",
        "slack_reminders_add",
        "slack_stars_list",
        "slack_bookmarks_add",
        "slack_calls_add",
        "slack_usergroups_create",
        "slack_users_profile_set",
        "slack_search_messages"
      ])
    );
  });

  test("declares JSON object input schemas and Slack scope metadata for every tool", () => {
    for (const tool of slackTools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations.scopes.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(12);
    }
  });

  test("uses Slack scope names for admin APIs", () => {
    const scopes = new Set(slackTools.flatMap((tool) => tool.annotations.scopes));

    expect(scopes.has("admin.users:read")).toBe(true);
    expect(scopes.has("admin.users:write")).toBe(true);
    expect(scopes.has("admin.conversations:write")).toBe(true);
    expect(scopes).not.toContain("admin.users.read");
    expect(scopes).not.toContain("admin.users.write");
    expect(scopes).not.toContain("admin.conversations.write");
  });
});
