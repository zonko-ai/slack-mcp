import { OAuthProvider, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { ExecutionContext } from "@cloudflare/workers-types";
import { createSlackMcpHttpHandler, type SlackMcpRuntimeEnv } from "./mcp-server.js";
import { D1TokenStore } from "./d1-token-store.js";
import { readSlackMcpConnectionId } from "./mcp-adapter.js";
import { SlackOAuthStateStore, type KvNamespaceLike } from "./slack-oauth-state.js";
import {
  buildSlackAuthorizeUrl,
  exchangeSlackOAuthCode,
  installationFromSlackOAuthResponse,
  type SlackOAuthConfig
} from "../slack/oauth.js";
import { botScopesFromEnv, splitCsv, userScopesFromEnv } from "../slack/scopes.js";
import { slackOauthSubjectId } from "./oauth-subject.js";

type CloudflareSlackMcpEnv = Omit<SlackMcpRuntimeEnv, "SESSION_KV"> & {
  readonly OAUTH_KV: KvNamespaceLike;
  readonly OAUTH_PROVIDER: OAuthHelpers;
  readonly SLACK_CLIENT_ID: string;
  readonly SLACK_CLIENT_SECRET: string;
  readonly SLACK_REDIRECT_URI?: string | undefined;
  readonly SLACK_OAUTH_SCOPES?: string | undefined;
  readonly SLACK_OAUTH_BOT_SCOPES?: string | undefined;
  readonly SLACK_OAUTH_STATE_TTL_SECONDS?: string | undefined;
  readonly SLACK_MCP_ALLOWED_ORIGINS?: string | undefined;
};

const DEFAULT_MCP_OAUTH_SCOPE = "slack";
const MCP_OAUTH_SCOPES = [DEFAULT_MCP_OAUTH_SCOPE];

const apiHandler = {
  async fetch(request: Request, env: CloudflareSlackMcpEnv, ctx: ExecutionContext): Promise<Response> {
    const originError = validateOrigin(request, env);
    if (originError) {
      return originError;
    }
    return createSlackMcpHttpHandler({ ...env, SESSION_KV: env.OAUTH_KV }, {
      connectionId: readSlackMcpConnectionId(readOAuthProviderProps(ctx))
    })(request);
  }
};

const defaultHandler = {
  async fetch(request: Request, env: CloudflareSlackMcpEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return jsonResponse(200, {
        name: "Slack MCP",
        mcp: `${url.origin}/mcp`,
        authorize: `${url.origin}/authorize`,
        token: `${url.origin}/token`,
        register: `${url.origin}/register`
      });
    }

    if (url.pathname === "/healthz") {
      return jsonResponse(200, {
        ok: true,
          service: "slack-mcp",
        storage: {
          d1: Boolean(env.DB),
          oauthKv: Boolean(env.OAUTH_KV)
        }
      });
    }

    if (url.pathname === "/authorize" && request.method === "GET") {
      return startAuthorization(request, env);
    }

    if (url.pathname === "/slack/oauth/callback" && request.method === "GET") {
      return completeSlackOAuth(request, env);
    }

    return textResponse(404, "Not found");
  }
};

export default new OAuthProvider<CloudflareSlackMcpEnv>({
  apiRoute: "/mcp",
  apiHandler,
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: MCP_OAUTH_SCOPES,
  allowPlainPKCE: false,
  allowImplicitFlow: false,
  allowTokenExchangeGrant: false,
  accessTokenTTL: 3600,
  refreshTokenTTL: 2_592_000,
  clientRegistrationTTL: 7_776_000
});

async function startAuthorization(
  request: Request,
  env: CloudflareSlackMcpEnv
): Promise<Response> {
  const oauthRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  assertSupportedMcpScopes(oauthRequest);

  const url = new URL(request.url);
  const stateStore = new SlackOAuthStateStore<AuthRequest>({
    kv: env.OAUTH_KV,
    ttlSeconds: oauthStateTtlSeconds(env)
  });
  const state = await stateStore.create({
    oauthRequest,
    teamId: url.searchParams.get("team")?.trim() || null,
    createdAt: new Date().toISOString()
  });

  const slackAuthorizeUrl = buildSlackAuthorizeUrl({
    config: slackOAuthConfig(env, request),
    state,
    teamId: url.searchParams.get("team")?.trim() || null
  });
  return Response.redirect(slackAuthorizeUrl.toString(), 302);
}

