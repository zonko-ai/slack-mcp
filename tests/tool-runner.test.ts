import { describe, expect, test, vi } from "vitest";
import type { TokenStore } from "../src/slack/token-store.js";
import { SlackToolRunner } from "../src/slack/tool-runner.js";

describe("SlackToolRunner", () => {
  test("redacts token-like values from Slack API responses", async () => {
    const tokenStore: TokenStore = {
      save: vi.fn(),
      get: vi.fn(),
      getDefault: vi.fn(async () => ({
        connectionId: "T123:U123",
        teamId: "T123",
        teamName: "Example",
        enterpriseId: null,
        userId: "U123",
        accessToken: "xoxp-installed-token",
        scope: "users:read",
        tokenType: "user" as const,
        createdAt: "2026-05-11T00:00:00.000Z",
        updatedAt: "2026-05-11T00:00:00.000Z"
      })),
      listSummaries: vi.fn()
    };
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          args: {
            token: "xoxp-123-456-789-secret",
            nested: "sent xoxb-123-456-secret here"
          }
        }),
        { headers: { "content-type": "application/json" } }
      )
    );
    const runner = new SlackToolRunner({ tokenStore, fetch: fetchMock });

    const result = await runner.callTool({ name: "slack_api_test", arguments: {} });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("[redacted]");
    expect(result.content[0]?.text).not.toContain("xoxp-123-456-789-secret");
    expect(result.content[0]?.text).not.toContain("xoxb-123-456-secret");
  });

  test("refreshes an expiring user token before calling Slack and persists the rotated token pair", async () => {
    const save = vi.fn(async (installation) => ({
      ...installation,
      connectionId: `${installation.teamId}:${installation.userId}`,
      createdAt: "2026-05-11T00:00:00.000Z",
      updatedAt: "2026-05-11T06:00:00.000Z"
    }));
    const tokenStore: TokenStore = {
      save,
      get: vi.fn(),
      getDefault: vi.fn(async () => ({
        connectionId: "T123:U123",
        teamId: "T123",
        teamName: "Example",
        enterpriseId: null,
        userId: "U123",
        accessToken: "xoxe.xoxp-old",
        userRefreshToken: "xoxe-user-refresh-old",
        userTokenExpiresAt: "2026-05-11T06:04:00.000Z",
        scope: "api:read",
        tokenType: "user" as const,
        createdAt: "2026-05-11T00:00:00.000Z",
        updatedAt: "2026-05-11T00:00:00.000Z"
      })),
      listSummaries: vi.fn()
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://slack.com/api/oauth.v2.access") {
        return new Response(
          JSON.stringify({
            ok: true,
            access_token: "xoxe.xoxp-new",
            refresh_token: "xoxe-user-refresh-new",
            expires_in: 43200,
            token_type: "user",
            scope: "api:read"
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      expect(url).toBe("https://slack.com/api/api.test");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer xoxe.xoxp-new");
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" }
      });
    });
    const runner = new SlackToolRunner({
      tokenStore,
      fetch: fetchMock,
      tokenRotation: {
        clientId: "111.222",
        clientSecret: "secret",
        now: () => new Date("2026-05-11T06:00:00.000Z")
      }
    });

    const result = await runner.callTool({ name: "slack_api_test", arguments: {} });

    expect(result.isError).toBeUndefined();
    const refreshCall = fetchMock.mock.calls.find(([input]) => String(input) === "https://slack.com/api/oauth.v2.access");
    expect(refreshCall).toBeTruthy();
    const refreshBody = refreshCall?.[1]?.body;
    expect(refreshBody).toBeInstanceOf(URLSearchParams);
    expect((refreshBody as URLSearchParams).get("grant_type")).toBe("refresh_token");
    expect((refreshBody as URLSearchParams).get("refresh_token")).toBe("xoxe-user-refresh-old");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "xoxe.xoxp-new",
        userRefreshToken: "xoxe-user-refresh-new",
        userTokenExpiresAt: "2026-05-11T18:00:00.000Z"
      })
    );
  });

  test("fetches unread message content with the high-level unread workflow", async () => {
    const tokenStore: TokenStore = {
      save: vi.fn(),
      get: vi.fn(),
      getDefault: vi.fn(async () => ({
        connectionId: "T123:U123",
        teamId: "T123",
        teamName: "Example",
        enterpriseId: null,
        userId: "U123",
        accessToken: "xoxp-installed-token",
        scope: "channels:read,channels:history,im:read,im:history",
        tokenType: "user" as const,
        createdAt: "2026-05-11T00:00:00.000Z",
        updatedAt: "2026-05-11T00:00:00.000Z"
      })),
      listSummaries: vi.fn()
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = String(input).replace("https://slack.com/api/", "");
      const body = init?.body as URLSearchParams;
      if (method === "conversations.list") {
        return new Response(
          JSON.stringify({
            ok: true,
            channels: [
              { id: "C1", name: "general", is_channel: true },
              { id: "D1", is_im: true, user: "U999", unread_count_display: 0 }
            ],
            response_metadata: { next_cursor: "" }
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      if (method === "conversations.info" && body.get("channel") === "C1") {
        return new Response(
          JSON.stringify({
            ok: true,
            channel: {
              id: "C1",
              name: "general",
              is_channel: true,
              unread_count_display: 2,
              last_read: "1710000000.000100"
            }
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      if (method === "conversations.info" && body.get("channel") === "D1") {
        return new Response(
          JSON.stringify({
            ok: true,
            channel: {
              id: "D1",
              is_im: true,
              user: "U999",
              unread_count_display: 0,
              last_read: "1710000000.000200"
            }
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      if (method === "conversations.history") {
        expect(body.get("channel")).toBe("C1");
        expect(body.get("oldest")).toBe("1710000000.000100");
        expect(body.get("inclusive")).toBe("false");
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [{ ts: "1710000001.000100", text: "unread hello" }],
            has_more: false
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`Unexpected Slack method: ${method}`);
    });
    const runner = new SlackToolRunner({ tokenStore, fetch: fetchMock });

    const result = await runner.callTool({
      name: "slack_unread_messages",
      arguments: { max_conversations: 10, messages_per_conversation: 5 }
    });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0]?.text ?? "{}");
    expect(payload.scanned_conversations).toBe(2);
    expect(payload.unread_conversations).toBe(1);
    expect(payload.conversations[0]).toMatchObject({
      id: "C1",
      name: "general",
      unread_count: 2,
      last_read: "1710000000.000100",
      messages: [{ ts: "1710000001.000100", text: "unread hello" }]
    });
    expect(payload.skipped[0]).toMatchObject({
      id: "D1",
      reason: "Slack reported no unread messages"
    });
  });
});
