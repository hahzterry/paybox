/**
 * lib/polygon.ts
 *
 * On-chain reads for the Kreopoly Lens plugin.
 *
 * Reads from:
 *   - Polygon RPC (env: POLYGON_RPC_URL, defaults to public endpoint)
 *   - Polymarket ConditionalTokens ERC-1155 contract (position balances)
 *   - Polymarket Gamma API (market metadata: title, outcomes, prices)
 *   - Polygonscan API (wallet activity tracking)
 *
 * This module performs ONLY reads. Trade construction lives in tools/placeBet.ts.
 *
 * All HTTP calls go through safeFetch() — never blindly calls .json().
 * Returns structured results: { ok: true, data } | { ok: false, error: ToolError }.
 */

import { ethers } from "ethers";
import { safeFetch, type SafeFetchResult } from "./safeFetch.js";
import { ErrorCode, type ToolError } from "./errors.js";

// ---------------------------------------------------------------------------
// Contract addresses (Polygon mainnet, chainId 137)
// ---------------------------------------------------------------------------

export const POLYGON_CHAIN_ID = 137;

export const ADDRESSES = {
  /** Polymarket CTF Exchange — order matching & settlement */
  ctfExchange: "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E",
  /** Polymarket ConditionalTokens — ERC-1155 position tokens */
  conditionalTokens: "0x4D97DCd97eC945f40CF65F87097ACE5eA0476045",
  /** USDC.e on Polygon — Polymarket's settlement token */
  usdcE: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
  /** NegRisk CTF Exchange (used by some multi-outcome markets) */
  negRiskCtfExchange: "0xC5d563A36AE78145C45a50134d48A1215220f80a",
} as const;

// ---------------------------------------------------------------------------
// Minimal ABIs
// ---------------------------------------------------------------------------

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
] as const;

const ERC1155_ABI = [
  "function balanceOf(address account, uint256 id) view returns (uint256)",
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
] as const;

// ---------------------------------------------------------------------------
// RPC provider (lazy singleton)
// ---------------------------------------------------------------------------

let _provider: ethers.JsonRpcProvider | null = null;

