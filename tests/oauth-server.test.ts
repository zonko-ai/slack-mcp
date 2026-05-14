import { describe, expect, test, vi } from "vitest";
import { createOAuthHandler } from "../src/http/oauth-server.js";

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://127.0.0.1:13182${path}`, init);
}

describe("OAuth HTTP handler", () => {
  test("accepts local setup credentials without exposing the client secret in responses", async () => {
    const save = vi.fn();
    const handler = createOAuthHandler({
      clientId: "",
      clientSecret: "",
      redirectUri: "https://example.com/oauth/callback",
      scopes: ["channels:read"],
      botScopes: [],
      tokenStore: { save }
    });

    const setup = await handler(
      request("/oauth/setup", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: "111.222",
          client_secret: "super-secret",
          redirect_uri: "https://example.com/oauth/callback"
        })
      })
    );

    expect(setup.status).toBe(200);
    const html = await setup.text();
    expect(html).toContain("OAuth credentials configured");
    expect(html).toContain("111.222");
    expect(html).not.toContain("super-secret");

    const start = await handler(request("/oauth/start"));
    const location = new URL(start.headers.get("location") ?? "");
    expect(location.searchParams.get("client_id")).toBe("111.222");
  });

  test("redirects to Slack with user scopes and stores returned OAuth installations", async () => {
    const save = vi.fn(async (installation) => ({
      ...installation,
      connectionId: `${installation.teamId}:${installation.userId}`
    }));
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          access_token: "xoxb-bot",
          refresh_token: "xoxe-bot-refresh",
          expires_in: 43200,
          authed_user: { id: "U123", access_token: "xoxp-user", scope: "channels:read,chat:write" },
          team: { id: "T123", name: "Example" },
          enterprise: null,
          scope: "commands"
        }),
        { headers: { "content-type": "application/json" } }
      )
    );
    const handler = createOAuthHandler({
      clientId: "111.222",
      clientSecret: "secret",
      redirectUri: "https://example.com/oauth/callback",
      scopes: ["channels:read", "chat:write"],
      botScopes: ["remote_files:read"],
      tokenStore: { save },
      fetch: fetchMock
    });

    const start = await handler(request("/oauth/start?team=T123"));
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(location.searchParams.get("client_id")).toBe("111.222");
    expect(location.searchParams.get("redirect_uri")).toBe("https://example.com/oauth/callback");
    expect(location.searchParams.get("user_scope")).toBe("channels:read,chat:write");
    expect(location.searchParams.get("scope")).toBe("remote_files:read");
    expect(location.searchParams.get("team")).toBe("T123");
    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();

    const callback = await handler(request(`/oauth/callback?code=abc&state=${state}`));
    expect(callback.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa("111.222:secret")}`
      },
      body: expect.any(URLSearchParams)
    });
    const tokenCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const tokenBody = tokenCall[1].body;
    expect(tokenBody).toBeInstanceOf(URLSearchParams);
    expect((tokenBody as URLSearchParams).get("client_id")).toBeNull();
    expect((tokenBody as URLSearchParams).get("client_secret")).toBeNull();
    expect((tokenBody as URLSearchParams).get("code")).toBe("abc");
    expect(save).toHaveBeenCalledWith({
      teamId: "T123",
      teamName: "Example",
      enterpriseId: null,
      userId: "U123",
      accessToken: "xoxp-user",
      botAccessToken: "xoxb-bot",
      botRefreshToken: "xoxe-bot-refresh",
      botTokenExpiresAt: expect.any(String),
      scope: "channels:read,chat:write",
      botScope: "commands",
      tokenType: "user"
    });
  });
});
