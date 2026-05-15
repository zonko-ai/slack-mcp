export type SlackApiFetch = typeof fetch;

export type SlackApiClientOptions = {
  readonly token: string;
  readonly fetch?: SlackApiFetch;
};

export type SlackApiErrorBody = {
  readonly ok?: false;
  readonly error?: string;
  readonly needed?: string;
  readonly provided?: string;
  readonly response_metadata?: unknown;
};

export class SlackApiError extends Error {
  readonly method: string;
  readonly status: number;
  readonly slackError: string;
  readonly needed?: string | undefined;
  readonly provided?: string | undefined;

  constructor(method: string, status: number, body: SlackApiErrorBody | string) {
    const slackError = typeof body === "string" ? body : body.error ?? "slack_api_error";
    super(`Slack API ${method} failed: ${slackError}`);
    this.name = "SlackApiError";
    this.method = method;
    this.status = status;
    this.slackError = slackError;
    this.needed = typeof body === "string" ? undefined : body.needed;
    this.provided = typeof body === "string" ? undefined : body.provided;
  }
}

export class SlackApiClient {
  private readonly token: string;
  private readonly fetchImpl: SlackApiFetch;

  constructor(options: SlackApiClientOptions) {
    if (!options.token.trim()) {
      throw new Error("Slack token is required");
    }
    this.token = options.token;
    this.fetchImpl = options.fetch ?? defaultFetch;
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const response = await this.fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: encodeSlackParams(params)
    });

    const text = await response.text();
    const parsed = parseSlackResponse(text);

    if (!response.ok) {
      throw new SlackApiError(method, response.status, parsed ?? text);
    }
    if (isSlackError(parsed)) {
      throw new SlackApiError(method, response.status, parsed);
    }
    return parsed;
  }
}

const defaultFetch: SlackApiFetch = (input, init) => fetch(input, init);

function encodeSlackParams(params: Record<string, unknown>): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string") {
      body.set(key, value);
    } else if (typeof value === "number" || typeof value === "boolean") {
      body.set(key, String(value));
    } else {
      body.set(key, JSON.stringify(value));
    }
  }
  return body;
}

function parseSlackResponse(text: string): unknown {
  if (text.length === 0) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isSlackError(value: unknown): value is SlackApiErrorBody {
  return typeof value === "object" && value !== null && "ok" in value && (value as { ok?: unknown }).ok === false;
}
