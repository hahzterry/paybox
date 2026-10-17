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
import { getWalletActivity, getMarketByConditionId } from "./polygon.js";

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
 * For each new transaction detected:
 *   1. Filter by direction (follow_buys / copy_sells / etc.)
 *   2. Filter by amount / price / daily cap
 *   3. Compute the mirror trade size based on sizing method
 *   4. Return a CopySignal — actionable or not, with reasoning
 *
 * Updates lastCheckedAt and lastProcessedTxTimestamp on the task.
 *
 * NOTE: We can't currently decode the source trade's conditionId / outcome
 * from raw Polygonscan tx data alone — that requires decoding the fillOrder
 * calldata against the CTF Exchange ABI. For v0.1 we surface the source
 * activity and let the agent ask the user for the target market, OR use
 * the polymarket data API to look up the source wallet's recent positions.
 *
 * Production: replace the sourceTrade enrichment with decoded calldata.
 */
export async function checkTaskForSignals(
  userId: string,
  task: CopyTask,
  userWalletBalanceUsd: number
): Promise<CopySignal[]> {
  if (!task.enabled) {
    return [
      {
        taskId: task.id,
        taskLabel: task.label,
        sourceWallet: task.sourceWallet,
        sourceTrade: {
          txHash: "",
          timestamp: Math.floor(Date.now() / 1000),
          type: "skip",
          amountUsd: null,
        },
        suggestedMirrorTrade: null,
        warnings: [],
        reasoning: `Task is paused. Call kreopoly_copy_trade action='resume' to reactivate.`,
        actionable: false,
      },
    ];
  }

  const activity = await getWalletActivity(task.sourceWallet, 10).catch(
    (err) => {
      if (err.message === "rate_limit") {
        throw err;
      }
      return [];
    }
  );

  // Filter to new activity only
  const newActivity = activity.filter(
    (a) => a.timestamp > task.lastProcessedTxTimestamp
  );

  // Update task timestamps
  if (activity.length > 0) {
    const newestTs = Math.max(...activity.map((a) => a.timestamp));
    await updateTask(userId, task.id, {
      lastCheckedAt: new Date().toISOString(),
      lastProcessedTxTimestamp: Math.max(newestTs, task.lastProcessedTxTimestamp),
    });
  } else {
    await updateTask(userId, task.id, {
      lastCheckedAt: new Date().toISOString(),
    });
  }

  if (newActivity.length === 0) {
    return [
      {
        taskId: task.id,
        taskLabel: task.label,
        sourceWallet: task.sourceWallet,
        sourceTrade: {
          txHash: "",
          timestamp: Math.floor(Date.now() / 1000),
          type: "no_activity",
          amountUsd: null,
        },
        suggestedMirrorTrade: null,
        warnings: [],
        reasoning: `No new activity from ${task.sourceWallet} since last check.`,
        actionable: false,
      },
    ];
  }

  const signals: CopySignal[] = [];

  for (const tx of newActivity) {
    const signal = await buildSignal(task, tx, userWalletBalanceUsd);
    signals.push(signal);
  }

  return signals;
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

  // Direction filter
  const isBuy = tx.type === "buy";
  const isSell = tx.type === "sell" || tx.type === "transfer";

  let directionOk = true;
  let mirrorOutcome: "YES" | "NO" | null = null;

  switch (task.direction) {
    case "follow_buys":
      if (!isBuy) {
        directionOk = false;
        reasoning.push(`Direction follow_buys — ignoring ${tx.type}`);
      }
      break;
    case "copy_sells":
      if (!isSell) {
        directionOk = false;
        reasoning.push(`Direction copy_sells — ignoring ${tx.type}`);
      }
      break;
    case "buy_on_sells":
      if (!isSell) {
        directionOk = false;
        reasoning.push(`Direction buy_on_sells — ignoring ${tx.type}`);
      }
      // Counter-signal: buy when source sells
      mirrorOutcome = "YES"; // simplified — production would decode the source's outcome
      break;
    case "counter_trade":
      reasoning.push(`Direction counter_trade — mirror opposite of source`);
      break;
    case "copy_sides":
      reasoning.push(`Direction copy_sides — mirror any trade`);
      break;
  }

  if (!directionOk) {
    return {
      taskId: task.id,
      taskLabel: task.label,
      sourceWallet: task.sourceWallet,
      sourceTrade: tx,
      suggestedMirrorTrade: null,
      warnings: [],
      reasoning: reasoning.join("; "),
      actionable: false,
    };
  }

  // Amount filters
  if (task.filters.minBuyUsd && tx.amountUsd && tx.amountUsd < task.filters.minBuyUsd) {
    return {
      taskId: task.id,
      taskLabel: task.label,
      sourceWallet: task.sourceWallet,
      sourceTrade: tx,
      suggestedMirrorTrade: null,
      warnings: [],
      reasoning: `Source trade $${tx.amountUsd?.toFixed(2)} below min_buy $${task.filters.minBuyUsd}.`,
      actionable: false,
    };
  }
  if (task.filters.maxBuyUsd && tx.amountUsd && tx.amountUsd > task.filters.maxBuyUsd) {
    return {
      taskId: task.id,
      taskLabel: task.label,
      sourceWallet: task.sourceWallet,
      sourceTrade: tx,
      suggestedMirrorTrade: null,
      warnings: [],
      reasoning: `Source trade $${tx.amountUsd?.toFixed(2)} above max_buy $${task.filters.maxBuyUsd}.`,
      actionable: false,
    };
  }

  // Daily cap
  if (
    task.filters.dailyCapUsd &&
    task.spentToday.amountUsd >= task.filters.dailyCapUsd
  ) {
    return {
      taskId: task.id,
      taskLabel: task.label,
      sourceWallet: task.sourceWallet,
      sourceTrade: tx,
      suggestedMirrorTrade: null,
      warnings: [],
      reasoning: `Daily cap reached ($${task.spentToday.amountUsd.toFixed(2)} / $${task.filters.dailyCapUsd}).`,
      actionable: false,
    };
  }

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

  // Limit-order expiration check (Kreopoly's "limit order expiration")
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

  // We can't decode the source trade's conditionId from raw tx data in v0.1.
  // The agent will need to either:
  //   - Ask the user which market the source just traded
  //   - OR query the Polymarket Data API for the source wallet's recent positions
  // We surface this honestly in the reasoning.
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
      // conditionId is null because we can't decode it from tx data alone.
      // The agent must resolve this before calling place_bet.
      conditionId: "",
      outcome: mirrorOutcome ?? "YES",
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
