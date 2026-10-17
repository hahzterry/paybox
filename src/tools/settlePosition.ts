/**
 * tools/settlePosition.ts
 *
 * Settle (redeem) winning Polymarket positions after a market resolves.
 *
 * In Polymarket:
 *   - When a market resolves, winning shares are worth $1 USDC.e each
 *   - Losing shares are worth $0
 *   - Winners call ConditionalTokens.redeemPositions(conditionId, ...) to claim
 *
 * This tool:
 *   1. Looks up the market via Gamma API to check resolution status
 *   2. If resolved, returns a signing_request for the redeemPositions call
 *   3. If not resolved, returns a clear "not yet" message with the resolution date
 *
 * The signing_request is forwarded to PayBox's request_wallet_sign — same flow
 * as place_bet, custody stays with PayBox.
 */

import { z } from "zod";
import {
  ADDRESSES,
  POLYGON_CHAIN_ID,
  getMarketByConditionId,
  getPositions,
  estimateGasUsd,
} from "../lib/polygon.js";

export const settlePositionSchema = z.object({
  /** Polymarket conditionId (hex string, 32 bytes). */
  conditionId: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .describe("Polymarket conditionId of the resolved market."),
  /** User's Polygon wallet (the one granted via PayBox). */
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("User's Polygon wallet."),
  /** Skip the safety check that the user actually has shares to redeem. */
  force: z
    .boolean()
    .default(false)
    .describe("Skip the position-check. Not recommended."),
});

export type SettlePositionArgs = z.infer<typeof settlePositionSchema>;

export const settlePositionTool = {
  name: "kreopoly_settle_position",
  description:
    "Redeem winning Polymarket shares after a market resolves. " +
    "Returns a signing_request for PayBox's request_wallet_sign — same custody model as place_bet. " +
    "If the market is not yet resolved, returns the resolution date. " +
    "If the user has no winning shares, returns 0 redeemable.",
  inputSchema: settlePositionSchema,
  handler: async (args: SettlePositionArgs) => {
    // 1. Fetch market metadata
    const market = await getMarketByConditionId(args.conditionId);
    if (!market) {
      return {
        ok: false,
        error: "market_not_found",
        message: `No Polymarket market found for conditionId ${args.conditionId}.`,
      };
    }

    // 2. Check resolution status
    // The Gamma API exposes `closed` (boolean) and `resolvedBy` (oracle).
    // We approximate "resolved" as: endDate has passed AND market is closed.
    const now = Math.floor(Date.now() / 1000);
    const isResolved = !market.active && market.endDate != null && market.endDate < now;

    if (!isResolved) {
      return {
        ok: false,
        error: "not_resolved",
        market: {
          title: market.question,
          slug: market.slug,
          url: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
        },
        message:
          market.endDate != null
            ? `Market "${market.question}" resolves at ${new Date(market.endDate * 1000).toISOString()}. Try again after that.`
            : `Market "${market.question}" has no end date. Cannot settle.`,
      };
    }

    // 3. Check user has shares to redeem
    let userShares = 0;
    let winningOutcome = "";
    let winningOutcomeIndex = -1;
    if (!args.force) {
      const positions = await getPositions(args.walletAddress);
      for (const p of positions) {
        if (p.tokenId && market.outcomeTokenIds.includes(p.tokenId)) {
          userShares += Number(p.shares);
          winningOutcome = p.outcome;
          winningOutcomeIndex = market.outcomeTokenIds.indexOf(p.tokenId);
        }
      }
      if (userShares === 0) {
        return {
          ok: false,
          error: "no_shares",
          market: {
            title: market.question,
            slug: market.slug,
          },
          message: `You have no shares in "${market.question}" to redeem.`,
        };
      }
    }

    // 4. Compute settlement value
    const redeemableValueUsd = userShares; // 1 winning share = $1 USDC
    const gasUsd = await estimateGasUsd();
    const netUsd = redeemableValueUsd - gasUsd;

    // 5. Build the redeemPositions calldata
    //
    // ConditionalTokens.redeemPositions(conditionId, outcomeSlotCount, indexSets)
    //   - conditionId: bytes32
    //   - outcomeSlotCount: uint (2 for binary markets)
    //   - indexSets: uint[] (e.g. [1, 2] for binary — bits representing outcomes)
    //
    // Selector: 0x46b3514f (redeemPositions)
    const redeemCalldata = encodeRedeemPositions({
      conditionId: args.conditionId,
      outcomeSlotCount: market.outcomeTokenIds.length || 2,
      indexSets: buildIndexSets(market.outcomeTokenIds.length || 2),
    });

    const signingRequest = {
      chain_id: POLYGON_CHAIN_ID,
      to: ADDRESSES.conditionalTokens,
      from: args.walletAddress,
      value: "0",
      data: redeemCalldata,
      gas_estimate: "200000",
      max_fee_per_gas: "20000000000",
      metadata: {
        type: "polymarket_settle",
        condition_id: args.conditionId,
        market_slug: market.slug,
        market_title: market.question,
        winning_outcome: winningOutcome || market.outcomes[winningOutcomeIndex] || "unknown",
        shares_redeemed: userShares,
        redeemable_value_usd: Number(redeemableValueUsd.toFixed(6)),
        gas_usd: Number(gasUsd.toFixed(6)),
        net_usd: Number(netUsd.toFixed(6)),
      },
    };

    return {
      ok: true,
      market: {
        title: market.question,
        slug: market.slug,
        url: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
        resolvedAt: market.endDate
          ? new Date(market.endDate * 1000).toISOString()
          : null,
      },
      winning_side: winningOutcome || market.outcomes[winningOutcomeIndex] || "unknown",
      shares_redeemed: userShares,
      redeemable_value_usd: Number(redeemableValueUsd.toFixed(6)),
      cost_breakdown: {
        gas_usd: Number(gasUsd.toFixed(6)),
        net_usd: Number(netUsd.toFixed(6)),
      },
      signing_request: signingRequest,
      next_step:
        "Forward `signing_request` to PayBox's request_wallet_sign. " +
        "PayBox signs and broadcasts; winning shares convert to USDC.e.",
    };
  },
};

