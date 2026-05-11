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
});