export function getProvider(): ethers.JsonRpcProvider {
  if (_provider) return _provider;
  const url = process.env.POLYGON_RPC_URL ?? "https://polygon-rpc.com";
  _provider = new ethers.JsonRpcProvider(url, {
    chainId: POLYGON_CHAIN_ID,
    name: "polygon",
  });
  return _provider;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Position {
  /** ERC-1155 tokenId (the position token) */
  tokenId: string;
  /** Number of shares held (USDC-denominated, 6 decimals implied) */
  shares: string;
  /** Outcome side this token represents ("YES" | "NO" | outcome label) */
  outcome: string;
  /** Current market title, e.g. "Will BTC hit $100k by Dec 31?" */
  marketTitle: string;
  /** Current price of this outcome (0..1), from Gamma API order book */
  currentPrice: number;
  /** Implied USD value of the position = shares × currentPrice */
  currentValueUsd: number;
  /** Market slug for linking to polymarket.com */
  marketSlug: string;
  /** Market resolution timestamp (Unix seconds) if known */
  marketEndDate: number | null;
}

export interface WalletActivity {
  /** Transaction hash */
  txHash: string;
  /** Block timestamp (Unix seconds) */
  timestamp: number;
  /** "buy" | "sell" | "deposit" | "withdraw" | "other" */
  type: string;
  /** Polymarket market title (if determinable) */
  marketTitle: string | null;
  /** Outcome side */
  outcome: string | null;
  /** USDC amount (human-readable) */
  amountUsd: number | null;
  /** Number of shares */
  shares: number | null;
  /** Avg fill price (0..1), if computable */
  price: number | null;
}

export interface MarketMeta {
  /** Polymarket conditionId */
  conditionId: string;
  /** Human-readable market title */
  question: string;
  /** Market slug */
  slug: string;
  /** Outcome labels, e.g. ["Yes", "No"] */
  outcomes: string[];
  /** ERC-1155 tokenIds for each outcome */
  outcomeTokenIds: string[];
  /** Current best prices (0..1) per outcome */
  outcomePrices: number[];
  /** Liquidity in USD */
  liquidityUsd: number;
  /** Resolution timestamp (Unix seconds) */
  endDate: number | null;
  /** Whether the market is active */
  active: boolean;
  /** Whether the market uses the NegRisk adapter (multi-outcome) */
  negRisk: boolean;
}

// ---------------------------------------------------------------------------
// Gamma API (Polymarket public metadata API)
// ---------------------------------------------------------------------------

const GAMMA_BASE = "https://gamma-api.polymarket.com";

export type MarketResult = { ok: true; market: MarketMeta | null } | { ok: false; error: ToolError };

/**
 * Look up a market by its conditionId.
 *
 * Returns:
 *   - { ok: true, market: MarketMeta } if found
 *   - { ok: true, market: null } if the API succeeded but no market matched
 *   - { ok: false, error: ToolError } if the upstream call failed
 */
export async function getMarketByConditionId(
  conditionId: string
): Promise<MarketResult> {
  const url = `${GAMMA_BASE}/markets?condition_ids=${encodeURIComponent(conditionId)}&limit=1`;
  const result = await safeFetch(url, {
    provider: "polymarket-gamma",
    headers: { accept: "application/json" },
  });
  if (!result.ok) return { ok: false, error: result.error };

  const data = result.data;
  if (!Array.isArray(data) || data.length === 0) {
    return { ok: true, market: null };
  }
  return { ok: true, market: normalizeGammaMarket(data[0]) };
}

/**
 * Look up markets by an array of ERC-1155 tokenIds.
 *
 * Polymarket's Gamma API does not directly index by tokenId, but each market
 * carries an array of clobTokenIds. We fetch recent markets and match.
 */
export async function getMarketByTokenId(
  tokenId: string
): Promise<MarketResult> {
  const url = `${GAMMA_BASE}/markets?closed=false&limit=500&order=volume24hr&ascending=false`;
  const result = await safeFetch(url, {
    provider: "polymarket-gamma",
    headers: { accept: "application/json" },
  });
  if (!result.ok) return { ok: false, error: result.error };

  const data = result.data;
  if (!Array.isArray(data)) {
    return { ok: false, error: {
      code: ErrorCode.UPSTREAM_INVALID_RESPONSE,
      message: "polymarket-gamma: expected array response",
      retryable: false,
      upstreamProvider: "polymarket-gamma",
    }};
  }
  for (const m of data) {
    const normalized = normalizeGammaMarket(m);
    if (normalized.outcomeTokenIds.includes(tokenId)) {
      return { ok: true, market: normalized };
    }
  }
  return { ok: true, market: null };
}

function normalizeGammaMarket(m: any): MarketMeta {
  const outcomes = parseJsonStringArray(m.outcomes) ?? ["Yes", "No"];
  const outcomePrices = parseJsonNumberArray(m.outcomePrices) ?? [];
  const outcomeTokenIds = parseJsonStringArray(m.clobTokenIds) ?? [];
  return {
    conditionId: m.conditionId ?? "",
    question: m.question ?? m.title ?? "Unknown market",
    slug: m.slug ?? m.marketSlug ?? "",
    outcomes,
    outcomeTokenIds,
    outcomePrices,
    liquidityUsd: Number(m.liquidity ?? m.liquidityClob ?? 0) || 0,
    endDate: m.endDate ? Math.floor(new Date(m.endDate).getTime() / 1000) : null,
    active: Boolean(m.active),
    negRisk: Boolean(m.negRisk),
  };
}

function parseJsonStringArray(v: unknown): string[] | null {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(String);
    } catch {
      /* ignore */
    }
  }
  return null;
}

