#!/usr/bin/env node
/**
 * src/index.ts
 *
 * MCP server entry — STDIO transport.
 *
 * Used by:
 *   - Claude Desktop (via claude_desktop_config.json)
 *   - PayBox Desktop / PayBox cloud runtime
 *   - Any MCP host that spawns a child process
 *
 * For ChatGPT (which only supports HTTP MCP), use src/http.ts instead:
 *   node dist/http.js --port=3000
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, TOOLS } from "./server.js";

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr — stdout is reserved for MCP protocol messages.
  console.error(
    `[paybox-kreopoly-lens] MCP stdio server ready. Tools: ${TOOLS.map((t) => t.name).join(", ")}`
  );
}

main().catch((err) => {
  console.error("[paybox-kreopoly-lens] fatal:", err);
  process.exit(1);
});
