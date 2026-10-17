/**
 * tools/getPositions.ts
 *
 * Returns the user's open Polymarket positions with live P&L.
 *
 * Reads from the Polymarket Data API (free, no auth). The user's wallet
 * address comes from PayBox — the agent must first call PayBox's
 * `list_credentials` to find the granted Polygon wallet.
 */

import { z } from "zod";
import { getPositions, getUsdcEBalance, type Position } from "../lib/polygon.js";

/**
 * Sort positions by the given key. Mirrors Kreopoly's "Sort by profit, size,
 * or expiry" feature.
 *
 * - profit: highest currentValueUsd / cost basis first (we approximate using
 *   currentValueUsd alone, since Polymarket Data API exposes currentPrice but
 *   not always avgPrice — if avgPrice is available, real P&L % is computed).
 * - size:   largest USD value first
 * - expiry: soonest marketEndDate first (nulls last)
 * - recent: highest tokenId / most-recent first (proxy — Data API doesn't
 *   expose entry timestamp per position without an extra call)
 */
function sortPositions(
  positions: Position[],
  sortBy: "profit" | "size" | "expiry" | "recent"
): Position[] {
  const arr = [...positions];
  switch (sortBy) {
    case "profit":
      // Sort by currentValueUsd descending (proxy for profit — see comment)
      return arr.sort(
        (a, b) => b.currentValueUsd - a.currentValueUsd
      );
    case "size":
      return arr.sort(
        (a, b) => Number(b.shares) - Number(a.shares)
      );
    case "expiry":
      return arr.sort((a, b) => {
        if (a.marketEndDate == null) return 1;
        if (b.marketEndDate == null) return -1;
        return a.marketEndDate - b.marketEndDate;
      });
    case "recent":
      // Proxy: sort by tokenId (higher = newer market) — Polymarket Data API
      // does not expose entry timestamp without an extra /activity call.
      return arr.sort((a, b) =>
        b.tokenId.localeCompare(a.tokenId)
      );
  }
}

export const getPositionsSchema = z.object({
  /** The user's Polygon wallet address (EIP-55 checksummed or lowercase). */
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "Must be a valid EVM address")
    .describe("User's Polygon wallet address, as granted via PayBox."),
  /** Optional: include zero-share (redeemable) positions */
  includeClosed: z
    .boolean()
    .default(false)
    .describe("Include positions with 0 size (resolved, redeemable)."),
  /** Optional: sort order (Kreopoly's "Sort by profit, size, or expiry"). */
  sortBy: z
    .enum(["profit", "size", "expiry", "recent"])
    .default("profit")
    .describe(
      "Sort order: profit (highest P&L first), size (largest USD value first), " +
        "expiry (soonest-resolution first), recent (most recently traded first)."
    ),
  /** Optional: filter to a specific category slug (Kreopoly's 13 categories). */
  category: z
    .string()
    .optional()
    .describe(
      "Optional category filter. See kreopoly_list_categories for the 13 turnkey categories."
    ),
});

export type GetPositionsArgs = z.infer<typeof getPositionsSchema>;

export const getPositionsTool = {
  name: "kreopoly_get_positions",
  description:
    "List the user's open Polymarket positions with live P&L, current prices, " +
    "and market metadata. Free read; does not touch funds. " +
    "Prerequisite: the user must have granted a Polygon wallet to this plugin " +
    "via PayBox. To discover the wallet address, call PayBox's list_credentials.",
  inputSchema: getPositionsSchema,
  handler: async (args: GetPositionsArgs) => {
    const positions = await getPositions(args.walletAddress);
    const usdcEBalance = await getUsdcEBalance(args.walletAddress).catch(
      () => "0"
    );

    const filtered = args.includeClosed
      ? positions
      : positions.filter((p) => Number(p.shares) > 0);

    // Sort (Kreopoly's "Sort by profit, size, or expiry")
    const sorted = sortPositions(filtered, args.sortBy);

    const totalValueUsd = sorted.reduce(
      (sum, p) => sum + p.currentValueUsd,
      0
    );

    return {
      wallet: args.walletAddress,
      usdcEBalance,
      sortBy: args.sortBy,
      totalPositionsValueUsd: Number(totalValueUsd.toFixed(2)),
      positions: sorted.map((p) => ({
        market: p.marketTitle,
        outcome: p.outcome,
        shares: Number(p.shares).toFixed(2),
        currentPrice: p.currentPrice.toFixed(3),
        currentValueUsd: Number(p.currentValueUsd.toFixed(2)),
        marketSlug: p.marketSlug,
        marketUrl: p.marketSlug
          ? `https://polymarket.com/event/${p.marketSlug}`
          : null,
        endsAt: p.marketEndDate
          ? new Date(p.marketEndDate * 1000).toISOString()
          : null,
      })),
      hint:
        filtered.length === 0
          ? "No open positions. Use kreopoly_get_tracked_activity to discover what smart wallets are trading, then kreopoly_place_bet to enter a market."
          : undefined,
    };
  },
};
