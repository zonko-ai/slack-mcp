import { describe, expect, test, vi } from "vitest";
import { SlackApiClient, SlackApiError } from "../src/slack/client.js";

describe("SlackApiClient", () => {
  test("posts Slack Web API calls as bearer-authenticated JSON", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, channel: { id: "C123" } }), {
        headers: { "content-type": "application/json" }
      })
    );
    const client = new SlackApiClient({ token: "xoxp-test", fetch: fetchMock });

    const result = await client.call("conversations.info", { channel: "C123" });

    expect(result).toEqual({ ok: true, channel: { id: "C123" } });
    expect(fetchMock).toHaveBeenCalledWith("https://slack.com/api/conversations.info", {
      method: "POST",
      headers: {
        authorization: "Bearer xoxp-test",
        "content-type": "application/x-www-form-urlencoded; charset=utf-8"
      },
      body: new URLSearchParams({ channel: "C123" })
    });
  });

  test("raises structured Slack errors instead of leaking raw failed responses", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: "missing_scope", needed: "files:read" }), {
        headers: { "content-type": "application/json" }
      })
    );
    const client = new SlackApiClient({ token: "xoxp-test", fetch: fetchMock });

    await expect(client.call("files.list", {})).rejects.toMatchObject({
      name: "SlackApiError",
      method: "files.list",
      slackError: "missing_scope",
      needed: "files:read"
    } satisfies Partial<SlackApiError>);
  });
});
