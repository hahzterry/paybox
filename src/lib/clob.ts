/**
 * src/clob.ts — Polymarket CLOB API integration
 *
 * The CLOB API (https://clob.polymarket.com) is the OFFICIAL trading interface.
 * It exposes:
 *   - Public: order book, prices, midpoints, spreads (no auth)
 *   - Private: order placement, cancellation, balance/allowance checks (L2 auth + EIP-712 order sig)
 *
 * Authentication model (from docs.polymarket.com/getting-started/api):
 *   - L1: wallet signs EIP-712 ClobAuth typed data → used ONCE to create/derive API credentials
 *   - L2: HMAC-SHA256(apiSecret, timestamp + method + path + body) → per-request auth header
 *   - Order signature: separate EIP-712 Order struct signed by the maker wallet
 *
 * CRITICAL ARCHITECTURE NOTE:
 *   Polymarket CLOB orders are OFF-CHAIN EIP-712 signed messages submitted to a
 *   REST API. They are NOT on-chain transactions. PayBox's proposeEvm() helper
 *   only constructs on-chain transactions, so it CANNOT be used for CLOB orders.
 *
 *   The signing flow MUST go through PayBox's request_wallet_sign MCP tool,
 *   which the AGENT (not the plugin) invokes. The plugin's role is to:
 *     1. Build the EIP-712 typed-data payload
 *     2. Return it to the agent
 *     3. Agent forwards to PayBox request_wallet_sign
 *     4. Agent returns the signature to the plugin
 *     5. Plugin submits the signed order to the CLOB API
 *
 *   This file therefore exposes builders that construct typed-data payloads but
 *   does NOT perform signing. The signing capability must be confirmed to
 *   support eth_signTypedData_v4 in PayBox's request_wallet_sign tool.
 */

import { createHmac, createHash } from "node:crypto";

const CLOB_BASE = "https://clob.polymarket.com";
const POLYGON_CHAIN_ID = 137;

// ===========================================================================
// TYPES — CLOB API responses (snake_case from upstream)
// ===========================================================================

export interface OrderBookLevel {
  price: string; // decimal string, e.g. "0.39"
  size: string;  // decimal string, e.g. "2680.16"
}

export interface OrderBook {
  market: string;          // conditionId
  asset_id: string;        // token ID (the outcome being traded)
  timestamp: string;       // Unix MILLISECONDS as a string
  hash: string;            // order-book state hash
  bids: OrderBookLevel[];  // ascending by price — best bid is LAST
  asks: OrderBookLevel[];  // descending by price — best ask is FIRST
  min_order_size: string;  // decimal string
  tick_size: string;       // decimal string (e.g. "0.01")
  neg_risk: boolean;
  last_trade_price: string | null;
}

export interface OrderBookView {
  conditionId: string;
  assetId: string;
  timestampMs: number;
  isoTimestamp: string;
  hash: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  bestBid: OrderBookLevel | null;  // highest bid
  bestAsk: OrderBookLevel | null;  // lowest ask
  spread: number | null;           // bestAsk.price - bestBid.price (decimal number)
  midpoint: number | null;
  minOrderSize: number;
  tickSize: number;
  negRisk: boolean;
  lastTradePrice: number | null;
  /** Total bid depth in shares (sum of all bid sizes) */
  totalBidDepthShares: number;
  /** Total ask depth in shares (sum of all ask sizes) */
  totalAskDepthShares: number;
  /** USD depth at or better than best ask (shares available at best ask × best ask price) */
  immediateAskUsd: number;
  /** USD depth at or better than best bid */
  immediateBidUsd: number;
}
// ===========================================================================
// SAFE FETCH
// ===========================================================================

