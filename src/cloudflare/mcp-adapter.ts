import { z } from "zod";
import type { JsonObjectSchema } from "../slack/tool-catalog.js";

export function readSlackMcpConnectionId(props: Record<string, unknown> | undefined): string | null {
  if (typeof props?.connectionId === "string" && props.connectionId.trim().length > 0) {
    return props.connectionId;
  }
  return null;
}

export function jsonSchemaToZodObject(schema: JsonObjectSchema) {
  const required = new Set(schema.required ?? []);
  const shape: Record<string, z.ZodType> = {};
  for (const [fieldName, fieldSchema] of Object.entries(schema.properties)) {
    const zodFieldSchema = zodSchemaForJsonField(fieldSchema);
    shape[fieldName] = required.has(fieldName) ? zodFieldSchema : zodFieldSchema.optional();
  }

  const objectSchema = z.object(shape);
  return schema.additionalProperties === false ? objectSchema : objectSchema.passthrough();
}

function zodSchemaForJsonField(fieldSchema: unknown): z.ZodType {
  if (typeof fieldSchema !== "object" || fieldSchema === null) {
    return z.unknown();
  }
  const schema = fieldSchema as { readonly type?: unknown; readonly description?: unknown };
  let zodFieldSchema: z.ZodType;
  switch (schema.type) {
    case "string":
      zodFieldSchema = z.string();
      break;
    case "number":
    case "integer":
      zodFieldSchema = z.number();
      break;
    case "boolean":
      zodFieldSchema = z.boolean();
      break;
    case "array":
      zodFieldSchema = z.array(z.unknown());
      break;
    case "object":
      zodFieldSchema = z.record(z.string(), z.unknown());
      break;
    default:
      zodFieldSchema = z.unknown();
      break;
  }

  return typeof schema.description === "string"
    ? zodFieldSchema.describe(schema.description)
    : zodFieldSchema;
}
