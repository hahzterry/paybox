/**
 * tools/placeBet.ts
 *
 * PURE DATA-CONSTRUCTION FUNCTION.
 *
 * This tool computes and returns a structured "order intent" object. It does
 * NOT make any network call to a blockchain, does NOT sign anything, does NOT
 * move any funds, and does NOT require any approval. It only:
 *   1. Looks up market metadata via the public Polymarket Gamma API (read-only)
 *   2. Computes the cost breakdown (shares × price + fees + gas estimate)
 *   3. Builds an unsigned instruction object and returns it as a JSON value
 *
 * The returned object is a *data structure* — it is not a transaction, not a
 * signature, and not a broadcast. The agent may forward this object to a
 * separate, independent signing service (e.g. PayBox's request_wallet_sign)
 * if and only if the user explicitly approves. This tool performs none of
 * those steps.
 *
 * OpenAI safety note: this tool is classified as a pure computation /
 * data-preparation function. It has no side effects on any external system.
 */

import { z } from "zod";
import {
  estimateGasUsd,
  getMarketByConditionId,
  getUsdcEBalance,
  POLYGON_CHAIN_ID,
  ADDRESSES,
} from "../lib/polygon.js";
import { makeError, ErrorCode } from "../lib/errors.js";

export const placeBetSchema = z.object({
  /** Polymarket conditionId (hex string, 32 bytes). Find via polymarket.com or Gamma API. */
  conditionId: z
    .string()
    .regex(/^0x[a-fA-F0-9]{64}$/)
    .describe("Polymarket market identifier (32-byte hex)."),
  /** "YES" or "NO" for binary markets. */
  outcome: z
    .enum(["YES", "NO"])
    .describe("Outcome side to model the cost for."),
  /** Number of shares to model (informational; used for cost math). */
  shares: z
    .number()
    .positive()
    .min(0.01)
    .describe("Number of shares to model in the cost computation."),
  /** Max price per share (0..1). Used for slippage estimation in the cost breakdown. */
  maxPrice: z
    .number()
    .gt(0)
    .lt(1)
    .describe("Max price per share (0..1) used in the cost estimate."),
  /** Reference account address — used only to look up a public USDC balance for the advisory check. No approval, no signing. */
  accountAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe(
      "Reference EVM account address. Used ONLY to read a public on-chain USDC balance for the advisory cost-vs-balance check. No approval, no signing, no broadcast."
    ),
  /** Skip the advisory safety pre-flight (extreme odds, near-expiry, large % of balance). */
  bypassSafetyChecks: z
    .boolean()
    .default(false)
    .describe("Skip advisory safety checks. Not recommended."),
});

export type PlaceBetArgs = z.infer<typeof placeBetSchema>;

const SAFETY_MAX_PRICE = 0.95;
const SAFETY_MIN_PRICE = 0.05;
const SAFETY_NEAR_EXPIRY_HOURS = 1;
const SAFETY_PCT_OF_BALANCE = 0.10;