/**
 * Encode ConditionalTokens.redeemPositions(conditionId, outcomeSlotCount, indexSets)
 *
 * Selector: 0x46b3514f
 *   - conditionId: bytes32 (32 bytes)
 *   - outcomeSlotCount: uint256 (32 bytes)
 *   - indexSets: uint256[] (offset + length + items)
 */
function encodeRedeemPositions(params: {
  conditionId: string;
  outcomeSlotCount: number;
  indexSets: bigint[];
}): string {
  const selector = "46b3514f";
  const conditionIdHex = params.conditionId
    .toLowerCase()
    .replace(/^0x/, "")
    .padStart(64, "0");
  const slotCountHex = BigInt(params.outcomeSlotCount)
    .toString(16)
    .padStart(64, "0");

  // Dynamic array: offset (32) + length (32) + items
  const offsetHex = BigInt(64).toString(16).padStart(64, "0");
  const lengthHex = BigInt(params.indexSets.length).toString(16).padStart(64, "0");
  const itemsHex = params.indexSets
    .map((v) => v.toString(16).padStart(64, "0"))
    .join("");

  return `0x${selector}${conditionIdHex}${slotCountHex}${offsetHex}${lengthHex}${itemsHex}`;
}

/**
 * Build indexSets for redeemPositions.
 *
 * For a binary market (YES/NO), indexSets = [1, 2]:
 *   - 1 = bit 0 set = YES
 *   - 2 = bit 1 set = NO
 * The caller redeems both — losing side returns 0, winning side returns $1/share.
 *
 * For a 3-outcome market, [1, 2, 4]. Etc.
 */
function buildIndexSets(outcomeCount: number): bigint[] {
  const sets: bigint[] = [];
  for (let i = 0; i < outcomeCount; i++) {
    sets.push(1n << BigInt(i));
  }
  return sets;
}