async function clobGet(path: string): Promise<{ ok: true; data: any; status: number } | { ok: false; error: { code: string; message: string; retryable: boolean; status: number } }> {
  const url = `${CLOB_BASE}${path}`;
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(3_000),
      redirect: "follow",
    });
    const status = res.status;
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (status === 429) {
      return { ok: false, error: { code: "UPSTREAM_RATE_LIMITED", message: `CLOB: HTTP 429 rate limited`, retryable: true, status } };
    }
    if (status >= 400) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: { code: "UPSTREAM_HTTP_ERROR", message: `CLOB: HTTP ${status}: ${text.slice(0, 200)}`, retryable: status >= 500, status } };
    }
    if (contentType.includes("text/html")) {
      return { ok: false, error: { code: "UPSTREAM_HTML_RESPONSE", message: `CLOB: returned HTML`, retryable: true, status } };
    }
    const text = await res.text();
    try {
      return { ok: true, data: JSON.parse(text), status };
    } catch {
      return { ok: false, error: { code: "UPSTREAM_INVALID_RESPONSE", message: `CLOB: JSON parse failed`, retryable: false, status } };
    }
  } catch (err: any) {
    return { ok: false, error: { code: "UPSTREAM_TIMEOUT", message: `CLOB: ${err?.message ?? "network error"}`, retryable: true, status: 0 } };
  }
}

// ===========================================================================
// PUBLIC ENDPOINTS — no auth required
// ===========================================================================

/**
 * Fetch the live order book for a specific outcome token.
 * Public endpoint — no authentication required.
 *
 * Endpoint: GET /book?token_id=<TOKEN_ID>
 * Returns: OrderBook (snake_case)
 */
export async function fetchOrderBook(tokenId: string): Promise<
  { ok: true; book: OrderBookView } | { ok: false; error: { code: string; message: string; retryable: boolean; status: number } }
> {
  const result = await clobGet(`/book?token_id=${encodeURIComponent(tokenId)}`);
  if (!result.ok) return { ok: false, error: result.error };
  const b = result.data as OrderBook;
  if (!b || !Array.isArray(b.bids) || !Array.isArray(b.asks)) {
    return { ok: false, error: { code: "UPSTREAM_INVALID_RESPONSE", message: "CLOB /book: missing bids/asks arrays", retryable: false, status: result.status } };
  }
  return { ok: true, book: normalizeOrderBook(b) };
}

/**
 * Fetch the best price for a side (BUY or SELL) of a token.
 * Public endpoint.
 *
 * Endpoint: GET /price?token_id=<TOKEN_ID>&side=<buy|sell>
 */
export async function fetchPrice(tokenId: string, side: "buy" | "sell"): Promise<
  { ok: true; price: number } | { ok: false; error: { code: string; message: string; retryable: boolean; status: number } }
> {
  const result = await clobGet(`/price?token_id=${encodeURIComponent(tokenId)}&side=${side}`);
  if (!result.ok) return { ok: false, error: result.error };
  const price = result.data?.price;
  if (price == null) return { ok: false, error: { code: "UPSTREAM_INVALID_RESPONSE", message: "CLOB /price: missing price field", retryable: false, status: result.status } };
  return { ok: true, price: Number(price) };
}

// ===========================================================================
// NORMALIZATION
// ===========================================================================

function normalizeOrderBook(b: OrderBook): OrderBookView {
  // Bids ascending by price — best bid is LAST
  // Asks descending by price — best ask is FIRST
  const bestBid: OrderBookLevel | null = b.bids.length > 0 ? (b.bids[b.bids.length - 1] ?? null) : null;
  const bestAsk: OrderBookLevel | null = b.asks.length > 0 ? (b.asks[0] ?? null) : null;

  const bestBidPrice = bestBid ? Number(bestBid.price) : null;
  const bestAskPrice = bestAsk ? Number(bestAsk.price) : null;
  const spread = bestBidPrice != null && bestAskPrice != null ? bestAskPrice - bestBidPrice : null;
  const midpoint = bestBidPrice != null && bestAskPrice != null ? (bestBidPrice + bestAskPrice) / 2 : null;

  const totalBidDepthShares = b.bids.reduce((s, l) => s + Number(l.size), 0);
  const totalAskDepthShares = b.asks.reduce((s, l) => s + Number(l.size), 0);

  const immediateAskUsd = bestAsk
    ? Number(bestAsk.price) * Number(bestAsk.size)
    : 0;
  const immediateBidUsd = bestBid
    ? Number(bestBid.price) * Number(bestBid.size)
    : 0;

  const timestampMs = Number(b.timestamp) || 0;

  return {
    conditionId: b.market,
    assetId: b.asset_id,
    timestampMs,
    isoTimestamp: timestampMs > 0 ? new Date(timestampMs).toISOString() : "unknown",
    hash: b.hash,
    bids: b.bids,
    asks: b.asks,
    bestBid,
    bestAsk,
    spread,
    midpoint,
    minOrderSize: Number(b.min_order_size),
    tickSize: Number(b.tick_size),
    negRisk: b.neg_risk,
    lastTradePrice: b.last_trade_price != null ? Number(b.last_trade_price) : null,
    totalBidDepthShares,
    totalAskDepthShares,
    immediateAskUsd,
    immediateBidUsd,
  };
}