function parseJsonNumberArray(v: unknown): number[] | null {
  if (Array.isArray(v)) return v.map(Number);
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch {
      /* ignore */
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Position reads
// ---------------------------------------------------------------------------

/**
 * Get the USDC.e balance of a wallet on Polygon.
 */
export async function getUsdcEBalance(walletAddress: string): Promise<string> {
  const provider = getProvider();
  const erc20 = new ethers.Contract(ADDRESSES.usdcE, ERC20_ABI, provider);
  const raw: bigint = (await erc20.balanceOf(walletAddress)) as bigint;
  return ethers.formatUnits(raw, 6);
}

/**
 * Get a wallet's open Polymarket positions.
 *
 * READ-ONLY: no signature, no transaction, no fund movement.
 *
 * Returns:
 *   - { ok: true, positions: Position[], upstreamProvider, upstreamStatus } on success
 *   - { ok: false, error: ToolError } if the upstream call failed
 *
 * Never returns an empty array silently when the upstream failed — that would
 * create a false negative. The caller can distinguish "no positions" (ok=true,
 * positions=[]) from "upstream failed" (ok=false).
 */
export type PositionsResult =
  | { ok: true; positions: Position[]; upstreamProvider: string; upstreamStatus: number }
  | { ok: false; error: ToolError };

export async function getPositions(walletAddress: string): Promise<PositionsResult> {
  const url = `https://data-api.polymarket.com/positions?user=${encodeURIComponent(
    walletAddress.toLowerCase()
  )}&sizeThreshold=0.1&limit=100`;

  const result = await safeFetch(url, {
    provider: "polymarket-data-api",
    headers: { accept: "application/json" },
  });

  if (!result.ok) return { ok: false, error: result.error };

  const data = result.data;
  if (!Array.isArray(data)) {
    return {
      ok: false,
      error: {
        code: ErrorCode.UPSTREAM_INVALID_RESPONSE,
        message: "polymarket-data-api: expected array response",
        retryable: false,
        upstreamProvider: "polymarket-data-api",
        upstreamStatus: result.status,
      },
    };
  }

  const positions: Position[] = data
    .filter((p) => Number(p.size ?? 0) > 0)
    .map((p) => ({
      tokenId: String(p.asset ?? p.tokenId ?? ""),
      shares: String(p.size ?? "0"),
      outcome: p.outcome ?? (Number(p.side) === 0 ? "YES" : "NO"),
      marketTitle: p.title ?? p.market ?? p.question ?? "Unknown market",
      currentPrice: Number(p.currentPrice ?? p.price ?? 0) || 0,
      currentValueUsd: Number(p.currentValue ?? 0) || 0,
      marketSlug: p.slug ?? p.marketSlug ?? "",
      marketEndDate: p.endDate
        ? Math.floor(new Date(p.endDate).getTime() / 1000)
        : null,
    }));

  return {
    ok: true,
    positions,
    upstreamProvider: "polymarket-data-api",
    upstreamStatus: result.status,
  };
}

// ---------------------------------------------------------------------------
// Wallet activity tracking (Polygonscan + Polymarket Data API fallback)
// ---------------------------------------------------------------------------

const POLYGONSCAN_BASE = "https://api.polygonscan.com/api";
const POLYMARKET_ACTIVITY_BASE = "https://data-api.polymarket.com";

/**
 * Result of fetching wallet activity.
 *
 * ok=true with activity=[] means: upstream confirmed OK, no matching trades found.
 * ok=false means: upstream failed; do NOT treat as "no activity".
 */
export type WalletActivityResult =
  | {
      ok: true;
      activity: WalletActivity[];
      upstreamProvider: string;
      upstreamStatus: number;
      /** How many raw txs were returned by the upstream before filtering */
      rawCount: number;
      /** How many txs remained after filtering to Polymarket contracts */
      polymarketCount: number;
    }
  | { ok: false; error: ToolError };

/**
 * Fetch recent Polymarket-related transactions for a wallet.
 *
 * READ-ONLY: no signature, no transaction, no fund movement.
 *
 * Strategy:
 *   1. Try Polygonscan `txlist` endpoint — returns txs from the wallet
 *   2. Filter to txs touching Polymarket contracts (CTF Exchange, ConditionalTokens, NegRisk)
 *   3. If Polygonscan fails (HTML, rate limit, WAF), fall back to Polymarket
 *      Data API's `/activity` endpoint
 *
 * NEVER returns an empty array silently when the upstream failed.
 */
export async function getWalletActivity(
  walletAddress: string,
  limit = 20
): Promise<WalletActivityResult> {
  // --- Attempt 1: Polygonscan -----------------------------------------
  const polygonscanResult = await getWalletActivityFromPolygonscan(
    walletAddress,
    limit
  );
  if (polygonscanResult.ok) return polygonscanResult;

  // If Polygonscan failed with a hard error (invalid response, not just rate
  // limit), try the Polymarket Data API as a fallback.
  const polymarketResult = await getWalletActivityFromPolymarket(
    walletAddress,
    limit
  );
  if (polymarketResult.ok) return polymarketResult;

  // Both failed — return the more informative error (prefer Polygonscan's
  // since that's the primary provider).
  return polygonscanResult;
}

async function getWalletActivityFromPolygonscan(
  walletAddress: string,
  limit: number
): Promise<WalletActivityResult> {
  const apiKey = process.env.POLYGONSCAN_API_KEY ?? "";
  const params = new URLSearchParams({
    module: "account",
    action: "txlist",
    address: walletAddress,
    startblock: "0",
    endblock: "99999999",
    sort: "desc",
    page: "1",
    offset: String(Math.min(limit * 4, 200)),
  });
  if (apiKey) params.set("apikey", apiKey);

  const url = `${POLYGONSCAN_BASE}?${params.toString()}`;
  const result = await safeFetch(url, {
    provider: "polygonscan",
    headers: { accept: "application/json" },
  });

  if (!result.ok) return { ok: false, error: result.error };

  const data = result.data;
  // Polygonscan returns { status, message, result } — even on "no txs"
  // status="0" message="No transactions found" result=[] is a VALID empty result
  if (data?.status === "0" && /no transactions/i.test(data?.message ?? "")) {
    return {
      ok: true,
      activity: [],
      upstreamProvider: "polygonscan",
      upstreamStatus: result.status,
      rawCount: 0,
      polymarketCount: 0,
    };
  }
  // status="0" with "Max calls" message = rate limit
  if (data?.status === "0" && /max calls/i.test(data?.message ?? "")) {
    return {
      ok: false,
      error: {
        code: ErrorCode.UPSTREAM_RATE_LIMITED,
        message: "polygonscan: rate limit exceeded (Max calls). Set POLYGONSCAN_API_KEY.",
        retryable: true,
        upstreamStatus: 200,
        upstreamProvider: "polygonscan",
      },
    };
  }

  const txs: any[] = Array.isArray(data?.result) ? data.result : [];

  const ctfLower = ADDRESSES.ctfExchange.toLowerCase();
  const condLower = ADDRESSES.conditionalTokens.toLowerCase();
  const negRiskLower = ADDRESSES.negRiskCtfExchange.toLowerCase();

  const filtered = txs.filter(
    (t) =>
      typeof t.to === "string" &&
      [ctfLower, condLower, negRiskLower].includes(t.to.toLowerCase())
  );

  const activity: WalletActivity[] = filtered.slice(0, limit).map((t) => ({
    txHash: t.hash as string,
    timestamp: Number(t.timeStamp) || 0,
    type: classifyTx(t),
    marketTitle: null,
    outcome: null,
    amountUsd: t.value ? Number(ethers.formatUnits(t.value, 6)) : null,
    shares: null,
    price: null,
  }));

  return {
    ok: true,
    activity,
    upstreamProvider: "polygonscan",
    upstreamStatus: result.status,
    rawCount: txs.length,
    polymarketCount: filtered.length,
  };
}

/**
 * Fallback: Polymarket Data API /activity endpoint.
 *
 * This endpoint returns the wallet's recent Polymarket trades directly, with
 * market metadata. Less granular than Polygonscan but more reliable.
 */
async function getWalletActivityFromPolymarket(
  walletAddress: string,
  limit: number
): Promise<WalletActivityResult> {
  const url = `${POLYMARKET_ACTIVITY_BASE}/activity?user=${encodeURIComponent(
    walletAddress.toLowerCase()
  )}&limit=${Math.min(limit, 100)}&type=TRADE`;

  const result = await safeFetch(url, {
    provider: "polymarket-data-api-activity",
    headers: { accept: "application/json" },
  });

  if (!result.ok) return { ok: false, error: result.error };

  const data = result.data;
  if (!Array.isArray(data)) {
    return {
      ok: false,
      error: {
        code: ErrorCode.UPSTREAM_INVALID_RESPONSE,
        message: "polymarket-data-api-activity: expected array response",
        retryable: false,
        upstreamProvider: "polymarket-data-api-activity",
        upstreamStatus: result.status,
      },
    };
  }

  const activity: WalletActivity[] = data.slice(0, limit).map((t: any) => ({
    txHash: t.transactionHash ?? t.txHash ?? "",
    timestamp: t.timestamp
      ? Math.floor(new Date(t.timestamp).getTime() / 1000)
      : t.blockNum
        ? Number(t.blockNum)
        : 0,
    type: t.side === "BUY" ? "buy" : t.side === "SELL" ? "sell" : "other",
    marketTitle: t.title ?? t.market ?? t.question ?? null,
    outcome: t.outcome ?? null,
    amountUsd: t.size ? Number(t.size) * Number(t.price ?? 0) : null,
    shares: t.size ? Number(t.size) : null,
    price: t.price ? Number(t.price) : null,
  }));

  return {
    ok: true,
    activity,
    upstreamProvider: "polymarket-data-api-activity",
    upstreamStatus: result.status,
    rawCount: data.length,
    polymarketCount: data.length,
  };
}

function classifyTx(t: any): string {
  // Heuristic — a full classifier would decode the calldata against the CTF
  // Exchange ABI. For the hackathon we return a coarse label.
  if (t.input === "0x" || !t.input) return "transfer";
  const sig = t.input.slice(0, 10).toLowerCase();
  // 0xee0d2c5c = fillOrder (CTF Exchange V1)
  if (sig === "0xee0d2c5c") return "buy";
  // 0x8d80ff0a = Safe multiSend — often wraps fillOrder
  if (sig === "0x8d80ff0a") return "multisend";
  return "other";
}

// ---------------------------------------------------------------------------
// Gas estimate (used by placeBet to compute total cost)
// ---------------------------------------------------------------------------

export async function estimateGasUsd(): Promise<number> {
  const provider = getProvider();
  try {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;
    // A Polymarket CTF Exchange fill is ~250k gas
    const gasUnits = 250_000n;
    const gasMatic = ethers.formatUnits(gasPrice * gasUnits, 18);
    // Approximate MATIC price in USD — for hackathon we hardcode ~$0.40.
    // Production: fetch from a price oracle or Chainlink.
    const maticUsd = 0.4;
    return Number(gasMatic) * maticUsd;
  } catch {
    return 0.01;
  }
}
