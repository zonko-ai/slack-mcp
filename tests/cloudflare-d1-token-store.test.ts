import { describe, expect, test } from "vitest";
import { D1TokenStore } from "../src/cloudflare/d1-token-store.js";
import type { SlackInstallationInput } from "../src/slack/token-store.js";

type D1Row = {
  connection_id: string;
  team_id: string;
  team_name: string | null;
  enterprise_id: string | null;
  user_id: string;
  access_token_ciphertext: string;
  user_refresh_token_ciphertext: string | null;
  user_token_expires_at: string | null;
  bot_access_token_ciphertext: string | null;
  bot_refresh_token_ciphertext: string | null;
  bot_token_expires_at: string | null;
  scope: string;
  bot_scope: string | null;
  token_type: string;
  created_at: string;
  updated_at: string;
};

class MemoryD1Database {
  readonly rows = new Map<string, D1Row>();

  prepare(sql: string) {
    return new MemoryD1Statement(this, sql);
  }
}

class MemoryD1Statement {
  private values: readonly unknown[] = [];

  constructor(
    private readonly db: MemoryD1Database,
    private readonly sql: string
  ) {}

  bind(...values: readonly unknown[]) {
    this.values = values;
    return this;
  }

  async run() {
    if (!this.sql.includes("INSERT INTO slack_installations")) {
      throw new Error(`Unexpected D1 run SQL: ${this.sql}`);
    }
    const [
      connection_id,
      team_id,
      team_name,
      enterprise_id,
      user_id,
      access_token_ciphertext,
      user_refresh_token_ciphertext,
      user_token_expires_at,
      bot_access_token_ciphertext,
      bot_refresh_token_ciphertext,
      bot_token_expires_at,
      scope,
      bot_scope,
      token_type,
      created_at,
      updated_at
    ] = this.values as [
      string,
      string,
      string | null,
      string | null,
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string,
      string | null,
      string,
      string,
      string
    ];
    this.db.rows.set(connection_id, {
      connection_id,
      team_id,
      team_name,
      enterprise_id,
      user_id,
      access_token_ciphertext,
      user_refresh_token_ciphertext,
      user_token_expires_at,
      bot_access_token_ciphertext,
      bot_refresh_token_ciphertext,
      bot_token_expires_at,
      scope,
      bot_scope,
      token_type,
      created_at: this.db.rows.get(connection_id)?.created_at ?? created_at,
      updated_at
    });
    return { success: true };
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.sql.includes("WHERE connection_id = ?")) {
      return (this.db.rows.get(this.values[0] as string) as T | undefined) ?? null;
    }
    if (this.sql.includes("ORDER BY updated_at DESC LIMIT 1")) {
      return ([...this.db.rows.values()].sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at)
      )[0] as T | undefined) ?? null;
    }
    throw new Error(`Unexpected D1 first SQL: ${this.sql}`);
  }

  async all<T = unknown>(): Promise<{ readonly results: readonly T[] }> {
    if (!this.sql.includes("FROM slack_installations")) {
      throw new Error(`Unexpected D1 all SQL: ${this.sql}`);
    }
    return {
      results: ([...this.db.rows.values()].sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at)
      ) as unknown) as readonly T[]
    };
  }
}

function installation(overrides: Partial<SlackInstallationInput> = {}): SlackInstallationInput {
  return {
    teamId: "T123",
    teamName: "Example",
    enterpriseId: null,
    userId: "U123",
    accessToken: "xoxp-user-secret",
    userRefreshToken: "xoxe-user-refresh-secret",
    userTokenExpiresAt: "2026-05-12T00:00:00.000Z",
    botAccessToken: "xoxb-bot-secret",
    botRefreshToken: "xoxe-bot-refresh-secret",
    botTokenExpiresAt: "2026-05-12T00:00:00.000Z",
    scope: "channels:read,chat:write",
    botScope: "commands,chat:write",
    tokenType: "user",
    ...overrides
  };
}

describe("D1TokenStore", () => {
  test("encrypts Slack tokens at rest and decrypts installations on read", async () => {
    const db = new MemoryD1Database();
    const store = new D1TokenStore({
      db,
      encryptionKey: "0123456789abcdef0123456789abcdef",
      now: () => "2026-05-11T12:00:00.000Z"
    });

    const saved = await store.save(installation());

    expect(saved.connectionId).toBe("T123:U123");
    const raw = db.rows.get("T123:U123");
    expect(raw).toBeTruthy();
    expect(raw?.access_token_ciphertext).not.toContain("xoxp-user-secret");
    expect(raw?.user_refresh_token_ciphertext).not.toContain("xoxe-user-refresh-secret");
    expect(raw?.bot_access_token_ciphertext).not.toContain("xoxb-bot-secret");
    expect(raw?.bot_refresh_token_ciphertext).not.toContain("xoxe-bot-refresh-secret");

    await expect(store.get("T123:U123")).resolves.toMatchObject({
      connectionId: "T123:U123",
      accessToken: "xoxp-user-secret",
      userRefreshToken: "xoxe-user-refresh-secret",
      userTokenExpiresAt: "2026-05-12T00:00:00.000Z",
      botAccessToken: "xoxb-bot-secret",
      botRefreshToken: "xoxe-bot-refresh-secret",
      botTokenExpiresAt: "2026-05-12T00:00:00.000Z",
      teamName: "Example"
    });
  });

  test("returns newest default installation and summaries without secret material", async () => {
    const db = new MemoryD1Database();
    let timestamp = 0;
    const store = new D1TokenStore({
      db,
      encryptionKey: "0123456789abcdef0123456789abcdef",
      now: () => `2026-05-11T12:00:0${timestamp++}.000Z`
    });

    await store.save(installation({ teamId: "T1", userId: "U1", accessToken: "xoxp-old" }));
    await store.save(installation({ teamId: "T2", userId: "U2", accessToken: "xoxp-new" }));

    await expect(store.getDefault()).resolves.toMatchObject({
      connectionId: "T2:U2",
      accessToken: "xoxp-new"
    });

    const summaries = await store.listSummaries();
    expect(summaries).toEqual([
      {
        connectionId: "T2:U2",
        teamId: "T2",
        teamName: "Example",
        userId: "U2",
        tokenType: "user",
        scope: "channels:read,chat:write"
      },
      {
        connectionId: "T1:U1",
        teamId: "T1",
        teamName: "Example",
        userId: "U1",
        tokenType: "user",
        scope: "channels:read,chat:write"
      }
    ]);
    expect(JSON.stringify(summaries)).not.toContain("xoxp-");
  });
});
