/**
 * lib/zodToJsonSchema.ts
 *
 * Tiny Zod → JSON Schema converter for the MCP tool inputSchema field.
 *
 * The official @smithy/zod-to-json-schema package works but pulls in a heavy
 * dependency tree. For this plugin we only use z.object, z.string, z.number,
 * z.boolean, z.literal, z.enum, z.discriminatedUnion, and z.default — all of
 * which we can convert by hand in ~80 lines.
 */

import { z, type ZodTypeAny } from "zod";

export function zodToJsonSchema(schema: ZodTypeAny): any {
  // Discriminated union
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const options = schema.options as ZodTypeAny[];
    return {
      type: "object",
      oneOf: options.map((o) => zodToJsonSchema(o)),
      discriminator: { propertyName: "action" },
    };
  }
  // Union
  if (schema instanceof z.ZodUnion) {
    return { anyOf: schema.options.map((o: ZodTypeAny) => zodToJsonSchema(o)) };
  }
  // Object
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, ZodTypeAny>;
    const properties: Record<string, any> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      if (!value.isOptional()) required.push(key);
    }
    return {
      type: "object",
      properties,
      required: required.length > 0 ? required : undefined,
      additionalProperties: false,
    };
  }
  // String
  if (schema instanceof z.ZodString) {
    const out: any = { type: "string" };
    const checks = (schema as any)._def.checks ?? [];
    for (const c of checks) {
      if (c.kind === "regex") out.pattern = c.regex.source;
      if (c.kind === "min") out.minLength = c.value;
      if (c.kind === "max") out.maxLength = c.value;
    }
    if ((schema as any).description) out.description = (schema as any).description;
    return out;
  }
  // Number
  if (schema instanceof z.ZodNumber) {
    const out: any = { type: "number" };
    const checks = (schema as any)._def.checks ?? [];
    for (const c of checks) {
      if (c.kind === "min") out.minimum = c.value;
      if (c.kind === "max") out.maximum = c.value;
      if (c.kind === "int") out.type = "integer";
    }
    if ((schema as any).description) out.description = (schema as any).description;
    return out;
  }
  // Boolean
  if (schema instanceof z.ZodBoolean) {
    return { type: "boolean", description: (schema as any).description };
  }
  // Literal
  if (schema instanceof z.ZodLiteral) {
    return { const: schema.value };
  }
  // Enum
  if (schema instanceof z.ZodEnum) {
    return { type: "string", enum: schema.options };
  }
  // Default (unwraps inner type)
  if (schema instanceof z.ZodDefault) {
    return zodToJsonSchema(schema.removeDefault());
  }
  // Optional (unwraps inner type)
  if (schema instanceof z.ZodOptional) {
    return zodToJsonSchema(schema.unwrap());
  }
  // Array
  if (schema instanceof z.ZodArray) {
    return { type: "array", items: zodToJsonSchema(schema.element) };
  }
  // Fallback
  return {};
}
