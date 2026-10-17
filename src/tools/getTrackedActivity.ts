/**
 * tools/getTrackedActivity.ts
 *
 * READ-ONLY: fetches recent on-chain Polymarket activity for every wallet in
 * the user's watchlist. Mirrors Kreopoly's wallet-alert feature.
 *
 * Does NOT sign, does NOT transact, does NOT require wallet permission.
 * Reads public Polygon blockchain data via Polygonscan + Polymarket Data API.
 *
 * CRITICAL: If the upstream provider fails for a wallet, that wallet's
 * `error` field is populated and `activity` is empty — but the overall
 * response still returns ok=true IF at least one wallet succeeded. If ALL
 * wallets fail, returns ok=false with the most informative error.
 */

import { z } from "zod";
import { listWallets } from "../lib/store.js";
import { getWalletActivity } from "../lib/polygon.js";
import { makeError, ErrorCode, type ToolError } from "../lib/errors.js";

export const getTrackedActivitySchema = z.object({
  /** Max activities to return per wallet (default 5) */
  perWallet: z.number().int().min(1).max(50).default(5),
  /** Only include activity newer than this (Unix seconds). Default: 24h ago. */
  sinceSeconds: z
    .number()
    .int()
    .default(86_400)
    .describe("Only show activity newer than this many seconds ago. Default 24h."),
});

export type GetTrackedActivityArgs = z.infer<typeof getTrackedActivitySchema>;

export const getTrackedActivityTool = {
  name: "kreopoly_get_tracked_activity",
  description:
    "[READ-ONLY] [NO SIGNATURE] [NO TRANSACTION] [NO FUND MOVEMENT] " +
    "Fetch recent Polymarket activity for every wallet in the user's watchlist. " +
    "Reads public on-chain data via Polygonscan (with Polymarket Data API fallback). " +
    "If a wallet's upstream fetch fails, that wallet's `error` field is populated — " +
    "do NOT treat empty `activity` as 'no trades' without checking `error` first.",
  inputSchema: getTrackedActivitySchema,
  handler: async (
    args: GetTrackedActivityArgs,
    ctx: { userId: string }
  ) => {
    const userId = ctx.userId || "anonymous";
    const wallets = await listWallets(userId);

    if (wallets.length === 0) {
      return {
        ok: true,
        walletsChecked: 0,
        totalActivity: 0,
        results: [],
        hint:
          "Watchlist is empty. Use kreopoly_track_wallet to add wallets first.",
      };
    }

    const sinceTs = Math.floor(Date.now() / 1000) - args.sinceSeconds;
    const results: Array<{
      wallet: { address: string; label: string };
      activity: import("../lib/polygon.js").WalletActivity[];
      upstreamProvider?: string;
      upstreamStatus?: number;
      rawCount?: number;
      polymarketCount?: number;
      error?: ToolError;
    }> = [];

    let totalActivity = 0;
    let failureCount = 0;
    let lastError: ToolError | null = null;

    for (const w of wallets) {
      if (!w.enabled) continue;
      const result = await getWalletActivity(w.address, args.perWallet);

      if (!result.ok) {
        failureCount++;
        lastError = result.error;
        results.push({
          wallet: { address: w.address, label: w.label },
          activity: [],
          error: result.error,
        });
        continue;
      }

      const recent = result.activity.filter((a) => a.timestamp >= sinceTs);
      totalActivity += recent.length;
      results.push({
        wallet: { address: w.address, label: w.label },
        activity: recent,
        upstreamProvider: result.upstreamProvider,
        upstreamStatus: result.upstreamStatus,
        rawCount: result.rawCount,
        polymarketCount: result.polymarketCount,
      });
    }

    // If ALL wallets failed, return an error response
    if (failureCount === wallets.length && lastError) {
      return makeError(
        lastError.code,
        `All ${wallets.length} wallet(s) failed to fetch activity. Last error: ${lastError.message}`,
        {
          retryable: lastError.retryable,
          upstreamStatus: lastError.upstreamStatus,
          upstreamProvider: lastError.upstreamProvider,
          upstreamContentType: lastError.upstreamContentType,
          upstreamPreview: lastError.upstreamPreview,
        }
      );
    }

    return {
      ok: true,
      since: new Date(sinceTs * 1000).toISOString(),
      walletsChecked: results.length,
      walletsFailed: failureCount,
      totalActivity,
      results,
      hint:
        totalActivity === 0 && failureCount > 0
          ? `${failureCount} wallet(s) failed to fetch — see per-wallet error fields.`
          : totalActivity === 0
            ? "No recent activity from tracked wallets. Try increasing sinceSeconds."
            : undefined,
    };
  },
};
