/**
 * lib/schemaNormalize.ts
 *
 * Normalizes incoming tool arguments to accept common aliases.
 *
 * Problem: Different tools use different names for the same concept:
 *   - sourceWallet  (copy_trade)
 *   - walletAddress (track_wallet, get_positions, get_tracked_activity)
 *   - userWalletAddress (check_copy_signals)
 *
 * Users (and LLM agents) naturally mix these up. Rather than rejecting
 * with a confusing Zod error, we accept aliases and remap them to the
 * canonical name before validation.
 *
 * Same for sizing: users try { mode: "fixed", amountUsd: 2 } when the
 * canonical form is { method: "fixed", fixedUsd: 2 }.
 */

/**
 * Normalize wallet address field aliases.
 *
 * Accepts: walletAddress, sourceWallet, userWalletAddress, address
 * Returns: { canonicalName: "walletAddress" | "sourceWallet" | "userWalletAddress", value: string }
 */
export interface NormalizedWallet {
  /** The canonical field name for the target tool */
  canonicalName: "sourceWallet" | "walletAddress" | "userWalletAddress";
  /** The wallet address (lowercased) */
  value: string;
}

/**
 * For copy_trade tool: accept walletAddress / address as aliases for sourceWallet.
 * Modifies the args object in place.
 */
export function normalizeSourceWalletAlias(
  args: Record<string, any>
): Record<string, any> {
  if (args.sourceWallet) return args;

  const alias = args.walletAddress ?? args.address ?? args.userWalletAddress;
  if (alias && typeof alias === "string") {
    args.sourceWallet = alias;
    // Don't delete the alias — Zod will reject unknown keys, but we use
    // passthrough schemas in tools that need it. For safety, remove aliases
    // that would conflict.
    delete args.walletAddress;
    delete args.address;
    delete args.userWalletAddress;
  }
  return args;
}

/**
 * For sizing object: accept { mode, amountUsd } as aliases for { method, fixedUsd }.
 * Modifies the args object in place.
 */
export function normalizeSizingAlias(
  args: Record<string, any>
): Record<string, any> {
  if (!args.sizing || typeof args.sizing !== "object") return args;
  const s = args.sizing as Record<string, any>;

  // mode → method
  if (s.mode && !s.method) {
    s.method = s.mode;
    delete s.mode;
  }

  // amountUsd → fixedUsd (only when method is "fixed")
  if (s.amountUsd != null && s.fixedUsd == null) {
    s.fixedUsd = s.amountUsd;
    delete s.amountUsd;
  }

  // amount → fixedUsd (another common alias)
  if (s.amount != null && s.fixedUsd == null) {
    s.fixedUsd = s.amount;
    delete s.amount;
  }

  // percent → percentOfBalance
  if (s.percent != null && s.percentOfBalance == null) {
    s.percentOfBalance = s.percent;
    delete s.percent;
  }

  args.sizing = s;
  return args;
}

/**
 * Apply all known normalizations for the copy_trade tool.
 */
export function normalizeCopyTradeArgs(
  args: Record<string, any>
): Record<string, any> {
  let result = { ...args };
  result = normalizeSourceWalletAlias(result);
  result = normalizeSizingAlias(result);
  return result;
}

/**
 * Format a Zod error into a readable message.
 * Instead of dumping the entire JSON schema, give a focused hint.
 */
export function formatZodError(
  err: { path: (string | number)[]; message: string }[]
): string {
  const lines = err.map((e) => {
    const path = e.path.length > 0 ? e.path.join(".") : "(root)";
    return `  - ${path}: ${e.message}`;
  });
  return `Invalid parameters:\n${lines.join("\n")}\n\nCommon aliases accepted:\n  - walletAddress / address / userWalletAddress → sourceWallet (for copy_trade)\n  - sizing.mode → sizing.method\n  - sizing.amountUsd / sizing.amount → sizing.fixedUsd (when method=fixed)\n  - sizing.percent → sizing.percentOfBalance`;
}
