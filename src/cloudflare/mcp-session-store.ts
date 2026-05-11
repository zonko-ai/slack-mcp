export type McpSessionKvNamespace = {
  readonly put: (
    key: string,
    value: string,
    options?: { readonly expirationTtl?: number }
  ) => Promise<void>;
  readonly get: (key: string) => Promise<string | null>;
  readonly delete: (key: string) => Promise<void>;
};

export type McpSessionRecord = {
  readonly id: string;
  readonly connectionId: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
};

export type McpSessionStoreOptions = {
  readonly kv: McpSessionKvNamespace;
  readonly ttlSeconds: number;
  readonly now?: (() => Date) | undefined;
};

export class McpSessionStore {
  private readonly kv: McpSessionKvNamespace;
  private readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(options: McpSessionStoreOptions) {
    this.kv = options.kv;
    this.ttlSeconds = normalizeSessionTtlSeconds(options.ttlSeconds);
    this.now = options.now ?? (() => new Date());
  }

  async create(input: {
    readonly sessionId?: string | undefined;
    readonly connectionId: string;
  }): Promise<McpSessionRecord> {
    const now = this.now();
    const record = this.record({
      id: input.sessionId ?? newMcpSessionId(),
      connectionId: input.connectionId,
      createdAt: now,
      lastSeenAt: now
    });
    await this.put(record);
    return record;
  }

  async get(sessionId: string): Promise<McpSessionRecord | null> {
    const raw = await this.kv.get(sessionKey(sessionId));
    if (!raw) {
      return null;
    }

    const record = parseSessionRecord(raw);
    if (!record) {
      await this.delete(sessionId);
      return null;
    }

    if (Date.parse(record.expiresAt) <= this.now().getTime()) {
      await this.delete(sessionId);
      return null;
    }

    return record;
  }

  async touch(record: McpSessionRecord): Promise<McpSessionRecord> {
    const now = this.now();
    const touched = this.record({
      id: record.id,
      connectionId: record.connectionId,
      createdAt: new Date(record.createdAt),
      lastSeenAt: now
    });
    await this.put(touched);
    return touched;
  }

  async delete(sessionId: string): Promise<void> {
    await this.kv.delete(sessionKey(sessionId));
  }

  private async put(record: McpSessionRecord): Promise<void> {
    await this.kv.put(sessionKey(record.id), JSON.stringify(record), {
      expirationTtl: this.ttlSeconds
    });
  }

  private record(input: {
    readonly id: string;
    readonly connectionId: string;
    readonly createdAt: Date;
    readonly lastSeenAt: Date;
  }): McpSessionRecord {
    const expiresAt = new Date(input.lastSeenAt.getTime() + this.ttlSeconds * 1000);
    return {
      id: input.id,
      connectionId: input.connectionId,
      createdAt: input.createdAt.toISOString(),
      lastSeenAt: input.lastSeenAt.toISOString(),
      expiresAt: expiresAt.toISOString()
    };
  }
}

export function normalizeSessionTtlSeconds(value: number): number {
  return Number.isInteger(value) && value > 0 ? value : 3600;
}

export function sessionKey(sessionId: string): string {
  return `mcp-session:${sessionId}`;
}

export function newMcpSessionId(): string {
  return `mcp-session-${crypto.randomUUID()}`;
}

function parseSessionRecord(raw: string): McpSessionRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<McpSessionRecord>;
    if (
      typeof value.id !== "string" ||
      typeof value.connectionId !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.lastSeenAt !== "string" ||
      typeof value.expiresAt !== "string"
    ) {
      return null;
    }
    return {
      id: value.id,
      connectionId: value.connectionId,
      createdAt: value.createdAt,
      lastSeenAt: value.lastSeenAt,
      expiresAt: value.expiresAt
    };
  } catch {
    return null;
  }
}
