/**
 * tools/copyTrade.ts
 *
 * Manage copy-trade tasks: create, list, pause, resume, delete, update.
 *
 * A copy task says: "When wallet X makes a Polymarket trade matching filters,
 * suggest a mirror trade using sizing method S."
 *
 * The plugin does NOT auto-execute. The agent must call
 * kreopoly_check_copy_signals periodically to discover pending mirror trades,
 * then call kreopoly_place_bet (which returns a signing_request for PayBox).
 *
 * This satisfies "ask for confirmation first" at two layers:
 *   1. At task creation: agent walks user through config + confirms
 *   2. At each mirror trade: flows through PayBox's standard signing flow,
 *      respecting approval mode + spend threshold
 */

import { z } from "zod";
import {
  createTask,
  listTasks,
  setEnabled,
  deleteTask,
  updateTask,
  type CreateCopyTaskInput,
  type CopyTask,
  type SizingMethod,
  type TradeDirection,
  type EntryMode,
} from "../lib/copyTasks.js";
import { normalizeCopyTradeArgs, formatZodError } from "../lib/schemaNormalize.js";
import { makeError, ErrorCode } from "../lib/errors.js";

// ---------------------------------------------------------------------------
// Action: create
// ---------------------------------------------------------------------------

const sizingSchema = z
  .object({
    method: z
      .enum(["fixed", "exact", "percent", "portfolio_weighted"])
      .describe("How to size the mirror trade."),
    fixedUsd: z.number().positive().optional(),
    percentOfBalance: z
      .number()
      .gt(0)
      .lte(1)
      .optional()
      .describe("Fraction of wallet balance, e.g. 0.05 = 5%."),
  })
  .describe("Sizing configuration for mirror trades.");

const filtersSchema = z
  .object({
    maxBuyUsd: z.number().positive().optional(),
    minBuyUsd: z.number().positive().optional(),
    dailyCapUsd: z.number().positive().optional(),
    priceRange: z
      .object({
        min: z.number().gte(0).lt(1),
        max: z.number().gt(0).lte(1),
      })
      .optional()
      .describe("Only mirror trades within this price band (0..1)."),
    categories: z.array(z.string()).optional(),
    oneEntryPerMarket: z
      .boolean()
      .default(false)
      .describe("If true, only enter each market once per task."),
  })
  .optional();

const createAction = z.object({
  action: z.literal("create"),
  sourceWallet: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("Polymarket wallet to copy from."),
  label: z.string().max(64).optional(),
  sizing: sizingSchema,
  direction: z
    .enum(["follow_buys", "copy_sells", "buy_on_sells", "counter_trade", "copy_sides"])
    .default("follow_buys")
    .describe("Which source trades to mirror and how."),
  filters: filtersSchema,
  stopLoss: z.number().gte(0).lte(1).optional(),
  takeProfit: z.number().gte(0).lte(1).optional(),
  entryMode: z.enum(["market", "limit"]).default("market"),
  limitMaxPrice: z.number().gt(0).lt(1).optional(),
  limitExpiresAt: z
    .number()
    .int()
    .optional()
    .describe(
      "Unix seconds. For entryMode='limit': after this time, the limit order no longer triggers. " +
        "Mirrors Kreopoly's 'Limit order expiration (by time or exact Unix timestamp)'."
    ),
  enabled: z
    .boolean()
    .default(true)
    .describe("Start copying immediately. Set false to stage without enabling."),
});

// ---------------------------------------------------------------------------
// Action: list
// ---------------------------------------------------------------------------

