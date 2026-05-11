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
});
