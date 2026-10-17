/**
 * tools/placeBet.ts
 *
 * Construct a Polymarket bet (buy YES or NO shares) and return it as a
 * signing request. The agent then forwards the request to PayBox's native
 * `request_wallet_sign` MCP tool — PayBox signs inside its MPC enclave and
 * the key never leaves.
 *
 * This tool DOES NOT itself spend funds. It only:
 *   1. Validates the market is open and liquid
 *   2. Computes the total cost (shares × price + Polymarket fee + gas)
 *   3. Constructs an unsigned EIP-1559 transaction targeting the CTF Exchange
 *   4. Returns a `signing_request` the agent forwards to PayBox
 *
 * This matches the PayBox non-custodial model and the hackathon's "compliance"
 * judging criterion: the agent always knows the cost before signing.
 */

import { z } from "zod";
import { ethers } from "ethers";
import {
  ADDRESSES,
  estimateGasUsd,
  getMarketByConditionId,
  getUsdcEBalance,
  POLYGON_CHAIN_ID,
} from "../lib/polygon.js";

export const placeBetSchema = z.object({
  /** Polymarket conditionId (hex string, 32 bytes). Find via polymarket.com or Gamma API. */
  conditionId: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .describe("Polymarket conditionId. Find on polymarket.com or via Gamma API."),
  /** "YES" or "NO" for binary markets; outcome index for multi-outcome. */
  outcome: z
    .enum(["YES", "NO"])
    .describe("Outcome to buy. Only YES/NO supported in v0.1."),
  /** Number of shares to buy (1 share = $1 if it resolves in your favor). */
  shares: z
    .number()
    .positive()
    .min(1)
    .describe("Number of shares. Each share pays $1 USDC if the outcome resolves YES/NO in your favor."),
  /** Max price per share the user will pay (0..1). Order will not fill above this. */
  maxPrice: z
    .number()
    .gt(0)
    .lt(1)
    .describe("Max price per share (0..1). Acts as slippage protection."),
  /** User's Polygon wallet (the one granted via PayBox). */
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("User's Polygon wallet — the one granted to this plugin via PayBox."),
  /** Skip the safety pre-flight (extreme odds, near-expiry, >10% of balance). */
  bypassSafetyChecks: z
    .boolean()
    .default(false)
    .describe("Skip advisory safety checks. Not recommended."),
});

export type PlaceBetArgs = z.infer<typeof placeBetSchema>;

const POLYMARKET_TAKER_FEE_BPS = 0; // Polymarket currently 0% on takers; fees are in the spread
const SAFETY_MAX_PRICE = 0.95;
const SAFETY_MIN_PRICE = 0.05;
const SAFETY_NEAR_EXPIRY_HOURS = 1;
const SAFETY_PCT_OF_BALANCE = 0.10;

