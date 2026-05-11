import { describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  test("uses explicit OAuth scopes when SLACK_OAUTH_SCOPES is set", () => {
    const config = loadConfig({
      SLACK_MCP_PORT: "13182",
      SLACK_MCP_API_KEY: "local-secret",
      SLACK_MCP_SESSION_TTL_SECONDS: "900",
      SLACK_OAUTH_SCOPES: "channels:read, chat:write,users:read",
      SLACK_OAUTH_BOT_SCOPES: "remote_files:read,remote_files:write",
      SLACK_TOKEN_REFRESH_WINDOW_SECONDS: "120"
    });

    expect(config.scopes).toEqual(["channels:read", "chat:write", "users:read"]);
    expect(config.botScopes).toEqual(["remote_files:read", "remote_files:write"]);
    expect(config.tokenRefreshWindowSeconds).toBe(120);
    expect(config.apiKey).toBe("local-secret");
    expect(config.sessionTtlSeconds).toBe(900);
  });

  test("does not request Enterprise admin scopes by default", () => {
    const config = loadConfig({ SLACK_MCP_PORT: "13182", SLACK_MCP_API_KEY: "local-secret" });

    expect(config.scopes.some((scope) => scope.startsWith("admin."))).toBe(false);
    expect(config.scopes.some((scope) => scope.startsWith("remote_files:"))).toBe(false);
    expect(config.botScopes).toEqual(["remote_files:read", "remote_files:share", "remote_files:write"]);
  });

  test("requires a local API key when running the Node MCP server", () => {
    expect(() => loadConfig({ SLACK_MCP_PORT: "13182" })).toThrow("SLACK_MCP_API_KEY is required");
  });
});
