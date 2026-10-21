#!/usr/bin/env node
/**
 * src/http.ts — Kreopoly Lens HTTP MCP Server
 *
 * Handles MCP JSON-RPC over HTTP with proper session management
 * and JSON Schema conversion for tool schemas.
 *
 * ChatGPT connects to https://your-app.onrender.com/mcp
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { createServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Create the MCP server instance
const mcpServer = createServer();

// Session management
let sessionInitialized = false;
let sessionId: string | null = null;

// Extract tool definitions and convert Zod schemas to JSON Schema
function getToolList() {
  const tools = (mcpServer as any)._registeredTools ?? {};
  const toolList = [];
  for (const [name, def] of Object.entries(tools)) {
    const d = def as any;
    // Convert Zod schema to JSON Schema if needed
    let inputSchema = d.inputSchema;
    // If it's a Zod schema (has _def), convert it
    if (inputSchema && inputSchema._def) {
      inputSchema = zodToJsonSchema(inputSchema);
    }
    // If inputSchema is missing or not a plain object, default to empty
    if (!inputSchema || typeof inputSchema !== 'object' || inputSchema._def) {
      inputSchema = { type: "object", properties: {}, additionalProperties: true };
    }
    toolList.push({
      name,
      description: d.description ?? "",
      inputSchema,
    });
  }
  return toolList;
}

// Minimal Zod-to-JSON-Schema converter
function zodToJsonSchema(schema: any): any {
  if (!schema || !schema._def) return schema;

  const def = schema._def;
  const typeName = def.typeName || def.constructor?.name || '';

  // ZodObject
  if (def.shape) {
    const shape = typeof def.shape === 'function' ? def.shape() : def.shape;
    const properties: any = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(value);
      // Check if required (not optional)
      const vDef = (value as any)?._def;
      if (vDef && vDef.typeName !== 'ZodOptional' && vDef.typeName !== 'ZodDefault') {
        required.push(key);
      }
    }
    const result: any = { type: "object", properties };
    if (required.length > 0) result.required = required;
    // Check for strict/passthrough
    if (def.catchall && def.catchall._def) {
      const ca = def.catchall._def;
      if (ca.typeName === 'ZodNever' || (ca.typeName === 'ZodLiteral' && ca.value === undefined)) {
        result.additionalProperties = false;
      } else {
        result.additionalProperties = true;
      }
    } else {
      result.additionalProperties = true;
    }
    return result;
  }

  // ZodString
  if (typeName === 'ZodString' || def.checks !== undefined) {
    const result: any = { type: "string" };
    if (def.checks) {
      for (const check of def.checks) {
        if (check.kind === 'regex') result.pattern = check.regex?.source;
        if (check.kind === 'min') result.minLength = check.value;
        if (check.kind === 'max') result.maxLength = check.value;
      }
    }
    return result;
  }

  // ZodNumber
  if (typeName === 'ZodNumber') {
    const result: any = { type: "number" };
    if (def.checks) {
      for (const check of def.checks) {
        if (check.kind === 'min') result.minimum = check.value;
        if (check.kind === 'max') result.maximum = check.value;
        if (check.kind === 'int') result.type = "integer";
      }
    }
    return result;
  }

  // ZodBoolean
  if (typeName === 'ZodBoolean') return { type: "boolean" };

  // ZodEnum / ZodLiteral
  if (typeName === 'ZodEnum') return { type: "string", enum: def.values };
  if (typeName === 'ZodLiteral') return { const: def.value };

  // ZodArray
  if (typeName === 'ZodArray') return { type: "array", items: zodToJsonSchema(def.element) };

  // ZodOptional
  if (typeName === 'ZodOptional') return zodToJsonSchema(def.innerType);

  // ZodDefault
  if (typeName === 'ZodDefault') {
    const s = zodToJsonSchema(def.innerType);
    return { ...s, default: def.defaultValue };
  }

  // ZodDiscriminatedUnion
  if (typeName === 'ZodDiscriminatedUnion' || (def.options && def.discriminator !== undefined)) {
    const options = def.options || [];
    if (Array.isArray(options)) {
      // Try to merge into a single schema with oneOf
      const schemas = options.map((o: any) => zodToJsonSchema(o));
      // If all are objects, merge properties
      if (schemas.every((s: any) => s.type === 'object' && s.properties)) {
        const allProps: any = {};
        for (const s of schemas) {
          Object.assign(allProps, s.properties);
        }
        return {
          type: 'object',
          properties: allProps,
          oneOf: schemas,
          additionalProperties: true,
        };
      }
      return { oneOf: schemas };
    }
    return { oneOf: options.map((o: any) => zodToJsonSchema(o)) };
  }

  // ZodUnion
  if (typeName === 'ZodUnion' || (def.options && def.discriminator === undefined)) {
    const options = def.options || [];
    if (Array.isArray(options)) {
      return { anyOf: options.map((o: any) => zodToJsonSchema(o)) };
    }
    return { anyOf: [] };
  }

  // Fallback
  return { type: "object", properties: {}, additionalProperties: true };
}

// Parse tool arguments, applying defaults
function parseToolArgs(toolDef: any, args: any): any {
  const schema = toolDef?.inputSchema;
  if (!schema || !schema._def) return args;

  const shape = schema._def.shape;
  if (!shape) return args;

  const shapeObj = typeof shape === 'function' ? shape() : shape;
  const result = { ...args };

  for (const [key, value] of Object.entries(shapeObj)) {
    const v = value as any;
    const vDef = v?._def;

    // Apply defaults
    if (vDef?.typeName === 'ZodDefault' && result[key] === undefined) {
      result[key] = vDef.defaultValue;
    }

    // Unwrap optional
    if (vDef?.typeName === 'ZodOptional' && result[key] !== undefined) {
      // Value is present — validate the inner type
    }
  }

  return result;
}

const httpServer = http.createServer(async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, Authorization");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      name: "kreopoly-lens",
      version: "0.5.0",
      transport: "http",
      mcpEndpoint: "/mcp",
      toolCount: 17,
    }, null, 2));
    return;
  }

  // MCP endpoint
  if (url.pathname === "/mcp" && req.method === "POST") {
    const body = await readBody(req);
    let msg: any;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
      return;
    }

    const method = msg.method;
    const id = msg.id;
    const params = msg.params ?? {};

    try {
      // initialize
      if (method === "initialize") {
        sessionId = randomUUID();
        sessionInitialized = true;
        res.setHeader("Mcp-Session-Id", sessionId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "kreopoly-lens", version: "0.5.0" },
          },
        }));
        return;
      }

      // notifications/initialized
      if (method === "notifications/initialized") {
        res.writeHead(200);
        res.end();
        return;
      }

      // tools/list
      if (method === "tools/list") {
        const toolList = getToolList();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { tools: toolList },
        }));
        return;
      }

      // tools/call
      if (method === "tools/call") {
        const toolName = params.name;
        const toolArgs = params.arguments ?? {};

        const tools = (mcpServer as any)._registeredTools ?? {};
        const toolDef = tools[toolName] as any;

        if (!toolDef) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
              isError: true,
            },
          }));
          return;
        }

        try {
          // Apply defaults to args
          const parsedArgs = parseToolArgs(toolDef, toolArgs);

          // Call the handler
          const handler = toolDef.handler ?? toolDef.callback ?? toolDef.fn;
          if (!handler) throw new Error(`Tool ${toolName} has no handler`);

          const result = await handler(parsedArgs, { userId: "anonymous" });

          // Ensure result is JSON-safe
          const safeResult = JSON.parse(JSON.stringify(result, (key, value) => {
            if (typeof value === 'bigint') return value.toString();
            if (value === undefined) return null;
            return value;
          }));

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: safeResult,
          }));
        } catch (err: any) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: `Tool error: ${err.message}` }],
              isError: true,
            },
          }));
        }
        return;
      }

      // ping
      if (method === "ping") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
        return;
      }

      // Unknown method
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      }));
    } catch (err: any) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Internal error: ${err.message}` },
      }));
    }
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", path: url.pathname }));
});

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) { reject(new Error("Body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

httpServer.listen(PORT, () => {
  console.log(`[kreopoly-lens] MCP HTTP server ready.`);
  console.log(`  Health:  http://localhost:${PORT}/`);
  console.log(`  MCP:     http://localhost:${PORT}/mcp`);
});

process.on("SIGTERM", () => { httpServer.close(); process.exit(0); });
process.on("SIGINT", () => { httpServer.close(); process.exit(0); });
