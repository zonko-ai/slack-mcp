import { randomBytes } from "node:crypto";
import {
  buildSlackAuthorizeUrl,
  exchangeSlackOAuthCode,
  installationFromSlackOAuthResponse,
  type SlackOAuthConfig
} from "../slack/oauth.js";
import type { SlackInstallationInput } from "../slack/token-store.js";

type OAuthHandlerOptions = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly scopes: readonly string[];
  readonly botScopes: readonly string[];
  readonly tokenStore: {
    readonly save: (installation: SlackInstallationInput) => Promise<{ readonly connectionId: string }>;
  };
  readonly fetch?: typeof fetch;
};

type OAuthCredentials = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
};

export function createOAuthHandler(options: OAuthHandlerOptions): (request: Request) => Promise<Response> {
  const states = new Map<string, number>();
  const fetchImpl = options.fetch ?? fetch;
  let credentials: OAuthCredentials = {
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri: options.redirectUri
  };

  return async function handleOAuth(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/oauth/setup" && request.method === "GET") {
      return htmlResponse(
        200,
        `<h1>Slack MCP OAuth Setup</h1>
        <p>Slack redirect URL: <code>${escapeHtml(credentials.redirectUri)}</code></p>
        <form method="post" action="/oauth/setup">
          <label>Client ID <input name="client_id" value="${escapeHtml(credentials.clientId)}" autocomplete="off" required></label>
          <label>Client Secret <input name="client_secret" type="password" autocomplete="off" required></label>
          <label>Redirect URI <input name="redirect_uri" value="${escapeHtml(credentials.redirectUri)}" autocomplete="off" required></label>
          <button type="submit">Save OAuth credentials</button>
        </form>`
      );
    }

    if (url.pathname === "/oauth/setup" && request.method === "POST") {
      const body = await request.text();
      const form = new URLSearchParams(body);
      const clientId = form.get("client_id")?.trim() ?? "";
      const clientSecret = form.get("client_secret")?.trim() ?? "";
      const redirectUri = form.get("redirect_uri")?.trim() ?? "";
      if (!clientId || !clientSecret || !redirectUri) {
        return htmlResponse(400, "<h1>Client ID, client secret, and redirect URI are required</h1>");
      }
      credentials = { clientId, clientSecret, redirectUri };
      return htmlResponse(
        200,
        `<h1>OAuth credentials configured</h1><p>Client ID: <code>${escapeHtml(clientId)}</code></p><p>Redirect URI: <code>${escapeHtml(redirectUri)}</code></p><p><a href="/oauth/start">Connect Slack</a></p>`
      );
    }

    if (url.pathname === "/oauth/start") {
      if (!credentials.clientId || !credentials.clientSecret || !credentials.redirectUri) {
        return htmlResponse(400, "<h1>Slack OAuth credentials are not configured</h1><p>Open <a href=\"/oauth/setup\">/oauth/setup</a> first.</p>");
      }
      const state = randomBytes(24).toString("base64url");
      states.set(state, Date.now());
      const team = url.searchParams.get("team")?.trim();
      const authorize = buildSlackAuthorizeUrl({
        config: slackOAuthConfig(credentials, options.scopes, options.botScopes),
        state,
        teamId: team
      });
      return redirect(authorize.toString());
    }

    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state || !states.has(state)) {
        return htmlResponse(400, "<h1>Invalid Slack OAuth callback</h1>");
      }
      states.delete(state);

      const data = await exchangeSlackOAuthCode({
        config: slackOAuthConfig(credentials, options.scopes, options.botScopes),
        code,
        fetch: fetchImpl
      });
      if (!data.ok) {
        return htmlResponse(400, `<h1>Slack OAuth failed</h1><pre>${escapeHtml(data.error ?? "unknown_error")}</pre>`);
      }

      let installation;
      try {
        installation = installationFromSlackOAuthResponse(data, options.scopes);
      } catch {
        return htmlResponse(400, "<h1>Slack OAuth response did not include a user token, team id, and user id</h1>");
      }

      const saved = await options.tokenStore.save(installation);

      return htmlResponse(
        200,
        `<h1>Slack connected</h1><p>Connection id: <code>${escapeHtml(saved.connectionId)}</code></p><p>You can now use the MCP endpoint at <code>/mcp</code>.</p>`
      );
    }

    return htmlResponse(404, "<h1>Not found</h1>");
  };
}

function slackOAuthConfig(
  credentials: OAuthCredentials,
  userScopes: readonly string[],
  botScopes: readonly string[]
): SlackOAuthConfig {
  return {
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: credentials.redirectUri,
    userScopes,
    botScopes
  };
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location }
  });
}

function htmlResponse(status: number, body: string): Response {
  return new Response(`<!doctype html><html><body>${body}</body></html>`, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
  });
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