// ===========================================================================
// DECIMAL-SAFE ARITHMETIC (avoid floating-point errors in money math)
// ===========================================================================

/**
 * Parse a decimal string into a high-precision integer representation.
 * Example: toAtomicUnits("1.234567", 6) → 1234567n
 */
export function toAtomicUnits(amount: string, decimals: number): bigint {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(amount)) {
    throw new Error(`Invalid decimal amount: ${amount}`);
  }
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Amount ${amount} has more than ${decimals} decimal places`);
  }
  const padded = (whole + fraction.padEnd(decimals, "0")).replace(/^0+/, "") || "0";
  return BigInt(padded);
}

/**
 * Convert atomic units back to a decimal string.
 * Example: fromAtomicUnits(1234567n, 6) → "1.234567"
 */
export function fromAtomicUnits(atomic: bigint, decimals: number): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const s = abs.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const fraction = s.slice(s.length - decimals).replace(/0+$/, "");
  const result = fraction ? `${whole}.${fraction}` : whole;
  return negative ? `-${result}` : result;
}

/**
 * Multiply a decimal price by a decimal size, returning atomic USDC (6 decimals).
 * Example: mulPriceSize("0.39", "100", 6) → atomic USDC for $39.00
 */
export function mulPriceSizeToUsd(price: string, size: string, usdDecimals = 6): bigint {
  // price is 0..1, size is shares
  // cost_usd_atomic = price_atomic * size_atomic / 1e(usdDecimals) where price_atomic has usdDecimals
  const priceAtomic = toAtomicUnits(price, usdDecimals);
  const sizeAtomic = toAtomicUnits(size, usdDecimals);
  // result has usdDecimals*2, so divide by 1e(usdDecimals) to get back to usdDecimals
  return (priceAtomic * sizeAtomic) / 10n ** BigInt(usdDecimals);
}

/**
 * Divide a USD budget by a price to get shares.
 * Example: budgetToShares("1.00", "0.39", 6) → shares as decimal string
 */
export function budgetToShares(budgetUsd: string, price: string, usdDecimals = 6): string {
  const budgetAtomic = toAtomicUnits(budgetUsd, usdDecimals);
  const priceAtomic = toAtomicUnits(price, usdDecimals);
  if (priceAtomic === 0n) throw new Error("Price is zero");
  const sharesAtomic = (budgetAtomic * 10n ** BigInt(usdDecimals)) / priceAtomic;
  return fromAtomicUnits(sharesAtomic, usdDecimals);
}

/**
 * Round a share count DOWN to the nearest tick-size multiple.
 */
export function floorToTick(shares: string, tickSize: string, decimals = 6): string {
  const sharesAtomic = toAtomicUnits(shares, decimals);
  const tickAtomic = toAtomicUnits(tickSize, decimals);
  if (tickAtomic === 0n) return shares;
  const floored = (sharesAtomic / tickAtomic) * tickAtomic;
  return fromAtomicUnits(floored, decimals);
}

/**
 * Round a price to the nearest valid tick.
 */
export function roundPriceToTick(price: string, tickSize: string, decimals = 6): string {
  const priceAtomic = toAtomicUnits(price, decimals);
  const tickAtomic = toAtomicUnits(tickSize, decimals);
  if (tickAtomic === 0n) return price;
  const rounded = ((priceAtomic + tickAtomic / 2n) / tickAtomic) * tickAtomic;
  return fromAtomicUnits(rounded, decimals);
}

// ===========================================================================
// ORDER SIZE CALCULATION — walks the book to compute expected fill
// ===========================================================================

export interface OrderCalculation {
  side: "BUY" | "SELL";
  budgetUsd: string;
  /** Best executable ask (for BUY) or bid (for SELL) */
  bestPrice: string | null;
  /** Shares we want to buy/sell, computed from budget and best price */
  requestedShares: string;
  /** Shares after flooring to min order size and tick */
  sharesToOrder: string;
  /** Limit price for the order (best ask for BUY, best bid for SELL) */
  limitPrice: string | null;
  /** Expected cost in USD (decimal string) — sum of (price × size) walked through the book */
  expectedCostUsd: string;
  /** Whether the book has enough depth to fill at the requested size */
  sufficientDepth: boolean;
  /** Shares available at the best price level only */
  sharesAtBest: string;
  /** Total shares available across all levels (within reasonable price bounds) */
  totalAvailableShares: string;
  /** Effective average price after walking the book */
  averageFillPrice: string | null;
  /** Polymarket taker fee in USDC atomic units (currently 0 — fees are in spread). String for JSON-serializability. */
  feeUsdAtomic: string;
  /** Total debit including fees = expectedCostUsd + feeUsd */
  totalDebitUsd: string;
  /** Whether total debit exceeds the budget */
  withinBudget: boolean;
  minOrderSize: string;
  tickSize: string;
  warnings: string[];
  errors: string[];
}

/**
 * Calculate a BUY order: given a USD budget, walk the ask side of the book
 * to determine executable shares and expected cost.
 *
 * Enforces:
 *   - shares floored to min order size and tick
 *   - total debit (cost + fees) does NOT exceed budget
 *   - if budget is too small to buy even min_order_size at best ask, returns error
 */
export function calculateBuyOrder(
  book: OrderBookView,
  budgetUsd: string,
  options: {
    maxSlippageFromBest?: string;  // decimal, e.g. "0.02" = 2 cents
    maxPriceDeviationFromReference?: string;  // decimal
    referencePrice?: string;  // source entry price
  } = {}
): OrderCalculation {
  const warnings: string[] = [];
  const errors: string[] = [];

  const usdDecimals = 6;
  const minOrderSize = book.minOrderSize.toString();
  const tickSize = book.tickSize.toString();

  if (book.asks.length === 0) {
    return {
      side: "BUY",
      budgetUsd,
      bestPrice: null,
      requestedShares: "0",
      sharesToOrder: "0",
      limitPrice: null,
      expectedCostUsd: "0",
      sufficientDepth: false,
      sharesAtBest: "0",
      totalAvailableShares: "0",
      averageFillPrice: null,
      feeUsdAtomic: "0",
      totalDebitUsd: "0",
      withinBudget: false,
      minOrderSize,
      tickSize,
      warnings,
      errors: ["EMPTY_ASK_BOOK: no asks available"],
    };
  }

  const bestAsk = book.asks[0];
  if (!bestAsk) {
    return {
      side: "BUY",
      budgetUsd,
      bestPrice: null,
      requestedShares: "0",
      sharesToOrder: "0",
      limitPrice: null,
      expectedCostUsd: "0",
      sufficientDepth: false,
      sharesAtBest: "0",
      totalAvailableShares: "0",
      averageFillPrice: null,
      feeUsdAtomic: "0",
      totalDebitUsd: "0",
      withinBudget: false,
      minOrderSize: book.minOrderSize.toString(),
      tickSize: book.tickSize.toString(),
      warnings,
      errors: ["EMPTY_ASK_BOOK: asks array is empty"],
    };
  }
  const bestAskPrice = bestAsk.price;
  const bestAskSize = bestAsk.size;

  // Source price deviation check
  if (options.referencePrice && options.maxPriceDeviationFromReference) {
    const ref = Number(options.referencePrice);
    const cur = Number(bestAskPrice);
    const deviation = Math.abs(cur - ref);
    if (deviation > Number(options.maxPriceDeviationFromReference)) {
      errors.push(
        `PRICE_DEVIATION: best ask $${bestAskPrice} vs source entry $${options.referencePrice} = $${deviation.toFixed(4)} deviation, exceeds max $${options.maxPriceDeviationFromReference}`
      );
    }
  }

  // Compute requested shares from budget and best ask price
  let requestedShares: string;
  try {
    requestedShares = budgetToShares(budgetUsd, bestAskPrice, usdDecimals);
  } catch (err: any) {
    return {
      side: "BUY",
      budgetUsd,
      bestPrice: bestAskPrice,
      requestedShares: "0",
      sharesToOrder: "0",
      limitPrice: bestAskPrice,
      expectedCostUsd: "0",
      sufficientDepth: false,
      sharesAtBest: bestAskSize,
      totalAvailableShares: book.asks.reduce((s, l) => s + Number(l.size), 0).toString(),
      averageFillPrice: null,
      feeUsdAtomic: "0",
      totalDebitUsd: "0",
      withinBudget: false,
      minOrderSize,
      tickSize,
      warnings,
      errors: [`BUDGET_CALC_FAILED: ${err.message}`],
    };
  }

  // Floor to tick size
  const tickFlooredShares = floorToTick(requestedShares, tickSize, usdDecimals);

  // Check min order size
  const tickFlooredAtomic = toAtomicUnits(tickFlooredShares, usdDecimals);
  const minSizeAtomic = toAtomicUnits(minOrderSize, usdDecimals);
  let sharesToOrder = tickFlooredShares;
  if (tickFlooredAtomic < minSizeAtomic) {
    errors.push(
      `BELOW_MIN_ORDER_SIZE: requested ${tickFlooredShares} shares but min is ${minOrderSize}`
    );
    sharesToOrder = "0";
  }

  // Walk the ask book to compute expected fill
  let remainingAtomic = toAtomicUnits(sharesToOrder, usdDecimals);
  let totalCostAtomic = 0n;
  let sharesFilledAtomic = 0n;
  const maxSlippage = options.maxSlippageFromBest ? Number(options.maxSlippageFromBest) : null;
  const bestAskNumeric = Number(bestAskPrice);

  for (const level of book.asks) {
    if (remainingAtomic <= 0n) break;
    // Slippage cap: skip levels beyond max slippage
    if (maxSlippage != null) {
      const levelPrice = Number(level.price);
      if (levelPrice > bestAskNumeric + maxSlippage) {
        warnings.push(`SLIPPAGE_CAP: stopped walking at $${level.price} (exceeds $${(bestAskNumeric + maxSlippage).toFixed(4)})`);
        break;
      }
    }
    const levelPriceAtomic = toAtomicUnits(level.price, usdDecimals);
    const levelSizeAtomic = toAtomicUnits(level.size, usdDecimals);
    const takeAtomic = remainingAtomic > levelSizeAtomic ? levelSizeAtomic : remainingAtomic;
    totalCostAtomic += (levelPriceAtomic * takeAtomic) / 10n ** BigInt(usdDecimals);
    sharesFilledAtomic += takeAtomic;
    remainingAtomic -= takeAtomic;
  }

  const sufficientDepth = remainingAtomic === 0n;
  if (!sufficientDepth) {
    errors.push(
      `INSUFFICIENT_DEPTH: requested ${sharesToOrder} shares but only ${fromAtomicUnits(sharesFilledAtomic, usdDecimals)} available within slippage cap`
    );
  }

  // Polymarket taker fee is currently 0 (fees are in the spread)
  const feeUsdAtomic = 0n;
  const totalDebitAtomic = totalCostAtomic + feeUsdAtomic;
  const budgetAtomic = toAtomicUnits(budgetUsd, usdDecimals);
  const withinBudget = totalDebitAtomic <= budgetAtomic;
  if (!withinBudget) {
    errors.push(
      `OVER_BUDGET: total debit $${fromAtomicUnits(totalDebitAtomic, usdDecimals)} exceeds budget $${budgetUsd}`
    );
  }

  const expectedCostUsd = fromAtomicUnits(totalCostAtomic, usdDecimals);
  const totalDebitUsd = fromAtomicUnits(totalDebitAtomic, usdDecimals);
  const averageFillPrice = sharesFilledAtomic > 0n
    ? fromAtomicUnits((totalCostAtomic * 10n ** BigInt(usdDecimals)) / sharesFilledAtomic, usdDecimals)
    : null;

  return {
    side: "BUY",
    budgetUsd,
    bestPrice: bestAskPrice,
    requestedShares,
    sharesToOrder,
    limitPrice: bestAskPrice,
    expectedCostUsd,
    sufficientDepth,
    sharesAtBest: bestAskSize,
    totalAvailableShares: book.asks.reduce((s, l) => s + Number(l.size), 0).toString(),
    averageFillPrice,
    feeUsdAtomic: feeUsdAtomic.toString(),  // Convert bigint to string for JSON serialization
    totalDebitUsd,
    withinBudget,
    minOrderSize,
    tickSize,
    warnings,
    errors,
  };
}

// ===========================================================================
// EIP-712 TYPED-DATA BUILDERS (for PayBox to sign — plugin does NOT sign)
// ===========================================================================

/**
 * Build the EIP-712 ClobAuth typed-data payload for L1 authentication.
 *
 * The agent forwards this to PayBox's request_wallet_sign (with op="typed_data"
 * or similar — PayBox's EIP-712 support must be confirmed). PayBox signs it
 * with the wallet's private key and returns the signature. The plugin then
 * submits the signature to POST /auth/api-key to obtain L2 credentials.
 */
export function buildClobAuthTypedData(signerAddress: string, nonce = 0) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return {
    domain: {
      name: "ClobAuthDomain",
      version: "1",
      chainId: POLYGON_CHAIN_ID,
    },
    types: {
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    },
    primaryType: "ClobAuth",
    message: {
      address: signerAddress,
      timestamp,
      nonce,
      message: "This message attests that I control the given wallet",
    },
  };
}

/**
 * Polymarket Order struct (EIP-712) for CTF Exchange V1.
 *
 * Reference: @polymarket/order-utils
 * Domain: { name: "CTF Exchange", version: "1", chainId: 137, verifyingContract: CTF_EXCHANGE }
 *
 * The agent forwards this to PayBox's request_wallet_sign. PayBox signs it
 * and returns (v, r, s). The plugin then submits POST /order with the signed
 * order + L2 HMAC auth.
 */
export interface PolymarketOrder {
  salt: string;            // uint256 as decimal string
  maker: string;           // signer address
  signer: string;          // signer address (same as maker for EOA; proxy for smart wallets)
  taker: string;           // zero address for open orders
  tokenId: string;         // uint256 as decimal string
  makerAmount: string;     // uint256 as decimal string (atomic USDC for BUY)
  takerAmount: string;     // uint256 as decimal string (atomic shares for BUY)
  expiration: string;      // uint256 as decimal string (Unix seconds)
  nonce: string;           // uint256 as decimal string
  feeRateBps: string;      // uint256 as decimal string
  side: "BUY" | "SELL";    // 0 = BUY, 1 = SELL
  signatureType: number;   // 0 = EOA, 1 = POLY_PROXY, 2 = POLY_GNOSIS_SAFE
}

export function buildOrderTypedData(order: PolymarketOrder, verifyingContract: string) {
  return {
    domain: {
      name: "CTF Exchange",
      version: "1",
      chainId: POLYGON_CHAIN_ID,
      verifyingContract,
    },
    types: {
      Order: [
        { name: "salt", type: "uint256" },
        { name: "maker", type: "address" },
        { name: "signer", type: "address" },
        { name: "taker", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "makerAmount", type: "uint256" },
        { name: "takerAmount", type: "uint256" },
        { name: "expiration", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "feeRateBps", type: "uint256" },
        { name: "side", type: "uint8" },
        { name: "signatureType", type: "uint8" },
      ],
    },
    primaryType: "Order",
    message: {
      salt: order.salt,
      maker: order.maker,
      signer: order.signer,
      taker: order.taker,
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      expiration: order.expiration,
      nonce: order.nonce,
      feeRateBps: order.feeRateBps,
      side: order.side === "BUY" ? 0 : 1,
      signatureType: order.signatureType,
    },
  };
}

// ===========================================================================
// L2 HMAC SIGNING (for authenticated CLOB API requests)
// ===========================================================================

/**
 * Build the L2 HMAC signature for a CLOB API request.
 *
 * Polymarket CLOB uses a custom header scheme:
 *   POLY_ADDRESS: <wallet address>
 *   POLY_SIGNATURE: <HMAC-SHA256(apiSecret, timestamp + method + path + body)>
 *   POLY_TIMESTAMP: <unix seconds>
 *   POLY_API_KEY: <api key>
 *   POLY_PASSPHRASE: <passphrase>
 *
 * (Note: exact header names may differ in current CLOB API version. This is
 *  the documented scheme — verify against live API before production use.)
 */
export function buildL2AuthHeaders(
  method: string,
  path: string,
  body: string,
  credentials: { apiKey: string; secret: string; passphrase: string; address: string }
): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = timestamp + method.toUpperCase() + path + body;
  const signature = createHmac("sha256", credentials.secret)
    .update(message)
    .digest("hex");
  return {
    POLY_ADDRESS: credentials.address,
    POLY_SIGNATURE: signature,
    POLY_TIMESTAMP: timestamp,
    POLY_API_KEY: credentials.apiKey,
    POLY_PASSPHRASE: credentials.passphrase,
    "Content-Type": "application/json",
  };
}

// ===========================================================================
// ORDER BUILDING — convert calculation → PolymarketOrder struct
// ===========================================================================

/**
 * Build a Polymarket Order struct for a BUY.
 *
 * For a BUY:
 *   makerAmount = atomic USDC to spend (what we pay)
 *   takerAmount = atomic shares to receive (what we get)
 *   tokenId = the outcome token we want to receive
 *
 * For EOA wallets: signatureType = 0, signer = maker
 * For Polymarket proxy wallets (Polymarket-generated "proxy"): signatureType = 1
 * For Gnosis Safe wallets: signatureType = 2
 *
 * The maker/signer address MUST match the wallet PayBox will sign with.
 */
export function buildBuyOrder(params: {
  makerAddress: string;
  tokenId: string;
  sharesToBuy: string;
  limitPrice: string;
  usdDecimals?: number;
  expirationSeconds?: number;
  feeRateBps?: number;
  signatureType?: 0 | 1 | 2;
  signerAddress?: string;
}): PolymarketOrder {
  const usdDecimals = params.usdDecimals ?? 6;
  const makerAmount = mulPriceSizeToUsd(params.limitPrice, params.sharesToBuy, usdDecimals);
  // takerAmount is shares in atomic units. Shares have the same decimals as USDC (6)
  const takerAmount = toAtomicUnits(params.sharesToBuy, usdDecimals);
  const salt = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const expiration = (params.expirationSeconds ?? Math.floor(Date.now() / 1000) + 3600).toString();
  return {
    salt: salt.toString(),
    maker: params.makerAddress,
    signer: params.signerAddress ?? params.makerAddress,
    taker: "0x0000000000000000000000000000000000000000",
    tokenId: params.tokenId,
    makerAmount: makerAmount.toString(),
    takerAmount: takerAmount.toString(),
    expiration,
    nonce: "0",
    feeRateBps: (params.feeRateBps ?? 0).toString(),
    side: "BUY",
    signatureType: params.signatureType ?? 0,
  };
}

// ===========================================================================
// COLLATERAL & ALLOWANCE — constants for Polymarket on Polygon
// ===========================================================================

export const POLYMARKET_CONTRACTS = {
  ctfExchange: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  conditionalTokens: "0x4D97DCd97eC945f40CF65F87097ACE5eA0476045",
  usdcE: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",  // bridged USDC.e (Polymarket uses THIS)
  usdcNative: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359",
  negRiskAdapter: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
  negRiskCtfExchange: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
} as const;
