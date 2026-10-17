/**
 * tools/trackWallet.ts
 *
 * Manage the wallet watchlist (Kreopoly's wallet-tracker feature).
 *
 * READ + WRITE (local storage only) — does NOT touch the blockchain, does
 * NOT sign anything, does NOT require any wallet permission. The watchlist
 * is a local JSON file used only by this plugin to remember which wallets
 * the user wants to monitor.
 */

import { z } from "zod";
import {
  addWallet,
  removeWallet,
  listWallets,
  type TrackedWallet,
} from "../lib/store.js";
import { makeError, ErrorCode } from "../lib/errors.js";

const addAction = z.object({
  action: z.literal("add").describe("Add a wallet to the watchlist."),
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("Polymarket / Polygon wallet address to track."),
  label: z
    .string()
    .max(64)
    .default("")
    .describe('Friendly name e.g. "Whale #1". Optional.'),
});

const removeAction = z.object({
  action: z.literal("remove"),
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("Wallet to stop tracking."),
});

const listAction = z.object({
  action: z.literal("list").describe("List currently tracked wallets."),
});

export const trackWalletSchema = z.discriminatedUnion("action", [
  addAction,
  removeAction,
  listAction,
]);

export type TrackWalletArgs = z.infer<typeof trackWalletSchema>;

export const trackWalletTool = {
  name: "kreopoly_track_wallet",
  description:
    "[READ + LOCAL WRITE] [NO BLOCKCHAIN] [NO SIGNATURE] [NO FUND MOVEMENT] " +
    "Manage the wallet watchlist (Kreopoly's wallet-tracker feature). " +
    "Actions: add, remove, list. The watchlist is a local JSON file — no " +
    "blockchain interaction, no wallet permission required. Tracked wallets " +
    "can be queried with kreopoly_get_tracked_activity to surface smart-money moves.",
  inputSchema: trackWalletSchema,
  handler: async (args: TrackWalletArgs, ctx: { userId: string }) => {
    const userId = ctx.userId || "anonymous";

    if (args.action === "add") {
      const result = await addWallet(userId, args.walletAddress, args.label);

      if (!result.ok) {
        // Persistence failed — return explicit error, do NOT claim success
        return makeError(
          ErrorCode.WATCHLIST_PERSISTENCE_FAILED,
          result.error ?? "Watchlist persistence failed for unknown reason.",
          { retryable: true }
        );
      }

      return {
        ok: true,
        action: "added",
        wallet: result.wallet,
        message: `Now tracking ${result.wallet!.address}${
          result.wallet!.label ? ` (${result.wallet!.label})` : ""
        }. Call kreopoly_get_tracked_activity to fetch recent trades.`,
      };
    }

    if (args.action === "remove") {
      const result = await removeWallet(userId, args.walletAddress);
      if (!result.ok) {
        return makeError(
          ErrorCode.WATCHLIST_PERSISTENCE_FAILED,
          result.error ?? "Watchlist persistence failed during remove.",
          { retryable: true }
        );
      }
      return {
        ok: true,
        action: "removed",
        message: result.removed
          ? `Stopped tracking ${args.walletAddress}.`
          : `Wallet ${args.walletAddress} was not in the watchlist.`,
      };
    }

    // list
    const wallets = await listWallets(userId);
    return {
      ok: true,
      action: "list",
      count: wallets.length,
      wallets,
      message:
        wallets.length === 0
          ? "Watchlist is empty. Use action='add' to start tracking a wallet."
          : undefined,
    };
  },
};
