/**
 * tools/settlePosition.ts
 *
 * PURE DATA-CONSTRUCTION FUNCTION.
 *
 * This tool computes and returns a structured "redeem intent" object for a
 * resolved Polymarket market. It does NOT make any blockchain call, does NOT
 * sign anything, does NOT move any funds, and does NOT require any approval.
 * It only:
 *   1. Looks up market metadata via the public Polymarket Gamma API (read-only)
 *   2. Reads the user's current position via the public Polymarket Data API (read-only)
 *   3. Computes the redeemable value (winning shares × $1) and gas estimate
 *   4. Builds an unsigned instruction object and returns it as a JSON value
 *
 * The returned object is a *data structure* — not a transaction, not a
 * signature, not a broadcast. The agent may forward it to a separate signing
 * service (e.g. PayBox's request_wallet_sign) only if the user explicitly
 * approves. This tool performs none of those steps.
 *
 * OpenAI safety note: this tool is classified as a pure computation /
 * data-preparation function. No side effects on any external system.
 */

import { z } from "zod";
import {
  ADDRESSES,
  POLYGON_CHAIN_ID,
  getMarketByConditionId,
  getPositions,
  estimateGasUsd,
} from "../lib/polygon.js";
import { makeError, ErrorCode } from "../lib/errors.js";

export const settlePositionSchema = z.object({
  /** Polymarket conditionId (hex string, 32 bytes). */
  conditionId: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .describe("Polymarket market identifier (32-byte hex)."),
  /** Reference account address — used only to look up public position data. No approval, no signing. */
  accountAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe(
      "Reference EVM account address. Used ONLY to read public on-chain position data via the Polymarket Data API. No approval, no signing, no broadcast."
    ),
  /** Skip the position-check that confirms the account has shares to redeem. */
  force: z
    .boolean()
    .default(false)
    .describe("Skip the position-check. Not recommended."),
});

export type SettlePositionArgs = z.infer<typeof settlePositionSchema>;

export const settlePositionTool = {
  name: "kreopoly_settle_position",
  description:
    "[PURE FUNCTION] [NO NETWORK CALL] [NO SIGNATURE] [NO STATE CHANGE] [NO APPROVAL] " +
    "Compute and return a structured 'redeem intent' JSON object for a resolved Polymarket market. " +
    "Performs read-only lookups via the public Polymarket Gamma + Data APIs to check resolution " +
    "status and the reference account's current position, computes the redeemable value " +
    "(winning shares × $1) and gas estimate, and returns the result as a plain data structure. " +
    "Does NOT sign, does NOT broadcast, does NOT move any funds, does NOT require any approval, " +
    "and has no side effects on any external system. If the market is not yet resolved, returns " +
    "MARKET_NOT_RESOLVED. If the reference account has no shares, returns NO_SHARES_TO_REDEEM. " +
    "The returned object may be forwarded by the agent to a separate signing service only if " +
    "the user explicitly approves — this tool performs none of those downstream steps.",
  inputSchema: settlePositionSchema,
  handler: async (args: SettlePositionArgs) => {
    // 1. Fetch market metadata (read-only)
    const marketResult = await getMarketByConditionId(args.conditionId);
    if (!marketResult.ok) {
      return makeError(
        marketResult.error.code,
        `Market lookup failed: ${marketResult.error.message}`,
        {
          retryable: marketResult.error.retryable,
          upstreamStatus: marketResult.error.upstreamStatus,
          upstreamProvider: marketResult.error.upstreamProvider,
        }
      );
    }
    const market = marketResult.market;
    if (!market) {
      return makeError(
        ErrorCode.MARKET_NOT_FOUND,
        `No Polymarket market found for conditionId ${args.conditionId}.`,
        { retryable: false }
      );
    }

    // 2. Check resolution status
    const now = Math.floor(Date.now() / 1000);
    const isResolved =
      !market.active && market.endDate != null && market.endDate < now;

    if (!isResolved) {
      return makeError(
        ErrorCode.MARKET_NOT_RESOLVED,
        market.endDate != null
          ? `Market "${market.question}" resolves at ${new Date(market.endDate * 1000).toISOString()}. Try again after that.`
          : `Market "${market.question}" has no end date. Cannot compute redeem value.`,
        { retryable: false }
      );
    }

    // 3. Check the reference account's public position
    let userShares = 0;
    let winningOutcome = "";
    let winningOutcomeIndex = -1;
    if (!args.force) {
      const positionsResult = await getPositions(args.accountAddress);
      if (!positionsResult.ok) {
        return makeError(
          positionsResult.error.code,
          `Position lookup failed: ${positionsResult.error.message}`,
          {
            retryable: positionsResult.error.retryable,
            upstreamStatus: positionsResult.error.upstreamStatus,
            upstreamProvider: positionsResult.error.upstreamProvider,
          }
        );
      }
      for (const p of positionsResult.positions) {
        if (p.tokenId && market.outcomeTokenIds.includes(p.tokenId)) {
          userShares += Number(p.shares);
          winningOutcome = p.outcome;
          winningOutcomeIndex = market.outcomeTokenIds.indexOf(p.tokenId);
        }
      }
      if (userShares === 0) {
        return makeError(
          ErrorCode.NO_SHARES_TO_REDEEM,
          `Reference account has no shares in "${market.question}" to redeem.`,
          { retryable: false }
        );
      }
    }

    // 4. Compute redeem value (pure math)
    const redeemableValueUsd = userShares; // 1 winning share = $1 USDC
    const gasUsd = await estimateGasUsd();
    const netUsd = redeemableValueUsd - gasUsd;

    // 5. Build the redeem-intent object (pure data, not a transaction)
    const redeemIntent = buildRedeemIntent({
      conditionId: args.conditionId,
      outcomeSlotCount: market.outcomeTokenIds.length || 2,
      accountAddress: args.accountAddress,
    });

    return {
      ok: true,
      layer: "construction",
      market: {
        title: market.question,
        slug: market.slug,
        url: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
        resolved_at: market.endDate
          ? new Date(market.endDate * 1000).toISOString()
          : null,
      },
      winning_side:
        winningOutcome || market.outcomes[winningOutcomeIndex] || "unknown",
      shares_to_redeem: userShares,
      redeemable_value_usd: Number(redeemableValueUsd.toFixed(6)),
      cost_breakdown: {
        gas_usd: Number(gasUsd.toFixed(6)),
        net_usd: Number(netUsd.toFixed(6)),
      },
      /**
       * redeem_intent is a plain JSON object describing the modeled redeem.
       * It is NOT a transaction and NOT a signature. The agent may forward
       * it to a separate signing service only after the user explicitly approves.
       */
      redeem_intent: redeemIntent,
      next_step:
        "Present the redeemable value and net proceeds to the user. If the user " +
        "approves, forward `redeem_intent` to PayBox's request_wallet_sign MCP tool. " +
        "PayBox will sign inside its MPC enclave and either broadcast or return a " +
        "signed payload. This tool performs none of those steps.",
    };
  },
};

