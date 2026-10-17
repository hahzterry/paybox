/**
 * tools/getTrackedActivity.ts
 *
 * Fetches recent on-chain activity for every wallet in the user's watchlist.
 * Mirrors Kreopoly's wallet-alert feature: "0x9e1f...a33c bought YES 'US
 * election outcome' size: $4,200 @ 0.71".
 *
 * Uses the Polygonscan free tier. Set POLYGONSCAN_API_KEY to lift rate limits.
 */

import { z } from "zod";
import { listWallets } from "../lib/store.js";
import { getWalletActivity, type WalletActivity } from "../lib/polygon.js";

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
    "Fetch recent Polymarket activity for every wallet in the user's watchlist. " +
    "Use this to surface smart-money moves to the user. Free read " +
    "(rate-limited by Polygonscan; set POLYGONSCAN_API_KEY to lift).",
  inputSchema: getTrackedActivitySchema,
  handler: async (
    args: GetTrackedActivityArgs,
    ctx: { userId: string }
  ) => {
    const userId = ctx.userId || "anonymous";
    const wallets = await listWallets(userId);

    if (wallets.length === 0) {
      return {
        ok: false,
        message:
          "Watchlist is empty. Use kreopoly_track_wallet to add wallets first.",
      };
    }

    const sinceTs = Math.floor(Date.now() / 1000) - args.sinceSeconds;
    const results: Array<{
      wallet: { address: string; label: string };
      activity: WalletActivity[];
      error?: string;
    }> = [];

    for (const w of wallets) {
      if (!w.enabled) continue;
      try {
        const activity = await getWalletActivity(w.address, args.perWallet);
        const recent = activity.filter((a) => a.timestamp >= sinceTs);
        results.push({ wallet: { address: w.address, label: w.label }, activity: recent });
      } catch (err: any) {
        results.push({
          wallet: { address: w.address, label: w.label },
          activity: [],
          error: err.message,
        });
      }
    }

    const totalActivity = results.reduce((s, r) => s + r.activity.length, 0);

    return {
      ok: true,
      since: new Date(sinceTs * 1000).toISOString(),
      walletsChecked: results.length,
      totalActivity,
      results,
      hint:
        totalActivity === 0
          ? "No recent activity from tracked wallets. Try increasing sinceSeconds."
          : undefined,
    };
  },
};
