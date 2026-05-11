import type {
  SlackInstallation,
  SlackInstallationInput,
  SlackInstallationSummary,
  SlackTokenType,
  TokenStore
} from "../slack/token-store.js";

type D1Result<T> = {
  readonly results?: readonly T[];
};

type D1PreparedStatementLike = {
  bind(...values: readonly unknown[]): D1PreparedStatementLike;
  run(): Promise<unknown>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
};

export type D1DatabaseLike = {
  prepare(sql: string): D1PreparedStatementLike;
};

type D1TokenStoreOptions = {
  readonly db: D1DatabaseLike;
  readonly encryptionKey: string;
  readonly now?: () => string;
};

type SlackInstallationRow = {
  readonly connection_id: string;
  readonly team_id: string;
  readonly team_name: string | null;
  readonly enterprise_id: string | null;
  readonly user_id: string;
  readonly access_token_ciphertext: string;
  readonly user_refresh_token_ciphertext: string | null;
  readonly user_token_expires_at: string | null;
  readonly bot_access_token_ciphertext: string | null;
  readonly bot_refresh_token_ciphertext: string | null;
  readonly bot_token_expires_at: string | null;
  readonly scope: string;
  readonly bot_scope: string | null;
  readonly token_type: string;
  readonly created_at: string;
  readonly updated_at: string;
};

type EncryptedValue = {
  readonly v: 1;
  readonly alg: "A256GCM";
  readonly iv: string;
  readonly ciphertext: string;
};

const SELECT_INSTALLATION_COLUMNS = `
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
`;

export class D1TokenStore implements TokenStore {
  private readonly db: D1DatabaseLike;
  private readonly encryptionKey: Promise<CryptoKey>;
  private readonly now: () => string;

