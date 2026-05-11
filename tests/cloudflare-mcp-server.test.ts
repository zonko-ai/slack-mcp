import { describe, expect, test } from "vitest";
import { jsonSchemaToZodObject, readSlackMcpConnectionId } from "../src/cloudflare/mcp-adapter.js";
import { createSlackMcpHttpHandler } from "../src/cloudflare/mcp-server.js";

class MemoryKvNamespace {
  readonly entries = new Map<string, string>();
  readonly expirations = new Map<string, number>();

  async put(key: string, value: string, options?: { readonly expirationTtl?: number }) {
    this.entries.set(key, value);
    if (options?.expirationTtl !== undefined) {
      this.expirations.set(key, options.expirationTtl);
    }
  }

  async get(key: string) {
    return this.entries.get(key) ?? null;
  }

  async delete(key: string) {
    this.entries.delete(key);
    this.expirations.delete(key);
  }
}

describe("Cloudflare MCP server adapter", () => {
  test("reads the Slack connection id from OAuth provider props", () => {
    expect(readSlackMcpConnectionId({ connectionId: "T123:U123" })).toBe("T123:U123");
    expect(readSlackMcpConnectionId({ connectionId: "" })).toBeNull();
    expect(readSlackMcpConnectionId(undefined)).toBeNull();
  });

  test("converts Slack JSON schemas to Zod objects while preserving additional Slack parameters", () => {
    const schema = jsonSchemaToZodObject({
      type: "object",
      properties: {
        channel: { type: "string" },
        limit: { type: "number" },
        inclusive: { type: "boolean" }
      },
      required: ["channel"],
      additionalProperties: true
    });

    expect(
      schema.parse({
        channel: "C123",
        limit: 10,
        inclusive: false,
        include_locale: true
      })
    ).toEqual({
      channel: "C123",
      limit: 10,
      inclusive: false,
      include_locale: true
    });
    expect(() => schema.parse({ limit: 10 })).toThrow();
  });

  test("serves stateful Streamable HTTP sessions through the FastMCP edge transport", async () => {
    const sessionKv = new MemoryKvNamespace();
    const handler = createSlackMcpHttpHandler(
      {
        DB: {
          prepare() {
            throw new Error("D1 should not be touched for tools/list");
          }
        },
        TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
        SESSION_KV: sessionKv,
        SLACK_MCP_SESSION_TTL_SECONDS: "60"
      },
      { connectionId: "T123:U123" }
    );

    const initialized = await handler(
      new Request("https://slack-mcp.example.com/mcp", {
        method: "POST",
        headers: {
          accept: "application/json",
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
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toMatch(/^mcp-session-/);
    expect(sessionKv.expirations.get(`mcp-session:${sessionId}`)).toBe(60);

    const response = await handler(
      new Request("https://slack-mcp.example.com/mcp", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "mcp-session-id": sessionId ?? "",
          "mcp-protocol-version": "2025-03-26"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list"
        })
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      readonly result?: {
        readonly tools?: ReadonlyArray<{
          readonly name: string;
          readonly annotations?: Record<string, unknown>;
        }>;
      };
    };
    const apiTestTool = body.result?.tools?.find((tool) => tool.name === "slack_api_test");
    expect(apiTestTool).toBeTruthy();
    expect(apiTestTool?.annotations?.readOnlyHint).toBe(true);

    const standaloneSse = await handler(
      new Request("https://slack-mcp.example.com/mcp", {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-session-id": sessionId ?? ""
        }
      })
    );
    expect(standaloneSse.status).toBe(405);

    const deleted = await handler(
      new Request("https://slack-mcp.example.com/mcp", {
        method: "DELETE",
        headers: {
          "mcp-session-id": sessionId ?? "",
          "mcp-protocol-version": "2025-03-26"
        }
      })
    );
    expect(deleted.status).toBe(204);

    const afterDelete = await handler(
      new Request("https://slack-mcp.example.com/mcp", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "mcp-session-id": sessionId ?? "",
          "mcp-protocol-version": "2025-03-26"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list"
        })
      })
    );
    expect(afterDelete.status).toBe(404);
  });

  test("expires Cloudflare MCP sessions after the configured idle TTL", async () => {
    let now = Date.parse("2026-05-11T12:00:00.000Z");
    const sessionKv = new MemoryKvNamespace();
    const handler = createSlackMcpHttpHandler(
      {
        DB: {
          prepare() {
            throw new Error("D1 should not be touched for tools/list");
          }
        },
        TOKEN_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
        SESSION_KV: sessionKv,
        SLACK_MCP_SESSION_TTL_SECONDS: "1"
      },
      {
        connectionId: "T123:U123",
        now: () => new Date(now)
      }
    );

    const initialized = await handler(
      new Request("https://slack-mcp.example.com/mcp", {
        method: "POST",
        headers: {
          accept: "application/json",
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
    const sessionId = initialized.headers.get("mcp-session-id");
    expect(sessionId).toMatch(/^mcp-session-/);

    now += 1_001;
    const expired = await handler(
      new Request("https://slack-mcp.example.com/mcp", {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "mcp-session-id": sessionId ?? "",
          "mcp-protocol-version": "2025-03-26"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list"
        })
      })
    );

    expect(expired.status).toBe(404);
  });
});
