/**
 * tools/checkCopySignals.ts
 *
 * READ-ONLY: polls copy tasks for new source-wallet activity and returns
 * pending mirror-trade signals along with detailed funnel diagnostics.
 *
 * Does NOT sign, does NOT transact, does NOT move funds. Returns signals
 * that the agent should evaluate; if actionable, the agent calls
 * kreopoly_place_bet (which returns a signing_request for PayBox).
 *
 * CRITICAL: Returns ok=false with a structured error if the upstream
 * activity fetch fails. Never reports "no signals" when the upstream
 * actually failed.
 */

import { z } from "zod";
import {
  listTasks,
  checkTaskForSignals,
  getTask,
  type SignalCheckResult,
  type CopyTask,
} from "../lib/copyTasks.js";
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
        "Omit for 'fixed' or 'exact' sizing. Read-only — public balance check, no signing."
    ),
});

export type CheckCopySignalsArgs = z.infer<typeof checkCopySignalsSchema>;

export const checkCopySignalsTool = {
  name: "kreopoly_check_copy_signals",
  description:
    "[READ-ONLY] [NO SIGNATURE] [NO TRANSACTION] [NO FUND MOVEMENT] " +
    "Poll copy tasks for new source-wallet activity and return pending mirror-trade " +
    "signals with detailed funnel diagnostics. Read-only — reads public on-chain " +
    "data via Polygonscan/Polymarket API, no signing, no fund movement. " +
    "For each actionable signal: resolve conditionId via Polymarket Data API, " +
    "present cost to user, then call kreopoly_place_bet → PayBox request_wallet_sign. " +
    "If upstream activity fetch fails, returns ok=false with the error — do NOT " +
    "treat as 'no signals'.",
  inputSchema: checkCopySignalsSchema,
  handler: async (args: CheckCopySignalsArgs, ctx: { userId: string }) => {
    const userId = ctx.userId || "anonymous";

    let tasks: CopyTask[];
    if (args.taskId) {
      const t = await getTask(userId, args.taskId);
      tasks = t ? [t] : [];
    } else {
      tasks = await listTasks(userId);
    }

    if (tasks.length === 0) {
      return {
        ok: true,
        checkedTasks: 0,
        results: [],
        hint:
          "No copy tasks found. Use kreopoly_copy_trade action='create' to set one up.",
      };
    }

    // Compute user wallet balance if needed for sizing
    let userBalanceUsd = 0;
    if (args.userWalletAddress) {
      const balStr = await getUsdcEBalance(args.userWalletAddress).catch(() => "0");
      userBalanceUsd = Number(balStr);
    }

    // Run each task's signal check, preserving task ID even when signals is empty
    const taskResults: Array<{
      task: { id: string; label: string; sourceWallet: string; enabled: boolean };
      check: SignalCheckResult;
    }> = [];

    for (const task of tasks) {
      const check = await checkTaskForSignals(userId, task, userBalanceUsd);
      taskResults.push({
        task: {
          id: task.id,
          label: task.label,
          sourceWallet: task.sourceWallet,
          enabled: task.enabled,
        },
        check,
      });
    }

    const totalSignals = taskResults.reduce(
      (s, tr) => s + (tr.check.ok ? tr.check.signals.length : 0),
      0
    );
    const actionableSignals = taskResults.reduce(
      (s, tr) =>
        s +
        (tr.check.ok
          ? tr.check.signals.filter((sig) => sig.actionable).length
          : 0),
      0
    );
    const failedTasks = taskResults.filter((tr) => !tr.check.ok).length;

    return {
      ok: true,
      checkedTasks: taskResults.length,
      failedTasks,
      totalSignals,
      actionableSignals,
      results: taskResults.map((tr) => ({
        task: tr.task,
        ok: tr.check.ok,
        checkedAt: tr.check.checkedAt,
        checkedFrom: tr.check.checkedFrom,
        checkedUntil: tr.check.checkedUntil,
        lastCheckedAtBefore: tr.check.lastCheckedAtBefore,
        lastCheckedAtAfter: tr.check.lastCheckedAtAfter,
        signals: tr.check.ok ? tr.check.signals : [],
        funnel: tr.check.funnel,
        error: tr.check.ok ? undefined : tr.check.error,
      })),
      hint:
        actionableSignals > 0
          ? `${actionableSignals} actionable signal(s). For each: (1) resolve conditionId via Polymarket Data API for source wallet's latest position, (2) present cost to user, (3) call kreopoly_place_bet, (4) forward signing_request to PayBox request_wallet_sign.`
          : failedTasks > 0
            ? `${failedTasks} task(s) failed to fetch activity — see per-task error fields. Do NOT treat as "no signals".`
            : totalSignals === 0
              ? "No signals — see per-task funnel for rejection reasons. Upstream confirmed OK."
              : undefined,
    };
  },
};
