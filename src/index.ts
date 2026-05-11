import { createServer } from "node:http";
import { createMcpHandler } from "./http/mcp-server.js";
import { createOAuthHandler } from "./http/oauth-server.js";
import { loadConfig } from "./config.js";
import { FileTokenStore } from "./slack/token-store.js";
import { slackTools } from "./slack/tool-catalog.js";
import { SlackToolRunner } from "./slack/tool-runner.js";

const config = loadConfig();
const tokenStore = new FileTokenStore(config.tokenStorePath);
const runner = new SlackToolRunner({ tokenStore });

const mcpHandler = createMcpHandler({
  allowedOrigins: config.allowedOrigins,
  apiKey: config.apiKey,
  tools: slackTools,
  callTool: (call) => runner.callTool(call)
});

const oauthHandler = createOAuthHandler({
  clientId: config.clientId,
  clientSecret: config.clientSecret,
  redirectUri: config.redirectUri,
  scopes: config.scopes,
  botScopes: config.botScopes,
  tokenStore
});

const server = createServer(async (incoming, outgoing) => {
  try {
    const request = await toRequest(incoming);
    const url = new URL(request.url);
    const response = url.pathname.startsWith("/oauth/")
      ? await oauthHandler(request)
      : await mcpHandler(request);
    await writeResponse(outgoing, response);
  } catch (error) {
    outgoing.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    outgoing.end(error instanceof Error ? error.message : "Internal server error");
  }
});

server.listen(config.port, config.host, () => {
  console.log(`Slack MCP listening on http://${config.host}:${config.port}`);
  console.log(`OAuth start: http://${config.host}:${config.port}/oauth/start`);
});

async function toRequest(incoming: import("node:http").IncomingMessage): Promise<Request> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of incoming) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const protocol = "http";
  const host = incoming.headers.host ?? "127.0.0.1";
  const url = `${protocol}://${host}${incoming.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) {
      headers.set(key, value.join(", "));
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const method = incoming.method ?? "GET";
  const init: RequestInit = {
    method,
    headers
  };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Buffer.concat(chunks);
  }
  return new Request(url, init);
}

async function writeResponse(outgoing: import("node:http").ServerResponse, response: Response): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const read = await reader.read();
    if (read.done) {
      outgoing.end();
      return;
    }
    outgoing.write(Buffer.from(read.value));
  }
}
