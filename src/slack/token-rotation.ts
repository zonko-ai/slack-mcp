export type SlackTokenRotationConfig = {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshWindowSeconds?: number | undefined;
  readonly now?: (() => Date) | undefined;
};

export type SlackTokenRefreshResult = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: string;
  readonly scope?: string | undefined;
};

export class SlackTokenRefreshError extends Error {
  readonly slackError: string;

  constructor(slackError: string) {
    super(`Slack token refresh failed: ${slackError}`);
    this.name = "SlackTokenRefreshError";
    this.slackError = slackError;
  }
}

type SlackTokenRefreshResponse = {
  readonly ok?: boolean;
  readonly error?: string;
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly expires_in?: number;
  readonly scope?: string;
};

const DEFAULT_REFRESH_WINDOW_SECONDS = 5 * 60;

export function shouldRefreshSlackToken(params: {
  readonly expiresAt: string | undefined;
  readonly refreshToken: string | undefined;
  readonly config: SlackTokenRotationConfig | undefined;
}): boolean {
  if (!params.config || !params.refreshToken?.trim() || !params.expiresAt?.trim()) {
    return false;
  }

  const expiresAtMs = Date.parse(params.expiresAt);
  if (!Number.isFinite(expiresAtMs)) {
    return false;
  }

  const refreshWindowSeconds = params.config.refreshWindowSeconds ?? DEFAULT_REFRESH_WINDOW_SECONDS;
  const now = params.config.now?.() ?? new Date();
  return expiresAtMs <= now.getTime() + refreshWindowSeconds * 1000;
}

export async function refreshSlackToken(params: {
  readonly config: SlackTokenRotationConfig;
  readonly refreshToken: string;
  readonly fetch: typeof fetch;
}): Promise<SlackTokenRefreshResult> {
  const response = await params.fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: {
      authorization: oauthBasicAuthorization(params.config.clientId, params.config.clientSecret),
      "content-type": "application/x-www-form-urlencoded; charset=utf-8"
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: params.refreshToken
    })
  });

  const data = (await response.json()) as SlackTokenRefreshResponse;
  if (!response.ok || data.ok === false) {
    throw new SlackTokenRefreshError(data.error ?? `http_${response.status}`);
  }
  if (!data.access_token?.trim() || !data.refresh_token?.trim()) {
    throw new SlackTokenRefreshError("missing_rotated_token");
  }
  if (typeof data.expires_in !== "number" || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw new SlackTokenRefreshError("missing_token_expiration");
  }

  const now = params.config.now?.() ?? new Date();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(now.getTime() + data.expires_in * 1000).toISOString(),
    ...(data.scope === undefined ? {} : { scope: data.scope })
  };
}

function oauthBasicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${base64Encode(`${encodeOAuthCredential(clientId)}:${encodeOAuthCredential(clientSecret)}`)}`;
}

function encodeOAuthCredential(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, "+");
}

function base64Encode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
