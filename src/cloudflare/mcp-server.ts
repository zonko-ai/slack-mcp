import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStreamableHTTPServerTransport } from "fastmcp/edge";
import { D1TokenStore, type D1DatabaseLike } from "./d1-token-store.js";
import { jsonSchemaToZodObject } from "./mcp-adapter.js";
import {
  McpSessionStore,
  newMcpSessionId,
  normalizeSessionTtlSeconds,
  type McpSessionKvNamespace
} from "./mcp-session-store.js";
import { slackTools, type SlackTool } from "../slack/tool-catalog.js";
import { SlackToolRunner, type ToolCallResult } from "../slack/tool-runner.js";
import type { SlackTokenRotationConfig } from "../slack/token-rotation.js";

export type SlackMcpRuntimeEnv = {
  readonly DB: D1DatabaseLike;
  readonly TOKEN_ENCRYPTION_KEY: string;
  readonly SLACK_CLIENT_ID?: string | undefined;
  readonly SLACK_CLIENT_SECRET?: string | undefined;
  readonly SLACK_TOKEN_REFRESH_WINDOW_SECONDS?: string | undefined;
  readonly SLACK_MCP_SESSION_TTL_SECONDS?: string | undefined;
  readonly SESSION_KV: McpSessionKvNamespace;
};

export type SlackMcpRequestContext = {
  readonly connectionId?: string | null | undefined;
  readonly now?: (() => Date) | undefined;
};

export function createSlackMcpHttpHandler(
  env: SlackMcpRuntimeEnv,
  context: SlackMcpRequestContext = {}
): (request: Request) => Promise<Response> {
  return async function handleSlackMcpRequest(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") {
      return new Response("Not found", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    const connectionId = context.connectionId?.trim() || null;
    if (!connectionId) {
      return jsonRpcErrorResponse(401, null, -32000, "No Slack OAuth installation is attached to this MCP authorization.");
    }

    if (request.method === "GET") {
      return jsonRpcErrorResponse(405, null, -32000, "Method not allowed");
    }

    const sessionStore = new McpSessionStore({
      kv: env.SESSION_KV,
      ttlSeconds: mcpSessionTtlSeconds(env),
      ...(context.now ? { now: context.now } : {})
    });
    const parsedBody = request.method === "POST" ? await parseMcpPostBody(request) : { ok: false as const };
    const hasInitializeRequest = parsedBody.ok ? containsInitializeRequest(parsedBody.value) : false;
    const requestSessionId = request.headers.get("mcp-session-id");
    const generatedSessionId = newMcpSessionId();

    const server = createSlackMcpServer(env, context);
    const transport = new WebStreamableHTTPServerTransport({
      enableJsonResponse: true,
      sessionIdGenerator: () => generatedSessionId,
      onsessioninitialized: async (sessionId) => {
        await sessionStore.create({ sessionId, connectionId });
      },
      onsessionclosed: (sessionId) => sessionStore.delete(sessionId)
    });

    if (!hasInitializeRequest && requestSessionId && (request.method !== "POST" || parsedBody.ok)) {
      const session = await sessionStore.get(requestSessionId);
      if (!session || session.connectionId !== connectionId) {
        return jsonRpcErrorResponse(404, parsedBody.ok ? jsonRpcId(parsedBody.value) : null, -32001, "Session not found");
      }
      const touched = await sessionStore.touch(session);
      transport.sessionId = touched.id;
    }

    await server.connect(transport);
    return transport.handleRequest(request, parsedBody.ok ? parsedBody.value : undefined);
  };
}

export function createSlackMcpServer(env: SlackMcpRuntimeEnv, context: SlackMcpRequestContext = {}): McpServer {
  const server = new McpServer({
    name: "Slack MCP",
    version: "0.1.0"
  });

  for (const tool of slackTools) {
    registerSlackTool(server, env, context, tool);
  }

  return server;
}

function registerSlackTool(
  server: McpServer,
  env: SlackMcpRuntimeEnv,
  context: SlackMcpRequestContext,
  tool: SlackTool
): void {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: jsonSchemaToZodObject(tool.inputSchema),
      annotations: {
        readOnlyHint: tool.annotations.readOnlyHint,
        ...(tool.annotations.destructiveHint === undefined
          ? {}
          : { destructiveHint: tool.annotations.destructiveHint }),
        openWorldHint: true
      },
      _meta: {
        "slack/scopes": tool.annotations.scopes,
        "slack/token": tool.annotations.token,
        ...(tool.annotations.requiresEnterprise === undefined
          ? {}
          : { "slack/requiresEnterprise": tool.annotations.requiresEnterprise })
      }
    },
    async (argumentsObject) => {
      const connectionId = context.connectionId?.trim() || null;
      if (!connectionId) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: "No Slack OAuth installation is attached to this MCP authorization."
            }
          ]
        };
      }

      const tokenStore = new D1TokenStore({
        db: env.DB,
        encryptionKey: env.TOKEN_ENCRYPTION_KEY
      });
      const tokenRotation = slackTokenRotationConfig(env);
      const runner = new SlackToolRunner({
        tokenStore,
        ...(tokenRotation === undefined ? {} : { tokenRotation })
      });
      const result = await runner.callTool({
        name: tool.name,
        arguments: argumentsObject as Record<string, unknown>,
        connectionId
      });
      return mcpToolResult(result);
    }
  );
}

function mcpToolResult(result: ToolCallResult) {
  return {
    ...(result.isError === undefined ? {} : { isError: result.isError }),
    content: result.content.map((item) => ({
      type: item.type,
      text: item.text
    }))
  };
}

function slackTokenRotationConfig(env: SlackMcpRuntimeEnv): SlackTokenRotationConfig | undefined {
  const clientId = env.SLACK_CLIENT_ID?.trim();
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return undefined;
  }

  const refreshWindowSeconds = Number(env.SLACK_TOKEN_REFRESH_WINDOW_SECONDS ?? 300);
  return {
    clientId,
    clientSecret,
    refreshWindowSeconds: Number.isFinite(refreshWindowSeconds) && refreshWindowSeconds > 0
      ? refreshWindowSeconds
      : 300
  };
}

function mcpSessionTtlSeconds(env: SlackMcpRuntimeEnv): number {
  return normalizeSessionTtlSeconds(Number(env.SLACK_MCP_SESSION_TTL_SECONDS ?? 3600));
}

async function parseMcpPostBody(request: Request): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  try {
    return { ok: true, value: await request.clone().json() };
  } catch {
    return { ok: false };
  }
}

function containsInitializeRequest(value: unknown): boolean {
  const messages = Array.isArray(value) ? value : [value];
  return messages.some((message) => {
    if (typeof message !== "object" || message === null) {
      return false;
    }
    return (message as { readonly method?: unknown }).method === "initialize";
  });
}

function jsonRpcId(value: unknown): string | number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const id = (value as { readonly id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function jsonRpcErrorResponse(status: number, id: string | number | null, code: number, message: string): Response {
  return new Response(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message }
  }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}
