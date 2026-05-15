import { D1TokenStore, type D1DatabaseLike } from "./d1-token-store.js";
import {
  McpSessionStore,
  newMcpSessionId,
  normalizeSessionTtlSeconds,
  type McpSessionKvNamespace
} from "./mcp-session-store.js";
import {
  filterSlackToolsForInstallation,
  slackTools,
  type SlackTool
} from "../slack/tool-catalog.js";
import { SlackToolRunner, type ToolCallResult } from "../slack/tool-runner.js";
import type { SlackTokenRotationConfig } from "../slack/token-rotation.js";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
};

type JsonRpcResponse = {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
  };
};

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

    if (request.method === "DELETE") {
      const session = await requireSession(request, sessionStore, connectionId, null);
      if (session instanceof Response) return session;
      await sessionStore.delete(session.id);
      return new Response(null, {
        status: 204,
        headers: { "mcp-session-id": session.id }
      });
    }

    if (request.method !== "POST") {
      return jsonRpcErrorResponse(405, null, -32000, "Method not allowed");
    }

    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return jsonRpcErrorResponse(415, null, -32000, "Content-Type must be application/json");
    }

    const accept = request.headers.get("accept") ?? "";
    if (accept && !accept.includes("application/json") && !accept.includes("text/event-stream") && !accept.includes("*/*")) {
      return jsonRpcErrorResponse(406, null, -32000, "Client must accept application/json or text/event-stream");
    }

    const parsedBody = await parseMcpPostBody(request);
    if (!parsedBody.ok) {
      return jsonRpcErrorResponse(400, null, -32700, "Parse error");
    }

    const messages = Array.isArray(parsedBody.value) ? parsedBody.value : [parsedBody.value];
    if (messages.length === 0) {
      return jsonRpcErrorResponse(400, null, -32600, "Invalid Request");
    }

    const hasInitializeRequest = messages.some((message) => isMcpMethod(message, "initialize"));
    if (hasInitializeRequest && messages.length > 1) {
      return jsonRpcErrorResponse(400, null, -32600, "Only one initialization request is allowed");
    }
    if (hasInitializeRequest && request.headers.get("mcp-session-id")) {
      return jsonRpcErrorResponse(400, jsonRpcId(messages[0]), -32600, "Initialization requests must not include an MCP session id");
    }

    let sessionId: string | undefined;
    if (hasInitializeRequest) {
      sessionId = newMcpSessionId();
      await sessionStore.create({ sessionId, connectionId });
    } else {
      const session = await requireSession(request, sessionStore, connectionId, jsonRpcId(messages[0]));
      if (session instanceof Response) return session;
      sessionId = session.id;
    }

    const responses: JsonRpcResponse[] = [];
    for (const message of messages) {
      const response = await handleJsonRpcMessage({
        env,
        context,
        message,
        connectionId
      });
      if (response) responses.push(response);
    }

    if (responses.length === 0) {
      return new Response(null, {
        status: 202,
        ...(sessionId ? { headers: { "mcp-session-id": sessionId } } : {})
      });
    }

    return new Response(JSON.stringify(responses.length === 1 ? responses[0] : responses), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...(sessionId ? { "mcp-session-id": sessionId } : {})
      }
    });
  };
}

async function handleJsonRpcMessage(input: {
  readonly env: SlackMcpRuntimeEnv;
  readonly context: SlackMcpRequestContext;
  readonly message: unknown;
  readonly connectionId: string;
}): Promise<JsonRpcResponse | null> {
  if (!isJsonRpcRequest(input.message)) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }

  const id = jsonRpcId(input.message);
  if (input.message.id === undefined) {
    return null;
  }

  switch (input.message.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: requestedProtocolVersion(input.message.params) ?? "2025-11-25",
          capabilities: {
            tools: { listChanged: true }
          },
          serverInfo: {
            name: "Slack MCP",
            version: "0.1.0"
          }
        }
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      const visibleTools = await visibleSlackTools(input.env, input.connectionId);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: visibleTools.map((tool) => mcpToolDefinition(tool))
        }
      };
    case "tools/call":
      return {
        jsonrpc: "2.0",
        id,
        result: await callSlackTool(input.env, input.context, input.connectionId, input.message.params)
      };
    default:
      return jsonRpcError(id, -32601, `Method not found: ${String(input.message.method)}`);
  }
}

async function visibleSlackTools(env: SlackMcpRuntimeEnv, connectionId: string): Promise<readonly SlackTool[]> {
  const tokenStore = new D1TokenStore({
    db: env.DB,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY
  });
  const installation = await tokenStore.get(connectionId);
  return installation ? filterSlackToolsForInstallation(slackTools, installation) : [];
}

function mcpToolDefinition(tool: SlackTool) {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
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
  };
}

async function callSlackTool(
  env: SlackMcpRuntimeEnv,
  context: SlackMcpRequestContext,
  connectionId: string,
  params: unknown
): Promise<ReturnType<typeof mcpToolResult>> {
  const parsed = parseToolCallParams(params);
  if (!parsed) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: "Invalid tool call parameters."
        }
      ]
    };
  }

  const tool = slackTools.find((candidate) => candidate.name === parsed.name);
  if (!tool) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `Unknown Slack tool: ${parsed.name}`
        }
      ]
    };
  }

  return executeSlackTool(env, context, connectionId, tool, parsed.arguments);
}

async function executeSlackTool(
  env: SlackMcpRuntimeEnv,
  context: SlackMcpRequestContext,
  connectionId: string,
  tool: SlackTool,
  argumentsObject: Record<string, unknown>
): Promise<ReturnType<typeof mcpToolResult>> {
  const attachedConnectionId = context.connectionId?.trim() || connectionId;
  if (!attachedConnectionId) {
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
    arguments: argumentsObject,
    connectionId: attachedConnectionId
  });
  return mcpToolResult(result);
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

async function requireSession(
  request: Request,
  sessionStore: McpSessionStore,
  connectionId: string,
  id: JsonRpcId
) {
  const requestSessionId = request.headers.get("mcp-session-id");
  if (!requestSessionId) {
    return jsonRpcErrorResponse(400, id, -32000, "Missing MCP session id");
  }

  const session = await sessionStore.get(requestSessionId);
  if (!session || session.connectionId !== connectionId) {
    return jsonRpcErrorResponse(404, id, -32001, "Session not found");
  }

  return sessionStore.touch(session);
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

function jsonRpcId(value: unknown): string | number | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const id = (value as { readonly id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : null;
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as JsonRpcRequest).jsonrpc === "2.0" &&
    typeof (value as JsonRpcRequest).method === "string"
  );
}

function isMcpMethod(value: unknown, method: string): boolean {
  return isJsonRpcRequest(value) && value.method === method;
}

function requestedProtocolVersion(params: unknown): string | undefined {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return undefined;
  }
  const version = (params as { readonly protocolVersion?: unknown }).protocolVersion;
  return typeof version === "string" && version.trim().length > 0 ? version : undefined;
}

function parseToolCallParams(params: unknown): { readonly name: string; readonly arguments: Record<string, unknown> } | null {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return null;
  }
  const value = params as { readonly name?: unknown; readonly arguments?: unknown };
  if (typeof value.name !== "string") {
    return null;
  }
  return {
    name: value.name,
    arguments: typeof value.arguments === "object" && value.arguments !== null && !Array.isArray(value.arguments)
      ? value.arguments as Record<string, unknown>
      : {}
  };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message }
  };
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
