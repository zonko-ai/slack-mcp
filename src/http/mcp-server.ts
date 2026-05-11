import { randomUUID } from "node:crypto";
import type { SlackTool } from "../slack/tool-catalog.js";
import type { ToolCallResult } from "../slack/tool-runner.js";

type JsonRpcRequest = {
  readonly jsonrpc?: string;
  readonly id?: string | number | null;
  readonly method?: string;
  readonly params?: unknown;
};

type McpHandlerOptions = {
  readonly allowedOrigins: readonly string[];
  readonly apiKey: string;
  readonly tools: readonly SlackTool[];
  readonly callTool: (call: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
    readonly connectionId?: string | null | undefined;
  }) => Promise<ToolCallResult>;
  readonly sessionTtlSeconds?: number | undefined;
  readonly now?: (() => number) | undefined;
};

export function createMcpHandler(options: McpHandlerOptions): (request: Request) => Promise<Response> {
  const sessions = new Map<string, { expiresAt: number }>();
  const sessionTtlMs = normalizeSessionTtlSeconds(options.sessionTtlSeconds ?? 3600) * 1000;
  const now = options.now ?? (() => Date.now());

  function validateSession(sessionId: string | null, id: string | number | null): Response | null {
    if (!sessionId) {
      return jsonResponse(400, jsonRpcError(id, -32000, "Missing MCP session id"));
    }

    const session = sessions.get(sessionId);
    if (!session || session.expiresAt <= now()) {
      sessions.delete(sessionId);
      return jsonResponse(404, jsonRpcError(id, -32001, "Session not found"));
    }

    session.expiresAt = now() + sessionTtlMs;
    return null;
  }

  return async function handleMcp(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp") {
      return textResponse(404, "Not found");
    }

    const origin = request.headers.get("origin");
    if (origin && !options.allowedOrigins.includes(origin)) {
      return textResponse(403, "Forbidden origin");
    }

    const expected = `Bearer ${options.apiKey}`;
    if (request.headers.get("authorization") !== expected) {
      return textResponse(401, "Unauthorized");
    }

    if (request.method === "GET") {
      return textResponse(405, "Method not allowed");
    }

    if (request.method === "DELETE") {
      const sessionId = request.headers.get("mcp-session-id");
      const sessionError = validateSession(sessionId, null);
      if (sessionError) {
        return sessionError;
      }
      sessions.delete(sessionId ?? "");
      return new Response(null, { status: 204 });
    }

    if (request.method !== "POST") {
      return textResponse(405, "Method not allowed");
    }

    let payload: JsonRpcRequest;
    try {
      payload = (await request.json()) as JsonRpcRequest;
    } catch {
      return jsonResponse(400, jsonRpcError(null, -32700, "Parse error"));
    }

    if (payload.method === "initialize") {
      if (request.headers.get("mcp-session-id")) {
        return jsonResponse(400, jsonRpcError(payload.id ?? null, -32600, "Initialization requests must not include an MCP session id"));
      }
      const sessionId = `mcp-session-${randomUUID()}`;
      sessions.set(sessionId, { expiresAt: now() + sessionTtlMs });
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            protocolVersion: "2025-03-26",
            capabilities: {
              logging: {},
              tools: { listChanged: true }
            },
            serverInfo: {
              name: "Slack MCP",
              version: "0.1.0"
            }
          }
        },
        { "Mcp-Session-Id": sessionId }
      );
    }

    const sessionError = validateSession(request.headers.get("mcp-session-id"), payload.id ?? null);
    if (sessionError) {
      return sessionError;
    }

    if (payload.method === "notifications/initialized") {
      return new Response(null, { status: 202 });
    }

    if (payload.method === "tools/list") {
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: payload.id ?? null,
        result: {
          tools: options.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations
          }))
        }
      });
    }

    if (payload.method === "tools/call") {
      const params = parseToolCallParams(payload.params);
      if (!params) {
        return jsonResponse(400, jsonRpcError(payload.id ?? null, -32602, "Invalid tool call parameters"));
      }
      const result = await options.callTool({
        ...params,
        connectionId: request.headers.get("x-slack-connection-id") ?? new URL(request.url).searchParams.get("connection_id")
      });
      return jsonResponse(200, {
        jsonrpc: "2.0",
        id: payload.id ?? null,
        result
      });
    }

    return jsonResponse(404, jsonRpcError(payload.id ?? null, -32601, "Method not found"));
  };
}

function normalizeSessionTtlSeconds(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 3600;
}

function parseToolCallParams(params: unknown): { readonly name: string; readonly arguments: Record<string, unknown> } | null {
  if (typeof params !== "object" || params === null) {
    return null;
  }
  const value = params as { readonly name?: unknown; readonly arguments?: unknown };
  if (typeof value.name !== "string") {
    return null;
  }
  return {
    name: value.name,
    arguments: typeof value.arguments === "object" && value.arguments !== null
      ? (value.arguments as Record<string, unknown>)
      : {}
  };
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message }
  };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}