  constructor(options: D1TokenStoreOptions) {
    this.db = options.db;
    this.encryptionKey = importEncryptionKey(options.encryptionKey);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async save(input: SlackInstallationInput): Promise<SlackInstallation> {
    const now = this.now();
    const connectionId = `${input.teamId}:${input.userId}`;
    const accessTokenCiphertext = await this.encrypt(input.accessToken);
    const userRefreshTokenCiphertext = input.userRefreshToken
      ? await this.encrypt(input.userRefreshToken)
      : null;
    const botAccessTokenCiphertext = input.botAccessToken
      ? await this.encrypt(input.botAccessToken)
      : null;
    const botRefreshTokenCiphertext = input.botRefreshToken
      ? await this.encrypt(input.botRefreshToken)
      : null;

    await this.db
      .prepare(
        `INSERT INTO slack_installations (
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id) DO UPDATE SET
          team_id = excluded.team_id,
          team_name = excluded.team_name,
          enterprise_id = excluded.enterprise_id,
          user_id = excluded.user_id,
          access_token_ciphertext = excluded.access_token_ciphertext,
          user_refresh_token_ciphertext = excluded.user_refresh_token_ciphertext,
          user_token_expires_at = excluded.user_token_expires_at,
          bot_access_token_ciphertext = excluded.bot_access_token_ciphertext,
          bot_refresh_token_ciphertext = excluded.bot_refresh_token_ciphertext,
          bot_token_expires_at = excluded.bot_token_expires_at,
          scope = excluded.scope,
          bot_scope = excluded.bot_scope,
          token_type = excluded.token_type,
          updated_at = excluded.updated_at`
      )
      .bind(
        connectionId,
        input.teamId,
        input.teamName,
        input.enterpriseId,
        input.userId,
        accessTokenCiphertext,
        userRefreshTokenCiphertext,
        input.userTokenExpiresAt ?? null,
        botAccessTokenCiphertext,
        botRefreshTokenCiphertext,
        input.botTokenExpiresAt ?? null,
        input.scope,
        input.botScope ?? null,
        input.tokenType,
        now,
        now
      )
      .run();

    return {
      ...input,
      connectionId,
      createdAt: now,
      updatedAt: now
    };
  }

  async get(connectionId: string): Promise<SlackInstallation | null> {
    const row = await this.db
      .prepare(`SELECT ${SELECT_INSTALLATION_COLUMNS} FROM slack_installations WHERE connection_id = ? LIMIT 1`)
      .bind(connectionId)
      .first<SlackInstallationRow>();
    return row ? this.rowToInstallation(row) : null;
  }

  async getDefault(): Promise<SlackInstallation | null> {
    const row = await this.db
      .prepare(`SELECT ${SELECT_INSTALLATION_COLUMNS} FROM slack_installations ORDER BY updated_at DESC LIMIT 1`)
      .first<SlackInstallationRow>();
    return row ? this.rowToInstallation(row) : null;
  }

  async listSummaries(): Promise<readonly SlackInstallationSummary[]> {
    const result = await this.db
      .prepare(
        `SELECT
          connection_id,
          team_id,
          team_name,
          user_id,
          scope,
          token_type
        FROM slack_installations
        ORDER BY updated_at DESC`
      )
      .all<Pick<SlackInstallationRow, "connection_id" | "team_id" | "team_name" | "user_id" | "scope" | "token_type">>();

    return (result.results ?? []).map((row) => ({
      connectionId: row.connection_id,
      teamId: row.team_id,
      teamName: row.team_name,
      userId: row.user_id,
      tokenType: parseTokenType(row.token_type),
      scope: row.scope
    }));
  }

  private async rowToInstallation(row: SlackInstallationRow): Promise<SlackInstallation> {
    const accessToken = await this.decrypt(row.access_token_ciphertext);
    const userRefreshToken = row.user_refresh_token_ciphertext
      ? await this.decrypt(row.user_refresh_token_ciphertext)
      : undefined;
    const botAccessToken = row.bot_access_token_ciphertext
      ? await this.decrypt(row.bot_access_token_ciphertext)
      : undefined;
    const botRefreshToken = row.bot_refresh_token_ciphertext
      ? await this.decrypt(row.bot_refresh_token_ciphertext)
      : undefined;

    return {
      connectionId: row.connection_id,
      teamId: row.team_id,
      teamName: row.team_name,
      enterpriseId: row.enterprise_id,
      userId: row.user_id,
      accessToken,
      ...(userRefreshToken === undefined ? {} : { userRefreshToken }),
      ...(row.user_token_expires_at === null ? {} : { userTokenExpiresAt: row.user_token_expires_at }),
      ...(botAccessToken === undefined ? {} : { botAccessToken }),
      ...(botRefreshToken === undefined ? {} : { botRefreshToken }),
      ...(row.bot_token_expires_at === null ? {} : { botTokenExpiresAt: row.bot_token_expires_at }),
      scope: row.scope,
      ...(row.bot_scope === null ? {} : { botScope: row.bot_scope }),
      tokenType: parseTokenType(row.token_type),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private async encrypt(value: string): Promise<string> {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: toArrayBuffer(iv) },
        await this.encryptionKey,
        new TextEncoder().encode(value)
      )
    );
    const encrypted: EncryptedValue = {
      v: 1,
      alg: "A256GCM",
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(ciphertext)
    };
    return JSON.stringify(encrypted);
  }

  private async decrypt(value: string): Promise<string> {
    const parsed = JSON.parse(value) as Partial<EncryptedValue>;
    if (parsed.v !== 1 || parsed.alg !== "A256GCM" || !parsed.iv || !parsed.ciphertext) {
      throw new Error("Unsupported encrypted Slack token format");
    }
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(decodeBase64Url(parsed.iv)) },
      await this.encryptionKey,
      toArrayBuffer(decodeBase64Url(parsed.ciphertext))
    );
    return new TextDecoder().decode(plaintext);
  }
}

async function importEncryptionKey(value: string): Promise<CryptoKey> {
  const keyBytes = decodeEncryptionKey(value);
  return crypto.subtle.importKey("raw", toArrayBuffer(keyBytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function decodeEncryptionKey(value: string): Uint8Array {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("TOKEN_ENCRYPTION_KEY is required");
  }

  const candidates = [
    decodeHexKey(trimmed),
    decodeBase64Key(trimmed),
    new TextEncoder().encode(trimmed)
  ].filter((candidate): candidate is Uint8Array => candidate !== null);

  const key = candidates.find((candidate) => candidate.byteLength === 32);
  if (!key) {
    throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM");
  }
  return key;
}

function decodeHexKey(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    return null;
  }
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function decodeBase64Key(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

function parseTokenType(value: string): SlackTokenType {
  if (value === "user" || value === "bot" || value === "admin") {
    return value;
  }
  throw new Error(`Unsupported Slack token type: ${value}`);
}