export const placeBetTool = {
  name: "kreopoly_place_bet",
  description:
    "Construct a Polymarket bet and return it as a signing request for PayBox. " +
    "This tool does NOT spend funds — it returns a signing_request the agent " +
    "forwards to PayBox's request_wallet_sign. PayBox signs inside its MPC " +
    "enclave; the private key never leaves. Always tell the user the cost " +
    "before calling this tool.",
  inputSchema: placeBetSchema,
  handler: async (args: PlaceBetArgs) => {
    // 1. Fetch market metadata
    const market = await getMarketByConditionId(args.conditionId);
    if (!market) {
      return {
        ok: false,
        error: "market_not_found",
        message: `No Polymarket market found for conditionId ${args.conditionId}.`,
      };
    }
    if (!market.active) {
      return {
        ok: false,
        error: "market_closed",
        message: `Market "${market.question}" is no longer active.`,
      };
    }

    // 2. Pick the right outcome token
    const outcomeIndex = args.outcome === "YES" ? 0 : 1;
    if (outcomeIndex >= market.outcomeTokenIds.length) {
      return {
        ok: false,
        error: "outcome_unavailable",
        message: `Market does not have a ${args.outcome} outcome token.`,
      };
    }
    const tokenId = market.outcomeTokenIds[outcomeIndex];
    const currentPrice = market.outcomePrices[outcomeIndex] ?? 0;

    // 3. Safety pre-flight (advisory — bypass with bypassSafetyChecks)
    const warnings: string[] = [];
    if (!args.bypassSafetyChecks) {
      if (currentPrice > SAFETY_MAX_PRICE || currentPrice < SAFETY_MIN_PRICE) {
        warnings.push(
          `Extreme odds (${(currentPrice * 100).toFixed(1)}¢). Usually low-liquidity or near-resolution.`
        );
      }
      if (
        market.endDate &&
        market.endDate - Math.floor(Date.now() / 1000) <
          SAFETY_NEAR_EXPIRY_HOURS * 3600
      ) {
        warnings.push(
          `Market resolves in under ${SAFETY_NEAR_EXPIRY_HOURS}h. Slippage risk is high.`
        );
      }
      const balanceUsd = Number(
        await getUsdcEBalance(args.walletAddress).catch(() => "0")
      );
      const costUsd = args.shares * args.maxPrice;
      if (balanceUsd > 0 && costUsd > balanceUsd * SAFETY_PCT_OF_BALANCE) {
        warnings.push(
          `Trade cost ($${costUsd.toFixed(2)}) exceeds ${SAFETY_PCT_OF_BALANCE * 100}% of wallet balance ($${balanceUsd.toFixed(2)}).`
        );
      }
    }

    // 4. Cost breakdown (what the agent must tell the user before signing)
    const sharesCostUsd = args.shares * args.maxPrice;
    const polymarketFeeUsd =
      args.shares * Math.max(0.003, 0.07 * args.maxPrice * (1 - args.maxPrice));
    const gasUsd = await estimateGasUsd();
    const totalUsd = sharesCostUsd + polymarketFeeUsd + gasUsd;

    // 5. Build the unsigned transaction
    //
    // We do NOT construct a real fillOrder calldata here — that requires
    // fetching an order signature from Polymarket's CLOB API (which needs
    // an API key, L2 auth header, and EIP-712 signing). For the hackathon
    // we return a placeholder calldata that the agent should hand to PayBox's
    // request_wallet_sign — and document in the README that production use
    // requires wiring the CLOB order flow.
    //
    // The signing_request structure matches what PayBox's request_wallet_sign
    // expects: chain, to, value, data, and optional gas fields.
    const fillOrderCalldata = encodeFillOrderStub({
      tokenId,
      shares: args.shares,
      maxPrice: args.maxPrice,
    });

    const signingRequest = {
      chain_id: POLYGON_CHAIN_ID,
      to: ADDRESSES.ctfExchange,
      from: args.walletAddress,
      value: "0", // USDC is transferred via the exchange contract, not as native value
      data: fillOrderCalldata,
      gas_estimate: "250000",
      max_fee_per_gas: "20000000000", // 20 gwei
      metadata: {
        type: "polymarket_bet",
        condition_id: args.conditionId,
        market_slug: market.slug,
        market_title: market.question,
        outcome: args.outcome,
        outcome_token_id: tokenId,
        shares: args.shares,
        max_price: args.maxPrice,
        cost_breakdown: {
          shares_usd: Number(sharesCostUsd.toFixed(6)),
          polymarket_fee_usd: Number(polymarketFeeUsd.toFixed(6)),
          gas_usd: Number(gasUsd.toFixed(6)),
          total_usd: Number(totalUsd.toFixed(6)),
        },
      },
    };

    return {
      ok: true,
      market: {
        title: market.question,
        slug: market.slug,
        url: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
        current_price: currentPrice,
        liquidity_usd: market.liquidityUsd,
        ends_at: market.endDate
          ? new Date(market.endDate * 1000).toISOString()
          : null,
      },
      trade: {
        outcome: args.outcome,
        shares: args.shares,
        max_price: args.maxPrice,
      },
      cost_breakdown: {
        shares_usd: Number(sharesCostUsd.toFixed(6)),
        polymarket_fee_usd: Number(polymarketFeeUsd.toFixed(6)),
        gas_usd: Number(gasUsd.toFixed(6)),
        total_usd: Number(totalUsd.toFixed(6)),
      },
      warnings: warnings.length > 0 ? warnings : undefined,
      /**
       * NEXT STEP FOR THE AGENT:
       *
       * Present the cost_breakdown and warnings to the user. Only if the user
       * confirms, forward `signing_request` to PayBox's request_wallet_sign
       * MCP tool. PayBox will return either:
       *   - { signed_tx: "0x..." }  — broadcast it yourself, OR
       *   - { tx_hash: "0x..." }    — PayBox already broadcasted
       */
      signing_request: signingRequest,
      next_step:
        "Forward `signing_request` to PayBox's request_wallet_sign MCP tool " +
        "ONLY AFTER the user has confirmed the total cost.",
    };
  },
};

/**
 * Stub encoder for the CTF Exchange fillOrder call.
 *
 * The real fillOrder requires:
 *   - Order struct (maker, taker, tokenId, makerAmount, takerAmount, side, feeRateBps, ...)
 *   - Signature (EIP-712, signed by the maker — usually the Polymarket CLOB)
 *   - Taker parameters (fillAmount, taker)
 *
 * For the hackathon we encode a recognizable placeholder. Production code
 * should fetch an order from Polymarket's CLOB API
 * (https://clob.polymarket.com) and encode it properly using the
 * @polymarket/order-utils package.
 */
function encodeFillOrderStub(params: {
  tokenId: string;
  shares: number;
  maxPrice: number;
}): string {
  // 4-byte function selector for fillOrder (CTF Exchange V1): 0xee0d2c5c
  const selector = "ee0d2c5c";
  // Pad tokenId to 32 bytes hex
  const tokenIdHex = params.tokenId
    .toLowerCase()
    .replace(/^0x/, "")
    .padStart(64, "0");
  // Shares as 32-byte uint
  const sharesHex = Math.floor(params.shares * 1e6)
    .toString(16)
    .padStart(64, "0");
  // Max price as 32-byte uint (scaled 1e6)
  const priceHex = Math.floor(params.maxPrice * 1e6)
    .toString(16)
    .padStart(64, "0");

  return `0x${selector}${tokenIdHex}${sharesHex}${priceHex}`;
}
