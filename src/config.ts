import { join } from "node:path";
import { botScopesFromEnv, splitCsv, userScopesFromEnv } from "./slack/scopes.js";

export type AppConfig = {
  readonly host: string;
  readonly port: number;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly apiKey: string | null;
  readonly allowedOrigins: readonly string[];
  readonly tokenStorePath: string;
  readonly scopes: readonly string[];
  readonly botScopes: readonly string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const port = Number(env.SLACK_MCP_PORT ?? 13182);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("SLACK_MCP_PORT must be a positive integer");
  }

  return {
    host: env.SLACK_MCP_HOST ?? "127.0.0.1",
    port,
    clientId: env.SLACK_CLIENT_ID ?? "",
    clientSecret: env.SLACK_CLIENT_SECRET ?? "",
    redirectUri: env.SLACK_REDIRECT_URI ?? `http://127.0.0.1:${port}/oauth/callback`,
    apiKey: env.SLACK_MCP_API_KEY?.trim() ? env.SLACK_MCP_API_KEY : null,
    allowedOrigins: splitCsv(env.SLACK_MCP_ALLOWED_ORIGINS),
    tokenStorePath: env.SLACK_MCP_TOKEN_STORE ?? join(process.cwd(), ".local", "slack-tokens.json"),
    scopes: userScopesFromEnv(env.SLACK_OAUTH_SCOPES),
    botScopes: botScopesFromEnv(env.SLACK_OAUTH_BOT_SCOPES)
  };
}
