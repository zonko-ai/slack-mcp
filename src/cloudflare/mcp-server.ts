import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp";
import { D1TokenStore, type D1DatabaseLike } from "./d1-token-store.js";
import { jsonSchemaToZodObject, readSlackMcpConnectionId } from "./mcp-adapter.js";
import { slackTools, type SlackTool } from "../slack/tool-catalog.js";
import { SlackToolRunner, type ToolCallResult } from "../slack/tool-runner.js";

export type SlackMcpRuntimeEnv = {
  readonly DB: D1DatabaseLike;
  readonly TOKEN_ENCRYPTION_KEY: string;
};

export function createSlackMcpHttpHandler(env: SlackMcpRuntimeEnv) {
  const server = createSlackMcpServer(env);
  return createMcpHandler(server, {
    route: "/mcp",
    enableJsonResponse: true
  });
}

export function createSlackMcpServer(env: SlackMcpRuntimeEnv): McpServer {
  const server = new McpServer({
    name: "Harbor Slack MCP",
    version: "0.1.0"
  });

  for (const tool of slackTools) {
    registerSlackTool(server, env, tool);
  }

  return server;
}

function registerSlackTool(server: McpServer, env: SlackMcpRuntimeEnv, tool: SlackTool): void {
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
      const connectionId = readSlackMcpConnectionId(getMcpAuthContext()?.props);
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
      const runner = new SlackToolRunner({ tokenStore });
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
