/**
 * src/server.ts
 *
 * Creates and configures the MCP server instance with all 8 tools registered.
 * Transport-agnostic — used by both src/index.ts (stdio) and src/http.ts (HTTP).
 *
 * Exports:
 *   - createServer(): returns a connected Server instance ready to be attached
 *     to any transport (Stdio, StreamableHTTP, SSE).
 *   - TOOLS: the registered tool definitions (for introspection / health check).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "./lib/zodToJsonSchema.js";

import { getPositionsTool, getPositionsSchema } from "./tools/getPositions.js";
import { trackWalletTool, trackWalletSchema } from "./tools/trackWallet.js";
import {
  getTrackedActivityTool,
  getTrackedActivitySchema,
} from "./tools/getTrackedActivity.js";
import { placeBetTool, placeBetSchema } from "./tools/placeBet.js";
import { copyTradeTool, copyTradeSchema } from "./tools/copyTrade.js";
import {
  checkCopySignalsTool,
  checkCopySignalsSchema,
} from "./tools/checkCopySignals.js";
import { settlePositionTool, settlePositionSchema } from "./tools/settlePosition.js";
import {
  listCategoriesTool,
  listCategoriesSchema,
} from "./tools/listCategories.js";

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  description: string;
  schema: any; // Zod schema
  handler: (args: any, ctx: { userId: string }) => Promise<any>;
}

export const TOOLS: ToolDef[] = [
  {
    name: getPositionsTool.name,
    description: getPositionsTool.description,
    schema: getPositionsSchema,
    handler: getPositionsTool.handler,
  },
  {
    name: trackWalletTool.name,
    description: trackWalletTool.description,
    schema: trackWalletSchema,
    handler: trackWalletTool.handler,
  },
  {
    name: getTrackedActivityTool.name,
    description: getTrackedActivityTool.description,
    schema: getTrackedActivitySchema,
    handler: getTrackedActivityTool.handler,
  },
  {
    name: placeBetTool.name,
    description: placeBetTool.description,
    schema: placeBetSchema,
    handler: placeBetTool.handler,
  },
  {
    name: copyTradeTool.name,
    description: copyTradeTool.description,
    schema: copyTradeSchema,
    handler: copyTradeTool.handler,
  },
  {
    name: checkCopySignalsTool.name,
    description: checkCopySignalsTool.description,
    schema: checkCopySignalsSchema,
    handler: checkCopySignalsTool.handler,
  },
  {
    name: settlePositionTool.name,
    description: settlePositionTool.description,
    schema: settlePositionSchema,
    handler: settlePositionTool.handler,
  },
  {
    name: listCategoriesTool.name,
    description: listCategoriesTool.description,
    schema: listCategoriesSchema,
    handler: listCategoriesTool.handler,
  },
];

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(): Server {
  const server = new Server(
    { name: "paybox-kreopoly-lens", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  // --- List tools -------------------------------------------------------
  server.setRequestHandler(
    ListToolsRequestSchema,
    async (_req: ListToolsRequest) => {
      return {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: zodToJsonSchema(t.schema),
        })),
      };
    }
  );

  // --- Call tool --------------------------------------------------------
  server.setRequestHandler(
    CallToolRequestSchema,
    async (req: CallToolRequest) => {
      const name = req.params.name;
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const ctx = {
        // PayBox passes the user id via the _meta context. Fall back to env.
        userId:
          (req.params as any)?._meta?.user_id ??
          process.env.PAYBOX_USER_ID ??
          "anonymous",
      };

      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}. Available: ${TOOLS.map((t) => t.name).join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      const parsed = tool.schema.safeParse(args);
      if (!parsed.success) {
        return {
          content: [
            {
              type: "text",
              text: `Invalid arguments: ${parsed.error.message}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await tool.handler(parsed.data, ctx);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
          structuredContent: result,
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `Tool ${name} failed: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}
