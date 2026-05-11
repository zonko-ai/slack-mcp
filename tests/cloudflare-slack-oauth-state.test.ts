import { describe, expect, test } from "vitest";
import { SlackOAuthStateStore } from "../src/cloudflare/slack-oauth-state.js";

class MemoryKvNamespace {
  readonly entries = new Map<string, string>();
  readonly expirations = new Map<string, number>();

  async put(key: string, value: string, options?: { readonly expirationTtl?: number }) {
    this.entries.set(key, value);
    if (options?.expirationTtl !== undefined) {
      this.expirations.set(key, options.expirationTtl);
    }
  }

  async get(key: string) {
    return this.entries.get(key) ?? null;
  }

  async delete(key: string) {
    this.entries.delete(key);
  }
}

describe("SlackOAuthStateStore", () => {
  test("stores OAuth request state with a short TTL and consumes it once", async () => {
    const kv = new MemoryKvNamespace();
    const store = new SlackOAuthStateStore({ kv, ttlSeconds: 600 });
    const oauthRequest = {
      clientId: "mcp-client",
      redirectUri: "http://localhost/callback",
      scope: "slack:standard",
      state: "client-state"
    };

    const state = await store.create({
      oauthRequest,
      teamId: "T123",
      createdAt: "2026-05-11T12:00:00.000Z"
    });

    expect(state).toMatch(/^slack-state-/);
    expect(kv.expirations.get(`slack-oauth-state:${state}`)).toBe(600);

    await expect(store.consume(state)).resolves.toEqual({
      oauthRequest,
      teamId: "T123",
      createdAt: "2026-05-11T12:00:00.000Z"
    });
    await expect(store.consume(state)).resolves.toBeNull();
  });
});