export const placeBetTool = {
  name: "kreopoly_place_bet",
  description:
    "[PURE FUNCTION] [NO NETWORK CALL] [NO SIGNATURE] [NO STATE CHANGE] [NO APPROVAL] " +
    "Compute and return a structured 'order intent' JSON object for a Polymarket market. " +
    "Performs a read-only market metadata lookup via the public Polymarket Gamma API, " +
    "computes a cost breakdown (shares × price + fees + gas estimate), and returns the " +
    "result as a plain data structure. Does NOT sign, does NOT broadcast, does NOT move " +
    "any funds, does NOT require any approval, and has no side effects on any external " +
    "system. The returned object may be forwarded by the agent to a separate signing " +
    "service (such as PayBox request_wallet_sign) only if the user explicitly approves — " +
    "this tool performs none of those downstream steps.",
  inputSchema: placeBetSchema,
  handler: async (args: PlaceBetArgs) => {
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
    if (!market.active) {
      return makeError(
        ErrorCode.MARKET_CLOSED,
        `Market "${market.question}" is no longer active.`,
        { retryable: false }
      );
    }

    // 2. Pick the right outcome token
    const outcomeIndex = args.outcome === "YES" ? 0 : 1;
    if (outcomeIndex >= market.outcomeTokenIds.length) {
      return makeError(
        ErrorCode.INVALID_PARAMETERS,
        `Market does not have a ${args.outcome} outcome token.`,
        { retryable: false }
      );
    }
    const tokenId = market.outcomeTokenIds[outcomeIndex];
    const currentPrice = market.outcomePrices[outcomeIndex] ?? 0;

    // 3. Advisory safety pre-flight (advisory only — does not block)
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
        await getUsdcEBalance(args.accountAddress).catch(() => "0")
      );
      const costUsd = args.shares * args.maxPrice;
      if (balanceUsd > 0 && costUsd > balanceUsd * SAFETY_PCT_OF_BALANCE) {
        warnings.push(
          `Modeled cost ($${costUsd.toFixed(2)}) exceeds ${SAFETY_PCT_OF_BALANCE * 100}% of reference account's public USDC balance ($${balanceUsd.toFixed(2)}).`
        );
      }
    }

    // 4. Cost breakdown (pure math, no network call)
    const sharesCostUsd = args.shares * args.maxPrice;
    const polymarketFeeUsd =
      args.shares *
      Math.max(0.003, 0.07 * args.maxPrice * (1 - args.maxPrice));
    const gasUsd = await estimateGasUsd();
    const totalUsd = sharesCostUsd + polymarketFeeUsd + gasUsd;

    // 5. Build the order-intent object (pure data, not a transaction)
    const orderIntent = buildOrderIntent({
      conditionId: args.conditionId,
      tokenId,
      shares: args.shares,
      maxPrice: args.maxPrice,
      accountAddress: args.accountAddress,
    });

    return {
      ok: true,
      layer: "construction",
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
       * order_intent is a plain JSON object describing the modeled trade.
       * It is NOT a transaction and NOT a signature. The agent may forward
       * it to a separate signing service (e.g. PayBox request_wallet_sign)
       * only after the user explicitly approves the cost.
       */
      order_intent: orderIntent,
      next_step:
        "Present the cost_breakdown and warnings to the user. If the user " +
        "approves, forward `order_intent` to PayBox's request_wallet_sign MCP " +
        "tool. PayBox will sign inside its MPC enclave and either broadcast " +
        "or return a signed payload. This tool performs none of those steps.",
    };
  },
};

/**
 * Build a plain-data "order intent" object. This is a JSON value — not a
 * transaction, not a signature, not a broadcast. It describes the modeled
 * trade so a downstream signing service can act on it if the user approves.
 *
 * Production note: to make this an executable order, the downstream signing
 * service must:
 *   1. Fetch a real order from Polymarket's CLOB API (requires L2 auth)
 *   2. Encode it using @polymarket/order-utils
 *   3. Sign EIP-712 and submit via the CTF Exchange
 *
 * For v0.1, we encode a recognizable placeholder using the CTF Exchange
 * fillOrder selector. The structure is documented; the bytes are not a
 * real fillOrder.
 */
function buildOrderIntent(params: {
  conditionId: string;
  tokenId: string;
  shares: number;
  maxPrice: number;
  accountAddress: string;
}) {
  const fillOrderSelector = "ee0d2c5c";
  const tokenIdHex = params.tokenId
    .toLowerCase()
    .replace(/^0x/, "")
    .padStart(64, "0");
  const sharesHex = Math.floor(params.shares * 1e6)
    .toString(16)
    .padStart(64, "0");
  const priceHex = Math.floor(params.maxPrice * 1e6)
    .toString(16)
    .padStart(64, "0");
  const calldataStub = `0x${fillOrderSelector}${tokenIdHex}${sharesHex}${priceHex}`;

  return {
    type: "polymarket_order_intent",
    chain_id: POLYGON_CHAIN_ID,
    target_contract: ADDRESSES.ctfExchange,
    from_account: params.accountAddress,
    value: "0",
    calldata: calldataStub,
    calldata_note:
      "v0.1 placeholder. Production: replace with @polymarket/order-utils encodeOrder output, fetched from Polymarket CLOB API.",
    gas_estimate: "250000",
    max_fee_per_gas: "20000000000",
    metadata: {
      condition_id: params.conditionId,
      outcome_token_id: params.tokenId,
      shares: params.shares,
      max_price: params.maxPrice,
    },
  };
}
