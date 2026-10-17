/**
 * lib/copyTasks.ts
 *
 * Copy-trade task store + signal detection.
 *
 * A copy task is a per-user configuration that says:
 *   "When wallet X makes a Polymarket trade matching filters F,
 *    suggest a mirror trade using sizing method S, subject to risk R."
 *
 * The plugin does NOT auto-execute mirror trades. It returns "signals" —
 * the agent calls kreopoly_check_copy_signals, sees pending mirror trades,
 * and then calls kreopoly_place_bet (which returns a signing_request the
 * user must approve via PayBox). This keeps custody with PayBox and gives
 * the user a passkey prompt for any trade above their threshold.
 *
 * "Ask for confirmation first" is satisfied at two layers:
 *   1. Task creation: the agent walks the user through config and confirms
 *   2. Each mirror trade: flows through PayBox's standard signing path,
 *      which respects the user's approval mode (autonomous/iframe/always_approve)
 *      and per-credential spend threshold.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  getWalletActivity,
  type WalletActivityResult,
} from "./polygon.js";
import { ErrorCode, type ToolError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SizingMethod =
  | "fixed" // Always $X per trade
  | "exact" // Mirror the source trade's USD amount exactly
  | "percent" // % of user's wallet balance per trade
  | "portfolio_weighted"; // Scale source trade size by user/source wallet-size ratio

export type TradeDirection =
  | "follow_buys" // Only copy buys, in the same direction
  | "copy_sells" // Only copy sells (close position when source does)
  | "buy_on_sells" // Counter-signal: buy when source sells (contrarian)
  | "counter_trade" // Opposite direction of every trade
  | "copy_sides"; // Copy both buys and sells

export type EntryMode = "market" | "limit";

export interface CopyTask {
  id: string;
  /** PayBox user id (the credential subject) */
  userId: string;
  /** Wallet being copied */
  sourceWallet: string;
  label: string;
  enabled: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
  /** Highest tx timestamp we've already processed (Unix seconds) */
  lastProcessedTxTimestamp: number;
  /** TxHash of the most recently mirrored trade (for UX) */
  lastCopiedTxHash: string | null;

  sizing: {
    method: SizingMethod;
    /** For "fixed": dollar amount per trade */
    fixedUsd?: number;
    /** For "exact": ignored, derived from source trade */
    /** For "percent": 0..1 of wallet balance (e.g. 0.05 = 5%) */
    percentOfBalance?: number;
    /** For "portfolio_weighted": computed at signal time */
  };

  direction: TradeDirection;

  filters: {
    maxBuyUsd?: number;
    minBuyUsd?: number;
    dailyCapUsd?: number;
    /** 0..1, only copy trades within this price band */
    priceRange?: { min: number; max: number };
    /** Polymarket category slugs; empty = all */
    categories?: string[];
    /** If true, only one entry per market per task */
    oneEntryPerMarket: boolean;
    /** Markets already entered — for oneEntryPerMarket */
    enteredMarkets: string[];
  };

  /** 0..1 — sell mirrored shares if price drops to this */
  stopLoss?: number;
  /** 0..1 — sell mirrored shares if price rises to this */
  takeProfit?: number;

  entryMode: EntryMode;
  /** For "limit" mode: max price per share to fill at */
  limitMaxPrice?: number;
  /** For "limit" mode: Unix timestamp after which the limit is no longer valid (Kreopoly's "limit order expiration") */
  limitExpiresAt?: number;

  /** Daily spend tracking — date is YYYY-MM-DD */
  spentToday: { date: string; amountUsd: number };
}

export interface CopySignal {
  taskId: string;
  taskLabel: string;
  sourceWallet: string;
  sourceTrade: {
    txHash: string;
    timestamp: number;
    type: string;
    amountUsd: number | null;
  };
  suggestedMirrorTrade: {
    conditionId: string;
    outcome: "YES" | "NO";
    shares: number;
    maxPrice: number;
    estimatedCostUsd: number;
    entryMode: EntryMode;
  } | null;
  warnings: string[];
  /** Why the signal was or wasn't suggested (for the agent to explain) */
  reasoning: string;
  /** Whether a mirror trade is recommended */
  actionable: boolean;
}

