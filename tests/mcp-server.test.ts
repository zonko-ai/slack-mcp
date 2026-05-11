import { describe, expect, test, vi } from "vitest";
import { createMcpHandler } from "../src/http/mcp-server.js";
import { slackTools } from "../src/slack/tool-catalog.js";

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://127.0.0.1:13182${path}`, init);
}

describe("MCP HTTP handler", () => {
  test("rejects untrusted browser origins before JSON-RPC handling", async () => {
    const handler = createMcpHandler({
      allowedOrigins: ["http://127.0.0.1:13182"],
      apiKey: "test-key",
      tools: slackTools,
      callTool: vi.fn()
    });

    const response = await handler(
      request("/mcp", {
        method: "POST",
        headers: {
          origin: "http://evil.example",
          accept: "application/json, text/event-stream",
          "content-type": "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      })
    );

    expect(response.status).toBe(403);
  });

  test("implements initialize, session enforcement, tools/list, and tools/call", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "ok" }]
    }));
    const handler = createMcpHandler({
      allowedOrigins: [],
      apiKey: "test-key",
      tools: slackTools,
      callTool,
      sessionTtlSeconds: 60
    });

    const unauthorized = await handler(
      request("/mcp", {
        method: "POST",
        headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      })
    );
    expect(unauthorized.status).toBe(401);

    const initialized = await handler(
      request("/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          accept: "application/json, text/event-stream",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "0.1.0" }
          }
        })
      })
    );
    expect(initialized.status).toBe(200);
    const sessionId = initialized.headers.get("Mcp-Session-Id");
    expect(sessionId).toMatch(/^mcp-session-/);
    await expect(initialized.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: true } }
      }
    });

    const reinitializeWithSession = await handler(
      request("/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId ?? ""
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: {} })
      })
    );
    expect(reinitializeWithSession.status).toBe(400);

    const missingSession = await handler(
      request("/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          accept: "application/json, text/event-stream",
          "content-type": "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      })
    );
    expect(missingSession.status).toBe(400);

    const list = await handler(
      request("/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId ?? ""
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
      })
    );
    const listed = await list.json();
    expect(listed.result.tools.length).toBe(slackTools.length);

    const standaloneSse = await handler(
      request("/mcp", {
        method: "GET",
        headers: {
          authorization: "Bearer test-key",
          accept: "text/event-stream",
          "mcp-session-id": sessionId ?? ""
        }
      })
    );
    expect(standaloneSse.status).toBe(405);

    const called = await handler(
      request("/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId ?? "",
          "x-slack-connection-id": "T123:U123"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "slack_auth_test", arguments: {} }
        })
      })
    );

    await expect(called.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 4,
      result: { content: [{ type: "text", text: "ok" }] }
    });
    expect(callTool).toHaveBeenCalledWith({
      name: "slack_auth_test",
      arguments: {},
      connectionId: "T123:U123"
    });

    const deleted = await handler(
      request("/mcp", {
        method: "DELETE",
        headers: {
          authorization: "Bearer test-key",
          "mcp-session-id": sessionId ?? "",
          "mcp-protocol-version": "2025-03-26"
        }
      })
    );
    expect(deleted.status).toBe(204);

    const afterDelete = await handler(
      request("/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId ?? "",
          "mcp-protocol-version": "2025-03-26"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} })
      })
    );
    expect(afterDelete.status).toBe(404);
  });

  test("expires inactive MCP sessions after the configured idle TTL", async () => {
    let now = 1_000;
    const handler = createMcpHandler({
      allowedOrigins: [],
      apiKey: "test-key",
      tools: slackTools,
      callTool: vi.fn(),
      sessionTtlSeconds: 1,
      now: () => now
    });

    const initialized = await handler(
      request("/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          accept: "application/json, text/event-stream",
          "content-type": "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
      })
    );
    const sessionId = initialized.headers.get("Mcp-Session-Id");
    expect(sessionId).toMatch(/^mcp-session-/);

    now += 1_001;
    const expired = await handler(
      request("/mcp", {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-session-id": sessionId ?? "",
          "mcp-protocol-version": "2025-03-26"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      })
    );

    expect(expired.status).toBe(404);
  });
});
