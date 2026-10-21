#!/usr/bin/env node
/**
 * src/http.ts — Kreopoly Lens HTTP MCP Server (raw JSON-RPC)
 *
 * Simple HTTP server that handles MCP JSON-RPC over HTTP.
 * No SDK HTTP transport dependency — just raw request/response.
 *
 * ChatGPT connects to https://your-app.onrender.com/mcp
 */

import http from "node:http";
// @ts-ignore — import from server.ts which exports createServer
import { createServer } from "./server.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);

// Create the MCP server instance
const mcpServer = createServer();

// Store connected sessions (simple in-memory)
let initialized = false;

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

  // MCP endpoint — handle POST with JSON-RPC
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

    // Handle the JSON-RPC message using the MCP server
    // The MCP SDK v2 Server has a built-in request handler
    // We need to use the internal transport mechanism
    // Simplest: use InMemoryTransport to connect and forward

    // Actually, let's use a simpler approach — directly handle the common methods
    const method = msg.method;
    const id = msg.id;
    const params = msg.params ?? {};

    try {
      // Add _meta for protocol version
      const enrichedParams = {
        ...params,
        _meta: params._meta ?? {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "http-client", version: "1.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      };

      // Use the server's internal request handling
      // The MCP SDK v2 Server can handle requests via setRequestHandler
      // but we need to invoke it directly. Let's use a different approach.

      // Since createServer() returns a McpServer that's already configured with
      // request handlers, we can send JSON-RPC messages through its internal
      // transport. Let's use InMemoryTransport for this.

      // Actually, the simplest approach: the McpServer extends Server which
      // has a _requestHandler map. We can call server.handleRequest() directly.
      // But that's internal API.

      // Let's just use a raw approach — handle the 3 methods we need:
      // tools/list, tools/call, initialize

      if (method === "initialize") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2026-07-28",
            capabilities: { tools: {} },
            serverInfo: { name: "kreopoly-lens", version: "0.5.0" },
          },
        }));
        initialized = true;
        return;
      }

      if (method === "notifications/initialized") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (method === "tools/list") {
        // Get tools from the server's registered tools registry
        const tools = (mcpServer as any)._registeredTools ?? {};
        const toolList = [];
        for (const [name, def] of Object.entries(tools)) {
          const d = def as any;
          toolList.push({
            name,
            description: d.description,
            inputSchema: d.inputSchema ?? d.schema ?? { type: "object", properties: {} },
          });
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { tools: toolList },
        }));
        return;
      }

      if (method === "tools/call") {
        const toolName = params.name;
        const toolArgs = params.arguments ?? {};

        // Find the tool and call it
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
          // Call the tool handler — the handler is in toolDef.handler or toolDef.callback
          const handler = toolDef.handler ?? toolDef.callback ?? toolDef.fn;
          if (!handler) {
            throw new Error(`Tool ${toolName} has no handler`);
          }
          const result = await handler(toolArgs, { userId: "anonymous" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            id,
            result,
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