const listAction = z.object({
  action: z.literal("list"),
  includePaused: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Action: pause / resume
// ---------------------------------------------------------------------------

const pauseAction = z.object({
  action: z.literal("pause"),
  taskId: z.string().uuid().describe("Task id from create/list response."),
});

const resumeAction = z.object({
  action: z.literal("resume"),
  taskId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Action: delete
// ---------------------------------------------------------------------------

const deleteAction = z.object({
  action: z.literal("delete"),
  taskId: z.string().uuid(),
});

// ---------------------------------------------------------------------------
// Action: update
// ---------------------------------------------------------------------------

const updateAction = z.object({
  action: z.literal("update"),
  taskId: z.string().uuid(),
  label: z.string().max(64).optional(),
  sizing: sizingSchema.optional(),
  direction: z
    .enum(["follow_buys", "copy_sells", "buy_on_sells", "counter_trade", "copy_sides"])
    .optional(),
  filters: filtersSchema,
  stopLoss: z.number().gte(0).lte(1).optional(),
  takeProfit: z.number().gte(0).lte(1).optional(),
  entryMode: z.enum(["market", "limit"]).optional(),
  limitMaxPrice: z.number().gt(0).lt(1).optional(),
  limitExpiresAt: z.number().int().optional(),
});

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

export const copyTradeSchema = z.discriminatedUnion("action", [
  createAction,
  listAction,
  pauseAction,
  resumeAction,
  deleteAction,
  updateAction,
]);

export type CopyTradeArgs = z.infer<typeof copyTradeSchema>;

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const copyTradeTool = {
  name: "kreopoly_copy_trade",
  description:
    "[READ + LOCAL WRITE] [NO BLOCKCHAIN] [NO SIGNATURE] [NO FUND MOVEMENT] " +
    "Manage copy-trade tasks (Kreopoly's headline feature). Actions: " +
    "create (set up a new copy task with sizing, filters, direction, SL/TP, entry mode), " +
    "list (show all tasks), pause (stop copying), resume (restart), delete, update. " +
    "Does NOT execute mirror trades — use kreopoly_check_copy_signals to discover " +
    "pending mirrors, then kreopoly_place_bet to execute (returns a signing_request " +
    "for PayBox). The user must confirm task creation and approve each mirror trade " +
    "through PayBox's standard signing flow. " +
    "Aliases accepted: walletAddress/address/userWalletAddress → sourceWallet; " +
    "sizing.mode → sizing.method; sizing.amountUsd/sizing.amount → sizing.fixedUsd.",
  inputSchema: copyTradeSchema,
  handler: async (args: CopyTradeArgs, ctx: { userId: string }) => {
    const userId = ctx.userId || "anonymous";

    switch (args.action) {
      case "create": {
        const input: CreateCopyTaskInput = {
          sourceWallet: args.sourceWallet,
          label: args.label,
          sizing: {
            method: args.sizing.method as SizingMethod,
            fixedUsd: args.sizing.fixedUsd,
            percentOfBalance: args.sizing.percentOfBalance,
          },
          direction: args.direction as TradeDirection,
          filters: args.filters
            ? {
                maxBuyUsd: args.filters.maxBuyUsd,
                minBuyUsd: args.filters.minBuyUsd,
                dailyCapUsd: args.filters.dailyCapUsd,
                priceRange: args.filters.priceRange,
                categories: args.filters.categories,
                oneEntryPerMarket: args.filters.oneEntryPerMarket,
              }
            : undefined,
          stopLoss: args.stopLoss,
          takeProfit: args.takeProfit,
          entryMode: args.entryMode as EntryMode,
          limitMaxPrice: args.limitMaxPrice,
          limitExpiresAt: args.limitExpiresAt,
          enabled: args.enabled,
        };
        try {
          const task = await createTask(userId, input);
          return {
            ok: true,
            action: "created",
            task: summarizeTask(task),
            message:
              `Copy task created${task.enabled ? " and ACTIVE" : " (staged — call action='resume' to start)"}. ` +
              `Source: ${task.sourceWallet}. ` +
              `The agent should now periodically call kreopoly_check_copy_signals to detect new trades. ` +
              `When a signal is actionable, call kreopoly_place_bet with the suggested mirror trade. ` +
              `Tell the user: "Now copying ${task.label}. Say 'stop' to pause."`,
            next_step:
              "Periodically call kreopoly_check_copy_signals for this task. " +
              "On actionable signals, present the cost to the user and call kreopoly_place_bet.",
          };
        } catch (err: any) {
          return makeError(
            ErrorCode.INVALID_PARAMETERS,
            err.message ?? "Failed to create copy task.",
            { retryable: false }
          );
        }
      }

      case "list": {
        const tasks = await listTasks(userId);
        const filtered = args.includePaused ? tasks : tasks.filter((t) => t.enabled);
        return {
          ok: true,
          action: "list",
          count: filtered.length,
          tasks: filtered.map(summarizeTask),
        };
      }

      case "pause": {
        try {
          const task = await setEnabled(userId, args.taskId, false);
          return {
            ok: true,
            action: "paused",
            task: summarizeTask(task),
            message: `Copy task "${task.label}" paused. No new mirror trades will be suggested. Call action='resume' to restart.`,
          };
        } catch (err: any) {
          return makeError(
            ErrorCode.TASK_NOT_FOUND,
            err.message ?? `Task ${args.taskId} not found.`,
            { retryable: false }
          );
        }
      }

      case "resume": {
        try {
          const task = await setEnabled(userId, args.taskId, true);
          return {
            ok: true,
            action: "resumed",
            task: summarizeTask(task),
            message: `Copy task "${task.label}" resumed. Agent will suggest mirror trades on new source-wallet activity.`,
          };
        } catch (err: any) {
          return makeError(
            ErrorCode.TASK_NOT_FOUND,
            err.message ?? `Task ${args.taskId} not found.`,
            { retryable: false }
          );
        }
      }

      case "delete": {
        const deleted = await deleteTask(userId, args.taskId);
        if (!deleted) {
          return makeError(
            ErrorCode.TASK_NOT_FOUND,
            `Task ${args.taskId} not found.`,
            { retryable: false }
          );
        }
        return {
          ok: true,
          action: "deleted",
          message: `Task ${args.taskId} deleted.`,
        };
      }

      case "update": {
        const patch: Partial<CopyTask> = {};
        if (args.label !== undefined) patch.label = args.label;
        if (args.sizing) {
          patch.sizing = {
            method: args.sizing.method as SizingMethod,
            fixedUsd: args.sizing.fixedUsd,
            percentOfBalance: args.sizing.percentOfBalance,
          };
        }
        if (args.direction) patch.direction = args.direction as TradeDirection;
        if (args.filters) {
          patch.filters = {
            maxBuyUsd: args.filters.maxBuyUsd,
            minBuyUsd: args.filters.minBuyUsd,
            dailyCapUsd: args.filters.dailyCapUsd,
            priceRange: args.filters.priceRange,
            categories: args.filters.categories ?? [],
            oneEntryPerMarket: args.filters.oneEntryPerMarket,
            enteredMarkets: [],
          };
        }
        if (args.stopLoss !== undefined) patch.stopLoss = args.stopLoss;
        if (args.takeProfit !== undefined) patch.takeProfit = args.takeProfit;
        if (args.entryMode) patch.entryMode = args.entryMode as EntryMode;
        if (args.limitMaxPrice !== undefined) patch.limitMaxPrice = args.limitMaxPrice;
        if (args.limitExpiresAt !== undefined) patch.limitExpiresAt = args.limitExpiresAt;

        try {
          const task = await updateTask(userId, args.taskId, patch);
          return {
            ok: true,
            action: "updated",
            task: summarizeTask(task),
          };
        } catch (err: any) {
          return makeError(
            ErrorCode.TASK_NOT_FOUND,
            err.message ?? `Task ${args.taskId} not found.`,
            { retryable: false }
          );
        }
      }
    }
  },
};

function summarizeTask(t: CopyTask) {
  return {
    id: t.id,
    label: t.label,
    sourceWallet: t.sourceWallet,
    enabled: t.enabled,
    direction: t.direction,
    sizing: t.sizing,
    entryMode: t.entryMode,
    limitMaxPrice: t.limitMaxPrice,
    limitExpiresAt: t.limitExpiresAt,
    filters: {
      ...t.filters,
      enteredMarkets: t.filters.enteredMarkets.length,
    },
    stopLoss: t.stopLoss,
    takeProfit: t.takeProfit,
    spentToday: t.spentToday,
    createdAt: t.createdAt,
    lastCheckedAt: t.lastCheckedAt,
    lastCopiedTxHash: t.lastCopiedTxHash,
  };
}
