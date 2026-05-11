import { describe, expect, test } from "vitest";
import { slackOauthSubjectId } from "../src/cloudflare/oauth-subject.js";

describe("Slack OAuth provider subject ids", () => {
  test("encodes Slack team and user ids without OAuth-provider delimiter characters", () => {
    const subject = slackOauthSubjectId({ teamId: "T123", userId: "U456" });

    expect(subject).toMatch(/^slack-[A-Za-z0-9_-]+$/);
    expect(subject).not.toContain(":");
    expect(subject).not.toContain("T123:U456");
  });
});