async function completeSlackOAuth(
  request: Request,
  env: CloudflareSlackMcpEnv
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return htmlResponse(400, "Invalid Slack OAuth callback", "Missing code or state.");
  }

  const stateStore = new SlackOAuthStateStore<AuthRequest>({
    kv: env.OAUTH_KV,
    ttlSeconds: oauthStateTtlSeconds(env)
  });
  const stateRecord = await stateStore.consume(state);
  if (!stateRecord) {
    return htmlResponse(400, "Invalid Slack OAuth callback", "OAuth state was not found or has expired.");
  }

  const slackConfig = slackOAuthConfig(env, request);
  const data = await exchangeSlackOAuthCode({
    config: slackConfig,
    code,
    fetch: workerFetch
  });
  if (!data.ok) {
    return htmlResponse(400, "Slack OAuth failed", data.error ?? "unknown_error");
  }

  let installation;
  try {
    installation = installationFromSlackOAuthResponse(data, slackConfig.userScopes);
  } catch (error) {
    return htmlResponse(
      400,
      "Slack OAuth response was incomplete",
      error instanceof Error ? error.message : "Missing Slack token metadata."
    );
  }

  const tokenStore = new D1TokenStore({
    db: env.DB,
    encryptionKey: env.TOKEN_ENCRYPTION_KEY
  });
  const saved = await tokenStore.save(installation);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: stateRecord.oauthRequest,
    userId: slackOauthSubjectId(saved),
    metadata: {
      provider: "slack",
      teamId: saved.teamId,
      teamName: saved.teamName,
      userId: saved.userId,
      connectionId: saved.connectionId,
      connectedAt: saved.updatedAt
    },
    scope: grantedMcpScopes(stateRecord.oauthRequest.scope),
    props: {
      provider: "slack",
      connectionId: saved.connectionId,
      teamId: saved.teamId,
      teamName: saved.teamName,
      userId: saved.userId
    }
  });

  return Response.redirect(redirectTo, 302);
}

const workerFetch: typeof fetch = (input, init) => fetch(input, init);

function slackOAuthConfig(env: CloudflareSlackMcpEnv, request: Request): SlackOAuthConfig {
  return {
    clientId: requiredEnv(env.SLACK_CLIENT_ID, "SLACK_CLIENT_ID"),
    clientSecret: requiredEnv(env.SLACK_CLIENT_SECRET, "SLACK_CLIENT_SECRET"),
    redirectUri: env.SLACK_REDIRECT_URI?.trim() || `${new URL(request.url).origin}/slack/oauth/callback`,
    userScopes: userScopesFromEnv(env.SLACK_OAUTH_SCOPES),
    botScopes: botScopesFromEnv(env.SLACK_OAUTH_BOT_SCOPES)
  };
}

function readOAuthProviderProps(ctx: ExecutionContext): Record<string, unknown> | undefined {
  const props = (ctx as ExecutionContext & { readonly props?: unknown }).props;
  return typeof props === "object" && props !== null ? props as Record<string, unknown> : undefined;
}

function requiredEnv(value: string | undefined, name: string): string {
  if (!value?.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertSupportedMcpScopes(oauthRequest: AuthRequest): void {
  const unsupported = oauthRequest.scope.filter((scope) => !MCP_OAUTH_SCOPES.includes(scope));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported MCP OAuth scope(s): ${unsupported.join(", ")}`);
  }
}

function grantedMcpScopes(requestedScopes: readonly string[]): string[] {
  return requestedScopes.length > 0
    ? requestedScopes.filter((scope) => MCP_OAUTH_SCOPES.includes(scope))
    : [DEFAULT_MCP_OAUTH_SCOPE];
}

function oauthStateTtlSeconds(env: CloudflareSlackMcpEnv): number {
  const ttl = Number(env.SLACK_OAUTH_STATE_TTL_SECONDS ?? 600);
  return Number.isInteger(ttl) && ttl > 0 ? ttl : 600;
}

function validateOrigin(request: Request, env: CloudflareSlackMcpEnv): Response | null {
  const origin = request.headers.get("origin");
  if (!origin) {
    return null;
  }

  const requestOrigin = new URL(request.url).origin;
  const allowedOrigins = new Set([requestOrigin, ...splitCsv(env.SLACK_MCP_ALLOWED_ORIGINS)]);
  return allowedOrigins.has(origin) ? null : textResponse(403, "Forbidden origin");
}

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function textResponse(status: number, value: string): Response {
  return new Response(value, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function htmlResponse(status: number, title: string, detail: string): Response {
  return new Response(
    `<!doctype html><html><body><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(detail)}</pre></body></html>`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return character;
    }
  });
}