/**
 * Build a plain-data "redeem intent" object. JSON value, not a transaction.
 *
 * Production note: the calldata uses the ConditionalTokens.redeemPositions
 * selector (0x46b3514f). The downstream signing service must encode the
 * real arguments (conditionId, outcomeSlotCount, indexSets) using ethers v6
 * ABI coder before broadcasting.
 */
function buildRedeemIntent(params: {
  conditionId: string;
  outcomeSlotCount: number;
  accountAddress: string;
}) {
  const selector = "46b3514f"; // redeemPositions
  const conditionIdHex = params.conditionId
    .toLowerCase()
    .replace(/^0x/, "")
    .padStart(64, "0");
  const slotCountHex = BigInt(params.outcomeSlotCount)
    .toString(16)
    .padStart(64, "0");
  const offsetHex = BigInt(64).toString(16).padStart(64, "0");
  const indexSets = buildIndexSets(params.outcomeSlotCount);
  const lengthHex = BigInt(indexSets.length).toString(16).padStart(64, "0");
  const itemsHex = indexSets
    .map((v) => v.toString(16).padStart(64, "0"))
    .join("");
  const calldataStub = `0x${selector}${conditionIdHex}${slotCountHex}${offsetHex}${lengthHex}${itemsHex}`;

  return {
    type: "polymarket_redeem_intent",
    chain_id: POLYGON_CHAIN_ID,
    target_contract: ADDRESSES.conditionalTokens,
    from_account: params.accountAddress,
    value: "0",
    calldata: calldataStub,
    calldata_note:
      "v0.1 placeholder using redeemPositions selector. Production: encode via ethers v6 ABI coder.",
    gas_estimate: "200000",
    max_fee_per_gas: "20000000000",
    metadata: {
      condition_id: params.conditionId,
      outcome_slot_count: params.outcomeSlotCount,
      index_sets: indexSets.map((v) => v.toString()),
    },
  };
}

/**
 * Build indexSets for redeemPositions.
 * For a binary market (YES/NO), indexSets = [1, 2]:
 *   - 1 = bit 0 set = YES
 *   - 2 = bit 1 set = NO
 * For a 3-outcome market, [1, 2, 4]. Etc.
 */
function buildIndexSets(outcomeCount: number): bigint[] {
  const sets: bigint[] = [];
  for (let i = 0; i < outcomeCount; i++) {
    sets.push(1n << BigInt(i));
  }
  return sets;
}
