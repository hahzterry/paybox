#!/usr/bin/env node
/**
 * src/http.ts
 *
 * MCP server entry — STREAMABLE HTTP transport.
 *
 * Used by:
 *   - ChatGPT (Custom Connectors / Developer Mode) — requires HTTP MCP
 *   - Any MCP host that connects to a remote URL instead of spawning a process
 *
 * Usage:
 *   node dist/http.js                       # default port 3000
 *   node dist/http.js --port=8080           # custom port (with space)
 *   node dist/http.js --port=8080           # custom port (with =)
 *   PORT=8080 node dist/http.js             # via env var
 *
 * Endpoints:
 *   GET  /              → health check + tool list (human-readable JSON)
 *   POST /mcp           → MCP JSON-RPC over HTTP (initialize, tools/list, tools/call, etc.)
 *   GET  /mcp           → SSE stream (server-to-client messages)
 *   DELETE /mcp         → terminate session
 *
 * For local testing with ChatGPT, expose this with a tunnel:
 *   ngrok http 3000
 *   # then add https://<your-ngrok>.ngrok.app/mcp as a Custom MCP server
 *   # in ChatGPT → Settings → Plugins → Add custom MCP server
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createServer, TOOLS } from "./server.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = (() => {
  const argv = process.argv.slice(2);
  const portIdx = argv.indexOf("--port");
  if (portIdx >= 0 && argv[portIdx + 1]) {
    const p = parseInt(argv[portIdx + 1], 10);
    if (!Number.isNaN(p)) return p;
  }
  const eqArg = argv.find((a) => a.startsWith("--port="));
  if (eqArg) {
    const p = parseInt(eqArg.slice("--port=".length), 10);
    if (!Number.isNaN(p)) return p;
  }
  return parseInt(process.env.PORT ?? "3000", 10);
})();

// ---------------------------------------------------------------------------
// Session storage — one transport per active session
// ---------------------------------------------------------------------------

const sessions = new Map<string, StreamableHTTPServerTransport>();

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const httpServer = http.createServer(async (req, res) => {
  // CORS — ChatGPT fetches from chatgpt.com
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Mcp-Session-Id, Last-Event-ID, Authorization"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // --- Health check -------------------------------------------------------
  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify(
        {
          ok: true,
          name: "paybox-kreopoly-lens",
          version: "0.1.0",
          transport: "http",
          endpoints: {
            mcp: "/mcp  (POST for JSON-RPC, GET for SSE, DELETE to close)",
            health: "/health",
          },
          tools: TOOLS.map((t) => t.name),
          toolCount: TOOLS.length,
          activeSessions: sessions.size,
        },
        null,
        2
      )
    );
    return;
  }

  // --- MCP endpoint -------------------------------------------------------
  if (url.pathname === "/mcp") {
    // Check for existing session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      // Read the body once
      const body = await readBody(req);
      let parsed: any;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null,
          })
        );
        return;
      }

      // Initialize request → create a new session
      if (isInitializeRequest(parsed)) {
        const newSessionId = randomUUID();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          onsessioninitialized: (sid) => {
            sessions.set(sid, transport);
          },
        });

        // Clean up when the session closes
        transport.onclose = () => {
          sessions.delete(newSessionId);
        };

        // Create and connect the MCP server
        const server = createServer();
        await server.connect(transport);

        // The transport will read the body itself — but we already read it.
        // Use a synthetic IncomingMessage-like approach: re-inject the body.
        // The MCP SDK's handleRequest signature accepts (req, res, parsedBody?)
        // — passing the parsed body avoids re-reading the stream.
        await transport.handleRequest(req, res, parsed);
        return;
      }

      // Existing session
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res, parsed);
        return;
      }

      // No session and not an initialize request
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "No valid session. Send 'initialize' first.",
          },
          id: parsed.id ?? null,
        })
      );
      return;
    }

    if (req.method === "GET") {
      // SSE stream — must have a valid session
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "No valid session for SSE stream." },
          id: null,
        })
      );
      return;
    }

    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        sessions.delete(sessionId);
        return;
      }
      res.writeHead(404);
      res.end();
      return;
    }

    res.writeHead(405);
    res.end();
    return;
  }

  // --- 404 ---------------------------------------------------------------
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", path: url.pathname }));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  console.error(`[paybox-kreopoly-lens] MCP HTTP server ready.`);
  console.error(`  Health:  http://localhost:${PORT}/`);
  console.error(`  MCP:     http://localhost:${PORT}/mcp`);
  console.error(`  Tools:   ${TOOLS.map((t) => t.name).join(", ")}`);
  console.error(`  CORS:    *`);
});

process.on("SIGTERM", () => {
  httpServer.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  httpServer.close();
  process.exit(0);
});
