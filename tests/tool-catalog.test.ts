import { describe, expect, test } from "vitest";
import {
  isSlackToolAvailableForInstallation,
  slackTools
} from "../src/slack/tool-catalog.js";

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

  test("uses Slack Web API parameter names for schema-required write arguments", () => {
    expect(requiredFields("slack_users_set_presence")).toEqual(["presence"]);
    expect(requiredFields("slack_users_profile_set")).toEqual(["profile"]);
    expect(requiredFields("slack_conversations_set_purpose")).toEqual(["channel", "purpose"]);
    expect(requiredFields("slack_bookmarks_list")).toEqual(["channel_id"]);
    expect(requiredFields("slack_bookmarks_add")).toEqual(["channel_id", "title", "type"]);
    expect(requiredFields("slack_bookmarks_edit")).toEqual(["channel_id", "bookmark_id"]);
    expect(requiredFields("slack_bookmarks_remove")).toEqual(["channel_id", "bookmark_id"]);
    expect(requiredFields("slack_calls_add")).toEqual(["external_unique_id", "join_url"]);
    expect(requiredFields("slack_dnd_set_snooze")).toEqual(["num_minutes"]);
  });

  test("declares structured schemas for Slack JSON payload fields", () => {
    expect(fieldType("slack_chat_post_message", "blocks")).toBe("array");
    expect(fieldType("slack_chat_post_message", "attachments")).toBe("array");
    expect(fieldType("slack_users_profile_set", "profile")).toBe("object");
    expect(fieldType("slack_chat_unfurl", "unfurls")).toBe("object");
  });

  test("matches Slack tools to installation token availability and granted scopes", () => {
    const installation = {
      connectionId: "T123:U123",
      teamId: "T123",
      teamName: "Example",
      enterpriseId: null,
      userId: "U123",
      accessToken: "xoxp-installed-token",
      scope: "auth.test,api.test,chat:write,channels:read",
      tokenType: "user" as const,
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T00:00:00.000Z"
    };

    expect(isSlackToolAvailableForInstallation(toolByName("slack_chat_post_message"), installation)).toBe(true);
    expect(isSlackToolAvailableForInstallation(toolByName("slack_admin_users_list"), installation)).toBe(false);
    expect(isSlackToolAvailableForInstallation(toolByName("slack_files_remote_add"), installation)).toBe(false);
  });
});

function requiredFields(name: string): readonly string[] {
  return toolByName(name).inputSchema.required ?? [];
}

function fieldType(toolName: string, fieldName: string): unknown {
  const field = toolByName(toolName).inputSchema.properties[fieldName];
  return typeof field === "object" && field !== null && "type" in field
    ? (field as { readonly type?: unknown }).type
    : undefined;
}

function toolByName(name: string) {
  const tool = slackTools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Missing Slack tool ${name}`);
  }
  return tool;
}
