import type { SlackInstallationInput } from "./token-store.js";

export type SlackOAuthConfig = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
  readonly userScopes: readonly string[];
  readonly botScopes: readonly string[];
};

export type SlackOAuthAccessResponse = {
  readonly ok?: boolean;
  readonly error?: string;
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
  readonly authed_user?: {
    readonly id?: string;
    readonly access_token?: string;
    readonly refresh_token?: string;
    readonly expires_in?: number;
    readonly scope?: string;
  };
  readonly team?: {
    readonly id?: string;
    readonly name?: string;
  };
  readonly enterprise?: {
    readonly id?: string;
  } | null;
};

export function buildSlackAuthorizeUrl(params: {
  readonly config: SlackOAuthConfig;
  readonly state: string;
  readonly teamId?: string | null | undefined;
}): URL {
  const authorize = new URL("https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", params.config.clientId);
  authorize.searchParams.set("redirect_uri", params.config.redirectUri);
  authorize.searchParams.set("user_scope", params.config.userScopes.join(","));
  if (params.config.botScopes.length > 0) {
    authorize.searchParams.set("scope", params.config.botScopes.join(","));
  }
  authorize.searchParams.set("state", params.state);
  if (params.teamId) {
    authorize.searchParams.set("team", params.teamId);
  }
  return authorize;
}

export async function exchangeSlackOAuthCode(params: {
  readonly config: SlackOAuthConfig;
  readonly code: string;
  readonly fetch: typeof fetch;
}): Promise<SlackOAuthAccessResponse> {
  const body = new URLSearchParams({
    code: params.code,
    client_id: params.config.clientId,
    client_secret: params.config.clientSecret,
    redirect_uri: params.config.redirectUri
  });
  const response = await params.fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    body
  });
  return (await response.json()) as SlackOAuthAccessResponse;
}

export function installationFromSlackOAuthResponse(
  data: SlackOAuthAccessResponse,
  fallbackUserScope: readonly string[]
): SlackInstallationInput {
  const accessToken = data.authed_user?.access_token;
  const teamId = data.team?.id;
  const userId = data.authed_user?.id;
  if (!accessToken || !teamId || !userId) {
    throw new Error("Slack OAuth response did not include a user token, team id, and user id");
  }

  return {
    teamId,
    teamName: data.team?.name ?? null,
    enterpriseId: data.enterprise?.id ?? null,
    userId,
    accessToken,
    ...tokenRotationFields("user", data.authed_user?.refresh_token, data.authed_user?.expires_in),
    botAccessToken: data.access_token,
    ...tokenRotationFields("bot", data.refresh_token, data.expires_in),
    scope: data.authed_user?.scope ?? fallbackUserScope.join(","),
    botScope: data.scope,
    tokenType: "user"
  };
}

function tokenRotationFields(
  tokenKind: "user" | "bot",
  refreshToken: string | undefined,
  expiresInSeconds: number | undefined
): Partial<SlackInstallationInput> {
  const fields: Record<string, string> = {};
  if (refreshToken?.trim()) {
    fields[`${tokenKind}RefreshToken`] = refreshToken;
  }
  if (typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    fields[`${tokenKind}TokenExpiresAt`] = new Date(Date.now() + expiresInSeconds * 1000).toISOString();
  }
  return fields as Partial<SlackInstallationInput>;
}
