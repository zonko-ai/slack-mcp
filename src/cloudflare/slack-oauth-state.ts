export type KvNamespaceLike = {
  put(key: string, value: string, options?: { readonly expirationTtl?: number }): Promise<void>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
};

export type SlackOAuthStateRecord<OAuthRequest = unknown> = {
  readonly oauthRequest: OAuthRequest;
  readonly teamId?: string | null | undefined;
  readonly createdAt: string;
};

type SlackOAuthStateStoreOptions = {
  readonly kv: KvNamespaceLike;
  readonly ttlSeconds: number;
};

const KEY_PREFIX = "slack-oauth-state:";

export class SlackOAuthStateStore<OAuthRequest = unknown> {
  private readonly kv: KvNamespaceLike;
  private readonly ttlSeconds: number;

  constructor(options: SlackOAuthStateStoreOptions) {
    this.kv = options.kv;
    this.ttlSeconds = options.ttlSeconds;
  }

  async create(record: SlackOAuthStateRecord<OAuthRequest>): Promise<string> {
    const state = `slack-state-${crypto.randomUUID()}`;
    await this.kv.put(this.key(state), JSON.stringify(record), {
      expirationTtl: this.ttlSeconds
    });
    return state;
  }

  async consume(state: string): Promise<SlackOAuthStateRecord<OAuthRequest> | null> {
    const key = this.key(state);
    const value = await this.kv.get(key);
    if (!value) {
      return null;
    }
    await this.kv.delete(key);
    return JSON.parse(value) as SlackOAuthStateRecord<OAuthRequest>;
  }

  private key(state: string): string {
    return `${KEY_PREFIX}${state}`;
  }
}
