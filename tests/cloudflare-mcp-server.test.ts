import { describe, expect, test, vi } from "vitest";
import type { D1DatabaseLike } from "../src/cloudflare/d1-token-store.js";
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

type SlackInstallationRow = {
  readonly connection_id: string;
  readonly team_id: string;
  readonly team_name: string | null;
  readonly enterprise_id: string | null;
  readonly user_id: string;
  readonly access_token_ciphertext: string;
  readonly user_refresh_token_ciphertext: string | null;
  readonly user_token_expires_at: string | null;
  readonly bot_access_token_ciphertext: string | null;
  readonly bot_refresh_token_ciphertext: string | null;
  readonly bot_token_expires_at: string | null;
  readonly scope: string;
  readonly bot_scope: string | null;
  readonly token_type: string;
  readonly created_at: string;
  readonly updated_at: string;
};

class SingleInstallationDb implements D1DatabaseLike {
  constructor(private readonly row: SlackInstallationRow) {}

  prepare() {
    const statement = {
      bind: () => statement,
      first: async <T = unknown>() => this.row as T,
      all: async <T = unknown>() => ({ results: [this.row as T] }),
      run: async () => ({})
    };
    return {
      ...statement
    };
  }
}

const tokenEncryptionKey = "0123456789abcdef0123456789abcdef";

async function encryptedSlackToken(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(new TextEncoder().encode(tokenEncryptionKey)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      new TextEncoder().encode(value)
    )
  );
  return JSON.stringify({
    v: 1,
    alg: "A256GCM",
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(ciphertext)
  });
}

async function slackInstallationRow(overrides: Partial<SlackInstallationRow> = {}): Promise<SlackInstallationRow> {
  const now = "2026-05-11T12:00:00.000Z";
  return {
    connection_id: "T123:U123",
    team_id: "T123",
    team_name: "Test Team",
    enterprise_id: null,
    user_id: "U123",
    access_token_ciphertext: await encryptedSlackToken("xoxp-fake"),
    user_refresh_token_ciphertext: null,
    user_token_expires_at: null,
    bot_access_token_ciphertext: null,
    bot_refresh_token_ciphertext: null,
    bot_token_expires_at: null,
    scope: "auth.test,team:read",
    bot_scope: null,
    token_type: "user",
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

async function initializeSession(handler: (request: Request) => Promise<Response>): Promise<string> {
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
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "test", version: "0.1.0" }
        }
      })
    })
  );
  expect(initialized.status).toBe(200);
  const sessionId = initialized.headers.get("mcp-session-id");
  expect(sessionId).toMatch(/^mcp-session-/);
  return sessionId ?? "";
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
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

  test("serves stateful Streamable HTTP sessions with JSON-RPC responses", async () => {
    const sessionKv = new MemoryKvNamespace();
    const handler = createSlackMcpHttpHandler(
      {
        DB: new SingleInstallationDb(await slackInstallationRow({
          scope: "auth.test,api.test,chat:write,team:read"
        })),
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
    const toolNames = new Set((body.result?.tools ?? []).map((tool) => tool.name));
    const apiTestTool = body.result?.tools?.find((tool) => tool.name === "slack_api_test");
    expect(apiTestTool).toBeTruthy();
    expect(apiTestTool?.annotations?.readOnlyHint).toBe(true);
    expect(toolNames.has("slack_chat_post_message")).toBe(true);
    expect(toolNames.has("slack_admin_users_list")).toBe(false);
    expect(toolNames.has("slack_files_remote_add")).toBe(false);

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

  test("returns a JSON-RPC object for tools/call", async () => {
    const sessionKv = new MemoryKvNamespace();
    const handler = createSlackMcpHttpHandler(
      {
        DB: new SingleInstallationDb(await slackInstallationRow()),
        TOKEN_ENCRYPTION_KEY: tokenEncryptionKey,
        SESSION_KV: sessionKv,
        SLACK_MCP_SESSION_TTL_SECONDS: "60"
      },
      { connectionId: "T123:U123" }
    );

    const slackCalls: Array<{ readonly methodUrl: string; readonly authorization: string | null }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      slackCalls.push({
        methodUrl: String(input),
        authorization: headers.get("authorization")
      });
      return new Response(JSON.stringify({
        ok: true,
        team_id: "T123",
        user_id: "U123"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    });

    try {
      const sessionId = await initializeSession(handler);
      const response = await handler(
        new Request("https://slack-mcp.example.com/mcp", {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "mcp-session-id": sessionId,
            "mcp-protocol-version": "2025-11-25"
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/call",
            params: {
              name: "slack_auth_test",
              arguments: {}
            }
          })
        })
      );

      expect(response.status).toBe(200);
      const body = await response.json() as {
        readonly jsonrpc?: string;
        readonly id?: number;
        readonly result?: {
          readonly isError?: boolean;
          readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
        };
      };
      expect(Array.isArray(body)).toBe(false);
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(2);
      expect(body.result?.isError).toBeUndefined();
      expect(body.result?.content?.[0]?.text).toContain('"team_id": "T123"');
      expect(slackCalls).toEqual([
        {
          methodUrl: "https://slack.com/api/auth.test",
          authorization: "Bearer xoxp-fake"
        }
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
