/**
 * tools/checkCopySignals.ts
 *
 * Polls all (or one) copy task's source wallet for new activity and returns
 * any pending mirror-trade signals. The agent should call this periodically
 * (e.g. every 30–60 seconds during a demo, or on user prompt).
 *
 * For each actionable signal, the agent should:
 *   1. Read the suggested mirror trade (shares, maxPrice, outcome)
 *   2. Resolve the conditionId (Polymarket Data API for source wallet's latest position)
 *   3. Present the cost breakdown to the user
 *   4. Call kreopoly_place_bet to get a signing_request
 *   5. Forward to PayBox's request_wallet_sign
 *
 * The plugin does NOT auto-execute — the agent orchestrates each mirror.
 */

import { z } from "zod";
import { listTasks, checkTaskForSignals, getTask } from "../lib/copyTasks.js";
import { getUsdcEBalance } from "../lib/polygon.js";

export const checkCopySignalsSchema = z.object({
  /** If provided, check only this task. If omitted, check all enabled tasks. */
  taskId: z
    .string()
    .uuid()
    .optional()
    .describe("Optional: check only this task. Omit to check all enabled tasks."),
  /** Optional: the user's Polygon wallet address (for sizing methods that need balance). */
  userWalletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .optional()
    .describe(
      "User's Polygon wallet (for sizing methods 'percent' or 'portfolio_weighted'). " +
        "Omit for 'fixed' or 'exact' sizing."
    ),
});

export type CheckCopySignalsArgs = z.infer<typeof checkCopySignalsSchema>;

export const checkCopySignalsTool = {
  name: "kreopoly_check_copy_signals",
  description:
    "Poll copy tasks for new source-wallet activity and return pending mirror-trade signals. " +
    "Call periodically. For each actionable signal: resolve conditionId via Polymarket " +
    "Data API, present cost to user, then call kreopoly_place_bet → PayBox request_wallet_sign. " +
    "Free read (rate-limited by Polygonscan).",
  inputSchema: checkCopySignalsSchema,
  handler: async (args: CheckCopySignalsArgs, ctx: { userId: string }) => {
    const userId = ctx.userId || "anonymous";

    let tasks;
    if (args.taskId) {
      const t = await getTask(userId, args.taskId);
      tasks = t ? [t] : [];
    } else {
      tasks = await listTasks(userId);
    }

    if (tasks.length === 0) {
      return {
        ok: false,
        message:
          "No copy tasks found. Use kreopoly_copy_trade action='create' to set one up.",
      };
    }

    // Compute user wallet balance if needed for sizing
    let userBalanceUsd = 0;
    if (args.userWalletAddress) {
      const balStr = await getUsdcEBalance(args.userWalletAddress).catch(() => "0");
      userBalanceUsd = Number(balStr);
    }

    const allSignals = [];
    const errors = [];

    for (const task of tasks) {
      try {
        const signals = await checkTaskForSignals(userId, task, userBalanceUsd);
        allSignals.push(...signals);
      } catch (err: any) {
        errors.push({
          taskId: task.id,
          taskLabel: task.label,
          error: err.message,
        });
      }
    }

    const actionable = allSignals.filter((s) => s.actionable);

    return {
      ok: true,
      checkedTasks: tasks.length,
      totalSignals: allSignals.length,
      actionableSignals: actionable.length,
      signals: allSignals,
      errors: errors.length > 0 ? errors : undefined,
      hint:
        actionable.length > 0
          ? `${actionable.length} actionable signal(s). For each: (1) resolve conditionId via Polymarket Data API for source wallet's latest position, (2) present cost to user, (3) call kreopoly_place_bet, (4) forward signing_request to PayBox request_wallet_sign.`
          : allSignals.length === 0
            ? "No signals — no new source activity. Try again in 30–60s."
            : undefined,
    };
  },
};
