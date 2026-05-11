import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { FileTokenStore } from "../src/slack/token-store.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("FileTokenStore", () => {
  test("stores Slack OAuth installations by connection id and avoids token exposure in summaries", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "slack-mcp-store-"));
    const path = join(tempDir, "tokens.json");
    const store = new FileTokenStore(path);

    const saved = await store.save({
      teamId: "T123",
      teamName: "Example",
      enterpriseId: null,
      userId: "U123",
      accessToken: "xoxp-secret",
      scope: "channels:read,chat:write",
      tokenType: "user"
    });

    expect(saved.connectionId).toBe("T123:U123");
    await expect(store.get("T123:U123")).resolves.toMatchObject({
      accessToken: "xoxp-secret",
      teamName: "Example"
    });
    await expect(store.listSummaries()).resolves.toEqual([
      {
        connectionId: "T123:U123",
        teamId: "T123",
        teamName: "Example",
        userId: "U123",
        tokenType: "user",
        scope: "channels:read,chat:write"
      }
    ]);
    expect(await readFile(path, "utf8")).toContain("xoxp-secret");
    expect(JSON.stringify(await store.listSummaries())).not.toContain("xoxp-secret");
  });
});
