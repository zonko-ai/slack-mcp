import { describe, expect, test } from "vitest";
import { jsonSchemaToZodObject, readSlackMcpConnectionId } from "../src/cloudflare/mcp-adapter.js";

describe("Cloudflare MCP server adapter", () => {
  test("reads the Slack connection id from OAuth provider props", () => {
    expect(readSlackMcpConnectionId({ connectionId: "T123:U123" })).toBe("T123:U123");
    expect(readSlackMcpConnectionId({ connectionId: "" })).toBeNull();
    expect(readSlackMcpConnectionId(undefined)).toBeNull();
  });

  test("converts Slack JSON schemas to Zod objects while preserving additional Slack parameters", () => {
    const schema = jsonSchemaToZodObject({
      type: "object",
      properties: {
        channel: { type: "string" },
        limit: { type: "number" },
        inclusive: { type: "boolean" }
      },
      required: ["channel"],
      additionalProperties: true
    });

    expect(
      schema.parse({
        channel: "C123",
        limit: 10,
        inclusive: false,
        include_locale: true
      })
    ).toEqual({
      channel: "C123",
      limit: 10,
      inclusive: false,
      include_locale: true
    });
    expect(() => schema.parse({ limit: 10 })).toThrow();
  });
});