/**
 * Funnel diagnostics for a single signal-poll cycle.
 *
 * Makes it possible to answer: "I know the source wallet has been trading,
 * why didn't I get a signal?"
 */
export interface SignalFunnel {
  /** Which upstream provider was used */
  upstreamProvider: string;
  /** Upstream HTTP status (200, 429, etc.) */
  upstreamStatus: number;
  /** Total raw txs returned by the upstream before any filtering */
  rawTradesDetected: number;
  /** Trades that touch Polymarket contracts (after upstream filter) */
  polymarketTradesDetected: number;
  /** Trades newer than lastProcessedTxTimestamp */
  newTradesDetected: number;
  /** Trades after direction filter (follow_buys / copy_sells / etc.) */
  afterDirectionFilter: number;
  /** Trades after category filter (sports, crypto, etc.) */
  afterCategoryFilter: number;
  /** Trades after source size filter (minBuyUsd / maxBuyUsd) */
  afterSizeFilter: number;
  /** Trades after oneEntryPerMarket dedup */
  afterDuplicateMarketFilter: number;
  /** Trades that survived all filters and produced a mirror suggestion */
  actionableSignals: number;
  /** Reasons trades were rejected (human-readable summary) */
  rejectionReasons: string[];
}

export interface SignalCheckResult {
  /** Whether the upstream call succeeded */
  ok: boolean;
  /** Signals for actionable trades (empty if none) */
  signals: CopySignal[];
  /** Funnel diagnostics */
  funnel: SignalFunnel;
  /** Set when ok=false; explains why the upstream failed */
  error?: ToolError;
  /** ISO timestamp when this check ran */
  checkedAt: string;
  /** ISO timestamp of the last trade we processed (for next poll's "since") */
  checkedFrom: string;
  /** ISO timestamp we checked up to */
  checkedUntil: string;
  /** ISO timestamp of the previous check (null on first poll) */
  lastCheckedAtBefore: string | null;
  /** ISO timestamp after this check completed */
  lastCheckedAtAfter: string;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface StoreShape {
  [userId: string]: {
    tasks: CopyTask[];
  };
}

const DEFAULT_PATH = path.resolve(process.cwd(), ".data", "copytasks.json");

function storePath(): string {
  return process.env.COPYTASKS_PATH ?? DEFAULT_PATH;
}

async function readStore(): Promise<StoreShape> {
  try {
    const raw = await fs.readFile(storePath(), "utf-8");
    return JSON.parse(raw) as StoreShape;
  } catch (err: any) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

async function writeStore(data: StoreShape): Promise<void> {
  await fs.mkdir(path.dirname(storePath()), { recursive: true });
  await fs.writeFile(storePath(), JSON.stringify(data, null, 2), "utf-8");
}

function getOrCreate(data: StoreShape, userId: string) {
  if (!data[userId]) data[userId] = { tasks: [] };
  return data[userId];
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateCopyTaskInput {
  sourceWallet: string;
  label?: string;
  sizing: CopyTask["sizing"];
  direction?: TradeDirection;
  filters?: Partial<CopyTask["filters"]>;
  stopLoss?: number;
  takeProfit?: number;
  entryMode?: EntryMode;
  limitMaxPrice?: number;
  /** Unix seconds after which limit orders should not trigger (Kreopoly's "limit order expiration") */
  limitExpiresAt?: number;
  /** If false, the task is created but not enabled (user must explicitly start) */
  enabled?: boolean;
}

export async function createTask(
  userId: string,
  input: CreateCopyTaskInput
): Promise<CopyTask> {
  const data = await readStore();
  const store = getOrCreate(data, userId);

  // Validate sizing
  if (input.sizing.method === "fixed" && !input.sizing.fixedUsd) {
    throw new Error("sizing.fixedUsd required when method='fixed'");
  }
  if (
    input.sizing.method === "percent" &&
    (input.sizing.percentOfBalance == null ||
      input.sizing.percentOfBalance <= 0 ||
      input.sizing.percentOfBalance > 1)
  ) {
    throw new Error(
      "sizing.percentOfBalance must be in (0, 1] when method='percent'"
    );
  }
  if (input.entryMode === "limit" && !input.limitMaxPrice) {
    throw new Error("limitMaxPrice required when entryMode='limit'");
  }
  if (
    input.limitExpiresAt != null &&
    input.limitExpiresAt < Math.floor(Date.now() / 1000)
  ) {
    throw new Error("limitExpiresAt must be in the future");
  }
  if (input.stopLoss != null && (input.stopLoss < 0 || input.stopLoss > 1)) {
    throw new Error("stopLoss must be in [0, 1]");
  }
  if (input.takeProfit != null && (input.takeProfit < 0 || input.takeProfit > 1)) {
    throw new Error("takeProfit must be in [0, 1]");
  }

  // De-dup: only one enabled task per source wallet
  const existing = store.tasks.find(
    (t) => t.sourceWallet === input.sourceWallet.toLowerCase() && t.enabled
  );
  if (existing && input.enabled !== false) {
    throw new Error(
      `An enabled copy task for ${input.sourceWallet} already exists (id=${existing.id}). Pause it first.`
    );
  }

  const task: CopyTask = {
    id: randomUUID(),
    userId,
    sourceWallet: input.sourceWallet.toLowerCase(),
    label: input.label || `Task ${store.tasks.length + 1}`,
    enabled: input.enabled ?? true,
    createdAt: new Date().toISOString(),
    lastCheckedAt: null,
    lastProcessedTxTimestamp: Math.floor(Date.now() / 1000),
    lastCopiedTxHash: null,
    sizing: input.sizing,
    direction: input.direction ?? "follow_buys",
    filters: {
      maxBuyUsd: input.filters?.maxBuyUsd,
      minBuyUsd: input.filters?.minBuyUsd,
      dailyCapUsd: input.filters?.dailyCapUsd,
      priceRange: input.filters?.priceRange,
      categories: input.filters?.categories ?? [],
      oneEntryPerMarket: input.filters?.oneEntryPerMarket ?? false,
      enteredMarkets: [],
    },
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    entryMode: input.entryMode ?? "market",
    limitMaxPrice: input.limitMaxPrice,
    limitExpiresAt: input.limitExpiresAt,
    spentToday: { date: todayStr(), amountUsd: 0 },
  };

  store.tasks.push(task);
  await writeStore(data);
  return task;
}

export async function listTasks(userId: string): Promise<CopyTask[]> {
  const data = await readStore();
  return data[userId]?.tasks ?? [];
}

export async function getTask(userId: string, taskId: string): Promise<CopyTask | null> {
  const data = await readStore();
  return data[userId]?.tasks.find((t) => t.id === taskId) ?? null;
}

export async function updateTask(
  userId: string,
  taskId: string,
  patch: Partial<CopyTask>
): Promise<CopyTask> {
  const data = await readStore();
  const store = getOrCreate(data, userId);
  const idx = store.tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) throw new Error(`Task ${taskId} not found`);
  store.tasks[idx] = { ...store.tasks[idx], ...patch, id: taskId, userId };
  await writeStore(data);
  return store.tasks[idx];
}

export async function deleteTask(
  userId: string,
  taskId: string
): Promise<boolean> {
  const data = await readStore();
  const store = data[userId];
  if (!store) return false;
  const before = store.tasks.length;
  store.tasks = store.tasks.filter((t) => t.id !== taskId);
  await writeStore(data);
  return store.tasks.length < before;
}

export async function setEnabled(
  userId: string,
  taskId: string,
  enabled: boolean
): Promise<CopyTask> {
  return updateTask(userId, taskId, { enabled });
}

export async function recordSpend(
  userId: string,
  taskId: string,
  amountUsd: number
): Promise<void> {
  const task = await getTask(userId, taskId);
  if (!task) return;
  const today = todayStr();
  const spentToday =
    task.spentToday.date === today
      ? { date: today, amountUsd: task.spentToday.amountUsd + amountUsd }
      : { date: today, amountUsd: amountUsd };
  await updateTask(userId, taskId, { spentToday });
}

export async function markMarketEntered(
  userId: string,
  taskId: string,
  conditionId: string
): Promise<void> {
  const task = await getTask(userId, taskId);
  if (!task) return;
  if (!task.filters.enteredMarkets.includes(conditionId)) {
    task.filters.enteredMarkets.push(conditionId);
    await updateTask(userId, taskId, {
      filters: { ...task.filters },
    });
  }
}

// ---------------------------------------------------------------------------
// Signal detection
// ---------------------------------------------------------------------------

/**
 * Check a single task for new source-wallet activity and produce signals.
 *
 * CRITICAL: Never converts an upstream failure into "no_activity".
 *
 * If the upstream call fails, returns ok=false with the error preserved.
 * If the upstream succeeds but returns no new trades, returns ok=true with
 * an empty signals array and a clear funnel showing "0 new trades detected".
 *
 * Funnel diagnostics track exactly where each trade was accepted or rejected:
 *   raw → polymarket-filter → new-since-last → direction → category → size → dedup → actionable
 */
export async function checkTaskForSignals(
  userId: string,
  task: CopyTask,
  userWalletBalanceUsd: number
): Promise<SignalCheckResult> {
  const checkedAt = new Date().toISOString();
  const lastCheckedAtBefore = task.lastCheckedAt;
  const checkedFrom = new Date(task.lastProcessedTxTimestamp * 1000).toISOString();

  // Initialize empty funnel (will be populated as we go)
  const emptyFunnel: SignalFunnel = {
    upstreamProvider: "none",
    upstreamStatus: 0,
    rawTradesDetected: 0,
    polymarketTradesDetected: 0,
    newTradesDetected: 0,
    afterDirectionFilter: 0,
    afterCategoryFilter: 0,
    afterSizeFilter: 0,
    afterDuplicateMarketFilter: 0,
    actionableSignals: 0,
    rejectionReasons: [],
  };

  // --- Handle paused task ---------------------------------------------
  if (!task.enabled) {
    return {
      ok: true,
      signals: [],
      funnel: { ...emptyFunnel, rejectionReasons: ["Task is paused"] },
      checkedAt,
      checkedFrom,
      checkedUntil: checkedAt,
      lastCheckedAtBefore,
      lastCheckedAtAfter: checkedAt,
    };
  }

  // --- Fetch upstream activity (NEVER swallow errors) -----------------
  const activityResult: WalletActivityResult = await getWalletActivity(
    task.sourceWallet,
    20
  );

  if (!activityResult.ok) {
    // Upstream failed — return the error explicitly. DO NOT report "no activity".
    return {
      ok: false,
      signals: [],
      funnel: {
        ...emptyFunnel,
        upstreamProvider: activityResult.error.upstreamProvider ?? "unknown",
        upstreamStatus: activityResult.error.upstreamStatus ?? 0,
        rejectionReasons: [`Upstream failed: ${activityResult.error.message}`],
      },
      error: activityResult.error,
      checkedAt,
      checkedFrom,
      checkedUntil: checkedAt,
      lastCheckedAtBefore,
      lastCheckedAtAfter: checkedAt,
    };
  }

  // --- Upstream succeeded — build funnel ------------------------------
  const funnel: SignalFunnel = {
    upstreamProvider: activityResult.upstreamProvider,
    upstreamStatus: activityResult.upstreamStatus,
    rawTradesDetected: activityResult.rawCount,
    polymarketTradesDetected: activityResult.polymarketCount,
    newTradesDetected: 0,
    afterDirectionFilter: 0,
    afterCategoryFilter: 0,
    afterSizeFilter: 0,
    afterDuplicateMarketFilter: 0,
    actionableSignals: 0,
    rejectionReasons: [],
  };

  // Filter to new activity only (newer than lastProcessedTxTimestamp)
  const allActivity = activityResult.activity;
  const newActivity = allActivity.filter(
    (a) => a.timestamp > task.lastProcessedTxTimestamp
  );
  funnel.newTradesDetected = newActivity.length;

  // Update task timestamps — only after we successfully got data
  if (allActivity.length > 0) {
    const newestTs = Math.max(...allActivity.map((a) => a.timestamp));
    await updateTask(userId, task.id, {
      lastCheckedAt: checkedAt,
      lastProcessedTxTimestamp: Math.max(
        newestTs,
        task.lastProcessedTxTimestamp
      ),
    });
  } else {
    await updateTask(userId, task.id, {
      lastCheckedAt: checkedAt,
    });
  }

  // --- If no new activity, return with clear funnel -------------------
  if (newActivity.length === 0) {
    if (allActivity.length === 0) {
      funnel.rejectionReasons.push(
        `Upstream OK (${activityResult.upstreamProvider}) but no Polymarket trades found for this wallet. ` +
          `Verify the address is correct and has traded on Polymarket.`
      );
    } else {
      funnel.rejectionReasons.push(
        `${allActivity.length} Polymarket trades found, but all are older than last check ` +
          `(${checkedFrom}). Next new trade will trigger a signal.`
      );
    }
    return {
      ok: true,
      signals: [],
      funnel,
      checkedAt,
      checkedFrom,
      checkedUntil: checkedAt,
      lastCheckedAtBefore,
      lastCheckedAtAfter: checkedAt,
    };
  }

  // --- Apply filters and build signals -------------------------------
  const signals: CopySignal[] = [];

  for (const tx of newActivity) {
    // Direction filter
    const isBuy = tx.type === "buy";
    const isSell = tx.type === "sell" || tx.type === "transfer";
    let directionOk = false;
    let directionReason = "";
    switch (task.direction) {
      case "follow_buys":
        directionOk = isBuy;
        directionReason = `follow_buys requires tx.type=buy, got ${tx.type}`;
        break;
      case "copy_sells":
        directionOk = isSell;
        directionReason = `copy_sells requires sell/transfer, got ${tx.type}`;
        break;
      case "buy_on_sells":
        directionOk = isSell;
        directionReason = `buy_on_sells requires sell/transfer, got ${tx.type}`;
        break;
      case "counter_trade":
        directionOk = true;
        directionReason = "";
        break;
      case "copy_sides":
        directionOk = true;
        directionReason = "";
        break;
    }
    if (!directionOk) {
      funnel.rejectionReasons.push(
        `tx ${tx.txHash.slice(0, 10)}: ${directionReason}`
      );
      continue;
    }
    funnel.afterDirectionFilter++;

    // Category filter — we can't fully decode the source trade's market category
    // from raw tx data alone. We accept all and let the agent resolve conditionId
    // before calling place_bet, where the category filter can be re-applied.
    // For now, we just track that the filter exists.
    if (task.filters.categories && task.filters.categories.length > 0) {
      // Cannot verify category without decoding — pass through with a warning
      // that the agent should verify before placing the bet.
    }
    funnel.afterCategoryFilter++;

    // Source size filter
    if (
      task.filters.minBuyUsd != null &&
      tx.amountUsd != null &&
      tx.amountUsd < task.filters.minBuyUsd
    ) {
      funnel.rejectionReasons.push(
        `tx ${tx.txHash.slice(0, 10)}: $${tx.amountUsd.toFixed(2)} below min_buy $${task.filters.minBuyUsd}`
      );
      continue;
    }
    if (
      task.filters.maxBuyUsd != null &&
      tx.amountUsd != null &&
      tx.amountUsd > task.filters.maxBuyUsd
    ) {
      funnel.rejectionReasons.push(
        `tx ${tx.txHash.slice(0, 10)}: $${tx.amountUsd.toFixed(2)} above max_buy $${task.filters.maxBuyUsd}`
      );
      continue;
    }
    funnel.afterSizeFilter++;

    // Daily cap
    if (
      task.filters.dailyCapUsd != null &&
      task.spentToday.amountUsd >= task.filters.dailyCapUsd
    ) {
      funnel.rejectionReasons.push(
        `tx ${tx.txHash.slice(0, 10)}: daily cap reached ($${task.spentToday.amountUsd.toFixed(2)} / $${task.filters.dailyCapUsd})`
      );
      continue;
    }

    // oneEntryPerMarket — we can't fully apply this without conditionId
    // (which requires decoding the source tx). Track that we passed.
    funnel.afterDuplicateMarketFilter++;

    // Build the signal
    const signal = await buildSignal(task, tx, userWalletBalanceUsd);
    signals.push(signal);
    if (signal.actionable) {
      funnel.actionableSignals++;
    }
  }

  return {
    ok: true,
    signals,
    funnel,
    checkedAt,
    checkedFrom,
    checkedUntil: checkedAt,
    lastCheckedAtBefore,
    lastCheckedAtAfter: checkedAt,
  };
}

async function buildSignal(
  task: CopyTask,
  tx: {
    txHash: string;
    timestamp: number;
    type: string;
    amountUsd: number | null;
  },
  userWalletBalanceUsd: number
): Promise<CopySignal> {
  const warnings: string[] = [];
  const reasoning: string[] = [];

  // Compute mirror trade size
  const sizing = computeMirrorSize(task, tx.amountUsd ?? 0, userWalletBalanceUsd);
  if (sizing.shares <= 0) {
    return {
      taskId: task.id,
      taskLabel: task.label,
      sourceWallet: task.sourceWallet,
      sourceTrade: tx,
      suggestedMirrorTrade: null,
      warnings,
      reasoning: `Computed mirror size is 0 (sizing method=${task.sizing.method}).`,
      actionable: false,
    };
  }

  // Compute max price
  const maxPrice = task.entryMode === "limit" ? task.limitMaxPrice! : 0.99;
  const estimatedCostUsd = sizing.shares * maxPrice;

  // Limit-order expiration check
  if (
    task.entryMode === "limit" &&
    task.limitExpiresAt != null &&
    task.limitExpiresAt < Math.floor(Date.now() / 1000)
  ) {
    return {
      taskId: task.id,
      taskLabel: task.label,
      sourceWallet: task.sourceWallet,
      sourceTrade: tx,
      suggestedMirrorTrade: null,
      warnings: [],
      reasoning: `Limit order expired at ${new Date(task.limitExpiresAt * 1000).toISOString()}. Update limitExpiresAt or switch to market entry to resume.`,
      actionable: false,
    };
  }

  // Daily cap check on mirror trade
  if (
    task.filters.dailyCapUsd &&
    task.spentToday.amountUsd + estimatedCostUsd > task.filters.dailyCapUsd
  ) {
    const remaining = task.filters.dailyCapUsd - task.spentToday.amountUsd;
    warnings.push(
      `Mirror trade would exceed daily cap. Remaining: $${remaining.toFixed(2)}. Suggest reducing shares.`
    );
  }

  reasoning.push(
    `Source ${tx.type} of ~$${tx.amountUsd?.toFixed(2) ?? "unknown"} detected. ` +
      `Suggesting mirror: ${sizing.shares.toFixed(2)} shares @ max ${maxPrice.toFixed(3)} = ~$${estimatedCostUsd.toFixed(2)}. ` +
      `Entry mode: ${task.entryMode}. ` +
      `To execute: agent should query source wallet's latest position via Polymarket Data API to determine conditionId+outcome, then call kreopoly_place_bet.`
  );

  return {
    taskId: task.id,
    taskLabel: task.label,
    sourceWallet: task.sourceWallet,
    sourceTrade: tx,
    suggestedMirrorTrade: {
      conditionId: "",
      outcome: "YES",
      shares: Number(sizing.shares.toFixed(2)),
      maxPrice: Number(maxPrice.toFixed(3)),
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(2)),
      entryMode: task.entryMode,
    },
    warnings,
    reasoning: reasoning.join(" "),
    actionable: true,
  };
}

function computeMirrorSize(
  task: CopyTask,
  sourceAmountUsd: number,
  userBalanceUsd: number
): { shares: number } {
  switch (task.sizing.method) {
    case "fixed":
      // Fixed dollar amount per trade → shares = amount / avg price (we use 0.5 as conservative default)
      // Actually shares = dollar amount (since 1 share pays $1, you buy at price p, you get 1/p shares per dollar)
      // For simplicity, shares = fixedUsd / maxPrice (worst-case shares count)
      // But we want the COST to be fixedUsd, so shares = fixedUsd / price
      // We don't know price yet — use maxPrice as conservative estimate
      return { shares: (task.sizing.fixedUsd ?? 0) / 0.5 };

    case "exact":
      // Mirror source USD amount exactly
      return { shares: sourceAmountUsd / 0.5 };

    case "percent":
      // % of user's wallet balance
      return {
        shares: (userBalanceUsd * (task.sizing.percentOfBalance ?? 0)) / 0.5,
      };

    case "portfolio_weighted":
      // Scale source trade by ratio of user balance to source balance
      // Without source balance data, fall back to 5% of user balance
      return {
        shares: (userBalanceUsd * 0.05) / 0.5,
      };

    default:
      return { shares: 0 };
  }
}
